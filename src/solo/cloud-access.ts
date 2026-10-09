// eslint-disable-next-line max-classes-per-file -- Keep the typed public error with its authorization policy.
import { timingSafeEqual } from 'node:crypto';

export type CloudAccessHeaders = Readonly<
  Record<string, string | string[] | undefined>
>;
export type CloudAccessAction =
  | 'read'
  | 'mutate'
  | 'audio'
  | 'audio-write'
  | 'transcript'
  | 'takeover';
/** Trusted transport metadata, never copied from request body/query/WS frames. */
export type CloudRequestSource =
  | Readonly<{ surface: 'http'; method: string }>
  | Readonly<{ surface: 'browser-ws' }>;
export type CloudAuthSession = {
  authSessionId: string;
  principalId: string;
  browserOwnerId: string;
  epoch: number;
  issuedAt: number;
  absoluteExpiresAt: number;
  idleExpiresAt: number;
  revoked: boolean;
  csrfToken: string;
};
/** Synchronous server-side CURRENT session lookup on every use, never login.
 * Async login/DB transactions require a separate design. Thenables are rejected.
 * No browser identity fields, persistent store or login provider are implemented.
 */
export type CloudSessionResolver = (opaqueCookie: string) => unknown;
export type CloudAccessContext = Readonly<
  Pick<
    CloudAuthSession,
    'authSessionId' | 'principalId' | 'browserOwnerId' | 'epoch'
  >
>;
export const CLOUD_SESSION_COOKIE = '__Host-ai-phone-session';
export const CLOUD_CSRF_HEADER = 'x-phone-csrf';

export class CloudAccessError extends Error {
  readonly statusCode: 401 | 403 | 404;

  constructor(readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND') {
    super(code);
    this.statusCode = { UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404 }[
      code
    ] as 401 | 403 | 404;
  }
}

type IssuedContext = {
  credential: string;
  csrf: string | undefined;
  binding: CloudAccessContext;
  source: CloudRequestSource | undefined;
  originPresent: boolean;
};
const identity = /^[A-Za-z0-9_-]{1,128}$/;
const opaque = /^[A-Za-z0-9_-]{43}$/;
const actions = new Set<CloudAccessAction>([
  'read',
  'mutate',
  'audio',
  'audio-write',
  'transcript',
  'takeover',
]);

function header(headers: CloudAccessHeaders, name: string): string | undefined {
  const keys = Object.keys(headers).filter((key) => key.toLowerCase() === name);
  if (!keys.length) return undefined;
  const value = headers[keys[0]];
  if (keys.length === 1 && value === undefined) return undefined;
  if (keys.length !== 1 || typeof value !== 'string' || /[\r\n\0]/.test(value))
    throw new CloudAccessError('FORBIDDEN');
  return value;
}
function credential(headers: CloudAccessHeaders): string {
  let value: string | undefined;
  try {
    const cookie = header(headers, 'cookie');
    if (!cookie || cookie.length > 4096) throw new Error();
    const matches = cookie.split(';').filter((part) => {
      const index = part.indexOf('=');
      return (
        part.slice(0, index < 0 ? undefined : index).trim() ===
        CLOUD_SESSION_COOKIE
      );
    });
    if (matches.length !== 1) throw new Error();
    value = matches[0].slice(matches[0].indexOf('=') + 1).trim();
    if (!opaque.test(value)) throw new Error();
    // Canonical unpadded base64url for exactly 32 random bytes.
    if (Buffer.from(value, 'base64url').toString('base64url') !== value)
      throw new Error();
  } catch {
    throw new CloudAccessError('UNAUTHORIZED');
  }
  return value;
}
function sameBinding(left: CloudAccessContext, right: CloudAccessContext) {
  return (
    left.authSessionId === right.authSessionId &&
    left.principalId === right.principalId &&
    left.browserOwnerId === right.browserOwnerId &&
    left.epoch === right.epoch
  );
}
function binding(session: CloudAuthSession): CloudAccessContext {
  return Object.freeze({
    authSessionId: session.authSessionId,
    principalId: session.principalId,
    browserOwnerId: session.browserOwnerId,
    epoch: session.epoch,
  });
}

