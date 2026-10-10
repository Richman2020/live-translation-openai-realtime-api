import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection, type AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';

import { CLOUD_SESSION_COOKIE } from '../src/solo/cloud-access';
import { createCloudIngress } from '../src/solo/cloud-ingress';
import {
  parsePhoneRuntime,
  type CloudPhoneRuntime,
} from '../src/solo/cloud-runtime';
import type { CloudWebVerificationConfig } from '../src/solo/cloud-web-verification-config';
import { createCloudWebVerificationService } from '../src/solo/cloud-web-verification-service';
import { GOOGLE_OIDC } from '../src/solo/google-oidc';

const origin = 'https://phone.example.test';
const authority = 'phone.example.test';
const initialTime = 1_800_000_000_000;
const clientId = 'offline.apps.googleusercontent.com';
const email = 'owner@workspace.example.test';
const domain = 'workspace.example.test';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...pair.publicKey.export({ format: 'jwk' }),
  kid: 'offline-web',
  alg: 'RS256',
  use: 'sig',
};
const readHeaders = (cookie?: string) => ({
  host: authority,
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  ...(cookie ? { cookie } : {}),
});
const writeHeaders = (cookie?: string, csrf?: string) => ({
  ...readHeaders(cookie),
  origin,
  'x-phone-login': 'start',
  ...(csrf ? { 'x-phone-csrf': csrf } : {}),
});
const callbackHeaders = (cookie: string) => ({
  host: authority,
  cookie,
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
function config(port: number): CloudWebVerificationConfig {
  return {
    mode: 'web-verification',
    runtime: parsePhoneRuntime({
      AI_PHONE_RUNTIME_MODE: 'cloud',
      PORT: String(port),
      CLOUD_PUBLIC_ORIGIN: origin,
      CLOUD_WARM_INSTANCES: '1',
    }) as CloudPhoneRuntime,
    google: {
      clientId,
      clientSecret: 'offline-not-a-secret',
      allowedEmail: email,
      expectedHostedDomain: domain,
      redirectUri: `${origin}/auth/google/callback`,
    },
    testDeadline: initialTime + 3_600_000,
  };
}
async function fixture(t: TestContext, deadlineDurationMs = 3_600_000) {
  let now = initialTime;
  let fetches = 0;
  let tokenBarrier: ReturnType<typeof deferred> | undefined;
  const enteredToken = deferred();
  const codes = new Map<string, string>();
  const claims: Record<string, unknown> = {};
  const fakeFetch: typeof fetch = async (input, init) => {
    fetches += 1;
    const url = String(input);
    if (url === GOOGLE_OIDC.jwksUri)
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { 'content-type': 'application/json' },
      });
    assert.equal(
      url,
      GOOGLE_OIDC.tokenEndpoint,
      'No other external URL is used',
    );
    enteredToken.resolve();
    if (tokenBarrier) await tokenBarrier.promise;
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: jwk.kid }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: GOOGLE_OIDC.issuer,
        aud: clientId,
        sub: 'offline-subject',
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 300,
        nonce: codes.get(new URLSearchParams(String(init?.body)).get('code')!),
        email,
        email_verified: true,
        hd: domain,
        ...claims,
      }),
    ).toString('base64url');
    const data = `${header}.${payload}`;
    const idToken = `${data}.${sign('RSA-SHA256', Buffer.from(data), pair.privateKey).toString('base64url')}`;
    return new Response(
      JSON.stringify({
        id_token: idToken,
        access_token: 'offline-unused-token',
        token_type: 'Bearer',
        expires_in: 300,
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  const settings = config(await reservePort());
  const boundedSettings = {
    ...settings,
    testDeadline: initialTime + deadlineDurationMs,
  };
  const service = await createCloudWebVerificationService(boundedSettings, {
    googleFetch: fakeFetch,
    now: () => now,
  });
  t.after(() => service.close());
  const inject = (
    url: string,
    headers: Record<string, string> = readHeaders(),
    method: 'GET' | 'POST' = 'GET',
  ) =>
    service.app.inject({
      method,
      url,
      headers,
      remoteAddress: '127.0.0.1',
      ...(method === 'POST' ? { payload: {} } : {}),
    });
  const start = async () => {
    const result = await inject('/auth/google/start', writeHeaders(), 'POST');
    assert.equal(result.statusCode, 200, result.body);
    const url = new URL(result.json().authorizationUrl);
    const code = `offline-code-${codes.size}`;
    codes.set(code, url.searchParams.get('nonce')!);
    return {
      url: `/auth/google/callback?state=${url.searchParams.get('state')}&code=${code}`,
      cookie: String(result.headers['set-cookie']).split(';')[0],
    };
  };
  const finish = (flow: Awaited<ReturnType<typeof start>>) =>
    inject(flow.url, callbackHeaders(flow.cookie));
  const signIn = async () => {
    const result = await finish(await start());
    assert.equal(result.statusCode, 200, result.body);
    const cookies = result.headers['set-cookie'];
    const values = Array.isArray(cookies) ? cookies : [cookies as string];
    const cookie = values
      .find((value) => value.startsWith(`${CLOUD_SESSION_COOKIE}=`))!
      .split(';')[0];
    const session = await inject('/api/browser-session', readHeaders(cookie));
    assert.equal(session.statusCode, 200, session.body);
    return {
      cookie,
      csrf: session.json().csrfToken,
      expiresAt: session.json().expiresAt,
    };
  };
  return {
    service,
    settings: boundedSettings,
    inject,
    start,
    finish,
    signIn,
    claims,
    fetches: () => fetches,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    blockToken: () => {
      tokenBarrier = deferred();
      return { entered: enteredToken.promise, release: tokenBarrier.resolve };
    },
  };
}
function send(
  port: number,
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        agent: false,
        headers: { host: authority, 'x-forwarded-proto': 'https', ...headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('end', () =>
          resolve({
            status: response.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
        response.once('error', reject);
      },
    );
    request.once('error', reject);
    request.end();
  });
}

test('web service starts without provider traffic, exposes only public shell and anonymous metadata', async (t) => {
  const f = await fixture(t);
  assert.equal(f.fetches(), 0);
  const health = await f.inject('/api/health');
  assert.deepEqual(health.json(), {
    appId: 'ai-phone-solo',
    mode: 'web-verification',
    callsEnabled: false,
  });
  for (const path of [
    '/controlled',
    '/web-verification.js',
    '/styles.css',
    '/favicon.svg',
  ]) {
    const result = await f.inject(path);
    assert.equal(result.statusCode, 200, path);
    assert.match(
      String(result.headers['content-security-policy']),
      /script-src 'self'/,
    );
  }
  for (const path of ['/api/status', '/api/browser-session']) {
    const result = await f.inject(path);
    assert.equal(result.statusCode, 401, path);
    assert.deepEqual(result.json(), { error: 'UNAUTHORIZED' });
  }
  assert.equal(f.fetches(), 0);
});

test('real login routes validate offline signed Google identity; session reads never grant calls', async (t) => {
  const f = await fixture(t);
  const account = await f.signIn();
  const status = await f.inject('/api/status', readHeaders(account.cookie));
  assert.deepEqual(status.json(), {
    mode: 'web-verification',
    authenticated: true,
    callsEnabled: false,
    phoneStatus: 'disabled',
  });
  const browser = await f.inject(
    '/api/browser-session',
    readHeaders(account.cookie),
  );
  assert.deepEqual(Object.keys(browser.json()).sort(), [
    'authenticated',
    'csrfToken',
    'expiresAt',
  ]);
  assert.equal(browser.json().csrfToken, account.csrf);
  assert.doesNotMatch(
    status.body + browser.body,
    /offline-subject|owner@|provider|controller|voiceIdentity/,
  );
  for (const path of [
    '/api/calls',
    '/api/controller/acquire',
    '/api/token',
    '/api/settings',
    '/api/events',
    '/voice/client',
    '/voice/connect',
    '/voice/media',
    '/vendor/twilio.min.js',
    '/app.js',
  ]) {
    const denied = await f.inject(
      path,
      writeHeaders(account.cookie, account.csrf),
      'POST',
    );
    assert.equal(denied.statusCode, 403, path);
    assert.deepEqual(denied.json(), { error: 'CALLS_DISABLED' });
  }
});

test('renew and logout keep original Origin and CSRF boundaries and revoke reads', async (t) => {
  const f = await fixture(t);
  const account = await f.signIn();
  for (const path of ['/auth/session/renew', '/auth/logout']) {
    const denied = await f.inject(path, writeHeaders(account.cookie), 'POST');
    assert.equal(denied.statusCode, 403, path);
  }
  const crossSite = await f.inject(
    '/auth/logout',
    {
      ...writeHeaders(account.cookie, account.csrf),
      origin: 'https://other.example.test',
    },
    'POST',
  );
  assert.equal(crossSite.statusCode, 403);
  const renewed = await f.inject(
    '/auth/session/renew',
    writeHeaders(account.cookie, account.csrf),
    'POST',
  );
  assert.equal(renewed.statusCode, 200, renewed.body);
  assert.equal(
    (
      await f.inject(
        '/auth/logout',
        writeHeaders(account.cookie, account.csrf),
        'POST',
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await f.inject('/api/status', readHeaders(account.cookie))).statusCode,
    401,
  );
});

test('missing hosted-domain signed claim fails real callback without session cookie', async (t) => {
  const f = await fixture(t);
  f.claims.hd = undefined;
  const result = await f.finish(await f.start());
  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.json(), { error: 'LOGIN_FAILED' });
  assert.equal(result.headers['set-cookie'], undefined);
});

test('session idle expiry revokes authenticated metadata within the test deadline', async (t) => {
  const f = await fixture(t);
  const account = await f.signIn();
  f.advance(16 * 60 * 1000);
  assert.equal(
    (await f.inject('/api/status', readHeaders(account.cookie))).statusCode,
    401,
  );
  assert.equal(
    (await f.inject('/api/browser-session', readHeaders(account.cookie)))
      .statusCode,
    401,
  );
});

test('session bootstrap and renew expose the earlier service deadline', async (t) => {
  const f = await fixture(t, 60_000);
  const account = await f.signIn();
  assert.equal(account.expiresAt, f.settings.testDeadline);
  assert.equal(
    (
      await f.inject(
        '/auth/session/renew',
        writeHeaders(account.cookie, account.csrf),
        'POST',
      )
    ).statusCode,
    200,
  );
  const browser = await f.inject(
    '/api/browser-session',
    readHeaders(account.cookie),
  );
  assert.equal(browser.json().expiresAt, f.settings.testDeadline);
});

test('expiry during awaited OIDC exchange cannot commit a cookie and clock rollback cannot reopen', async (t) => {
  const f = await fixture(t);
  const flow = await f.start();
  const gate = f.blockToken();
  const pending = f.finish(flow);
  await gate.entered;
  f.advance(3_600_000);
  gate.release();
  const result = await pending;
  assert.equal(result.statusCode, 503, result.body);
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(result.headers.location, undefined);
  await f.service.close();
  f.advance(-3_600_000);
  assert.throws(() => f.service.deadline.assertCurrent(), /CLOUD_TEST_EXPIRED/);
  assert.equal(f.service.ingress.server.listening, false);
  assert.equal(f.service.app.server.listening, false);
  assert.equal(f.service.close(), f.service.close());
});

test('deadline revokes existing identity and closes both listeners, including half-open upgrade sockets', async (t) => {
  const f = await fixture(t);
  const account = await f.signIn();
  const context = f.service.login.policy.authenticate(
    readHeaders(account.cookie),
    'read',
    { surface: 'http', method: 'GET' },
  );
  const port = (f.service.app.server.address() as AddressInfo).port;
  const socket = createConnection({
    host: '127.0.0.1',
    port,
    allowHalfOpen: true,
  });
  t.after(() => socket.destroy());
  const response = new Promise<string>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('data', (chunk) => resolve(chunk.toString()));
  });
  socket.once('connect', () =>
    socket.write(
      `GET /voice/media HTTP/1.1\r\nHost: ${authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
    ),
  );
  assert.match(await response, /403 Forbidden/);
  f.advance(3_600_000);
  await f.service.deadline.expireIfDue();
  assert.throws(
    () => f.service.login.policy.revalidate(context, 'read'),
    /UNAUTHORIZED/,
  );
  assert.equal(f.service.ingress.server.listening, false);
  assert.equal(f.service.app.server.listening, false);
});

test('deadline shutdown destroys a private unfinished HTTP request without waiting for its body', async (t) => {
  const f = await fixture(t);
  const port = (f.service.app.server.address() as AddressInfo).port;
  const received = new Promise<void>((resolve) =>
    f.service.app.server.once('request', () => resolve()),
  );
  const socket = createConnection({
    host: '127.0.0.1',
    port,
    allowHalfOpen: true,
  });
  t.after(() => socket.destroy());
  socket.on('error', () => {});
  socket.once('connect', () =>
    socket.write(
      `POST /auth/google/start HTTP/1.1\r\nHost: ${authority}\r\nOrigin: ${origin}\r\nX-Phone-Login: start\r\nSec-Fetch-Site: same-origin\r\nSec-Fetch-Mode: cors\r\nSec-Fetch-Dest: empty\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`,
    ),
  );
  await received;
  f.advance(3_600_000);
  let timeout: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      f.service.deadline.expireIfDue(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Private incomplete body blocked shutdown')),
          300,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout!);
  }
  assert.equal(f.fetches(), 0);
  assert.equal(f.service.ingress.server.listening, false);
  assert.equal(f.service.app.server.listening, false);
});

test('connections arriving while ingress close is pending are destroyed before private listener close', async (t) => {
  const f = await fixture(t);
  const released = deferred();
  const reached = deferred();
  const originalClose = f.service.ingress.server.close.bind(
    f.service.ingress.server,
  );
  f.service.ingress.server.close = ((callback?: (error?: Error) => void) =>
    originalClose((error?: Error) => {
      reached.resolve();
      void released.promise.then(() => callback?.(error));
    })) as typeof f.service.ingress.server.close;
  const closing = f.service.close();
  const sockets: ReturnType<typeof createConnection>[] = [];
  try {
    await reached.promise;
    assert.equal(f.service.app.server.listening, true);
    for (const upgrade of [false, true]) {
      const socket = createConnection({
        host: '127.0.0.1',
        port: (f.service.app.server.address() as AddressInfo).port,
      });
      sockets.push(socket);
      socket.on('error', () => {});
      if (upgrade)
        socket.once('connect', () =>
          socket.write(
            `GET /voice/media HTTP/1.1\r\nHost: ${authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
          ),
        );
      let timeout: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          new Promise<void>((resolve) => socket.once('close', () => resolve())),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error('New private socket survived closing boundary'),
                ),
              300,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout!);
      }
      assert.equal(f.service.app.server.listening, true);
    }
    assert.equal(f.fetches(), 0);
  } finally {
    released.resolve();
    for (const socket of sockets) socket.destroy();
    await closing;
  }
});

