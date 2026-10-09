import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import {
  CLOUD_CSRF_HEADER,
  CLOUD_SESSION_COOKIE,
  CloudAccessError,
  CloudAccessPolicy,
  type CloudRequestSource,
  type CloudAccessHeaders,
  type CloudAuthSession,
} from '../src/solo/cloud-access';

// Deterministic synthetic sessions are TEST ONLY; no production fallback store.
const tokenA = Buffer.alloc(32, 1).toString('base64url');
const tokenB = Buffer.alloc(32, 2).toString('base64url');
const csrfA = Buffer.alloc(32, 3).toString('base64url');
const csrfB = Buffer.alloc(32, 4).toString('base64url');
const publicOrigin = 'https://phone.example.com';
function fixture(maxCalls = 100) {
  let now = 10000;
  let lookups = 0;
  const make = (letter: 'a' | 'b'): CloudAuthSession => ({
    authSessionId: `session-${letter}`,
    principalId: 'single-principal',
    browserOwnerId: `owner-${letter}`,
    epoch: 1,
    issuedAt: 1000,
    absoluteExpiresAt: 40000,
    idleExpiresAt: 20000,
    revoked: false,
    csrfToken: letter === 'a' ? csrfA : csrfB,
  });
  const sessionA = make('a');
  const sessionB = make('b');
  const sessions = new Map([
    [tokenA, sessionA],
    [tokenB, sessionB],
  ]);
  const headers = (letter: 'a' | 'b' = 'a'): CloudAccessHeaders => ({
    host: 'phone.example.com',
    origin: publicOrigin,
    cookie: `${CLOUD_SESSION_COOKIE}=${letter === 'a' ? tokenA : tokenB}`,
    [CLOUD_CSRF_HEADER]: letter === 'a' ? csrfA : csrfB,
  });
  const policy = new CloudAccessPolicy({
    publicOrigin,
    maxCalls,
    now: () => now,
    resolveSession: (token) => {
      lookups += 1;
      const value = sessions.get(token);
      return value ? { ...value } : null;
    },
  });
  return {
    policy,
    headers,
    sessions,
    sessionA,
    sessionB,
    advance: (value: number) => {
      now = value;
    },
    lookups: () => lookups,
  };
}
function denied(run: () => unknown, code: CloudAccessError['code']) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof CloudAccessError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(
      error.statusCode,
      { UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404 }[code],
    );
    assert.ok(!error.message.includes('owner-'));
    assert.ok(!error.message.includes(tokenA));
    return true;
  });
}
function owned(f = fixture()) {
  const context = f.policy.authenticate(f.headers(), 'mutate');
  f.policy.registerCall(context, 'call-a');
  return { ...f, context };
}

test('no configured resolver denies access and resolver exceptions never leak identities', () => {
  const f = fixture();
  for (const resolveSession of [
    undefined,
    () => {
      throw new Error(`fixture private owner-a ${tokenA}`);
    },
  ]) {
    const policy = new CloudAccessPolicy({ publicOrigin, resolveSession });
    denied(() => policy.authenticate(f.headers()), 'UNAUTHORIZED');
  }
});

test('one canonical session cookie is required; arrays, duplicates, encodings and alternative credentials fail closed', () => {
  const { policy, headers } = fixture();
  for (const cookie of [
    undefined,
    '',
    `${CLOUD_SESSION_COOKIE}=`,
    CLOUD_SESSION_COOKIE,
    `${CLOUD_SESSION_COOKIE}=${tokenA}; ${CLOUD_SESSION_COOKIE}=${tokenB}`,
    `${CLOUD_SESSION_COOKIE}=${tokenA}; ${CLOUD_SESSION_COOKIE}=${tokenA}`,
    [`${CLOUD_SESSION_COOKIE}=${tokenA}`],
    `${CLOUD_SESSION_COOKIE}="${tokenA}"`,
    `${CLOUD_SESSION_COOKIE}=%41${tokenA.slice(1)}`,
    `${CLOUD_SESSION_COOKIE}=${'x'.repeat(44)}`,
    `${CLOUD_SESSION_COOKIE}=${'x'.repeat(43)}`,
    `other=${'x'.repeat(4096)}`,
    `other=${tokenA}`,
  ])
    denied(() => policy.authenticate({ ...headers(), cookie }), 'UNAUTHORIZED');
  denied(
    () =>
      policy.authenticate({
        ...headers(),
        cookie: undefined,
        authorization: `Bearer ${tokenA}`,
      }),
    'UNAUTHORIZED',
  );
  assert.ok(
    policy.authenticate({
      ...headers(),
      cookie: `other=value; ${CLOUD_SESSION_COOKIE}=${tokenA}`,
    }),
  );
});

