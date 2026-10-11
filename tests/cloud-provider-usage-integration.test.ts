import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import WebSocket from 'ws';

import { CloudBudgetJournal } from '../src/solo/cloud-budget-journal';
import type { SoloConfig } from '../src/solo/config';
import {
  createSessionBridge,
  SessionManager,
  type Role,
} from '../src/solo/session-manager';

// Real journal, manager, bridge and protocol clients. Only supplier transports
// are deterministic fakes; no external API, paid model or phone is contacted.
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
  options: { lateCreate?: boolean; reservationUsdMicros?: number } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-provider-usage-'));
  const now = 100000;
  const journal = CloudBudgetJournal.open({
    directory,
    now: () => now,
    policy: {
      allowedTarget: target,
      accountSid: config.TWILIO_ACCOUNT_SID,
      applicationSid,
      budgetUsdMicros: 5000000,
      worstCaseCallUsdMicros: options.reservationUsdMicros ?? 5_000_000,
      maxCalls: 1,
      maxWallClockMs: 300000,
      maxInputBytes: 72_000_000,
      maxOutputBytes: 72_000_000,
      lateCallbackWindowMs: 1000,
      rates: {
        // Synthetic offline evidence, not a claim about current real prices.
        twilioReference: 'https://www.twilio.com/synthetic-offline-test',
        openaiReference: 'https://openai.com/synthetic-offline-test',
        checkedAt: now - 1000,
        validUntil: now + 3600000,
      },
    },
  });
  const providers: Array<{ url: string; socket: OfflineSocket }> = [];
  const created: Record<string, unknown>[] = [];
  const limited: Array<{ sid: string; seconds: number }> = [];
  const hungup: string[] = [];
  const persisted = () =>
    JSON.parse(readFileSync(join(directory, 'trial-budget.json'), 'utf8'));
  let acknowledgeLimit!: () => void;
  const limitAcknowledged = new Promise<void>((resolve) => {
    acknowledgeLimit = resolve;
  });
  const forbidLocalVoice = () => {
    throw new Error('OFFLINE_LOCAL_VOICE_MUST_NOT_START');
  };
  let resolveCreate!: (value: { sid: string }) => void;
  const pendingCreate = new Promise<{ sid: string }>((resolve) => {
    resolveCreate = resolve;
  });
  const manager = new SessionManager({
    providerUsage: {
      reservationUsdMicros: options.reservationUsdMicros ?? 5_000_000,
      outgoingPairedCaptions: true,
    },
    callJournal: journal,
    maxCallMs: 300000,
    now: () => now,
    providerFactory: () => ({
      create: async (args) => {
        // The actual on-disk intent must exist before submitting a dial.
        assert.equal(persisted().intents[0].remote.phase, 'started');
        created.push(args);
        return options.lateCreate ? pendingCreate : { sid: remoteSid };
      },
      hangup: async (sid) => {
        hungup.push(sid);
      },
      limit: async (sid, seconds) => {
        limited.push({ sid, seconds });
        await limitAcknowledged;
      },
    }),
    bridgeFactory: (settings) =>
      createSessionBridge(
        {
          ...settings,
          outgoingCaptions: true,
          createWebSocket: (url) => {
            const socket = new OfflineSocket();
            providers.push({ url, socket });
            return socket.socket();
          },
        },
        {
          nano: forbidLocalVoice,
          nanoCaption: forbidLocalVoice,
          pocket: forbidLocalVoice,
        },
      ),
  });
  t.after(async () => {
    acknowledgeLimit();
    resolveCreate({ sid: remoteSid });
    await manager.close();
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = manager.createOutbound(config, target, 'continuous-captions', {
    browserIdentity: identity,
    deferBrowserJoin: true,
    beforePublish: () => {},
    authorizeCurrent: () => {},
    authorizeBrowserJoin: (fields) => {
      assert.equal(fields.From, `client:${identity}`);
      assert.equal(fields.CallSid, localSid);
      return 'join';
    },
  });
  await journal.reserve({
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
  manager.enforceCallDeadline(call.id);
  journal.beginCreate(call.id, 'local');
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
  const media = (role: Role, socket: OfflineSocket, audio: Buffer) =>
    socket.receive({
      event: 'media',
      streamSid: streams[role],
      media: { track: 'inbound', payload: audio.toString('base64') },
    });
  return {
    manager,
    resolveCreate,
    call,
    providers,
    created,
    limited,
    hungup,
    persisted,
    browserReply,
    acknowledgeLimit,
    attach,
    media,
  };
}

async function startNative(f: Awaited<ReturnType<typeof fixture>>) {
  f.acknowledgeLimit();
  await f.browserReply;
  const local = new OfflineSocket();
  local.open();
  assert.equal(f.attach('local', local, f.call.connectionParams.nonce), true);
  const native = f.providers[0].socket;
  native.open();
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

test('five real protocol clients share a single text allowance and denied sends synchronously stop media before two-leg cleanup', async (t) => {
  const f = await fixture(t, { reservationUsdMicros: 2_300_000 });
  const { local, remote } = await startAll(f);
  const outgoingAsr = f.providers[1].socket;
  const outgoingText = f.providers[2].socket;
  const remoteAsr = f.providers[3].socket;
  const remoteText = f.providers[4].socket;
  // Exercise both real caption pumps first, including their actual instructions,
  // metadata, encoded context and maximum output reservations.
  outgoingAsr.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'outgoing_first',
    content_index: 0,
    transcript: '您好。',
  });
  remoteAsr.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'remote_first',
    content_index: 0,
    transcript: 'Hello.',
  });
  assert.equal(requests(outgoingText).length, 1);
  assert.equal(requests(remoteText).length, 1);
  const templates = [requests(outgoingText)[0], requests(remoteText)[0]];
  const sockets = [outgoingText, remoteText];
  // Simulate further queued sends at the actual transport seam. Neither branch
  // may obtain a new allowance; reuse/cancellation never refunds reservations.
  let denied = false;
  let deniedReservation = 0;
  const reservedFee = (socket: OfflineSocket, request: Record<string, any>) =>
    (Buffer.byteLength(JSON.stringify(request)) +
      Buffer.byteLength(socket.sent[0].session.instructions) +
      4096) *
      4 +
    request.response.max_output_tokens * 16;
  for (let i = 0; i < 12; i += 1) {
    const socket = sockets[i % 2];
    const before = socket.sent.length;
    const request = { ...templates[i % 2], event_id: `extra_${i}` };
    socket.send(JSON.stringify(request));
    if (socket.sent.length === before) {
      denied = true;
      deniedReservation = reservedFee(socket, request);
      assertStopped(f, [local, remote]);
      assert.equal(
        f.hungup.length,
        0,
        'media closes before asynchronous REST cleanup',
      );
      break;
    }
  }
  assert.equal(denied, true);
  // Sum the actual wire envelopes, including session instructions and the
  // published conservative framing allowance. The rejected operation must
  // exceed the remaining shared amount, while each branch alone remains below
  // the full allowance: separate per-client budgets would wrongly permit it.
  const branchReservations = sockets.map((socket) =>
    requests(socket).reduce(
      (total, request) => total + reservedFee(socket, request),
      0,
    ),
  );
  const totalReserved = branchReservations.reduce(
    (sum, value) => sum + value,
    0,
  );
  assert.ok(totalReserved <= 300_000);
  assert.ok(totalReserved + deniedReservation > 300_000);
  assert.ok(
    branchReservations.every((value) => value + deniedReservation <= 300_000),
  );
  const counts = sockets.map((socket) => socket.sent.length);
  sockets.forEach((socket, i) => socket.send(JSON.stringify(templates[i])));
  assert.deepEqual(
    sockets.map((socket) => socket.sent.length),
    counts,
  );
  await tick();
  assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
  const ledger = f.persisted();
  assert.equal(ledger.chargedUsdMicros, 2_300_000);
  assert.notEqual(ledger.intents[0].usage, 'confirmed');
  assert.equal(ledger.intents[0].local.phase, 'terminal');
  assert.equal(ledger.intents[0].remote.phase, 'terminal');
  assert.equal(f.providers.length, 5);
});