test('factory rejects mode, runtime, callback and deadline mismatches before listener or network work', async () => {
  const good = config(await reservePort());
  let fetches = 0;
  const fakeFetch: typeof fetch = async () => {
    fetches += 1;
    throw new Error('must not run');
  };
  const variants = [
    { ...good, mode: 'phone' },
    { ...good, runtime: { ...good.runtime, port: 0 } },
    { ...good, runtime: { ...good.runtime, host: '127.0.0.1' } },
    {
      ...good,
      runtime: { ...good.runtime, mediaOrigin: 'wss://other.example.test' },
    },
    {
      ...good,
      google: {
        ...good.google,
        redirectUri: 'https://other.example.test/auth/google/callback',
      },
    },
    { ...good, testDeadline: initialTime },
    { ...good, testDeadline: initialTime + 3_600_001 },
  ];
  for (const value of variants)
    await assert.rejects(
      createCloudWebVerificationService(value as CloudWebVerificationConfig, {
        now: () => initialTime,
        googleFetch: fakeFetch,
      }),
      /CLOUD_WEB_VERIFICATION_CONFIG_INVALID/,
    );
  assert.equal(fetches, 0);
});

test('web ingress forwards only exact web routes and denies all upgrades before contacting upstream', async (t) => {
  let upstreamRequests = 0;
  let upstreamUpgrades = 0;
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1;
    response.end('offline');
  });
  upstream.on('upgrade', (_request, socket) => {
    upstreamUpgrades += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  t.after(
    () => new Promise<void>((resolve) => upstream.close(() => resolve())),
  );
  const settings = config(await reservePort());
  const ingress = createCloudIngress({
    runtime: settings.runtime,
    mode: 'web-verification',
    upstreamPort: (upstream.address() as AddressInfo).port,
  });
  await new Promise<void>((resolve) =>
    ingress.server.listen(settings.runtime.port, '127.0.0.1', resolve),
  );
  t.after(() => ingress.close());
  for (const path of [
    '/api/calls',
    '/api/controller/acquire',
    '/api/events',
    '/api/token',
    '/voice/client',
    '/voice/media',
    '/app.js',
    '/vendor/twilio.min.js',
    '/api/status?ownerId=forged',
  ]) {
    for (const method of ['GET', 'POST', 'HEAD'])
      assert.equal(
        (await send(settings.runtime.port, path, method)).status,
        404,
        `${method} ${path}`,
      );
  }
  assert.equal(upstreamRequests, 0);
  for (const path of ['/voice/media', '/api/status', '/controlled']) {
    const socket = createConnection({
      host: '127.0.0.1',
      port: settings.runtime.port,
      allowHalfOpen: true,
    });
    const reply = new Promise<string>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('data', (chunk) => resolve(chunk.toString()));
    });
    socket.once('connect', () =>
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      ),
    );
    assert.match(await reply, /403 Rejected/);
    socket.destroy();
  }
  assert.equal(upstreamRequests, 0);
  assert.equal(upstreamUpgrades, 0);
  assert.equal((await send(settings.runtime.port, '/api/status')).status, 200);
  assert.equal(upstreamRequests, 1);
  const probe = await send(settings.runtime.port, '/api/health', 'GET', {
    host: 'healthcheck.railway.app',
  });
  assert.deepEqual(JSON.parse(probe.body), {
    appId: 'ai-phone-solo',
    mode: 'web-verification',
    callsEnabled: false,
  });
  assert.equal(upstreamRequests, 1);
  assert.throws(
    () =>
      createCloudIngress({
        runtime: settings.runtime,
        upstreamPort: (upstream.address() as AddressInfo).port,
        mode: 'unknown' as 'phone',
      }),
    /INVALID_CLOUD_INGRESS/,
  );
});
