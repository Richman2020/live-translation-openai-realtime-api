import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { ReadableStream } from 'node:stream/web';
import { test } from 'node:test';
import {
  GOOGLE_OIDC,
  GoogleOidcClient,
  GoogleOidcError,
} from '../src/solo/google-oidc';

// Generated synthetic keys and provider transport are test-only. No Google
// endpoint, real client, account, credentials, grant or telephone is contacted.
const keyA = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyB = generateKeyPairSync('rsa', { modulusLength: 2048 });
const weakKey = generateKeyPairSync('rsa', { modulusLength: 1024 });
const clientId = 'synthetic-google-client';
const clientSecret = 'synthetic-client-secret';
const redirectUri = 'https://phone.example.test/auth/google/callback';
const allowedEmail = 'synthetic@workspace.example.test';
const expectedHostedDomain = 'workspace.example.test';
const subject = 'google-synthetic-subject';
const nonce = Buffer.alloc(32, 1).toString('base64url');
const state = Buffer.alloc(32, 2).toString('base64url');
const codeVerifier = Buffer.alloc(32, 3).toString('base64url');
const codeChallenge = createHash('sha256')
  .update(codeVerifier)
  .digest('base64url');
const start = 1_780_000_000_000;

function publicJwk(key = keyA.publicKey, kid = 'synthetic-key-a') {
  return {
    ...key.export({ format: 'jwk' }),
    kid,
    alg: 'RS256',
    use: 'sig',
  };
}
function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: GOOGLE_OIDC.issuer,
    aud: clientId,
    azp: clientId,
    sub: subject,
    email: allowedEmail,
    email_verified: true,
    hd: expectedHostedDomain,
    iat: start / 1000,
    exp: start / 1000 + 3600,
    nonce,
    ...overrides,
  };
}
function jwt(
  payload: Record<string, unknown> | string = claims(),
  header: Record<string, unknown> | string = {
    alg: 'RS256',
    kid: 'synthetic-key-a',
    typ: 'JWT',
  },
  key: KeyObject = keyA.privateKey,
) {
  const encoded = [header, payload].map((value) =>
    Buffer.from(
      typeof value === 'string' ? value : JSON.stringify(value),
    ).toString('base64url'),
  );
  const message = encoded.join('.');
  return `${message}.${sign('RSA-SHA256', Buffer.from(message), key).toString('base64url')}`;
}
function response(
  value: unknown,
  headers: Record<string, string> = {},
  status = 200,
) {
  return new Response(
    typeof value === 'string' ? value : JSON.stringify(value),
    {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    },
  );
}
function fixture(
  overrides: Partial<ConstructorParameters<typeof GoogleOidcClient>[0]> = {},
) {
  let now = start;
  const requests: { url: string; init: RequestInit }[] = [];
  let jwks = { keys: [publicJwk()] } as unknown;
  let cacheControl = 'public, max-age=3600';
  let provider:
    | ((url: string, init: RequestInit) => Promise<Response>)
    | undefined;
  let token = jwt();
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.ok(
      url === GOOGLE_OIDC.tokenEndpoint || url === GOOGLE_OIDC.jwksUri,
      'fake transport refuses every unpinned endpoint',
    );
    requests.push({ url, init: init! });
    if (provider) return provider(url, init!);
    if (url === GOOGLE_OIDC.jwksUri)
      return response(jwks, { 'cache-control': cacheControl });
    return response({
      access_token: 'synthetic-access-token-unused',
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: token,
      scope: 'openid email',
    });
  };
  const client: GoogleOidcClient = new GoogleOidcClient({
    clientId,
    clientSecret,
    redirectUri,
    allowedEmail,
    expectedHostedDomain,
    fetch: fakeFetch,
    now: () => now,
    ...overrides,
  });
  return {
    client,
    requests,
    advance(value: number) {
      now = value;
    },
    jwks(value: unknown, cache = cacheControl) {
      jwks = value;
      cacheControl = cache;
    },
    token(value: string) {
      token = value;
    },
    provider(value: typeof provider) {
      provider = value;
    },
  };
}
function errorCode(code: GoogleOidcError['code']) {
  return (error: unknown) => {
    assert.ok(error instanceof GoogleOidcError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    assert.ok(!error.stack?.includes(clientSecret));
    assert.ok(!error.stack?.includes(allowedEmail));
    return true;
  };
}
function exchange(client: GoogleOidcClient) {
  return client.exchangeCode({ code: 'synthetic-code', codeVerifier, nonce });
}

test('authorization URL fixes Google, code flow, minimum scopes and S256 without offline grants', () => {
  const f = fixture();
  const url = new URL(
    f.client.authorizationUrl({ state, nonce, codeChallenge }),
  );
  assert.equal(url.origin + url.pathname, GOOGLE_OIDC.authorizationEndpoint);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: 'openid email',
    access_type: 'online',
    include_granted_scopes: 'false',
    prompt: 'select_account',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  assert.equal(url.searchParams.has('login_hint'), false);
  assert.equal(url.href.includes(clientSecret), false);
  assert.equal(url.href.includes(allowedEmail), false);
  assert.equal(f.requests.length, 0);
  for (const input of [
    { state: 'short', nonce, codeChallenge },
    { state, nonce: `${nonce}=`, codeChallenge },
    { state, nonce, codeChallenge: 'x'.repeat(43) },
  ])
    assert.throws(
      () => f.client.authorizationUrl(input),
      errorCode('GOOGLE_TOKEN_INVALID'),
    );
});

test('configuration requires fixed canonical HTTPS callback and explicit authoritative account policy', () => {
  for (const overrides of [
    { redirectUri: 'http://phone.example.test/auth/google/callback' },
    { redirectUri: `${redirectUri}?untrusted=1` },
    { redirectUri: `${redirectUri}#untrusted` },
    {
      redirectUri:
        'https://user:secret@phone.example.test/auth/google/callback',
    },
    { redirectUri: 'https://PHONE.example.test/auth/google/callback' },
    { clientId: 'client with whitespace' },
    { clientSecret: '' },
    { allowedEmail: 'bad email' },
    { expectedHostedDomain: undefined },
    { expectedHostedDomain: 'WORKSPACE.example.test' },
    { expectedHostedDomain: 'workspace.example.test.evil/' },
    { pinnedGoogleSubject: '' },
    { requestTimeoutMs: 5001 },
    { requestTimeoutMs: 0 },
  ])
    assert.throws(
      () => fixture(overrides),
      errorCode('GOOGLE_OIDC_CONFIG_INVALID'),
    );
});

test('code exchange sends fixed credentials/callback/PKCE only and returns original verified identity', async () => {
  const f: ReturnType<typeof fixture> = fixture();
  const result = await exchange(f.client);
  assert.deepEqual(result, {
    issuer: GOOGLE_OIDC.issuer,
    subject,
    email: allowedEmail,
    emailVerified: true,
    issuedAt: start,
    expiresAt: start + 3_600_000,
  });
  assert.ok(Object.isFrozen(result));
  const verifiedClient: GoogleOidcClient = f.client;
  verifiedClient.assertVerifiedIdentity(result);
  assert.throws(
    () => f.client.assertVerifiedIdentity({ ...result }),
    errorCode('GOOGLE_TOKEN_INVALID'),
  );
  assert.throws(
    () => fixture().client.assertVerifiedIdentity(result),
    errorCode('GOOGLE_TOKEN_INVALID'),
  );
  assert.equal(f.requests.length, 2);
  const tokenRequest = f.requests[0];
  assert.equal(tokenRequest.url, GOOGLE_OIDC.tokenEndpoint);
  assert.equal(tokenRequest.init.method, 'POST');
  assert.equal(tokenRequest.init.redirect, 'error');
  assert.equal(tokenRequest.init.credentials, 'omit');
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(String(tokenRequest.init.body))),
    {
      grant_type: 'authorization_code',
      code: 'synthetic-code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    },
  );
  assert.deepEqual(Object.keys(result), [
    'issuer',
    'subject',
    'email',
    'emailVerified',
    'issuedAt',
    'expiresAt',
  ]);
  f.advance(start + 3_600_000);
  assert.throws(
    () => f.client.assertVerifiedIdentity(result),
    errorCode('GOOGLE_TOKEN_INVALID'),
  );
});

