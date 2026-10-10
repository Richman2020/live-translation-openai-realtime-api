import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import {
  CLOUD_SERVICE_REQUIRED_ENV,
  parseCloudServiceConfig,
} from '../src/solo/cloud-service-config';
import {
  parseCloudWebVerificationConfig,
  selectCloudServiceMode,
} from '../src/solo/cloud-web-verification-config';

type Environment = Record<string, string | undefined>;
const now = 1_780_000_000_000;
const paidFields = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_TWIML_APP_SID',
  'TWILIO_CALLER_NUMBER',
  'OPENAI_API_KEY',
  'OPENAI_REALTIME_MODEL',
  'OPENAI_TRANSCRIPTION_MODEL',
  'OPENAI_PROXY_URL',
  'CLOUD_TRANSLATION_CAPABILITY_CONFIRMED',
  'CLOUD_PUBLIC_CALLBACK_CONFIRMED',
  'CLOUD_TRIAL_RATE_BOUND_CONFIRMED',
  'CLOUD_JOURNAL_VOLUME_CONFIRMED',
  'CLOUD_JOURNAL_DIRECTORY',
  'CLOUD_TEST_TARGET_NUMBER',
  'CLOUD_CALL_RESERVATION_USD_MICROS',
  'CLOUD_RATE_CHECKED_AT',
  'CLOUD_RATE_VALID_UNTIL',
  'CLOUD_OUTGOING_PAIRED_CAPTIONS_ENABLED',
] as const;
const paidFieldNames = new Set<string>(paidFields);
const paidFlags = [
  'CLOUD_TRANSLATION_CAPABILITY_CONFIRMED',
  'CLOUD_PUBLIC_CALLBACK_CONFIRMED',
  'CLOUD_TRIAL_RATE_BOUND_CONFIRMED',
  'CLOUD_JOURNAL_VOLUME_CONFIRMED',
] as const;

function webFixture(time = now): Environment {
  return {
    CLOUD_SERVICE_MODE: 'web-verification',
    AI_PHONE_RUNTIME_MODE: 'cloud',
    PORT: '8080',
    CLOUD_PUBLIC_ORIGIN: 'https://phone.example.com',
    PUBLIC_BASE_URL: 'https://phone.example.com',
    CLOUD_WARM_INSTANCES: '1',
    GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'fixture-google-offline-secret',
    GOOGLE_ALLOWED_EMAIL: 'fixture@example.com',
    GOOGLE_SUBJECT: 'fixture-pinned-google-subject',
    CLOUD_TEST_DEADLINE: new Date(time + 3_600_000).toISOString(),
  };
}

