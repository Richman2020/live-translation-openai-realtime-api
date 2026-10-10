import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type OutgoingHttpHeaders,
} from 'node:http';
import { createConnection, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import twilio from 'twilio';
import WebSocket from 'ws';

import { CLOUD_SESSION_COOKIE } from '../src/solo/cloud-access';
import { CloudPhoneAccess } from '../src/solo/cloud-phone-access';
import { createCloudIngress } from '../src/solo/cloud-ingress';
import {
  parsePhoneRuntime,
  type CloudPhoneRuntime,
} from '../src/solo/cloud-runtime';
import { ConfigStore, type SoloConfig } from '../src/solo/config';
import { CloudControllerLeases } from '../src/solo/controller-lease';
import { GoogleBrowserLogin } from '../src/solo/google-login';
import { GOOGLE_OIDC, GoogleOidcClient } from '../src/solo/google-oidc';
import {
  buildCloudControlledServer,
  buildSoloServer,
} from '../src/solo/server';
import { SessionManager } from '../src/solo/session-manager';

const origin = 'https://phone.example.test';
const runtime = parsePhoneRuntime({
  AI_PHONE_RUNTIME_MODE: 'cloud',
  PORT: '8080',
  CLOUD_PUBLIC_ORIGIN: origin,
  CLOUD_WARM_INSTANCES: '1',
}) as CloudPhoneRuntime;
const config: SoloConfig = {
  API_HOST: '127.0.0.1',
  API_PORT: '5050',
  PUBLIC_BASE_URL: origin,
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'b'.repeat(32),
  TWILIO_API_KEY_SID: `SK${'c'.repeat(32)}`,
  TWILIO_API_KEY_SECRET: 'd'.repeat(32),
  TWILIO_TWIML_APP_SID: `AP${'e'.repeat(32)}`,
  TWILIO_CALLER_NUMBER: '+12125550123',
  OPENAI_API_KEY: `sk-offline-${'f'.repeat(32)}`,
  OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
  OPENAI_TRANSCRIPTION_MODEL: 'gpt-4o-transcribe',
  OPENAI_PROXY_URL: '',
  LOCAL_ACCESS_TOKEN: '',
};
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...pair.publicKey.export({ format: 'jwk' }),
  kid: 'offline-ingress',
  alg: 'RS256',
  use: 'sig',
};
const nativeRead = {
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
};
const nativeWrite = { ...nativeRead, origin };
type HttpResult = {
  status: number;
  headers: import('node:http').IncomingHttpHeaders;
  body: string;
  json(): any;
};