test('invalid code, nonce and PKCE inputs never reach the token provider', async () => {
  const f = fixture();
  for (const input of [
    { code: '', codeVerifier, nonce },
    { code: 'contains newline\n', codeVerifier, nonce },
    { code: 'x'.repeat(2049), codeVerifier, nonce },
    { code: 'synthetic-code', codeVerifier: 'short', nonce },
    { code: 'synthetic-code', codeVerifier: `${codeVerifier}=`, nonce },
    { code: 'synthetic-code', codeVerifier, nonce: state.slice(0, -1) },
  ])
    await assert.rejects(
      f.client.exchangeCode(input),
      errorCode('GOOGLE_TOKEN_INVALID'),
    );
  assert.equal(f.requests.length, 0);
});

test('both official issuer spellings normalize, single array audience and optional azp are accepted', async () => {
  const f = fixture();
  for (const overrides of [
    { iss: 'accounts.google.com' },
    { aud: [clientId] },
    { azp: undefined },
    { email: allowedEmail.toUpperCase() },
  ]) {
    const identity = await f.client.verifyIdToken(
      jwt(claims(overrides)),
      nonce,
    );
    assert.equal(identity.issuer, GOOGLE_OIDC.issuer);
    assert.equal(identity.email, allowedEmail);
    assert.equal(identity.subject, subject);
  }
  assert.equal(f.requests.length, 1);
});

