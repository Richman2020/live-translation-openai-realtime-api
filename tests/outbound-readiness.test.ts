import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { InjectOptions } from 'fastify';

import { ConfigStore, type SoloConfig } from '../src/solo/config';
import type {
  checkPublicReadiness,
  PublicReadinessResult,
} from '../src/solo/public-readiness';
import { buildSoloServer } from '../src/solo/server';
import { SessionManager } from '../src/solo/session-manager';
import type {
  checkTranslationEngine,
  verifyProviders,
} from '../src/solo/provider-checks';

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
const ready: PublicReadinessResult = {
  status: 'ready',
  code: 'PUBLIC_CALLBACK_READY',
};
const unreachable: PublicReadinessResult = {
  status: 'unreachable',
  code: 'PUBLIC_CALLBACK_UNREACHABLE',
};
const request = {
  method: 'POST' as const,
  url: '/api/calls',
  remoteAddress: '127.0.0.1',
  headers: {
    host: '127.0.0.1:5050',
    origin: 'http://127.0.0.1:5050',
    authorization: `Bearer ${config.LOCAL_ACCESS_TOKEN}`,
  },
  payload: { to: '+12125550124' },
};

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  t: TestContext,
  publicReadinessChecker: typeof checkPublicReadiness,
  translationReadinessChecker?: typeof checkTranslationEngine,
  providerVerifier?: typeof verifyProviders,
) {
  // Injection never opens a listener. These guards also prevent a regression in
  // the /api/verify gate from reaching real providers with the fake credentials.
  let networkAttempts = 0;
  const forbidNetwork = () => {
    networkAttempts += 1;
    throw new Error('This test must not make network requests');
  };
  t.mock.method(globalThis, 'fetch', forbidNetwork);
  t.mock.method(http, 'request', forbidNetwork);
  t.mock.method(https, 'request', forbidNetwork);

  const dir = mkdtempSync(join(tmpdir(), 'ai-phone-outbound-readiness-'));
  const envPath = join(dir, '.env');
  const store = new ConfigStore({
    envPath,
    values: { ...config },
    generateToken: false,
  });
  const calls = { factory: 0, create: 0, hangup: 0, bridge: 0 };
  const events: unknown[] = [];
  const manager = new SessionManager({
    providerFactory: () => {
      calls.factory += 1;
      return {
        create: async () => {
          calls.create += 1;
          throw new Error('Preparing a local session must not dial a provider');
        },
        hangup: async () => {
          calls.hangup += 1;
        },
      };
    },
    bridgeFactory: () => {
      calls.bridge += 1;
      throw new Error('Preparing a local session must not open media');
    },
  });
  manager.setPresence(true);
  manager.on('event', (event) => events.push(event));
  const app = await buildSoloServer({
    configStore: store,
    sessionManager: manager,
    publicDir: dir,
    publicReadinessChecker,
    translationReadinessChecker,
    providerVerifier,
  });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    assert.equal(networkAttempts, 0, 'No real network calls are permitted');
    assert.equal(calls.create, 0, 'No provider call may be created');
    assert.equal(calls.hangup, 0, 'No provider call exists to hang up');
    assert.equal(calls.bridge, 0, 'No translation media bridge may be created');
  });
  assert.equal(store.configured(), true);
  return { app, manager, calls, events, store, envPath };
}

