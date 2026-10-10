import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as nodeTest, type TestContext } from 'node:test';
import {
  setImmediate as tick,
  setTimeout as delay,
} from 'node:timers/promises';
import twilio from 'twilio';
import WebSocket from 'ws';

import {
  CLOUD_SESSION_COOKIE,
  CloudAccessPolicy,
  type CloudAuthSession,
} from '../src/solo/cloud-access';
import { CloudPhoneAccess } from '../src/solo/cloud-phone-access';
import {
  CloudControllerLeases,
  type ControllerProof,
} from '../src/solo/controller-lease';
import {
  CloudVoiceJoin,
  type CloudVoiceGrant,
} from '../src/solo/cloud-voice-join';
import { ConfigStore, type SoloConfig } from '../src/solo/config';
import { buildSoloServer } from '../src/solo/server';
import {
  SessionManager,
  type BridgeOptions,
  type CallProvider,
  type OutboundCallAdmission,
} from '../src/solo/session-manager';
import type { checkPublicReadiness } from '../src/solo/public-readiness';
import type { checkTranslationEngine } from '../src/solo/provider-checks';

const test = (name: string, body: (t: TestContext) => Promise<void>) =>
  nodeTest(name, { timeout: 10000 }, body);
const origin = 'https://phone.example.com';
const tokenA = Buffer.alloc(32, 11).toString('base64url');
const tokenB = Buffer.alloc(32, 12).toString('base64url');
const csrf = Buffer.alloc(32, 13).toString('base64url');
const localSid = `CA${'1'.repeat(32)}`;
const remoteSid = `CA${'2'.repeat(32)}`;
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
class MemoryMockIdentity {
  now = 1000;
  sessions = new Map<string, CloudAuthSession>([
    [tokenA, this.session('auth-a', 'owner-a')],
    [tokenB, this.session('auth-b', 'owner-b')],
  ]);
  private session(
    authSessionId: string,
    browserOwnerId: string,
  ): CloudAuthSession {
    return {
      authSessionId,
      browserOwnerId,
      principalId: 'one-test-account',
      epoch: 1,
      issuedAt: 100,
      absoluteExpiresAt: 100000,
      idleExpiresAt: 50000,
      revoked: false,
      csrfToken: csrf,
    };
  }
  resolve = (token: string) => {
    const session = this.sessions.get(token);
    return session ? { ...session } : null;
  };
}
function writeHeaders(token = tokenA) {
  return {
    host: 'phone.example.com',
    origin,
    cookie: `${CLOUD_SESSION_COOKIE}=${token}`,
    'x-phone-csrf': csrf,
  };
}
function readHeaders(token = tokenA) {
  return {
    host: 'phone.example.com',
    cookie: `${CLOUD_SESSION_COOKIE}=${token}`,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  };
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}
async function until(condition: () => boolean, description: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(`Timed out: ${description}`);
}
type SseFrame = { event: string; data: unknown };
async function fixture(
  t: TestContext,
  options: {
    publicChecker?: typeof checkPublicReadiness;
    translationChecker?: typeof checkTranslationEngine;
    create?: CallProvider['create'];
    hangup?: CallProvider['hangup'];
    listen?: boolean;
    voiceReady?: boolean;
    voicePreparation?: () => Promise<void>;
    voiceResponsePause?: () => Promise<void>;
    leaseTtlMs?: number;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-phone-integration-'));
  const store = new ConfigStore({
    envPath: join(directory, '.env'),
    values: config,
    generateToken: false,
  });
  const identity = new MemoryMockIdentity();
  const policy = new CloudAccessPolicy({
    publicOrigin: origin,
    resolveSession: identity.resolve,
    now: () => identity.now,
  });
  const created: Record<string, unknown>[] = [];
  const terminated: string[] = [];
  const admissions: OutboundCallAdmission[] = [];
  const bridgeOptions: BridgeOptions[] = [];
  const translationChecks: string[] = [];
  const events: SseFrame[] = [];
  const counters = {
    factory: 0,
    bridge: 0,
    publicReady: 0,
    translationReady: 0,
    externalNetwork: 0,
  };
  const providerState = { failHangup: false };
  const manager = new SessionManager({
    providerFactory: () => {
      counters.factory += 1;
      return {
        create: async (parameters) => {
          created.push(parameters);
          return options.create
            ? options.create(parameters)
            : { sid: remoteSid };
        },
        hangup: async (sid) => {
          terminated.push(sid);
          if (providerState.failHangup)
            throw new Error('private-provider-cleanup-secret');
          await options.hangup?.(sid);
        },
      };
    },
    bridgeFactory: (parameters) => {
      counters.bridge += 1;
      bridgeOptions.push(parameters);
      return {
        attach(role) {
          parameters.onConnection?.({ role, state: 'ready' });
        },
        close() {},
      };
    },
    setupTimeoutMs: 5000,
  });
  manager.on('event', (event) => events.push(event));
  const originalCreate = manager.createOutbound.bind(manager);
  t.mock.method(
    manager,
    'createOutbound',
    (...args: Parameters<SessionManager['createOutbound']>) => {
      if (args[3]) admissions.push(args[3]);
      return originalCreate(...args);
    },
  );
  const controllerLeases = new CloudControllerLeases({
    policy,
    now: () => identity.now,
    ttlMs: options.leaseTtlMs ?? 30000,
  });
  const grants: unknown[] = [];
  const voiceJoin = new CloudVoiceJoin({
    policy,
    outgoingApplicationSid: config.TWILIO_TWIML_APP_SID,
    now: () => identity.now,
    ...(options.voiceReady === false
      ? {}
      : {
          signer: async (grant) => {
            grants.push(grant);
            return `test-only-fake-voice-${grant.identity}`;
          },
          admission: {
            reserve: async () => {
              await options.voicePreparation?.();
              return {
                assertCurrent() {},
                release: async () => undefined,
              };
            },
          },
        }),
  });
  const access = new CloudPhoneAccess({
    policy,
    manager,
    controllerLeases,
    voiceJoin,
    publicReadinessChecker: async (...args) => {
      counters.publicReady += 1;
      return options.publicChecker
        ? options.publicChecker(...args)
        : { status: 'ready', code: 'PUBLIC_CALLBACK_READY' };
    },
    translationReadinessChecker: async (...args) => {
      counters.translationReady += 1;
      translationChecks.push(args[1]);
      return options.translationChecker
        ? options.translationChecker(...args)
        : {
            name: 'test-only-translation',
            status: 'passed',
            code: 'TEST_READY',
          };
    },
    revalidationIntervalMs: 10,
  });
  let loopbackPort = 0;
  const originalRequest = http.request;
  const forbidNetwork = () => {
    counters.externalNetwork += 1;
    throw new Error('Real providers are forbidden in this fixture');
  };
  t.mock.method(globalThis, 'fetch', forbidNetwork);
  t.mock.method(https, 'request', forbidNetwork);
  t.mock.method(http, 'request', (...args: unknown[]) => {
    const target = args[0] as http.RequestOptions;
    // Only this test's explicit ephemeral listener is reachable by HTTP/SSE/WS.
    if (
      loopbackPort &&
      target &&
      typeof target === 'object' &&
      (target.hostname || target.host) === '127.0.0.1' &&
      Number(target.port) === loopbackPort
    )
      return Reflect.apply(originalRequest, http, args) as ClientRequest;
    return forbidNetwork();
  });
  const app = await buildSoloServer({
    configStore: store,
    sessionManager: manager,
    publicDir: directory,
    browserControl: access,
  });
  if (options.voiceResponsePause)
    app.addHook('onSend', async (request, _reply, payload) => {
      if (/^\/api\/calls\/[^/]+\/voice$/.test(request.url))
        await options.voiceResponsePause!();
      return payload;
    });
  const clients = new Set<ClientRequest>();
  if (options.listen) {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '127.0.0.1');
    loopbackPort = address.port;
  }
  t.after(async () => {
    providerState.failHangup = false;
    for (const client of clients) client.destroy();
    for (const socket of app.websocketServer.clients) socket.terminate();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
    assert.equal(
      counters.externalNetwork,
      0,
      'No external network/provider calls',
    );
  });
  const proofs = new Map<string, ControllerProof>();
  const controller = (
    action: 'acquire' | 'renew' | 'revoke',
    token = tokenA,
    body: Record<string, unknown> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/controller/${action}`,
      headers: writeHeaders(token),
      payload: body,
    });
  const acquire = async (
    token = tokenA,
    tabId = `tab-${token === tokenA ? 'a' : 'b'}`,
  ) => {
    const result = await controller('acquire', token, { tabId });
    if (result.statusCode === 200) proofs.set(token, result.json());
    return result;
  };
  const revoke = async (token = tokenA) => {
    const result = await controller('revoke', token, { ...proofs.get(token) });
    if (result.statusCode === 200) proofs.delete(token);
    return result;
  };
  assert.equal(
    (await acquire()).statusCode,
    200,
    'Explicit owner controller acquire',
  );
  const call = async (token = tokenA, body: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/calls',
      headers: writeHeaders(token),
      payload: { to: '+12125550124', controller: proofs.get(token), ...body },
    });
  const status = (token = tokenA) =>
    app.inject({ url: '/api/status', headers: readHeaders(token) });
  const hangup = async (id: string, token = tokenA) =>
    app.inject({
      method: 'POST',
      url: `/api/calls/${encodeURIComponent(id)}/hangup`,
      headers: writeHeaders(token),
      payload: { controller: proofs.get(token) },
    });
  const voiceGrants = new Map<
    string,
    {
      token: string;
      join: string;
      grant: CloudVoiceGrant;
      params: Record<string, string>;
    }
  >();
  const voice = async (
    id: string,
    token = tokenA,
    proof = proofs.get(token),
  ) => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/calls/${encodeURIComponent(id)}/voice`,
      headers: writeHeaders(token),
      payload: { controller: proof },
    });
    if (response.statusCode === 200) voiceGrants.set(id, response.json());
    return response;
  };
  async function signed(path: string, fields: Record<string, string>) {
    if (path === '/voice/client' && fields.sessionId && !fields.join) {
      if (!voiceGrants.has(fields.sessionId)) {
        const permission = await voice(fields.sessionId);
        assert.equal(permission.statusCode, 200, permission.body);
      }
      fields = { ...fields, join: voiceGrants.get(fields.sessionId)!.join };
    }
    const body = { AccountSid: config.TWILIO_ACCOUNT_SID, ...fields };
    return app.inject({
      method: 'POST',
      url: path,
      headers: {
        host: 'phone.example.com',
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': twilio.getExpectedTwilioSignature(
          config.TWILIO_AUTH_TOKEN,
          `${origin}${path}`,
          body,
        ),
      },
      payload: new URLSearchParams(body).toString(),
    });
  }
  async function media(
    id: string,
    role: 'local' | 'remote',
    nonce: string,
    sid: string,
  ) {
    assert.ok(loopbackPort);
    const socket = new WebSocket(`ws://127.0.0.1:${loopbackPort}/voice/media`, {
      headers: {
        host: 'phone.example.com',
        'x-twilio-signature': twilio.getExpectedTwilioSignature(
          config.TWILIO_AUTH_TOKEN,
          `${origin}/voice/media`,
          {},
        ),
      },
    });
    socket.on('error', () => undefined);
    t.after(() => socket.terminate());
    await once(socket, 'open');
    socket.send(
      JSON.stringify({
        event: 'start',
        start: {
          accountSid: config.TWILIO_ACCOUNT_SID,
          callSid: sid,
          streamSid: `MZ${(role === 'local' ? '3' : '4').repeat(32)}`,
          customParameters: { sessionId: id, role, nonce },
          mediaFormat: {
            encoding: 'audio/x-mulaw',
            sampleRate: 8000,
            channels: 1,
          },
        },
      }),
    );
    await tick();
    await tick();
    return socket;
  }
  async function eventsFor(token = tokenA) {
    assert.ok(loopbackPort);
    const frames: SseFrame[] = [];
    let pending = '';
    const request = http.request({
      hostname: '127.0.0.1',
      port: loopbackPort,
      path: '/api/events',
      method: 'GET',
      headers: readHeaders(token),
    });
    clients.add(request);
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      request.once('error', reject);
      request.once('response', (stream) => {
        // Authorization closes can destroy a streaming socket mid-response.
        // Wait for its actual close event while handling the expected reset.
        stream.on('error', () => undefined);
        stream.on('data', (chunk) => {
          pending += chunk.toString();
          for (;;) {
            const index = pending.indexOf('\n\n');
            if (index < 0) break;
            const raw = pending.slice(0, index);
            pending = pending.slice(index + 2);
            const event = /^event: (.+)$/m.exec(raw)?.[1];
            const data = /^data: (.+)$/m.exec(raw)?.[1];
            if (event && data) frames.push({ event, data: JSON.parse(data) });
          }
        });
        resolve(stream);
      });
      request.end();
    });
    assert.equal(response.statusCode, 200);
    await until(() => frames.length > 0, 'initial SSE snapshot');
    return {
      frames,
      request,
      response,
      close: () => {
        request.destroy();
        response.destroy();
      },
    };
  }
  return {
    app,
    store,
    directory,
    identity,
    policy,
    manager,
    access,
    controllerLeases,
    voiceJoin,
    grants,
    proofs,
    acquire,
    revoke,
    controller,
    voice,
    voiceGrants,
    created,
    terminated,
    admissions,
    bridgeOptions,
    translationChecks,
    counters,
    providerState,
    events,
    call,
    status,
    hangup,
    signed,
    media,
    eventsFor,
  };
}

