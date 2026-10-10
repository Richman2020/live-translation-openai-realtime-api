import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import {
  CLOUD_SERVICE_REQUIRED_ENV,
  parseCloudServiceConfig,
} from '../src/solo/cloud-service-config';

const now = 1780000000000;
function fixture(time = now) {
  return {
    AI_PHONE_RUNTIME_MODE: 'cloud',
    PORT: '8080',
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
    CLOUD_TEST_DEADLINE: new Date(time + 3600000).toISOString(),
    CLOUD_TEST_TARGET_NUMBER: '+12025550101',
    CLOUD_JOURNAL_DIRECTORY: '/data/ai-phone',
    CLOUD_JOURNAL_VOLUME_CONFIRMED: 'true',
    CLOUD_CALL_RESERVATION_USD_MICROS: '5000000',
    CLOUD_RATE_CHECKED_AT: new Date(time - 1000).toISOString(),
    CLOUD_RATE_VALID_UNTIL: new Date(time + 3600000).toISOString(),
    CLOUD_TRIAL_RATE_BOUND_CONFIRMED: 'true',
  };
}

test('cloud trial config pins one instance, one bounded call and exact callback without a local token', () => {
  const config = parseCloudServiceConfig(fixture(), now);
  assert.equal(config.runtime.host, '0.0.0.0');
  assert.equal(config.runtime.mediaOrigin, 'wss://phone.example.com');
  assert.equal(config.runtime.warmInstances, 1);
  assert.equal(
    config.google.redirectUri,
    'https://phone.example.com/auth/google/callback',
  );
  assert.equal(config.providers.LOCAL_ACCESS_TOKEN, '');
  assert.equal(config.providers.OPENAI_REALTIME_MODEL, 'gpt-realtime-1.5');
  assert.equal(config.budget.maxCalls, 1);
  assert.equal(config.budget.maxWallClockMs, 300000);
  assert.equal(config.budget.budgetUsdMicros, 5_000_000);
  assert.equal(config.budget.worstCaseCallUsdMicros, 5_000_000);
  assert.equal(config.budget.rates.validUntil, config.testDeadline);
  assert.equal(config.outgoingPairedCaptions, false);
  assert.equal(Object.isFrozen(config.providers), true);
  assert.equal(Object.isFrozen(config.budget.rates), true);
  assert.equal(
    CLOUD_SERVICE_REQUIRED_ENV.includes('LOCAL_ACCESS_TOKEN' as never),
    false,
  );
});

test('every missing deployment requirement fails closed with field/code only', () => {
  for (const name of CLOUD_SERVICE_REQUIRED_ENV) {
    const values: Record<string, string> = fixture();
    delete values[name];
    assert.throws(
      () => parseCloudServiceConfig(values, now),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(
          error.message,
          /fixture-cloud-offline-secret|fixture-google-offline-secret|\+12025550101/,
        );
        return true;
      },
    );
  }
});

test('unconfirmed capabilities, callback reachability, cost bounds and volume never become ready by URL format', () => {
  for (const name of [
    'CLOUD_TRANSLATION_CAPABILITY_CONFIRMED',
    'CLOUD_PUBLIC_CALLBACK_CONFIRMED',
    'CLOUD_TRIAL_RATE_BOUND_CONFIRMED',
    'CLOUD_JOURNAL_VOLUME_CONFIRMED',
  ])
    for (const value of ['false', '1', 'TRUE'])
      assert.throws(
        () => parseCloudServiceConfig({ ...fixture(), [name]: value }, now),
        { message: `CLOUD_CONFIG_UNCONFIRMED:${name}` },
      );
});

