import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import fastify from 'fastify';

import { CLOUD_SESSION_COOKIE } from '../src/solo/cloud-access';
import { createCloudAccessTransport } from '../src/solo/cloud-access-transport';
import {
  GOOGLE_LOGIN_COOKIE,
  GoogleBrowserLogin,
  type GoogleLoginFailureReason,
  registerGoogleLoginRoutes,
} from '../src/solo/google-login';
import { GOOGLE_OIDC, GoogleOidcClient } from '../src/solo/google-oidc';

const origin = 'https://phone.example.test';
const clientId = 'offline.apps.googleusercontent.com';
const email = 'owner@workspace.example.test';
const domain = 'workspace.example.test';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...pair.publicKey.export({ format: 'jwk' }),
  kid: 'offline-key',
  alg: 'RS256',
  use: 'sig',
};
const writeHeaders = (cookie?: string) => ({
  host: 'phone.example.test',
  origin,
  'x-phone-login': 'start',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  ...(cookie ? { cookie } : {}),
});
const readHeaders = (cookie?: string) => ({
  host: 'phone.example.test',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  ...(cookie ? { cookie } : {}),
});
const callbackHeaders = (cookie?: string) => ({
  host: 'phone.example.test',
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  ...(cookie ? { cookie } : {}),
});
const cookiePair = (value: string) => value.split(';')[0];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Flow = {
  state: string;
  nonce: string;
  challenge: string;
  cookie: string;
  code: string;
};

