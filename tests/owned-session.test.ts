import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type WebSocket from 'ws';
import type { SoloConfig } from '../src/solo/config';
import {
  SessionManager,
  type BridgeOptions,
  type CallProvider,
  type Role,
} from '../src/solo/session-manager';

// Explicit offline doubles: no credentials, suppliers, sockets or voice models.
const config = {
  PUBLIC_BASE_URL: 'https://phone.example.com',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_CALLER_NUMBER: '+12125550123',
  OPENAI_API_KEY: 'offline-test-no-api',
  OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
  OPENAI_TRANSCRIPTION_MODEL: 'gpt-4o-mini-transcribe',
} as SoloConfig;
const localSid = `CA${'1'.repeat(32)}`;
const remoteSid = `CA${'2'.repeat(32)}`;
const unrelatedSid = `CA${'9'.repeat(32)}`;
const browserIdentity = 'offline-owner-browser-A';
type Call = ReturnType<SessionManager['createOutbound']>;
type ObservedEvent = { event: string; data: Record<string, unknown> };

class OfflineSocket extends EventEmitter {
  readyState = 1;

  closes = 0;

  sent: unknown[] = [];

  close(_code?: number, _reason?: string): void {
    if (this.readyState === 3) return;
    this.closes += 1;
    this.readyState = 3;
    // Deliberately synchronous: close handlers must not turn an intent into I/O.
    this.emit('close');
  }

