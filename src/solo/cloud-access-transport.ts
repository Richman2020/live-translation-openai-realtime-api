import type { FastifyReply, FastifyRequest, onSendHookHandler } from 'fastify';
import WebSocket, { type RawData } from 'ws';

import {
  CLOUD_CSRF_HEADER,
  CloudAccessError,
  CloudAccessPolicy,
  type CloudAccessAction,
  type CloudAccessContext,
  type CloudAccessHeaders,
  type CloudRequestSource,
} from './cloud-access';

export const CLOUD_BROWSER_WS_MAX_PAYLOAD = 16 * 1024;

export type CloudHttpScope = Readonly<{
  callId: string;
  action: CloudAccessAction;
}>;
export type CloudBrowserMessage = Readonly<{
  callId: string;
  action: CloudAccessAction;
  csrfToken?: string;
  payload?: unknown;
}>;
export type CloudBrowserOutput = Readonly<{
  callId: string;
  kind: 'audio' | 'transcript';
  payload: unknown;
}>;

type RequestGrant = {
  context: CloudAccessContext;
  headers: CloudAccessHeaders;
  scope: Readonly<{ action: CloudAccessAction; callId?: string }>;
  source: CloudRequestSource;
  socketBound?: boolean;
};
class CloudTransportUnavailable extends Error {
  readonly statusCode = 503;

  readonly code = 'CLOUD_ACCESS_UNAVAILABLE';

  constructor() {
    super('CLOUD_ACCESS_UNAVAILABLE');
  }
}

const sensitiveHeaders = new Set([
  'host',
  'origin',
  'cookie',
  'authorization',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  CLOUD_CSRF_HEADER,
  'x-phone-controller-lease',
]);
const actions = new Set<CloudAccessAction>([
  'read',
  'mutate',
  'audio',
  'audio-write',
  'transcript',
  'takeover',
]);

function sameContext(left: CloudAccessContext, right: CloudAccessContext) {
  return (
    left.authSessionId === right.authSessionId &&
    left.principalId === right.principalId &&
    left.browserOwnerId === right.browserOwnerId &&
    left.epoch === right.epoch
  );
}
function browserHeaders(request: FastifyRequest): CloudAccessHeaders {
  let path: string;
  try {
    path = decodeURIComponent(request.url.split('?')[0]);
  } catch {
    throw new CloudAccessError('FORBIDDEN');
  }
  // This adapter is exclusively for browsers, never Twilio's signed transport.
  if (path === '/voice' || path.startsWith('/voice/'))
    throw new CloudAccessError('FORBIDDEN');
  const raw = request.raw.rawHeaders;
  if (!Array.isArray(raw) || raw.length % 2)
    throw new CloudAccessError('FORBIDDEN');
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 2) {
    const key = raw[index].toLowerCase();
    if (sensitiveHeaders.has(key)) {
      if (seen.has(key)) throw new CloudAccessError('FORBIDDEN');
      seen.add(key);
      if (request.headers[key] !== raw[index + 1])
        throw new CloudAccessError('FORBIDDEN');
    }
  }
  for (const key of sensitiveHeaders) {
    if (request.headers[key] !== undefined && !seen.has(key))
      throw new CloudAccessError('FORBIDDEN');
  }
  return Object.freeze({ ...request.headers });
}
function privateResponseHeaders(reply: FastifyReply) {
  reply.header('cache-control', 'private, no-store');
  const existing = reply.getHeader('vary');
  const fields = (Array.isArray(existing) ? existing : [existing])
    .flatMap((value) => (typeof value === 'string' ? value.split(',') : []))
    .map((value) => value.trim())
    .filter(Boolean);
  if (fields.includes('*')) return;
  const merged = new Map(fields.map((field) => [field.toLowerCase(), field]));
  for (const field of [
    'Origin',
    'Sec-Fetch-Site',
    'Sec-Fetch-Mode',
    'Sec-Fetch-Dest',
    'Cookie',
  ])
    if (!merged.has(field.toLowerCase()))
      merged.set(field.toLowerCase(), field);
  reply.header('vary', [...merged.values()].join(', '));
}
function denyReply(reply: FastifyReply, error: unknown) {
  privateResponseHeaders(reply);
  if (error instanceof CloudAccessError)
    return reply.code(error.statusCode).send({ error: error.code });
  return reply.code(503).send({ error: 'CLOUD_ACCESS_UNAVAILABLE' });
}
function parseMessage(raw: RawData, binary: boolean): CloudBrowserMessage {
  if (binary) throw new CloudAccessError('FORBIDDEN');
  let buffer: Buffer;
  if (Buffer.isBuffer(raw)) buffer = raw;
  else if (Array.isArray(raw)) buffer = Buffer.concat(raw);
  else buffer = Buffer.from(raw);
  if (buffer.length > CLOUD_BROWSER_WS_MAX_PAYLOAD)
    throw new CloudAccessError('FORBIDDEN');
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new CloudAccessError('FORBIDDEN');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CloudAccessError('FORBIDDEN');
  const message = value as Record<string, unknown>;
  if (
    typeof message.callId !== 'string' ||
    !actions.has(message.action as CloudAccessAction) ||
    Object.keys(message).some(
      (key) => !['callId', 'action', 'csrfToken', 'payload'].includes(key),
    ) ||
    (message.csrfToken !== undefined && typeof message.csrfToken !== 'string')
  )
    throw new CloudAccessError('FORBIDDEN');
  return message as CloudBrowserMessage;
}