async function fixture(
  t: TestContext,
  options: {
    flowTimeoutMs?: number;
    idleTimeoutMs?: number;
    absoluteTimeoutMs?: number;
    onFailure?: (reason: GoogleLoginFailureReason) => void;
  } = {},
) {
  let now = 1_800_000_000_000;
  const codes = new Map<string, string>();
  let tokenRequests = 0;
  let failure = false;
  let tokenBarrier: ReturnType<typeof deferred> | null = null;
  let sendBarrier: ReturnType<typeof deferred> | null = null;
  let enteredToken = deferred();
  let enteredSend = deferred();
  const failures: GoogleLoginFailureReason[] = [];
  const claims: Record<string, unknown> = {};
  const tokenCounts = new Map<number, ReturnType<typeof deferred>>();
  const requests: { code: string; verifier: string }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === GOOGLE_OIDC.jwksUri)
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: {
          'content-type': 'application/json',
          'cache-control': 'public,max-age=60',
        },
      });
    assert.equal(
      url,
      GOOGLE_OIDC.tokenEndpoint,
      'Only fixed official endpoints are used with the explicit offline port',
    );
    tokenRequests += 1;
    tokenCounts.get(tokenRequests)?.resolve();
    const params = new URLSearchParams(String(init?.body));
    assert.equal(params.get('grant_type'), 'authorization_code');
    assert.equal(params.get('redirect_uri'), `${origin}/auth/google/callback`);
    assert.equal(params.get('client_id'), clientId);
    const code = params.get('code')!;
    requests.push({ code, verifier: params.get('code_verifier')! });
    enteredToken.resolve();
    if (tokenBarrier) await tokenBarrier.promise;
    if (failure)
      throw new Error('offline provider unavailable; never expose this detail');
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: GOOGLE_OIDC.issuer,
        sub: 'offline-subject',
        aud: clientId,
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 300,
        nonce: codes.get(code),
        email,
        email_verified: true,
        hd: domain,
        ...claims,
      }),
    ).toString('base64url');
    const data = `${header}.${payload}`;
    const jwt = `${data}.${sign('RSA-SHA256', Buffer.from(data), pair.privateKey).toString('base64url')}`;
    return new Response(
      JSON.stringify({
        id_token: jwt,
        access_token: 'offline-unused-access-token',
        token_type: 'Bearer',
        expires_in: 300,
      }),
      {
        headers: { 'content-type': 'application/json' },
      },
    );
  };
  const client = new GoogleOidcClient({
    clientId,
    clientSecret: 'offline-not-a-secret',
    redirectUri: `${origin}/auth/google/callback`,
    allowedEmail: email,
    expectedHostedDomain: domain,
    fetch: fakeFetch,
    now: () => now,
  });
  const login = new GoogleBrowserLogin({
    client,
    publicOrigin: origin,
    now: () => now,
    onFailure: (reason) => failures.push(reason),
    ...options,
  });
  const app = fastify({ logger: false });
  app.addHook('onSend', async (request) => {
    if (request.url.startsWith('/auth/google/callback') && sendBarrier) {
      enteredSend.resolve();
      await sendBarrier.promise;
    }
  });
  registerGoogleLoginRoutes(app, login);
  const transport = createCloudAccessTransport(login.policy);
  app.get('/api/current', transport.sessionHttpRoute('read'), async (request) =>
    transport.executeSessionHttp(request, (context) => ({
      csrf: login.policy.currentCsrfToken(context),
      deadline: login.policy.expiresAt(context),
      principal: context.principalId,
    })),
  );
  t.after(() => app.close());
  let codeId = 0;
  const start = async (cookies?: string): Promise<Flow> => {
    const result = await app.inject({
      method: 'POST',
      url: '/auth/google/start',
      headers: writeHeaders(cookies),
      payload: {},
      remoteAddress: '127.0.0.1',
    });
    assert.equal(result.statusCode, 200, result.body);
    const url = new URL(result.json().authorizationUrl);
    const code = `offline-code-${++codeId}`;
    const flow = {
      state: url.searchParams.get('state')!,
      nonce: url.searchParams.get('nonce')!,
      challenge: url.searchParams.get('code_challenge')!,
      cookie: cookiePair(result.headers['set-cookie'] as string),
      code,
    };
    codes.set(code, flow.nonce);
    return flow;
  };
  const callback = (flow: Flow, cookies = flow.cookie, extra = '') =>
    app.inject({
      method: 'GET',
      url: `/auth/google/callback?state=${flow.state}&code=${flow.code}${extra}`,
      headers: callbackHeaders(cookies),
      remoteAddress: '127.0.0.1',
    });
  const current = (cookies?: string) =>
    app.inject({
      method: 'GET',
      url: '/api/current',
      headers: readHeaders(cookies),
      remoteAddress: '127.0.0.1',
    });
  const signIn = async (cookies?: string) => {
    const flow = await start(cookies);
    const result = await callback(flow);
    assert.equal(result.statusCode, 200, result.body);
    const values = result.headers['set-cookie'] as string[];
    const session = cookiePair(
      values.find((value) => value.startsWith(`${CLOUD_SESSION_COOKIE}=`))!,
    );
    const status = await current(session);
    assert.equal(status.statusCode, 200);
    return { flow, result, session, ...status.json() };
  };
  const write = (
    url: string,
    cookies?: string,
    csrf?: string,
    payload: Record<string, unknown> = {},
  ) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        ...writeHeaders(cookies),
        ...(csrf ? { 'x-phone-csrf': csrf } : {}),
      },
      payload,
      remoteAddress: '127.0.0.1',
    });
  return {
    app,
    client,
    login,
    start,
    callback,
    current,
    signIn,
    write,
    requests,
    failures,
    claims,
    waitForTokenCount(count: number) {
      if (tokenRequests >= count) return Promise.resolve();
      const pending = deferred();
      tokenCounts.set(count, pending);
      return pending.promise;
    },
    get tokenRequests() {
      return tokenRequests;
    },
    setNow(value: number) {
      now = value;
    },
    get now() {
      return now;
    },
    failProvider() {
      failure = true;
    },
    blockToken() {
      tokenBarrier = deferred();
      enteredToken = deferred();
      return { entered: enteredToken.promise, release: tokenBarrier.resolve };
    },
    blockSend() {
      sendBarrier = deferred();
      enteredSend = deferred();
      return { entered: enteredSend.promise, release: sendBarrier.resolve };
    },
  };
}

