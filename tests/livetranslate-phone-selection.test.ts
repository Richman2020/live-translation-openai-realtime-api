import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  parsePhoneTranslationSelection,
  freezePhoneTranslationSelection,
} from '../src/solo/aliyun-planb-config';
import { createCloudTranslationBridgeFactory } from '../src/solo/cloud-translation-selection';
import { parseCloudServiceConfig } from '../src/solo/cloud-service-config';
import { createCloudService } from '../src/solo/cloud-service';
import type { BridgeOptions } from '../src/solo/session-manager';
import {
  assertLiveTranslatePhoneConfig,
  type LiveTranslatePhoneConfig,
} from '../src/solo/livetranslate-phone-config';

const liveEnv = () => ({
  CLOUD_PHONE_TRANSLATION_PROVIDER: 'aliyun-livetranslate',
  ALIYUN_LIVETRANSLATE_WORKSPACE_ID: 'ws-offline-phone',
  ALIYUN_BEIJING_API_KEY: 'offline-fixture-not-a-real-key',
});
function selected() {
  const choice = parsePhoneTranslationSelection(liveEnv());
  assert.equal(choice.provider, 'aliyun-livetranslate');
  if (choice.provider !== 'aliyun-livetranslate') throw new Error('TEST_SETUP');
  return choice;
}
function cloudEnv(port = 8080): Record<string, string> {
  return {
    ...liveEnv(),
    AI_PHONE_RUNTIME_MODE: 'cloud',
    PORT: String(port),
    CLOUD_PUBLIC_ORIGIN: 'https://phone.example.com',
    PUBLIC_BASE_URL: 'https://phone.example.com',
    TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
    TWILIO_AUTH_TOKEN: '4'.repeat(32),
    TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}`,
    TWILIO_API_KEY_SECRET: 'offline-fixture-twilio-secret',
    TWILIO_TWIML_APP_SID: `AP${'3'.repeat(32)}`,
    TWILIO_CALLER_NUMBER: '+12025550100',
    GOOGLE_CLIENT_ID: 'offline.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'offline-fixture-google-secret',
    GOOGLE_ALLOWED_EMAIL: 'offline@example.com',
    GOOGLE_SUBJECT: 'offline-subject',
    CLOUD_PUBLIC_CALLBACK_CONFIRMED: 'true',
    CLOUD_TEST_TARGET_NUMBER: '+12025550101',
  };
}
const settings = {
  translationEngine: 'continuous-captions',
  outgoingCaptions: true,
} as BridgeOptions;
const bridge = () => ({ attach() {}, close() {} });

test('LiveTranslate remains default-off and default OpenAI never reads its key or workspace', () => {
  const env = {};
  for (const name of [
    'ALIYUN_BEIJING_API_KEY',
    'ALIYUN_LIVETRANSLATE_WORKSPACE_ID',
  ])
    Object.defineProperty(env, name, {
      get() {
        throw new Error('DEFAULT_MUST_NOT_READ_ALIYUN');
      },
    });
  assert.deepEqual(parsePhoneTranslationSelection(env), { provider: 'openai' });
  let openai = 0;
  let aliyun = 0;
  createCloudTranslationBridgeFactory(undefined, {
    openai: () => {
      openai += 1;
      return bridge();
    },
    liveTranslate: () => {
      aliyun += 1;
      return bridge();
    },
  })(settings);
  assert.equal(openai, 1);
  assert.equal(aliyun, 0);
});

test('explicit phone selection fixes Beijing model and Andre without creating a session', () => {
  const value = selected();
  assert.deepEqual(value.config, {
    region: 'beijing',
    workspaceId: 'ws-offline-phone',
    apiKey: 'offline-fixture-not-a-real-key',
    model: 'qwen3.8-livetranslate-flash-realtime',
    voice: 'Andre',
  });
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.config));
  assertLiveTranslatePhoneConfig(value.config);
});

test('invalid region, model, voice, key and workspace never silently fall back', () => {
  for (const override of [
    { ALIYUN_LIVETRANSLATE_REGION: 'singapore' },
    { ALIYUN_LIVETRANSLATE_MODEL: 'qwen3.5-livetranslate-flash-realtime' },
    { ALIYUN_LIVETRANSLATE_VOICE: 'Tina' },
    { ALIYUN_LIVETRANSLATE_WORKSPACE_ID: '' },
    { ALIYUN_LIVETRANSLATE_WORKSPACE_ID: 'ws/other' },
    { ALIYUN_LIVETRANSLATE_WORKSPACE_ID: 'https://example.com' },
    { ALIYUN_LIVETRANSLATE_PROXY_URL: 'https://proxy.example/path' },
    { ALIYUN_BEIJING_API_KEY: '' },
    { ALIYUN_BEIJING_API_KEY: ' offline-fixture ' },
    { ALIYUN_BEIJING_API_KEY: 'offline\nfixture' },
  ])
    assert.throws(() =>
      parsePhoneTranslationSelection({ ...liveEnv(), ...override }),
    );
  assert.throws(() =>
    parsePhoneTranslationSelection({
      CLOUD_PHONE_TRANSLATION_PROVIDER: 'auto',
    }),
  );
});

test('per-service snapshot is immutable and requires the existing phone engine', () => {
  const config = { ...selected().config };
  const value = { provider: 'aliyun-livetranslate' as const, config };
  const snapshot = freezePhoneTranslationSelection(value);
  assert.notEqual(snapshot, value);
  assert.notEqual(
    snapshot.provider === 'aliyun-livetranslate' && snapshot.config,
    config,
  );
  const seen: string[] = [];
  let otherCalls = 0;
  const factory = createCloudTranslationBridgeFactory(value, {
    openai: () => {
      otherCalls += 1;
      return bridge();
    },
    planB: () => {
      otherCalls += 1;
      return bridge();
    },
    liveTranslate: (options, frozen) => {
      assert.ok(Object.isFrozen(frozen));
      assert.equal(options.outgoingCaptions, false);
      assert.equal(options.captionFailureEndsCall, false);
      seen.push(frozen.workspaceId);
      return bridge();
    },
  });
  config.workspaceId = 'ws-mutated-after-start';
  factory(settings);
  factory(settings);
  assert.deepEqual(seen, ['ws-offline-phone', 'ws-offline-phone']);
  assert.equal(otherCalls, 0);
  assert.throws(
    () => factory({ ...settings, translationEngine: 'legacy' }),
    /CLOUD_LIVETRANSLATE_ENGINE_DENIED/u,
  );
});

test('model creation failure cannot select an alternative provider', () => {
  let otherCalls = 0;
  const factory = createCloudTranslationBridgeFactory(selected(), {
    openai: () => {
      otherCalls += 1;
      return bridge();
    },
    planB: () => {
      otherCalls += 1;
      return bridge();
    },
    liveTranslate: () => {
      throw new Error('OFFLINE_FAILURE');
    },
  });
  assert.throws(() => factory(settings), /OFFLINE_FAILURE/u);
  assert.equal(otherCalls, 0);
});

test('explicit LiveTranslate cloud configuration does not read OpenAI credentials', () => {
  const env = cloudEnv();
  Object.defineProperty(env, 'OPENAI_API_KEY', {
    get() {
      throw new Error('OPENAI_MUST_NOT_BE_READ');
    },
  });
  const config = parseCloudServiceConfig(env);
  assert.equal(config.translationProvider?.provider, 'aliyun-livetranslate');
  assert.equal(config.providers.OPENAI_API_KEY, '');
  assert.throws(() =>
    assertLiveTranslatePhoneConfig({
      ...selected().config,
      voice: 'Tina',
    } as unknown as LiveTranslatePhoneConfig),
  );
});

test('config-only startup reports two LiveTranslate sessions and no key or phone duration cap', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/solo/cloud-index.ts', '--check'],
    {
      env: {
        ...cloudEnv(),
        PATH: process.env.PATH,
        NODE_OPTIONS: process.env.NODE_OPTIONS,
        LIVETRANSLATE_OFFLINE_GUARD_DIR:
          process.env.LIVETRANSLATE_OFFLINE_GUARD_DIR,
      },
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 15000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(result.stdout.trim());
  assert.equal(info.translationProvider, 'aliyun-livetranslate');
  assert.equal(info.aliyunVoice, 'Andre');
  assert.equal(info.aliyunRealtimeSessionsPerCall, 2);
  assert.equal(info.externalProvidersContacted, false);
  assert.equal(info.openaiSocketsPerCall, 0);
  assert.deepEqual(info.openaiModels, []);
  assert.deepEqual(info.aliyunModels, ['qwen3.8-livetranslate-flash-realtime']);
  assert.equal(info.applicationCallDurationLimitSeconds, null);
  assert.equal(info.applicationBudgetEnabled, false);
  assert.equal(result.stdout.includes('offline-fixture-not-a-real-key'), false);
});

test('selected LiveTranslate service startup, health and unauthorized dial do zero supplier work', async (t) => {
  const listener = createServer();
  await new Promise<void>((resolve) => {
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => {
    listener.close(() => resolve());
  });
  let calls = 0;
  const unexpected = () => {
    calls += 1;
    throw new Error('OFFLINE_UNEXPECTED_CALL');
  };
  const service = await createCloudService(
    parseCloudServiceConfig(cloudEnv(address.port)),
    {
      providerFactory: unexpected,
      translationFactories: {
        openai: unexpected,
        planB: unexpected,
        liveTranslate: unexpected,
      },
      googleFetch: async () => unexpected(),
    },
  );
  t.after(() => service.close());
  const health = await service.app.inject({
    method: 'GET',
    url: '/api/health',
  });
  assert.equal(health.statusCode, 200);
  const denied = await service.app.inject({
    method: 'POST',
    url: '/api/calls',
    payload: { to: '+12025550101', translationProvider: 'openai' },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(calls, 0);
});