for (const observerThrows of [false, true]) {
  test(`budget denial still terminates a late REST-created leg${observerThrows ? ' when an ending observer throws' : ''}`, async (t) => {
    const f = await fixture(t, { lateCreate: true });
    const { local, native } = await startNative(f);
    let observerFailures = 0;
    if (observerThrows)
      f.manager.on('event', () => {
        if (f.manager.activeSession?.status === 'ending') {
          observerFailures += 1;
          throw new Error('OFFLINE_OBSERVER_FAILED');
        }
      });
    const before = native.sent.length;
    // An unrecognized billable operation must fail closed before the fake wire.
    native.send(JSON.stringify({ type: 'response.create', response: {} }));
    assert.equal(native.sent.length, before);
    assertStopped(f, [local]);
    assert.equal(observerFailures > 0, observerThrows);
    await tick();
    assert.deepEqual(f.hungup, [localSid]);
    assert.equal(f.manager.isCleanupConfirmed(f.call.id), false);
    f.resolveCreate({ sid: remoteSid });
    await tick();
    await tick();
    assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
    assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
    assert.equal(f.persisted().intents[0].remote.phase, 'terminal');
    assert.equal(f.persisted().chargedUsdMicros, 5_000_000);
    assert.equal(
      f.providers.length,
      1,
      'no fallback provider after budget denial',
    );
  });
}

test('faster-than-realtime native media reaches cumulative allowance with wall clock unchanged', async (t) => {
  const f = await fixture(t);
  const { local, remote, native } = await startAll(f);
  const raw = JSON.stringify({
    type: 'session.input_audio_buffer.append',
    audio: Buffer.alloc(48_000).toString('base64'),
  });
  for (let i = 0; i < 300; i += 1) native.send(raw);
  assert.equal(
    native.sent.filter((event) => event.type.endsWith('.append')).length,
    300,
  );
  native.send(raw);
  assert.equal(
    native.sent.filter((event) => event.type.endsWith('.append')).length,
    300,
  );
  assertStopped(f, [local, remote]);
  await tick();
  assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
});
