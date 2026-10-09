import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import fastify from 'fastify';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import twilio from 'twilio';
import type WebSocket from 'ws';

import { desktopConnectivity } from './desktop-connectivity';
import { ConnectionMaintenance } from './connection-maintenance';
import { ConfigStore } from './config';
import { loadPhoneRuntime, requireLocalPhoneRuntime } from './cloud-runtime';
import { CloudAccessError } from './cloud-access';
import { createCloudAccessTransport } from './cloud-access-transport';
import { CloudPhoneAccess } from './cloud-phone-access';
import { createOwnedPhoneEventStreams } from './phone-event-stream';
import {
  isLocalRequest,
  sameOrigin,
  validLocalToken,
  validTwilioRequest,
} from './security';
import { SessionError, SessionManager, type Role } from './session-manager';
import { verifyProviders, checkTranslationEngine } from './provider-checks';
import { checkPublicReadiness } from './public-readiness';
import { closeNanoVoiceWorker, nanoVoiceStatus } from './nano-runtime';
import { closePocketVoiceWorker, pocketVoiceStatus } from './pocket-runtime';
import {
  isTranslationEngine,
  TRANSLATION_ENGINES,
  type TranslationEngine,
} from './translation-engine';

export async function buildSoloServer(
  options: {
    configStore?: ConfigStore;
    sessionManager?: SessionManager;
    publicDir?: string;
    publicReadinessChecker?: typeof checkPublicReadiness;
    translationReadinessChecker?: typeof checkTranslationEngine;
    providerVerifier?: typeof verifyProviders;
    browserControl?: CloudPhoneAccess;
  } = {},
) {
  // Exported builders are also entry points: never expose local control APIs by
  // bypassing index.ts in a cloud process.
  requireLocalPhoneRuntime(
    loadPhoneRuntime({ envPath: options.configStore?.envPath }),
  );
  const { browserControl } = options;
  if (
    browserControl !== undefined &&
    (!(browserControl instanceof CloudPhoneAccess) ||
      !options.configStore ||
      !options.sessionManager ||
      browserControl.manager !== options.sessionManager ||
      options.publicReadinessChecker !== undefined ||
      options.translationReadinessChecker !== undefined ||
      options.providerVerifier !== undefined)
  )
    throw new SessionError('CLOUD_PHONE_DEPENDENCIES_REQUIRED', 503);
  const configStore = options.configStore || new ConfigStore();
  const manager = options.sessionManager || new SessionManager();
  browserControl?.assertConfig(configStore.value);
  const browserTransport = browserControl
    ? createCloudAccessTransport(browserControl.policy)
    : null;
  const publicDir = resolve(options.publicDir || 'public');
  // URLs can carry stream nonces/SSE tokens. Never enable automatic HTTP logging.
  const app = fastify({
    logger: false,
    disableRequestLogging: true,
    trustProxy: false,
    bodyLimit: 16 * 1024,
  });
  const ownedEventStreams =
    browserControl && browserTransport
      ? createOwnedPhoneEventStreams({
          access: browserControl,
          transport: browserTransport,
          manager,
        })
      : null;
  const subscribers = new Set<
    (event: { event: string; data: unknown }) => void
  >();
  const eventStreams = new Set<ServerResponse>();
  let lastVerification: Awaited<ReturnType<typeof verifyProviders>> | null =
    null;
  let verifying = false;
  let checkingOutbound = false;
  let lastVerifyAttempt = 0;
  const maintenance = new ConnectionMaintenance();
  const broadcast = (event: { event: string; data: unknown }) => {
    for (const subscriber of subscribers) subscriber(event);
  };
  manager.on('event', broadcast);
  const status = () => ({
    mode: 'solo',
    configured: configStore.configured(),
    checks: configStore.checks(),
    identity: 'ai-phone',
    publicUrl: configStore.value.PUBLIC_BASE_URL,
    realtimeModel: configStore.value.OPENAI_REALTIME_MODEL,
    callerNumber: configStore.value.TWILIO_CALLER_NUMBER,
    activeSession: manager.activeSession,
    lastVerification,
    translationEngines: TRANSLATION_ENGINES,
    defaultTranslationEngine: 'legacy',
    nanoVoice: nanoVoiceStatus(),
    pocketVoice: pocketVoiceStatus(),
    connectionMaintenance: maintenance.active,
    desktopConnection: desktopConnectivity(),
  });
  function requestedEngine(body: unknown): TranslationEngine {
    if (
      body !== undefined &&
      (body === null || typeof body !== 'object' || Array.isArray(body))
    )
      throw new SessionError('INVALID_TRANSLATION_ENGINE');
    const value = (body as { translationEngine?: unknown })?.translationEngine;
    if (value === undefined) return 'legacy';
    if (!isTranslationEngine(value))
      throw new SessionError('INVALID_TRANSLATION_ENGINE');
    return value;
  }
  function requireConfigured() {
    if (!configStore.configured())
      throw new SessionError('CONFIGURATION_REQUIRED', 503);
  }
  await app.register(formbody);
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff');
    // Minimal deployment probe is the sole public route outside /voice/.
    if (path === '/api/health' && req.method === 'GET') return undefined;
    if (path.startsWith('/voice/')) return undefined;
    if (browserControl && path.startsWith('/api/')) {
      reply
        .header('Cache-Control', 'private, no-store')
        .header(
          'Vary',
          'Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest, Cookie',
        );
      // This dependency-injected path remains an offline loopback application
      // boundary. It cannot enable a cloud listener or bypass startup protection.
      const remote = req.raw.socket.remoteAddress || req.ip;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote))
        return reply.code(403).send({ error: 'LOCAL_ACCESS_ONLY' });
      if (
        !['/api/status', '/api/calls', '/api/events'].includes(path) &&
        !/^\/api\/calls\/[^/]+\/hangup$/.test(path)
      )
        return reply.code(503).send({ error: 'CLOUD_CONTROL_UNAVAILABLE' });
      return undefined;
    }
    if (!isLocalRequest(req, configStore.value.API_PORT) || !sameOrigin(req))
      return reply.code(403).send({ error: 'LOCAL_ACCESS_ONLY' });
    if (path.startsWith('/api/') && !validLocalToken(req, configStore.value))
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    return undefined;
  });
  app.addHook('preValidation', async (req, reply) => {
    if (!req.url.split('?')[0].startsWith('/voice/')) return undefined;
    const isMedia =
      req.method === 'GET' && req.url.split('?')[0] === '/voice/media';
    if (!validTwilioRequest(req, configStore.value, isMedia))
      return reply.code(403).send({ error: 'INVALID_TWILIO_SIGNATURE' });
    return undefined;
  });
  app.setErrorHandler((error, req, reply) => {
    const code =
      error instanceof SessionError || error instanceof CloudAccessError
        ? error.code
        : 'REQUEST_FAILED';
    let statusCode = 500;
    if (error instanceof SessionError) statusCode = error.statusCode;
    else if (error.statusCode && error.statusCode < 500)
      statusCode = error.statusCode;
    reply.code(statusCode).send({
      error: code,
      ...(code === 'CONFIGURATION_REQUIRED' && !browserControl
        ? { checks: configStore.checks() }
        : {}),
    });
  });
  app.get('/api/health', async () => ({ appId: 'ai-phone-solo' }));
  app.get('/health', async () => ({
    appId: 'ai-phone-solo',
    mode: 'solo',
    ok: true,
  }));
  app.get(
    '/api/status',
    browserTransport?.sessionHttpRoute('read') || {},
    async (req) => {
      if (browserControl && browserTransport)
        return browserTransport.executeSessionHttp(req, (context) => ({
          mode: 'solo',
          activeSession: browserControl.ownedActive(context),
        }));
      return status();
    },
  );
  app.post<{ Body: { action: string; lease?: string } }>(
    '/api/connection-maintenance',
    async (req) => {
      try {
        if (req.body?.action === 'begin') {
          const lease = maintenance.begin(
            Boolean(manager.activeSession || verifying || checkingOutbound),
          );
          return { lease, expiresInMs: 180000 };
        }
        if (req.body?.action === 'renew') maintenance.renew(req.body.lease);
        else if (req.body?.action === 'end') maintenance.end(req.body.lease);
        else throw new Error('INVALID_MAINTENANCE_LEASE');
        return { ok: true };
      } catch (error) {
        throw new SessionError(
          error instanceof Error &&
          error.message === 'CONNECTION_MAINTENANCE_BUSY'
            ? 'CONNECTION_MAINTENANCE_BUSY'
            : 'INVALID_MAINTENANCE_LEASE',
          409,
        );
      }
    },
  );
  app.post<{ Body: Record<string, unknown> }>('/api/settings', async (req) => {
    if (
      maintenance.active &&
      !maintenance.matches(req.headers['x-phone-maintenance'])
    )
      throw new SessionError('CONNECTION_MAINTENANCE_BUSY', 409);
    if (manager.activeSession || verifying || checkingOutbound)
      throw new SessionError('CALL_OR_VERIFICATION_IN_PROGRESS', 409);
    if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object')
      throw new SessionError('INVALID_SETTINGS');
    if (
      ['API_HOST', 'API_PORT', 'LOCAL_ACCESS_TOKEN'].some(
        (name) => name in req.body,
      )
    )
      throw new SessionError('PRIVATE_BOOTSTRAP_SETTING');
    try {
      configStore.save(req.body);
    } catch {
      throw new SessionError('INVALID_SETTINGS');
    }
    lastVerification = null;
    return { ok: true, ...status() };
  });
  app.post('/api/verify', async (req) => {
    if (
      maintenance.active &&
      !maintenance.matches(req.headers['x-phone-maintenance'])
    )
      throw new SessionError('CONNECTION_MAINTENANCE_BUSY', 409);
    const engine = requestedEngine(req.body);
    if (manager.activeSession || verifying || checkingOutbound)
      throw new SessionError('CALL_OR_VERIFICATION_IN_PROGRESS', 409);
    if (Date.now() - lastVerifyAttempt < 30000)
      throw new SessionError('VERIFICATION_COOLDOWN', 429);
    verifying = true;
    lastVerifyAttempt = Date.now();
    try {
      lastVerification = await (options.providerVerifier || verifyProviders)(
        configStore.value,
        engine,
      );
      return lastVerification;
    } finally {
      verifying = false;
    }
  });
  app.post('/api/shutdown', async (_req, reply) => {
    // Keep HTTP available on failure so late callbacks or another shutdown
    // attempt can confirm every call's final state before this process exits.
    await manager.close();
    reply.send({ ok: true, safeToStop: true });
    setImmediate(() => {
      app.close().catch(() => {});
    });
    return reply;
  });
  app.get('/api/token', async () => {
    requireConfigured();
    const config = configStore.value;
    const access = new twilio.jwt.AccessToken(
      config.TWILIO_ACCOUNT_SID,
      config.TWILIO_API_KEY_SID,
      config.TWILIO_API_KEY_SECRET,
      { identity: 'ai-phone', ttl: 3600 },
    );
    access.addGrant(
      new twilio.jwt.AccessToken.VoiceGrant({
        outgoingApplicationSid: config.TWILIO_TWIML_APP_SID,
        incomingAllow: true,
      }),
    );
    return { token: access.toJwt(), identity: 'ai-phone' };
  });
  app.post<{ Body: { available: boolean } }>('/api/presence', async (req) => {
    if (typeof req.body?.available !== 'boolean')
      throw new SessionError('INVALID_PRESENCE');
    manager.setPresence(req.body.available);
    return { ok: true, available: manager.available };
  });
  app.post<{ Body: { to: string; translationEngine?: TranslationEngine } }>(
    '/api/calls',
    browserTransport?.sessionHttpRoute('mutate') || {},
    async (req) => {
      const engine = requestedEngine(req.body);
      if (maintenance.active)
        throw new SessionError('CONNECTION_MAINTENANCE_BUSY', 409);
      if (verifying || checkingOutbound)
        throw new SessionError('VERIFICATION_IN_PROGRESS', 409);
      requireConfigured();
      if (typeof req.body?.to !== 'string')
        throw new SessionError('INVALID_DESTINATION');
      if (browserControl && browserTransport) {
        const prepared = await browserControl.prepareCreate(
          browserTransport.requestContext(req),
          configStore.value,
          req.body.to.trim(),
          engine,
        );
        return browserControl.createPrepared(prepared);
      }
      if (manager.activeSession) throw new SessionError('BUSY', 409);
      checkingOutbound = true;
      try {
        // A registered browser cannot establish a phone call when its public
        // TwiML/media entry is offline. Check before creating even a local session.
        const readiness = await (
          options.publicReadinessChecker || checkPublicReadiness
        )(configStore.value);
        if (readiness.status !== 'ready')
          throw new SessionError(readiness.code, 503);
        // Check both candidate language sessions before a real call is created.
        // A successful legacy probe cannot authorize a different endpoint/model.
        if (engine !== 'legacy') {
          const translation = await (
            options.translationReadinessChecker || checkTranslationEngine
          )(configStore.value, engine);
          if (translation.status !== 'passed')
            throw new SessionError('TRANSLATION_ENGINE_UNAVAILABLE', 503);
        }
        return manager.createOutbound(
          configStore.value,
          req.body.to.trim(),
          engine,
        );
      } finally {
        checkingOutbound = false;
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/calls/:id/hangup',
    browserTransport?.httpRoute((req) => ({
      callId: (req.params as { id: string }).id,
      action: 'mutate',
    })) || {},
    async (req) => {
      if (browserControl && browserTransport) {
        const context = browserTransport.requestContext(req);
        const intent = browserControl.beginHangup(context, req.params.id);
        await browserControl.finishHangup(intent);
        if (!browserControl.recheckCleanup(context, req.params.id))
          throw new SessionError('CALL_CLEANUP_UNCONFIRMED', 503);
        return { ok: true };
      }
      await manager.end(req.params.id);
      if (!manager.isCleanupConfirmed(req.params.id))
        throw new SessionError('CALL_CLEANUP_UNCONFIRMED', 503);
      return { ok: true };
    },
  );
  if (ownedEventStreams) {
    app.get(
      '/api/events',
      { preHandler: ownedEventStreams.guard },
      ownedEventStreams.handler,
    );
  } else
    app.get('/api/events', (req, reply) => {
      if (subscribers.size >= 5)
        return reply.code(429).send({ error: 'TOO_MANY_EVENT_CONNECTIONS' });
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Referrer-Policy': 'no-referrer',
      });
      const send = ({ event, data }: { event: string; data: unknown }) => {
        if (!reply.raw.destroyed) {
          // Disconnect stalled tabs instead of buffering unbounded transcripts.
          if (reply.raw.writableLength > 256 * 1024) {
            reply.raw.destroy();
            return;
          }
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };
      send({
        event: 'snapshot',
        data: { activeSession: manager.activeSession },
      });
      subscribers.add(send);
      eventStreams.add(reply.raw);
      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(': keepalive\n\n');
      }, 20000);
      heartbeat.unref?.();
      reply.raw.once('close', () => {
        clearInterval(heartbeat);
        subscribers.delete(send);
        eventStreams.delete(reply.raw);
      });
      return undefined;
    });

  app.post<{ Body: Record<string, string> }>(
    '/voice/client',
    async (req, reply) => {
      requireConfigured();
      return reply.type('text/xml').send(manager.connectBrowser(req.body));
    },
  );
  app.post<{ Body: Record<string, string> }>(
    '/voice/incoming',
    async (req, reply) => {
      if (browserControl) {
        const response = new twilio.twiml.VoiceResponse();
        response.reject({ reason: 'busy' });
        return reply.type('text/xml').send(response.toString());
      }
      requireConfigured();
      if (verifying || maintenance.active) {
        const response = new twilio.twiml.VoiceResponse();
        response.reject({ reason: 'busy' });
        return reply.type('text/xml').send(response.toString());
      }
      return reply
        .type('text/xml')
        .send(manager.acceptIncoming(configStore.value, req.body));
    },
  );
  type LegQuery = { sessionId: string; role: Role; nonce: string };
  app.post<{ Querystring: LegQuery; Body: Record<string, string> }>(
    '/voice/connect',
    async (req, reply) =>
      reply
        .type('text/xml')
        .send(
          manager.connectLeg(
            req.query.sessionId,
            req.query.role,
            req.query.nonce,
            req.body.CallSid,
          ),
        ),
  );
  for (const path of ['/voice/status', '/voice/stream-status']) {
    app.post<{ Querystring: LegQuery; Body: Record<string, string> }>(
      path,
      async (req, reply) => {
        manager.handleStatus(
          req.query.sessionId,
          req.query.role,
          req.query.nonce,
          req.body,
          path === '/voice/stream-status',
        );
        return reply.code(204).send();
      },
    );
  }
  app.get('/voice/media', { websocket: true }, (socket: WebSocket) => {
    const timer = setTimeout(() => socket.close(1008, 'Missing start'), 10000);
    timer.unref?.();
    const firstMessage = (data: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.event === 'connected') return;
        if (parsed.event !== 'start') {
          socket.close(1008, 'Expected start');
          return;
        }
        clearTimeout(timer);
        socket.off('message', firstMessage);
        manager.attachMedia(socket, parsed.start);
      } catch {
        socket.close(1008, 'Invalid message');
      }
    };
    socket.on('message', firstMessage);
    socket.on('error', () => clearTimeout(timer));
    socket.once('close', () => clearTimeout(timer));
  });
  app.get('/*', async (req, reply) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(req.url.split('?')[0]);
    } catch {
      return reply.code(404).send();
    }
    const file = resolve(
      publicDir,
      `.${pathname === '/' ? '/index.html' : pathname}`,
    );
    if (
      !file.startsWith(publicDir + sep) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    )
      return reply.code(404).send({ error: 'NOT_FOUND' });
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.wav': 'audio/wav',
    };
    if (!types[extname(file)]) return reply.code(404).send();
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.twilio.com wss://*.twilio.com https://*.twiliocdn.com; img-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    return reply.type(types[extname(file)]).send(readFileSync(file));
  });
  app.addHook('preClose', async () => {
    ownedEventStreams?.close();
    for (const stream of eventStreams) stream.end();
    await manager.close();
  });
  app.addHook('onClose', async () => {
    ownedEventStreams?.close();
    browserControl?.close();
    manager.off('event', broadcast);
    closeNanoVoiceWorker();
    closePocketVoiceWorker();
  });
  return app;
}