test('login status is non-secret and strictly same-origin, start needs explicit custom source header', async (t) => {
  const f = await fixture(t);
  const status = await f.app.inject({
    method: 'GET',
    url: '/auth/status',
    headers: readHeaders(),
    remoteAddress: '127.0.0.1',
  });
  assert.deepEqual(status.json(), { provider: 'google', enabled: true });
  assert.equal(status.headers['cache-control'], 'private, no-store');
  for (const headers of [
    { host: 'phone.example.test' },
    { ...readHeaders(), origin: 'null' },
    { ...readHeaders(), 'sec-fetch-site': 'cross-site' },
    { ...readHeaders(), 'x-forwarded-host': 'phone.example.test' },
  ]) {
    const denied = await f.app.inject({
      method: 'GET',
      url: '/auth/status',
      headers,
      remoteAddress: '127.0.0.1',
    });
    assert.equal(denied.statusCode, 403);
  }
  const bad = await f.app.inject({
    method: 'POST',
    url: '/auth/google/start',
    headers: { ...writeHeaders(), 'x-phone-login': 'incorrect' },
    payload: {},
    remoteAddress: '127.0.0.1',
  });
  assert.equal(bad.statusCode, 403);
  assert.equal(f.tokenRequests, 0);
});

test('server-generated independent state nonce and PKCE produce a verified opaque Strict session', async (t) => {
  const f = await fixture(t);
  const login = await f.signIn();
  assert.notEqual(login.flow.state, login.flow.nonce);
  assert.notEqual(login.flow.state, login.flow.challenge);
  assert.equal(
    createHash('sha256').update(f.requests[0].verifier).digest('base64url'),
    login.flow.challenge,
  );
  assert.equal(f.requests[0].verifier.length, 43);
  const values = login.result.headers['set-cookie'] as string[];
  const sessionHeader = values.find((value) =>
    value.startsWith(`${CLOUD_SESSION_COOKIE}=`),
  )!;
  assert.match(sessionHeader, /Path=\/; Secure; HttpOnly; SameSite=Strict$/);
  assert.doesNotMatch(sessionHeader, /Domain|Expires|Max-Age/);
  assert.match(login.result.body, /url=\/controlled/);
  assert.doesNotMatch(
    login.result.body,
    new RegExp(`${login.flow.code}|${login.flow.state}|${email}|eyJ`),
  );
  assert.equal(login.result.headers['referrer-policy'], 'no-referrer');
  assert.equal(login.result.headers.location, undefined);
  assert.match(login.principal, /^[a-f0-9]{64}$/);
  assert.equal((await f.current()).statusCode, 401);
  assert.deepEqual(
    f.failures,
    [],
    'Success and ordinary session reads produce no failure diagnostics',
  );
});

test('state is bound to this browser and consumed before async exchange', async (t) => {
  const f = await fixture(t);
  const a = await f.start();
  const b = await f.start();
  assert.equal((await f.callback(a, b.cookie)).statusCode, 401);
  assert.equal(f.tokenRequests, 0);
  const barrier = f.blockToken();
  const first = f.callback(a);
  const pending = first.then((value) => value);
  await barrier.entered;
  assert.equal((await f.callback(a)).statusCode, 401);
  assert.equal(f.tokenRequests, 1);
  barrier.release();
  assert.equal((await pending).statusCode, 200);
  assert.equal((await f.callback(a)).statusCode, 401);
  assert.equal(f.tokenRequests, 1);
});

for (const retirement of [
  'cancel',
  'new-login',
  'expired',
  'closed',
] as const) {
  test(`pending exchange cannot establish a session after ${retirement}`, async (t) => {
    const f = await fixture(t);
    const flow = await f.start();
    const barrier = f.blockToken();
    const pending = f.callback(flow).then((value) => value);
    await barrier.entered;
    if (retirement === 'cancel')
      assert.equal(
        (await f.write('/auth/google/cancel', flow.cookie)).statusCode,
        200,
      );
    if (retirement === 'new-login') await f.start(flow.cookie);
    if (retirement === 'expired') f.setNow(f.now + 300001);
    if (retirement === 'closed') f.login.close();
    barrier.release();
    const response = await pending;
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.deepEqual(f.failures, ['POST_EXCHANGE_REJECTED']);
  });
}

