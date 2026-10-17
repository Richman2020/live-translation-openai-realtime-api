/* eslint-disable max-classes-per-file, no-await-in-loop -- Independent in-memory phone and model peers exercise the real client-to-owner lifecycle. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { test, type TestContext } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import WebSocket from 'ws';

import {
  createLiveTranslateClient,
  LIVE_TRANSLATE_MODEL,
  type LiveTranslateClientOptions,
  type LiveTranslateRole,
} from '../src/experiments/livetranslate-client';
import { createPersonalVoiceAdmission } from '../src/solo/cloud-service';
import type { CloudVoiceReservation } from '../src/solo/cloud-voice-join';
import type { SoloConfig } from '../src/solo/config';
import { createLiveTranslatePhoneBridge } from '../src/solo/livetranslate-phone-bridge';
import { SessionManager, type Role } from '../src/solo/session-manager';

// Synthetic supplier/transport events, not a reconstruction of the incident's
// absent WebSocket frames. That call's SEND_UNAVAILABLE did not record whether
// readyState, bufferedAmount or a write callback was the first cause.
const ids = {
  local: { sid: `CA${'1'.repeat(32)}`, stream: `MZ${'3'.repeat(32)}` },
  remote: { sid: `CA${'2'.repeat(32)}`, stream: `MZ${'4'.repeat(32)}` },
};
const identity = 'offline_transport_owner';
const config = {
  PUBLIC_BASE_URL: 'https://offline.example.com',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_CALLER_NUMBER: '+12125550123',
  OPENAI_API_KEY: 'UNUSED_OPENAI_OFFLINE_KEY',
  OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
} as SoloConfig;
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await tick();
};

class Phone extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: any[] = [];
  closed = 0;
  constructor(readonly role: Role) {
    super();
  }
  send(raw: string, callback?: (error?: Error) => void) {
    const event = JSON.parse(raw);
    this.sent.push(event);
    callback?.();
    if (event.event === 'mark') this.receive(event);
  }
  receive(event: object) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }
  media(bytes = Buffer.alloc(160, 0xff)) {
    this.receive({
      event: 'media',
      streamSid: ids[this.role].stream,
      media: {
        track: 'inbound',
        timestamp: '20',
        payload: bytes.toString('base64'),
      },
    });
  }
  audio() {
    return Buffer.concat(
      this.sent
        .filter((e) => e.event === 'media')
        .map((e) => Buffer.from(e.media.payload, 'base64')),
    );
  }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.closed += 1;
    this.emit('close', 1000);
  }
  terminate() {
    this.close();
  }
  socket() {
    return this as unknown as WebSocket;
  }
}

class Model extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: any[] = [];
  closed = 0;
  hold = false;
  sequence = 0;
  callbacks: ((error?: Error) => void)[] = [];
  constructor(readonly options: LiveTranslateClientOptions) {
    super();
  }
  session() {
    const { role, voice } = this.options;
    return {
      id: `transport-${role}`,
      model: LIVE_TRANSLATE_MODEL,
      voice,
      enable_voice_clone: false,
      output_modalities: role === 'local' ? ['text', 'audio'] : ['text'],
      translation: { language: role === 'local' ? 'en' : 'zh' },
      audio: {
        input: {
          format: { type: 'pcm', sample_rate: 16000 },
          turn_detection: { type: 'speaker_detection', threshold: 0.5 },
        },
        output: { format: { type: 'pcm', sample_rate: 24000 }, voice },
      },
    };
  }
  receive(event: object) {
    this.sequence += 1;
    this.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          event_id: `${this.options.role}-${this.sequence}`,
          ...event,
        }),
      ),
      false,
    );
  }
  send(raw: string, callback?: (error?: Error) => void) {
    const event = JSON.parse(raw);
    this.sent.push(event);
    if (this.hold && event.type === 'input_audio_buffer.append' && callback) {
      this.callbacks.push(callback);
      this.bufferedAmount += Buffer.byteLength(raw);
    } else callback?.();
    if (event.type === 'session.update')
      queueMicrotask(() =>
        this.receive({ type: 'session.updated', session: this.session() }),
      );
  }
  release(error?: Error) {
    const callbacks = this.callbacks.splice(0);
    this.bufferedAmount = 0;
    for (const callback of callbacks) callback(error);
  }
  inputCount() {
    return this.sent.filter((e) => e.type === 'input_audio_buffer.append')
      .length;
  }
  close(code = 1000) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.closed += 1;
    this.emit('close', code);
  }
  terminate() {
    this.close();
  }
}

async function fixture(t: TestContext) {
  const models = new Map<LiveTranslateRole, Model>();
  const phones = { local: new Phone('local'), remote: new Phone('remote') };
  const events: any[] = [];
  const created: any[] = [];
  const hungup: string[] = [];
  const now = 100000;
  let reservation: CloudVoiceReservation;
  const manager = new SessionManager({
    maxCallMs: null,
    allowedTarget: '+14155550123',
    now: () => now,
    providerFactory: () => ({
      async create(args) {
        created.push(args);
        return { sid: ids.remote.sid };
      },
      async hangup(sid) {
        hungup.push(sid);
      },
      async limit() {
        assert.fail('No application duration cap');
      },
    }),
    bridgeFactory(options) {
      return createLiveTranslatePhoneBridge(
        { ...options, remoteCaptions: true, outgoingCaptions: false },
        {
          config: {
            region: 'beijing',
            workspaceId: 'offline-transport-workspace',
            apiKey: 'OFFLINE_FAKE_ALIYUN_KEY',
            model: LIVE_TRANSLATE_MODEL,
            voice: 'Andre',
          },
          deps: {
            createClient(clientOptions) {
              assert.equal(
                models.has(clientOptions.role),
                false,
                'No model reconnect',
              );
              const peer = new Model(clientOptions);
              models.set(clientOptions.role, peer);
              const client = createLiveTranslateClient({
                ...clientOptions,
                createWebSocket() {
                  return peer as unknown as WebSocket;
                },
              });
              queueMicrotask(() =>
                peer.receive({
                  type: 'session.created',
                  session: peer.session(),
                }),
              );
              return client;
            },
          },
        },
      );
    },
  });
  t.after(async () => {
    await manager.close();
  });
  manager.on('event', (event) => events.push(event));
  manager.setPresence(true);
  const call = manager.createOutbound(
    config,
    '+14155550123',
    'continuous-captions',
    {
      browserIdentity: identity,
      deferBrowserJoin: true,
      beforePublish() {},
      authorizeCurrent() {},
      authorizeBrowserJoin(fields) {
        assert.equal(fields.From, `client:${identity}`);
        assert.equal(fields.CallSid, ids.local.sid);
        reservation.assertCurrent();
        return 'join';
      },
    },
  );
  reservation = await createPersonalVoiceAdmission(manager).reserve({
    version: 1,
    callId: call.id,
    identity,
    authSessionId: 'offline_auth',
    principalId: 'offline_principal',
    browserOwnerId: 'offline_owner',
    authEpoch: 1,
    controller: { leaseId: 'offline_lease', tabId: 'offline_tab', epoch: 1 },
    issuedAt: now,
    expiresAt: now + 60000,
    authExpiresAt: now + 60000,
    tokenExpiresAt: now + 60000,
    incomingAllow: false,
    outgoingApplicationSid: `AP${'a'.repeat(32)}`,
    outgoing: { callId: call.id, identity },
  });
  await manager.connectBrowserControlled({
    ...call.connectionParams,
    From: `client:${identity}`,
    CallSid: ids.local.sid,
  });
  const attach = (role: Role, nonce: string) =>
    manager.attachMedia(phones[role].socket(), {
      accountSid: config.TWILIO_ACCOUNT_SID,
      callSid: ids[role].sid,
      streamSid: ids[role].stream,
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      customParameters: { sessionId: call.id, role, nonce },
    });
  assert.equal(attach('local', call.connectionParams.nonce), true);
  await flush();
  assert.equal(created.length, 1);
  const remoteNonce = new URL(String(created[0].url)).searchParams.get(
    'nonce',
  )!;
  manager.connectLeg(call.id, 'remote', remoteNonce, ids.remote.sid);
  assert.equal(attach('remote', remoteNonce), true);
  await flush();
  assert.equal(manager.activeSession?.status, 'active');
  return { manager, models, phones, events, created, hungup, call };
}

function stoppedOnce(f: Awaited<ReturnType<typeof fixture>>, code: string) {
  assert.equal(f.manager.activeSession?.status, 'active');
  assert.equal(f.manager.activeSession?.translationStopped, true);
  assert.equal(f.manager.hasEndIntent(f.call.id), false);
  assert.deepEqual(f.hungup, []);
  const failed = f.events.filter(
    (e) => e.event === 'translation-live' && e.data.stage === 'failed',
  );
  assert.equal(failed.length, 1);
  assert.equal(failed[0].data.code, code);
  assert.ok(
    f.events.some(
      (e) => e.event === 'call' && e.data.translationStopped === true,
    ),
  );
  assert.ok(
    f.events.some(
      (e) => e.event === 'caption-status' && e.data.translationStopped === true,
    ),
  );
  assert.ok([...f.models.values()].every((model) => model.closed === 1));
}

test('synthetic slow write resumes FIFO without stopping either translation or delaying the original route', async (t) => {
  const f = await fixture(t);
  const model = f.models.get('remote')!;
  model.hold = true;
  const original = Buffer.from([0x91, 0x10, 0xff]);
  f.phones.remote.media(original);
  f.phones.remote.media(original);
  await flush();
  assert.equal(
    model.inputCount(),
    2,
    'Both ordered audio frames are submitted without waiting for a local write callback',
  );
  assert.equal(model.callbacks.length, 2);
  assert.deepEqual(f.phones.local.audio(), Buffer.concat([original, original]));
  assert.notEqual(f.manager.activeSession?.translationStopped, true);
  model.hold = false;
  model.release();
  await flush();
  assert.equal(model.inputCount(), 2);
  assert.notEqual(f.manager.activeSession?.translationStopped, true);
  assert.equal(f.models.size, 2);
  assert.equal(f.created.length, 1);
  model.options.onTiming?.({
    role: 'remote',
    sessionId: 'transport-remote',
    sourceId: 'synthetic-after-callbacks',
    stage: 'source_stopped',
    providerAudioMs: 0,
    at: 100000,
  });
  const writtenBytes = model.sent
    .filter((event) => event.type === 'input_audio_buffer.append')
    .reduce(
      (total, event) => total + Buffer.from(event.audio, 'base64').length,
      0,
    );
  const evidence = f.events.find(
    (e) => e.event === 'translation-live' && e.data.stage === 'source_stopped',
  );
  assert.equal(
    evidence?.data.inputWrittenAudioMs,
    writtenBytes / 32,
    'The contiguous local write receipt still advances source timing, although normal send logs now stay in the ring',
  );
  assert.equal(
    f.events.some(
      (e) => e.event === 'translation-live' && e.data.stage === 'send_written',
    ),
    false,
  );
});

test('synthetic persistent write stalls visibly stop both model directions without ending the phone; manual end cleans both legs', async (t) => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  const model = f.models.get('remote')!;
  model.hold = true;
  f.phones.remote.media();
  await flush();
  elapsed = 2001;
  t.mock.timers.tick(2100);
  await flush();
  stoppedOnce(f, 'LIVETRANSLATE_SEND_UNAVAILABLE');
  const inputCounts = [...f.models.values()].map((peer) => peer.inputCount());
  const before = f.phones.local.audio().length;
  f.phones.remote.media(Buffer.from([0x91, 0x10, 0xff]));
  f.phones.local.media();
  model.release();
  await flush();
  assert.equal(f.phones.local.audio().length, before + 3);
  assert.deepEqual(
    [...f.models.values()].map((peer) => peer.inputCount()),
    inputCounts,
  );
  assert.equal(f.manager.activeSession?.translationStopped, true);
  await f.manager.end(f.call.id);
  await flush();
  assert.deepEqual(new Set(f.hungup), new Set([ids.local.sid, ids.remote.sid]));
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
  assert.ok(Object.values(f.phones).every((phone) => phone.closed === 1));
  t.mock.timers.reset();
});

test('synthetic close racing a held send and late duplicate callbacks fails once, never reconnects, and still permits original audio', async (t) => {
  const f = await fixture(t);
  const model = f.models.get('remote')!;
  model.hold = true;
  f.phones.remote.media();
  await flush();
  const callbacks = [...model.callbacks];
  model.close(1006);
  model.release(new Error('OFFLINE_PRIVATE_SEND_ERROR'));
  for (const callback of callbacks)
    callback(new Error('OFFLINE_PRIVATE_DUPLICATE_ERROR'));
  await flush();
  stoppedOnce(f, 'LIVETRANSLATE_CONNECTION_CLOSED');
  const before = f.phones.local.audio().length;
  f.phones.remote.media(Buffer.from([0x81, 0x01]));
  await flush();
  assert.equal(f.phones.local.audio().length, before + 2);
  assert.equal(f.models.size, 2);
  assert.equal(f.created.length, 1);
  assert.equal(JSON.stringify(f.events).includes('OFFLINE_PRIVATE_'), false);
  f.phones.remote.receive({ event: 'stop', streamSid: ids.remote.stream });
  await flush();
  assert.deepEqual(new Set(f.hungup), new Set([ids.local.sid, ids.remote.sid]));
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
});

test('synthetic recognition language never reassigns authenticated roles and the remote session remains text-only', async (t) => {
  const f = await fixture(t);
  const originals = {
    local: 'This synthetic phrase was recognized on the local track.',
    remote: '这段模拟中文来自对方音轨，不应凭语言改成我方。',
  };
  for (const role of ['local', 'remote'] as const) {
    f.phones[role].media();
    const peer = f.models.get(role)!;
    peer.receive({
      type: 'input_audio_buffer.speech_started',
      item_id: `source-${role}`,
      audio_start_ms: 0,
    });
    peer.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: `source-${role}`,
      content_index: 0,
      transcript: originals[role],
    });
  }
  await flush();
  for (const role of ['local', 'remote'] as const) {
    const source = f.events.find(
      (e) => e.event === 'transcript' && e.data.text === originals[role],
    );
    assert.ok(source);
    assert.equal(source.data.role, role);
  }
  const remote = f.models.get('remote')!;
  assert.deepEqual(remote.sent[0].session.output_modalities, ['text']);
  assert.equal(
    f.phones.remote.audio().length,
    0,
    'No synthetic Chinese speech is sent to the other phone',
  );
  assert.notEqual(f.manager.activeSession?.translationStopped, true);
});
