import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import WebSocket from 'ws';
import type { SoloConfig } from '../src/solo/config';
import {
  createSessionBridge,
  SessionManager,
  type Role,
} from '../src/solo/session-manager';
import { createPersonalVoiceAdmission } from '../src/solo/cloud-service';
import type { CloudVoiceReservation } from '../src/solo/cloud-voice-join';

// Production personal admission, manager, bridge and real protocol clients.
// Only phone/model transports are fake. No journal is opened or initialized.
const config = {
  PUBLIC_BASE_URL: 'https://phone.example.com',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_CALLER_NUMBER: '+12125550123',
  OPENAI_API_KEY: 'offline-not-a-key',
  OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
  OPENAI_TRANSCRIPTION_MODEL: 'gpt-4o-mini-transcribe',
} as SoloConfig;
const target = '+14155550123';
const applicationSid = `AP${'a'.repeat(32)}`;
const identity = 'offline-browser';
const localSid = `CA${'1'.repeat(32)}`;
const remoteSid = `CA${'2'.repeat(32)}`;
const streams = {
  local: `MZ${'3'.repeat(32)}`,
  remote: `MZ${'4'.repeat(32)}`,
};

class OfflineSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }

  send(raw: string, callback?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(raw));
    callback?.();
  }

  receive(event: unknown): void {
    this.emit('message', JSON.stringify(event));
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  terminate(): void {
    this.close();
  }

  socket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

async function fixture(
  t: TestContext,
  options: {
    lateCreate?: boolean;
    failHangup?: boolean;
    createError?: Error;
  } = {},
) {
  let now = 100000;
  let authorized = true;
  let failHangup = options.failHangup ?? false;
  const providers: Array<{ url: string; socket: OfflineSocket }> = [];
  const created: Record<string, unknown>[] = [];
  const limited: number[] = [];
  const hungup: string[] = [];
  let occupancy: CloudVoiceReservation | undefined;
  let resolveCreate!: (value: { sid: string }) => void;
  const pendingCreate = new Promise<{ sid: string }>((resolve) => {
    resolveCreate = resolve;
  });
  const manager = new SessionManager({
    maxCallMs: null,
    allowedTarget: target,
    now: () => now,
    providerFactory: () => ({
      create: async (args) => {
        created.push(args);
        if (options.createError) throw options.createError;
        return options.lateCreate ? pendingCreate : { sid: remoteSid };
      },
      hangup: async (sid) => {
        hungup.push(sid);
        if (failHangup && sid === localSid)
          throw new Error('OFFLINE_TERMINATION_UNKNOWN');
      },
      limit: async (_sid, seconds) => {
        limited.push(seconds);
        throw new Error('NO_APPLICATION_DURATION_LIMIT_EXPECTED');
      },
    }),
    bridgeFactory: (settings) =>
      createSessionBridge({
        ...settings,
        outgoingCaptions: true,
        captionFailureEndsCall: true,
        createWebSocket: (url) => {
          const socket = new OfflineSocket();
          providers.push({ url, socket });
          return socket.socket();
        },
      }),
  });
  const newCall = (destination = target) =>
    manager.createOutbound(config, destination, 'continuous-captions', {
      browserIdentity: identity,
      deferBrowserJoin: true,
      beforePublish: () => {},
      authorizeCurrent: () => {
        if (!authorized) throw new Error('OFFLINE_AUTH_EXPIRED');
      },
      authorizeBrowserJoin: (fields) => {
        assert.equal(fields.From, `client:${identity}`);
        assert.equal(fields.CallSid, localSid);
        occupancy!.assertCurrent();
        return 'join';
      },
    });
  const call = newCall();
  occupancy = await createPersonalVoiceAdmission(manager).reserve({
    version: 1,
    callId: call.id,
    identity,
    authSessionId: 'offline_session',
    principalId: 'offline_principal',
    browserOwnerId: 'offline_owner',
    authEpoch: 1,
    controller: { leaseId: 'offline_lease', tabId: 'offline_tab', epoch: 1 },
    issuedAt: now,
    expiresAt: now + 60000,
    incomingAllow: false,
    outgoingApplicationSid: applicationSid,
    outgoing: { callId: call.id, identity },
  });
  const browserReply = manager.connectBrowserControlled({
    ...call.connectionParams,
    From: `client:${identity}`,
    CallSid: localSid,
  });
  const attach = (role: Role, socket: OfflineSocket, nonce: string) =>
    manager.attachMedia(socket.socket(), {
      accountSid: config.TWILIO_ACCOUNT_SID,
      callSid: role === 'local' ? localSid : remoteSid,
      streamSid: streams[role],
      customParameters: { sessionId: call.id, role, nonce },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    });
  t.after(async () => {
    failHangup = false;
    resolveCreate({ sid: remoteSid });
    await tick();
    await manager.close();
  });
  return {
    manager,
    call,
    occupancy,
    providers,
    created,
    limited,
    hungup,
    browserReply,
    attach,
    newCall,
    resolveCreate,
    acknowledgeLimit: () => {},
    advance: (ms: number) => {
      now += ms;
    },
    revoke: () => {
      authorized = false;
    },
    allowCleanup: () => {
      failHangup = false;
    },
  };
}
async function startNative(f: Awaited<ReturnType<typeof fixture>>) {
  f.acknowledgeLimit();
  await f.browserReply;
  const local = new OfflineSocket();
  local.open();
  assert.equal(f.attach('local', local, f.call.connectionParams.nonce), true);
  const native = f.providers[0].socket;
  assert.equal(f.created.length, 0);
  native.open();
  assert.equal(f.created.length, 0);
  native.receive({
    type: 'session.updated',
    session: {
      model: 'gpt-realtime-translate',
      audio: { output: { language: 'en' } },
    },
  });
  await tick();
  assert.equal(f.created.length, 1);
  return { local, native };
}

async function startAll(f: Awaited<ReturnType<typeof fixture>>) {
  const first = await startNative(f);
  const nonce = new URL(f.created[0].url as string).searchParams.get('nonce')!;
  const remote = new OfflineSocket();
  remote.open();
  f.manager.connectLeg(f.call.id, 'remote', nonce, remoteSid);
  assert.equal(f.attach('remote', remote, nonce), true);
  assert.equal(f.providers.length, 5);
  for (const { socket } of f.providers.slice(1)) {
    socket.open();
    assert.equal(socket.sent[0]?.type, 'session.update');
    socket.receive({
      type: 'session.updated',
      session: socket.sent[0].session,
    });
  }
  await tick();
  assert.equal(f.manager.activeSession?.translationReady, true);
  return { ...first, remote };
}

const requests = (socket: OfflineSocket) =>
  socket.sent.filter((event) => event.type === 'response.create');

function assertStopped(
  f: Awaited<ReturnType<typeof fixture>>,
  phones: OfflineSocket[],
) {
  for (const socket of [...phones, ...f.providers.map((p) => p.socket)])
    assert.equal(socket.readyState, WebSocket.CLOSED);
  for (const phone of phones)
    assert.equal(
      phone.sent.filter((event) => event.event === 'clear').length,
      1,
    );
  for (const { socket } of f.providers)
    assert.equal(
      socket.sent.some((event) => event.type === 'session.close'),
      false,
    );
}

test('personal call remains active beyond five minutes and the old one-hour app timer, with no budget timeLimit on either leg', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  await startAll(f);
  f.advance(301000);
  t.mock.timers.tick(301000);
  await tick();
  assert.equal(f.manager.activeSession?.status, 'active');
  f.advance(3300000);
  t.mock.timers.tick(3300000);
  await tick();
  assert.equal(f.manager.activeSession?.status, 'active');
  assert.deepEqual(f.limited, []);
  assert.equal(Object.hasOwn(f.created[0], 'timeLimit'), false);
  await f.manager.end(f.call.id);
  await f.occupancy.release();
  assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
});

