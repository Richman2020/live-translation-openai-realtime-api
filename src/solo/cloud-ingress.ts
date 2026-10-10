import { createHash } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { isIP, type Socket } from 'node:net';

import { parsePhoneRuntime, type CloudPhoneRuntime } from './cloud-runtime';

/** Public source files only. Authentication and controller APIs are separate. */
export const CLOUD_CONTROLLED_PUBLIC_PATHS = Object.freeze([
  '/controlled',
  '/app.js',
  '/controller-client.js',
  '/controlled-workbench.js',
  '/styles.css',
  '/favicon.svg',
  '/vendor/twilio.min.js',
  '/call-lifecycle.js',
  '/audio-output.js',
  '/microphone-input.js',
  '/rtc-diagnostics.js',
  '/conversation-model.js',
  '/conversation-view.js',
  '/translation-engine.js',
  '/assets/speaker-test.wav',
]);

const publicPaths = new Set<string>(CLOUD_CONTROLLED_PUBLIC_PATHS);
const getPaths = new Set([
  '/api/health',
  '/api/status',
  '/api/browser-session',
  '/api/events',
  '/auth/status',
  '/auth/google/callback',
]);
const postPaths = new Set([
  '/api/calls',
  '/api/controller/acquire',
  '/api/controller/renew',
  '/api/controller/revoke',
  '/auth/google/start',
  '/auth/google/cancel',
  '/auth/logout',
  '/auth/session/renew',
  '/voice/client',
  '/voice/connect',
  '/voice/status',
  '/voice/stream-status',
]);
const queryPaths = new Set([
  '/api/browser-session',
  '/auth/google/callback',
  '/voice/connect',
  '/voice/status',
  '/voice/stream-status',
]);
const droppedHeaders = new Set([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const MAX_BODY_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = 4096;
const MAX_UPGRADE_HEAD_BYTES = 64 * 1024;
const WEB_SOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const RAILWAY_HEALTH_AUTHORITY = 'healthcheck.railway.app';

function validTarget(req: IncomingMessage, upgrade: boolean): boolean {
  const target = req.url || '';
  if (
    !target.startsWith('/') ||
    target.startsWith('//') ||
    target.length > MAX_REQUEST_BYTES ||
    /[\\#]/.test(target) ||
    [...target].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  )
    return false;
  const question = target.indexOf('?');
  const path = question === -1 ? target : target.slice(0, question);
  if (path.includes('%')) return false;
  if (upgrade) return req.method === 'GET' && target === '/voice/media';
  if (question !== -1 && !queryPaths.has(path)) return false;
  if (req.method === 'GET') return getPaths.has(path) || publicPaths.has(path);
  if (req.method === 'HEAD') return publicPaths.has(path);
  if (req.method === 'POST')
    return (
      postPaths.has(path) ||
      /^\/api\/calls\/[A-Za-z0-9_-]{1,128}\/(?:hangup|voice)$/.test(path)
    );
  return false;
}

/** The public port must be exposed only through the configured platform TLS
 * ingress. Forwarded metadata is checked here and never becomes app identity.
 * Browser cookie/Origin/CSRF and Twilio signatures remain upstream checks. */
function headersForUpstream(
  req: IncomingMessage,
  authority: string,
  upgrade: boolean,
  healthProbe = false,
): Record<string, string> | null {
  const headers: Record<string, string> = Object.create(null);
  const seen = new Set<string>();
  const raw = req.rawHeaders;
  if (raw.length % 2) return null;
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index].toLowerCase();
    const value = raw[index + 1];
    // Reject duplicates rather than letting Node join security-sensitive values.
    if (seen.has(name) || req.headers[name] !== value) return null;
    seen.add(name);
    if (!droppedHeaders.has(name)) headers[name] = value;
  }
  if (
    req.headers.host !== authority ||
    ((!healthProbe || req.headers['x-forwarded-proto'] !== undefined) &&
      req.headers['x-forwarded-proto'] !== 'https') ||
    req.headers.forwarded !== undefined ||
    (req.headers['x-forwarded-host'] !== undefined &&
      req.headers['x-forwarded-host'] !== authority)
  )
    return null;
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor !== undefined) {
    if (typeof forwardedFor !== 'string' || forwardedFor.length > 1024)
      return null;
    const addresses = forwardedFor.split(',');
    if (
      addresses.length > 16 ||
      addresses.some((address) => !isIP(address.trim()))
    )
      return null;
  }
  const { connection } = req.headers;
  if (
    connection !== undefined &&
    (typeof connection !== 'string' ||
      connection
        .split(',')
        .some(
          (name) =>
            !['close', 'keep-alive', 'upgrade'].includes(
              name.trim().toLowerCase(),
            ),
        ))
  )
    return null;
  const length = req.headers['content-length'];
  if (
    length !== undefined &&
    (typeof length !== 'string' ||
      !/^\d+$/.test(length) ||
      +length > MAX_BODY_BYTES)
  )
    return null;
  if (req.headers['content-encoding'] !== undefined) return null;
  if (
    req.method !== 'POST' &&
    (req.headers['transfer-encoding'] || Number(length || 0))
  )
    return null;
  if (upgrade) {
    const key = req.headers['sec-websocket-key'];
    if (
      req.headers.upgrade?.toLowerCase() !== 'websocket' ||
      typeof connection !== 'string' ||
      !connection
        .split(',')
        .some((name) => name.trim().toLowerCase() === 'upgrade') ||
      req.headers['sec-websocket-version'] !== '13' ||
      typeof key !== 'string' ||
      Buffer.from(key, 'base64').length !== 16 ||
      Buffer.from(key, 'base64').toString('base64') !== key ||
      typeof req.headers['x-twilio-signature'] !== 'string'
    )
      return null;
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
  } else if (req.headers.upgrade !== undefined) return null;
  return headers;
}