test('all protected actions require exact pinned HTTPS origin and authority; duplicates and forwarded claims are rejected', () => {
  const { policy, headers } = fixture();
  for (const change of [
    { origin: undefined },
    { origin: 'null' },
    { origin: 'http://phone.example.com' },
    { origin: `${publicOrigin}:443` },
    { origin: `${publicOrigin}.evil.example` },
    { origin: [publicOrigin] },
    { host: 'evil.example' },
    { host: 'phone.example.com:443' },
    { host: ['phone.example.com'] },
    { Host: 'phone.example.com' },
    { Origin: publicOrigin },
    { forwarded: '' },
    { 'x-forwarded-for': '127.0.0.1' },
    { 'x-forwarded-host': 'phone.example.com' },
    { 'x-forwarded-proto': 'https' },
  ])
    denied(() => policy.authenticate({ ...headers(), ...change }), 'FORBIDDEN');
  for (const origin of [
    'http://phone.example.com',
    `${publicOrigin}/private`,
    `https://fixture-password@phone.example.com`,
  ])
    denied(() => new CloudAccessPolicy({ publicOrigin: origin }), 'FORBIDDEN');
  const nondefaultPort = new CloudAccessPolicy({
    publicOrigin: 'https://phone.example.com:8443',
    now: () => 10000,
    resolveSession: () => fixture().sessionA,
  });
  assert.ok(
    nondefaultPort.authenticate({
      ...headers(),
      host: 'phone.example.com:8443',
      origin: 'https://phone.example.com:8443',
    }),
  );
});

test('server-issued context is frozen and cannot be forged, cloned, or reused with another policy', () => {
  const f = owned();
  assert.ok(Object.isFrozen(f.context));
  assert.deepEqual(Object.keys(f.context).sort(), [
    'authSessionId',
    'browserOwnerId',
    'epoch',
    'principalId',
  ]);
  assert.throws(
    () => Object.assign(f.context, { browserOwnerId: 'owner-b' }),
    TypeError,
  );
  for (const context of [
    { ...f.context },
    {
      authSessionId: 'session-a',
      browserOwnerId: 'owner-a',
      epoch: 1,
      principalId: 'single-principal',
    },
    fixture().policy.authenticate(f.headers()),
  ])
    denied(() => f.policy.authorizeCall(context, 'call-a'), 'UNAUTHORIZED');
});

test('CSRF protects call registration, mutations and incoming audio; reads and outgoing audio are scoped without CSRF', () => {
  const f = owned();
  const read = f.policy.authenticate({
    ...f.headers(),
    [CLOUD_CSRF_HEADER]: undefined,
  });
  for (const action of ['read', 'audio', 'transcript'] as const)
    assert.doesNotThrow(() => f.policy.authorizeCall(read, 'call-a', action));
  for (const action of ['mutate', 'audio-write'] as const) {
    denied(
      () =>
        f.policy.authenticate(
          { ...f.headers(), [CLOUD_CSRF_HEADER]: csrfB },
          action,
        ),
      'FORBIDDEN',
    );
    denied(() => f.policy.authorizeCall(read, 'call-a', action), 'FORBIDDEN');
    assert.doesNotThrow(() =>
      f.policy.authorizeCall(f.context, 'call-a', action),
    );
  }
  denied(() => f.policy.registerCall(read, 'call-without-csrf'), 'FORBIDDEN');
  f.sessionA.csrfToken = csrfB;
  denied(
    () => f.policy.authorizeCall(f.context, 'call-a', 'mutate'),
    'FORBIDDEN',
  );
});

test('every cross-owner read, mutation, audio, transcript and takeover is denied even for the same principal', () => {
  const f = owned();
  const other = f.policy.authenticate(f.headers('b'), 'mutate');
  for (const action of [
    'read',
    'mutate',
    'audio',
    'audio-write',
    'transcript',
    'takeover',
  ] as const)
    denied(() => f.policy.authorizeCall(other, 'call-a', action), 'NOT_FOUND');
  denied(() => f.policy.authorizeCall(f.context, 'unknown-call'), 'NOT_FOUND');
  // A misconfigured server returning the same owner still cannot merge sessions.
  f.sessionB.browserOwnerId = f.sessionA.browserOwnerId;
  const sameOwnerDifferentSession = f.policy.authenticate(
    f.headers('b'),
    'mutate',
  );
  denied(
    () => f.policy.authorizeCall(sameOwnerDifferentSession, 'call-a'),
    'NOT_FOUND',
  );
});