  send(data: unknown): void {
    this.sent.push(data);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fixture(
  t: TestContext,
  options: {
    create?: CallProvider['create'];
    hangup?: CallProvider['hangup'];
    beforePublish?: (id: string) => void;
    beforeProvider?: () => void;
    onAttach?: (role: Role) => void;
    onEvent?: (event: ObservedEvent) => void;
    beforeClose?: () => void;
  } = {},
) {
  const created: Record<string, unknown>[] = [];
  const ended: string[] = [];
  const attached: Role[] = [];
  const bridgeSockets = new Map<Role, WebSocket>();
  const bridgeInputs: { role: Role; data: string }[] = [];
  const events: ObservedEvent[] = [];
  const order: string[] = [];
  let revoked = false;
  let providerFactories = 0;
  let bridgeFactories = 0;
  let bridgeClosed = 0;
  let bridgeOptions: BridgeOptions | undefined;
  const registeredCalls = new Set<string>();
  const provider: CallProvider = {
    create: async (args) => {
      created.push(args);
      return options.create ? options.create(args) : { sid: remoteSid };
    },
    hangup: async (sid) => {
      ended.push(sid);
      await options.hangup?.(sid);
    },
  };
  const manager = new SessionManager({
    providerFactory: () => {
      order.push('provider');
      providerFactories += 1;
      options.beforeProvider?.();
      return provider;
    },
    bridgeFactory: (settings) => {
      bridgeFactories += 1;
      bridgeOptions = settings;
      return {
        attach: (role, socket) => {
          attached.push(role);
          bridgeSockets.set(role, socket);
          socket.on('message', (data: WebSocket.RawData) => {
            bridgeInputs.push({ role, data: data.toString() });
          });
          options.onAttach?.(role);
        },
        close: () => {
          bridgeClosed += 1;
        },
      };
    },
    setupTimeoutMs: 75000,
  });
  manager.on('event', (event: ObservedEvent) => {
    order.push('event');
    events.push(event);
    options.onEvent?.(event);
  });
  manager.setPresence(true);
  t.after(async () => {
    options.beforeClose?.();
    await manager.close();
  });
  const admission = {
    browserIdentity,
    beforePublish: (id: string) => {
      order.push('admission');
      options.beforePublish?.(id);
      registeredCalls.add(id);
    },
    authorizeCurrent: () => {
      if (revoked) throw new Error('OFFLINE_OWNER_REVOKED');
    },
  };
  return {
    manager,
    admission,
    created,
    ended,
    attached,
    bridgeInputs,
    events,
    order,
    registeredCalls,
    revoke: () => {
      revoked = true;
    },
    providerFactories: () => providerFactories,
    bridgeFactories: () => bridgeFactories,
    bridgeClosed: () => bridgeClosed,
    bridgeSocket: (role: Role) => {
      const socket = bridgeSockets.get(role);
      assert.ok(socket);
      return socket;
    },
    bridge: () => {
      assert.ok(bridgeOptions);
      return bridgeOptions;
    },
  };
}

function owned(f: ReturnType<typeof fixture>): Call {
  return f.manager.createOutbound(
    config,
    '+14155550123',
    'legacy',
    f.admission,
  );
}

function connectBrowser(f: ReturnType<typeof fixture>, call: Call): string {
  return f.manager.connectBrowser({
    ...call.connectionParams,
    From: `client:${browserIdentity}`,
    CallSid: localSid,
  });
}

function attach(
  f: ReturnType<typeof fixture>,
  call: Call,
  role: Role = 'local',
  nonce = call.connectionParams.nonce,
  sid = localSid,
  overrides: Record<string, unknown> = {},
) {
  const socket = new OfflineSocket();
  const accepted = f.manager.attachMedia(socket as unknown as WebSocket, {
    accountSid: config.TWILIO_ACCOUNT_SID,
    callSid: sid,
    streamSid: `MZ${(role === 'local' ? '3' : '4').repeat(32)}`,
    customParameters: { sessionId: call.id, role, nonce },
    mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    ...overrides,
  });
  return { socket, accepted };
}

function remoteNonce(f: ReturnType<typeof fixture>): string {
  assert.equal(f.created.length, 1);
  assert.equal(typeof f.created[0].url, 'string');
  const nonce = new URL(f.created[0].url as string).searchParams.get('nonce');
  assert.ok(nonce);
  return nonce;
}

test('trusted ownership is registered before provider construction and the first call event', (t) => {
  let f: ReturnType<typeof fixture>;
  f = fixture(t, {
    beforeProvider: () => assert.equal(f.registeredCalls.size, 1),
    onEvent: (event) => {
      if (event.event === 'call')
        assert.ok(f.registeredCalls.has(event.data.id as string));
    },
  });
  const call = owned(f);
  assert.ok(f.registeredCalls.has(call.id));
  assert.equal(f.order[0], 'admission');
  assert.ok(f.order.indexOf('admission') < f.order.indexOf('provider'));
  assert.ok(f.order.indexOf('admission') < f.order.indexOf('event'));
  assert.equal(f.created.length, 0);
});

test('failed ownership registration allocates no session, timer, provider or event', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scheduled = t.mock.method(globalThis, 'setTimeout');
  const f = fixture(t, {
    beforePublish: () => {
      throw new Error('OFFLINE_REGISTRATION_DENIED');
    },
  });
  assert.throws(() => owned(f), /OFFLINE_REGISTRATION_DENIED/);
  assert.equal(f.manager.activeSession, null);
  assert.equal(f.providerFactories(), 0);
  assert.equal(f.bridgeFactories(), 0);
  assert.equal(scheduled.mock.callCount(), 0);
  assert.deepEqual(f.events, []);
  t.mock.timers.tick(75001);
  await tick();
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.ended, []);
});

test('revoked admission cannot register or create a new call', (t) => {
  const f = fixture(t);
  f.revoke();
  assert.throws(() => owned(f));
  assert.equal(f.manager.activeSession, null);
  assert.equal(f.registeredCalls.size, 0);
  assert.equal(f.providerFactories(), 0);
  assert.deepEqual(f.events, []);
});

test('control readiness requires both explicit offline dependencies and session lookup retains cleanup tombstones', async (t) => {
  const defaults = new SessionManager();
  const onlyProvider = new SessionManager({
    providerFactory: () => ({
      create: async () => ({ sid: remoteSid }),
      hangup: async () => {},
    }),
  });
  t.after(async () => {
    await Promise.all([defaults.close(), onlyProvider.close()]);
  });
  assert.equal(defaults.hasExplicitControlDependencies, false);
  assert.equal(onlyProvider.hasExplicitControlDependencies, false);
  const f = fixture(t);
  assert.equal(f.manager.hasExplicitControlDependencies, true);
  assert.equal(f.manager.hasSession('unallocated-offline-call'), false);
  const call = owned(f);
  assert.equal(f.manager.hasSession(call.id), true);
  await f.manager.end(call.id);
  assert.equal(
    f.manager.hasSession(call.id),
    true,
    'late callbacks still require the owned tombstone',
  );
});