for (const retirement of ['cancel', 'new-login', 'logout'] as const) {
  test(`final callback publication rejects ${retirement} during async onSend`, async (t) => {
    const f = await fixture(t);
    const prior = await f.signIn();
    const flow = await f.start(prior.session);
    const barrier = f.blockSend();
    const pending = f.callback(flow).then((value) => value);
    await barrier.entered;
    if (retirement === 'cancel')
      assert.equal(
        (await f.write('/auth/google/cancel', flow.cookie)).statusCode,
        200,
      );
    if (retirement === 'new-login')
      await f.start(`${flow.cookie}; ${prior.session}`);
    if (retirement === 'logout')
      assert.equal(
        (await f.write('/auth/logout', prior.session, prior.csrf)).statusCode,
        200,
      );
    barrier.release();
    const result = await pending;
    assert.equal(result.statusCode, 401);
    assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(result.headers.location, undefined);
    assert.deepEqual(f.failures, ['FINAL_COMMIT_REJECTED']);
    assert.equal(
      (await f.current(prior.session)).statusCode,
      retirement === 'logout' ? 401 : 200,
    );
  });
}

test('logout requires current CSRF, immediately revokes cached contexts, and is successful after self-revocation', async (t) => {
  const f = await fixture(t);
  const session = await f.signIn();
  const context = f.login.policy.authenticate(
    readHeaders(session.session),
    'read',
    { surface: 'http', method: 'GET' },
  );
  assert.equal(
    (await f.write('/auth/logout', session.session)).statusCode,
    403,
  );
  assert.equal((await f.current(session.session)).statusCode, 200);
  const logout = await f.write('/auth/logout', session.session, session.csrf);
  assert.equal(logout.statusCode, 200);
  assert.deepEqual(logout.json(), { ok: true });
  assert.equal((await f.current(session.session)).statusCode, 401);
  assert.throws(() => f.login.policy.revalidate(context), /UNAUTHORIZED/);
  assert.equal(
    (await f.write('/auth/logout', session.session, session.csrf)).statusCode,
    401,
  );
});

test('malformed login cookies and logout bodies reject without changing current authority', async (t) => {
  const f = await fixture(t);
  const session = await f.signIn();
  for (const cookies of [
    `${session.session}; ${GOOGLE_LOGIN_COOKIE}=bad`,
    `${session.session}; ${session.flow.cookie}; ${session.flow.cookie}`,
  ])
    assert.equal(
      (await f.write('/auth/logout', cookies, session.csrf)).statusCode,
      403,
    );
  assert.equal(
    (await f.write('/auth/logout', session.session, session.csrf, { email }))
      .statusCode,
    403,
  );
  assert.equal((await f.current(session.session)).statusCode, 200);
});

test('successful login rotates prior session, CSRF and binding without requiring old Strict cookie on callback', async (t) => {
  const f = await fixture(t);
  const first = await f.signIn();
  const second = await f.signIn(first.session);
  assert.notEqual(first.session, second.session);
  assert.notEqual(first.csrf, second.csrf);
  assert.equal(first.principal, second.principal);
  assert.equal((await f.current(first.session)).statusCode, 401);
  assert.equal((await f.current(second.session)).statusCode, 200);
});

test('provider failure and duplicate/malicious callback fields never expose provider error or allow replay', async (t) => {
  const f = await fixture(t);
  const flow = await f.start();
  assert.equal(
    (await f.callback(flow, flow.cookie, '&code=another')).statusCode,
    401,
  );
  assert.equal((await f.callback(flow)).statusCode, 401);
  assert.equal(f.tokenRequests, 0);
  const retry = await f.start();
  f.failProvider();
  const result = await f.callback(retry);
  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.json(), { error: 'LOGIN_FAILED' });
  assert.equal((await f.callback(retry)).statusCode, 401);
  assert.equal(f.tokenRequests, 1);
});