test('idle connection maintenance blocks new calls and settings but preserves its own verification and private lease', async (t) => {
  const f = await fixture(t, async () => ready, async () => ({ name:'pocketCaptions',status:'passed',code:'POCKET_CAPTIONS_READY' }), async (_config, engine) => ({ checkedAt:new Date().toISOString(), realCallTested:false, translationEngine:engine, checks:[] }));
  const headers = { host:'127.0.0.1:5050',origin:'http://127.0.0.1:5050',authorization:`Bearer ${config.LOCAL_ACCESS_TOKEN}` };
  const request = (url:string,payload:InjectOptions['payload'],extra:Record<string,string>={})=>f.app.inject({method:'POST',url,headers:{...headers,...extra},payload});
  const begin=await request('/api/connection-maintenance',{action:'begin'});assert.equal(begin.statusCode,200);
  const lease=begin.json().lease;assert.equal(typeof lease,'string');
  const status=await f.app.inject({method:'GET',url:'/api/status',headers});assert.equal(status.json().connectionMaintenance,true);assert.ok(!JSON.stringify(status.json()).includes(lease));
  assert.equal((await request('/api/calls',{to:'+12125551234'})).statusCode,409);
  assert.equal((await request('/api/settings',{OPENAI_PROXY_URL:''})).statusCode,409);
  assert.equal((await request('/api/verify',{translationEngine:'pocket-captions'})).statusCode,409);
  assert.equal((await request('/api/verify',{translationEngine:'pocket-captions'},{'x-phone-maintenance':lease})).statusCode,200);
  assert.equal((await request('/api/connection-maintenance',{action:'end',lease:'wrong'})).statusCode,409);
  assert.equal((await request('/api/connection-maintenance',{action:'renew',lease})).statusCode,200);
  assert.equal((await request('/api/connection-maintenance',{action:'end',lease})).statusCode,200);
  assert.equal((await request('/api/calls',{to:'+12125551234'})).statusCode,200);
  assert.equal((await request('/api/connection-maintenance',{action:'begin'})).statusCode,409,'an existing session cannot be interrupted by maintenance');
});

for (const result of [
  unreachable,
  { status: 'wrong_service', code: 'PUBLIC_CALLBACK_WRONG_SERVICE' },
  { status: 'invalid_configuration', code: 'PUBLIC_CALLBACK_URL_INVALID' },
] as PublicReadinessResult[]) {
  test(`outbound readiness ${result.status} rejects before creating a session`, async (t) => {
    let checks = 0;
    const { app, manager, calls, events } = await fixture(t, async () => {
      checks += 1;
      return result;
    });
    const response = await app.inject(request);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: result.code });
    assert.equal(checks, 1);
    assert.equal(manager.activeSession, null);
    assert.equal(calls.factory, 0);
    assert.deepEqual(events, []);
  });
}

test('ready public callback prepares only a local session and browser connection parameters', async (t) => {
  let checks = 0;
  const { app, manager, calls } = await fixture(t, async (settings) => {
    checks += 1;
    assert.equal(settings.PUBLIC_BASE_URL, config.PUBLIC_BASE_URL);
    return ready;
  });
  const response = await app.inject(request);
  assert.equal(response.statusCode, 200);
  const session = response.json();
  assert.equal(session.status, 'connecting');
  assert.equal(session.direction, 'outbound');
  assert.equal(session.to, request.payload.to);
  assert.equal(session.connectionParams.sessionId, session.id);
  assert.match(session.connectionParams.nonce, /^[a-f0-9]{48}$/);
  assert.equal(manager.activeSession?.id, session.id);
  assert.equal(checks, 1);
  assert.deepEqual(calls, { factory: 1, create: 0, hangup: 0, bridge: 0 });
});

test('continuous selection is checked before any phone session and never falls back after failure', async (t) => {
  const engines: string[] = [];
  const { app, calls, manager } = await fixture(
    t,
    async () => ready,
    async (_config, engine) => {
      engines.push(engine);
      return {
        name: 'openaiContinuous',
        status: 'failed',
        code: 'SESSION_MISMATCH',
      };
    },
  );
  const failed = await app.inject({
    ...request,
    payload: { ...request.payload, translationEngine: 'continuous' },
  });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().error, 'TRANSLATION_ENGINE_UNAVAILABLE');
  assert.equal(manager.activeSession, null);
  assert.equal(calls.factory, 0);
  assert.deepEqual(engines, ['continuous']);
  const legacy = await app.inject(request);
  assert.equal(legacy.statusCode, 200);
  assert.equal(legacy.json().translationEngine, 'legacy');
  assert.equal(legacy.json().translationReady, false);
  assert.deepEqual(engines, ['continuous']);
});