test('undefined admission preserves the local client:ai-phone identity', (t) => {
  const f = fixture(t);
  const call = f.manager.createOutbound(config, '+14155550123');
  assert.throws(
    () =>
      f.manager.connectBrowser({
        ...call.connectionParams,
        From: `client:${browserIdentity}`,
        CallSid: localSid,
      }),
    /INVALID_BROWSER_CALL/,
  );
  assert.match(
    f.manager.connectBrowser({
      ...call.connectionParams,
      From: 'client:ai-phone',
      CallSid: localSid,
    }),
    /<Stream/,
  );
  assert.equal(f.created.length, 0);
});

test('a nonce or request-supplied identity cannot replace the trusted browser From', (t) => {
  const f = fixture(t);
  const call = owned(f);
  for (const From of [
    '',
    'client:ai-phone',
    'client:offline-owner-browser-B',
  ]) {
    assert.throws(
      () =>
        f.manager.connectBrowser({
          ...call.connectionParams,
          From,
          CallSid: unrelatedSid,
          browserIdentity,
          expectedBrowserIdentity: browserIdentity,
        }),
      /INVALID_BROWSER_CALL/,
    );
  }
  assert.throws(
    () =>
      f.manager.connectBrowser({
        sessionId: call.id,
        nonce: 'other-call-nonce',
        From: `client:${browserIdentity}`,
        CallSid: unrelatedSid,
      }),
    /INVALID_SESSION/,
  );
  assert.deepEqual(f.ended, []);
  assert.equal(f.manager.activeSession?.status, 'connecting');
  assert.match(connectBrowser(f, call), /<Stream/);
});

test('revoked browser admission validates nonce, From and SID before cleanup-only binding', async (t) => {
  const f = fixture(t);
  const call = owned(f);
  f.revoke();
  assert.throws(
    () =>
      f.manager.connectBrowser({
        sessionId: call.id,
        nonce: 'invalid',
        From: `client:${browserIdentity}`,
        CallSid: unrelatedSid,
      }),
    /INVALID_SESSION/,
  );
  assert.throws(
    () =>
      f.manager.connectBrowser({
        ...call.connectionParams,
        From: 'client:offline-owner-browser-B',
        CallSid: unrelatedSid,
      }),
    /INVALID_BROWSER_CALL/,
  );
  assert.throws(
    () =>
      f.manager.connectBrowser({
        ...call.connectionParams,
        From: `client:${browserIdentity}`,
        CallSid: 'invalid-sid',
      }),
    /CALL_SID_MISMATCH/,
  );
  assert.deepEqual(f.ended, []);
  assert.equal(f.manager.activeSession?.status, 'connecting');
  assert.match(connectBrowser(f, call), /<Hangup/);
  await tick();
  assert.deepEqual(f.ended, [localSid]);
  assert.deepEqual(f.created, []);
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
});

test('revoked valid media refuses bridge and dialing after all Twilio bindings pass', async (t) => {
  const f = fixture(t);
  const call = owned(f);
  connectBrowser(f, call);
  f.revoke();
  const media = attach(f, call);
  assert.equal(media.accepted, false);
  assert.equal(media.socket.readyState, 3);
  await tick();
  assert.equal(f.bridgeFactories(), 0);
  assert.deepEqual(f.attached, []);
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.ended, [localSid]);
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
});

test('invalid media cannot use a revoked owner to trigger cleanup of an unrelated call', (t) => {
  const f = fixture(t);
  const call = owned(f);
  connectBrowser(f, call);
  f.revoke();
  const malformed = attach(
    f,
    call,
    'local',
    call.connectionParams.nonce,
    localSid,
    {
      accountSid: `AC${'9'.repeat(32)}`,
    },
  );
  assert.equal(malformed.accepted, false);
  assert.equal(f.manager.activeSession?.status, 'connecting');
  assert.deepEqual(f.ended, []);
  assert.equal(f.bridgeFactories(), 0);
});