function send(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: OutgoingHttpHeaders;
    body?: string;
  } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const body = options.body;
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method || 'GET',
        headers: Object.fromEntries(
          Object.entries({
            host: 'phone.example.test',
            'x-forwarded-proto': 'https',
            ...(body === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(body),
                }),
            ...options.headers,
          }).filter(([_name, value]) => value !== undefined),
        ),
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body: text,
            json: () => JSON.parse(text),
          });
        });
      },
    );
    request.once('error', reject);
    request.end(body);
  });
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-ingress-'));
  const store = new ConfigStore({
    envPath: join(directory, '.env'),
    values: config,
    generateToken: false,
  });
  const codes = new Map<string, string>();
  let tokenRequests = 0;
  let providerCalls = 0;
  const client = new GoogleOidcClient({
    clientId: 'offline.apps.googleusercontent.com',
    clientSecret: 'offline-not-a-secret',
    redirectUri: `${origin}/auth/google/callback`,
    allowedEmail: 'owner@workspace.example.test',
    expectedHostedDomain: 'workspace.example.test',
    fetch: async (input, init) => {
      if (String(input) === GOOGLE_OIDC.jwksUri)
        return new Response(JSON.stringify({ keys: [jwk] }), {
          headers: {
            'content-type': 'application/json',
            'cache-control': 'public,max-age=60',
          },
        });
      assert.equal(String(input), GOOGLE_OIDC.tokenEndpoint);
      tokenRequests += 1;
      const parameters = new URLSearchParams(String(init?.body));
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(
        JSON.stringify({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' }),
      ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          iss: GOOGLE_OIDC.issuer,
          sub: 'offline-ingress-owner',
          aud: 'offline.apps.googleusercontent.com',
          iat: now,
          exp: now + 300,
          nonce: codes.get(parameters.get('code')!),
          email: 'owner@workspace.example.test',
          email_verified: true,
          hd: 'workspace.example.test',
        }),
      ).toString('base64url');
      const signed = `${header}.${payload}`;
      const jwt = `${signed}.${sign('RSA-SHA256', Buffer.from(signed), pair.privateKey).toString('base64url')}`;
      return new Response(
        JSON.stringify({
          id_token: jwt,
          access_token: 'offline-unused',
          token_type: 'Bearer',
          expires_in: 300,
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const login = new GoogleBrowserLogin({ client, publicOrigin: origin });
  const manager = new SessionManager({
    providerFactory: () => ({
      create: async () => {
        providerCalls += 1;
        assert.fail('No real or fake dial is permitted before a Voice join');
      },
      hangup: async () => undefined,
    }),
    bridgeFactory: () => ({ attach() {}, close() {} }),
  });
  const leases = new CloudControllerLeases({ policy: login.policy });
  const access = new CloudPhoneAccess({
    policy: login.policy,
    manager,
    controllerLeases: leases,
    publicReadinessChecker: async () => ({
      status: 'ready',
      code: 'PUBLIC_CALLBACK_READY',
    }),
    translationReadinessChecker: async () => ({
      name: 'offline',
      status: 'passed',
      code: 'EXPLICIT_TEST_FAKE',
    }),
  });
  const options = {
    runtime,
    configStore: store,
    sessionManager: manager,
    browserControl: access,
    googleLogin: login,
  };
  const app = await buildCloudControlledServer(options);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const ingress = createCloudIngress({
    runtime,
    upstreamPort: (app.server.address() as AddressInfo).port,
  });
  await new Promise<void>((resolve, reject) => {
    ingress.server.once('error', reject);
    ingress.server.listen(0, '127.0.0.1', resolve);
  });
  const port = (ingress.server.address() as AddressInfo).port;
  t.after(async () => {
    await ingress.close();
    await app.close();
    await access.close();
    login.close();
    rmSync(directory, { recursive: true, force: true });
    assert.equal(providerCalls, 0);
  });
  const establishLogin = async () => {
    const start = await send(port, '/auth/google/start', {
      method: 'POST',
      body: '{}',
      headers: { ...nativeWrite, 'x-phone-login': 'start' },
    });
    assert.equal(start.status, 200, start.body);
    const authorize = new URL(start.json().authorizationUrl);
    const state = authorize.searchParams.get('state')!;
    const nonce = authorize.searchParams.get('nonce')!;
    const code = `offline-code-${codes.size}`;
    codes.set(code, nonce);
    const binding = start.headers['set-cookie']![0].split(';')[0];
    const callbackPath = `/auth/google/callback?state=${state}&code=${code}`;
    const callback = await send(port, callbackPath, {
      headers: {
        cookie: binding,
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    });
    assert.equal(callback.status, 200, callback.body);
    const cookie = callback.headers['set-cookie']!.find((value) =>
      value.startsWith(`${CLOUD_SESSION_COOKIE}=`),
    )!.split(';')[0];
    const bootstrap = await send(
      port,
      '/api/browser-session?tabId=offline-tab',
      { headers: { ...nativeRead, cookie } },
    );
    assert.equal(bootstrap.status, 200, bootstrap.body);
    return {
      cookie,
      csrf: bootstrap.json().csrfToken as string,
      callbackPath,
      binding,
    };
  };
  return {
    ...options,
    app,
    port,
    ingress,
    establishLogin,
    tokenRequests: () => tokenRequests,
  };
}

test('cloud builder requires real explicit dependency instances and one exact policy', async (t) => {
  const f = await fixture(t);
  for (const invalid of [
    {},
    { ...f, googleLogin: undefined },
    { ...f, browserControl: {} },
    { ...f, sessionManager: new SessionManager() },
    { ...f, runtime: { ...runtime, mode: 'local' } },
    {
      ...f,
      runtime: { ...runtime, publicOrigin: 'https://other.example.test' },
    },
    { ...f, runtime: { ...runtime, mediaOrigin: 'wss://other.example.test' } },
    { ...f, runtime: { ...runtime, warmInstances: 2 } },
  ])
    await assert.rejects(
      () => buildCloudControlledServer(invalid as any),
      /CLOUD_PHONE_DEPENDENCIES_REQUIRED/,
    );
  const otherLogin = new GoogleBrowserLogin({
    client: new GoogleOidcClient({
      clientId: 'offline.apps.googleusercontent.com',
      clientSecret: 'offline',
      redirectUri: `${origin}/auth/google/callback`,
      allowedEmail: 'owner@gmail.com',
      fetch: async () => {
        assert.fail('No external login');
      },
    }),
    publicOrigin: origin,
  });
  t.after(() => otherLogin.close());
  await assert.rejects(
    () => buildCloudControlledServer({ ...f, googleLogin: otherLogin }),
    /CLOUD_PHONE_DEPENDENCIES_REQUIRED/,
  );
});

test('cloud factory does not remove the local builders cloud guard', async (t) => {
  const f = await fixture(t);
  const store = new ConfigStore({
    envPath: join(tmpdir(), `nonexistent-cloud-guard-${process.pid}.env`),
    values: config,
    generateToken: false,
  });
  const original = process.env.AI_PHONE_RUNTIME_MODE;
  const originalPort = process.env.PORT;
  const originalOrigin = process.env.CLOUD_PUBLIC_ORIGIN;
  try {
    process.env.AI_PHONE_RUNTIME_MODE = 'cloud';
    process.env.PORT = '8080';
    process.env.CLOUD_PUBLIC_ORIGIN = origin;
    await assert.rejects(
      () =>
        buildSoloServer({
          configStore: store,
          sessionManager: f.sessionManager,
          browserControl: f.browserControl,
          googleLogin: f.googleLogin,
        }),
      /CLOUD_AUTH_NOT_IMPLEMENTED/,
    );
  } finally {
    for (const [name, value] of [
      ['AI_PHONE_RUNTIME_MODE', original],
      ['PORT', originalPort],
      ['CLOUD_PUBLIC_ORIGIN', originalOrigin],
    ])
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
});

test('internal cloud application retains actual loopback and forwarded-header rejection', async (t) => {
  const f = await fixture(t);
  for (const path of ['/controlled', '/auth/status', '/api/status']) {
    const result = await f.app.inject({
      url: path,
      remoteAddress: '203.0.113.1',
      headers: { host: 'phone.example.test', ...nativeRead },
    });
    assert.equal(result.statusCode, 403);
    const forwarded = await f.app.inject({
      url: path,
      headers: {
        host: 'phone.example.test',
        ...nativeRead,
        'x-forwarded-proto': 'https',
      },
    });
    assert.equal(forwarded.statusCode, 403);
  }
});

test('ingress rejects unpinned runtime and arbitrary or recursive upstream ports', () => {
  for (const options of [
    { runtime, upstreamPort: 0 },
    { runtime, upstreamPort: 65536 },
    { runtime, upstreamPort: runtime.port },
    { runtime: { ...runtime, host: '127.0.0.1' }, upstreamPort: 8081 },
    {
      runtime: { ...runtime, publicOrigin: 'http://phone.example.test' },
      upstreamPort: 8081,
    },
    { runtime: { ...runtime, warmInstances: 2 }, upstreamPort: 8081 },
  ])
    assert.throws(
      () => createCloudIngress(options as any),
      /INVALID_CLOUD_INGRESS/,
    );
});

test('restricted ingress serves actual controlled assets after stripping checked proxy metadata', async (t) => {
  const f = await fixture(t);
  const page = await send(f.port, '/controlled', {
    headers: {
      'x-forwarded-host': 'phone.example.test',
      'x-forwarded-for': '203.0.113.9, 2001:db8::1',
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    },
  });
  assert.equal(page.status, 200, page.body);
  assert.match(page.body, /data-phone-surface="controlled"/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(
    String(page.headers['content-security-policy']),
    /frame-ancestors 'none'/,
  );
  assert.equal((await send(f.port, '/app.js')).status, 200);
  assert.equal((await send(f.port, '/api/health')).status, 200);
  assert.equal(
    (await send(f.port, '/api/status', { headers: nativeRead })).status,
    401,
  );
});

test('ingress refuses wrong Host, insecure or ambiguous proxy assertions, and spoofed addresses', async (t) => {
  const f = await fixture(t);
  for (const headers of [
    { host: 'attacker.example.test' },
    { host: 'phone.example.test:443' },
    { 'x-forwarded-proto': 'http' },
    { 'x-forwarded-proto': 'https,http' },
    { 'x-forwarded-proto': 'HTTPS' },
    { 'x-forwarded-proto': undefined },
    { 'x-forwarded-host': 'attacker.example.test' },
    { forwarded: 'proto=https;host=phone.example.test' },
    { 'x-forwarded-for': 'attacker.example.test' },
    { 'x-forwarded-for': '203.0.113.1:1234' },
    { connection: 'close, x-phone-csrf' },
  ])
    assert.equal((await send(f.port, '/api/health', { headers })).status, 403);
});

test('Railway fixed health Host permits only the exact bodyless public probe without TLS headers', async (t) => {
  const f = await fixture(t);
  const headers = {
    host: 'healthcheck.railway.app',
    'x-forwarded-proto': undefined,
  };
  const probe = await send(f.port, '/api/health', { headers });
  assert.equal(probe.status, 200, probe.body);
  assert.deepEqual(probe.json(), { appId: 'ai-phone-solo' });
  for (const path of ['/controlled', '/auth/status', '/api/status'])
    assert.equal((await send(f.port, path, { headers })).status, 403);
  assert.equal(
    (await send(f.port, '/api/health?ready=1', { headers })).status,
    404,
  );
  assert.equal(
    (await send(f.port, '/api/health', { method: 'POST', body: '{}', headers }))
      .status,
    404,
  );
  assert.equal(
    (
      await send(f.port, '/api/health', {
        headers: { ...headers, 'content-length': '1' },
        body: 'x',
      })
    ).status,
    403,
  );
});

test('duplicate TLS/Host/Cookie header assertions never reach protected routes', async (t) => {
  const f = await fixture(t);
  for (const duplicate of [
    'Host: phone.example.test',
    'X-Forwarded-Proto: https',
    'Cookie: second=value',
  ]) {
    const result = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: f.port });
      let data = '';
      socket.once('connect', () =>
        socket.write(
          `GET /auth/status HTTP/1.1\r\nHost: phone.example.test\r\nX-Forwarded-Proto: https\r\nCookie: first=value\r\n${duplicate}\r\nConnection: close\r\n\r\n`,
        ),
      );
      socket.on('data', (chunk) => {
        data += chunk;
      });
      socket.once('error', reject);
      socket.once('close', () => resolve(data));
    });
    assert.match(result, /HTTP\/1\.1 (?:400|403)/);
  }
});

test('old private APIs, ordinary incoming calls, encoded paths and unknown surfaces are closed', async (t) => {
  const f = await fixture(t);
  for (const [path, method] of [
    ['/', 'GET'],
    ['/index.html', 'GET'],
    ['/health', 'GET'],
    ['/api/token', 'GET'],
    ['/api/settings', 'POST'],
    ['/api/presence', 'POST'],
    ['/api/verify', 'POST'],
    ['/api/shutdown', 'POST'],
    ['/api/connection-maintenance', 'POST'],
    ['/voice/incoming', 'POST'],
    ['/api/%73tatus', 'GET'],
    ['/controlled?enable=1', 'GET'],
    ['/../api/settings', 'POST'],
    ['https://phone.example.test/api/status', 'GET'],
    ['/voice/media', 'GET'],
    ['/api/status', 'PUT'],
  ])
    assert.equal(
      (await send(f.port, path, { method })).status,
      404,
      `${method} ${path}`,
    );
});

test('Google callback and current cookie/CSRF control remain enforced through ingress without local token', async (t) => {
  const f = await fixture(t);
  const auth = await f.establishLogin();
  assert.equal(f.configStore.value.LOCAL_ACCESS_TOKEN, '');
  assert.equal(f.tokenRequests(), 1);
  const common = {
    ...nativeWrite,
    cookie: auth.cookie,
    'x-phone-csrf': auth.csrf,
  };
  assert.equal(
    (
      await send(f.port, '/api/controller/acquire', {
        method: 'POST',
        body: '{"tabId":"offline-tab"}',
        headers: { ...nativeWrite, cookie: auth.cookie },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await send(f.port, '/api/controller/acquire', {
        method: 'POST',
        body: '{"tabId":"offline-tab"}',
        headers: { ...common, origin: 'https://attacker.example.test' },
      })
    ).status,
    403,
  );
  const acquired = await send(f.port, '/api/controller/acquire', {
    method: 'POST',
    body: '{"tabId":"offline-tab"}',
    headers: common,
  });
  assert.equal(acquired.status, 200, acquired.body);
  const proof = acquired.json();
  const created = await send(f.port, '/api/calls', {
    method: 'POST',
    body: JSON.stringify({ to: '+12125550124', controller: proof }),
    headers: common,
  });
  assert.equal(created.status, 200, created.body);
  const ended = await send(f.port, `/api/calls/${created.json().id}/hangup`, {
    method: 'POST',
    body: JSON.stringify({ controller: proof }),
    headers: common,
  });
  assert.equal(ended.status, 200, ended.body);
  assert.equal(
    (
      await send(f.port, auth.callbackPath, {
        headers: {
          cookie: auth.binding,
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await send(f.port, '/auth/logout', {
        method: 'POST',
        body: '{}',
        headers: common,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await send(f.port, '/api/status', {
        headers: { ...nativeRead, cookie: auth.cookie },
      })
    ).status,
    401,
  );
});

function connectMedia(
  port: number,
  path = '/voice/media',
  signature = twilio.getExpectedTwilioSignature(
    config.TWILIO_AUTH_TOKEN,
    `${origin}/voice/media`,
    {},
  ),
) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    headers: {
      host: 'phone.example.test',
      'x-forwarded-proto': 'https',
      'x-twilio-signature': signature,
    },
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, opened };
}

test('only the signed Twilio media WS upgrades; unknown browser WS and forged signature stay rejected', async (t) => {
  const f = await fixture(t);
  for (const [path, signature, expected] of [
    ['/api/events', 'forged', 404],
    ['/unknown', 'forged', 404],
    ['/voice/media', 'forged', 403],
  ] as const) {
    const socket = new WebSocket(`ws://127.0.0.1:${f.port}${path}`, {
      headers: {
        host: 'phone.example.test',
        'x-forwarded-proto': 'https',
        'x-twilio-signature': signature,
      },
    });
    socket.on('error', () => undefined);
    const rejected = await new Promise<number>((resolve) =>
      socket.once('unexpected-response', (_req, response) => {
        response.resume();
        resolve(response.statusCode!);
        socket.terminate();
      }),
    );
    assert.equal(rejected, expected);
  }
  const { socket, opened } = connectMedia(f.port);
  await opened;
  socket.send(JSON.stringify({ event: 'connected' }));
  const closed = new Promise<void>((resolve) =>
    socket.once('close', () => resolve()),
  );
  socket.close();
  await closed;
});

test('ingress close destroys active media tunnels and upstream sockets and is idempotent', async (t) => {
  const f = await fixture(t);
  const { socket, opened } = connectMedia(f.port);
  await opened;
  const closed = new Promise<void>((resolve) =>
    socket.once('close', () => resolve()),
  );
  const first = f.ingress.close();
  assert.equal(f.ingress.close(), first);
  await first;
  await closed;
  assert.equal(f.ingress.server.listening, false);
});

test('bounded framing rejects oversized control and compressed or body-bearing GET requests', async (t) => {
  const f = await fixture(t);
  for (const options of [
    { method: 'POST', body: 'x'.repeat(16 * 1024 + 1) },
    { method: 'POST', body: '{}', headers: { 'content-encoding': 'gzip' } },
  ])
    assert.equal((await send(f.port, '/api/calls', options)).status, 403);
  assert.equal((await send(f.port, '/api/status', { body: 'x' })).status, 403);
});

test('ingress shutdown ends an authenticated actual SSE stream and its pending upstream', async (t) => {
  const f = await fixture(t);
  const auth = await f.establishLogin();
  const stream = await new Promise<import('node:http').IncomingMessage>(
    (resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: f.port,
          path: '/api/events',
          agent: false,
          headers: {
            host: 'phone.example.test',
            'x-forwarded-proto': 'https',
            ...nativeRead,
            cookie: auth.cookie,
          },
        },
        (response) => {
          assert.equal(response.statusCode, 200);
          assert.match(
            String(response.headers['content-type']),
            /^text\/event-stream(?:;|$)/,
          );
          response.on('error', () => undefined);
          response.once('data', (chunk) => {
            assert.match(String(chunk), /event: snapshot/);
            resolve(response);
          });
        },
      );
      request.once('error', reject);
      request.end();
    },
  );
  const closed = new Promise<void>((resolve) => stream.once('close', resolve));
  await f.ingress.close();
  await closed;
  assert.equal(stream.destroyed, true);
});

test('upstream deadline returns only a fixed failure and releases the pending request', async (t) => {
  const upstream = createServer((_request, _response) => undefined);
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  const ingress = createCloudIngress({
    runtime,
    upstreamPort: (upstream.address() as AddressInfo).port,
    upstreamTimeoutMs: 30,
  });
  await new Promise<void>((resolve) =>
    ingress.server.listen(0, '127.0.0.1', resolve),
  );
  t.after(async () => {
    await ingress.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const result = await send(
    (ingress.server.address() as AddressInfo).port,
    '/api/health',
  );
  assert.equal(result.status, 504);
  assert.deepEqual(result.json(), { error: 'CLOUD_INGRESS_UPSTREAM_TIMEOUT' });
});