test('actual phone status and create routes isolate two authenticated sessions without browser owner claims', async (t) => {
  const f = await fixture(t);
  const created = await f.call(tokenA, {
    ownerId: 'owner-b',
    principalId: 'forged',
    identity: 'ai-phone',
  });
  assert.equal(created.statusCode, 200, created.body);
  const call = created.json();
  assert.ok(call.id && call.connectionParams.nonce);
  assert.equal(call.translationEngine, 'pocket-prefix');
  assert.equal(f.counters.translationReady, 1);
  assert.deepEqual(f.translationChecks, ['pocket-prefix']);
  assert.equal(f.counters.factory, 1);
  assert.equal(f.created.length, 0, 'HTTP creation has not dialed a supplier');
  const mine = await f.status();
  assert.deepEqual(Object.keys(mine.json()).sort(), ['activeSession', 'mode']);
  assert.equal(mine.json().activeSession.id, call.id);
  assert.equal((await f.status(tokenB)).json().activeSession, null);
  assert.ok(!mine.body.includes('nonce'));
  assert.equal(mine.headers['cache-control'], 'private, no-store');
  for (const token of [tokenA, tokenB]) {
    assert.ok([403, 409].includes((await f.call(token)).statusCode));
    assert.equal(f.counters.factory, 1);
  }
  const forbidden = await f.hangup(call.id, tokenB);
  const missing = await f.hangup('missing-call', tokenB);
  assert.equal(forbidden.statusCode, 404);
  assert.equal(missing.statusCode, 404);
  assert.equal(forbidden.body, missing.body);
  assert.equal(f.manager.activeSession?.id, call.id);
  assert.equal((await f.hangup(call.id)).statusCode, 200);
  assert.equal(f.manager.activeSession, null);
  const legacy = await f.call(tokenA, { translationEngine: 'legacy' });
  assert.equal(legacy.statusCode, 400);
  assert.deepEqual(legacy.json(), { error: 'INVALID_TRANSLATION_ENGINE' });
  assert.equal(f.counters.factory, 1);
  assert.deepEqual(f.translationChecks, ['pocket-prefix']);
});