test('continuous success snapshots the chosen engine and a busy request cannot change it', async (t) => {
  const { app, manager } = await fixture(
    t,
    async () => ready,
    async (_config, engine) => {
      assert.equal(engine, 'continuous');
      return {
        name: 'openaiContinuous',
        status: 'passed',
        code: 'SESSION_UPDATED',
      };
    },
  );
  const chosen = await app.inject({
    ...request,
    payload: { ...request.payload, translationEngine: 'continuous' },
  });
  assert.equal(chosen.statusCode, 200);
  assert.equal(chosen.json().translationEngine, 'continuous');
  const denied = await app.inject(request);
  assert.equal(denied.statusCode, 409);
  assert.equal(manager.activeSession?.translationEngine, 'continuous');
});

for (const engine of [
  'nano-captions',
  'continuous-captions',
  'pocket-captions',
] as const)
  test(`${engine} must pass its selected provider check before any phone session`, async (t) => {
    let passed = false;
    const engines: string[] = [];
    const { app, manager, calls } = await fixture(
      t,
      async () => ready,
      async (_config, engine) => {
        engines.push(engine);
        const selected = {
          'nano-captions': ['nanoCaptions', 'NANO_CAPTIONS_READY'],
          'continuous-captions': [
            'continuousCaptions',
            'CONTINUOUS_CAPTIONS_READY',
          ],
          'pocket-captions': ['pocketCaptions', 'POCKET_CAPTIONS_READY'],
        }[engine];
        return {
          name: selected[0],
          status: passed ? 'passed' : 'failed',
          code: passed ? selected[1] : 'CAPTION_UNAVAILABLE',
        };
      },
    );
    const chosenRequest = {
      ...request,
      payload: { ...request.payload, translationEngine: engine },
    };
    const failed = await app.inject(chosenRequest);
    assert.equal(failed.statusCode, 503);
    assert.equal(manager.activeSession, null);
    assert.equal(calls.factory, 0);
    passed = true;
    const success = await app.inject(chosenRequest);
    assert.equal(success.statusCode, 200);
    assert.equal(manager.activeSession?.translationEngine, engine);
    assert.deepEqual(engines, [engine, engine]);
  });

test('continuous-nano failed preflight creates no phone session and never silently selects another engine', async (t) => {
  const engines: string[] = [];
  const { app, calls, manager, events } = await fixture(
    t,
    async () => ready,
    async (_config, engine) => {
      engines.push(engine);
      return {
        name: 'nanoVoice',
        status: 'failed',
        code: 'NANOVOICE_UNAVAILABLE',
      };
    },
  );
  const failed = await app.inject({
    ...request,
    payload: { ...request.payload, translationEngine: 'continuous-nano' },
  });
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(failed.json(), { error: 'TRANSLATION_ENGINE_UNAVAILABLE' });
  assert.deepEqual(engines, ['continuous-nano']);
  assert.equal(manager.activeSession, null);
  assert.deepEqual(calls, { factory: 0, create: 0, hangup: 0, bridge: 0 });
  assert.deepEqual(events, []);

  // A later explicit legacy request is allowed; failure cannot choose it for us.
  const legacy = await app.inject(request);
  assert.equal(legacy.statusCode, 200);
  assert.equal(legacy.json().translationEngine, 'legacy');
  assert.deepEqual(engines, ['continuous-nano']);
});