test('audio above the old 300/600-second byte budgets and text above 60 requests are no longer budget-denied', async (t) => {
  const f = await fixture(t);
  const { native } = await startAll(f);
  const raw = JSON.stringify({
    type: 'session.input_audio_buffer.append',
    audio: Buffer.alloc(48000).toString('base64'),
  });
  for (let i = 0; i < 601; i++) native.send(raw);
  assert.equal(
    native.sent.filter((x) => x.type.endsWith('.append')).length,
    601,
  );
  const text = f.providers[2].socket;
  for (let i = 0; i < 61; i++)
    text.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          conversation: 'none',
          modalities: ['text'],
          max_output_tokens: 1200,
          input: [],
        },
      }),
    );
  assert.equal(requests(text).length, 61);
  assert.equal(f.manager.activeSession?.status, 'active');
});

test('one concurrent call and target restriction remain; confirmed hangup permits another personal call without a lifetime spending slot', async (t) => {
  const f = await fixture(t);
  const { local, remote } = await startAll(f);
  assert.throws(() => f.newCall(), /BUSY/);
  assert.throws(() => f.newCall('+14155550124'), /CALL_TARGET_NOT_ALLOWED/);
  await assert.rejects(f.occupancy.release(), /CALL_CLEANUP_UNCONFIRMED/);
  await f.manager.end(f.call.id);
  await f.occupancy.release();
  assertStopped(f, [local, remote]);
  assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
  assert.throws(
    () => f.occupancy.assertCurrent(),
    /CALL_AUTHORIZATION_REVOKED/,
  );
  assert.notEqual(f.newCall().id, f.call.id);
});

