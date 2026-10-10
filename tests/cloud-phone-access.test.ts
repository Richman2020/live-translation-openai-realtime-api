import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import fastify from 'fastify';

import {
  CLOUD_CSRF_HEADER,
  CLOUD_SESSION_COOKIE,
  CloudAccessError,
  CloudAccessPolicy,
  type CloudAuthSession,
} from '../src/solo/cloud-access';
import { createCloudAccessTransport } from '../src/solo/cloud-access-transport';
import { CloudPhoneAccess } from '../src/solo/cloud-phone-access';
import { CloudControllerLeases } from '../src/solo/controller-lease';
import { CloudVoiceJoin } from '../src/solo/cloud-voice-join';
import type { SoloConfig } from '../src/solo/config';
import { SessionManager } from '../src/solo/session-manager';
import type { TranslationEngine } from '../src/solo/translation-engine';

// Synthetic credentials and provider behavior are TEST ONLY. No network clients.
const origin = 'https://phone.example.com';
const token = Buffer.alloc(32, 1).toString('base64url');
const otherToken = Buffer.alloc(32, 2).toString('base64url');
const csrf = Buffer.alloc(32, 3).toString('base64url');
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
  OPENAI_API_KEY: 'sk-test-only-offline',
  OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
  OPENAI_TRANSCRIPTION_MODEL: 'gpt-4o-transcribe',
  OPENAI_PROXY_URL: '',
  LOCAL_ACCESS_TOKEN: 'test-only-local-token',
};
function fixture(
  t: any,
  options: {
    maxCalls?: number;
    hangup?: () => Promise<void>;
    publicChecker?: () => Promise<any>;
    factoryThrows?: boolean;
    leaseTtlMs?: number;
    noVoice?: boolean;
    voiceRelease?: () => Promise<void>;
    allowedTranslationEngines?: readonly TranslationEngine[];
    defaultTranslationEngine?: TranslationEngine;
    outgoingPairedCaptions?: boolean;
  } = {},
) {
  let now = 10000;
  const make = (id: string): CloudAuthSession => ({
    authSessionId: `session-${id}`,
    principalId: 'shared-single-account',
    browserOwnerId: `owner-${id}`,
    epoch: 1,
    issuedAt: 1000,
    absoluteExpiresAt: 40000,
    idleExpiresAt: 20000,
    revoked: false,
    csrfToken: csrf,
  });
  const session = make('a');
  const otherSession = make('b');
  const sessions = new Map([
    [token, session],
    [otherToken, otherSession],
  ]);
  const policy = new CloudAccessPolicy({
    publicOrigin: origin,
    now: () => now,
    resolveSession: (value) => sessions.get(value),
  });
  let factories = 0;
  let hangups = 0;
  let publicChecks = 0;
  let translationChecks = 0;
  const checkedEngines: TranslationEngine[] = [];
  const admissions: any[] = [];
  const manager = new SessionManager({
    now: () => now,
    providerFactory: () => {
      factories += 1;
      if (options.factoryThrows)
        throw new Error('fixture private provider factory');
      return {
        create: async () => {
          throw new Error('Unexpected test provider create');
        },
        hangup: async () => {
          hangups += 1;
          await options.hangup?.();
        },
      };
    },
    bridgeFactory: () => {
      throw new Error('Unexpected test bridge creation');
    },
  });
  const controllerLeases = new CloudControllerLeases({
    policy,
    now: () => now,
    ttlMs: options.leaseTtlMs ?? 5000,
  });
  const voiceJoin = new CloudVoiceJoin({
    policy,
    now: () => now,
    outgoingApplicationSid: config.TWILIO_TWIML_APP_SID,
    signer: async () => 'offline-fake-token',
    admission: {
      reserve: async () => ({
        assertCurrent: () => {},
        release: async () => { await options.voiceRelease?.(); },
      }),
    },
  });
  const originalCreate = manager.createOutbound.bind(manager);
  manager.createOutbound = (...args) => {
    admissions.push(args[3]);
    return originalCreate(...args);
  };
  const access = new CloudPhoneAccess({
    policy,
    manager,
    controllerLeases,
    voiceJoin: options.noVoice ? undefined : voiceJoin,
    maxCalls: options.maxCalls,
    allowedTranslationEngines: options.allowedTranslationEngines,
    defaultTranslationEngine: options.defaultTranslationEngine,
    outgoingPairedCaptions: options.outgoingPairedCaptions,
    revalidationIntervalMs: 10,
    publicReadinessChecker: async () => {
      publicChecks += 1;
      return options.publicChecker
        ? options.publicChecker()
        : { status: 'ready', code: 'PUBLIC_CALLBACK_READY' };
    },
    translationReadinessChecker: async (_config, engine) => {
      translationChecks += 1;
      checkedEngines.push(engine);
      return { name: 'offline', status: 'passed', code: 'OFFLINE_PASSED' };
    },
  });
  t.after(async () => {
    await manager.close();
    await access.close();
  });
  const headers = (other = false) => ({
    host: 'phone.example.com',
    origin,
    cookie: `${CLOUD_SESSION_COOKIE}=${other ? otherToken : token}`,
    [CLOUD_CSRF_HEADER]: csrf,
  });
  const post = (other = false) =>
    policy.authenticate(headers(other), 'mutate', {
      surface: 'http',
      method: 'POST',
    });
  const read = (other = false) =>
    policy.authenticate(headers(other), 'read', {
      surface: 'http',
      method: 'GET',
    });
  const proof = access.acquireController(post(), 'offline-tab-a');
  const create = async () =>
    access.createPrepared(
      await access.prepareCreate(
        post(),
        config,
        '+14155550123',
        'pocket-prefix',
        proof,
      ),
    );
  return {
    access,
    manager,
    policy,
    proof,
    controllerLeases,
    voiceJoin,
    session,
    otherSession,
    headers,
    post,
    read,
    create,
    admissions,
    checkedEngines,
    advance: (value: number) => {
      now = value;
    },
    counts: () => ({ factories, hangups, publicChecks, translationChecks }),
  };
}
function denied(run: () => unknown, code: CloudAccessError['code']) {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof CloudAccessError &&
      error.code === code &&
      error.message === code,
  );
}
async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    // eslint-disable-next-line no-await-in-loop -- Poll an offline lifecycle timer with a bounded deadline.
    await delay(10);
  }
  assert.fail('Offline lifecycle did not complete');
}