test('revocation between media admission and provider submission creates no uncertain leg', async (t) => {
  let f: ReturnType<typeof fixture>;
  f = fixture(t, { onAttach: () => f.revoke() });
  const call = owned(f);
  connectBrowser(f, call);
  attach(f, call);
  await tick();
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.ended, [localSid]);
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
  assert.equal(f.manager.activeSession, null);
});

test('a bound bridge receives no subsequent input media after owner revocation', async (t) => {
  const f = fixture(t);
  const call = owned(f);
  connectBrowser(f, call);
  const local = attach(f, call);
  await tick();
  const payload = JSON.stringify({
    event: 'media',
    media: { payload: 'Zg==' },
  });
  local.socket.emit('message', Buffer.from(payload));
  assert.deepEqual(f.bridgeInputs, [{ role: 'local', data: payload }]);
  f.revoke();
  local.socket.emit('message', Buffer.from(payload));
  await tick();
  assert.deepEqual(f.bridgeInputs, [{ role: 'local', data: payload }]);
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
  assert.deepEqual([...f.ended].sort(), [localSid, remoteSid].sort());
});

test('a bound bridge sends no output audio after owner revocation', async (t) => {
  const f = fixture(t);
  const call = owned(f);
  connectBrowser(f, call);
  const local = attach(f, call);
  await tick();
  const payload = JSON.stringify({
    event: 'media',
    media: { payload: 'Zg==' },
  });
  f.bridgeSocket('local').send(payload);
  assert.deepEqual(local.socket.sent, [payload]);
  f.revoke();
  f.bridgeSocket('local').send(payload);
  await tick();
  assert.deepEqual(local.socket.sent, [payload]);
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
  assert.deepEqual([...f.ended].sort(), [localSid, remoteSid].sort());
});

test('protected media listeners preserve facade this, once, off and chain identity', async (t) => {
  const f = fixture(t);
  const call = owned(f);
  connectBrowser(f, call);
  const local = attach(f, call);
  await tick();
  const facade = f.bridgeSocket('local');
  const observed: WebSocket[] = [];
  let onceCount = 0;
  function listener(this: WebSocket): void {
    observed.push(this);
  }
  function once(this: WebSocket): void {
    assert.equal(this, facade);
    onceCount += 1;
  }
  assert.equal(facade.on('message', listener), facade);
  assert.equal(facade.once('message', once), facade);
  local.socket.emit('message', Buffer.from('{"event":"media"}'));
  local.socket.emit('message', Buffer.from('{"event":"media"}'));
  assert.deepEqual(observed, [facade, facade]);
  assert.equal(onceCount, 1);
  assert.equal(facade.off('message', listener), facade);
  local.socket.emit('message', Buffer.from('{"event":"media"}'));
  assert.equal(observed.length, 2);
  assert.equal(onceCount, 1);
  f.revoke();
  assert.equal(facade.on('message', listener), facade);
  local.socket.emit('message', Buffer.from('{"event":"media"}'));
  await tick();
  assert.equal(observed.length, 2);
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
});

test('revoked output settles its callback and permits only an exact destination clear', async (t) => {
  const f = fixture(t);
  const call = owned(f);
  connectBrowser(f, call);
  const local = attach(f, call);
  await tick();
  const facade = f.bridgeSocket('local');
  const streamSid = `MZ${'3'.repeat(32)}`;
  const rejected: (Error | undefined)[] = [];
  f.revoke();
  facade.send(
    JSON.stringify({ event: 'media', media: { payload: 'Zg==' } }),
    (error?: Error) => rejected.push(error),
  );
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0] instanceof Error);
  assert.deepEqual(local.socket.sent, []);
  for (const packet of [
    { event: 'clear', streamSid: `MZ${'9'.repeat(32)}` },
    { event: 'clear', streamSid, payload: 'Zg==' },
    { event: 'clear', streamSid, unknown: true },
    { event: 'media', streamSid },
  ])
    facade.send(JSON.stringify(packet));
  assert.deepEqual(local.socket.sent, []);
  const clear = JSON.stringify({ event: 'clear', streamSid });
  facade.send(clear);
  facade.send(Buffer.from(clear));
  assert.deepEqual(local.socket.sent, [clear, Buffer.from(clear)]);
  await tick();
  assert.equal(rejected.length, 1);
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
});

