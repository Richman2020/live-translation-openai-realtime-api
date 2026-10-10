import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Socket } from 'node:net';
import fastify, { type FastifyInstance } from 'fastify';

import { CloudAccessError } from './cloud-access';
import { createCloudAccessTransport } from './cloud-access-transport';
import {
  CLOUD_WEB_VERIFICATION_PUBLIC_PATHS,
  createCloudIngress,
} from './cloud-ingress';
import { parsePhoneRuntime, type CloudPhoneRuntime } from './cloud-runtime';
import type { CloudWebVerificationConfig } from './cloud-web-verification-config';
import {
  GOOGLE_LOGIN_PATHS,
  GoogleBrowserLogin,
  registerGoogleLoginRoutes,
} from './google-login';
import { GoogleOidcClient } from './google-oidc';

const health = Object.freeze({
  appId: 'ai-phone-solo',
  mode: 'web-verification',
  callsEnabled: false,
});
const status = Object.freeze({
  mode: 'web-verification',
  authenticated: true,
  callsEnabled: false,
  phoneStatus: 'disabled',
});
const readPaths = new Set<string>([
  '/api/health',
  '/api/status',
  '/api/browser-session',
  GOOGLE_LOGIN_PATHS.status,
  GOOGLE_LOGIN_PATHS.callback,
]);
const writePaths = new Set<string>([
  GOOGLE_LOGIN_PATHS.start,
  GOOGLE_LOGIN_PATHS.cancel,
  GOOGLE_LOGIN_PATHS.logout,
  GOOGLE_LOGIN_PATHS.renew,
]);
const publicPaths = new Set<string>(CLOUD_WEB_VERIFICATION_PUBLIC_PATHS);

/** Identity and page verification only. There is no telephone resource,
 * journal, voice signer, controller, translation engine or provider instance.
 */
