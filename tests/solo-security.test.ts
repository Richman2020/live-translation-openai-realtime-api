import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import twilio from 'twilio';
import { setImmediate as tick } from 'node:timers/promises';
import WebSocket from 'ws';
import { ConfigStore, checkConfig, type SoloConfig } from '../src/solo/config';
import { buildSoloServer } from '../src/solo/server';
import { SessionError, SessionManager } from '../src/solo/session-manager';

const config: SoloConfig = {
  API_PORT: '5050',
  API_HOST: '127.0.0.1',
  PUBLIC_BASE_URL: 'https://phone.example.com',
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
async function fixture(t: any, overrides: Partial<SoloConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-phone-security-'));
  const store = new ConfigStore({
    envPath: join(dir, '.env'),
    values: { ...config, ...overrides },
    generateToken: false,
  });
  const manager = new SessionManager({
    providerFactory: () => {
      throw new Error('Tests must not call a provider');
    },
  });
  const app = await buildSoloServer({
    configStore: store,
    sessionManager: manager,
    publicDir: dir,
  });
  t.after(async () => {
    for (const socket of app.websocketServer.clients) socket.terminate();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, store, dir, manager };
}
const headers = {
  host: '127.0.0.1:5050',
  authorization: `Bearer ${config.LOCAL_ACCESS_TOKEN}`,
  origin: 'http://127.0.0.1:5050',
};

test('local API rejects public Host, remote callers, forwarded requests, cross-origin and absent auth', async (t) => {
  const { app } = await fixture(t);
  const good = await app.inject({
    method: 'GET',
    url: '/api/status',
    remoteAddress: '127.0.0.1',
    headers,
  });
  assert.equal(good.statusCode, 200);
  assert.equal(good.json().configured, true);
  for (const request of [
    {
      headers: { ...headers, host: 'phone.example.com' },
      remoteAddress: '127.0.0.1',
    },
    { headers, remoteAddress: '198.51.100.2' },
    {
      headers: { ...headers, 'x-forwarded-for': '198.51.100.2' },
      remoteAddress: '127.0.0.1',
    },
    {
      headers: { ...headers, origin: 'https://evil.example' },
      remoteAddress: '127.0.0.1',
    },
    { headers: { host: '127.0.0.1:5050' }, remoteAddress: '127.0.0.1' },
  ]) {
    const response = await app.inject({
      method: 'GET',
      url: '/api/status',
      ...request,
    });
    assert.ok([401, 403].includes(response.statusCode));
  }
  const queryToken = await app.inject({
    method: 'GET',
    url: `/api/token?token=${config.LOCAL_ACCESS_TOKEN}`,
    remoteAddress: '127.0.0.1',
    headers: { host: '127.0.0.1:5050' },
  });
  assert.equal(queryToken.statusCode, 401);
  const probe = await app.inject({
    method: 'GET',
    url: '/api/health',
    remoteAddress: '198.51.100.2',
    headers: { host: 'phone.example.com' },
  });
  assert.deepEqual(probe.json(), { appId: 'ai-phone-solo' });
});

test('status and settings never echo secrets; blank secrets preserve existing configuration', async (t) => {
  const { app, dir, store } = await fixture(t);
  writeFileSync(
    join(dir, '.env'),
    `# private file\nUNRELATED_SETTING=preserved\nOPENAI_API_KEY=${config.OPENAI_API_KEY}\n`,
  );
  const saved = await app.inject({
    method: 'POST',
    url: '/api/settings',
    remoteAddress: '127.0.0.1',
    headers,
    payload: { OPENAI_API_KEY: '', OPENAI_REALTIME_MODEL: 'gpt-realtime' },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(store.value.OPENAI_API_KEY, config.OPENAI_API_KEY);
  assert.match(
    readFileSync(join(dir, '.env'), 'utf8'),
    /UNRELATED_SETTING=preserved/,
  );
  assert.equal(saved.json().realtimeModel, 'gpt-realtime');
  for (const secret of [
    config.OPENAI_API_KEY,
    config.TWILIO_AUTH_TOKEN,
    config.TWILIO_API_KEY_SECRET,
    config.LOCAL_ACCESS_TOKEN,
  ])
    assert.ok(!saved.body.includes(secret));
  const bad = await app.inject({
    method: 'POST',
    url: '/api/settings',
    remoteAddress: '127.0.0.1',
    headers,
    payload: { NODE_OPTIONS: '--require=evil' },
  });
  assert.equal(bad.statusCode, 400);
});

test('transcription defaults to Whisper and only supported explicit settings persist', async (t) => {
  const { app, store, dir } = await fixture(t, {
    OPENAI_TRANSCRIPTION_MODEL: '',
  });
  assert.equal(store.value.OPENAI_TRANSCRIPTION_MODEL, 'whisper-1');
  assert.equal(store.configured(), true);
  const saved = await app.inject({
    method: 'POST',
    url: '/api/settings',
    remoteAddress: '127.0.0.1',
    headers,
    payload: { OPENAI_TRANSCRIPTION_MODEL: 'gpt-4o-mini-transcribe' },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(
    store.value.OPENAI_TRANSCRIPTION_MODEL,
    'gpt-4o-mini-transcribe',
  );
  const reloaded = new ConfigStore({
    envPath: join(dir, '.env'),
    generateToken: false,
  });
  assert.equal(
    reloaded.value.OPENAI_TRANSCRIPTION_MODEL,
    'gpt-4o-mini-transcribe',
  );
  for (const value of ['', 'unsupported-model']) {
    assert.throws(
      () => store.save({ OPENAI_TRANSCRIPTION_MODEL: value }),
      /INVALID_OPENAI_TRANSCRIPTION_MODEL/,
    );
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/settings',
      remoteAddress: '127.0.0.1',
      headers,
      payload: { OPENAI_TRANSCRIPTION_MODEL: value },
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.json().error, 'INVALID_SETTINGS');
    assert.equal(
      store.value.OPENAI_TRANSCRIPTION_MODEL,
      'gpt-4o-mini-transcribe',
    );
  }
  for (const value of [
    'gpt-4o-transcribe',
    'gpt-4o-mini-transcribe',
    'whisper-1',
  ])
    assert.equal(
      checkConfig({ ...config, OPENAI_TRANSCRIPTION_MODEL: value }).find(
        (check) => check.name === 'OPENAI_TRANSCRIPTION_MODEL',
      )?.status,
      'ready',
    );
  assert.equal(
    checkConfig({
      ...config,
      OPENAI_TRANSCRIPTION_MODEL: 'unsupported-model',
    }).find((check) => check.name === 'OPENAI_TRANSCRIPTION_MODEL')?.status,
    'invalid',
  );
});

test('optional OpenAI proxy persists privately, rejects invalid values and can be cleared without clearing secrets', async (t) => {
  const { app, dir, store } = await fixture(t);
  assert.equal(store.configured(), true);
  assert.equal(
    store.checks().some((check) => check.name === 'OPENAI_PROXY_URL'),
    false,
  );
  const proxy = 'http://fixture-user:fixture-password@127.0.0.1:8080';
  const saved = await app.inject({
    method: 'POST',
    url: '/api/settings',
    remoteAddress: '127.0.0.1',
    headers,
    payload: { OPENAI_PROXY_URL: proxy, OPENAI_API_KEY: config.OPENAI_API_KEY },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(store.configured(), true);
  assert.equal(store.value.OPENAI_PROXY_URL, proxy);
  assert.ok(!saved.body.includes(proxy));
  assert.ok(!saved.body.includes('fixture-password'));
  const reloaded = new ConfigStore({
    envPath: join(dir, '.env'),
    generateToken: false,
  });
  assert.equal(reloaded.value.OPENAI_PROXY_URL, proxy);
  const rejected = await app.inject({
    method: 'POST',
    url: '/api/settings',
    remoteAddress: '127.0.0.1',
    headers,
    payload: { OPENAI_PROXY_URL: `${proxy}/private` },
  });
  assert.equal(rejected.statusCode, 400);
  assert.ok(!rejected.body.includes('fixture-password'));
  assert.equal(store.value.OPENAI_PROXY_URL, proxy);
  assert.equal(
    checkConfig({ ...config, OPENAI_PROXY_URL: `${proxy}/private` }).find(
      (check) => check.name === 'OPENAI_PROXY_URL',
    )?.status,
    'invalid',
  );
  const cleared = await app.inject({
    method: 'POST',
    url: '/api/settings',
    remoteAddress: '127.0.0.1',
    headers,
    payload: { OPENAI_PROXY_URL: '', OPENAI_API_KEY: '' },
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal(store.value.OPENAI_PROXY_URL, '');
  assert.equal(store.value.OPENAI_API_KEY, config.OPENAI_API_KEY);
  assert.equal(store.configured(), true);
  assert.ok(!cleared.body.includes(config.OPENAI_API_KEY));
  const direct = new ConfigStore({
    envPath: join(dir, '.env'),
    generateToken: false,
  });
  assert.equal(direct.value.OPENAI_PROXY_URL, '');
  assert.equal(direct.value.OPENAI_API_KEY, config.OPENAI_API_KEY);
  assert.equal(
    direct.checks().some((check) => check.name === 'OPENAI_PROXY_URL'),
    false,
  );
});

test('unconfigured UI/status remains available while token and calls fail closed', async (t) => {
  const { app } = await fixture(t, {
    OPENAI_API_KEY: '',
    TWILIO_AUTH_TOKEN: 'your_auth_token_here',
  });
  const response = await app.inject({
    method: 'GET',
    url: '/api/status',
    headers,
    remoteAddress: '127.0.0.1',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().configured, false);
  for (const [method, url] of [
    ['GET', '/api/token'],
    ['POST', '/api/calls'],
  ] as const) {
    const denied = await app.inject({
      method,
      url,
      headers,
      remoteAddress: '127.0.0.1',
      ...(method === 'POST' ? { payload: { to: '+14155550123' } } : {}),
    });
    assert.equal(denied.statusCode, 503);
    assert.equal(denied.json().error, 'CONFIGURATION_REQUIRED');
    assert.ok(
      denied
        .json()
        .checks.some(
          (check: any) =>
            check.name === 'OPENAI_API_KEY' && check.status === 'missing',
        ),
    );
  }
  assert.equal(
    checkConfig({
      ...config,
      PUBLIC_BASE_URL: 'http://phone.example.com',
    }).find((check) => check.name === 'PUBLIC_BASE_URL')?.status,
    'invalid',
  );
});

test('Twilio inbound webhooks require signature and correct account; valid callback without presence rejects safely', async (t) => {
  const { app } = await fixture(t);
  const url = '/voice/incoming';
  const body = {
    AccountSid: config.TWILIO_ACCOUNT_SID,
    CallSid: `CA${'1'.repeat(32)}`,
    From: '+14155550123',
    To: config.TWILIO_CALLER_NUMBER,
  };
  const send = (fields: typeof body, signature?: string) =>
    app.inject({
      method: 'POST',
      url,
      remoteAddress: '198.51.100.2',
      headers: {
        host: 'phone.example.com',
        'content-type': 'application/x-www-form-urlencoded',
        ...(signature ? { 'x-twilio-signature': signature } : {}),
      },
      payload: new URLSearchParams(fields).toString(),
    });
  assert.equal((await send(body)).statusCode, 403);
  const signature = twilio.getExpectedTwilioSignature(
    config.TWILIO_AUTH_TOKEN,
    `${config.PUBLIC_BASE_URL}${url}`,
    body,
  );
  const valid = await send(body, signature);
  assert.equal(valid.statusCode, 200);
  assert.match(valid.body, /Reject reason="busy"/);
  const foreign = { ...body, AccountSid: `AC${'9'.repeat(32)}` };
  const foreignSignature = twilio.getExpectedTwilioSignature(
    config.TWILIO_AUTH_TOKEN,
    `${config.PUBLIC_BASE_URL}${url}`,
    foreign,
  );
  assert.equal((await send(foreign, foreignSignature)).statusCode, 403);
  assert.equal(
    (await send({ ...body, To: '+14155550000' }, signature)).statusCode,
    403,
  );
});

test('browser token restricts identity and outgoing application; no provider call is needed to mint it', async (t) => {
  const { app } = await fixture(t);
  const response = await app.inject({
    method: 'GET',
    url: '/api/token',
    headers,
    remoteAddress: '127.0.0.1',
  });
  assert.equal(response.statusCode, 200);
  const claims = JSON.parse(
    Buffer.from(response.json().token.split('.')[1], 'base64url').toString(),
  );
  assert.equal(claims.grants.identity, 'ai-phone');
  assert.equal(
    claims.grants.voice.outgoing.application_sid,
    config.TWILIO_TWIML_APP_SID,
  );
  assert.equal(claims.grants.voice.incoming.allow, true);
});

test('media WebSocket handshake requires a valid signature before accepting stream messages', async (t) => {
  const { app } = await fixture(t);
  await app.ready();
  await assert.rejects(
    app.injectWS('/voice/media', { headers: { host: 'phone.example.com' } }),
    /403/,
  );
  const signature = twilio.getExpectedTwilioSignature(
    config.TWILIO_AUTH_TOKEN,
    `${config.PUBLIC_BASE_URL}/voice/media`,
    {},
  );
  const socket = await app.injectWS('/voice/media', {
    headers: { host: 'phone.example.com', 'x-twilio-signature': signature },
  });
  t.after(() => socket.terminate());
  // Even a signed socket cannot send audio until start credentials are verified.
  socket.send(JSON.stringify({ event: 'media', media: { payload: 'AA==' } }));
  await tick();
  assert.ok([WebSocket.CLOSING, WebSocket.CLOSED].includes(socket.readyState));
  socket.terminate();
});

test('shutdown requires local authentication and returns an explicit failure without closing when cleanup is unconfirmed', async (t) => {
  const { app, manager } = await fixture(t);
  const close = t.mock.method(manager, 'close', async () => {
    throw new SessionError('CALL_CLEANUP_UNCONFIRMED', 503);
  });
  const denied = await app.inject({
    method: 'POST',
    url: '/api/shutdown',
    remoteAddress: '127.0.0.1',
    headers: { host: '127.0.0.1:5050' },
  });
  assert.equal(denied.statusCode, 401);
  assert.equal(close.mock.callCount(), 0);
  const unsafe = await app.inject({
    method: 'POST',
    url: '/api/shutdown',
    remoteAddress: '127.0.0.1',
    headers,
  });
  assert.equal(unsafe.statusCode, 503);
  assert.equal(unsafe.json().error, 'CALL_CLEANUP_UNCONFIRMED');
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/status',
        remoteAddress: '127.0.0.1',
        headers,
      })
    ).statusCode,
    200,
  );
  close.mock.restore();
});

test('shutdown acknowledges safety only after awaited cleanup completes', async (t) => {
  const { app, manager } = await fixture(t);
  let finished = false;
  const close = t.mock.method(manager, 'close', async () => {
    await tick();
    finished = true;
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/shutdown',
    remoteAddress: '127.0.0.1',
    headers,
  });
  assert.equal(finished, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true, safeToStop: true });
  close.mock.restore();
});
