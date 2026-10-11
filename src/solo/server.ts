import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import fastify, { type FastifyRequest, type onSendHookHandler } from 'fastify';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import twilio from 'twilio';
import type WebSocket from 'ws';

import { desktopConnectivity } from './desktop-connectivity';
import { ConnectionMaintenance } from './connection-maintenance';
import { checkConfig, ConfigStore } from './config';
import {
  loadPhoneRuntime,
  parsePhoneRuntime,
  requireLocalPhoneRuntime,
  type CloudPhoneRuntime,
} from './cloud-runtime';
import { CLOUD_CONTROLLED_PUBLIC_PATHS } from './cloud-ingress';
import { CloudAccessError, type CloudAccessContext } from './cloud-access';
import { createCloudAccessTransport } from './cloud-access-transport';
import { CloudPhoneAccess } from './cloud-phone-access';
import { ControllerLeaseError, type ControllerProof } from './controller-lease';
import {
  CloudVoiceJoinError,
  type PreparedCloudVoice,
} from './cloud-voice-join';
import { createOwnedPhoneEventStreams } from './phone-event-stream';
import {
  GoogleBrowserLogin,
  GOOGLE_LOGIN_PATHS,
  registerGoogleLoginRoutes,
} from './google-login';
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

// These are public application source/assets, never control or Voice endpoints.
// The controlled page is the sole HTML entry for an injected browser app.
const controlledPublicPaths = new Set<string>(CLOUD_CONTROLLED_PUBLIC_PATHS);
const publicContentSecurityPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.twilio.com wss://*.twilio.com https://*.twiliocdn.com; img-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

/** Only public source reads need browser navigation/script Fetch Metadata.
 * API authorization keeps its stricter native-fetch policy, independently. */
function controlledPublicRequest(req: FastifyRequest, origin: string): boolean {
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  const remote = req.raw.socket.remoteAddress || req.ip;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  const names = new Set([
    'host',
    'origin',
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'sec-fetch-site',
    'sec-fetch-mode',
    'sec-fetch-dest',
  ]);
  const raw = req.raw.rawHeaders;
  if (!Array.isArray(raw) || raw.length % 2) return false;
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index].toLowerCase();
    if (names.has(name)) {
      if (seen.has(name) || req.headers[name] !== raw[index + 1]) return false;
      seen.add(name);
    }
  }
  for (const name of names)
    if (req.headers[name] !== undefined && !seen.has(name)) return false;
  if (
    req.headers.host !== new URL(origin).host ||
    [
      'forwarded',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
    ].some((name) => req.headers[name] !== undefined) ||
    (req.headers.origin !== undefined && req.headers.origin !== origin)
  )
    return false;
  const site = req.headers['sec-fetch-site'];
  const mode = req.headers['sec-fetch-mode'];
  const dest = req.headers['sec-fetch-dest'];
  if ([site, mode, dest].every((value) => value === undefined)) return true;
  const path = req.url.split('?')[0];
  if (path === '/controlled')
    return (
      ['none', 'same-origin'].includes(site as string) &&
      mode === 'navigate' &&
      dest === 'document'
    );
  const destinations: Record<string, string> = {
    '.js': 'script',
    '.css': 'style',
    '.wav': 'audio',
  };
  const destination = destinations[extname(path)] || 'image';
  return (
    site === 'same-origin' &&
    ['cors', 'no-cors', 'same-origin'].includes(mode as string) &&
    dest === destination
  );
}

type SoloServerOptions = {
  configStore?: ConfigStore;
  sessionManager?: SessionManager;
  publicDir?: string;
  publicReadinessChecker?: typeof checkPublicReadiness;
  translationReadinessChecker?: typeof checkTranslationEngine;
  providerVerifier?: typeof verifyProviders;
  browserControl?: CloudPhoneAccess;
  googleLogin?: GoogleBrowserLogin;
};

export async function buildSoloServer(options: SoloServerOptions = {}) {
  // Exported builders are also entry points: never expose local control APIs by
  // bypassing index.ts in a cloud process.
  requireLocalPhoneRuntime(
    loadPhoneRuntime({ envPath: options.configStore?.envPath }),
  );
  // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Shared private builder follows guarded public entry points.
  return buildPhoneApplication(options);
}