test('service requires the complete explicit dependency bundle and matching fixed origin', (t) => {
  const f = fixture(t);
  for (const change of [
    { policy: undefined },
    { manager: undefined },
    { manager: new SessionManager() },
    {
      manager: new SessionManager({
        providerFactory: () => ({
          create: async () => ({ sid: '' }),
          hangup: async () => {},
        }),
      }),
    },
    { publicReadinessChecker: undefined },
    { translationReadinessChecker: undefined },
    { controllerLeases: undefined },
    { revalidationIntervalMs: 1001 },
    { maxCalls: 101 },
    { allowedTranslationEngines: [] },
    { allowedTranslationEngines: ['legacy'] },
    { allowedTranslationEngines: ['continuous'] },
    { allowedTranslationEngines: ['pocket-prefix', 'pocket-prefix'] },
    { allowedTranslationEngines: ['continuous-captions'] },
    { defaultTranslationEngine: 'continuous-captions' },
    { outgoingPairedCaptions: 'true' },
  ])
    denied(
      () =>
        new CloudPhoneAccess({
          policy: f.policy,
          manager: f.manager,
          controllerLeases: f.controllerLeases,
          publicReadinessChecker: async () => ({
            status: 'ready',
            code: 'PUBLIC_CALLBACK_READY',
          }),
          translationReadinessChecker: async () => ({
            name: 'offline',
            status: 'passed',
          }),
          ...change,
        } as any),
      'FORBIDDEN',
    );
  denied(
    () =>
      f.access.assertConfig({
        ...config,
        PUBLIC_BASE_URL: 'https://other.example',
      }),
    'FORBIDDEN',
  );
  assert.equal(f.counts().factories, 0);
});