/** Unregistered browser boundary. It requires an explicit server-side policy.
 * No login provider, fake identity, phone backend or production routes are supplied.
 * Register @fastify/websocket with maxPayload=CLOUD_BROWSER_WS_MAX_PAYLOAD
 * before using its socket hooks. HTTP supports buffered responses only; register
 * httpRoute's paired hooks as the route's final authorization/send boundary.
 */
export function createCloudAccessTransport(
  policy: CloudAccessPolicy,
  options: {
    maxSockets?: number;
    maxSocketsPerSession?: number;
  } = {},
) {
  const maxSockets = options.maxSockets ?? 16;
  const maxSocketsPerSession = options.maxSocketsPerSession ?? 2;
  if (
    !Number.isSafeInteger(maxSockets) ||
    maxSockets < 1 ||
    maxSockets > 256 ||
    !Number.isSafeInteger(maxSocketsPerSession) ||
    maxSocketsPerSession < 1 ||
    maxSocketsPerSession > maxSockets
  )
    throw new CloudAccessError('FORBIDDEN');
  const reservations = new Set<RequestGrant>();
  const httpGrants = new WeakMap<FastifyRequest, RequestGrant>();
  const socketGrants = new WeakMap<FastifyRequest, RequestGrant>();
  function authenticate(
    request: FastifyRequest,
    scope: RequestGrant['scope'],
    source: CloudRequestSource,
  ): RequestGrant {
    const headers = browserHeaders(request);
    const context = policy.authenticate(headers, scope.action, source);
    if (scope.callId !== undefined)
      policy.authorizeCall(context, scope.callId, scope.action);
    return {
      headers,
      context,
      source: Object.freeze({ ...source }),
      scope: Object.freeze({ ...scope }),
    };
  }
  function httpGuard(
    scopeFor: (request: FastifyRequest) => RequestGrant['scope'],
  ) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      privateResponseHeaders(reply);
      try {
        httpGrants.set(
          request,
          authenticate(request, scopeFor(request), {
            surface: 'http',
            method: request.method,
          }),
        );
      } catch (error) {
        return denyReply(reply, error);
      }
      return undefined;
    };
  }
  const responseGuard: onSendHookHandler = (request, reply, payload, done) => {
    privateResponseHeaders(reply);
    const grant = httpGrants.get(request);
    if (!grant) {
      done(null, payload);
      return;
    }
    try {
      if (
        payload !== null &&
        payload !== undefined &&
        typeof payload !== 'string' &&
        !Buffer.isBuffer(payload)
      ) {
        const stream = payload as { destroy?: () => void };
        if (typeof stream.destroy === 'function') stream.destroy();
        throw new CloudTransportUnavailable();
      }
      if (grant.scope.callId === undefined)
        policy.runAuthorizedSession(grant.context, grant.scope.action, () =>
          done(null, payload),
        );
      else
        policy.runAuthorizedCall(
          grant.context,
          grant.scope.callId,
          grant.scope.action,
          () => done(null, payload),
        );
    } catch (error) {
      const known = error instanceof CloudAccessError;
      reply.code(known ? error.statusCode : 503);
      reply.removeHeader('content-length');
      reply.header('content-type', 'application/json');
      done(
        null,
        JSON.stringify({
          error: known ? error.code : 'CLOUD_ACCESS_UNAVAILABLE',
        }),
      );
    }
  };
  function httpRoute(scopeFor: (request: FastifyRequest) => CloudHttpScope) {
    return { preHandler: httpGuard(scopeFor), onSend: responseGuard };
  }
  function sessionHttpRoute(action: CloudAccessAction) {
    return { preHandler: httpGuard(() => ({ action })), onSend: responseGuard };
  }
  /** Pre-header check only. Streaming users must authorize every write/heartbeat. */
  function sessionStreamGuard(action: CloudAccessAction = 'read') {
    return httpGuard(() => ({ action }));
  }
  function requestContext(request: FastifyRequest): CloudAccessContext {
    const grant = httpGrants.get(request);
    if (!grant) throw new CloudAccessError('UNAUTHORIZED');
    return grant.context;
  }
  async function executeSessionHttp<Result>(
    request: FastifyRequest,
    commit: (context: CloudAccessContext) => Result,
  ) {
    const grant = httpGrants.get(request);
    if (!grant || grant.scope.callId !== undefined)
      throw new CloudAccessError('UNAUTHORIZED');
    try {
      return policy.runAuthorizedSession(
        grant.context,
        grant.scope.action,
        commit,
      );
    } catch (error) {
      if (error instanceof CloudAccessError) throw error;
      throw new CloudTransportUnavailable();
    }
  }
  async function executeHttp<Result>(
    request: FastifyRequest,
    commit: (context: CloudAccessContext) => Result,
  ) {
    const grant = httpGrants.get(request);
    if (!grant || grant.scope.callId === undefined)
      throw new CloudAccessError('UNAUTHORIZED');
    // Async preparation belongs before this call. The final check and synchronous
    // commit share the core continuation; asynchronous external effects remain
    // the caller's separate transaction/lease responsibility.
    try {
      return policy.runAuthorizedCall(
        grant.context,
        grant.scope.callId,
        grant.scope.action,
        commit,
      );
    } catch (error) {
      if (error instanceof CloudAccessError) throw error;
      throw new CloudTransportUnavailable();
    }
  }
  function browserSocketGuard(callFor: (request: FastifyRequest) => string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!request.ws) throw new CloudAccessError('FORBIDDEN');
        const grant = authenticate(
          request,
          { callId: callFor(request), action: 'read' },
          { surface: 'browser-ws' },
        );
        const active = [...reservations].filter((item) =>
          sameContext(item.context, grant.context),
        ).length;
        if (reservations.size >= maxSockets || active >= maxSocketsPerSession)
          throw new CloudAccessError('FORBIDDEN');
        reservations.add(grant);
        socketGrants.set(request, grant);
        reply.raw.once('close', () => {
          if (!grant.socketBound) reservations.delete(grant);
        });
        request.raw.once?.('aborted', () => {
          if (!grant.socketBound) reservations.delete(grant);
        });
      } catch (error) {
        return denyReply(reply, error);
      }
      return undefined;
    };
  }
  function bindBrowserSocket(
    socket: WebSocket,
    request: FastifyRequest,
    socketOptions: {
      onMessage: (
        message: CloudBrowserMessage,
        context: CloudAccessContext,
      ) => void;
      revalidationIntervalMs?: number;
    },
  ) {
    const grant = socketGrants.get(request);
    const intervalMs = socketOptions.revalidationIntervalMs ?? 1000;
    if (
      !grant ||
      Object.prototype.toString.call(socketOptions.onMessage) !==
        '[object Function]' ||
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < 10 ||
      intervalMs > 30000
    ) {
      socket.once('close', () => {
        if (grant) reservations.delete(grant);
      });
      socket.close(1008, 'Browser access denied');
      throw new CloudAccessError('FORBIDDEN');
    }
    grant.socketBound = true;
    let disposed = false;
    let pendingMessages = 0;
    let pendingSends = 0;
    let messages = Promise.resolve();
    let sends = Promise.resolve();
    let timer: ReturnType<typeof setInterval>;
    let messageListener: (raw: RawData, binary: boolean) => void;
    function close(code = 1008) {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      socket.removeListener('message', messageListener);
      if (socket.readyState === WebSocket.OPEN)
        socket.close(code, 'Browser access closed');
    }
    function check() {
      if (disposed) return false;
      try {
        policy.runAuthorizedCall(
          grant.context,
          grant.scope.callId,
          'read',
          () => undefined,
        );
        return !disposed;
      } catch {
        close();
        return false;
      }
    }
    function onMessage(raw: RawData, binary: boolean) {
      if (disposed) return;
      let size: number;
      if (Buffer.isBuffer(raw)) size = raw.length;
      else if (Array.isArray(raw))
        size = raw.reduce((total, part) => total + part.length, 0);
      else size = raw.byteLength;
      if (binary || size > CLOUD_BROWSER_WS_MAX_PAYLOAD) {
        close();
        return;
      }
      pendingMessages += 1;
      if (pendingMessages > 16) {
        close(1013);
        return;
      }
      messages = messages
        .then(() => {
          if (disposed) return;
          const message = parseMessage(raw, binary);
          if (message.callId !== grant.scope.callId)
            throw new CloudAccessError('NOT_FOUND');
          policy.revalidate(grant.context);
          // Browser WS cannot set a custom upgrade CSRF header. Only the token
          // field is mapped; frame cookie/owner/session fields are never accepted.
          const context = policy.authenticate(
            {
              ...grant.headers,
              [CLOUD_CSRF_HEADER]: message.csrfToken,
            },
            message.action,
            grant.source,
          );
          if (!sameContext(context, grant.context))
            throw new CloudAccessError('UNAUTHORIZED');
          policy.runAuthorizedCall(
            context,
            grant.scope.callId,
            message.action,
            () => {
              if (!disposed && socket.readyState === WebSocket.OPEN)
                return socketOptions.onMessage(message, context);
              return undefined;
            },
          );
        })
        .catch(() => close())
        .finally(() => {
          pendingMessages -= 1;
        });
    }
    async function send(output: CloudBrowserOutput) {
      if (disposed) return false;
      if (
        output.callId !== grant.scope.callId ||
        !['audio', 'transcript'].includes(output.kind)
      ) {
        close();
        return false;
      }
      pendingSends += 1;
      if (pendingSends > 32) {
        close(1013);
        pendingSends -= 1;
        return false;
      }
      let delivered = false;
      const task = sends
        .then(() => {
          if (disposed) return;
          const serialized = JSON.stringify(output);
          if (Buffer.byteLength(serialized) > 64 * 1024) {
            close(1013);
            return;
          }
          policy.runAuthorizedCall(
            grant.context,
            grant.scope.callId,
            output.kind,
            () => {
              if (disposed || socket.readyState !== WebSocket.OPEN) return;
              if (
                socket.bufferedAmount + Buffer.byteLength(serialized) >
                256 * 1024
              ) {
                close(1013);
                return;
              }
              socket.send(serialized);
              delivered = true;
            },
          );
        })
        .catch(() => close())
        .finally(() => {
          pendingSends -= 1;
        });
      sends = task;
      await task;
      return delivered;
    }
    messageListener = onMessage;
    socket.on('message', messageListener);
    socket.once('close', () => {
      reservations.delete(grant);
      close();
    });
    socket.once('error', () => close());
    timer = setInterval(() => {
      if (!disposed) check();
    }, intervalMs);
    timer.unref();
    return {
      send,
      check,
      close,
      get closed() {
        return disposed;
      },
      callId: grant.scope.callId,
    };
  }
  return {
    httpRoute,
    executeHttp,
    sessionHttpRoute,
    executeSessionHttp,
    requestContext,
    sessionStreamGuard,
    browserSocketGuard,
    bindBrowserSocket,
  };
}
