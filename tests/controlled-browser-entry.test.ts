import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  CLOUD_SESSION_COOKIE,
  CloudAccessPolicy,
  type CloudAuthSession,
} from '../src/solo/cloud-access';
import { CloudPhoneAccess } from '../src/solo/cloud-phone-access';
import { CloudControllerLeases } from '../src/solo/controller-lease';
import { ConfigStore, type SoloConfig } from '../src/solo/config';
import { buildSoloServer } from '../src/solo/server';
import { SessionManager } from '../src/solo/session-manager';
import type { checkPublicReadiness } from '../src/solo/public-readiness';

const origin = 'https://phone.example.test';
const token = Buffer.alloc(32, 31).toString('base64url');
const otherToken = Buffer.alloc(32, 32).toString('base64url');
const csrf = Buffer.alloc(32, 33).toString('base64url');
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
  OPENAI_API_KEY: `sk-test-${'f'.repeat(32)}`,
  OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
  OPENAI_TRANSCRIPTION_MODEL: 'gpt-4o-transcribe',
  OPENAI_PROXY_URL: '',
  LOCAL_ACCESS_TOKEN: 't'.repeat(64),
};
const readHeaders = (credential = token) => ({
  host: 'phone.example.test',
  cookie: `${CLOUD_SESSION_COOKIE}=${credential}`,
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
});
const writeHeaders = () => ({
  host: 'phone.example.test',
  origin,
  cookie: `${CLOUD_SESSION_COOKIE}=${token}`,
  'x-phone-csrf': csrf,
});

async function fixture(
  t: TestContext,
  options: {
    local?: boolean;
    publicDir?: string;
    publicChecker?: typeof checkPublicReadiness;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'controlled-browser-entry-'));
  const store = new ConfigStore({
    envPath: join(directory, '.env'),
    values: config,
    generateToken: false,
  });
  let now = 1000;
  const session = (suffix: string): CloudAuthSession => ({
    authSessionId: `auth-${suffix}`,
    principalId: 'one-test-user',
    browserOwnerId: `owner-${suffix}`,
    epoch: 1,
    issuedAt: 100,
    absoluteExpiresAt: 100000,
    idleExpiresAt: 50000,
    revoked: false,
    csrfToken: csrf,
  });
  const sessions = new Map([
    [token, session('one')],
    [otherToken, session('two')],
  ]);
  const policy = new CloudAccessPolicy({
    publicOrigin: origin,
    resolveSession: (credential) => sessions.get(credential),
    now: () => now,
  });
  const manager = new SessionManager({
    now: () => now,
    providerFactory: () => ({
      create: async () => {
        assert.fail('No provider dial is permitted by an entry-page test');
      },
      hangup: async () => undefined,
    }),
    bridgeFactory: () => ({ attach() {}, close() {} }),
  });
  const leases = new CloudControllerLeases({ policy, now: () => now });
  const access = new CloudPhoneAccess({
    policy,
    manager,
    controllerLeases: leases,
    publicReadinessChecker:
      options.publicChecker ||
      (async () => ({ status: 'ready', code: 'PUBLIC_CALLBACK_READY' })),
    translationReadinessChecker: async () => ({
      name: 'offline-only',
      status: 'passed',
      code: 'TEST_READY',
    }),
  });
  const app = await buildSoloServer({
    configStore: store,
    sessionManager: manager,
    publicDir: options.publicDir || resolve('public'),
    ...(options.local ? {} : { browserControl: access }),
  });
  t.after(async () => {
    await app.close();
    await access.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const bootstrap = (tabId = 'tab-one', credential = token) =>
    app.inject({
      method: 'GET',
      url: `/api/browser-session?tabId=${tabId}`,
      remoteAddress: '127.0.0.1',
      headers: readHeaders(credential),
    });
  const acquire = () =>
    app.inject({
      method: 'POST',
      url: '/api/controller/acquire',
      headers: writeHeaders(),
      payload: { tabId: 'tab-one' },
      remoteAddress: '127.0.0.1',
    });
  return {
    app,
    policy,
    access,
    manager,
    sessions,
    bootstrap,
    acquire,
    setNow(value: number) {
      now = value;
    },
  };
}

test('the isolated entry serves the real marked page without private configuration or a query switch', async (t) => {
  const { app } = await fixture(t);
  const page = await app.inject({
    url: '/controlled',
    headers: {
      host: 'phone.example.test',
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    },
    remoteAddress: '127.0.0.1',
  });
  assert.equal(page.statusCode, 200);
  assert.match(
    page.body,
    /<html lang="zh-CN" data-phone-surface="controlled">/,
  );
  assert.match(page.body, /id="transcript-scroll"/);
  assert.match(page.body, /src="\/app\.js"/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(
    page.headers['content-security-policy'] || '',
    /script-src 'self'/,
  );
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  for (const secret of [
    token,
    csrf,
    config.TWILIO_AUTH_TOKEN,
    config.LOCAL_ACCESS_TOKEN,
  ])
    assert.ok(!page.body.includes(secret));
  for (const url of [
    '/',
    '/index.html',
    '/controlled?enabled=1',
    '/conversation-demo.html',
  ])
    assert.equal(
      (await app.inject({ url, headers: { host: 'phone.example.test' } }))
        .statusCode,
      404,
    );
});

test('missing controlled page marker fails closed rather than running the local page flow', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'controlled-invalid-page-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, 'index.html'),
    '<html lang="en"><body></body></html>',
  );
  const { app } = await fixture(t, { publicDir: directory });
  const response = await app.inject({
    url: '/controlled',
    headers: { host: 'phone.example.test' },
  });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { error: 'CLOUD_BROWSER_NOT_READY' });
});