test('continuous-nano waits for its own preflight before preparing the selected phone session', async (t) => {
  const entered = deferred<void>();
  const probe = deferred<Awaited<ReturnType<typeof checkTranslationEngine>>>();
  const engines: string[] = [];
  const { app, calls, manager, events } = await fixture(
    t,
    async () => ready,
    async (_config, engine) => {
      engines.push(engine);
      entered.resolve();
      return probe.promise;
    },
  );
  const pending = app
    .inject({
      ...request,
      payload: { ...request.payload, translationEngine: 'continuous-nano' },
    })
    .then((response) => response);
  try {
    await entered.promise;
    assert.equal(manager.activeSession, null);
    assert.deepEqual(calls, { factory: 0, create: 0, hangup: 0, bridge: 0 });
    assert.deepEqual(events, []);
    const blocked = await app.inject(request);
    assert.equal(blocked.statusCode, 409);
    assert.deepEqual(blocked.json(), { error: 'VERIFICATION_IN_PROGRESS' });
    assert.deepEqual(engines, ['continuous-nano']);
  } finally {
    probe.resolve({
      name: 'nanoTranslation',
      status: 'passed',
      code: 'NANO_AND_CONTINUOUS_READY',
    });
    await pending;
  }
  const chosen = await pending;
  assert.equal(chosen.statusCode, 200);
  assert.equal(chosen.json().translationEngine, 'continuous-nano');
  assert.equal(chosen.json().translationReady, false);
  assert.equal(manager.activeSession?.translationEngine, 'continuous-nano');
  assert.deepEqual(calls, { factory: 1, create: 0, hangup: 0, bridge: 0 });
});

test('continuous-nano preflight exceptions release the gate without creating a session or leaking diagnostics', async (t) => {
  let checks = 0;
  const { app, manager, calls, events } = await fixture(
    t,
    async () => ready,
    async (_config, engine) => {
      assert.equal(engine, 'continuous-nano');
      checks += 1;
      if (checks === 1) throw new Error('private model path and diagnostic');
      return {
        name: 'nanoTranslation',
        status: 'passed',
        code: 'NANO_AND_CONTINUOUS_READY',
      };
    },
  );
  const nanoRequest = {
    ...request,
    payload: { ...request.payload, translationEngine: 'continuous-nano' },
  };
  const failed = await app.inject(nanoRequest);
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(failed.json(), { error: 'REQUEST_FAILED' });
  assert.equal(manager.activeSession, null);
  assert.deepEqual(calls, { factory: 0, create: 0, hangup: 0, bridge: 0 });
  assert.deepEqual(events, []);
  const retried = await app.inject(nanoRequest);
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.json().translationEngine, 'continuous-nano');
  assert.equal(checks, 2);
  assert.deepEqual(calls, { factory: 1, create: 0, hangup: 0, bridge: 0 });
});