test('issuer, audience, authorized party and subject confusion fail before key lookup', async () => {
  const f = fixture();
  for (const overrides of [
    { iss: 'https://accounts.google.com.evil.test' },
    { iss: 'https://accounts.google.com/' },
    { iss: null },
    { aud: 'other-client' },
    { aud: [clientId, 'other-client'] },
    { aud: [clientId, clientId] },
    { aud: [] },
    { aud: 1 },
    { azp: 'other-client' },
    { azp: null },
    { sub: '' },
    { sub: 'x'.repeat(256) },
    { sub: 'has spaces' },
    { sub: 1 },
  ])
    await assert.rejects(
      f.client.verifyIdToken(jwt(claims(overrides)), nonce),
      errorCode('GOOGLE_TOKEN_INVALID'),
    );
  assert.equal(f.requests.length, 0);
});

test('strict verified email plus exact signed Workspace domain are required', async () => {
  const f = fixture();
  for (const overrides of [
    { email_verified: false },
    { email_verified: 'true' },
    { email_verified: 1 },
    { email_verified: undefined },
    { email: 'other@workspace.example.test' },
    { email: 'synthetic@workspace.example.test.evil' },
    { email: null },
    { hd: undefined },
    { hd: 'other.example.test' },
    { hd: 'WORKSPACE.example.test' },
  ])
    await assert.rejects(
      f.client.verifyIdToken(jwt(claims(overrides)), nonce),
      errorCode('GOOGLE_IDENTITY_REJECTED'),
    );
  assert.equal(f.requests.length, 0);
});

test('third-party email requires independently configured sub pin or Workspace authority', async () => {
  const f = fixture({
    expectedHostedDomain: undefined,
    pinnedGoogleSubject: subject,
  });
  const result = await f.client.verifyIdToken(
    jwt(claims({ hd: undefined })),
    nonce,
  );
  assert.equal(result.subject, subject);
  await assert.rejects(
    f.client.verifyIdToken(jwt(claims({ sub: 'different-subject' })), nonce),
    errorCode('GOOGLE_IDENTITY_REJECTED'),
  );
  const both = fixture({ pinnedGoogleSubject: subject });
  await assert.rejects(
    both.client.verifyIdToken(jwt(claims({ hd: undefined })), nonce),
    errorCode('GOOGLE_IDENTITY_REJECTED'),
  );
});

test('Google-authoritative Gmail still requires exact allowed verified account', async () => {
  const f = fixture({
    allowedEmail: 'synthetic@gmail.com',
    expectedHostedDomain: undefined,
  });
  const identity = await f.client.verifyIdToken(
    jwt(claims({ email: 'synthetic@gmail.com', hd: undefined })),
    nonce,
  );
  assert.equal(identity.email, 'synthetic@gmail.com');
  await assert.rejects(
    f.client.verifyIdToken(
      jwt(claims({ email: 'synthetic@gmail.com', email_verified: false })),
      nonce,
    ),
    errorCode('GOOGLE_IDENTITY_REJECTED'),
  );
});