test('an ended pending create still cleans up its late SID after owner revocation', async (t) => {
  const pending = deferred<{ sid: string }>();
  const f = fixture(t, {
    create: () => pending.promise,
    beforeClose: () => pending.resolve({ sid: remoteSid }),
  });
  const call = owned(f);
  connectBrowser(f, call);
  attach(f, call);
  assert.equal(f.created.length, 1);
  f.manager.beginEndIntent(call.id);
  await f.manager.end(call.id);
  f.revoke();
  pending.resolve({ sid: remoteSid });
  await tick();
  assert.deepEqual([...f.ended].sort(), [localSid, remoteSid].sort());
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
  assert.equal(f.manager.activeSession, null);
  assert.equal(f.created.length, 1);
});

test('revocation discovered by a pending create result cleans both legs without a prior hangup request', async (t) => {
  const pending = deferred<{ sid: string }>();
  const f = fixture(t, {
    create: () => pending.promise,
    beforeClose: () => pending.resolve({ sid: remoteSid }),
  });
  const call = owned(f);
  connectBrowser(f, call);
  attach(f, call);
  assert.equal(f.created.length, 1);
  f.revoke();
  pending.resolve({ sid: remoteSid });
  await tick();
  assert.deepEqual([...f.ended].sort(), [localSid, remoteSid].sort());
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
  assert.equal(f.manager.activeSession, null);
  assert.equal(f.created.length, 1);
});

test('revoked connectLeg keeps nonce and bound-SID checks before cleanup-only TwiML', async (t) => {
  const f = fixture(t);
  const call = owned(f);
  connectBrowser(f, call);
  attach(f, call);
  await tick();
  const nonce = remoteNonce(f);
  f.revoke();
  assert.throws(
    () => f.manager.connectLeg(call.id, 'remote', 'invalid', unrelatedSid),
    /INVALID_SESSION/,
  );
  assert.throws(
    () => f.manager.connectLeg(call.id, 'remote', nonce, unrelatedSid),
    /CALL_SID_MISMATCH/,
  );
  assert.deepEqual(f.ended, []);
  assert.match(
    f.manager.connectLeg(call.id, 'remote', nonce, remoteSid),
    /<Hangup/,
  );
  await tick();
  assert.deepEqual([...f.ended].sort(), [localSid, remoteSid].sort());
  assert.equal(f.ended.includes(unrelatedSid), false);
  assert.equal(f.created.length, 1);
});

test('revoked status callbacks cannot bind an injected SID and only clean validated legs', async (t) => {
  const f = fixture(t);
  const call = owned(f);
  connectBrowser(f, call);
  attach(f, call);
  await tick();
  const nonce = remoteNonce(f);
  f.revoke();
  assert.throws(
    () =>
      f.manager.handleStatus(call.id, 'remote', 'invalid', {
        CallSid: unrelatedSid,
        CallStatus: 'ringing',
      }),
    /INVALID_SESSION/,
  );
  assert.throws(
    () =>
      f.manager.handleStatus(call.id, 'remote', nonce, {
        CallSid: unrelatedSid,
        CallStatus: 'ringing',
      }),
    /CALL_SID_MISMATCH/,
  );
  assert.deepEqual(f.ended, []);
  f.manager.handleStatus(call.id, 'remote', nonce, {
    CallSid: remoteSid,
    CallStatus: 'ringing',
  });
  await tick();
  assert.deepEqual([...f.ended].sort(), [localSid, remoteSid].sort());
  assert.equal(f.ended.includes(unrelatedSid), false);
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
});

test('a terminal local status after revocation still cleans up the nonterminal remote leg', async (t) => {
  const f = fixture(t);
  const call = owned(f);
  connectBrowser(f, call);
  attach(f, call);
  await tick();
  f.revoke();
  f.manager.handleStatus(call.id, 'local', call.connectionParams.nonce, {
    CallSid: localSid,
    CallStatus: 'completed',
  });
  await tick();
  assert.deepEqual(f.ended, [remoteSid]);
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
  assert.equal(f.manager.activeSession, null);
  f.manager.handleStatus(call.id, 'local', call.connectionParams.nonce, {
    CallSid: localSid,
    CallStatus: 'completed',
  });
  await tick();
  assert.deepEqual(f.ended, [remoteSid]);
});