test('public source assets allow native script/module/style/image loads independently of API authorization', async (t) => {
  const { app } = await fixture(t);
  for (const [url, mode, dest] of [
    ['/app.js', 'no-cors', 'script'],
    ['/call-lifecycle.js', 'cors', 'script'],
    ['/styles.css', 'no-cors', 'style'],
    ['/favicon.svg', 'no-cors', 'image'],
    ['/assets/speaker-test.wav', 'no-cors', 'audio'],
  ]) {
    const response = await app.inject({
      url,
      headers: {
        host: 'phone.example.test',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': mode,
        'sec-fetch-dest': dest,
      },
    });
    assert.equal(response.statusCode, 200, url);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(
      response.headers['content-security-policy'] || '',
      /object-src 'none'/,
    );
  }
  const head = await app.inject({
    method: 'HEAD',
    url: '/app.js',
    headers: { host: 'phone.example.test' },
  });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
});

test('public reads retain exact Host, real loopback, Origin and unambiguous forwarding protection', async (t) => {
  const { app } = await fixture(t);
  for (const request of [
    { headers: { host: 'evil.example.test' } },
    { headers: { host: 'phone.example.test', origin: 'null' } },
    {
      headers: {
        host: 'phone.example.test',
        origin: 'https://evil.example.test',
      },
    },
    { headers: { host: 'phone.example.test', forwarded: '' } },
    { headers: { host: 'phone.example.test', 'x-forwarded-proto': 'https' } },
    {
      headers: { host: 'phone.example.test', 'sec-fetch-site': 'same-origin' },
    },
    {
      headers: {
        host: 'phone.example.test',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'script',
      },
    },
    {
      headers: {
        host: 'phone.example.test',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'empty',
      },
    },
    { headers: { host: 'phone.example.test' }, remoteAddress: '198.51.100.8' },
  ]) {
    const result = await app.inject({ url: '/app.js', ...request });
    assert.equal(result.statusCode, 403);
  }
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  for (const headers of [
    'Host: phone.example.test\r\nHost: phone.example.test',
    `Host: phone.example.test\r\nOrigin: ${origin}\r\nOrigin: ${origin}`,
  ]) {
    const status = await new Promise<number>((yes, no) => {
      const socket = createConnection({
        host: '127.0.0.1',
        port: address.port,
      });
      let response = '';
      socket.setTimeout(2000, () =>
        socket.destroy(new Error('HTTP test timeout')),
      );
      socket.once('connect', () =>
        socket.write(
          `GET /app.js HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`,
        ),
      );
      socket.on('data', (chunk) => {
        response += chunk.toString();
      });
      socket.once('error', no);
      socket.once('end', () =>
        yes(Number(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1] || 0)),
      );
    });
    assert.equal(status, 403);
  }
});