/** Unwired authorization component: no phone, controller lease, budget or login.
 * After asynchronous preparation, runAuthorizedCall is the final synchronous
 * check/commit boundary. It cannot make external async provider effects atomic.
 */
export class CloudAccessPolicy {
  private readonly origin: string;

  private readonly authority: string;

  private readonly resolveSession: CloudSessionResolver | undefined;

  private readonly now: () => number;

  private readonly maxCalls: number;

  private readonly issued = new WeakMap<CloudAccessContext, IssuedContext>();

  private readonly calls = new Map<string, CloudAccessContext>();

  constructor(options: {
    publicOrigin: string;
    resolveSession?: CloudSessionResolver;
    now?: () => number;
    maxCalls?: number;
  }) {
    let url: URL;
    try {
      url = new URL(options.publicOrigin);
    } catch {
      throw new CloudAccessError('FORBIDDEN');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new CloudAccessError('FORBIDDEN');
    this.origin = url.origin;
    this.authority = url.host;
    this.resolveSession = options.resolveSession;
    this.now = options.now || Date.now;
    this.maxCalls = options.maxCalls ?? 100;
    if (
      !Number.isInteger(this.maxCalls) ||
      this.maxCalls < 1 ||
      this.maxCalls > 10000
    )
      throw new CloudAccessError('FORBIDDEN');
  }

  get publicOrigin(): string {
    return this.origin;
  }

  private requireSourceAction(
    source: CloudRequestSource | undefined,
    originPresent: boolean,
    action: CloudAccessAction,
  ): void {
    if (source?.surface !== 'http') return;
    const read = ['read', 'audio', 'transcript'].includes(action);
    if (
      (read && !['GET', 'HEAD'].includes(source.method)) ||
      (!read && (source.method !== 'POST' || !originPresent))
    )
      throw new CloudAccessError('FORBIDDEN');
  }

  private requireHeaders(
    headers: CloudAccessHeaders,
    action: CloudAccessAction,
    inputSource?: CloudRequestSource,
  ): Pick<IssuedContext, 'source' | 'originPresent'> {
    if (!headers || typeof headers !== 'object' || Array.isArray(headers))
      throw new CloudAccessError('FORBIDDEN');
    let source: CloudRequestSource | undefined;
    if (inputSource !== undefined) {
      if (
        !inputSource ||
        typeof inputSource !== 'object' ||
        Array.isArray(inputSource)
      )
        throw new CloudAccessError('FORBIDDEN');
      const surface = Object.getOwnPropertyDescriptor(
        inputSource,
        'surface',
      )?.value;
      const method = Object.getOwnPropertyDescriptor(
        inputSource,
        'method',
      )?.value;
      if (
        surface === 'http' &&
        typeof method === 'string' &&
        ['GET', 'HEAD', 'POST'].includes(method)
      )
        source = Object.freeze({ surface: 'http', method });
      else if (surface === 'browser-ws')
        source = Object.freeze({ surface: 'browser-ws' });
      else throw new CloudAccessError('FORBIDDEN');
    }
    if (
      header(headers, 'host') !== this.authority ||
      [
        'forwarded',
        'x-forwarded-for',
        'x-forwarded-host',
        'x-forwarded-proto',
      ].some((name) => header(headers, name) !== undefined)
    )
      throw new CloudAccessError('FORBIDDEN');
    const origin = header(headers, 'origin');
    const originPresent = origin !== undefined;
    const site = header(headers, 'sec-fetch-site');
    const mode = header(headers, 'sec-fetch-mode');
    const dest = header(headers, 'sec-fetch-dest');
    const modes =
      source?.surface === 'browser-ws'
        ? ['websocket']
        : ['cors', 'same-origin'];
    const metadataPresent = [site, mode, dest].some(
      (value) => value !== undefined,
    );
    const validMetadata =
      site === 'same-origin' && modes.includes(mode || '') && dest === 'empty';
    // Supplemental browser provenance only: scripts outside browsers can forge
    // these headers. Cookie/current session/ownership checks remain mandatory.
    if (metadataPresent && !validMetadata)
      throw new CloudAccessError('FORBIDDEN');
    if (originPresent) {
      if (origin !== this.origin) throw new CloudAccessError('FORBIDDEN');
    } else if (source?.surface !== 'http' || !validMetadata) {
      throw new CloudAccessError('FORBIDDEN');
    }
    this.requireSourceAction(source, originPresent, action);
    return { source, originPresent };
  }

  private current(token: string): CloudAuthSession {
    try {
      if (!this.resolveSession) throw new Error();
      const record = this.resolveSession(token);
      if (record && typeof (record as { then?: unknown }).then === 'function') {
        // Misconfigured server-only resolver: consume rejection without granting
        // access or leaking credentials through an unhandled rejection.
        Promise.resolve(record).catch(() => {});
        throw new Error();
      }
      if (!record || typeof record !== 'object' || Array.isArray(record))
        throw new Error();
      const fields = [
        'authSessionId',
        'principalId',
        'browserOwnerId',
        'epoch',
        'issuedAt',
        'absoluteExpiresAt',
        'idleExpiresAt',
        'revoked',
        'csrfToken',
      ] as const;
      // Accept data records only; accessors must not change identity/revocation
      // between validation and commit or add private resolver fields to a grant.
      const session = Object.fromEntries(
        fields.map((name) => {
          const field = Object.getOwnPropertyDescriptor(record, name);
          if (!field || !('value' in field)) throw new Error();
          return [name, field.value];
        }),
      ) as CloudAuthSession;
      const now = this.now();
      if (
        ![
          session.authSessionId,
          session.principalId,
          session.browserOwnerId,
        ].every((id) => typeof id === 'string' && identity.test(id)) ||
        !Number.isSafeInteger(session.epoch) ||
        session.epoch < 0 ||
        ![
          session.issuedAt,
          session.absoluteExpiresAt,
          session.idleExpiresAt,
          now,
        ].every(Number.isSafeInteger) ||
        session.issuedAt > now ||
        session.absoluteExpiresAt <= session.issuedAt ||
        session.idleExpiresAt <= session.issuedAt ||
        now >= session.absoluteExpiresAt ||
        now >= session.idleExpiresAt ||
        session.revoked !== false ||
        typeof session.csrfToken !== 'string' ||
        !opaque.test(session.csrfToken)
      )
        throw new Error();
      return { ...session };
    } catch {
      // Resolver errors may contain credentials/identity; never expose them.
      throw new CloudAccessError('UNAUTHORIZED');
    }
  }

  private requireAction(
    action: CloudAccessAction,
    csrf: string | undefined,
    session: CloudAuthSession,
  ) {
    if (!actions.has(action) || action === 'takeover')
      throw new CloudAccessError('FORBIDDEN');
    if (action !== 'mutate' && action !== 'audio-write') return;
    const left = Buffer.from(csrf || '');
    const right = Buffer.from(session.csrfToken);
    if (
      !left.length ||
      left.length !== right.length ||
      !timingSafeEqual(left, right)
    )
      throw new CloudAccessError('FORBIDDEN');
  }

  authenticate(
    headers: CloudAccessHeaders,
    action: CloudAccessAction = 'read',
    source?: CloudRequestSource,
  ): CloudAccessContext {
    const provenance = this.requireHeaders(headers, action, source);
    const token = credential(headers);
    const csrf = header(headers, CLOUD_CSRF_HEADER);
    const session = this.current(token);
    this.requireAction(action, csrf, session);
    const context = binding(session);
    this.issued.set(context, {
      credential: token,
      csrf,
      binding: context,
      ...provenance,
    });
    return context;
  }

  private refresh(context: CloudAccessContext): {
    issued: IssuedContext;
    session: CloudAuthSession;
  } {
    const issued = this.issued.get(context);
    if (!issued) throw new CloudAccessError('UNAUTHORIZED');
    const session = this.current(issued.credential);
    if (!sameBinding(issued.binding, session))
      throw new CloudAccessError('UNAUTHORIZED');
    return { issued, session };
  }

  revalidate(
    context: CloudAccessContext,
    action: CloudAccessAction = 'read',
  ): void {
    const { issued, session } = this.refresh(context);
    this.requireSourceAction(issued.source, issued.originPresent, action);
    this.requireAction(action, issued.csrf, session);
  }

  /** Read-only bootstrap for an authenticated same-origin browser. The returned
   * CSRF token can accompany a NEW POST context; it cannot promote this GET
   * context to a write capability or return the opaque login credential. */
  currentCsrfToken(context: CloudAccessContext): string {
    const { issued, session } = this.refresh(context);
    this.requireSourceAction(issued.source, issued.originPresent, 'read');
    this.requireAction('read', issued.csrf, session);
    return session.csrfToken;
  }

  /** Current server-authenticated deadline; no credential/session fields escape. */
  expiresAt(
    context: CloudAccessContext,
    action: CloudAccessAction = 'read',
  ): number {
    const { issued, session } = this.refresh(context);
    this.requireSourceAction(issued.source, issued.originPresent, action);
    this.requireAction(action, issued.csrf, session);
    return Math.min(session.absoluteExpiresAt, session.idleExpiresAt);
  }

  registerCall(context: CloudAccessContext, callId: string): void {
    const { issued, session } = this.refresh(context);
    this.requireSourceAction(issued.source, issued.originPresent, 'mutate');
    this.requireAction('mutate', issued.csrf, session);
    if (
      typeof callId !== 'string' ||
      !identity.test(callId) ||
      this.calls.has(callId)
    )
      throw new CloudAccessError('NOT_FOUND');
    if (this.calls.size >= this.maxCalls)
      throw new CloudAccessError('FORBIDDEN');
    this.calls.set(callId, binding(session));
  }

  /** Private rollback capability for a server admission that has not published.
   * It revokes metadata only, never grants permission or stops an active phone.
   * The caller must retain registrations for every committed/uncertain session.
   */
  registerCallWithRollback(
    context: CloudAccessContext,
    callId: string,
  ): () => void {
    this.registerCall(context, callId);
    const registered = this.calls.get(callId);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.calls.get(callId) === registered) this.calls.delete(callId);
    };
  }

  authorizeCall(
    context: CloudAccessContext,
    callId: string,
    action: CloudAccessAction = 'read',
  ): void {
    const { issued, session } = this.refresh(context);
    const owner = this.calls.get(callId);
    if (!owner || !sameBinding(owner, session))
      throw new CloudAccessError('NOT_FOUND');
    this.requireSourceAction(issued.source, issued.originPresent, action);
    this.requireAction(action, issued.csrf, session);
  }

  /** Synchronous commit/send only, with no deferred side effects. Async prepare
   * happens before entering this boundary; external async effects need their own
   * transactional authority rather than a cached authorization result.
   */
  runAuthorizedSession<T>(
    context: CloudAccessContext,
    action: CloudAccessAction,
    commit: (context: CloudAccessContext) => T,
  ): T {
    if (Object.prototype.toString.call(commit) !== '[object Function]')
      throw new CloudAccessError('FORBIDDEN');
    this.revalidate(context, action);
    const result = commit(context);
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      Promise.resolve(result).catch(() => {});
      throw new CloudAccessError('FORBIDDEN');
    }
    return result;
  }

  runAuthorizedCall<T>(
    context: CloudAccessContext,
    callId: string,
    action: CloudAccessAction,
    commit: (context: CloudAccessContext) => T,
  ): T {
    if (Object.prototype.toString.call(commit) !== '[object Function]')
      throw new CloudAccessError('FORBIDDEN');
    this.authorizeCall(context, callId, action);
    const result = commit(context);
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      Promise.resolve(result).catch(() => {});
      throw new CloudAccessError('FORBIDDEN');
    }
    return result;
  }
}