test('takeover is unsupported even for the same owner; duplicate IDs cannot rebind and metadata is bounded', () => {
  const f = owned(fixture(1));
  denied(
    () => f.policy.authorizeCall(f.context, 'call-a', 'takeover'),
    'FORBIDDEN',
  );
  denied(() => f.policy.authenticate(f.headers(), 'takeover'), 'FORBIDDEN');
  denied(() => f.policy.registerCall(f.context, 'call-a'), 'NOT_FOUND');
  denied(() => f.policy.registerCall(f.context, 'call-b'), 'FORBIDDEN');
  assert.doesNotThrow(() => f.policy.authorizeCall(f.context, 'call-a'));
  for (const maxCalls of [0, -1, 10001, 1.5])
    denied(
      () => new CloudAccessPolicy({ publicOrigin, maxCalls }),
      'FORBIDDEN',
    );
});

test('every use checks resolver state, absolute/idle expiry, revocation and identity/epoch changes', () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.sessionA.revoked = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.advance(f.sessionA.absoluteExpiresAt);
    },
    (f: ReturnType<typeof fixture>) => {
      f.advance(f.sessionA.idleExpiresAt);
    },
    (f: ReturnType<typeof fixture>) => {
      f.sessionA.epoch += 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.sessionA.principalId = 'changed-principal';
    },
    (f: ReturnType<typeof fixture>) => {
      f.sessionA.browserOwnerId = 'changed-owner';
    },
    (f: ReturnType<typeof fixture>) => {
      f.sessionA.authSessionId = 'changed-session';
    },
    (f: ReturnType<typeof fixture>) => {
      f.sessions.delete(tokenA);
    },
  ]) {
    const f = owned();
    change(f);
    for (const run of [
      () => f.policy.revalidate(f.context),
      () => f.policy.registerCall(f.context, 'call-new'),
      () => f.policy.authorizeCall(f.context, 'call-a'),
    ])
      denied(run, 'UNAUTHORIZED');
  }
  const f = owned();
  const before = f.lookups();
  f.policy.revalidate(f.context);
  f.policy.authorizeCall(f.context, 'call-a', 'transcript');
  f.policy.runAuthorizedCall(f.context, 'call-a', 'audio', () => undefined);
  assert.equal(f.lookups() - before, 3);
});

test('malformed resolver records fail closed without exposing fixture data', () => {
  const f = fixture();
  for (const record of [
    undefined,
    null,
    true,
    'fixture-private-identity',
    [],
    {},
    { ...f.sessionA, revoked: undefined },
    { ...f.sessionA, epoch: -1 },
    { ...f.sessionA, issuedAt: 10001 },
    { ...f.sessionA, idleExpiresAt: NaN },
    { ...f.sessionA, absoluteExpiresAt: Infinity },
    { ...f.sessionA, principalId: ['single-principal'] },
    { ...f.sessionA, csrfToken: '' },
    { ...f.sessionA, absoluteExpiresAt: 1000 },
    Object.defineProperty({ ...f.sessionA }, 'revoked', { get: () => false }),
  ]) {
    const policy = new CloudAccessPolicy({
      publicOrigin,
      now: () => 10000,
      resolveSession: () => record,
    });
    denied(() => policy.authenticate(f.headers()), 'UNAUTHORIZED');
  }
});

test('async/thenable current-session resolvers are refused and their rejection is consumed', async () => {
  const f = fixture();
  for (const resolveSession of [
    () => Promise.resolve(f.sessionA),
    () => Promise.reject(new Error(`fixture private owner-a ${tokenA}`)),
    () => ({
      then: (resolve: (value: CloudAuthSession) => void) => resolve(f.sessionA),
    }),
  ]) {
    const policy = new CloudAccessPolicy({ publicOrigin, resolveSession });
    denied(() => policy.authenticate(f.headers()), 'UNAUTHORIZED');
  }
  await tick(); // node:test fails on any unhandled rejection after this test.
});