test('trial rejects expired/extended deadlines, unsupported regions of target, cost overflow and temporary storage', () => {
  const invalid = [
    { CLOUD_TEST_DEADLINE: new Date(now).toISOString() },
    { CLOUD_TEST_DEADLINE: new Date(now + 3600001).toISOString() },
    { CLOUD_TEST_DEADLINE: '2026-05-28T00:00:00Z' },
    { CLOUD_RATE_CHECKED_AT: new Date(now + 1).toISOString() },
    { CLOUD_RATE_VALID_UNTIL: new Date(now + 3599999).toISOString() },
    { CLOUD_RATE_CHECKED_AT: new Date(now - 86400000).toISOString() },
    { CLOUD_TEST_TARGET_NUMBER: '+442071838750' },
    { CLOUD_TEST_TARGET_NUMBER: '+12021110101' },
    { CLOUD_JOURNAL_DIRECTORY: '/tmp/private-phone-volume' },
    { CLOUD_JOURNAL_DIRECTORY: 'relative-volume' },
    { CLOUD_JOURNAL_DIRECTORY: '/data/../data/private' },
    { CLOUD_JOURNAL_DIRECTORY: '/' },
    { CLOUD_CALL_RESERVATION_USD_MICROS: '5000001' },
    { CLOUD_CALL_RESERVATION_USD_MICROS: '0' },
    { CLOUD_CALL_RESERVATION_USD_MICROS: '1.5' },
    { CLOUD_WARM_INSTANCES: '2' },
    { PUBLIC_BASE_URL: 'https://other.example.com' },
    { PUBLIC_BASE_URL: 'https://phone.example.com/' },
    { OPENAI_REALTIME_MODEL: 'different-model' },
    { OPENAI_PROXY_URL: 'https://proxy.example.com' },
    { CLOUD_OUTGOING_PAIRED_CAPTIONS_ENABLED: '1' },
    { CLOUD_OUTGOING_PAIRED_CAPTIONS_ENABLED: 'TRUE' },
  ];
  for (const values of invalid)
    assert.throws(() =>
      parseCloudServiceConfig({ ...fixture(), ...values }, now),
    );
});

test('third-party email requires pinned subject or independently configured Workspace domain', () => {
  const values = { ...fixture(), GOOGLE_SUBJECT: undefined };
  assert.throws(
    () => parseCloudServiceConfig(values, now),
    /GOOGLE_OIDC_CONFIG_INVALID/,
  );
  assert.doesNotThrow(() =>
    parseCloudServiceConfig(
      { ...values, GOOGLE_HOSTED_DOMAIN: 'example.com' },
      now,
    ),
  );
  assert.doesNotThrow(() =>
    parseCloudServiceConfig(
      { ...values, GOOGLE_ALLOWED_EMAIL: 'fixture@gmail.com' },
      now,
    ),
  );
});

test('config-only executable terminates promptly and never contacts suppliers or creates a local credential', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/solo/cloud-index.ts', '--check'],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, ...fixture(Date.now()) },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    mode: 'cloud',
    configOnly: true,
    externalProvidersContacted: false,
    translationEngine: 'continuous-captions',
    openaiSocketsPerCall: 3,
    optionalOutgoingCaptionSockets: 0,
    outgoingPairedCaptions: false,
    openaiModels: [
      'gpt-realtime-translate',
      'gpt-4o-transcribe',
      'gpt-realtime-1.5',
    ],
    maxCalls: 1,
    maxCallSeconds: 300,
    singleInstance: true,
  });
  assert.equal(result.stderr, '');
});

test('paired outgoing captions require an explicit flag and metadata exposes the extra charge-bearing sockets', () => {
  const values = {
    ...fixture(Date.now()),
    CLOUD_OUTGOING_PAIRED_CAPTIONS_ENABLED: 'true',
  };
  assert.equal(parseCloudServiceConfig(values).outgoingPairedCaptions, true);
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/solo/cloud-index.ts', '--check'],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, ...values },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(result.stdout);
  assert.equal(metadata.openaiSocketsPerCall, 5);
  assert.equal(metadata.optionalOutgoingCaptionSockets, 2);
  assert.equal(metadata.outgoingPairedCaptions, true);
  assert.deepEqual(metadata.openaiModels, [
    'gpt-realtime-translate',
    'gpt-4o-transcribe',
    'gpt-realtime-1.5',
    'gpt-live-transcribe',
  ]);
});