test('time claims, fresh login age, lifetime, not-before and nonce are checked strictly', async () => {
  const f = fixture();
  for (const overrides of [
    { exp: start / 1000 },
    { exp: start / 1000 - 1 },
    { exp: '9999999999' },
    { exp: 999999999999999 },
    { exp: start / 1000 + 3600.5 },
    { exp: start / 1000 + 7201 },
    { iat: start / 1000 + 31 },
    { iat: start / 1000 - 601 },
    { iat: start / 1000 + 0.5 },
    { iat: '1780000000' },
    { iat: -1 },
    { iat: start / 1000 + 3600 },
    { nbf: start / 1000 + 1 },
    { nbf: '1780000000' },
    { nonce: state },
    { nonce: `${nonce}=` },
    { nonce: undefined },
  ])
    await assert.rejects(
      f.client.verifyIdToken(jwt(claims(overrides)), nonce),
      errorCode('GOOGLE_TOKEN_INVALID'),
    );
  assert.equal(f.requests.length, 0);
  await f.client.verifyIdToken(
    jwt(claims({ iat: start / 1000 + 30, nbf: start / 1000 })),
    nonce,
  );
});

test('only RS256 and local cached kid are considered, JOSE key URL extensions are rejected', async () => {
  const f = fixture();
  for (const header of [
    { alg: 'none', kid: 'synthetic-key-a' },
    { alg: 'HS256', kid: 'synthetic-key-a' },
    { alg: 'ES256', kid: 'synthetic-key-a' },
    { alg: 'RS256' },
    { alg: 'RS256', kid: '../../escape' },
    { alg: 'RS256', kid: 'synthetic-key-a', typ: 'other' },
    { alg: 'RS256', kid: 'synthetic-key-a', jku: 'https://evil.test/keys' },
    { alg: 'RS256', kid: 'synthetic-key-a', x5u: 'https://evil.test/cert' },
    { alg: 'RS256', kid: 'synthetic-key-a', jwk: publicJwk() },
    { alg: 'RS256', kid: 'synthetic-key-a', crit: ['unknown'] },
    { alg: 'RS256', kid: 'synthetic-key-a', b64: false },
  ])
    await assert.rejects(
      f.client.verifyIdToken(jwt(claims(), header), nonce),
      errorCode('GOOGLE_TOKEN_INVALID'),
    );
  assert.equal(f.requests.length, 0);
});

test('JOSE rejects malformed framing, UTF-8, canonical base64url and oversized tokens', async () => {
  const f = fixture();
  const good = jwt();
  const parts = good.split('.');
  for (const token of [
    '',
    'a.b',
    `${good}.extra`,
    `${parts[0]}=.${parts[1]}.${parts[2]}`,
    `${parts[0]}.${parts[1]}.${parts[2]}=`,
    `${parts[0]}.${parts[1]}.short`,
    `${Buffer.from([0xff, 0xff]).toString('base64url')}.${parts[1]}.${parts[2]}`,
    jwt('[]'),
    jwt('null'),
    jwt('{"iss": "unterminated}'),
    jwt(claims(), '{"alg": "RS256",}'),
    'x'.repeat(16 * 1024 + 1),
  ])
    await assert.rejects(
      f.client.verifyIdToken(token, nonce),
      errorCode('GOOGLE_TOKEN_INVALID'),
    );
  assert.equal(f.requests.length, 0);
});

test('duplicate decoded JSON keys and excessive nesting cannot change security claims', async () => {
  const f = fixture();
  const payload = JSON.stringify(claims());
  for (const token of [
    jwt(payload.replace('"aud":', '"aud":"other-client","aud":')),
    jwt(payload.replace('"aud":', '"a\\u0075d":"other-client","aud":')),
    jwt(
      payload.replace(
        '"email_verified":',
        '"email_verified":false,"email_verified":',
      ),
    ),
    jwt(claims(), '{"alg":"none","alg":"RS256","kid":"synthetic-key-a"}'),
    jwt(
      claims({
        unknown: { a: { a: { a: { a: { a: { a: { a: { a: {} } } } } } } } },
      }),
    ),
  ])
    await assert.rejects(
      f.client.verifyIdToken(token, nonce),
      errorCode('GOOGLE_TOKEN_INVALID'),
    );
  assert.equal(f.requests.length, 0);
});

