import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import type { request as HttpsRequest } from 'node:https';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type WebSocket from 'ws';

import {
  parsePhoneTranslationSelection,
  assertAliyunPlanBConfig,
  type PhoneTranslationSelection,
} from '../src/solo/aliyun-planb-config';
import {
  createPlanBFetch,
  createPlanBWebSocket,
} from '../src/solo/aliyun-planb-network';
import { createCloudTranslationBridgeFactory } from '../src/solo/cloud-translation-selection';
import { parseCloudServiceConfig } from '../src/solo/cloud-service-config';
import { createCloudService } from '../src/solo/cloud-service';
import type { BridgeOptions } from '../src/solo/session-manager';

function selection(region: 'beijing' | 'singapore' = 'beijing') {
  const value = parsePhoneTranslationSelection({
    CLOUD_PHONE_TRANSLATION_PROVIDER: 'aliyun-plan-b',
    ALIYUN_PLAN_B_REGION: region,
    ALIYUN_BEIJING_API_KEY: 'offline-beijing-fixture',
    ALIYUN_SINGAPORE_API_KEY: 'offline-singapore-fixture',
  });
  assert.equal(value.provider, 'aliyun-plan-b');
  return value as Extract<
    PhoneTranslationSelection,
    { provider: 'aliyun-plan-b' }
  >;
}
function cloudEnv(port = 8080): Record<string, string> {
  return {
    AI_PHONE_RUNTIME_MODE: 'cloud',
    PORT: String(port),
    CLOUD_PUBLIC_ORIGIN: 'https://phone.example.com',
    PUBLIC_BASE_URL: 'https://phone.example.com',
    TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
    TWILIO_AUTH_TOKEN: '4'.repeat(32),
    TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}`,
    TWILIO_API_KEY_SECRET: 'offline-fixture-secret-123456',
    TWILIO_TWIML_APP_SID: `AP${'3'.repeat(32)}`,
    TWILIO_CALLER_NUMBER: '+12025550100',
    OPENAI_API_KEY: 'sk-offline-fixture-only',
    GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'offline-fixture-google-secret',
    GOOGLE_ALLOWED_EMAIL: 'fixture@example.com',
    GOOGLE_SUBJECT: 'fixture-subject',
    CLOUD_PUBLIC_CALLBACK_CONFIRMED: 'true',
    CLOUD_TEST_TARGET_NUMBER: '+12025550101',
  };
}
const bridgeOptions = {
  translationEngine: 'continuous-captions',
  outgoingCaptions: true,
} as BridgeOptions;
const fakeBridge = () => ({
  attach() {
    /* no phone or supplier */
  },
  close() {
    /* no resources */
  },
});

test('default OpenAI never reads or connects to any Aliyun credential, even with stale Aliyun fields', () => {
  const env = {
    CLOUD_PHONE_TRANSLATION_PROVIDER: 'openai',
    ALIYUN_PLAN_B_REGION: 'invalid',
  };
  Object.defineProperty(env, 'ALIYUN_BEIJING_API_KEY', {
    get: () => {
      throw new Error('MUST_NOT_READ');
    },
  });
  assert.deepEqual(parsePhoneTranslationSelection(env), { provider: 'openai' });
  assert.deepEqual(parsePhoneTranslationSelection({}), { provider: 'openai' });
  let original = 0;
  let alternative = 0;
  const factory = createCloudTranslationBridgeFactory(undefined, {
    openai: (settings) => {
      original += 1;
      assert.equal(settings, bridgeOptions);
      return fakeBridge();
    },
    planB: () => {
      alternative += 1;
      return fakeBridge();
    },
  });
  factory(bridgeOptions);
  assert.equal(original, 1);
  assert.equal(alternative, 0);
});

test('region/key/model/voice selection is explicit, immutable and never cross-region fallback', () => {
  const bj = selection();
  const sg = selection('singapore');
  assert.notEqual(bj.config.webSocketUrl, sg.config.webSocketUrl);
  assert.notEqual(bj.config.apiKey, sg.config.apiKey);
  assert.ok(Object.isFrozen(bj));
  assert.ok(Object.isFrozen(bj.config));
  assert.throws(
    () =>
      parsePhoneTranslationSelection({
        CLOUD_PHONE_TRANSLATION_PROVIDER: 'aliyun-plan-b',
        ALIYUN_PLAN_B_REGION: 'beijing',
        ALIYUN_SINGAPORE_API_KEY: 'unused-offline',
      }),
    /KEY_MISSING:ALIYUN_BEIJING_API_KEY/,
  );
  assert.throws(
    () =>
      parsePhoneTranslationSelection({
        CLOUD_PHONE_TRANSLATION_PROVIDER: 'aliyun-plan-b',
      }),
    /ALIYUN_PLAN_B_REGION/,
  );
  for (const [field, value] of Object.entries({
    ALIYUN_PLAN_B_ASR_MODEL: 'only-zh-8k',
    ALIYUN_PLAN_B_MT_MODEL: 'unreviewed',
    ALIYUN_PLAN_B_TTS_MODEL: 'other',
    ALIYUN_PLAN_B_VOICE: 'default',
    ALIYUN_PLAN_B_SAMPLE_RATE: '8000',
  }))
    assert.throws(
      () =>
        parsePhoneTranslationSelection({
          CLOUD_PHONE_TRANSLATION_PROVIDER: 'aliyun-plan-b',
          ALIYUN_PLAN_B_REGION: 'beijing',
          ALIYUN_BEIJING_API_KEY: 'offline-fixture',
          [field]: value,
        }),
      new RegExp(field),
    );
  assert.throws(
    () =>
      assertAliyunPlanBConfig({
        ...bj.config,
        webSocketUrl: sg.config.webSocketUrl,
      }),
    /CONFIG_INVALID/,
  );
});

test('provider and all configuration values freeze before a call; errors never invoke another supplier', () => {
  const mutable = {
    provider: 'aliyun-plan-b',
    config: { ...selection().config },
  } as PhoneTranslationSelection;
  let alternative = 0;
  let original = 0;
  const factory = createCloudTranslationBridgeFactory(mutable, {
    openai: () => {
      original += 1;
      return fakeBridge();
    },
    planB: (settings, config) => {
      alternative += 1;
      assert.equal(config.region, 'beijing');
      assert.equal(settings.outgoingCaptions, false);
      throw new Error('OFFLINE_FAILURE');
    },
  });
  (mutable as any).provider = 'openai';
  (mutable as any).config.region = 'singapore';
  assert.throws(() => factory(bridgeOptions), /OFFLINE_FAILURE/);
  assert.equal(original, 0);
  assert.equal(alternative, 1);
  assert.throws(
    () => factory({ ...bridgeOptions, translationEngine: 'legacy' }),
    /ENGINE_DENIED/,
  );
  assert.equal(alternative, 1);
});

test('Plan B cloud config does not read or require an unused OpenAI key; default still requires it', () => {
  const env = {
    ...cloudEnv(),
    CLOUD_PHONE_TRANSLATION_PROVIDER: 'aliyun-plan-b',
    ALIYUN_PLAN_B_REGION: 'beijing',
    ALIYUN_BEIJING_API_KEY: 'offline-fixture',
  };
  Object.defineProperty(env, 'OPENAI_API_KEY', {
    get: () => {
      throw new Error('MUST_NOT_READ');
    },
  });
  const config = parseCloudServiceConfig(env);
  assert.equal(config.providers.OPENAI_API_KEY, '');
  assert.equal(config.translationProvider?.provider, 'aliyun-plan-b');
  const original = cloudEnv();
  delete original.OPENAI_API_KEY;
  assert.throws(() => parseCloudServiceConfig(original), /OPENAI_API_KEY/);
  const invalid = {
    ...cloudEnv(),
    CLOUD_PHONE_TRANSLATION_PROVIDER: 'aliyun-plan-b',
    ALIYUN_PLAN_B_REGION: 'beijing',
    ALIYUN_BEIJING_API_KEY: 'offline-fixture',
    TWILIO_AUTH_TOKEN: '',
  };
  assert.throws(() => parseCloudServiceConfig(invalid), /TWILIO_AUTH_TOKEN/);
});

test('cloud --check reports fixed Plan B metadata without API contact or credential output', () => {
  const env = {
    ...process.env,
    ...cloudEnv(),
    CLOUD_PHONE_TRANSLATION_PROVIDER: 'aliyun-plan-b',
    ALIYUN_PLAN_B_REGION: 'singapore',
    ALIYUN_SINGAPORE_API_KEY: 'offline-fixture-api-secret',
  };
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/solo/cloud-index.ts', '--check'],
    { cwd: process.cwd(), env, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  const value = JSON.parse(r.stdout);
  assert.equal(value.externalProvidersContacted, false);
  assert.equal(value.openaiSocketsPerCall, 0);
  assert.equal(value.aliyunRegion, 'singapore');
  assert.equal(value.aliyunVoice, 'loongandy_v3');
  assert.equal(value.applicationCallDurationLimitSeconds, null);
  assert.doesNotMatch(
    r.stdout + r.stderr,
    /offline-fixture-api-secret|sk-offline/,
  );
});

test('network rejects cross-region endpoints and keeps proxy/TLS options; raw errors are sanitized', () => {
  const config = {
    ...selection().config,
    proxyUrl: 'http://proxy.invalid:8080',
  };
  let calls = 0;
  const factory = (url: string, settings: WebSocket.ClientOptions) => {
    calls += 1;
    assert.equal(url, config.webSocketUrl);
    assert.ok(settings.agent);
    assert.notEqual(settings.rejectUnauthorized, false);
    return {} as WebSocket;
  };
  createPlanBWebSocket(config, factory);
  assert.equal(calls, 1);
  assert.throws(
    () =>
      createPlanBWebSocket(
        { ...config, webSocketUrl: selection('singapore').config.webSocketUrl },
        factory,
      ),
    /CONFIG_INVALID/,
  );
  assert.equal(calls, 1);
  assert.throws(
    () =>
      createPlanBWebSocket(config, () => {
        throw new Error('NEVER_LEAK_SECRET');
      }),
    { message: 'PLAN_B_SOCKET_CREATE_FAILED' },
  );
});

test('fixed HTTP transport streams via injected HTTPS request and rejects redirects/foreign inputs', async () => {
  const { config } = selection();
  let calls = 0;
  let outgoingBody = '';
  const request = ((url, options, callback) => {
    calls += 1;
    assert.equal(url, config.translationUrl);
    assert.equal(options.method, 'POST');
    const outgoing = new EventEmitter() as any;
    outgoing.end = (body: string) => {
      outgoingBody = body;
      const incoming = new PassThrough() as any;
      incoming.statusCode = 200;
      incoming.headers = { 'content-type': 'text/event-stream' };
      callback(incoming);
      incoming.end('data: [DONE]\n\n');
    };
    return outgoing;
  }) as unknown as typeof HttpsRequest;
  const fetch = createPlanBFetch(config, request);
  const response = await fetch(config.translationUrl, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(await response.text(), 'data: [DONE]\n\n');
  assert.equal(outgoingBody, '{}');
  await assert.rejects(
    fetch('https://other.invalid/', { method: 'POST', body: '{}' }),
    /HTTP_REQUEST_INVALID/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetch(config.translationUrl, {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    }),
    /HTTP_ABORTED/,
  );
  assert.equal(calls, 1);
});

test('selected Plan B service startup and unauthorized request create zero provider work', async (t) => {
  const listener = createServer();
  await new Promise<void>((resolve) => {
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => {
    listener.close(() => resolve());
  });
  const env: Record<string, string> = {
    ...cloudEnv(address.port),
    CLOUD_PHONE_TRANSLATION_PROVIDER: 'aliyun-plan-b',
    ALIYUN_PLAN_B_REGION: 'beijing',
    ALIYUN_BEIJING_API_KEY: 'offline-fixture',
  };
  delete env.OPENAI_API_KEY;
  let calls = 0;
  const service = await createCloudService(parseCloudServiceConfig(env), {
    providerFactory: () => {
      calls += 1;
      throw new Error('NO_CALLS');
    },
    translationFactories: {
      openai: () => {
        calls += 1;
        return fakeBridge();
      },
      planB: () => {
        calls += 1;
        return fakeBridge();
      },
    },
    googleFetch: async () => {
      calls += 1;
      throw new Error('NO_LOGIN_REQUESTS');
    },
  });
  t.after(() => service.close());
  const health = await service.app.inject({
    method: 'GET',
    url: '/api/health',
  });
  assert.equal(health.statusCode, 200);
  const unauthorized = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: address.port,
        method: 'POST',
        path: '/api/calls',
        headers: {
          host: 'phone.example.com',
          'x-forwarded-proto': 'https',
          'content-type': 'application/json',
        },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode!));
        response.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('OFFLINE_HTTP_TIMEOUT')));
    req.end(
      JSON.stringify({ to: '+12025550101', translationProvider: 'openai' }),
    );
  });
  // The existing Origin/CSRF boundary rejects this unauthenticated request.
  assert.equal(unauthorized, 403);
  assert.equal(calls, 0);
});

test('phone Plan B rejects non-Beijing selection before constructing a supplier or phone bridge', () => {
  let calls = 0;
  assert.throws(
    () =>
      createCloudTranslationBridgeFactory(selection('singapore'), {
        planB: () => {
          calls += 1;
          return fakeBridge();
        },
      }),
    /CLOUD_PLAN_B_REGION_DENIED/u,
  );
  assert.equal(calls, 0);
});
