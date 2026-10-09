// eslint-disable-next-line max-classes-per-file -- The sanitized error belongs to this OIDC client.
import {
  constants,
  createPublicKey,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';

/** Fixed Google metadata, independently checked against its discovery document.
 * No user-supplied issuer, discovery URL or JOSE key URL is ever followed.
 */
export const GOOGLE_OIDC = Object.freeze({
  issuer: 'https://accounts.google.com',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
});

export type VerifiedGoogleIdentity = Readonly<{
  issuer: typeof GOOGLE_OIDC.issuer;
  subject: string;
  email: string;
  emailVerified: true;
  /** Milliseconds, matching the application's current-session clock. */
  issuedAt: number;
  expiresAt: number;
}>;

type GoogleOidcErrorCode =
  | 'GOOGLE_OIDC_CONFIG_INVALID'
  | 'GOOGLE_TOKEN_INVALID'
  | 'GOOGLE_IDENTITY_REJECTED'
  | 'GOOGLE_PROVIDER_UNAVAILABLE'
  | 'GOOGLE_AUTH_BUSY';

export class GoogleOidcError extends Error {
  readonly statusCode: number;

  constructor(readonly code: GoogleOidcErrorCode) {
    super(code);
    this.statusCode = {
      GOOGLE_OIDC_CONFIG_INVALID: 503,
      GOOGLE_TOKEN_INVALID: 401,
      GOOGLE_IDENTITY_REJECTED: 403,
      GOOGLE_PROVIDER_UNAVAILABLE: 503,
      GOOGLE_AUTH_BUSY: 429,
    }[code];
  }
}

type JsonObject = Record<string, unknown>;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_AUTH_CONCURRENCY = 4;
const JWKS_REFRESH_COOLDOWN_MS = 30_000;
const MAX_JWKS_CACHE_MS = 60 * 60 * 1000;
const MAX_TOKEN_AGE_MS = 10 * 60 * 1000;
const MAX_TOKEN_LIFETIME_MS = 2 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 30_000;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function invalid(): never {
  throw new GoogleOidcError('GOOGLE_TOKEN_INVALID');
}
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function canonicalBase64(value: unknown, minimum: number, maximum: number) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length > Math.ceil((maximum * 4) / 3)
  )
    invalid();
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.length < minimum ||
    decoded.length > maximum ||
    decoded.toString('base64url') !== value
  )
    invalid();
  return decoded;
}
function opaque(value: unknown): value is string {
  try {
    return canonicalBase64(value, 32, 32).length === 32;
  } catch {
    return false;
  }
}

/** JSON.parse alone silently accepts duplicate security claims. This bounded
 * parser rejects duplicate decoded keys, invalid UTF-8, and excessive nesting.
 * Values use null-prototype objects; no getters or inherited properties arise.
 */
function parseJson(raw: Uint8Array): JsonObject {
  const input = textDecoder.decode(raw);
  let position = 0;
  let values = 0;
  const whitespace = () => {
    while (/[\t\r\n ]/.test(input[position] || '\0')) position += 1;
  };
  const string = (): string => {
    const start = position;
    if (input[position] !== '"') invalid();
    position += 1;
    while (position < input.length) {
      const character = input[position];
      position += 1;
      if (character === '\\') position += 1;
      else if (character === '"')
        return JSON.parse(input.slice(start, position)) as string;
    }
    return invalid();
  };
  const value = (depth: number): unknown => {
    values += 1;
    if (depth > 8 || values > 1024) invalid();
    whitespace();
    const character = input[position];
    if (character === '"') return string();
    if (character === '{') {
      position += 1;
      const result: JsonObject = Object.create(null);
      const keys = new Set<string>();
      whitespace();
      if (input[position] === '}') {
        position += 1;
        return result;
      }
      for (;;) {
        whitespace();
        const key = string();
        if (keys.has(key)) invalid();
        keys.add(key);
        whitespace();
        if (input[position] !== ':') invalid();
        position += 1;
        result[key] = value(depth + 1);
        whitespace();
        const delimiter = input[position];
        position += 1;
        if (delimiter === '}') return result;
        if (delimiter !== ',') invalid();
      }
    }
    if (character === '[') {
      position += 1;
      const result: unknown[] = [];
      whitespace();
      if (input[position] === ']') {
        position += 1;
        return result;
      }
      for (;;) {
        result.push(value(depth + 1));
        whitespace();
        const delimiter = input[position];
        position += 1;
        if (delimiter === ']') return result;
        if (delimiter !== ',') invalid();
      }
    }
    for (const [literal, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (input.startsWith(literal, position)) {
        position += literal.length;
        return result;
      }
    }
    const number = input
      .slice(position)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!number) return invalid();
    position += number[0].length;
    const result = Number(number[0]);
    if (!Number.isFinite(result)) invalid();
    return result;
  };
  const result = value(0);
  whitespace();
  if (position !== input.length || !object(result)) invalid();
  return result;
}