test('first real manager publication already has server-owned authorization; same account other owner is isolated', async (t) => {
  const f = fixture(t);
  const read = f.read();
  let publications = 0;
  f.manager.on('event', (event) => {
    assert.equal(f.access.authorizeEvents(read, event), true);
    publications += 1;
  });
  const call = await f.create();
  assert.equal(publications, 1);
  assert.equal(f.access.ownedActive(read)?.id, call.id);
  assert.equal(f.access.ownedActive(f.read(true)), null);
  assert.equal(
    f.access.authorizeEvents(f.read(true), {
      event: 'transcript',
      data: { sessionId: call.id, text: 'private fixture' },
    }),
    false,
  );
  denied(
    () => f.access.beginHangup(f.post(true), call.id, f.proof),
    'NOT_FOUND',
  );
  denied(() => f.access.readAccess({ ...read }, call.id), 'UNAUTHORIZED');
  assert.equal(f.counts().hangups, 0);
  f.manager.removeAllListeners('event');
});

test('prepared admissions are unforgeable and one-use with random per-call browser identities', async (t) => {
  const f = fixture(t);
  const prepared = await f.access.prepareCreate(
    f.post(),
    config,
    '+14155550123',
    'pocket-prefix',
    f.proof,
  );
  denied(() => f.access.createPrepared({ ...prepared }), 'UNAUTHORIZED');
  const call = f.access.createPrepared(prepared);
  denied(() => f.access.createPrepared(prepared), 'UNAUTHORIZED');
  assert.match(f.admissions[0].browserIdentity, /^cloud-phone-[0-9a-f]{36}$/);
  assert.notEqual(f.admissions[0].browserIdentity, 'ai-phone');
  await f.access.finishHangup(f.access.beginHangup(f.post(), call.id, f.proof));
  await f.create();
  assert.notEqual(
    f.admissions[0].browserIdentity,
    f.admissions[1].browserIdentity,
  );
});