test('actual phone API rejects missing identity, wrong origins, missing CSRF and remote socket addresses before readiness', async (t) => {
  const f = await fixture(t);
  for (const headers of [
    { ...writeHeaders(), cookie: '' },
    { ...writeHeaders(), origin: 'null' },
    { ...writeHeaders(), origin: 'https://evil.test' },
    { ...writeHeaders(), 'x-phone-csrf': '' },
    { ...readHeaders(), 'x-phone-csrf': csrf },
    {
      ...writeHeaders(),
      'sec-fetch-site': 'same-site',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    },
  ]) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/calls?ownerId=owner-a&method=GET',
      headers,
      payload: { to: '+12125550124' },
    });
    assert.ok([401, 403].includes(response.statusCode));
    assert.ok(!response.body.includes('nonce'));
  }
  assert.equal(
    (
      await f.app.inject({
        url: '/api/status',
        headers: readHeaders(),
        remoteAddress: '198.51.100.5',
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        url: `/api/status?token=${config.LOCAL_ACCESS_TOKEN}`,
        headers: {
          ...readHeaders(),
          cookie: '',
          authorization: `Bearer ${config.LOCAL_ACCESS_TOKEN}`,
        },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'HEAD',
        url: '/api/status',
        headers: readHeaders(),
      })
    ).statusCode,
    200,
  );
  assert.equal(f.counters.publicReady, 0);
  assert.equal(f.counters.factory, 0);
  assert.equal(f.manager.activeSession, null);
});