test('unknown engines are rejected without checking providers or preparing a phone session', async (t) => {
  let checks = 0;
  const { app, calls } = await fixture(t, async () => {
    checks += 1;
    return ready;
  });
  for (const value of ['unknown', null, 123, {}]) {
    const invalid = await app.inject({
      ...request,
      payload: { ...request.payload, translationEngine: value },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error, 'INVALID_TRANSLATION_ENGINE');
  }
  assert.equal(checks, 0);
  assert.equal(calls.factory, 0);
});

test('provider verification records the selected engine separately from the default engine', async (t) => {
  const { app } = await fixture(
    t,
    async () => ready,
    undefined,
    async (_config, engine) => ({
      translationEngine: engine,
      checkedAt: new Date().toISOString(),
      realCallTested: false,
      checks: [
        { name: 'openaiContinuous', status: 'passed', code: 'SESSION_UPDATED' },
      ],
    }),
  );
  const verified = await app.inject({
    ...request,
    url: '/api/verify',
    payload: { translationEngine: 'continuous' },
  });
  assert.equal(verified.statusCode, 200);
  assert.equal(verified.json().translationEngine, 'continuous');
  const status = await app.inject({
    method: 'GET',
    url: '/api/status',
    remoteAddress: request.remoteAddress,
    headers: request.headers,
  });
  assert.equal(status.json().defaultTranslationEngine, 'legacy');
  assert.deepEqual(status.json().translationEngines, [
    'legacy',
    'continuous',
    'continuous-nano',
    'nano-captions',
    'continuous-captions',
    'pocket-captions',
    'pocket-prefix',
  ]);
  assert.deepEqual(status.json().pocketVoice, {
    state: 'not_started',
    pendingJobs: 0,
  });
  assert.equal(status.json().lastVerification.translationEngine, 'continuous');
});

test('pending readiness blocks concurrent dialing, settings and provider verification, then releases for retry', async (t) => {
  const entered = deferred<void>();
  const probe = deferred<PublicReadinessResult>();
  let checks = 0;
  const { app, manager, calls, events, store, envPath } = await fixture(
    t,
    async () => {
      checks += 1;
      if (checks === 1) {
        entered.resolve();
        return probe.promise;
      }
      return ready;
    },
  );
  const pending = app.inject(request).then((response) => response);
  try {
    await entered.promise;
    assert.equal(manager.activeSession, null);
    assert.equal(calls.factory, 0);
    assert.deepEqual(events, []);
    const [secondCall, settings, verify] = await Promise.all([
      app.inject(request),
      app.inject({
        ...request,
        url: '/api/settings',
        payload: { PUBLIC_BASE_URL: 'https://changed.example.com' },
      }),
      app.inject({ ...request, url: '/api/verify', payload: {} }),
    ]);
    assert.equal(secondCall.statusCode, 409);
    assert.deepEqual(secondCall.json(), { error: 'VERIFICATION_IN_PROGRESS' });
    for (const blocked of [settings, verify]) {
      assert.equal(blocked.statusCode, 409);
      assert.deepEqual(blocked.json(), {
        error: 'CALL_OR_VERIFICATION_IN_PROGRESS',
      });
    }
    assert.equal(checks, 1);
    assert.equal(store.value.PUBLIC_BASE_URL, config.PUBLIC_BASE_URL);
    assert.equal(existsSync(envPath), false);
    assert.equal(calls.factory, 0);
  } finally {
    probe.resolve(unreachable);
    await pending;
  }
  const first = await pending;
  assert.equal(first.statusCode, 503);
  assert.deepEqual(first.json(), { error: unreachable.code });
  assert.equal(manager.activeSession, null);
  const retried = await app.inject(request);
  assert.equal(retried.statusCode, 200);
  assert.equal(checks, 2);
  assert.equal(manager.activeSession?.id, retried.json().id);
  assert.equal(calls.factory, 1);
});

test('a throwing readiness checker releases the gate without leaking its error or creating a session', async (t) => {
  let checks = 0;
  const { app, manager, calls } = await fixture(t, async () => {
    checks += 1;
    if (checks === 1) throw new Error('private upstream diagnostic');
    return ready;
  });
  const failed = await app.inject(request);
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(failed.json(), { error: 'REQUEST_FAILED' });
  assert.equal(manager.activeSession, null);
  assert.equal(calls.factory, 0);
  const retried = await app.inject(request);
  assert.equal(retried.statusCode, 200);
  assert.equal(checks, 2);
  assert.equal(calls.factory, 1);
});

test('a session validation failure after readiness also releases the gate', async (t) => {
  let checks = 0;
  const { app, manager, calls } = await fixture(t, async () => {
    checks += 1;
    return ready;
  });
  manager.setPresence(false);
  const failed = await app.inject(request);
  assert.equal(failed.statusCode, 409);
  assert.deepEqual(failed.json(), { error: 'BROWSER_NOT_READY' });
  assert.equal(manager.activeSession, null);
  assert.equal(calls.factory, 0);
  manager.setPresence(true);
  const retried = await app.inject(request);
  assert.equal(retried.statusCode, 200);
  assert.equal(checks, 2);
  assert.equal(calls.factory, 1);
});
