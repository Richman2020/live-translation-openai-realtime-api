// eslint-disable-next-line max-classes-per-file -- The sanitized error belongs to this login registry.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  CLOUD_CSRF_HEADER,
  CLOUD_SESSION_COOKIE,
  CloudAccessError,
  CloudAccessPolicy,
  type CloudAccessContext,
  type CloudAuthSession,
} from './cloud-access';
import { GoogleOidcClient, type VerifiedGoogleIdentity } from './google-oidc';

export const GOOGLE_LOGIN_COOKIE = '__Host-ai-phone-login';
export const GOOGLE_LOGIN_HEADER = 'x-phone-login';
export const GOOGLE_LOGIN_PATHS = Object.freeze({
  status: '/auth/status',
  start: '/auth/google/start',
  callback: '/auth/google/callback',
  cancel: '/auth/google/cancel',
  logout: '/auth/logout',
  renew: '/auth/session/renew',
});

class GoogleLoginError extends Error {
  constructor(
    readonly code: 'LOGIN_FAILED' | 'LOGIN_UNAVAILABLE' | 'FORBIDDEN',
    readonly statusCode: number,
  ) {
    super(code);
  }
}

type Binding = { generation: number; expiresAt: number };
type LoginFlow = {
  bindingKey: string;
  generation: number;
  nonce: string;
  verifier: string;
  expiresAt: number;
  consumed: boolean;
  previousSession?: { key: string; epoch: number };
};
type SessionRecord = CloudAuthSession & { credentialKey: string };
type PreparedLogin = Readonly<{ sessionCookie: string }>;
const opaque = /^[A-Za-z0-9_-]{43}$/;
const random = () => randomBytes(32).toString('base64url');
const keyOf = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const nowOr = (clock: (() => number) | undefined) => clock || Date.now;

function canonical(value: string): boolean {
  return (
    opaque.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value
  );
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function cookie(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers.cookie;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length > 4096)
    throw new GoogleLoginError('FORBIDDEN', 403);
  const values = raw
    .split(';')
    .filter((item) => item.split('=')[0].trim() === name);
  if (!values.length) return undefined;
  if (values.length !== 1) throw new GoogleLoginError('FORBIDDEN', 403);
  const value = values[0].slice(values[0].indexOf('=') + 1).trim();
  if (!canonical(value)) throw new GoogleLoginError('FORBIDDEN', 403);
  return value;
}
function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}
function clearCookie(name: string): string {
  return `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}
function sessionCookie(credential: string): string {
  return `${CLOUD_SESSION_COOKIE}=${credential}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}
function noPrivateCache(reply: FastifyReply): void {
  reply
    .header('cache-control', 'private, no-store')
    .header('referrer-policy', 'no-referrer')
    .header('x-content-type-options', 'nosniff')
    .header(
      'vary',
      'Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest, Cookie',
    );
}

/** A bounded single-process login registry. Restart invalidates every cookie;
 * it is not a persistent session store, phone budget, or recovery journal.
 * Provider exchanges are async; the policy resolver only reads current records.
 */
export class GoogleBrowserLogin {
  readonly policy: CloudAccessPolicy;

  private readonly origin: string;

  private readonly client: GoogleOidcClient;

  private readonly now: () => number;

  private readonly absoluteTimeout: number;

  private readonly idleTimeout: number;

  private readonly flowTimeout: number;

  private readonly bindings = new Map<string, Binding>();

  private readonly flows = new Map<string, LoginFlow>();

  private readonly sessions = new Map<string, SessionRecord>();

  private readonly prepared = new WeakMap<
    PreparedLogin,
    {
      record: SessionRecord;
      identity: VerifiedGoogleIdentity;
      flow: LoginFlow;
      binding: Binding;
      stateKey: string;
      committed: boolean;
    }
  >();

  private subject: string | undefined;

  private closed = false;