test('actual phone DI denies voice token, presence, administration and signed inbound calls', async (t) => {
  const f = await fixture(t);
  for (const [method, url, payload] of [
    ['GET', '/api/token', undefined],
    ['POST', '/api/presence', { available: true }],
    ['POST', '/api/settings', { OPENAI_API_KEY: 'forged' }],
    ['POST', '/api/verify', {}],
    ['POST', '/api/shutdown', {}],
    ['POST', '/api/connection-maintenance', { action: 'begin' }],
  ] as const) {
    const response = await f.app.inject({
      method,
      url,
      headers: writeHeaders(),
      payload,
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'CLOUD_CONTROL_UNAVAILABLE' });
  }
  const incoming = await f.signed('/voice/incoming', {
    To: config.TWILIO_CALLER_NUMBER,
    From: '+12125550124',
    CallSid: remoteSid,
  });
  assert.equal(incoming.statusCode, 200);
  assert.match(incoming.body, /<Reject/);
  assert.equal(f.counters.factory, 0);
  assert.equal(f.manager.activeSession, null);
});

test('revocation during the real create route public readiness leaves no call, event, nonce or provider', async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, {
    publicChecker: async () => {
      entered.resolve();
      await release.promise;
      return { status: 'ready', code: 'PUBLIC_CALLBACK_READY' };
    },
  });
  const pending = f.call();
  await entered.promise;
  f.identity.sessions.get(tokenA)!.revoked = true;
  release.resolve();
  const response = await pending;
  assert.equal(response.statusCode, 401);
  assert.ok(!response.body.includes('nonce'));
  assert.equal(f.counters.factory, 0);
  assert.equal(f.events.length, 0);
  assert.equal(f.manager.activeSession, null);
});

test('revocation during the real create route translation readiness leaves no media or provider', async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, {
    translationChecker: async () => {
      entered.resolve();
      await release.promise;
      return { name: 'test-only', status: 'passed', code: 'TEST_READY' };
    },
  });
  const pending = f.call(tokenA, { translationEngine: 'pocket-prefix' });
  await entered.promise;
  f.identity.sessions.get(tokenA)!.epoch += 1;
  release.resolve();
  const response = await pending;
  assert.equal(response.statusCode, 401);
  assert.equal(f.counters.factory, 0);
  assert.equal(f.counters.bridge, 0);
  assert.equal(f.events.length, 0);
});

test('real application SSE sees owner binding before first call publish and hides foreign and late old-call events', async (t) => {
  const f = await fixture(t, { listen: true });
  const a = await f.eventsFor();
  const b = await f.eventsFor(tokenB);
  assert.deepEqual(a.frames[0], {
    event: 'snapshot',
    data: { activeSession: null },
  });
  assert.deepEqual(b.frames[0], {
    event: 'snapshot',
    data: { activeSession: null },
  });
  const first = (await f.call()).json();
  await until(
    () =>
      a.frames.some(
        (frame) =>
          frame.event === 'call' &&
          (frame.data as { id: string }).id === first.id,
      ),
    'first owned call event',
  );
  f.manager.emit('event', {
    event: 'conversation',
    data: { sessionId: first.id, text: 'owner-a-private-text' },
  });
  await until(
    () => a.frames.some((frame) => frame.event === 'conversation'),
    'owned caption',
  );
  assert.equal(b.frames.length, 1);
  assert.equal((await f.hangup(first.id)).statusCode, 200);
  assert.equal((await f.revoke()).statusCode, 200);
  assert.equal((await f.acquire(tokenB)).statusCode, 200);
  const second = (await f.call(tokenB)).json();
  await until(
    () =>
      b.frames.some(
        (frame) =>
          frame.event === 'call' &&
          (frame.data as { id: string }).id === second.id,
      ),
    'second owner call',
  );
  const count = b.frames.length;
  f.manager.emit('event', {
    event: 'transcript',
    data: { sessionId: first.id, text: 'late-owner-a-private-text' },
  });
  f.manager.emit('event', {
    event: 'conversation',
    data: { sessionId: 'unknown-call', text: 'unbound-private-text' },
  });
  await delay(20);
  assert.equal(b.frames.length, count);
  assert.ok(!JSON.stringify(b.frames).includes('owner-a-private-text'));
  assert.ok(!JSON.stringify(b.frames).includes('late-owner-a-private-text'));
  assert.equal((await f.status()).json().activeSession, null);
  a.close();
  b.close();
});

test('real application SSE stops sending and closes after revocation without transferring the call', async (t) => {
  const f = await fixture(t, { listen: true });
  const stream = await f.eventsFor();
  const call = (await f.call()).json();
  await until(
    () => stream.frames.some((frame) => frame.event === 'call'),
    'call event',
  );
  f.identity.sessions.get(tokenA)!.revoked = true;
  const closed = new Promise<void>((resolve) =>
    stream.response.once('close', resolve),
  );
  f.manager.emit('event', {
    event: 'transcript',
    data: { sessionId: call.id, text: 'must-not-send-after-revoke' },
  });
  await closed;
  assert.equal(stream.response.destroyed, true);
  assert.ok(
    !JSON.stringify(stream.frames).includes('must-not-send-after-revoke'),
  );
  assert.equal((await f.status()).statusCode, 401);
  await until(() => f.manager.activeSession === null, 'revoked call cleanup');
  assert.equal((await f.status(tokenB)).json().activeSession, null);
});