function rejectHttp(reply: ServerResponse, status: number, code: string): void {
  if (reply.headersSent || reply.destroyed) {
    reply.destroy();
    return;
  }
  const body = JSON.stringify({ error: code });
  reply.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    connection: 'close',
  });
  reply.end(body);
}

function rejectUpgrade(socket: Socket, status: number, code: string): void {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error: code });
  socket.end(
    `HTTP/1.1 ${status} Rejected\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${body}`,
  );
}

/** One process, two sockets: public restricted ingress and loopback Fastify.
 * This factory performs no provider request and never chooses a remote upstream. */
export function createCloudIngress(options: {
  runtime: CloudPhoneRuntime;
  upstreamPort: number;
  upstreamTimeoutMs?: number;
}) {
  const runtime = options?.runtime;
  let pinned: CloudPhoneRuntime;
  try {
    pinned = parsePhoneRuntime({
      AI_PHONE_RUNTIME_MODE: 'cloud',
      PORT: String(runtime?.port),
      CLOUD_PUBLIC_ORIGIN: runtime?.publicOrigin,
      CLOUD_WARM_INSTANCES: String(runtime?.warmInstances),
    }) as CloudPhoneRuntime;
  } catch {
    throw new Error('INVALID_CLOUD_INGRESS');
  }
  const timeoutMs = options.upstreamTimeoutMs ?? 30000;
  if (
    runtime.mode !== 'cloud' ||
    runtime.host !== pinned.host ||
    runtime.publicOrigin !== pinned.publicOrigin ||
    runtime.mediaOrigin !== pinned.mediaOrigin ||
    !Number.isSafeInteger(options.upstreamPort) ||
    options.upstreamPort < 1 ||
    options.upstreamPort > 65535 ||
    options.upstreamPort === pinned.port ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > 30000
  )
    throw new Error('INVALID_CLOUD_INGRESS');
  const authority = new URL(pinned.publicOrigin).host;
  const connections = new Set<Socket>();
  const upstreamSockets = new Set<Socket>();
  const requests = new Set<ClientRequest>();
  const responses = new Set<ServerResponse>();
  let closing = false;
  let closeTask: Promise<void> | undefined;

  const track = (upstream: ClientRequest) => {
    requests.add(upstream);
    upstream.once('close', () => requests.delete(upstream));
    return upstream;
  };
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, reply) => {
    if (closing || responses.size + requests.size >= 64) {
      rejectHttp(reply, 503, 'CLOUD_INGRESS_UNAVAILABLE');
      return;
    }
    if (!validTarget(req, false)) {
      rejectHttp(reply, 404, 'NOT_FOUND');
      return;
    }
    // Railway's fixed probe Host is never a browser/control authority. This
    // exact bodyless GET exposes only the same public app identification.
    const healthProbe =
      req.method === 'GET' &&
      req.url === '/api/health' &&
      req.headers.host === RAILWAY_HEALTH_AUTHORITY;
    const headers = headersForUpstream(
      req,
      healthProbe ? RAILWAY_HEALTH_AUTHORITY : authority,
      false,
      healthProbe,
    );
    if (!headers) {
      rejectHttp(reply, 403, 'CLOUD_INGRESS_FORBIDDEN');
      return;
    }
    if (healthProbe) {
      const body = JSON.stringify({ appId: 'ai-phone-solo' });
      reply.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
        connection: 'close',
      });
      reply.end(body);
      return;
    }
    responses.add(reply);
    reply.once('close', () => responses.delete(reply));
    const chunks: Buffer[] = [];
    let bytes = 0;
    // Buffer the bounded control/form body before forwarding any mutation.
    const bodyTimer = setTimeout(() => {
      rejectHttp(reply, 408, 'CLOUD_INGRESS_TIMEOUT');
      req.destroy();
    }, 10000);
    bodyTimer.unref();
    req.once('error', () => {
      clearTimeout(bodyTimer);
      rejectHttp(reply, 400, 'CLOUD_INGRESS_REQUEST_FAILED');
    });
    req.once('close', () => clearTimeout(bodyTimer));
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        clearTimeout(bodyTimer);
        rejectHttp(reply, 413, 'CLOUD_INGRESS_BODY_LIMIT');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.once('end', () => {
      clearTimeout(bodyTimer);
      if (reply.destroyed || reply.writableEnded || closing) return;
      const body = Buffer.concat(chunks, bytes);
      if (req.method === 'POST')
        headers['content-length'] = String(body.length);
      const upstream = track(
        httpRequest({
          host: '127.0.0.1',
          port: options.upstreamPort,
          method: req.method,
          path: req.url,
          headers,
          agent: false,
          maxHeaderSize: 16 * 1024,
        }),
      );
      const headerTimer = setTimeout(() => {
        rejectHttp(reply, 504, 'CLOUD_INGRESS_UPSTREAM_TIMEOUT');
        upstream.destroy();
      }, timeoutMs);
      headerTimer.unref();
      upstream.once('error', () => {
        clearTimeout(headerTimer);
        rejectHttp(reply, 502, 'CLOUD_INGRESS_UPSTREAM_FAILED');
      });
      reply.once('close', () => {
        clearTimeout(headerTimer);
        upstream.destroy();
      });
      upstream.once('response', (response) => {
        clearTimeout(headerTimer);
        const responseHeaders = { ...response.headers };
        for (const name of droppedHeaders) delete responseHeaders[name];
        // Streaming pipe preserves backpressure; never collect captions/audio.
        reply.writeHead(response.statusCode || 502, responseHeaders);
        response.once('error', () => reply.destroy());
        response.pipe(reply);
      });
      upstream.end(body);
    });
  });
  server.maxConnections = 64;
  server.headersTimeout = 10000;
  server.requestTimeout = 10000;
  server.maxRequestsPerSocket = 100;
  server.keepAliveTimeout = 5000;
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.on('error', () => socket.destroy());
  });
  server.on('upgrade', (req, external, head) => {
    const socket = external as Socket;
    if (
      closing ||
      responses.size + requests.size + upstreamSockets.size >= 64
    ) {
      rejectUpgrade(socket, 503, 'CLOUD_INGRESS_UNAVAILABLE');
      return;
    }
    if (!validTarget(req, true)) {
      rejectUpgrade(socket, 404, 'NOT_FOUND');
      return;
    }
    const headers = headersForUpstream(req, authority, true);
    if (!headers || head.length > MAX_UPGRADE_HEAD_BYTES) {
      rejectUpgrade(socket, 403, 'CLOUD_INGRESS_FORBIDDEN');
      return;
    }
    const upstream = track(
      httpRequest({
        host: '127.0.0.1',
        port: options.upstreamPort,
        method: 'GET',
        path: req.url,
        headers,
        agent: false,
        maxHeaderSize: 16 * 1024,
      }),
    );
    const timer = setTimeout(
      () => {
        rejectUpgrade(socket, 504, 'CLOUD_INGRESS_UPSTREAM_TIMEOUT');
        upstream.destroy();
      },
      Math.min(timeoutMs, 10000),
    );
    timer.unref();
    socket.once('close', () => {
      clearTimeout(timer);
      upstream.destroy();
    });
    upstream.once('error', () => {
      clearTimeout(timer);
      rejectUpgrade(socket, 502, 'CLOUD_INGRESS_UPSTREAM_FAILED');
    });
    upstream.once('response', (response) => {
      clearTimeout(timer);
      response.resume();
      rejectUpgrade(
        socket,
        response.statusCode &&
          response.statusCode >= 400 &&
          response.statusCode < 500
          ? response.statusCode
          : 502,
        'CLOUD_INGRESS_UPSTREAM_REJECTED',
      );
    });
    upstream.once('upgrade', (response, remote, remoteHead) => {
      clearTimeout(timer);
      const expectedAccept = createHash('sha1')
        .update(`${headers['sec-websocket-key']}${WEB_SOCKET_GUID}`)
        .digest('base64');
      if (
        closing ||
        socket.destroyed ||
        response.statusCode !== 101 ||
        response.headers.upgrade?.toLowerCase() !== 'websocket' ||
        response.headers['sec-websocket-accept'] !== expectedAccept ||
        remoteHead.length > MAX_UPGRADE_HEAD_BYTES
      ) {
        remote.destroy();
        rejectUpgrade(socket, 502, 'CLOUD_INGRESS_UPSTREAM_FAILED');
        return;
      }
      const paired = remote as Socket;
      upstreamSockets.add(paired);
      paired.once('close', () => {
        upstreamSockets.delete(paired);
        socket.destroy();
      });
      paired.once('error', () => {
        paired.destroy();
        socket.destroy();
      });
      socket.once('close', () => paired.destroy());
      const responseLines = ['HTTP/1.1 101 Switching Protocols'];
      for (let index = 0; index < response.rawHeaders.length; index += 2)
        responseLines.push(
          `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`,
        );
      socket.write(`${responseLines.join('\r\n')}\r\n\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) paired.write(head);
      socket.pipe(paired);
      paired.pipe(socket);
    });
    upstream.end();
  });
  server.on('clientError', (_error, socket) => {
    rejectUpgrade(socket as Socket, 400, 'CLOUD_INGRESS_REQUEST_FAILED');
  });
  const close = (): Promise<void> => {
    if (closeTask) return closeTask;
    closing = true;
    closeTask = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (
          error &&
          (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
        )
          reject(error);
        else resolve();
      });
      for (const request of requests) request.destroy();
      for (const socket of upstreamSockets) socket.destroy();
      for (const socket of connections) socket.destroy();
    });
    return closeTask;
  };
  return Object.freeze({ server, close });
}