  constructor(options: {
    client: GoogleOidcClient;
    publicOrigin: string;
    now?: () => number;
    absoluteTimeoutMs?: number;
    idleTimeoutMs?: number;
    flowTimeoutMs?: number;
  }) {
    this.now = nowOr(options.now);
    this.absoluteTimeout = options.absoluteTimeoutMs ?? 8 * 60 * 60 * 1000;
    this.idleTimeout = options.idleTimeoutMs ?? 15 * 60 * 1000;
    this.flowTimeout = options.flowTimeoutMs ?? 5 * 60 * 1000;
    for (const [timeout, maximum] of [
      [this.absoluteTimeout, 24 * 60 * 60 * 1000],
      [this.idleTimeout, this.absoluteTimeout],
      [this.flowTimeout, 10 * 60 * 1000],
    ])
      if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > maximum)
        throw new GoogleLoginError('LOGIN_UNAVAILABLE', 503);
    if (!(options.client instanceof GoogleOidcClient))
      throw new GoogleLoginError('LOGIN_UNAVAILABLE', 503);
    this.client = options.client;
    this.policy = new CloudAccessPolicy({
      publicOrigin: options.publicOrigin,
      now: this.now,
      resolveSession: (credential) => this.resolveSession(credential),
    });
    this.origin = this.policy.publicOrigin;
    if (
      this.client.redirectUri !== `${this.origin}${GOOGLE_LOGIN_PATHS.callback}`
    )
      throw new GoogleLoginError('LOGIN_UNAVAILABLE', 503);
  }

  private resolveSession(credential: string): CloudAuthSession | undefined {
    if (this.closed || !canonical(credential)) return undefined;
    const record = this.sessions.get(keyOf(credential));
    if (
      !record ||
      record.revoked ||
      this.now() >= Math.min(record.absoluteExpiresAt, record.idleExpiresAt)
    )
      return undefined;
    // A snapshot prevents callers from changing the current registry. The next
    // policy use always looks up the current record again; no Promise is cached.
    return {
      authSessionId: record.authSessionId,
      principalId: record.principalId,
      browserOwnerId: record.browserOwnerId,
      epoch: record.epoch,
      issuedAt: record.issuedAt,
      absoluteExpiresAt: record.absoluteExpiresAt,
      idleExpiresAt: record.idleExpiresAt,
      revoked: record.revoked,
      csrfToken: record.csrfToken,
    };
  }

  private prune(): void {
    const now = this.now();
    for (const [key, flow] of this.flows)
      if (flow.expiresAt <= now) this.flows.delete(key);
    for (const [key, binding] of this.bindings)
      if (binding.expiresAt <= now) this.bindings.delete(key);
    for (const [key, session] of this.sessions)
      if (
        session.revoked ||
        Math.min(session.absoluteExpiresAt, session.idleExpiresAt) <= now
      )
        this.sessions.delete(key);
  }

  /** This transport still requires the actual loopback connection. It does not
   * permit a cloud listener or forwarded-host bypass of the startup guards. */
  assertRequest(
    request: FastifyRequest,
    kind: 'read' | 'write' | 'callback',
  ): void {
    if (this.closed) throw new GoogleLoginError('LOGIN_UNAVAILABLE', 503);
    const remote = request.raw.socket.remoteAddress || request.ip;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote))
      throw new GoogleLoginError('FORBIDDEN', 403);
    const sensitive = new Set([
      'host',
      'origin',
      'cookie',
      CLOUD_CSRF_HEADER,
      GOOGLE_LOGIN_HEADER,
      'sec-fetch-site',
      'sec-fetch-mode',
      'sec-fetch-dest',
      'forwarded',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
    ]);
    const raw = request.raw.rawHeaders;
    const seen = new Set<string>();
    if (!Array.isArray(raw) || raw.length % 2)
      throw new GoogleLoginError('FORBIDDEN', 403);
    for (let index = 0; index < raw.length; index += 2) {
      const name = raw[index].toLowerCase();
      if (sensitive.has(name)) {
        if (seen.has(name) || request.headers[name] !== raw[index + 1])
          throw new GoogleLoginError('FORBIDDEN', 403);
        seen.add(name);
      }
    }
    if (
      [...sensitive].some(
        (name) => request.headers[name] !== undefined && !seen.has(name),
      )
    )
      throw new GoogleLoginError('FORBIDDEN', 403);
    if (
      request.headers.host !== new URL(this.origin).host ||
      [
        'forwarded',
        'x-forwarded-for',
        'x-forwarded-host',
        'x-forwarded-proto',
      ].some((name) => request.headers[name] !== undefined) ||
      (request.headers.origin !== undefined &&
        request.headers.origin !== this.origin)
    )
      throw new GoogleLoginError('FORBIDDEN', 403);
    const [site, mode, dest] = [
      request.headers['sec-fetch-site'],
      request.headers['sec-fetch-mode'],
      request.headers['sec-fetch-dest'],
    ];
    if (kind === 'write') {
      if (request.method !== 'POST' || request.headers.origin !== this.origin)
        throw new GoogleLoginError('FORBIDDEN', 403);
      if (
        [site, mode, dest].some((value) => value !== undefined) &&
        (site !== 'same-origin' ||
          !['cors', 'same-origin'].includes(mode as string) ||
          dest !== 'empty')
      )
        throw new GoogleLoginError('FORBIDDEN', 403);
    } else if (kind === 'read') {
      if (
        request.method !== 'GET' ||
        (request.headers.origin === undefined &&
          (site !== 'same-origin' ||
            !['cors', 'same-origin'].includes(mode as string) ||
            dest !== 'empty'))
      )
        throw new GoogleLoginError('FORBIDDEN', 403);
    } else if (
      request.method !== 'GET' ||
      ([site, mode, dest].some((value) => value !== undefined) &&
        (!['cross-site', 'same-origin', 'none'].includes(site as string) ||
          mode !== 'navigate' ||
          dest !== 'document'))
    )
      throw new GoogleLoginError('FORBIDDEN', 403);
  }

  private requireStart(request: FastifyRequest): void {
    this.assertRequest(request, 'write');
    if (
      request.headers[GOOGLE_LOGIN_HEADER] !== 'start' ||
      request.url.includes('?') ||
      (request.body !== undefined &&
        (request.body === null ||
          typeof request.body !== 'object' ||
          Array.isArray(request.body) ||
          Object.keys(request.body).length))
    )
      throw new GoogleLoginError('FORBIDDEN', 403);
  }

  start(request: FastifyRequest): {
    authorizationUrl: string;
    bindingCookie: string;
  } {
    this.requireStart(request);
    const oldCookie = cookie(request, CLOUD_SESSION_COOKIE);
    const browserCookie = cookie(request, GOOGLE_LOGIN_COOKIE);
    this.prune();
    let browser = browserCookie;
    let bindingKey = browser && keyOf(browser);
    let binding = bindingKey && this.bindings.get(bindingKey);
    if (!binding) {
      if (this.bindings.size >= 64)
        throw new GoogleLoginError('LOGIN_UNAVAILABLE', 503);
      browser = random();
      bindingKey = keyOf(browser);
      binding = { generation: 0, expiresAt: 0 };
      this.bindings.set(bindingKey, binding);
    }
    if (this.flows.size >= 32)
      throw new GoogleLoginError('LOGIN_UNAVAILABLE', 503);
    binding.generation += 1;
    binding.expiresAt = this.now() + this.flowTimeout;
    for (const [key, flow] of this.flows)
      if (flow.bindingKey === bindingKey) this.flows.delete(key);
    const state = random();
    const nonce = random();
    const verifier = random();
    const old = oldCookie && this.sessions.get(keyOf(oldCookie));
    const previousSession =
      old && !old.revoked && this.resolveSession(oldCookie)
        ? { key: old.credentialKey, epoch: old.epoch }
        : undefined;
    this.flows.set(keyOf(state), {
      bindingKey,
      generation: binding.generation,
      nonce,
      verifier,
      expiresAt: binding.expiresAt,
      consumed: false,
      previousSession,
    });
    const codeChallenge = createHash('sha256')
      .update(verifier)
      .digest('base64url');
    return {
      authorizationUrl: this.client.authorizationUrl({
        state,
        nonce,
        codeChallenge,
      }),
      bindingCookie: setCookie(
        GOOGLE_LOGIN_COOKIE,
        browser,
        this.flowTimeout / 1000,
      ),
    };
  }

  cancel(request: FastifyRequest): void {
    this.requireStart(request);
    this.cancelBinding(cookie(request, GOOGLE_LOGIN_COOKIE));
  }

  private cancelBinding(browser: string | undefined): void {
    if (!browser) return;
    const bindingKey = keyOf(browser);
    const binding = this.bindings.get(bindingKey);
    if (binding) binding.generation += 1;
    this.bindings.delete(bindingKey);
    for (const [key, flow] of this.flows)
      if (flow.bindingKey === bindingKey) this.flows.delete(key);
  }

  async complete(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<PreparedLogin> {
    this.assertRequest(request, 'callback');
    const url = new URL(request.url, this.origin);
    if (
      url.pathname !== GOOGLE_LOGIN_PATHS.callback ||
      url.hash ||
      request.url.length > 4096
    )
      throw new GoogleLoginError('FORBIDDEN', 403);
    const params = url.searchParams;
    const state = params.get('state');
    const browser = cookie(request, GOOGLE_LOGIN_COOKIE);
    if (
      !state ||
      !canonical(state) ||
      !browser ||
      params.getAll('state').length !== 1
    )
      throw new GoogleLoginError('LOGIN_FAILED', 401);
    const stateKey = keyOf(state);
    const flow = this.flows.get(stateKey);
    const binding = this.bindings.get(keyOf(browser));
    if (
      !flow ||
      flow.consumed ||
      !binding ||
      !equal(flow.bindingKey, keyOf(browser)) ||
      flow.generation !== binding.generation ||
      this.now() >= flow.expiresAt
    )
      throw new GoogleLoginError('LOGIN_FAILED', 401);
    // Consume before token exchange. Provider failure/error/duplicate callback
    // cannot replay this transaction; cancellation can still retire its record.
    flow.consumed = true;
    const validParams = [
      'state',
      'code',
      'scope',
      'authuser',
      'prompt',
      'hd',
      'error',
      'error_description',
      'error_uri',
    ];
    const code = params.get('code');
    if (
      [...params.keys()].some(
        (name) =>
          !validParams.includes(name) || params.getAll(name).length !== 1,
      ) ||
      params.has('error') ||
      !code ||
      code.length > 2048 ||
      /[\r\n\0]/.test(code)
    ) {
      this.flows.delete(stateKey);
      throw new GoogleLoginError('LOGIN_FAILED', 401);
    }
    try {
      const identity = await this.client.exchangeCode({
        code,
        codeVerifier: flow.verifier,
        nonce: flow.nonce,
      });
      this.client.assertVerifiedIdentity(identity);
      if (
        this.closed ||
        request.raw.aborted ||
        reply.raw.destroyed ||
        this.flows.get(stateKey) !== flow ||
        this.bindings.get(flow.bindingKey) !== binding ||
        flow.generation !== binding.generation ||
        this.now() >= flow.expiresAt
      )
        throw new Error('retired flow');
      if (flow.previousSession) {
        const previous = this.sessions.get(flow.previousSession.key);
        if (
          !previous ||
          previous.revoked ||
          previous.epoch !== flow.previousSession.epoch ||
          this.now() >=
            Math.min(previous.absoluteExpiresAt, previous.idleExpiresAt)
        )
          throw new Error('retired session');
      }
      if (this.subject && this.subject !== identity.subject)
        throw new Error('subject changed');
      this.prune();
      if (this.sessions.size >= 16 && !flow.previousSession)
        throw new Error('session limit');
      const credential = random();
      const now = this.now();
      const record: SessionRecord = {
        credentialKey: keyOf(credential),
        authSessionId: random(),
        principalId: keyOf(`${identity.issuer}\0${identity.subject}`),
        browserOwnerId: random(),
        epoch: 1,
        issuedAt: now,
        absoluteExpiresAt: now + this.absoluteTimeout,
        idleExpiresAt: now + this.idleTimeout,
        revoked: false,
        csrfToken: random(),
      };
      const prepared = Object.freeze({
        sessionCookie: sessionCookie(credential),
      });
      this.prepared.set(prepared, {
        record,
        identity,
        flow,
        binding,
        stateKey,
        committed: false,
      });
      return prepared;
    } catch {
      this.flows.delete(stateKey);
      throw new GoogleLoginError('LOGIN_FAILED', 401);
    }
  }

  /** Publish only at the route's final synchronous send boundary. Async onSend
   * preparation cannot rotate an old session or revive a retired login flow. */
  commitPrepared(
    prepared: PreparedLogin,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    const issued = this.prepared.get(prepared);
    if (
      !issued ||
      this.closed ||
      issued.committed ||
      request.raw.aborted ||
      reply.raw.destroyed ||
      reply.raw.headersSent ||
      this.flows.get(issued.stateKey) !== issued.flow ||
      this.bindings.get(issued.flow.bindingKey) !== issued.binding ||
      issued.flow.generation !== issued.binding.generation ||
      this.now() >= issued.flow.expiresAt
    )
      throw new GoogleLoginError('LOGIN_FAILED', 401);
    this.client.assertVerifiedIdentity(issued.identity);
    if (this.subject && this.subject !== issued.identity.subject)
      throw new GoogleLoginError('LOGIN_FAILED', 401);
    const previous =
      issued.flow.previousSession &&
      this.sessions.get(issued.flow.previousSession.key);
    if (
      issued.flow.previousSession &&
      (!previous ||
        previous.revoked ||
        previous.epoch !== issued.flow.previousSession.epoch ||
        this.now() >=
          Math.min(previous.absoluteExpiresAt, previous.idleExpiresAt))
    )
      throw new GoogleLoginError('LOGIN_FAILED', 401);
    this.prune();
    if (this.sessions.size >= 16 && !previous)
      throw new GoogleLoginError('LOGIN_UNAVAILABLE', 503);
    if (previous) {
      this.revokeRecord(previous);
      this.sessions.delete(previous.credentialKey);
    }
    const now = this.now();
    issued.record.issuedAt = now;
    issued.record.absoluteExpiresAt = now + this.absoluteTimeout;
    issued.record.idleExpiresAt = now + this.idleTimeout;
    this.subject = issued.identity.subject;
    this.sessions.set(issued.record.credentialKey, issued.record);
    issued.binding.generation += 1;
    this.bindings.delete(issued.flow.bindingKey);
    for (const [key, flow] of this.flows)
      if (flow.bindingKey === issued.flow.bindingKey) this.flows.delete(key);
    issued.committed = true;
  }

  private revokeRecord(record: SessionRecord): void {
    record.revoked = true;
    record.epoch += 1;
    record.csrfToken = random();
  }

  private currentRecord(context: CloudAccessContext): SessionRecord {
    const record = [...this.sessions.values()].find(
      (item) => item.authSessionId === context.authSessionId,
    );
    if (!record || record.revoked || record.epoch !== context.epoch)
      throw new CloudAccessError('UNAUTHORIZED');
    return record;
  }

  logout(request: FastifyRequest): void {
    this.assertRequest(request, 'write');
    if (
      request.url.includes('?') ||
      (request.body !== undefined &&
        (request.body === null ||
          typeof request.body !== 'object' ||
          Array.isArray(request.body) ||
          Object.keys(request.body).length))
    )
      throw new GoogleLoginError('FORBIDDEN', 403);
    const browser = cookie(request, GOOGLE_LOGIN_COOKIE);
    const context = this.policy.authenticate(request.headers, 'mutate', {
      surface: 'http',
      method: request.method,
    });
    this.policy.runAuthorizedSession(context, 'mutate', () => {
      this.revokeRecord(this.currentRecord(context));
      this.cancelBinding(browser);
    });
  }

  renew(request: FastifyRequest): void {
    this.assertRequest(request, 'write');
    if (
      request.url.includes('?') ||
      (request.body !== undefined &&
        (request.body === null ||
          typeof request.body !== 'object' ||
          Array.isArray(request.body) ||
          Object.keys(request.body).length))
    )
      throw new GoogleLoginError('FORBIDDEN', 403);
    const context = this.policy.authenticate(request.headers, 'mutate', {
      surface: 'http',
      method: request.method,
    });
    this.policy.runAuthorizedSession(context, 'mutate', () => {
      const record = this.currentRecord(context);
      record.idleExpiresAt = Math.min(
        record.absoluteExpiresAt,
        this.now() + this.idleTimeout,
      );
    });
  }

  close(): void {
    this.closed = true;
    for (const record of this.sessions.values()) this.revokeRecord(record);
    this.flows.clear();
    this.bindings.clear();
    this.sessions.clear();
  }
}