test('read-only polling cannot extend idle expiry; explicit CSRF renewal respects absolute expiry', async (t) => {
  const f = await fixture(t, { idleTimeoutMs: 2000, absoluteTimeoutMs: 5000 });
  const session = await f.signIn();
  f.setNow(f.now + 1000);
  const read = await f.current(session.session);
  assert.equal(read.json().deadline, session.deadline);
  assert.equal(
    (
      await f.write(
        '/auth/session/renew?untrusted=1',
        session.session,
        session.csrf,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.write('/auth/session/renew', session.session, session.csrf, {
        email,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await f.write('/auth/session/renew', session.session, session.csrf))
      .statusCode,
    200,
  );
  assert.equal(
    (await f.current(session.session)).json().deadline,
    session.deadline + 1000,
  );
  f.setNow(f.now + 1000);
  assert.equal(
    (await f.write('/auth/session/renew', session.session, session.csrf))
      .statusCode,
    200,
  );
  f.setNow(f.now + 1000);
  assert.equal(
    (await f.write('/auth/session/renew', session.session, session.csrf))
      .statusCode,
    200,
  );
  f.setNow(f.now + 2000);
  assert.equal((await f.current(session.session)).statusCode, 401);
  assert.equal(
    (await f.write('/auth/session/renew', session.session, session.csrf))
      .statusCode,
    401,
  );
});

test('another registry or restart cannot resolve old opaque cookies and fabricated prepared objects fail', async (t) => {
  const f = await fixture(t);
  const session = await f.signIn();
  const other = await fixture(t);
  assert.equal((await other.current(session.session)).statusCode, 401);
  assert.throws(
    () =>
      f.login.commitPrepared(
        { sessionCookie: session.session },
        {} as never,
        {} as never,
      ),
    /LOGIN_FAILED/,
  );
  f.login.close();
  assert.equal((await f.current(session.session)).statusCode, 401);
});

test('expired pending flows are bounded without making any provider request', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 32; index += 1) await f.start();
  const denied = await f.app.inject({
    method: 'POST',
    url: '/auth/google/start',
    headers: writeHeaders(),
    payload: {},
    remoteAddress: '127.0.0.1',
  });
  assert.equal(denied.statusCode, 503);
  assert.equal(f.tokenRequests, 0);
  f.setNow(f.now + 300001);
  await f.start();
});

test('failure diagnostics distinguish callback input, missing binding, missing flow and expired flow before exchange', async (t) => {
  for (const scenario of [
    'input',
    'binding',
    'flow',
    'expired',
    'wrong-browser',
  ] as const) {
    const f = await fixture(t);
    const flow = await f.start();
    let result;
    let expected: GoogleLoginFailureReason;
    if (scenario === 'input') {
      result = await f.callback({ ...flow, state: 'sensitive-state-canary' });
      expected = 'CALLBACK_INPUT_REJECTED';
    } else if (scenario === 'binding') {
      result = await f.callback(flow, '');
      expected = 'BINDING_MISSING';
    } else if (scenario === 'flow') {
      result = await f.callback({ ...flow, state: 'A'.repeat(43) });
      expected = 'FLOW_MISSING';
    } else {
      if (scenario === 'expired') f.setNow(f.now + 300001);
      const browser =
        scenario === 'wrong-browser' ? (await f.start()).cookie : flow.cookie;
      result = await f.callback(flow, browser);
      expected = 'FLOW_INVALID_OR_EXPIRED';
    }
    assert.equal(result.statusCode, 401, scenario);
    assert.deepEqual(result.json(), { error: 'LOGIN_FAILED' });
    assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(f.tokenRequests, 0);
    assert.deepEqual(f.failures, [expected]);
    assert.doesNotMatch(JSON.stringify(f.failures), /sensitive-state-canary/);
  }
});

test('unknown iss or session_state and duplicate callback parameters still fail before any exchange', async (t) => {
  const canary = 'synthetic-private-query-canary';
  for (const extra of [
    `&iss=${canary}`,
    `&session_state=${canary}`,
    `&code=${canary}`,
    `&scope=openid&scope=${canary}`,
    `&authuser=0&authuser=${canary}`,
    `&error=${canary}`,
    `&unexpected_${canary}=anything`,
  ]) {
    const f = await fixture(t);
    const flow = await f.start();
    const result = await f.callback(flow, flow.cookie, extra);
    assert.equal(result.statusCode, 401);
    assert.deepEqual(result.json(), { error: 'LOGIN_FAILED' });
    assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(f.tokenRequests, 0);
    assert.deepEqual(f.failures, ['CALLBACK_PARAMS_REJECTED']);
    for (const sensitive of [
      canary,
      flow.code,
      flow.state,
      flow.nonce,
      flow.cookie,
      origin,
    ])
      assert.equal(JSON.stringify(f.failures).includes(sensitive), false);
  }
});

test('provider, token and identity failures report only existing fixed OIDC reasons', async (t) => {
  for (const failure of ['provider', 'token', 'identity'] as const) {
    const f = await fixture(t);
    const flow = await f.start();
    if (failure === 'provider') f.failProvider();
    if (failure === 'token') f.claims.aud = 'sensitive-audience-canary';
    if (failure === 'identity') {
      f.claims.email = 'sensitive-owner-canary@example.test';
      f.claims.sub = 'sensitive-subject-canary';
      f.claims.hd = 'sensitive-domain-canary.example.test';
    }
    const result = await f.callback(flow);
    assert.equal(result.statusCode, 401);
    assert.deepEqual(result.json(), { error: 'LOGIN_FAILED' });
    assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(f.tokenRequests, 1);
    const expected = {
      provider: 'GOOGLE_PROVIDER_UNAVAILABLE',
      token: 'GOOGLE_TOKEN_INVALID',
      identity: 'GOOGLE_IDENTITY_REJECTED',
    }[failure];
    assert.deepEqual(f.failures, [expected]);
    for (const sensitive of [
      flow.code,
      flow.state,
      flow.nonce,
      flow.cookie,
      origin,
      email,
      domain,
      'sensitive-audience-canary',
      'sensitive-owner-canary@example.test',
      'sensitive-subject-canary',
      'sensitive-domain-canary.example.test',
      'offline provider unavailable; never expose this detail',
      'offline-unused-access-token',
      'offline-not-a-secret',
    ])
      assert.equal(JSON.stringify(f.failures).includes(sensitive), false);
  }
});

test('bounded simultaneous exchanges report GOOGLE_AUTH_BUSY without another token request', async (t) => {
  const f = await fixture(t);
  const flows: Flow[] = [];
  for (let index = 0; index < 5; index += 1) flows.push(await f.start());
  const gate = f.blockToken();
  const inFlight = flows
    .slice(0, 4)
    .map((flow) => f.callback(flow).then((result) => result));
  try {
    await f.waitForTokenCount(4);
    const result = await f.callback(flows[4]);
    assert.equal(result.statusCode, 401);
    assert.deepEqual(result.json(), { error: 'LOGIN_FAILED' });
    assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(f.tokenRequests, 4);
    assert.deepEqual(f.failures, ['GOOGLE_AUTH_BUSY']);
  } finally {
    gate.release();
    const completed = await Promise.all(inFlight);
    for (const result of completed) assert.equal(result.statusCode, 200);
  }
});

for (const failure of ['throws', 'rejects'] as const) {
  test(`a diagnostic observer that ${failure} cannot change the failure response or emit an unhandled rejection`, async (t) => {
    const observed: unknown[][] = [];
    const f = await fixture(t, {
      onFailure: (...arguments_) => {
        observed.push(arguments_);
        const error = new Error('sensitive-observer-error-canary');
        if (failure === 'throws') throw error;
        return Promise.reject(error);
      },
    });
    const result = await f.app.inject({
      method: 'GET',
      url: '/auth/google/callback?code=synthetic-private-code-canary',
      headers: callbackHeaders(''),
      remoteAddress: '127.0.0.1',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(result.statusCode, 401);
    assert.deepEqual(result.json(), { error: 'LOGIN_FAILED' });
    assert.equal(result.headers['set-cookie'], undefined);
    assert.deepEqual(observed, [['CALLBACK_INPUT_REJECTED']]);
    assert.equal(f.tokenRequests, 0);
    await f.signIn();
    assert.deepEqual(
      observed,
      [['CALLBACK_INPUT_REJECTED']],
      'Successful login does not invoke the observer',
    );
  });
}

test('runtime-invalid diagnostic reasons cannot pass arbitrary strings or objects to the observer', async (t) => {
  const f = await fixture(t);
  for (const value of [
    'sensitive-non-enum-canary',
    new Error('sensitive-error-canary'),
    { reason: 'GOOGLE_TOKEN_INVALID', token: 'sensitive-token-canary' },
    undefined,
    null,
    ['CALLBACK_INPUT_REJECTED'],
  ])
    f.login.reportFailure(value as unknown as GoogleLoginFailureReason);
  assert.deepEqual(f.failures, []);
  f.login.reportFailure('GOOGLE_TOKEN_INVALID');
  assert.deepEqual(f.failures, ['GOOGLE_TOKEN_INVALID']);
});