test('DI dependency bundle cannot bypass cloud startup protection or fall back to real managers/checkers', async (t) => {
  const f = await fixture(t);
  for (const options of [
    { browserControl: f.access },
    { browserControl: f.access, configStore: f.store },
    {
      browserControl: f.access,
      configStore: f.store,
      sessionManager: new SessionManager(),
    },
    {
      browserControl: {} as CloudPhoneAccess,
      configStore: f.store,
      sessionManager: f.manager,
    },
    {
      browserControl: f.access,
      configStore: f.store,
      sessionManager: f.manager,
      publicReadinessChecker: async () => ({
        status: 'ready' as const,
        code: 'PUBLIC_CALLBACK_READY' as const,
      }),
    },
  ])
    await assert.rejects(
      buildSoloServer(options),
      /CLOUD_PHONE_DEPENDENCIES_REQUIRED/,
    );
  const wrongStore = new ConfigStore({
    envPath: join(f.directory, 'other.env'),
    values: { ...config, PUBLIC_BASE_URL: 'https://other.example.com' },
    generateToken: false,
  });
  await assert.rejects(
    buildSoloServer({
      browserControl: f.access,
      configStore: wrongStore,
      sessionManager: f.manager,
    }),
    /FORBIDDEN/,
  );
  writeFileSync(
    f.store.envPath,
    `AI_PHONE_RUNTIME_MODE=cloud\nPORT=5432\nCLOUD_PUBLIC_ORIGIN=${origin}\n`,
  );
  await assert.rejects(
    buildSoloServer({
      browserControl: f.access,
      configStore: f.store,
      sessionManager: f.manager,
    }),
    /CLOUD_AUTH_NOT_IMPLEMENTED/,
  );
  assert.equal(f.counters.publicReady, 0);
  assert.equal(f.counters.factory, 0);
  assert.equal(f.created.length, 0);
});

test('local default router keeps bearer/loopback authentication and existing token/presence behavior', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-phone-local-'));
  const store = new ConfigStore({
    envPath: join(directory, '.env'),
    values: config,
    generateToken: false,
  });
  const manager = new SessionManager({
    providerFactory: () => {
      throw new Error('No provider calls in local regression');
    },
  });
  const app = await buildSoloServer({
    configStore: store,
    sessionManager: manager,
    publicDir: directory,
  });
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const headers = {
    host: '127.0.0.1:5050',
    origin: 'http://127.0.0.1:5050',
    authorization: `Bearer ${config.LOCAL_ACCESS_TOKEN}`,
  };
  assert.equal(
    (await app.inject({ url: '/api/status', headers })).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ url: '/api/status', headers: readHeaders() }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: '/api/status',
        headers,
        remoteAddress: '198.51.100.5',
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/presence',
        headers,
        payload: { available: true },
      })
    ).statusCode,
    200,
  );
  assert.equal(manager.available, true);
  assert.equal(
    (await app.inject({ url: '/api/token', headers })).statusCode,
    200,
  );
});