test('signature tampering and a different signing key with the same kid are denied', async () => {
  const f = fixture();
  const parts = jwt().split('.');
  const signature = Buffer.from(parts[2], 'base64url');
  signature[0] ^= 1;
  for (const token of [
    `${parts[0]}.${parts[1]}.${signature.toString('base64url')}`,
    jwt(claims(), undefined, keyB.privateKey),
  ])
    await assert.rejects(
      f.client.verifyIdToken(token, nonce),
      errorCode('GOOGLE_TOKEN_INVALID'),
    );
  assert.equal(f.requests.length, 1);
});

test('untrusted JWKS key material, duplicate kids and private/URL fields fail closed', async () => {
  for (const keys of [
    [],
    [publicJwk(), publicJwk()],
    Array.from({ length: 9 }, (_, index) =>
      publicJwk(keyA.publicKey, `key-${index}`),
    ),
    [{ ...publicJwk(), alg: 'HS256' }],
    [{ ...publicJwk(), use: 'enc' }],
    [{ ...publicJwk(), kty: 'EC' }],
    [{ ...publicJwk(), e: 'Aw' }],
    [{ ...publicJwk(), n: `${publicJwk().n}=` }],
    [{ ...publicJwk(), d: 'private-material' }],
    [{ ...publicJwk(), x5u: 'https://evil.test/cert' }],
    [{ ...publicJwk(), key_ops: ['sign', 'verify'] }],
    [publicJwk(weakKey.publicKey)],
  ]) {
    const f = fixture();
    f.jwks({ keys });
    await assert.rejects(
      f.client.verifyIdToken(jwt(), nonce),
      errorCode('GOOGLE_PROVIDER_UNAVAILABLE'),
    );
    assert.equal(f.requests.length, 1);
  }
});

test('JWKS refresh single-flights, honors cache and throttles attacker-selected unknown kids', async () => {
  const f = fixture();
  await Promise.all(
    Array.from({ length: 4 }, () => f.client.verifyIdToken(jwt(), nonce)),
  );
  assert.equal(f.requests.length, 1);
  await f.client.verifyIdToken(jwt(), nonce);
  assert.equal(f.requests.length, 1);
  const unknown = jwt(
    claims(),
    { alg: 'RS256', kid: 'synthetic-key-b' },
    keyB.privateKey,
  );
  await assert.rejects(
    f.client.verifyIdToken(unknown, nonce),
    errorCode('GOOGLE_TOKEN_INVALID'),
  );
  assert.equal(f.requests.length, 1);
  f.advance(start + 30_000);
  f.jwks({ keys: [publicJwk(keyB.publicKey, 'synthetic-key-b')] });
  await f.client.verifyIdToken(unknown, nonce);
  assert.equal(f.requests.length, 2);
  await assert.rejects(
    f.client.verifyIdToken(jwt(), nonce),
    errorCode('GOOGLE_TOKEN_INVALID'),
  );
  assert.equal(f.requests.length, 2);
});

test('expired JWKS does not fall back to old keys after a failed refresh', async () => {
  const f = fixture();
  f.jwks({ keys: [publicJwk()] }, 'max-age=30');
  await f.client.verifyIdToken(jwt(), nonce);
  f.advance(start + 30_000);
  f.provider(async () => response({ secret: clientSecret }, {}, 503));
  await assert.rejects(
    f.client.verifyIdToken(jwt(), nonce),
    errorCode('GOOGLE_PROVIDER_UNAVAILABLE'),
  );
  await assert.rejects(
    f.client.verifyIdToken(jwt(), nonce),
    errorCode('GOOGLE_TOKEN_INVALID'),
  );
  assert.equal(f.requests.length, 2);
});