function email(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 254 &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(
      value,
    )
  );
}
function hostedDomain(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      value,
    )
  );
}
function safeString(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[\x21-\x7e]+$/.test(value)
  );
}
function keyId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function cacheTtl(cacheControl: string | null, age: string | null) {
  if (/\b(?:no-store|no-cache)\b/i.test(cacheControl || '')) return 0;
  const match = (cacheControl || '').match(
    /(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/i,
  );
  const seconds = match ? Number(match[1]) : 300;
  const elapsed = age && /^\d+$/.test(age) ? Number(age) : 0;
  return Math.max(0, Math.min(MAX_JWKS_CACHE_MS, (seconds - elapsed) * 1000));
}

/** Authorization-code login only. Not a current-session resolver: all network
 * and RSA verification are asynchronous and bounded, outside media callbacks.
 * Session issuance, one-use state/browser binding and revocation are separate.
 */
export class GoogleOidcClient {
  readonly redirectUri: string;

  private readonly clientId: string;

  private readonly clientSecret: string;

  private readonly allowedEmail: string;

  private readonly expectedHostedDomain: string | undefined;

  private readonly pinnedGoogleSubject: string | undefined;

  private readonly request: typeof fetch;

  private readonly now: () => number;

  private readonly requestTimeoutMs: number;

  private active = 0;

  private keys = new Map<string, KeyObject>();

  private keysExpireAt = 0;

  private lastRefreshAt = -Infinity;

  private refreshing: Promise<void> | undefined;

  private readonly identities = new WeakSet<VerifiedGoogleIdentity>();

  constructor(options: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    /** One explicitly configured account, never a browser-supplied email. */
    allowedEmail: string;
    /** Third-party email is not authoritative merely because it is verified.
     * Confirm Workspace hd, or independently confirm and pin its Google sub.
     */
    expectedHostedDomain?: string;
    pinnedGoogleSubject?: string;
    /** Explicit offline transport port. Production uses native HTTPS fetch. */
    fetch?: typeof fetch;
    now?: () => number;
    requestTimeoutMs?: number;
  }) {
    try {
      const redirect = new URL(options.redirectUri);
      if (
        !safeString(options.clientId, 256) ||
        !safeString(options.clientSecret, 1024) ||
        !email(options.allowedEmail) ||
        (options.expectedHostedDomain !== undefined &&
          !hostedDomain(options.expectedHostedDomain)) ||
        (options.pinnedGoogleSubject !== undefined &&
          !safeString(options.pinnedGoogleSubject, 255)) ||
        (options.allowedEmail.toLowerCase().split('@')[1] !== 'gmail.com' &&
          options.expectedHostedDomain === undefined &&
          options.pinnedGoogleSubject === undefined) ||
        redirect.protocol !== 'https:' ||
        redirect.username ||
        redirect.password ||
        redirect.search ||
        redirect.hash ||
        redirect.href !== options.redirectUri ||
        (options.fetch !== undefined && typeof options.fetch !== 'function') ||
        (options.now !== undefined && typeof options.now !== 'function') ||
        !Number.isSafeInteger(options.requestTimeoutMs ?? 5000) ||
        (options.requestTimeoutMs ?? 5000) < 10 ||
        (options.requestTimeoutMs ?? 5000) > 5000
      )
        throw new Error();
      this.redirectUri = redirect.href;
      this.clientId = options.clientId;
      this.clientSecret = options.clientSecret;
      this.allowedEmail = options.allowedEmail.toLowerCase();
      this.expectedHostedDomain = options.expectedHostedDomain;
      this.pinnedGoogleSubject = options.pinnedGoogleSubject;
      this.request = options.fetch ?? fetch;
      this.now = options.now ?? Date.now;
      this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    } catch {
      throw new GoogleOidcError('GOOGLE_OIDC_CONFIG_INVALID');
    }
  }

  authorizationUrl(input: {
    state: string;
    nonce: string;
    codeChallenge: string;
  }) {
    if (
      !opaque(input.state) ||
      !opaque(input.nonce) ||
      !opaque(input.codeChallenge)
    )
      invalid();
    const url = new URL(GOOGLE_OIDC.authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: 'openid email',
      access_type: 'online',
      include_granted_scopes: 'false',
      prompt: 'select_account',
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.href;
  }

  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    nonce: string;
  }): Promise<VerifiedGoogleIdentity> {
    return this.withSlot(async () => {
      if (
        !safeString(input.code, 2048) ||
        typeof input.codeVerifier !== 'string' ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier) ||
        !opaque(input.nonce)
      )
        invalid();
      const { data } = await this.requestJson(GOOGLE_OIDC.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: input.code,
          client_id: this.clientId,
          client_secret: this.clientSecret,
          redirect_uri: this.redirectUri,
          code_verifier: input.codeVerifier,
        }).toString(),
      });
      // No access/refresh token is stored, returned, logged or used for APIs.
      if (
        typeof data.id_token !== 'string' ||
        data.token_type !== 'Bearer' ||
        !safeString(data.access_token, 4096) ||
        !Number.isSafeInteger(data.expires_in) ||
        Number(data.expires_in) <= 0 ||
        Object.hasOwn(data, 'refresh_token')
      )
        invalid();
      if (data.scope !== undefined) {
        if (typeof data.scope !== 'string') invalid();
        const scopes = data.scope.split(' ');
        if (
          !scopes.includes('openid') ||
          !scopes.some((scope) =>
            [
              'email',
              'https://www.googleapis.com/auth/userinfo.email',
            ].includes(scope),
          ) ||
          scopes.some(
            (scope) =>
              ![
                'openid',
                'email',
                'https://www.googleapis.com/auth/userinfo.email',
              ].includes(scope),
          )
        )
          invalid();
      }
      return this.verifyToken(data.id_token, input.nonce);
    });
  }

  async verifyIdToken(idToken: string, nonce: string) {
    return this.withSlot(() => this.verifyToken(idToken, nonce));
  }

  /** Only this client's original, still-current verification output is trusted.
   * Copying fields or supplying ordinary JSON cannot authorize a login session.
   */
  assertVerifiedIdentity(
    identity: unknown,
  ): asserts identity is VerifiedGoogleIdentity {
    if (
      !object(identity) ||
      !this.identities.has(identity as VerifiedGoogleIdentity) ||
      Number(identity.expiresAt) <= this.clock()
    )
      invalid();
  }

  private clock() {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new GoogleOidcError('GOOGLE_PROVIDER_UNAVAILABLE');
    return now;
  }

  private async withSlot<T>(run: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_AUTH_CONCURRENCY)
      throw new GoogleOidcError('GOOGLE_AUTH_BUSY');
    this.active += 1;
    try {
      return await run();
    } catch (error) {
      if (error instanceof GoogleOidcError) throw error;
      // Never expose a provider response, token, claim or client secret.
      throw new GoogleOidcError('GOOGLE_TOKEN_INVALID');
    } finally {
      this.active -= 1;
    }
  }

  private async verifyToken(idToken: string, nonce: string) {
    if (
      typeof idToken !== 'string' ||
      Buffer.byteLength(idToken) > MAX_TOKEN_BYTES ||
      !opaque(nonce)
    )
      invalid();
    const parts = idToken.split('.');
    if (parts.length !== 3) invalid();
    const header = parseJson(canonicalBase64(parts[0], 2, 1024));
    const claims = parseJson(canonicalBase64(parts[1], 2, 8192));
    const signature = canonicalBase64(parts[2], 256, 512);
    if (
      header.alg !== 'RS256' ||
      !keyId(header.kid) ||
      (header.typ !== undefined && header.typ !== 'JWT') ||
      Object.keys(header).some((key) => !['alg', 'kid', 'typ'].includes(key))
    )
      invalid();
    // Reject invalid claims before any key refresh; repeat after async work.
    this.validateClaims(claims, nonce);
    const key = await this.key(header.kid);
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
    const valid = await new Promise<boolean>((resolve, reject) => {
      verify(
        'RSA-SHA256',
        signed,
        { key, padding: constants.RSA_PKCS1_PADDING },
        signature,
        (error, result) => (error ? reject(error) : resolve(result)),
      );
    });
    if (!valid) invalid();
    this.validateClaims(claims, nonce);
    const identity: VerifiedGoogleIdentity = Object.freeze({
      issuer: GOOGLE_OIDC.issuer,
      subject: claims.sub as string,
      email: (claims.email as string).toLowerCase(),
      emailVerified: true,
      issuedAt: Number(claims.iat) * 1000,
      expiresAt: Number(claims.exp) * 1000,
    });
    this.identities.add(identity);
    return identity;
  }

  private validateClaims(claims: JsonObject, nonce: string) {
    const now = this.clock();
    let audience: unknown;
    if (typeof claims.aud === 'string') audience = claims.aud;
    else if (Array.isArray(claims.aud) && claims.aud.length === 1)
      [audience] = claims.aud;
    if (
      ![GOOGLE_OIDC.issuer, 'accounts.google.com'].includes(
        claims.iss as string,
      ) ||
      audience !== this.clientId ||
      (Object.hasOwn(claims, 'azp') && claims.azp !== this.clientId) ||
      !safeString(claims.sub, 255) ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      Number(claims.iat) < 0 ||
      Number(claims.exp) > Math.floor(Number.MAX_SAFE_INTEGER / 1000) ||
      Number(claims.exp) <= Number(claims.iat) ||
      Number(claims.exp) * 1000 <= now ||
      Number(claims.iat) * 1000 > now + CLOCK_SKEW_MS ||
      now - Number(claims.iat) * 1000 > MAX_TOKEN_AGE_MS ||
      (Number(claims.exp) - Number(claims.iat)) * 1000 >
        MAX_TOKEN_LIFETIME_MS ||
      (Object.hasOwn(claims, 'nbf') &&
        (!Number.isSafeInteger(claims.nbf) ||
          Number(claims.nbf) < 0 ||
          Number(claims.nbf) * 1000 > now)) ||
      !opaque(claims.nonce) ||
      !timingSafeEqual(Buffer.from(claims.nonce), Buffer.from(nonce))
    )
      invalid();
    if (
      claims.email_verified !== true ||
      !email(claims.email) ||
      claims.email.toLowerCase() !== this.allowedEmail ||
      (this.expectedHostedDomain !== undefined &&
        claims.hd !== this.expectedHostedDomain) ||
      (this.pinnedGoogleSubject !== undefined &&
        claims.sub !== this.pinnedGoogleSubject)
    )
      throw new GoogleOidcError('GOOGLE_IDENTITY_REJECTED');
  }

  private async key(kid: string) {
    const now = this.clock();
    const cached = this.keys.get(kid);
    if (cached && this.keysExpireAt > now) return cached;
    if (this.refreshing) await this.refreshing;
    else {
      if (now - this.lastRefreshAt < JWKS_REFRESH_COOLDOWN_MS) invalid();
      this.lastRefreshAt = now;
      const pending = this.refreshKeys();
      this.refreshing = pending;
      try {
        await pending;
      } finally {
        if (this.refreshing === pending) this.refreshing = undefined;
      }
    }
    const key = this.keys.get(kid);
    // max-age=0 authorizes only the request that fetched this fresh response,
    // never subsequent requests or stale-cache fallback after network failure.
    if (!key) invalid();
    return key;
  }

  private async refreshKeys() {
    const { data, cacheControl, age } = await this.requestJson(
      GOOGLE_OIDC.jwksUri,
      { method: 'GET', headers: { accept: 'application/json' } },
    );
    try {
      if (
        !Array.isArray(data.keys) ||
        !data.keys.length ||
        data.keys.length > 8
      )
        invalid();
      const keys = new Map<string, KeyObject>();
      for (const item of data.keys) {
        if (
          !object(item) ||
          item.kty !== 'RSA' ||
          item.alg !== 'RS256' ||
          item.use !== 'sig' ||
          !keyId(item.kid) ||
          keys.has(item.kid) ||
          Object.keys(item).some(
            (field) =>
              !['kty', 'alg', 'use', 'kid', 'n', 'e', 'key_ops'].includes(
                field,
              ),
          ) ||
          (item.key_ops !== undefined &&
            (!Array.isArray(item.key_ops) ||
              item.key_ops.length !== 1 ||
              item.key_ops[0] !== 'verify'))
        )
          invalid();
        const modulus = canonicalBase64(item.n, 256, 512);
        if (modulus[0] === 0 || item.e !== 'AQAB') invalid();
        const key = createPublicKey({
          key: { kty: 'RSA', n: item.n as string, e: item.e as string },
          format: 'jwk',
        });
        const bits = key.asymmetricKeyDetails?.modulusLength;
        if (
          key.asymmetricKeyType !== 'rsa' ||
          !bits ||
          bits < 2048 ||
          bits > 4096
        )
          invalid();
        keys.set(item.kid, key);
      }
      this.keys = keys;
      this.keysExpireAt = this.clock() + cacheTtl(cacheControl, age);
    } catch {
      throw new GoogleOidcError('GOOGLE_PROVIDER_UNAVAILABLE');
    }
  }

  private async requestJson(url: string, input: RequestInit) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new GoogleOidcError('GOOGLE_PROVIDER_UNAVAILABLE'));
      }, this.requestTimeoutMs);
    });
    const run = async () => {
      const response = await this.request(url, {
        ...input,
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
      });
      if (
        response.status !== 200 ||
        (response.url && response.url !== url) ||
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get('content-type') || '',
        ) ||
        !response.body
      )
        throw new Error();
      const length = response.headers.get('content-length');
      if (
        length &&
        (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)
      )
        throw new Error();
      const reader = response.body.getReader();
      const cancel = () => {
        reader.cancel().catch(() => undefined);
      };
      controller.signal.addEventListener('abort', cancel, { once: true });
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          // eslint-disable-next-line no-await-in-loop -- Read incrementally under the byte/deadline budget.
          const result = await reader.read();
          if (result.done) break;
          bytes += result.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) throw new Error();
          chunks.push(result.value);
        }
      } finally {
        controller.signal.removeEventListener('abort', cancel);
        cancel();
      }
      return {
        data: parseJson(Buffer.concat(chunks, bytes)),
        cacheControl: response.headers.get('cache-control'),
        age: response.headers.get('age'),
      };
    };
    try {
      return await Promise.race([run(), timeout]);
    } catch {
      throw new GoogleOidcError('GOOGLE_PROVIDER_UNAVAILABLE');
    } finally {
      clearTimeout(timer!);
      controller.abort();
    }
  }
}
