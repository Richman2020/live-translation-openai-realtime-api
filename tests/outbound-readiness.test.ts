import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { ConfigStore, type SoloConfig } from '../src/solo/config';
import type {
  checkPublicReadiness,
  PublicReadinessResult,
} from '../src/solo/public-readiness';
import { buildSoloServer } from '../src/solo/server';
import { SessionManager } from '../src/solo/session-manager';

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