export async function createCloudWebVerificationService(
  config: CloudWebVerificationConfig,
  options: {
    now?: () => number;
    googleFetch?: typeof fetch;
    publicDir?: string;
  } = {},
) {
  const clock = options.now || Date.now;
  const initialTime = clock();
  let runtime: CloudPhoneRuntime;
  try {
    runtime = parsePhoneRuntime({
      AI_PHONE_RUNTIME_MODE: 'cloud',
      PORT: String(config?.runtime?.port),
      CLOUD_PUBLIC_ORIGIN: config?.runtime?.publicOrigin,
      CLOUD_WARM_INSTANCES: String(config?.runtime?.warmInstances),
    }) as CloudPhoneRuntime;
  } catch {
    throw new Error('CLOUD_WEB_VERIFICATION_CONFIG_INVALID');
  }
  if (
    config.mode !== 'web-verification' ||
    config.runtime.mode !== runtime.mode ||
    config.runtime.host !== runtime.host ||
    config.runtime.publicOrigin !== runtime.publicOrigin ||
    config.runtime.mediaOrigin !== runtime.mediaOrigin ||
    !Number.isSafeInteger(initialTime) ||
    initialTime < 0 ||
    !Number.isSafeInteger(config.testDeadline) ||
    config.testDeadline <= initialTime ||
    config.testDeadline - initialTime > 3600000 ||
    config.google?.redirectUri !==
      `${runtime.publicOrigin}${GOOGLE_LOGIN_PATHS.callback}`
  )
    throw new Error('CLOUD_WEB_VERIFICATION_CONFIG_INVALID');
  runtime = Object.freeze(runtime);
  const { testDeadline } = config;
  const authority = new URL(runtime.publicOrigin).host;
  let login: GoogleBrowserLogin | undefined;
  let app: FastifyInstance | undefined;
  let ingress: ReturnType<typeof createCloudIngress> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let expired = false;
  let closing = false;
  let closeTask: Promise<void> | undefined;
  const privateConnections = new Set<Socket>();
  const rejectedUpgrades = new Set<Socket>();
  const close = (): Promise<void> => {
    if (closeTask) return closeTask;
    closing = true;
    clearInterval(timer);
    login?.close();
    for (const socket of privateConnections) socket.destroy();
    for (const socket of rejectedUpgrades) socket.destroy();
    closeTask = (async () => {
      await ingress?.close();
      await app?.close();
    })();
    return closeTask;
  };
  const expireIfDue = (): Promise<void> | undefined => {
    let time: number;
    try {
      time = clock();
    } catch {
      time = NaN;
    }
    if (!Number.isSafeInteger(time) || time < 0 || time >= testDeadline)
      expired = true;
    return expired ? close() : undefined;
  };
  // Reused by the actual OIDC/login final commit clock, not just HTTP admission.
  // Expiry during an awaited exchange cannot publish a usable session cookie.
  const checkedNow = (): number => {
    let time: number;
    try {
      time = clock();
    } catch {
      time = NaN;
    }
    if (
      closing ||
      expired ||
      !Number.isSafeInteger(time) ||
      time < 0 ||
      time >= testDeadline
    ) {
      expired = true;
      close().catch(() => {});
      throw new Error('CLOUD_TEST_EXPIRED');
    }
    return time;
  };
  const deadline = Object.freeze({ assertCurrent: checkedNow, expireIfDue });
  try {
    const { google } = config;
    login = new GoogleBrowserLogin({
      publicOrigin: runtime.publicOrigin,
      now: checkedNow,
      client: new GoogleOidcClient({
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        redirectUri: google.redirectUri,
        allowedEmail: google.allowedEmail,
        ...(google.expectedHostedDomain !== undefined
          ? { expectedHostedDomain: google.expectedHostedDomain }
          : {}),
        ...(google.pinnedGoogleSubject !== undefined
          ? { pinnedGoogleSubject: google.pinnedGoogleSubject }
          : {}),
        ...(options.googleFetch ? { fetch: options.googleFetch } : {}),
        now: checkedNow,
      }),
    });
    app = fastify({
      logger: false,
      disableRequestLogging: true,
      trustProxy: false,
      bodyLimit: 16 * 1024,
    });
    app.addHook('onRequest', (request, reply, done) => {
      reply
        .header('cache-control', 'private, no-store')
        .header('referrer-policy', 'no-referrer')
        .header('x-content-type-options', 'nosniff');
      try {
        checkedNow();
      } catch {
        reply.code(503).send({ error: 'CLOUD_TEST_EXPIRED' });
        return;
      }
      const remote = request.raw.socket.remoteAddress || request.ip;
      const headerNames = request.raw.rawHeaders
        .filter((_value, index) => index % 2 === 0)
        .map((name) => name.toLowerCase());
      if (
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) ||
        new Set(headerNames).size !== headerNames.length ||
        request.headers.host !== authority ||
        [
          'forwarded',
          'x-forwarded-for',
          'x-forwarded-host',
          'x-forwarded-proto',
        ].some((name) => request.headers[name] !== undefined) ||
        (request.headers.origin !== undefined &&
          request.headers.origin !== runtime.publicOrigin)
      ) {
        reply.code(403).send({ error: 'CLOUD_INGRESS_FORBIDDEN' });
        return;
      }
      const path = request.url.split('?')[0];
      if (
        request.headers.upgrade !== undefined ||
        (request.url.includes('?') && path !== GOOGLE_LOGIN_PATHS.callback) ||
        !(
          (request.method === 'GET' &&
            (readPaths.has(path) || publicPaths.has(path))) ||
          (request.method === 'HEAD' && publicPaths.has(path)) ||
          (request.method === 'POST' && writePaths.has(path))
        )
      ) {
        reply.code(403).send({ error: 'CALLS_DISABLED' });
        return;
      }
      done();
    });
    app.addHook('onSend', (_request, _reply, payload, done) => {
      try {
        checkedNow();
        done(null, payload);
      } catch {
        _reply
          .code(503)
          .removeHeader('set-cookie')
          .removeHeader('location')
          .removeHeader('content-length')
          .type('application/json');
        done(null, JSON.stringify({ error: 'CLOUD_TEST_EXPIRED' }));
      }
    });
    app.setErrorHandler((error, _request, reply) => {
      reply
        .code(error instanceof CloudAccessError ? error.statusCode : 503)
        .send({
          error:
            error instanceof CloudAccessError
              ? error.code
              : 'WEB_VERIFICATION_UNAVAILABLE',
        });
    });
    registerGoogleLoginRoutes(app, login);
    const transport = createCloudAccessTransport(login.policy);
    app.get('/api/health', () => health);
    app.get('/api/status', transport.sessionHttpRoute('read'), (request) =>
      transport.executeSessionHttp(request, () => status),
    );
    app.get(
      '/api/browser-session',
      transport.sessionHttpRoute('read'),
      (request) =>
        transport.executeSessionHttp(request, (context) => ({
          authenticated: true,
          csrfToken: login.policy.currentCsrfToken(context),
          expiresAt: Math.min(testDeadline, login.policy.expiresAt(context)),
        })),
    );
    const publicDir = resolve(options.publicDir || 'public');
    for (const path of CLOUD_WEB_VERIFICATION_PUBLIC_PATHS) {
      const filename =
        path === '/controlled' ? 'web-verification.html' : path.slice(1);
      app.get(path, (_request, reply) => {
        reply.header(
          'content-security-policy',
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        );
        const type = {
          '/controlled': 'text/html; charset=utf-8',
          '/web-verification.js': 'text/javascript; charset=utf-8',
          '/styles.css': 'text/css; charset=utf-8',
          '/favicon.svg': 'image/svg+xml',
        }[path];
        return reply
          .type(type)
          .send(readFileSync(resolve(publicDir, filename)));
      });
    }
    app.server.on('connection', (socket) => {
      if (closing) {
        socket.destroy();
        return;
      }
      privateConnections.add(socket);
      socket.on('error', () => socket.destroy());
      socket.once('close', () => privateConnections.delete(socket));
    });
    app.server.on('upgrade', (_request, socket) => {
      const connection = socket as Socket;
      if (closing) {
        connection.destroy();
        return;
      }
      rejectedUpgrades.add(connection);
      connection.on('error', () => connection.destroy());
      connection.once('close', () => rejectedUpgrades.delete(connection));
      const body = JSON.stringify({ error: 'CALLS_DISABLED' });
      connection.end(
        `HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        () => connection.destroy(),
      );
    });
    app.server.maxConnections = 64;
    await app.listen({ host: '127.0.0.1', port: 0 });
    checkedNow();
    const address = app.server.address();
    if (!address || typeof address === 'string')
      throw new Error('CLOUD_PRIVATE_LISTENER_FAILED');
    ingress = createCloudIngress({
      runtime,
      upstreamPort: address.port,
      mode: 'web-verification',
    });
    await new Promise<void>((resolveStarted, reject) => {
      ingress.server.once('error', reject);
      ingress.server.listen(runtime.port, runtime.host, () => {
        ingress.server.removeListener('error', reject);
        resolveStarted();
      });
    });
    checkedNow();
    timer = setInterval(() => expireIfDue()?.catch(() => {}), 250);
    timer.unref();
    return Object.freeze({ app, ingress, login, deadline, close });
  } catch (error) {
    await close();
    throw error;
  }
}