test('two signed fake telephone legs use the server-issued identity and owner hangup is idempotent', async (t) => {
  const f = await fixture(t, { listen: true });
  const call = (await f.call()).json();
  const identity = f.admissions[0].browserIdentity;
  assert.match(identity, /^cloud-phone-/);
  const unsigned = await f.app.inject({
    method: 'POST',
    url: '/voice/client',
    headers: {
      ...writeHeaders(),
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: new URLSearchParams({
      AccountSid: config.TWILIO_ACCOUNT_SID,
      sessionId: call.id,
      nonce: call.connectionParams.nonce,
      CallSid: localSid,
      From: `client:${identity}`,
    }).toString(),
  });
  assert.equal(
    unsigned.statusCode,
    403,
    'A browser cookie cannot authorize Twilio callbacks',
  );
  assert.equal(f.created.length, 0);
  const wrongIdentity = await f.signed('/voice/client', {
    sessionId: call.id,
    nonce: call.connectionParams.nonce,
    CallSid: localSid,
    From: 'client:ai-phone',
  });
  assert.equal(wrongIdentity.statusCode, 403);
  const permission = f.voiceGrants.get(call.id)!;
  assert.equal(permission.grant.callId, call.id);
  assert.equal(permission.grant.authSessionId, 'auth-a');
  assert.equal(permission.grant.incomingAllow, false);
  assert.equal(
    permission.grant.outgoingApplicationSid,
    config.TWILIO_TWIML_APP_SID,
  );
  assert.equal(
    permission.grant.controller.leaseId,
    f.proofs.get(tokenA)!.leaseId,
  );
  assert.ok(
    permission.grant.expiresAt <=
      (f.proofs.get(tokenA) as ControllerProof & { expiresAt: number })
        .expiresAt,
  );
  assert.ok(permission.grant.expiresAt - permission.grant.issuedAt <= 60000);
  assert.equal(permission.grant.identity, identity);
  assert.match(permission.token, /^test-only-fake-voice-/);
  const fakeVoiceSdk = {
    connect: async ({ params }: { params: Record<string, string> }) => {
      assert.deepEqual(params, permission.params);
      return f.signed('/voice/client', {
        ...params,
        CallSid: localSid,
        From: `client:${permission.grant.identity}`,
      });
    },
  };
  const browser = await fakeVoiceSdk.connect({ params: permission.params });
  assert.equal(browser.statusCode, 200);
  assert.match(browser.body, /<Stream/, JSON.stringify(f.events));
  const local = await f.media(
    call.id,
    'local',
    call.connectionParams.nonce,
    localSid,
  );
  await until(() => f.created.length === 1, 'fake remote-leg create');
  const callback = new URL(String(f.created[0].url));
  const remoteNonce = callback.searchParams.get('nonce')!;
  const remote = await f.signed(`${callback.pathname}${callback.search}`, {
    CallSid: remoteSid,
  });
  assert.equal(remote.statusCode, 200);
  const phone = await f.media(call.id, 'remote', remoteNonce, remoteSid);
  await until(
    () => f.manager.activeSession?.status === 'active',
    'both fake media legs attached',
  );
  assert.equal(f.counters.bridge, 1);
  assert.equal(f.bridgeOptions[0].translationEngine, 'pocket-prefix');
  assert.equal(
    f.manager.available,
    false,
    'Cloud control never sets global local presence',
  );
  assert.equal((await f.status(tokenB)).json().activeSession, null);
  assert.equal((await f.hangup(call.id, tokenB)).statusCode, 404);
  const ended = await f.hangup(call.id);
  assert.equal(ended.statusCode, 200);
  assert.deepEqual([...f.terminated].sort(), [localSid, remoteSid].sort());
  assert.equal((await f.hangup(call.id)).statusCode, 200);
  assert.equal(f.terminated.length, 2);
  local.terminate();
  phone.terminate();
});

test('failed fake cleanup stays busy and private error text is not returned until retry confirms cleanup', async (t) => {
  const f = await fixture(t);
  const call = (await f.call()).json();
  await f.signed('/voice/client', {
    sessionId: call.id,
    nonce: call.connectionParams.nonce,
    CallSid: localSid,
    From: `client:${f.admissions[0].browserIdentity}`,
  });
  f.providerState.failHangup = true;
  const failed = await f.hangup(call.id);
  assert.equal(failed.statusCode, 503);
  assert.ok(!failed.body.includes('private-provider-cleanup-secret'));
  assert.equal(f.manager.activeSession?.status, 'ending');
  assert.equal((await f.call(tokenB)).statusCode, 403);
  assert.equal((await f.acquire(tokenB)).statusCode, 409);
  f.providerState.failHangup = false;
  assert.equal((await f.hangup(call.id)).statusCode, 200);
  assert.equal(f.manager.activeSession, null);
});

test('accepted hangup cleanup continues after revocation while its response is withheld', async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, {
    hangup: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const call = (await f.call()).json();
  await f.signed('/voice/client', {
    sessionId: call.id,
    nonce: call.connectionParams.nonce,
    CallSid: localSid,
    From: `client:${f.admissions[0].browserIdentity}`,
  });
  const response = f.hangup(call.id);
  await entered.promise;
  f.identity.sessions.get(tokenA)!.revoked = true;
  release.resolve();
  assert.equal((await response).statusCode, 401);
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
  assert.deepEqual(f.terminated, [localSid]);
  assert.equal(f.manager.activeSession, null);
});

test('revoked owner cannot join its old signed browser callback and it is cleaned without another fake dial', async (t) => {
  const f = await fixture(t);
  const call = (await f.call()).json();
  assert.equal((await f.voice(call.id)).statusCode, 200);
  f.identity.sessions.get(tokenA)!.revoked = true;
  await until(
    () => f.manager.activeSession === null,
    'old owner cleanup before new call',
  );
  assert.equal(
    (await f.acquire(tokenB)).statusCode,
    409,
    'A revoked login does not silently transfer a still-live controller lease',
  );
  f.identity.now = (
    f.proofs.get(tokenA) as ControllerProof & { expiresAt: number }
  ).expiresAt;
  assert.equal((await f.acquire(tokenB)).statusCode, 200);
  const second = (await f.call(tokenB)).json();
  assert.ok(second.id && second.id !== call.id);
  const result = await f.signed('/voice/client', {
    sessionId: call.id,
    nonce: call.connectionParams.nonce,
    CallSid: localSid,
    From: `client:${f.admissions[0].browserIdentity}`,
  });
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /<Hangup/);
  await until(
    () => f.terminated.includes(localSid),
    'cleanup of late signed browser SID',
  );
  assert.equal(f.created.length, 0);
  assert.equal(f.counters.bridge, 0);
  assert.equal((await f.status(tokenB)).json().activeSession.id, second.id);
  assert.equal(
    f.counters.factory,
    2,
    'Late old callback cannot create another session',
  );
});

async function fakeSdkTelephone(
  f: Awaited<ReturnType<typeof fixture>>,
  call: { id: string; connectionParams: { nonce: string } },
) {
  const response = await f.voice(call.id);
  assert.equal(response.statusCode, 200, response.body);
  const permission = f.voiceGrants.get(call.id)!;
  const fakeVoiceSdk = {
    connect: ({ params }: { params: Record<string, string> }) => {
      assert.deepEqual(params, permission.params);
      return f.signed('/voice/client', {
        ...params,
        CallSid: localSid,
        From: `client:${permission.grant.identity}`,
      });
    },
  };
  const joined = await fakeVoiceSdk.connect({ params: permission.params });
  assert.equal(joined.statusCode, 200);
  assert.match(joined.body, /<Stream/, JSON.stringify(f.events));
  const browser = await f.media(
    call.id,
    'local',
    call.connectionParams.nonce,
    localSid,
  );
  await until(
    () => f.created.length === 1,
    'fake supplier dial after permitted SDK join',
  );
  const callback = new URL(String(f.created[0].url));
  assert.equal(
    (
      await f.signed(`${callback.pathname}${callback.search}`, {
        CallSid: remoteSid,
      })
    ).statusCode,
    200,
  );
  const phone = await f.media(
    call.id,
    'remote',
    callback.searchParams.get('nonce')!,
    remoteSid,
  );
  await until(
    () => f.manager.activeSession?.status === 'active',
    'fake SDK two-leg flow',
  );
  return { permission, browser, phone };
}