test('readiness waits and prepared results cannot commit after revocation or epoch change', async (t) => {
  let release: (result: any) => void;
  const f = fixture(t, {
    publicChecker: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const pending = f.access.prepareCreate(
    f.post(),
    config,
    '+14155550123',
    'pocket-prefix',
    f.proof,
  );
  f.session.revoked = true;
  release({ status: 'ready', code: 'PUBLIC_CALLBACK_READY' });
  await assert.rejects(pending, (error: any) => error.code === 'UNAUTHORIZED');
  assert.equal(f.manager.activeSession, null);
  assert.equal(f.counts().factories, 0);
  const g = fixture(t);
  const prepared = await g.access.prepareCreate(
    g.post(),
    config,
    '+14155550123',
    'pocket-prefix',
    g.proof,
  );
  g.session.epoch += 1;
  denied(() => g.access.createPrepared(prepared), 'UNAUTHORIZED');
  assert.equal(g.counts().factories, 0);
});

test('single in-flight readiness admission is bounded and its permit releases after failure', async (t) => {
  let release: (result: any) => void;
  const f = fixture(t, {
    publicChecker: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const first = f.access.prepareCreate(
    f.post(),
    config,
    '+14155550123',
    'pocket-prefix',
    f.proof,
  );
  await assert.rejects(
    f.access.prepareCreate(
      f.post(),
      config,
      '+14155550123',
      'pocket-prefix',
      f.proof,
    ),
    (error: any) => error.code === 'BUSY',
  );
  assert.equal(f.counts().publicChecks, 1);
  release({ status: 'unreachable' });
  await assert.rejects(
    first,
    (error: any) => error.code === 'PUBLIC_CALLBACK_UNREACHABLE',
  );
  const next = f.access.prepareCreate(
    f.post(),
    config,
    '+14155550123',
    'pocket-prefix',
    f.proof,
  );
  assert.equal(f.counts().publicChecks, 2);
  release({ status: 'ready', code: 'PUBLIC_CALLBACK_READY' });
  f.access.createPrepared(await next);
});

test('unpublished factory failures roll back registrations without revoked-owner mutation authority', async (t) => {
  const f = fixture(t, { maxCalls: 1, factoryThrows: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prepared = await f.access.prepareCreate(
      f.post(),
      config,
      '+14155550123',
      'pocket-prefix',
      f.proof,
    );
    assert.throws(
      () => f.access.createPrepared(prepared),
      /fixture private provider factory/,
    );
    assert.equal(f.manager.activeSession, null);
  }
  const g = fixture(t, { maxCalls: 1 });
  const original = g.manager.createOutbound;
  g.manager.createOutbound = (_config, _to, _engine, admission) => {
    admission.beforePublish('unpublished-attempt', {
      identity: admission.browserIdentity,
      nonce: 'fake-nonce',
    });
    g.session.revoked = true;
    throw new Error('Unpublished test failure');
  };
  const prepared = await g.access.prepareCreate(
    g.post(),
    config,
    '+14155550123',
    'pocket-prefix',
    g.proof,
  );
  assert.throws(
    () => g.access.createPrepared(prepared),
    /Unpublished test failure/,
  );
  g.session.revoked = false;
  denied(
    () => g.policy.authorizeCall(g.post(), 'unpublished-attempt', 'mutate'),
    'NOT_FOUND',
  );
  g.manager.createOutbound = original;
  await g.create(); // Registry capacity was recovered despite revocation.
});

test('published creation failure retains ownership and immediately enters safety cleanup', async (t) => {
  const f = fixture(t);
  let publishedId: string;
  const listener = ({ event, data }: any) => {
    if (event === 'call') {
      publishedId = data.id;
      throw new Error('Subscriber fixture failure');
    }
  };
  f.manager.on('event', listener);
  const prepared = await f.access.prepareCreate(
    f.post(),
    config,
    '+14155550123',
    'pocket-prefix',
    f.proof,
  );
  assert.throws(
    () => f.access.createPrepared(prepared),
    /Subscriber fixture failure/,
  );
  f.manager.off('event', listener);
  f.access.readAccess(f.read(), publishedId);
  await waitFor(
    () => f.manager.isCleanupConfirmed(publishedId) && !f.manager.activeSession,
  );
  assert.equal(f.manager.activeSession, null);
});

test('hangup accepts synchronous intent before provider cleanup and cleanup continues after owner revocation', async (t) => {
  let release: () => void;
  const f = fixture(t, {
    hangup: () =>
      new Promise<void>((resolve) => {
        const deadline = setTimeout(resolve, 1000);
        release = () => {
          clearTimeout(deadline);
          resolve();
        };
      }),
  });
  const call = await f.create();
  const voice = await f.access.prepareVoice(f.post(), call.id, f.proof);
  f.manager.connectBrowser({
    ...voice.params,
    From: `client:${f.admissions[0].browserIdentity}`,
    CallSid: `CA${'1'.repeat(32)}`,
  });
  const context = f.post();
  const intent = f.access.beginHangup(context, call.id, f.proof);
  assert.equal(f.counts().hangups, 0);
  assert.equal(f.manager.activeSession?.status, 'ending');
  assert.equal(f.manager.isCleanupConfirmed(call.id), false);
  await assert.rejects(
    f.access.finishHangup({ ...intent }),
    (error: any) => error.code === 'UNAUTHORIZED',
  );
  f.session.revoked = true;
  const finishing = f.access.finishHangup(intent);
  await waitFor(() => f.counts().hangups === 1);
  assert.equal(f.counts().hangups, 1);
  release();
  await finishing;
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
  denied(() => f.access.recheckCleanup(context, call.id), 'UNAUTHORIZED');
});

test('lifecycle expires an owned active call without an SSE subscriber and never treats POST context as read', async (t) => {
  const f = fixture(t);
  const call = await f.create();
  const voice = await f.access.prepareVoice(f.post(), call.id, f.proof);
  f.manager.connectBrowser({
    ...voice.params,
    From: `client:${f.admissions[0].browserIdentity}`,
    CallSid: `CA${'2'.repeat(32)}`,
  });
  f.advance(20000); // Idle expiry boundary, independent of the manager presence.
  await waitFor(() => f.manager.isCleanupConfirmed(call.id));
  assert.equal(f.counts().hangups, 1);
  assert.equal(f.manager.activeSession, null);
});

test('an observer failure after an authorized end intent cannot strand provider cleanup', async (t) => {
  const f = fixture(t);
  const call = await f.create();
  const voice = await f.access.prepareVoice(f.post(), call.id, f.proof);
  f.manager.connectBrowser({
    ...voice.params,
    From: `client:${f.admissions[0].browserIdentity}`,
    CallSid: `CA${'3'.repeat(32)}`,
  });
  const listener = ({ event, data }: any) => {
    if (event === 'call' && data.status === 'ending')
      throw new Error('End subscriber test failure');
  };
  f.manager.on('event', listener);
  denied(
    () => f.access.beginHangup(f.post(true), call.id, f.proof),
    'NOT_FOUND',
  );
  assert.equal(f.counts().hangups, 0);
  assert.throws(
    () => f.access.beginHangup(f.post(), call.id, f.proof),
    /End subscriber test failure/,
  );
  f.manager.off('event', listener);
  await waitFor(() => f.manager.isCleanupConfirmed(call.id));
  assert.equal(f.counts().hangups, 1);
  assert.equal(f.manager.activeSession, null);
});

test('event commits are owner-scoped and revalidated after serialization or preparation', async (t) => {
  const f = fixture(t);
  const call = await f.create();
  const context = f.read();
  let sent = 0;
  const event = {
    event: 'conversation',
    data: { sessionId: call.id, text: 'private fixture' },
  };
  assert.equal(
    f.access.runAuthorizedEvent(context, event, () => {
      sent += 1;
    }),
    true,
  );
  for (const unknown of [
    { event: 'unknown', data: { sessionId: call.id } },
    { event: 'transcript', data: {} },
    { event: 'call', data: { id: 'other-call' } },
  ])
    assert.equal(
      f.access.runAuthorizedEvent(context, unknown, () => {
        sent += 1;
      }),
      false,
    );
  assert.equal(
    f.access.runAuthorizedEvent(f.read(true), event, () => {
      sent += 1;
    }),
    false,
  );
  f.session.revoked = true;
  denied(
    () =>
      f.access.runAuthorizedEvent(context, event, () => {
        sent += 1;
      }),
    'UNAUTHORIZED',
  );
  assert.equal(sent, 1);
});

test('session-only HTTP boundary guards pre-create/status and rechecks before buffered delivery', async (t) => {
  const f = fixture(t);
  const app = fastify();
  const transport = createCloudAccessTransport(f.policy);
  let effects = 0;
  app.post('/create', transport.sessionHttpRoute('mutate'), async (request) => {
    return transport.executeSessionHttp(request, () => {
      effects += 1;
      return { ok: true };
    });
  });
  app.get('/status', transport.sessionHttpRoute('read'), async (request) => {
    assert.ok(transport.requestContext(request));
    f.session.revoked = true;
    return { private: 'do not deliver' };
  });
  t.after(() => app.close());
  const missing = await app.inject({
    method: 'POST',
    url: '/create',
    headers: { host: 'phone.example.com', origin },
  });
  assert.equal(missing.statusCode, 401);
  assert.equal(effects, 0);
  const create = await app.inject({
    method: 'POST',
    url: '/create',
    headers: f.headers(),
  });
  assert.equal(create.statusCode, 200);
  assert.equal(effects, 1);
  const status = await app.inject({
    method: 'GET',
    url: '/status',
    headers: f.headers(),
  });
  assert.equal(status.statusCode, 401);
  assert.deepEqual(status.json(), { error: 'UNAUTHORIZED' });
  assert.ok(!status.body.includes('do not deliver'));
});

test('session commit rejects declared async callbacks before effects and stale contexts after await', async (t) => {
  const f = fixture(t);
  const context = f.post();
  let effects = 0;
  denied(
    () =>
      f.policy.runAuthorizedSession(context, 'mutate', async () => {
        effects += 1;
      }),
    'FORBIDDEN',
  );
  assert.equal(effects, 0);
  await delay(0);
  f.session.revoked = true;
  denied(
    () =>
      f.policy.runAuthorizedSession(context, 'mutate', () => {
        effects += 1;
      }),
    'UNAUTHORIZED',
  );
  assert.equal(effects, 0);
});

test('controlled reservations require a lease and use Pocket without global browser presence', async (t) => {
  const f = fixture(t);
  assert.equal(f.manager.available, false);
  await assert.rejects(
    f.access.prepareCreate(f.post(), config, '+14155550123'),
    (error: any) => error.code === 'FORBIDDEN',
  );
  for (const engine of ['legacy', 'continuous', 'nano-captions'] as const)
    await assert.rejects(
      f.access.prepareCreate(f.post(), config, '+14155550123', engine, f.proof),
      (error: any) => error.code === 'INVALID_TRANSLATION_ENGINE',
    );
  assert.equal(f.counts().publicChecks, 0);
  assert.equal(f.counts().factories, 0);
  const prepared = await f.access.prepareCreate(
    f.post(),
    config,
    '+14155550123',
    undefined,
    f.proof,
  );
  assert.equal(prepared.translationEngine, 'pocket-prefix');
  const call = f.access.createPrepared(prepared);
  assert.equal(call.translationEngine, 'pocket-prefix');
  assert.equal(f.counts().translationChecks, 1);
  denied(() => f.access.beginHangup(f.post(), call.id), 'FORBIDDEN');
  denied(
    () =>
      f.access.beginHangup(f.post(), call.id, {
        ...f.proof,
        tabId: 'other-tab',
      }),
    'FORBIDDEN',
  );
  denied(
    () =>
      f.access.beginHangup(f.post(), call.id, {
        ...f.proof,
        epoch: f.proof.epoch - 1,
      }),
    'FORBIDDEN',
  );
  assert.equal(f.access.ownedActive(f.read())?.id, call.id);
  assert.throws(
    () => f.access.acquireController(f.post(), 'other-tab'),
    (error: any) => error.code === 'CONTROLLER_BUSY',
  );
});

test('explicit continuous configuration publishes and enforces its own default without Pocket readiness', async (t) => {
  const engines: TranslationEngine[] = ['continuous-captions'];
  const f = fixture(t, {
    allowedTranslationEngines: engines,
    defaultTranslationEngine: 'continuous-captions',
  });
  engines.push('pocket-prefix');
  const bootstrap = f.access.browserSession(f.read());
  assert.deepEqual(bootstrap.translationEngines, ['continuous-captions']);
  assert.equal(bootstrap.defaultTranslationEngine, 'continuous-captions');
  assert.equal(bootstrap.outgoingPairedCaptions, false);
  assert.equal(f.access.configuredDefaultTranslationEngine, 'continuous-captions');
  assert.equal(Object.isFrozen(bootstrap.translationEngines), true);
  await assert.rejects(
    f.access.prepareCreate(f.post(), config, '+14155550123', 'pocket-prefix', f.proof),
    (error: any) => error.code === 'INVALID_TRANSLATION_ENGINE',
  );
  assert.equal(f.counts().translationChecks, 0);
  const prepared = await f.access.prepareCreate(f.post(), config, '+14155550123', undefined, f.proof);
  assert.equal(prepared.translationEngine, 'continuous-captions');
  assert.equal(f.access.createPrepared(prepared).translationEngine, 'continuous-captions');
  assert.deepEqual(f.checkedEngines, ['continuous-captions']);
});

test('explicit outgoing caption metadata cannot authorize an engine outside the configured allowlist', async (t) => {
  const f = fixture(t, {
    allowedTranslationEngines: ['continuous-captions'],
    defaultTranslationEngine: 'continuous-captions',
    outgoingPairedCaptions: true,
  });
  assert.equal(f.access.browserSession(f.read()).outgoingPairedCaptions, true);
  await assert.rejects(
    f.access.prepareCreate(f.post(), config, '+14155550123', 'pocket-prefix', f.proof),
    (error: any) => error.code === 'INVALID_TRANSLATION_ENGINE',
  );
  assert.equal(f.counts().publicChecks, 0);
});

test('revoking the controller during readiness refuses creation with the login still valid', async (t) => {
  let release: (result: any) => void;
  const f = fixture(t, {
    publicChecker: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const pending = f.access.prepareCreate(
    f.post(),
    config,
    '+14155550123',
    'pocket-prefix',
    f.proof,
  );
  f.access.revokeController(f.post(), f.proof);
  release({ status: 'ready', code: 'PUBLIC_CALLBACK_READY' });
  await assert.rejects(pending, (error: any) => error.code === 'FORBIDDEN');
  assert.equal(f.session.revoked, false);
  assert.equal(f.manager.activeSession, null);
  assert.equal(f.counts().factories, 0);
});

test('a missing Voice permission port rejects connection rather than falling back to local token identity', async (t) => {
  const f = fixture(t, { noVoice: true });
  const call = await f.create();
  await assert.rejects(
    f.access.prepareVoice(f.post(), call.id, f.proof),
    (error: any) =>
      error.code === 'VOICE_CONNECTION_NOT_READY' && error.statusCode === 503,
  );
  assert.throws(
    () =>
      f.manager.connectBrowser({
        ...call.connectionParams,
        From: `client:${f.admissions[0].browserIdentity}`,
        CallSid: `CA${'5'.repeat(32)}`,
        join: 'not-a-permit',
      }),
    (error: any) => error.code === 'VOICE_CONNECTION_NOT_READY',
  );
  assert.equal(f.counts().hangups, 0);
});

test('Voice delivery uses its private response and invalid callbacks cannot consume a legitimate join', async (t) => {
  const f = fixture(t);
  const call = await f.create();
  const context = f.post();
  const voice = await f.access.prepareVoice(context, call.id, f.proof);
  f.access.assertVoiceResponseCurrent(context, call.id, voice);
  denied(
    () => f.access.assertVoiceResponseCurrent(context, call.id, { ...voice }),
    'UNAUTHORIZED',
  );
  const fields = {
    ...voice.params,
    From: `client:${voice.grant.identity}`,
    CallSid: `CA${'6'.repeat(32)}`,
  };
  for (const bad of [
    { nonce: 'wrong' },
    { From: 'client:ai-phone' },
    { CallSid: 'invalid-sid' },
  ])
    assert.throws(() => f.manager.connectBrowser({ ...fields, ...bad }));
  assert.equal(f.counts().hangups, 0);
  assert.match(f.manager.connectBrowser(fields), /<Stream/);
  assert.match(f.manager.connectBrowser(fields), /<Stream/); // Same provider SID retry; no fresh grant.
  assert.throws(
    () =>
      f.manager.connectBrowser({ ...fields, CallSid: `CA${'7'.repeat(32)}` }),
    (error: any) => error.code === 'CALL_SID_MISMATCH',
  );
});

test('controller loss expires a live browser leg while authenticated read access remains valid', async (t) => {
  const f = fixture(t, { leaseTtlMs: 1000 });
  const call = await f.create();
  const voice = await f.access.prepareVoice(f.post(), call.id, f.proof);
  f.manager.connectBrowser({
    ...voice.params,
    From: `client:${voice.grant.identity}`,
    CallSid: `CA${'8'.repeat(32)}`,
  });
  f.advance(11000);
  f.access.readAccess(f.read(), call.id); // Reading does not extend the controller lease.
  await waitFor(() => f.manager.isCleanupConfirmed(call.id));
  assert.equal(f.session.revoked, false);
  assert.equal(f.counts().hangups, 1);
  assert.equal(f.manager.activeSession, null);
  assert.throws(
    () => f.access.renewController(f.post(), f.proof),
    (error: any) => error.code === 'FORBIDDEN',
  );
  const next = f.access.acquireController(f.post(), 'new-tab-after-cleanup');
  assert.ok(next.epoch > f.proof.epoch);
});

test('natural completion retries unconfirmed reservation release and blocks the next controller and call', async (t) => {
  let releaseAttempts = 0;
  let failRelease = true;
  const f = fixture(t, { voiceRelease: async () => {
    releaseAttempts += 1;
    if (failRelease) throw new Error('OFFLINE_RELEASE_UNCONFIRMED');
  } });
  const call = await f.create();
  await f.access.prepareVoice(f.post(), call.id, f.proof);
  await f.manager.end(call.id); // Natural/setup failure cleanup, not service hangup.
  assert.equal(f.manager.activeSession, null);
  await assert.rejects(f.access.prepareCreate(f.post(), config, '+14155550123', 'pocket-prefix', f.proof),
    (error: any) => error.code === 'CALL_CLEANUP_UNCONFIRMED');
  f.access.revokeController(f.post(), f.proof);
  assert.throws(() => f.access.acquireController(f.post(), 'next-tab'),
    (error: any) => error.code === 'CONTROLLER_BUSY');
  await waitFor(() => releaseAttempts > 0);
  assert.equal(f.voiceJoin.cleanupUnconfirmed, true);
  failRelease = false;
  await waitFor(() => !f.voiceJoin.cleanupUnconfirmed);
  const next = f.access.acquireController(f.post(), 'next-tab');
  assert.ok(next.epoch > f.proof.epoch);
});