/** Explicit cloud composition. It does not relax the local builder or its APIs.
 * The application still accepts only actual loopback ingress connections. */
export async function buildCloudControlledServer(options: {
  runtime: CloudPhoneRuntime;
  configStore: ConfigStore;
  sessionManager: SessionManager;
  browserControl: CloudPhoneAccess;
  googleLogin: GoogleBrowserLogin;
  publicDir?: string;
}) {
  if (
    !(options?.configStore instanceof ConfigStore) ||
    !(options.sessionManager instanceof SessionManager) ||
    !(options.browserControl instanceof CloudPhoneAccess) ||
    !(options.googleLogin instanceof GoogleBrowserLogin) ||
    options.googleLogin.policy !== options.browserControl.policy ||
    options.browserControl.manager !== options.sessionManager ||
    !options.runtime ||
    options.runtime.mode !== 'cloud'
  )
    throw new SessionError('CLOUD_PHONE_DEPENDENCIES_REQUIRED', 503);
  let pinned: CloudPhoneRuntime;
  try {
    pinned = parsePhoneRuntime({
      AI_PHONE_RUNTIME_MODE: 'cloud',
      PORT: String(options.runtime.port),
      CLOUD_PUBLIC_ORIGIN: options.runtime.publicOrigin,
      CLOUD_WARM_INSTANCES: String(options.runtime.warmInstances),
    }) as CloudPhoneRuntime;
  } catch {
    throw new SessionError('CLOUD_PHONE_DEPENDENCIES_REQUIRED', 503);
  }
  if (
    options.runtime.host !== pinned.host ||
    options.runtime.mediaOrigin !== pinned.mediaOrigin ||
    options.runtime.publicOrigin !== pinned.publicOrigin ||
    options.browserControl.policy.publicOrigin !== pinned.publicOrigin ||
    options.configStore.value.PUBLIC_BASE_URL !== pinned.publicOrigin
  )
    throw new SessionError('CLOUD_PHONE_DEPENDENCIES_REQUIRED', 503);
  // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Shared private builder follows guarded public entry points.
  return buildPhoneApplication(options, pinned);
}