test('synchronous authorization/commit has no microtask gap and delayed preparations cannot commit after revocation', async () => {
  const f = owned();
  let committed = 0;
  const value = f.policy.runAuthorizedCall(
    f.context,
    'call-a',
    'mutate',
    (context) => {
      assert.equal(context, f.context);
      queueMicrotask(() => {
        f.sessionA.revoked = true;
      });
      committed += 1;
      return 'sent';
    },
  );
  assert.equal(value, 'sent');
  assert.equal(committed, 1);
  assert.equal(f.sessionA.revoked, false);
  await tick();
  denied(
    () =>
      f.policy.runAuthorizedCall(f.context, 'call-a', 'mutate', () => {
        committed += 1;
      }),
    'UNAUTHORIZED',
  );
  assert.equal(committed, 1);

  const delayed = owned();
  const prepare = async () => {
    await tick();
    delayed.sessionA.revoked = true;
  };
  await prepare();
  denied(
    () =>
      delayed.policy.runAuthorizedCall(
        delayed.context,
        'call-a',
        'audio',
        () => {
          committed += 1;
        },
      ),
    'UNAUTHORIZED',
  );
  assert.equal(committed, 1);
});

test('queued revocation cannot slip between registration check and the metadata commit', async () => {
  const f = fixture();
  const context = f.policy.authenticate(f.headers(), 'mutate');
  queueMicrotask(() =>
    queueMicrotask(() => {
      f.sessionA.revoked = true;
    }),
  );
  f.policy.registerCall(context, 'racing-call');
  assert.equal(f.sessionA.revoked, false); // registration already completed.
  await tick();
  denied(() => f.policy.authorizeCall(context, 'racing-call'), 'UNAUTHORIZED');
});

test('declared async commits are rejected before invoking their effects', () => {
  const f = owned();
  let invoked = false;
  denied(
    () =>
      f.policy.runAuthorizedCall(f.context, 'call-a', 'mutate', async () => {
        invoked = true;
      }),
    'FORBIDDEN',
  );
  assert.equal(invoked, false);
});

const sameOriginMetadata = {
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
};

test('normal browser GET/HEAD fetch and SSE metadata permits missing Origin for scoped reads only', () => {
  const f = owned();
  for (const method of ['GET', 'HEAD']) {
    for (const mode of ['cors', 'same-origin']) {
      const headers = {
        ...f.headers(),
        ...sameOriginMetadata,
        origin: undefined,
        'sec-fetch-mode': mode,
      };
      for (const action of ['read', 'audio', 'transcript'] as const) {
        const context = f.policy.authenticate(headers, action, {
          surface: 'http',
          method,
        });
        assert.equal(
          f.policy.runAuthorizedCall(
            context,
            'call-a',
            action,
            () => 'scoped-result',
          ),
          'scoped-result',
        );
      }
    }
  }
  const other = f.policy.authenticate(
    { ...f.headers('b'), ...sameOriginMetadata, origin: undefined },
    'transcript',
    { surface: 'http', method: 'GET' },
  );
  denied(
    () => f.policy.authorizeCall(other, 'call-a', 'transcript'),
    'NOT_FOUND',
  );
  denied(
    () =>
      f.policy.authenticate(
        {
          ...f.headers(),
          ...sameOriginMetadata,
          origin: undefined,
          cookie: undefined,
        },
        'read',
        { surface: 'http', method: 'GET' },
      ),
    'UNAUTHORIZED',
  );
});

test('missing/partial/ambiguous or non-read browser metadata fails closed even with a correct explicit Origin', () => {
  const f = fixture();
  const source = { surface: 'http' as const, method: 'GET' };
  for (const change of [
    { 'sec-fetch-site': undefined },
    { 'sec-fetch-mode': undefined },
    { 'sec-fetch-dest': undefined },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { 'sec-fetch-site': 'none' },
    { 'sec-fetch-mode': 'navigate' },
    { 'sec-fetch-mode': 'no-cors' },
    { 'sec-fetch-mode': 'websocket' },
    { 'sec-fetch-dest': 'document' },
    { 'sec-fetch-dest': 'iframe' },
    { 'sec-fetch-dest': 'image' },
    { 'sec-fetch-site': ['same-origin'] },
    { 'sec-fetch-mode': ['cors'] },
    { 'sec-fetch-dest': ['empty'] },
    { 'Sec-Fetch-Site': 'same-origin' },
    { 'Sec-Fetch-Mode': 'cors' },
    { 'Sec-Fetch-Dest': 'empty' },
  ]) {
    for (const origin of [undefined, publicOrigin])
      denied(
        () =>
          f.policy.authenticate(
            { ...f.headers(), ...sameOriginMetadata, origin, ...change },
            'read',
            source,
          ),
        'FORBIDDEN',
      );
  }
  denied(
    () =>
      f.policy.authenticate(
        { ...f.headers(), origin: undefined },
        'read',
        source,
      ),
    'FORBIDDEN',
  );
});