test('native same-origin fetch bootstrap returns only current CSRF and safe informational policy', async (t) => {
  const { bootstrap } = await fixture(t);
  const response = await bootstrap();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    mode: 'controlled',
    csrfToken: csrf,
    controller: {
      mode: 'available',
      ownSession: false,
      tabMatches: false,
      epoch: 0,
      expiresAt: null,
    },
    activeSession: null,
    busy: false,
    translationEngines: ['pocket-prefix', 'pocket-captions'],
    defaultTranslationEngine: 'pocket-prefix',
    outgoingPairedCaptions: true,
  });
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.match(response.headers.vary || '', /Cookie/);
  for (const name of [
    'configured',
    'checks',
    'identity',
    'publicUrl',
    'leaseId',
    'token',
    'desktopConnection',
    'pocketVoice',
  ])
    assert.ok(!Object.hasOwn(response.json(), name), name);
  for (const secret of [
    token,
    config.TWILIO_AUTH_TOKEN,
    config.TWILIO_API_KEY_SECRET,
    config.LOCAL_ACCESS_TOKEN,
    config.OPENAI_API_KEY,
  ])
    assert.ok(!response.body.includes(secret));
});

test('bootstrap still rejects missing login and invalid API source rather than borrowing public script policy', async (t) => {
  const { app } = await fixture(t);
  for (const [headers, status] of [
    [{ ...readHeaders(), cookie: '' }, 401],
    [
      { ...readHeaders(), cookie: `${CLOUD_SESSION_COOKIE}=not-a-session` },
      401,
    ],
    [{ ...readHeaders(), origin: 'null' }, 403],
    [{ ...readHeaders(), host: 'evil.example.test' }, 403],
    [{ ...readHeaders(), forwarded: 'for=127.0.0.1' }, 403],
    [
      {
        ...readHeaders(),
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'script',
      },
      403,
    ],
  ] as const) {
    const response = await app.inject({
      url: '/api/browser-session?tabId=tab-one',
      headers,
    });
    assert.equal(response.statusCode, status);
    assert.ok(!response.body.includes(csrf));
  }
  assert.equal(
    (
      await app.inject({
        url: '/api/browser-session',
        headers: readHeaders(),
        remoteAddress: '198.51.100.8',
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: '/api/browser-session?tabId=bad%20tab',
        headers: readHeaders(),
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: '/api/browser-session?tabId=tab-one&tabId=tab-two',
        headers: readHeaders(),
      })
    ).statusCode,
    403,
  );
  for (const url of [
    '/api/token',
    '/api/presence',
    '/api/settings',
    '/api/shutdown',
  ])
    assert.equal(
      (await app.inject({ url, headers: readHeaders() })).statusCode,
      503,
    );
});

test('read-only CSRF projection refreshes current values without promoting its GET context', async (t) => {
  const { policy, sessions, bootstrap } = await fixture(t);
  const context = policy.authenticate(readHeaders(), 'read', {
    surface: 'http',
    method: 'GET',
  });
  assert.equal(policy.currentCsrfToken(context), csrf);
  assert.throws(() => policy.revalidate(context, 'mutate'), /FORBIDDEN/);
  const replacement = Buffer.alloc(32, 34).toString('base64url');
  sessions.get(token)!.csrfToken = replacement;
  assert.equal(policy.currentCsrfToken(context), replacement);
  assert.equal((await bootstrap()).json().csrfToken, replacement);
  assert.throws(() => policy.revalidate(context, 'mutate'), /FORBIDDEN/);
  assert.doesNotThrow(() =>
    policy.authenticate(
      { ...writeHeaders(), 'x-phone-csrf': replacement },
      'mutate',
      { surface: 'http', method: 'POST' },
    ),
  );
  sessions.get(token)!.revoked = true;
  assert.throws(() => policy.currentCsrfToken(context), /UNAUTHORIZED/);
  assert.equal((await bootstrap()).statusCode, 401);
});