for (const trigger of ['disconnect', 'error', 'authorization'] as const)
  test(`personal ${trigger} still stops media and cleans both phone legs`, async (t) => {
    const f = await fixture(t);
    const { local, remote, native } = await startAll(f);
    if (trigger === 'disconnect') local.close();
    if (trigger === 'error')
      native.receive({
        type: 'error',
        error: { message: 'offline provider error' },
      });
    if (trigger === 'authorization') {
      f.revoke();
      const sent = native.sent.length;
      native.send(
        JSON.stringify({
          type: 'session.input_audio_buffer.append',
          audio: Buffer.alloc(480).toString('base64'),
        }),
      );
      assert.equal(native.sent.length, sent);
    }
    await tick();
    await tick();
    assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
    assert.equal(local.readyState, WebSocket.CLOSED);
    assert.equal(remote.readyState, WebSocket.CLOSED);
    assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
    assert.equal(f.providers.length, 5);
  });

for (const modelIndex of [1, 2, 3, 4])
  test(`personal caption model ${modelIndex} failure ends both legs without reconnecting`, async (t) => {
    const f = await fixture(t);
    const { local, remote } = await startAll(f);
    f.providers[modelIndex].socket.receive({
      type: 'error',
      error: { message: 'offline model access failure' },
    });
    await tick();
    await tick();
    assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
    assertStopped(f, [local, remote]);
    assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
    assert.equal(f.providers.length, 5);
  });

test('native model failure before readiness never dials the remote number and closes the browser leg', async (t) => {
  const f = await fixture(t);
  await f.browserReply;
  const local = new OfflineSocket();
  local.open();
  assert.equal(f.attach('local', local, f.call.connectionParams.nonce), true);
  const native = f.providers[0].socket;
  native.open();
  native.receive({
    type: 'error',
    error: { message: 'offline access denied' },
  });
  await tick();
  await tick();
  assert.equal(f.created.length, 0);
  assert.deepEqual(f.hungup, [localSid]);
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
  assertStopped(f, [local]);
  assert.equal(f.providers.length, 1);
});

test('failed hangup keeps only the real unresolved leg blocking admission and allows cleanup retry', async (t) => {
  const f = await fixture(t, { failHangup: true });
  await startAll(f);
  await f.manager.end(f.call.id);
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), false);
  assert.equal(f.manager.controlAdmissionBlocked, true);
  await assert.rejects(f.occupancy.release(), /CALL_CLEANUP_UNCONFIRMED/);
  await assert.rejects(f.manager.close(), /CALL_CLEANUP_UNCONFIRMED/);
  assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
  f.allowCleanup();
  await f.manager.end(f.call.id);
  await f.occupancy.release();
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
});

test('late remote creation after user hangup is still terminated without any journal', async (t) => {
  const f = await fixture(t, { lateCreate: true });
  await startNative(f);
  await f.manager.end(f.call.id);
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), false);
  f.resolveCreate({ sid: remoteSid });
  await tick();
  await tick();
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
  assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
  await f.occupancy.release();
});

test('an actual ambiguous create failure keeps its responsibility until the signed status path identifies the remote leg', async (t) => {
  const f = await fixture(t, {
    createError: new Error('OFFLINE_CONNECTION_LOST'),
  });
  await startNative(f);
  await tick();
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), false);
  await assert.rejects(f.occupancy.release(), /CALL_CLEANUP_UNCONFIRMED/);
  const nonce = new URL(f.created[0].url as string).searchParams.get('nonce')!;
  assert.throws(() =>
    f.manager.handleStatus(f.call.id, 'remote', 'wrong-nonce', {
      CallSid: remoteSid,
      CallStatus: 'completed',
    }),
  );
  f.manager.handleStatus(f.call.id, 'remote', nonce, {
    CallSid: remoteSid,
    CallStatus: 'completed',
  });
  await tick();
  await f.manager.end(f.call.id);
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
  await f.occupancy.release();
});