/** Explicit installation only. No client creation, config reading, public
 * listener, credentials or fake provider is supplied by production startup. */
export function registerGoogleLoginRoutes(
  app: FastifyInstance,
  login: GoogleBrowserLogin,
): void {
  const callbackResponses = new WeakMap<FastifyRequest, PreparedLogin>();
  const respond =
    (
      handler: (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => unknown | Promise<unknown>,
    ) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      noPrivateCache(reply);
      try {
        return await Promise.resolve(handler(request, reply));
      } catch (error) {
        const known =
          error instanceof GoogleLoginError ||
          error instanceof CloudAccessError;
        return reply
          .code(known ? error.statusCode : 503)
          .send({ error: known ? error.code : 'LOGIN_UNAVAILABLE' });
      }
    };
  app.get(
    GOOGLE_LOGIN_PATHS.status,
    respond((request) => {
      login.assertRequest(request, 'read');
      if (request.url !== GOOGLE_LOGIN_PATHS.status)
        throw new GoogleLoginError('FORBIDDEN', 403);
      return { provider: 'google', enabled: true };
    }),
  );
  app.post(
    GOOGLE_LOGIN_PATHS.start,
    respond((request, reply) => {
      const result = login.start(request);
      reply.header('set-cookie', result.bindingCookie);
      return { authorizationUrl: result.authorizationUrl };
    }),
  );
  app.get(
    GOOGLE_LOGIN_PATHS.callback,
    {
      onSend(request, reply, payload, done) {
        const prepared = callbackResponses.get(request);
        if (!prepared) return done(null, payload);
        try {
          login.commitPrepared(prepared, request, reply);
          reply.header('set-cookie', [
            prepared.sessionCookie,
            clearCookie(GOOGLE_LOGIN_COOKIE),
          ]);
          return done(null, payload);
        } catch {
          reply
            .code(401)
            .removeHeader('set-cookie')
            .removeHeader('location')
            .removeHeader('content-length')
            .type('application/json');
          return done(null, JSON.stringify({ error: 'LOGIN_FAILED' }));
        }
      },
    },
    respond(async (request, reply) => {
      const prepared = await login.complete(request, reply);
      callbackResponses.set(request, prepared);
      return reply
        .type('text/html; charset=utf-8')
        .header(
          'content-security-policy',
          "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        )
        .send(
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0; url=/controlled"><title>登录完成</title></head><body><p>登录完成，正在打开电话工作台。</p><a href="/controlled">打开工作台</a></body></html>',
        );
    }),
  );
  app.post(
    GOOGLE_LOGIN_PATHS.cancel,
    respond((request, reply) => {
      login.cancel(request);
      reply.header('set-cookie', clearCookie(GOOGLE_LOGIN_COOKIE));
      return { ok: true };
    }),
  );
  app.post(
    GOOGLE_LOGIN_PATHS.logout,
    respond((request, reply) => {
      login.logout(request);
      // A dedicated response is necessary: ordinary auth onSend must not reject
      // the successful logout after its synchronous revocation.
      reply.header('set-cookie', [
        clearCookie(CLOUD_SESSION_COOKIE),
        clearCookie(GOOGLE_LOGIN_COOKIE),
      ]);
      return { ok: true };
    }),
  );
  app.post(
    GOOGLE_LOGIN_PATHS.renew,
    respond((request) => {
      login.renew(request);
      return { ok: true };
    }),
  );
  app.addHook('onClose', () => login.close());
}