test('bootstrap exposes read-only tab status without returning controller proof or renewing its expiry', async (t) => {
  const { acquire, bootstrap, setNow } = await fixture(t);
  const acquired = await acquire();
  assert.equal(acquired.statusCode, 200);
  const proof = acquired.json();
  const own = (await bootstrap()).json();
  assert.equal(own.controller.tabMatches, true);
  assert.equal(own.controller.ownSession, true);
  assert.equal(own.controller.expiresAt, proof.expiresAt);
  assert.ok(!JSON.stringify(own).includes(proof.leaseId));
  const otherTab = (await bootstrap('tab-two')).json();
  assert.equal(otherTab.controller.tabMatches, false);
  assert.equal(otherTab.controller.ownSession, true);
  const otherSession = (await bootstrap('tab-three', otherToken)).json();
  assert.equal(otherSession.controller.ownSession, false);
  assert.equal(otherSession.controller.tabMatches, false);
  setNow(2000);
  assert.equal(
    (await bootstrap()).json().controller.expiresAt,
    proof.expiresAt,
  );
  setNow(proof.expiresAt);
  assert.equal((await bootstrap()).json().controller.mode, 'available');
});

test('busy bootstrap includes preparation and call gates while keeping a foreign active call private', async (t) => {
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((yes) => {
    release = yes;
  });
  const preparing = new Promise<void>((yes) => {
    entered = yes;
  });
  t.after(release);
  const { app, acquire, bootstrap } = await fixture(t, {
    publicChecker: async () => {
      entered();
      await paused;
      return { status: 'ready', code: 'PUBLIC_CALLBACK_READY' };
    },
  });
  const proof = (await acquire()).json();
  const create = app.inject({
    method: 'POST',
    url: '/api/calls',
    headers: writeHeaders(),
    payload: { to: '+12125550124', controller: proof },
  });
  const started = create.then((value) => value);
  await Promise.race([
    preparing,
    started.then((response) => {
      assert.fail(
        `Call stopped before readiness: ${response.statusCode} ${response.body}`,
      );
    }),
  ]);
  assert.equal((await bootstrap()).json().busy, true);
  assert.equal((await bootstrap()).json().activeSession, null);
  release();
  const created = await started;
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().translationEngine, 'pocket-prefix');
  const own = (await bootstrap()).json();
  assert.equal(own.busy, true);
  assert.equal(own.activeSession.id, created.json().id);
  const foreign = (await bootstrap('tab-other', otherToken)).json();
  assert.equal(foreign.activeSession, null);
  assert.equal(foreign.busy, true);
  assert.ok(!JSON.stringify(foreign).includes(created.json().id));
});

test('local root and authorization stay unchanged and cannot select controlled mode by URL or query', async (t) => {
  const { app } = await fixture(t, { local: true });
  const headers = { host: '127.0.0.1:5050', origin: 'http://127.0.0.1:5050' };
  for (const url of ['/', '/?controlled=1']) {
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200);
    assert.ok(!response.body.includes('data-phone-surface="controlled"'));
  }
  assert.equal(
    (await app.inject({ url: '/controlled', headers })).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        url: '/api/browser-session',
        headers: {
          ...headers,
          authorization: `Bearer ${config.LOCAL_ACCESS_TOKEN}`,
        },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        url: '/app.js',
        headers: { host: 'phone.example.test' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ url: '/api/status', headers })).statusCode,
    401,
  );
});