test('actual controller routes protect same-session secondary tabs, reject stale epochs, and never return an existing lease', async (t) => {
  const f = await fixture(t, { listen: true });
  const proof = f.proofs.get(tokenA)!;
  assert.equal((await f.acquire(tokenA, 'tab-a')).statusCode, 409);
  assert.equal((await f.acquire(tokenA, 'tab-b')).statusCode, 409);
  assert.equal((await f.acquire(tokenB, 'tab-c')).statusCode, 409);
  const stream = await f.eventsFor();
  assert.equal((await f.status()).statusCode, 200);
  assert.ok(!JSON.stringify(stream.frames).includes(proof.leaseId));
  assert.ok(!(await f.status()).body.includes(proof.leaseId));
  for (const invalidProof of [
    undefined,
    { ...proof, tabId: 'tab-b' },
    { ...proof, leaseId: 'forged-lease' },
    { ...proof, epoch: proof.epoch - 1 },
  ]) {
    assert.equal(
      (await f.call(tokenA, { controller: invalidProof })).statusCode,
      403,
    );
    if (invalidProof)
      assert.equal(
        (await f.controller('renew', tokenA, invalidProof)).statusCode,
        403,
      );
  }
  const call = (await f.call()).json();
  assert.equal((await f.acquire(tokenA, 'tab-b')).statusCode, 409);
  assert.equal(
    (await f.voice(call.id, tokenA, { ...proof, tabId: 'tab-b' })).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/calls/${call.id}/hangup`,
        headers: writeHeaders(),
        payload: { controller: { ...proof, tabId: 'tab-b' } },
      })
    ).statusCode,
    403,
  );
  assert.equal(f.manager.activeSession?.id, call.id);
  assert.equal((await f.hangup(call.id)).statusCode, 200);
  assert.equal((await f.revoke()).statusCode, 200);
  const replacement = await f.acquire(tokenA, 'tab-b');
  assert.equal(replacement.statusCode, 200);
  assert.ok(replacement.json().epoch > proof.epoch);
  assert.notEqual(replacement.json().leaseId, proof.leaseId);
  assert.equal((await f.call(tokenA, { controller: proof })).statusCode, 403);
  stream.close();
});

test('actual per-call Voice permission refuses missing durable admission and signer instead of using local token secrets', async (t) => {
  const f = await fixture(t, { voiceReady: false });
  const call = (await f.call()).json();
  const result = await f.voice(call.id);
  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.json(), { error: 'VOICE_CONNECTION_NOT_READY' });
  assert.equal(f.grants.length, 0);
  assert.equal(f.created.length, 0);
  assert.equal(f.manager.available, false);
  assert.equal((await f.hangup(call.id)).statusCode, 200);
});

test('a prepared Voice join binds call and identity and is consumed once by the signed real callback', async (t) => {
  const f = await fixture(t);
  const first = (await f.call()).json();
  assert.equal((await f.voice(first.id)).statusCode, 200);
  const firstGrant = f.voiceGrants.get(first.id)!;
  assert.equal((await f.hangup(first.id)).statusCode, 200);
  const second = (await f.call()).json();
  assert.equal((await f.voice(second.id)).statusCode, 200);
  const permission = f.voiceGrants.get(second.id)!;
  const crossCall = await f.signed('/voice/client', {
    ...permission.params,
    join: firstGrant.join,
    CallSid: localSid,
    From: `client:${permission.grant.identity}`,
  });
  assert.equal(crossCall.statusCode, 403);
  assert.equal(f.created.length, 0);
  const body = {
    ...permission.params,
    CallSid: localSid,
    From: `client:${permission.grant.identity}`,
  };
  assert.equal((await f.signed('/voice/client', body)).statusCode, 200);
  assert.equal(
    (await f.signed('/voice/client', body)).statusCode,
    200,
    'Same signed provider SID replay remains idempotent',
  );
  assert.equal(
    (
      await f.signed('/voice/client', {
        ...body,
        CallSid: `CA${'5'.repeat(32)}`,
      })
    ).statusCode,
    403,
    'The consumed join cannot admit a second SDK leg',
  );
  assert.equal(
    f.created.length,
    0,
    'SDK join alone does not dial before media attach',
  );
  assert.equal((await f.hangup(second.id)).statusCode, 200);
  assert.deepEqual(f.terminated, [localSid]);
});

test('controller revoke during asynchronous Voice preparation yields no token or usable join', async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, {
    voicePreparation: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const call = (await f.call()).json();
  const pending = f.voice(call.id);
  await entered.promise;
  assert.equal((await f.revoke()).statusCode, 200);
  release.resolve();
  const denied = await pending;
  assert.equal(denied.statusCode, 403);
  assert.ok(!denied.body.includes('test-only-fake-voice-'));
  assert.equal(f.voiceGrants.size, 0);
  assert.equal(f.created.length, 0);
  await until(
    () => f.manager.activeSession === null,
    'revoked reservation cleanup',
  );
});

test('fake SDK call receives paired owner captions and SSE reconnection cannot extend the controller lease', async (t) => {
  const f = await fixture(t, { listen: true });
  const originalStream = await f.eventsFor();
  const readonlyStream = await f.eventsFor(tokenB);
  const call = (await f.call()).json();
  const { browser, phone, permission } = await fakeSdkTelephone(f, call);
  assert.equal(f.bridgeOptions[0].translationEngine, 'pocket-prefix');
  assert.match(permission.token, /^test-only-fake-voice-/);
  const emitCaption = f.bridgeOptions[0].onConversationTranscript!;
  emitCaption({
    id: 'fake-source',
    utteranceId: 'fake-utterance',
    role: 'local',
    kind: 'original',
    text: '我想明天下午预约。',
    final: true,
    at: f.identity.now,
  });
  emitCaption({
    id: 'fake-translation',
    utteranceId: 'fake-utterance',
    role: 'local',
    kind: 'translation',
    text: 'I would like an appointment tomorrow afternoon.',
    final: true,
    at: f.identity.now,
  });
  await until(
    () =>
      originalStream.frames.filter((frame) => frame.event === 'conversation')
        .length === 2,
    'paired owner caption events',
  );
  const captions = originalStream.frames
    .filter((frame) => frame.event === 'conversation')
    .map(
      (frame) =>
        frame.data as { utteranceId: string; kind: string; text: string },
    );
  assert.equal(captions[0].utteranceId, captions[1].utteranceId);
  assert.deepEqual(
    captions.map((event) => event.kind),
    ['original', 'translation'],
  );
  assert.ok(!JSON.stringify(readonlyStream.frames).includes('appointment'));
  const expiry = (
    f.proofs.get(tokenA) as ControllerProof & { expiresAt: number }
  ).expiresAt;
  f.identity.now = expiry - 1;
  assert.equal((await f.status()).json().activeSession.id, call.id);
  originalStream.close();
  const reconnected = await f.eventsFor();
  assert.equal((await f.status()).json().activeSession.id, call.id);
  f.identity.now = expiry;
  await until(
    () => f.manager.activeSession === null,
    'unrenewed controller expiry cleans fake legs',
  );
  assert.deepEqual([...f.terminated].sort(), [localSid, remoteSid].sort());
  assert.equal((await f.call()).statusCode, 403);
  const count = reconnected.frames.length;
  emitCaption({
    id: 'late',
    utteranceId: 'fake-late',
    role: 'local',
    kind: 'translation',
    text: 'must not publish after controller expiry',
    final: true,
    at: f.identity.now,
  });
  await delay(20);
  assert.equal(reconnected.frames.length, count);
  reconnected.close();
  readonlyStream.close();
  browser.terminate();
  phone.terminate();
});

test('lease expiry after signing but before the real Voice response write withholds the fake token', async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, {
    voiceResponsePause: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const call = (await f.call()).json();
  const pending = f.voice(call.id);
  await entered.promise;
  assert.equal(f.grants.length, 1, 'Signer completed before the response hook');
  f.identity.now = (
    f.proofs.get(tokenA) as ControllerProof & { expiresAt: number }
  ).expiresAt;
  release.resolve();
  const denied = await pending;
  assert.equal(denied.statusCode, 403);
  assert.ok(!denied.body.includes('test-only-fake-voice-'));
  assert.ok(!denied.body.includes('join'));
  assert.equal(f.voiceGrants.size, 0);
  assert.equal(f.created.length, 0);
});

test('controller revoke during actual call readiness cancels reservation before any publish or provider', async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, {
    publicChecker: async () => {
      entered.resolve();
      await release.promise;
      return { status: 'ready', code: 'PUBLIC_CALLBACK_READY' };
    },
  });
  const pending = f.call();
  await entered.promise;
  assert.equal((await f.revoke()).statusCode, 200);
  assert.equal(
    (await f.acquire(tokenB)).statusCode,
    409,
    'Preparation prevents takeover',
  );
  release.resolve();
  const denied = await pending;
  assert.equal(denied.statusCode, 403);
  assert.equal(f.counters.factory, 0);
  assert.equal(f.events.length, 0);
  assert.equal(f.manager.activeSession, null);
  assert.equal((await f.acquire(tokenB)).statusCode, 200);
});

test('only explicit authenticated controller renew extends the lease, and Voice permission still requires write credentials', async (t) => {
  const f = await fixture(t);
  const proof = f.proofs.get(tokenA)!;
  const oldDeadline = (proof as ControllerProof & { expiresAt: number })
    .expiresAt;
  f.identity.now += 1000;
  const renewal = await f.controller('renew', tokenA, proof);
  assert.equal(renewal.statusCode, 200);
  assert.equal(renewal.json().leaseId, proof.leaseId);
  assert.equal(renewal.json().epoch, proof.epoch);
  assert.ok(renewal.json().expiresAt > oldDeadline);
  const call = (await f.call()).json();
  for (const headers of [
    { ...writeHeaders(), cookie: '' },
    { ...writeHeaders(), origin: 'https://evil.test' },
    { ...writeHeaders(), 'x-phone-csrf': '' },
  ]) {
    const denied = await f.app.inject({
      method: 'POST',
      url: `/api/calls/${call.id}/voice`,
      headers,
      payload: { controller: proof },
    });
    assert.ok([401, 403].includes(denied.statusCode));
    assert.ok(!denied.body.includes('test-only-fake-voice-'));
  }
  assert.equal(f.grants.length, 0);
  assert.equal((await f.voice(call.id, tokenB)).statusCode, 404);
  assert.equal((await f.hangup(call.id)).statusCode, 200);
});

test('expired controller cleanup failure keeps both fake legs busy until termination is confirmed', async (t) => {
  const f = await fixture(t, { listen: true });
  const call = (await f.call()).json();
  const { browser, phone } = await fakeSdkTelephone(f, call);
  f.providerState.failHangup = true;
  f.identity.now = (
    f.proofs.get(tokenA) as ControllerProof & { expiresAt: number }
  ).expiresAt;
  await until(
    () => f.manager.activeSession?.status === 'ending',
    'expiry accepts end intent',
  );
  await until(
    () => f.terminated.includes(localSid) && f.terminated.includes(remoteSid),
    'expiry attempts both fake legs',
  );
  assert.equal(f.manager.isCleanupConfirmed(call.id), false);
  const blocked = await f.acquire(tokenB);
  assert.equal(blocked.statusCode, 409);
  assert.ok(!blocked.body.includes('private-provider-cleanup-secret'));
  assert.equal((await f.call(tokenB)).statusCode, 403);
  f.providerState.failHangup = false;
  await until(
    () => f.manager.activeSession === null,
    'retry confirms both legs clean',
  );
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
  assert.equal((await f.acquire(tokenB)).statusCode, 200);
  const next = await f.call(tokenB);
  assert.equal(next.statusCode, 200, next.body);
  assert.notEqual(next.json().id, call.id);
  browser.terminate();
  phone.terminate();
});