test('zero-age keys serve only their fresh request and cannot be reused during cooldown', async () => {
  const f = fixture();
  f.jwks({ keys: [publicJwk()] }, 'max-age=0');
  await f.client.verifyIdToken(jwt(), nonce);
  await assert.rejects(
    f.client.verifyIdToken(jwt(), nonce),
    errorCode('GOOGLE_TOKEN_INVALID'),
  );
  assert.equal(f.requests.length, 1);
});

test('token that expires during asynchronous JWKS fetching never produces verified identity', async () => {
  const f = fixture();
  f.provider(async () => {
    f.advance(start + 1000);
    return response({ keys: [publicJwk()] });
  });
  await assert.rejects(
    f.client.verifyIdToken(jwt(claims({ exp: start / 1000 + 1 })), nonce),
    errorCode('GOOGLE_TOKEN_INVALID'),
  );
});

test('token response refuses extra scopes or refresh tokens and never returns provider secrets', async () => {
  for (const patch of [
    { refresh_token: 'synthetic-refresh-not-permitted' },
    { scope: 'openid email profile' },
    { scope: 'openid https://www.googleapis.com/auth/drive' },
    { scope: 'email' },
    { token_type: 'other' },
    { access_token: '' },
    { expires_in: '3600' },
    { expires_in: 0 },
    { id_token: null },
  ]) {
    const f = fixture();
    f.provider(async () =>
      response({
        id_token: jwt(),
        access_token: 'unused-synthetic',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid email',
        ...patch,
      }),
    );
    await assert.rejects(exchange(f.client), errorCode('GOOGLE_TOKEN_INVALID'));
    assert.equal(f.requests.length, 1);
  }
});

test('token response accepts the official email scope alias without requesting profile', async () => {
  const f = fixture();
  f.provider(async (url) =>
    url === GOOGLE_OIDC.jwksUri
      ? response({ keys: [publicJwk()] })
      : response({
          id_token: jwt(),
          access_token: 'unused-synthetic',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid https://www.googleapis.com/auth/userinfo.email',
        }),
  );
  const identity = await exchange(f.client);
  assert.equal(identity.subject, subject);
});

test('request rejects redirects, non-JSON, malformed or duplicate JSON and excessive declared/streamed bodies', async () => {
  for (const result of [
    response({}, { location: 'https://evil.test/provider' }, 302),
    response('<html>secret</html>', { 'content-type': 'text/html' }),
    response('{"keys":[],"keys":[]}'),
    response('{broken}'),
    response('{}', { 'content-length': String(64 * 1024 + 1) }),
    response('{}', { 'content-length': 'invalid' }),
    response('x'.repeat(64 * 1024 + 1)),
  ]) {
    const f = fixture();
    f.provider(async () => result);
    await assert.rejects(
      f.client.verifyIdToken(jwt(), nonce),
      errorCode('GOOGLE_PROVIDER_UNAVAILABLE'),
    );
    assert.equal(f.requests.length, 1);
  }
});

test('fetch and body-read deadline aborts and frees authentication slots without depending on provider cooperation', async () => {
  const f = fixture({ requestTimeoutMs: 20 });
  f.provider(async () => new Promise<Response>(() => undefined));
  const pending = Array.from({ length: 4 }, () => exchange(f.client));
  await assert.rejects(exchange(f.client), errorCode('GOOGLE_AUTH_BUSY'));
  await Promise.all(
    pending.map((promise) =>
      assert.rejects(promise, errorCode('GOOGLE_PROVIDER_UNAVAILABLE')),
    ),
  );
  assert.ok(f.requests.every(({ init }) => init.signal?.aborted));
  let canceled = false;
  f.provider(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from('{'));
          },
          cancel() {
            canceled = true;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  await assert.rejects(
    exchange(f.client),
    errorCode('GOOGLE_PROVIDER_UNAVAILABLE'),
  );
  assert.equal(canceled, true);
});

test('provider failures carry only a stable public error and never secret response details', async () => {
  const f = fixture();
  f.provider(async () => {
    throw new Error(`${clientSecret} ${allowedEmail} raw-id-token`);
  });
  await assert.rejects(
    exchange(f.client),
    errorCode('GOOGLE_PROVIDER_UNAVAILABLE'),
  );
});