function phoneFixture(): Environment {
  return {
    ...webFixture(),
    CLOUD_SERVICE_MODE: 'phone',
    TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
    TWILIO_AUTH_TOKEN: '4'.repeat(32),
    TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}`,
    TWILIO_API_KEY_SECRET: 'fixture-cloud-offline-secret-123456',
    TWILIO_TWIML_APP_SID: `AP${'3'.repeat(32)}`,
    TWILIO_CALLER_NUMBER: '+12025550100',
    OPENAI_API_KEY: 'sk-fixture-cloud-offline-key',
    CLOUD_TRANSLATION_CAPABILITY_CONFIRMED: 'true',
    CLOUD_PUBLIC_CALLBACK_CONFIRMED: 'true',
    CLOUD_TEST_TARGET_NUMBER: '+12025550101',
    CLOUD_JOURNAL_DIRECTORY: '/data/ai-phone',
    CLOUD_JOURNAL_VOLUME_CONFIRMED: 'true',
    CLOUD_CALL_RESERVATION_USD_MICROS: '5000000',
    CLOUD_RATE_CHECKED_AT: new Date(now - 1000).toISOString(),
    CLOUD_RATE_VALID_UNTIL: new Date(now + 3_600_000).toISOString(),
    CLOUD_TRIAL_RATE_BOUND_CONFIRMED: 'true',
  };
}

test('web verification parses without provider, target, rates or volume', () => {
  const env = webFixture();
  for (const field of paidFields) assert.equal(env[field], undefined);
  const config = parseCloudWebVerificationConfig(env, now);
  assert.deepEqual(Object.keys(config).sort(), [
    'google',
    'mode',
    'runtime',
    'testDeadline',
  ]);
  assert.equal(config.mode, 'web-verification');
  assert.equal(config.runtime.mode, 'cloud');
  assert.equal(config.runtime.host, '0.0.0.0');
  assert.equal(config.runtime.port, 8080);
  assert.equal(config.runtime.warmInstances, 1);
  assert.equal(config.runtime.publicOrigin, 'https://phone.example.com');
  assert.equal(config.runtime.mediaOrigin, 'wss://phone.example.com');
  assert.equal(
    config.google.redirectUri,
    'https://phone.example.com/auth/google/callback',
  );
  assert.equal(config.testDeadline, now + 3_600_000);
});

test('web verification does not require paid operator attestations', () => {
  for (const value of [undefined, 'false', '', '1', 'TRUE']) {
    const env = webFixture();
    for (const flag of paidFlags) env[flag] = value;
    assert.equal(
      parseCloudWebVerificationConfig(env, now).mode,
      'web-verification',
    );
  }
});

test('web verification never reads paid configuration, even when getters throw', () => {
  const env = webFixture();
  for (const field of paidFields)
    Object.defineProperty(env, field, {
      enumerable: true,
      get() {
        throw new Error(`PAID_FIELD_READ:${field}`);
      },
    });
  const guarded = new Proxy(env, {
    get(target, name, receiver) {
      if (
        typeof name === 'string' &&
        (/^(TWILIO_|OPENAI_)/.test(name) || paidFieldNames.has(name))
      )
        throw new Error(`PAID_FIELD_READ:${name}`);
      return Reflect.get(target, name, receiver);
    },
  });
  assert.equal(
    parseCloudWebVerificationConfig(guarded, now).mode,
    'web-verification',
  );
});

test('service mode defaults only when absent and rejects empty or misspelled values', () => {
  assert.equal(selectCloudServiceMode({}), 'phone');
  assert.equal(
    selectCloudServiceMode({ CLOUD_SERVICE_MODE: undefined }),
    'phone',
  );
  assert.equal(
    selectCloudServiceMode({ CLOUD_SERVICE_MODE: 'phone' }),
    'phone',
  );
  assert.equal(
    selectCloudServiceMode({ CLOUD_SERVICE_MODE: 'web-verification' }),
    'web-verification',
  );
  for (const mode of [
    '',
    'web',
    'Phone',
    'WEB-VERIFICATION',
    ' phone',
    'phone\n',
  ]) {
    const env = { ...webFixture(), CLOUD_SERVICE_MODE: mode };
    assert.throws(
      () => selectCloudServiceMode(env),
      /^Error: CLOUD_SERVICE_MODE_INVALID$/,
    );
    assert.throws(
      () => parseCloudWebVerificationConfig(env, now),
      /^Error: CLOUD_SERVICE_MODE_INVALID$/,
    );
    assert.throws(
      () => parseCloudServiceConfig(env, now),
      /^Error: CLOUD_SERVICE_MODE_INVALID$/,
    );
  }
});

test('web and phone parsers cannot reinterpret each other or use missing mode', () => {
  assert.throws(
    () => parseCloudServiceConfig(webFixture(), now),
    /^Error: CLOUD_PHONE_MODE_REQUIRED$/,
  );
  assert.throws(
    () => parseCloudWebVerificationConfig(phoneFixture(), now),
    /^Error: CLOUD_WEB_MODE_REQUIRED$/,
  );
  const implicitPhone = webFixture();
  delete implicitPhone.CLOUD_SERVICE_MODE;
  assert.throws(
    () => parseCloudWebVerificationConfig(implicitPhone, now),
    /^Error: CLOUD_WEB_MODE_REQUIRED$/,
  );
  assert.throws(() => parseCloudServiceConfig(implicitPhone, now));
});

test('default phone mode retains all existing required gates and four confirmations', () => {
  const env = phoneFixture();
  delete env.CLOUD_SERVICE_MODE;
  const config = parseCloudServiceConfig(env, now);
  assert.equal(config.budget.maxCalls, 1);
  assert.equal(config.budget.maxWallClockMs, 300_000);
  assert.equal(config.budget.budgetUsdMicros, 5_000_000);
  for (const field of CLOUD_SERVICE_REQUIRED_ENV) {
    const missing = { ...env };
    delete missing[field];
    assert.throws(() => parseCloudServiceConfig(missing, now), Error, field);
  }
  for (const field of paidFlags)
    for (const value of ['false', '', '1', 'TRUE']) {
      const unconfirmed = { ...env, [field]: value };
      assert.throws(
        () => parseCloudServiceConfig(unconfirmed, now),
        Error,
        field,
      );
    }
});

test('web verification still requires Google credentials, identity and runtime fields', () => {
  for (const field of [
    'AI_PHONE_RUNTIME_MODE',
    'PORT',
    'CLOUD_PUBLIC_ORIGIN',
    'PUBLIC_BASE_URL',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_ALLOWED_EMAIL',
    'CLOUD_TEST_DEADLINE',
  ])
    for (const value of [undefined, '']) {
      const env = { ...webFixture(), [field]: value };
      assert.throws(
        () => parseCloudWebVerificationConfig(env, now),
        Error,
        field,
      );
    }
});

test('web verification requires explicit cloud runtime and a valid supplied port', () => {
  for (const mode of ['local', 'Cloud', 'unknown'])
    assert.throws(() =>
      parseCloudWebVerificationConfig(
        { ...webFixture(), AI_PHONE_RUNTIME_MODE: mode },
        now,
      ),
    );
  for (const port of ['0', '-1', '65536', '8080.0', '8e3', ' 8080', '8080\n'])
    assert.throws(() =>
      parseCloudWebVerificationConfig({ ...webFixture(), PORT: port }, now),
    );
  for (const port of ['1', '65535'])
    assert.equal(
      parseCloudWebVerificationConfig({ ...webFixture(), PORT: port }, now)
        .runtime.port,
      Number(port),
    );
});

test('web verification requires public HTTPS and exact callback origin', () => {
  for (const origin of [
    'http://phone.example.com',
    'https://localhost',
    'https://127.0.0.1',
    'https://0.0.0.0',
    'https://phone.localhost',
    'https://user:password@phone.example.com',
    'https://phone.example.com/path',
    'https://phone.example.com?redirect=elsewhere',
    'https://phone.example.com#fragment',
    'https://phone.example.com/',
  ])
    assert.throws(() =>
      parseCloudWebVerificationConfig(
        {
          ...webFixture(),
          CLOUD_PUBLIC_ORIGIN: origin,
          PUBLIC_BASE_URL: origin,
        },
        now,
      ),
    );
  for (const base of [
    'http://phone.example.com',
    'https://elsewhere.example.com',
    'https://phone.example.com/',
    'https://phone.example.com/auth/google/callback',
  ])
    assert.throws(() =>
      parseCloudWebVerificationConfig(
        { ...webFixture(), PUBLIC_BASE_URL: base },
        now,
      ),
    );
});

test('web verification keeps the single warm instance requirement', () => {
  for (const warm of ['0', '2', '01', 'true', '1 '])
    assert.throws(() =>
      parseCloudWebVerificationConfig(
        { ...webFixture(), CLOUD_WARM_INSTANCES: warm },
        now,
      ),
    );
});

test('web verification deadline is canonical UTC, future and at most one hour', () => {
  for (const deadline of [
    new Date(now).toISOString(),
    new Date(now - 1).toISOString(),
    new Date(now + 3_600_001).toISOString(),
    new Date(now + 1000).toISOString().replace('.000Z', 'Z'),
    new Date(now + 1000).toISOString().replace('Z', '+00:00'),
    'not-a-date',
  ])
    assert.throws(() =>
      parseCloudWebVerificationConfig(
        { ...webFixture(), CLOUD_TEST_DEADLINE: deadline },
        now,
      ),
    );
  for (const milliseconds of [1, 3_600_000])
    assert.equal(
      parseCloudWebVerificationConfig(
        {
          ...webFixture(),
          CLOUD_TEST_DEADLINE: new Date(now + milliseconds).toISOString(),
        },
        now,
      ).testDeadline,
      now + milliseconds,
    );
  for (const invalidNow of [NaN, Infinity, -1, now + 0.5])
    assert.throws(
      () => parseCloudWebVerificationConfig(webFixture(), invalidNow),
      /^Error: CLOUD_CLOCK_INVALID$/,
    );
});

test('third-party Google identity requires a hosted domain or pinned subject', () => {
  const env = webFixture();
  delete env.GOOGLE_SUBJECT;
  assert.throws(
    () => parseCloudWebVerificationConfig(env, now),
    /GOOGLE_OIDC_CONFIG_INVALID/,
  );
  const withDomain = parseCloudWebVerificationConfig(
    { ...env, GOOGLE_HOSTED_DOMAIN: 'example.com' },
    now,
  );
  assert.equal(withDomain.google.expectedHostedDomain, 'example.com');
  assert.equal(
    parseCloudWebVerificationConfig(webFixture(), now).google
      .pinnedGoogleSubject,
    'fixture-pinned-google-subject',
  );
  const gmail = parseCloudWebVerificationConfig(
    { ...env, GOOGLE_ALLOWED_EMAIL: 'fixture@gmail.com' },
    now,
  );
  assert.equal(gmail.google.allowedEmail, 'fixture@gmail.com');
});

test('invalid Google authority and malformed identity fail without printing secrets', () => {
  for (const patch of [
    { GOOGLE_ALLOWED_EMAIL: 'not-an-email' },
    { GOOGLE_CLIENT_ID: 'fixture\nclient' },
    { GOOGLE_CLIENT_SECRET: 'fixture\nsecret' },
    { GOOGLE_SUBJECT: 'fixture\nsubject' },
    { GOOGLE_SUBJECT: '' },
    { GOOGLE_HOSTED_DOMAIN: '' },
    { GOOGLE_HOSTED_DOMAIN: 'https://example.com' },
    { GOOGLE_HOSTED_DOMAIN: 'example.com/path' },
  ]) {
    const env = { ...webFixture(), ...patch };
    assert.throws(
      () => parseCloudWebVerificationConfig(env, now),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes('fixture-google-offline-secret'));
        assert.ok(!error.message.includes('fixture\nsecret'));
        return true;
      },
    );
  }
});

test('parsed web configuration is a deeply frozen snapshot of active identity and bounds', () => {
  const env = webFixture();
  const config = parseCloudWebVerificationConfig(env, now);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.runtime));
  assert.ok(Object.isFrozen(config.google));
  Object.assign(env, {
    CLOUD_SERVICE_MODE: 'phone',
    PORT: '9090',
    CLOUD_PUBLIC_ORIGIN: 'https://other.example.com',
    PUBLIC_BASE_URL: 'https://other.example.com',
    GOOGLE_CLIENT_SECRET: 'different-fixture-offline-secret',
    GOOGLE_ALLOWED_EMAIL: 'other@example.com',
    GOOGLE_SUBJECT: 'other-fixture-subject',
    CLOUD_TEST_DEADLINE: new Date(now + 1).toISOString(),
  });
  assert.equal(config.mode, 'web-verification');
  assert.equal(config.runtime.port, 8080);
  assert.equal(config.runtime.publicOrigin, 'https://phone.example.com');
  assert.equal(config.google.allowedEmail, 'fixture@example.com');
  assert.equal(config.google.clientSecret, 'fixture-google-offline-secret');
  assert.equal(
    config.google.pinnedGoogleSubject,
    'fixture-pinned-google-subject',
  );
  assert.equal(config.testDeadline, now + 3_600_000);
});

test('web-only cloud check exits without paid configuration and reports calls disabled', () => {
  const env = webFixture(Date.now());
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/solo/cloud-index.ts', '--check'],
    { cwd: process.cwd(), env, encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.signal, null);
  assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout);
  assert.equal(result.serviceMode, 'web-verification');
  assert.equal(result.callsEnabled, false);
  assert.equal(result.supplierCallsEnabled, false);
  const output = `${child.stdout}${child.stderr}`;
  for (const value of [
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_ALLOWED_EMAIL,
    env.GOOGLE_SUBJECT,
    '+12025550101',
  ]) {
    assert.ok(value);
    assert.ok(
      !output.includes(value),
      'check output disclosed configured identity',
    );
  }
  for (const field of paidFields) assert.equal(env[field], undefined);
});

test('cloud check rejects empty or unknown mode instead of selecting a service', () => {
  for (const mode of ['', 'web', 'Phone']) {
    const env: Environment = {
      ...webFixture(Date.now()),
      CLOUD_SERVICE_MODE: mode,
    };
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/solo/cloud-index.ts', '--check'],
      { cwd: process.cwd(), env, encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.equal(child.signal, null);
    assert.match(
      `${child.stdout}${child.stderr}`,
      /CLOUD_SERVICE_MODE_INVALID/,
    );
    assert.ok(
      !`${child.stdout}${child.stderr}`.includes(env.GOOGLE_CLIENT_SECRET!),
    );
    assert.ok(
      !`${child.stdout}${child.stderr}`.includes(env.GOOGLE_ALLOWED_EMAIL!),
    );
  }
});

test('default phone cloud check still rejects absent paid prerequisites', () => {
  const env = webFixture(Date.now());
  delete env.CLOUD_SERVICE_MODE;
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/solo/cloud-index.ts', '--check'],
    { cwd: process.cwd(), env, encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.equal(child.signal, null);
  assert.match(
    `${child.stdout}${child.stderr}`,
    /CLOUD_CONFIG_INVALID:TWILIO_ACCOUNT_SID/,
  );
  assert.ok(
    !`${child.stdout}${child.stderr}`.includes(env.GOOGLE_CLIENT_SECRET!),
  );
  assert.ok(
    !`${child.stdout}${child.stderr}`.includes(env.GOOGLE_ALLOWED_EMAIL!),
  );
});
