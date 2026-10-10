import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { request, createServer, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { parseCloudServiceConfig } from '../src/solo/cloud-service-config';
import {
  createCloudService,
  createCloudTestDeadline,
  createCloudVoiceSigner,
  registerCloudServiceSignals,
} from '../src/solo/cloud-service';
import type { CloudVoiceGrant } from '../src/solo/cloud-voice-join';

function configuration(
  time: number,
  directory = '/data/ai-phone',
  port = 8080,
) {
  return parseCloudServiceConfig(
    {
      AI_PHONE_RUNTIME_MODE: 'cloud',
      PORT: String(port),
      CLOUD_PUBLIC_ORIGIN: 'https://phone.example.com',
      PUBLIC_BASE_URL: 'https://phone.example.com',
      TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
      TWILIO_AUTH_TOKEN: '4'.repeat(32),
      TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}`,
      TWILIO_API_KEY_SECRET: 'fixture-cloud-offline-secret-123456',
      TWILIO_TWIML_APP_SID: `AP${'3'.repeat(32)}`,
      TWILIO_CALLER_NUMBER: '+12025550100',
      OPENAI_API_KEY: 'sk-fixture-cloud-offline-key',
      GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'fixture-google-offline-secret',
      GOOGLE_ALLOWED_EMAIL: 'fixture@example.com',
      GOOGLE_SUBJECT: 'fixture-pinned-google-subject',
      CLOUD_TRANSLATION_CAPABILITY_CONFIRMED: 'true',
      CLOUD_PUBLIC_CALLBACK_CONFIRMED: 'true',
      CLOUD_TEST_DEADLINE: new Date(time + 60000).toISOString(),
      CLOUD_TEST_TARGET_NUMBER: '+12025550101',
      CLOUD_JOURNAL_DIRECTORY: directory,
      CLOUD_JOURNAL_VOLUME_CONFIRMED: 'true',
      CLOUD_CALL_RESERVATION_USD_MICROS: '5000000',
      CLOUD_RATE_CHECKED_AT: new Date(time - 1000).toISOString(),
      CLOUD_RATE_VALID_UNTIL: new Date(time + 60000).toISOString(),
      CLOUD_TRIAL_RATE_BOUND_CONFIRMED: 'true',
    },
    time,
  );
}
function grant(time: number): CloudVoiceGrant {
  return {
    version: 1,
    authSessionId: 'offline-auth',
    principalId: 'offline-account',
    browserOwnerId: 'offline-browser',
    authEpoch: 1,
    controller: { leaseId: 'offline-lease', tabId: 'offline-tab', epoch: 1 },
    callId: 'offline-call',
    identity: 'offline-call-identity',
    issuedAt: time,
    expiresAt: time + 30000,
    incomingAllow: false,
    outgoingApplicationSid: `AP${'3'.repeat(32)}`,
    outgoing: { callId: 'offline-call', identity: 'offline-call-identity' },
  };
}
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
function httpCall(
  port: number,
  path: string,
  headers: Record<string, string> = {},
) {
  return new Promise<{
    status: number;
    body: string;
    headers: IncomingHttpHeaders;
  }>((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        headers: {
          host: 'phone.example.com',
          'x-forwarded-proto': 'https',
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('offline HTTP timeout')));
    req.end();
  });
}
async function serviceFixture(t: TestContext) {
  // Explicit test fixture, not a production fallback to an ephemeral volume.
  const directory = mkdtempSync(join(process.cwd(), 'cloud-entry-offline-'));
  let service: Awaited<ReturnType<typeof createCloudService>> | undefined;
  t.after(async () => {
    await service?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let time = Date.now();
  const config = configuration(time, directory, await unusedPort());
  const count = { provider: 0, bridge: 0, google: 0 };
  service = await createCloudService(config, {
    now: () => time,
    providerFactory: () => {
      count.provider += 1;
      return {
        create: async () => {
          throw new Error('offline supplier MUST NOT be called');
        },
        hangup: async () => {
          throw new Error('offline supplier MUST NOT be called');
        },
      };
    },
    bridgeFactory: () => {
      count.bridge += 1;
      throw new Error('offline bridge MUST NOT be opened');
    },
    googleFetch: async () => {
      count.google += 1;
      throw new Error('offline Google transport MUST NOT be called');
    },
  });
  return {
    service,
    config,
    count,
    directory,
    advance: () => {
      time = config.testDeadline;
    },
  };
}

test('real locked Twilio signer scopes the outgoing app and identity, disables incoming, clamps actual JWT expiry', async () => {
  const time = Date.now();
  const config = configuration(time);
  const voice = grant(time);
  const token = await createCloudVoiceSigner(config)(voice);
  const payload = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
  );
  assert.equal(payload.iss, config.providers.TWILIO_API_KEY_SID);
  assert.equal(payload.sub, config.providers.TWILIO_ACCOUNT_SID);
  assert.equal(payload.grants.identity, voice.identity);
  assert.equal(
    payload.grants.voice.outgoing.application_sid,
    voice.outgoingApplicationSid,
  );
  assert.equal(payload.grants.voice.incoming?.allow ?? false, false);
  assert.ok(payload.exp * 1000 <= voice.expiresAt);
  assert.ok(payload.exp * 1000 <= config.testDeadline);
  assert.deepEqual(Object.keys(payload.grants).sort(), ['identity', 'voice']);
});

test('Twilio signer refuses subsecond TTL, stale or wrong app/identity grants without widening default lifetime', async () => {
  const time = Date.now();
  const signer = createCloudVoiceSigner(configuration(time));
  const voice = grant(time);
  for (const invalid of [
    { ...voice, expiresAt: time + 900 },
    { ...voice, expiresAt: time - 1 },
    { ...voice, expiresAt: time + 60001 },
    { ...voice, issuedAt: time + 10000 },
    { ...voice, outgoingApplicationSid: `AP${'9'.repeat(32)}` },
    { ...voice, identity: 'ai-phone' },
    { ...voice, incomingAllow: true },
    { ...voice, outgoing: { ...voice.outgoing, callId: 'different-call' } },
  ])
    await assert.rejects(
      signer(invalid as CloudVoiceGrant),
      /CLOUD_VOICE_SIGNING_DENIED/,
    );
});

test('deadline expires current admission before deferred cleanup and never renews after clock moves back', async () => {
  let time = 1000;
  let cleaned = 0;
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  const deadline = createCloudTestDeadline({
    deadline: 2000,
    now: () => time,
    cleanup: async () => {
      cleaned += 1;
      await pending;
    },
  });
  deadline.assertCurrent();
  time = 2000;
  assert.throws(() => deadline.assertCurrent(), /CLOUD_TEST_EXPIRED/);
  await Promise.resolve();
  assert.equal(cleaned, 1);
  time = 1000;
  assert.throws(() => deadline.assertCurrent(), /CLOUD_TEST_EXPIRED/);
  resolve();
  await deadline.expireIfDue();
  assert.equal(cleaned, 1);
});

test('cleanup failure remains observable while all new admission stays closed', async () => {
  let time = 1000;
  let failures = 0;
  let attempts = 0;
  const deadline = createCloudTestDeadline({
    deadline: 2000,
    now: () => time,
    cleanup: async () => {
      attempts += 1;
      throw new Error('offline cleanup unknown');
    },
    onCleanupFailure: () => {
      failures += 1;
    },
  });
  time = 2000;
  await assert.rejects(deadline.expireIfDue(), /offline cleanup unknown/);
  assert.equal(failures, 1);
  assert.equal(attempts, 3);
  assert.throws(() => deadline.assertCurrent(), /CLOUD_TEST_EXPIRED/);
  deadline.cancel();
});

test('signal cleanup failure retains the same signal listener for a later retry and removes both after success', async () => {
  const signals = new EventEmitter();
  let attempts = 0;
  let failures = 0;
  const dispose = registerCloudServiceSignals(
    {
      close: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('offline uncertain cleanup');
      },
    },
    {
      signals,
      onCleanupFailure: () => {
        failures += 1;
      },
    },
  );
  signals.emit('SIGTERM');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(failures, 1);
  assert.equal(signals.listenerCount('SIGTERM'), 1);
  signals.emit('SIGTERM');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  dispose();
});

test(
  'full offline cloud factory starts real private/public HTTP listeners, filters routes, denies unauthenticated control',
  { timeout: 10000 },
  async (t) => {
    const f = await serviceFixture(t);
    const address = f.service.app.server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '127.0.0.1');
    const ingress = f.service.ingress.server.address();
    assert.ok(ingress && typeof ingress !== 'string');
    assert.equal(ingress.address, '0.0.0.0');
    assert.equal(ingress.port, f.config.runtime.port);
    const health = await httpCall(ingress.port, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).appId, 'ai-phone-solo');
    const sdk = await httpCall(ingress.port, '/vendor/twilio.min.js', {
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'no-cors',
      'sec-fetch-dest': 'script',
    });
    assert.equal(sdk.status, 200);
    const expectedSdk = readFileSync(
      join(process.cwd(), 'node_modules/@twilio/voice-sdk/dist/twilio.min.js'),
    );
    const servedSdk = Buffer.from(sdk.body, 'utf8');
    assert.deepEqual(servedSdk, expectedSdk);
    assert.equal(
      createHash('sha256').update(servedSdk).digest('hex'),
      createHash('sha256').update(expectedSdk).digest('hex'),
    );
    assert.deepEqual(f.count, { provider: 0, bridge: 0, google: 0 });
    const unauth = await httpCall(ingress.port, '/api/browser-session', {
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    });
    assert.equal(unauth.status, 401);
    assert.equal(JSON.parse(unauth.body).error, 'UNAUTHORIZED');
    assert.equal((await httpCall(ingress.port, '/api/config')).status, 404);
    assert.equal((await httpCall(ingress.port, '/api/token')).status, 404);
    assert.equal(
      (
        await httpCall(ingress.port, '/api/health', {
          'x-forwarded-proto': 'http',
        })
      ).status,
      403,
    );
    assert.deepEqual(f.count, { provider: 0, bridge: 0, google: 0 });
    assert.equal(existsSync(join(f.directory, '.env')), false);
  },
);

test(
  'second single-instance cloud factory cannot acquire the first journal or silently fall back',
  { timeout: 10000 },
  async (t) => {
    const f = await serviceFixture(t);
    await assert.rejects(createCloudService(f.config), /BUDGET_LOCKED/);
    assert.equal(
      (await httpCall(f.config.runtime.port, '/api/health')).status,
      200,
    );
    assert.deepEqual(f.count, { provider: 0, bridge: 0, google: 0 });
  },
);

test(
  'absolute trial deadline closes real listeners and private journal after confirmed idle cleanup',
  { timeout: 10000 },
  async (t) => {
    const f = await serviceFixture(t);
    f.advance();
    await f.service.deadline.expireIfDue();
    assert.equal(f.service.app.server.listening, false);
    assert.equal(f.service.ingress.server.listening, false);
    assert.equal(existsSync(join(f.directory, 'trial-budget.lock')), false);
    assert.deepEqual(f.count, { provider: 0, bridge: 0, google: 0 });
  },
);

test(
  'constructor failure after durable journal acquisition releases its startup lock',
  { timeout: 10000 },
  async (t) => {
    const directory = mkdtempSync(
      join(process.cwd(), 'cloud-entry-constructor-'),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const config = configuration(Date.now(), directory, await unusedPort());
    await assert.rejects(
      createCloudService(config, {
        googleFetch: 'invalid-offline-transport' as unknown as typeof fetch,
      }),
      /GOOGLE_OIDC_CONFIG_INVALID/,
    );
    assert.equal(existsSync(join(directory, 'trial-budget.lock')), false);
    const service = await createCloudService(config);
    await service.close();
  },
);

test(
  'deadline transient cleanup failure keeps real callback listeners and journal for its bounded retry',
  { timeout: 10000 },
  async (t) => {
    const f = await serviceFixture(t);
    const original = f.service.manager.close.bind(f.service.manager);
    let attempts = 0;
    f.service.manager.close = async () => {
      attempts += 1;
      if (attempts === 1)
        throw new Error('offline cleanup temporarily unknown');
      await original();
    };
    f.advance();
    const cleanup = f.service.deadline.expireIfDue();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1);
    assert.equal(f.service.ingress.server.listening, true);
    assert.equal(f.service.app.server.listening, true);
    assert.equal(existsSync(join(f.directory, 'trial-budget.lock')), true);
    assert.throws(
      () => f.service.deadline.assertCurrent(),
      /CLOUD_TEST_EXPIRED/,
    );
    await cleanup;
    assert.ok(attempts >= 2 && attempts <= 3);
    assert.equal(f.service.ingress.server.listening, false);
    assert.equal(f.service.app.server.listening, false);
    assert.equal(existsSync(join(f.directory, 'trial-budget.lock')), false);
  },
);