test('present wrong Origin never falls back; default and browser WS always require explicit Origin', () => {
  const f = fixture();
  for (const origin of [
    '',
    'null',
    'http://phone.example.com',
    'https://evil.example',
    [publicOrigin],
  ])
    denied(
      () =>
        f.policy.authenticate(
          { ...f.headers(), ...sameOriginMetadata, origin },
          'read',
          { surface: 'http', method: 'GET' },
        ),
      'FORBIDDEN',
    );
  const noOrigin = { ...f.headers(), ...sameOriginMetadata, origin: undefined };
  denied(() => f.policy.authenticate(noOrigin), 'FORBIDDEN');
  const wsMetadata = { ...sameOriginMetadata, 'sec-fetch-mode': 'websocket' };
  denied(
    () =>
      f.policy.authenticate({ ...noOrigin, ...wsMetadata }, 'read', {
        surface: 'browser-ws',
      }),
    'FORBIDDEN',
  );
  assert.ok(
    f.policy.authenticate({ ...f.headers(), ...wsMetadata }, 'read', {
      surface: 'browser-ws',
    }),
  );
  for (const site of ['cross-site', 'same-site', 'none'])
    denied(
      () =>
        f.policy.authenticate(
          { ...f.headers(), ...wsMetadata, 'sec-fetch-site': site },
          'read',
          { surface: 'browser-ws' },
        ),
      'FORBIDDEN',
    );
});

test('HTTP source enforces real methods; POST writes require explicit Origin and CSRF while GET/HEAD cannot write', () => {
  const f = fixture();
  for (const method of ['GET', 'HEAD']) {
    for (const action of ['mutate', 'audio-write'] as const)
      denied(
        () =>
          f.policy.authenticate(f.headers(), action, {
            surface: 'http',
            method,
          }),
        'FORBIDDEN',
      );
  }
  for (const action of ['read', 'audio', 'transcript'] as const)
    denied(
      () =>
        f.policy.authenticate(f.headers(), action, {
          surface: 'http',
          method: 'POST',
        }),
      'FORBIDDEN',
    );
  const post = { surface: 'http' as const, method: 'POST' };
  for (const action of ['mutate', 'audio-write'] as const) {
    denied(
      () =>
        f.policy.authenticate(
          { ...f.headers(), ...sameOriginMetadata, origin: undefined },
          action,
          post,
        ),
      'FORBIDDEN',
    );
    denied(
      () =>
        f.policy.authenticate(
          { ...f.headers(), [CLOUD_CSRF_HEADER]: undefined },
          action,
          post,
        ),
      'FORBIDDEN',
    );
    assert.ok(f.policy.authenticate(f.headers(), action, post));
  }
  for (const source of [
    { surface: 'other' },
    { surface: 'http', method: 'PUT' },
    { surface: 'http', method: 'get' },
    { surface: 'http', method: undefined },
    Object.defineProperty({}, 'surface', { get: () => 'http' }),
    Object.create({ surface: 'http', method: 'GET' }),
  ])
    denied(
      () =>
        f.policy.authenticate(
          f.headers(),
          'read',
          source as CloudRequestSource,
        ),
      'FORBIDDEN',
    );
});

test('GET read context cannot launder CSRF into writes or be upgraded by mutating the caller source object', () => {
  const f = owned();
  for (const origin of [undefined, publicOrigin]) {
    const source = { surface: 'http' as const, method: 'GET' };
    const context = f.policy.authenticate(
      {
        ...f.headers(),
        ...sameOriginMetadata,
        origin,
        'x-http-method-override': 'POST',
      },
      'read',
      source,
    );
    source.method = 'POST';
    denied(() => f.policy.registerCall(context, 'laundered-call'), 'FORBIDDEN');
    let committed = false;
    for (const action of ['mutate', 'audio-write'] as const) {
      denied(() => f.policy.revalidate(context, action), 'FORBIDDEN');
      denied(
        () => f.policy.authorizeCall(context, 'call-a', action),
        'FORBIDDEN',
      );
      denied(
        () =>
          f.policy.runAuthorizedCall(context, 'call-a', action, () => {
            committed = true;
          }),
        'FORBIDDEN',
      );
    }
    assert.equal(committed, false);
    assert.doesNotThrow(() =>
      f.policy.authorizeCall(context, 'call-a', 'transcript'),
    );
  }
});