async function buildPhoneApplication(
  options: SoloServerOptions,
  cloudRuntime?: CloudPhoneRuntime,
) {
  const { browserControl } = options;
  const { googleLogin } = options;
  if (
    googleLogin !== undefined &&
    (!(googleLogin instanceof GoogleBrowserLogin) ||
      !browserControl ||
      googleLogin.policy !== browserControl.policy)
  )
    throw new SessionError('CLOUD_PHONE_DEPENDENCIES_REQUIRED', 503);
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
  const controllerResponses = new WeakMap<
    FastifyRequest,
    {
      context: CloudAccessContext;
      proof?: ControllerProof;
      callId?: string;
      voice?: PreparedCloudVoice;
    }
  >();
  const controllerResponseGuard: onSendHookHandler = (
    req,
    reply,
    payload,
    done,
  ) => {
    const issued = controllerResponses.get(req);
    if (!issued || !browserControl) return done(null, payload);
    try {
      if (issued.voice)
        browserControl.assertVoiceResponseCurrent(
          issued.context,
          issued.callId!,
          issued.voice,
        );
      else
        browserControl.recheckController(
          issued.context,
          issued.proof!,
          issued.callId,
        );
      return done(null, payload);
    } catch (error) {
      const known =
        error instanceof CloudAccessError ||
        error instanceof CloudVoiceJoinError;
      reply
        .code(known ? error.statusCode : 503)
        .type('application/json; charset=utf-8')
        .removeHeader('content-length');
      return done(
        null,
        JSON.stringify({
          error: known ? error.code : 'CLOUD_CONTROL_UNAVAILABLE',
        }),
      );
    }
  };
  const controllerRoute = () => {
    if (!browserTransport) return {};
    const route = browserTransport.sessionHttpRoute('mutate');
    return { ...route, onSend: [route.onSend, controllerResponseGuard] };
  };
  const controllerCallRoute = () => {
    if (!browserTransport) return {};
    const route = browserTransport.httpRoute((req) => ({
      callId: (req.params as { id: string }).id,
      action: 'mutate',
    }));
    return { ...route, onSend: [route.onSend, controllerResponseGuard] };
  };
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
  function requestedEngine(
    body: unknown,
    defaultEngine: TranslationEngine = 'legacy',
  ): TranslationEngine {
    if (
      body !== undefined &&
      (body === null || typeof body !== 'object' || Array.isArray(body))
    )
      throw new SessionError('INVALID_TRANSLATION_ENGINE');
    const value = (body as { translationEngine?: unknown })?.translationEngine;
    if (value === undefined) return defaultEngine;
    if (!isTranslationEngine(value))
      throw new SessionError('INVALID_TRANSLATION_ENGINE');
    return value;
  }
  function requireConfigured() {
    const configured = cloudRuntime
      ? checkConfig(configStore.value)
          .filter((check) => check.name !== 'LOCAL_ACCESS_TOKEN')
          .every((check) => check.status === 'ready')
      : configStore.configured();
    if (!configured) throw new SessionError('CONFIGURATION_REQUIRED', 503);
  }
  await app.register(formbody);
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff');
    // Health is the sole unauthenticated API; isolated public source reads below
    // never confer controller or Voice authorization.
    if (path === '/api/health' && req.method === 'GET') return undefined;
    if (path.startsWith('/voice/')) return undefined;
    if (
      googleLogin &&
      Object.values(GOOGLE_LOGIN_PATHS).some((loginPath) => loginPath === path)
    ) {
      // Login owns its independent fixed-origin source/transaction boundary.
      // The callback is a Google top-level navigation, never an API read/write.
      return undefined;
    }
    if (browserControl && path.startsWith('/api/')) {
      reply
        .header('Cache-Control', 'private, no-store')
        .header(
          'Vary',
          'Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest, Cookie',
        );
      // Both injected surfaces retain the actual loopback application boundary.
      // The cloud entry reaches it only through the restricted local ingress.
      const remote = req.raw.socket.remoteAddress || req.ip;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote))
        return reply.code(403).send({ error: 'LOCAL_ACCESS_ONLY' });
      if (
        ![
          '/api/status',
          '/api/browser-session',
          '/api/calls',
          '/api/events',
        ].includes(path) &&
        !/^\/api\/calls\/[^/]+\/(?:hangup|voice)$/.test(path) &&
        !/^\/api\/controller\/(?:acquire|renew|revoke)$/.test(path)
      )
        return reply.code(503).send({ error: 'CLOUD_CONTROL_UNAVAILABLE' });
      return undefined;
    }
    if (browserControl && path !== '/health') {
      if (
        !controlledPublicPaths.has(path) ||
        (path === '/controlled' && req.url !== '/controlled')
      )
        return reply.code(404).send({ error: 'NOT_FOUND' });
      if (!controlledPublicRequest(req, browserControl.policy.publicOrigin))
        return reply.code(403).send({ error: 'LOCAL_ACCESS_ONLY' });
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
      error instanceof SessionError ||
      error instanceof CloudAccessError ||
      error instanceof CloudVoiceJoinError ||
      error instanceof ControllerLeaseError
        ? error.code
        : 'REQUEST_FAILED';
    let statusCode = 500;
    if (
      error instanceof SessionError ||
      error instanceof CloudVoiceJoinError ||
      error instanceof ControllerLeaseError
    )
      statusCode = error.statusCode;
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
  if (googleLogin) registerGoogleLoginRoutes(app, googleLogin);
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
  if (browserControl && browserTransport) {
    app.get<{ Querystring: { tabId?: string } }>(
      '/api/browser-session',
      browserTransport.sessionHttpRoute('read'),
      async (req) =>
        browserTransport.executeSessionHttp(req, (context) =>
          browserControl.browserSession(context, req.query.tabId),
        ),
    );
    app.get('/controlled', async (_req, reply) => {
      const file = resolve(publicDir, 'index.html');
      if (!existsSync(file) || !statSync(file).isFile())
        return reply.code(404).send({ error: 'NOT_FOUND' });
      const html = readFileSync(file, 'utf8').replace(
        /<html\s+lang="zh-CN">/,
        '<html lang="zh-CN" data-phone-surface="controlled">',
      );
      if (!html.includes('<html lang="zh-CN" data-phone-surface="controlled">'))
        throw new SessionError('CLOUD_BROWSER_NOT_READY', 503);
      return reply
        .header('Content-Security-Policy', publicContentSecurityPolicy)
        .type('text/html; charset=utf-8')
        .send(html);
    });
    app.post<{ Body: { tabId: string } }>(
      '/api/controller/acquire',
      controllerRoute(),
      async (req) => {
        const context = browserTransport.requestContext(req);
        const proof = browserControl.acquireController(
          context,
          req.body?.tabId,
        );
        controllerResponses.set(req, { context, proof });
        return proof;
      },
    );
    app.post<{ Body: ControllerProof }>(
      '/api/controller/renew',
      controllerRoute(),
      async (req) => {
        const context = browserTransport.requestContext(req);
        const proof = browserControl.renewController(context, req.body);
        controllerResponses.set(req, { context, proof });
        return proof;
      },
    );
    app.post<{ Body: ControllerProof }>(
      '/api/controller/revoke',
      browserTransport.sessionHttpRoute('mutate'),
      async (req) => {
        browserControl.revokeController(
          browserTransport.requestContext(req),
          req.body,
        );
        return { ok: true };
      },
    );
    app.post<{
      Params: { id: string };
      Body: { controller: ControllerProof };
    }>('/api/calls/:id/voice', controllerCallRoute(), async (req) => {
      const context = browserTransport.requestContext(req);
      const voice = await browserControl.prepareVoice(
        context,
        req.params.id,
        req.body?.controller,
      );
      controllerResponses.set(req, { context, callId: req.params.id, voice });
      return voice;
    });
  }
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
  app.post<{
    Body: {
      to: string;
      translationEngine?: TranslationEngine;
      controller?: ControllerProof;
    };
  }>('/api/calls', controllerRoute(), async (req) => {
    const engine = requestedEngine(
      req.body,
      browserControl
        ? browserControl.configuredDefaultTranslationEngine
        : 'legacy',
    );
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
        req.body.controller,
      );
      const call = browserControl.createPrepared(prepared);
      controllerResponses.set(req, {
        context: browserTransport.requestContext(req),
        proof: Object.freeze({ ...req.body.controller }),
        callId: call.id,
      });
      return call;
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
  });
  app.post<{
    Params: { id: string };
    Body: { controller?: ControllerProof };
  }>('/api/calls/:id/hangup', controllerCallRoute(), async (req) => {
    if (browserControl && browserTransport) {
      const context = browserTransport.requestContext(req);
      const intent = browserControl.beginHangup(
        context,
        req.params.id,
        req.body?.controller,
      );
      controllerResponses.set(req, {
        context,
        proof: Object.freeze({ ...req.body.controller }),
        callId: req.params.id,
      });
      await browserControl.finishHangup(intent);
      if (!browserControl.recheckCleanup(context, req.params.id))
        throw new SessionError('CALL_CLEANUP_UNCONFIRMED', 503);
      return { ok: true };
    }
    await manager.end(req.params.id);
    if (!manager.isCleanupConfirmed(req.params.id))
      throw new SessionError('CALL_CLEANUP_UNCONFIRMED', 503);
    return { ok: true };
  });
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
      const twiml = browserControl
        ? await manager.connectBrowserControlled(req.body)
        : manager.connectBrowser(req.body);
      return reply.type('text/xml').send(twiml);
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
    reply.header('Content-Security-Policy', publicContentSecurityPolicy);
    return reply.type(types[extname(file)]).send(readFileSync(file));
  });
  app.addHook('preClose', async () => {
    ownedEventStreams?.close();
    for (const stream of eventStreams) stream.end();
    await manager.close();
  });
  app.addHook('onClose', async () => {
    ownedEventStreams?.close();
    await browserControl?.close();
    manager.off('event', broadcast);
    closeNanoVoiceWorker();
    closePocketVoiceWorker();
  });
  return app;
}