test('beginEndIntent synchronously stops both media legs and bridge without provider hangup', async (t) => {
  const f = fixture(t);
  const call = owned(f);
  connectBrowser(f, call);
  const local = attach(f, call);
  await tick();
  const nonce = remoteNonce(f);
  f.manager.connectLeg(call.id, 'remote', nonce, remoteSid);
  const remote = attach(f, call, 'remote', nonce, remoteSid);
  assert.equal(f.manager.activeSession?.status, 'active');
  f.manager.beginEndIntent(call.id);
  assert.equal(f.manager.activeSession?.status, 'ending');
  assert.equal(f.manager.activeSession?.translationReady, false);
  assert.equal(f.bridgeClosed(), 1);
  assert.equal(local.socket.readyState, 3);
  assert.equal(remote.socket.readyState, 3);
  assert.deepEqual(f.ended, []);
  await tick();
  assert.deepEqual(f.ended, [], 'intent does not defer an implicit hangup');
  f.manager.beginEndIntent(call.id);
  assert.equal(f.bridgeClosed(), 1);
  assert.equal(local.socket.closes, 1);
  assert.equal(remote.socket.closes, 1);
  await f.manager.end(call.id);
  assert.deepEqual([...f.ended].sort(), [localSid, remoteSid].sort());
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
});

test('a throwing ending subscriber cannot prevent synchronous media stop or later provider cleanup', async (t) => {
  const f = fixture(t);
  const call = owned(f);
  connectBrowser(f, call);
  const local = attach(f, call);
  await tick();
  const nonce = remoteNonce(f);
  f.manager.connectLeg(call.id, 'remote', nonce, remoteSid);
  const remote = attach(f, call, 'remote', nonce, remoteSid);
  assert.equal(f.manager.activeSession?.status, 'active');
  const failingSubscriber = (event: ObservedEvent) => {
    if (event.event === 'call' && event.data.status === 'ending') {
      throw new Error('OFFLINE_ENDING_SUBSCRIBER_FAILED');
    }
  };
  f.manager.on('event', failingSubscriber);
  try {
    assert.throws(
      () => f.manager.beginEndIntent(call.id),
      /OFFLINE_ENDING_SUBSCRIBER_FAILED/,
    );
    assert.equal(f.manager.activeSession?.status, 'ending');
    assert.equal(local.socket.readyState, 3);
    assert.equal(remote.socket.readyState, 3);
    assert.equal(f.bridgeClosed(), 1);
    assert.deepEqual(f.ended, []);
    await tick();
    assert.deepEqual(
      f.ended,
      [],
      'subscriber failure cannot start implicit provider work',
    );
  } finally {
    f.manager.off('event', failingSubscriber);
  }
  await f.manager.end(call.id);
  assert.deepEqual([...f.ended].sort(), [localSid, remoteSid].sort());
  assert.equal(f.bridgeClosed(), 1);
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
  assert.equal(f.manager.activeSession, null);
});

test('repeated intents and concurrent end calls coalesce provider cleanup', async (t) => {
  const cleanup = deferred<void>();
  const f = fixture(t, {
    hangup: () => cleanup.promise,
    beforeClose: () => cleanup.resolve(),
  });
  const call = owned(f);
  connectBrowser(f, call);
  attach(f, call);
  await tick();
  f.manager.beginEndIntent(call.id, 'OFFLINE_STOP');
  f.manager.beginEndIntent(call.id, 'OFFLINE_STOP');
  assert.deepEqual(f.ended, []);
  const first = f.manager.end(call.id);
  const second = f.manager.end(call.id);
  await tick();
  assert.deepEqual([...f.ended].sort(), [localSid, remoteSid].sort());
  assert.equal(f.bridgeClosed(), 1);
  assert.equal(f.manager.activeSession?.status, 'ending');
  cleanup.resolve();
  await Promise.all([first, second]);
  await f.manager.end(call.id);
  assert.deepEqual([...f.ended].sort(), [localSid, remoteSid].sort());
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
  const final = f.events.findLast((event) => event.event === 'call')?.data;
  assert.ok(final);
  assert.equal(final.status, 'failed');
  assert.equal(final.error, 'OFFLINE_STOP');
});
