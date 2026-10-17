/* eslint-disable max-classes-per-file, no-await-in-loop -- The offline owner fixture has independent phone/model peers and ordered lifecycle cases. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
import { reportCloudLiveTranslateDiagnostic } from '../src/solo/livetranslate-phone-diagnostics';
import { sendDiagnosticFixture } from './fixtures/livetranslate-send-diagnostic';
import {
  SessionManager,
  type BridgeOptions,
  type Role,
} from '../src/solo/session-manager';

// Fictional NANP 555 numbers and fake credentials, never actual user data.
// Authentication here is the trusted explicit personal-admission port; it does
// not claim that a synthetic browser identity has passed real Google login.
const configuration = {
  PUBLIC_BASE_URL: 'https://offline.example.com',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_CALLER_NUMBER: '+12125550123',
  OPENAI_API_KEY: 'UNUSED_OPENAI_OFFLINE_KEY',
  OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
} as SoloConfig;
const target = '+14155550123';
const identity = 'offline_authenticated_owner';
const localSid = `CA${'1'.repeat(32)}`;
const remoteSid = `CA${'2'.repeat(32)}`;
const streams = { local: `MZ${'3'.repeat(32)}`, remote: `MZ${'4'.repeat(32)}` };

class Phone extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  sent: any[] = [];

  closed = 0;

  send(raw: string, callback?: () => void) {
    const event = JSON.parse(raw);
    this.sent.push(event);
    callback?.();
    if (event.event === 'mark') this.receive(event);
  }

  receive(event: object) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }

  media(role: Role, pcmu: Buffer) {
    this.receive({
      event: 'media',
      streamSid: streams[role],
      media: {
        track: 'inbound',
        timestamp: '20',
        payload: pcmu.toString('base64'),
      },
    });
  }

  audio() {
    return Buffer.concat(
      this.sent
        .filter((event) => event.event === 'media')
        .map((event) => Buffer.from(event.media.payload, 'base64')),
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

  sequence = 0;

  constructor(readonly options: LiveTranslateClientOptions) {
    super();
  }

  session() {
    const { role, voice } = this.options;
    return {
      id: `offline-model-${role}`,
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

  send(raw: string, callback?: () => void) {
    const event = JSON.parse(raw);
    this.sent.push(event);
    callback?.();
    if (event.type === 'session.update')
      queueMicrotask(() =>
        this.receive({ type: 'session.updated', session: this.session() }),
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

  inputCount() {
    return this.sent.filter(
      (event) => event.type === 'input_audio_buffer.append',
    ).length;
  }
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await tick();
}

async function fixture(t: TestContext) {
  let now = 100000;
  let authorized = true;
  let occupancy: CloudVoiceReservation | undefined;
  let settings!: BridgeOptions;
  const events: any[] = [];
  const created: any[] = [];
  const hungup: string[] = [];
  const models = new Map<LiveTranslateRole, Model>();
  const local = new Phone();
  const remote = new Phone();
  const manager = new SessionManager({
    maxCallMs: null,
    allowedTarget: target,
    now: () => now,
    providerFactory: () => ({
      async create(args) {
        created.push(args);
        return { sid: remoteSid };
      },
      async hangup(sid) {
        hungup.push(sid);
      },
      async limit() {
        assert.fail(
          'No application duration or budget cap may be reintroduced',
        );
      },
    }),
    bridgeFactory(options) {
      settings = options;
      return createLiveTranslatePhoneBridge(
        {
          ...options,
          remoteCaptions: true,
          outgoingCaptions: false,
          createWebSocket() {
            throw new Error('OpenAI transport must not be created');
          },
        },
        {
          config: {
            region: 'beijing',
            workspaceId: 'offline-owner-workspace',
            apiKey: 'OFFLINE_FAKE_ALIYUN_KEY',
            model: LIVE_TRANSLATE_MODEL,
            voice: 'Andre',
          },
          deps: {
            createClient(optionsForModel) {
              assert.equal(
                models.has(optionsForModel.role),
                false,
                'No replacement model sessions',
              );
              const model = new Model(optionsForModel);
              models.set(optionsForModel.role, model);
              const client = createLiveTranslateClient({
                ...optionsForModel,
                createWebSocket(address) {
                  assert.equal(
                    address,
                    'wss://offline-owner-workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime',
                  );
                  return model as unknown as WebSocket;
                },
              });
              queueMicrotask(() =>
                model.receive({
                  type: 'session.created',
                  session: model.session(),
                }),
              );
              return client;
            },
          },
        },
      );
    },
  });
  manager.on('event', (event) => events.push(event));
  manager.setPresence(true);
  const admission = (browserIdentity = identity) => ({
    browserIdentity,
    deferBrowserJoin: true as const,
    beforePublish() {},
    authorizeCurrent() {
      if (!authorized) throw new Error('OFFLINE_OWNER_AUTH_REVOKED');
    },
    authorizeBrowserJoin(fields: Record<string, string>) {
      assert.equal(fields.From, `client:${identity}`);
      assert.equal(fields.CallSid, localSid);
      occupancy!.assertCurrent();
      return 'join' as const;
    },
  });
  const call = manager.createOutbound(
    configuration,
    target,
    'continuous-captions',
    admission(),
  );
  occupancy = await createPersonalVoiceAdmission(manager).reserve({
    version: 1,
    callId: call.id,
    identity,
    authSessionId: 'offline_auth_session',
    principalId: 'offline_principal',
    browserOwnerId: 'offline_owner',
    authEpoch: 1,
    controller: {
      leaseId: 'offline_lease',
      tabId: 'offline_owner_tab',
      epoch: 1,
    },
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
    CallSid: localSid,
  });
  const attach = (
    role: Role,
    socket: Phone,
    changes: Record<string, unknown> = {},
    parameterChanges: Record<string, unknown> = {},
  ) => {
    const nonce =
      role === 'local'
        ? call.connectionParams.nonce
        : new URL(String(created[0].url)).searchParams.get('nonce')!;
    return manager.attachMedia(socket.socket(), {
      accountSid: configuration.TWILIO_ACCOUNT_SID,
      callSid: role === 'local' ? localSid : remoteSid,
      streamSid: streams[role],
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      ...changes,
      customParameters: {
        sessionId: call.id,
        role,
        nonce,
        ...parameterChanges,
      },
    });
  };
  assert.equal(attach('local', local), true);
  await flush();
  assert.equal(created.length, 1);
  const remoteNonce = new URL(String(created[0].url)).searchParams.get(
    'nonce',
  )!;
  manager.connectLeg(call.id, 'remote', remoteNonce, remoteSid);
  assert.equal(attach('remote', remote), true);
  await flush();
  assert.equal(manager.activeSession?.status, 'active');
  assert.equal(models.size, 2);
  t.after(async () => {
    authorized = true;
    await manager.close();
    await manager.close();
  });
  return {
    manager,
    call,
    settings,
    events,
    created,
    hungup,
    models,
    local,
    remote,
    attach,
    advance(ms: number) {
      now += ms;
    },
    otherPageCall() {
      return manager.createOutbound(
        configuration,
        target,
        'continuous-captions',
        admission('offline_other_page'),
      );
    },
  };
}

test('authenticated owner creates one Andre phone call while wrong nonce, SID, account or browser identity cannot attach or replace its media', async (t) => {
  const f = await fixture(t);
  assert.equal(f.models.get('local')!.sent[0].session.voice, 'Andre');
  assert.equal(f.models.get('remote')!.sent[0].session.voice, 'Tina');
  assert.deepEqual(f.models.get('remote')!.sent[0].session.output_modalities, [
    'text',
  ]);
  assert.ok(
    [...f.models.values()].every((model) => model.options.usage === 'phone'),
  );
  const attacks = [
    { fields: {}, params: { nonce: 'wrong-nonce' } },
    { fields: { accountSid: `AC${'b'.repeat(32)}` }, params: {} },
    { fields: { callSid: `CA${'9'.repeat(32)}` }, params: {} },
    { fields: {}, params: {} }, // A second stream cannot replace the joined leg.
  ];
  for (const attack of attacks) {
    const outsider = new Phone();
    assert.equal(
      f.attach('local', outsider, attack.fields, attack.params),
      false,
    );
    assert.equal(outsider.readyState, WebSocket.CLOSED);
  }
  await assert.rejects(
    f.manager.connectBrowserControlled({
      ...f.call.connectionParams,
      From: 'client:offline_other_page',
      CallSid: localSid,
    }),
    /INVALID_BROWSER_CALL/,
  );
  assert.throws(() => f.otherPageCall(), /BUSY/);
  const original = Buffer.from([0xff, 0x80, 0x10, 0x7f]);
  f.remote.media('remote', original);
  assert.deepEqual(f.local.audio(), original);
  assert.equal(f.manager.activeSession?.id, f.call.id);
  assert.equal(f.manager.activeSession?.status, 'active');
  assert.equal(f.created.length, 1);
  assert.equal(f.models.size, 2);
  assert.deepEqual(f.hungup, []);
});

test('model fatal status persists in the real owner call snapshot and caption events without ending the call or muting remote original', async (t) => {
  const f = await fixture(t);
  const local = f.models.get('local')!;
  local.emit('close', 1006, Buffer.from('OFFLINE_PRIVATE_SUPPLIER_CLOSE'));
  await flush();
  const call = f.manager.activeSession!;
  assert.equal(call.id, f.call.id);
  assert.equal(call.status, 'active');
  assert.equal(call.translationStopped, true);
  assert.equal(call.translationReady, false);
  assert.equal(call.captionState, 'failed');
  assert.equal(f.manager.hasEndIntent(f.call.id), false);
  assert.deepEqual(f.hungup, []);
  assert.ok(
    f.events.some(
      (event) =>
        event.event === 'call' && event.data.translationStopped === true,
    ),
  );
  assert.ok(
    f.events.some(
      (event) =>
        event.event === 'caption-status' &&
        event.data.translationStopped === true &&
        event.data.sessionId === f.call.id,
    ),
  );
  const failed = f.events.filter(
    (event) =>
      event.event === 'translation-live' && event.data.stage === 'failed',
  );
  assert.equal(failed.length, 1);
  assert.equal(failed[0].data.code, 'LIVETRANSLATE_CONNECTION_CLOSED');
  assert.equal(failed[0].data.closeCode, 1006);
  assert.equal(
    JSON.stringify(failed).includes('OFFLINE_PRIVATE_SUPPLIER_CLOSE'),
    false,
  );
  const counts = [...f.models.values()].map((model) => model.inputCount());
  f.advance(240000);
  const original = Buffer.from([0x91, 0x10, 0xff]);
  f.remote.media('remote', original);
  f.local.media('local', Buffer.alloc(160, 0xff));
  await flush();
  assert.deepEqual(f.local.audio(), original);
  assert.deepEqual(
    [...f.models.values()].map((model) => model.inputCount()),
    counts,
  );
  assert.equal(f.manager.activeSession?.translationStopped, true);
  assert.equal(f.manager.activeSession?.status, 'active');
  assert.equal(f.models.size, 2);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.hungup, []);
});

test('manual owner end hangs up both fake provider legs, closes both model sessions and rejects late output or readiness resurrection', async (t) => {
  const f = await fixture(t);
  await f.manager.end(f.call.id);
  await flush();
  assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
  assert.equal(f.hungup.length, 2);
  assert.equal(f.manager.activeSession, null);
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
  assert.ok([...f.models.values()].every((model) => model.closed === 1));
  assert.equal(f.local.closed, 1);
  assert.equal(f.remote.closed, 1);
  const before = f.events.length;
  const beforeMedia = f.remote.audio().length;
  const local = f.models.get('local')!;
  local.options.onSource?.({
    role: 'local',
    sessionId: 'offline-model-local',
    sourceId: 'late',
    revision: 1,
    text: 'Late synthetic text',
    final: true,
    at: 100000,
  });
  local.options.onTranslation?.({
    role: 'local',
    sessionId: 'offline-model-local',
    translationId: 'late',
    responseId: 'late',
    sourceId: 'late',
    pairing: 'explicit',
    revision: 1,
    text: 'Late synthetic translation',
    final: true,
    at: 100001,
  });
  f.settings.onConnection?.({ role: 'local', state: 'ready' });
  f.settings.onCaptionState?.({ state: 'ready' });
  f.remote.media('remote', Buffer.from([0xff, 0x80]));
  await flush();
  assert.equal(f.events.length, before);
  assert.equal(f.remote.audio().length, beforeMedia);
  assert.equal(f.manager.activeSession, null);
  assert.equal(f.models.size, 2);
  assert.equal(f.created.length, 1);
});

test('a real remote stream stop or transport error still ends the owner call and cleans both legs after translation has stopped', async (t) => {
  for (const cause of ['stop', 'error'] as const) {
    const f = await fixture(t);
    f.models
      .get('remote')!
      .emit('close', 1011, Buffer.from('PRIVATE_REMOTE_MODEL_REASON'));
    await flush();
    assert.equal(f.manager.activeSession?.status, 'active');
    if (cause === 'stop')
      f.remote.receive({ event: 'stop', streamSid: streams.remote });
    else f.remote.emit('error', new Error('PRIVATE_PHONE_ERROR'));
    await flush();
    assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
    assert.equal(f.manager.activeSession, null);
    assert.equal(f.manager.hasEndIntent(f.call.id), true);
    assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
    assert.ok([...f.models.values()].every((model) => model.closed === 1));
    assert.equal(f.local.readyState, WebSocket.CLOSED);
    assert.equal(f.remote.readyState, WebSocket.CLOSED);
  }
});

test('manual hangup retains terminal send evidence at the final cloud sink without reviving retired output or polluting the next call', async (t) => {
  const f = await fixture(t);
  const lines: string[] = [];
  f.manager.on('event', (event) =>
    reportCloudLiveTranslateDiagnostic(event, (line) => lines.push(line)),
  );
  const oldLocal = f.models.get('local')!;
  const oldRemote = f.models.get('remote')!;
  await f.manager.end(f.call.id);
  await flush();
  const windows = lines
    .map((line) => JSON.parse(line))
    .filter((event) => event.stage === 'send_window');
  assert.equal(windows.length, 2);
  assert.deepEqual(
    new Set(windows.map((event) => event.role)),
    new Set(['local', 'remote']),
  );
  assert.ok(
    windows.every(
      (event) =>
        event.callId === f.call.id &&
        event.sendDiagnostic.trigger === 'cancelled',
    ),
  );
  assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
  assert.equal(f.manager.activeSession, null);
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
  const next = f.otherPageCall();
  const before = f.events.length;
  const beforeAudio = f.local.audio().length;
  for (const model of [oldLocal, oldRemote]) {
    model.options.onSendDiagnostic?.({
      ...sendDiagnosticFixture('late_callback'),
      role: model.options.role,
    });
    model.options.onSendDiagnostic?.({
      ...sendDiagnosticFixture('backlog_warning'),
      role: model.options.role,
    });
  }
  f.settings.onLiveTranslateDiagnostic?.({
    clock: 'application_epoch_ms',
    role: 'local',
    stage: 'configuration',
    at: 1000,
    model: 'qwen3.8-livetranslate-flash-realtime',
    requestedVoice: 'Andre',
  });
  await flush();
  const retiredEvents = f.events.slice(before);
  assert.equal(retiredEvents.length, 2);
  assert.ok(
    retiredEvents.every(
      (event) =>
        event.event === 'translation-live' &&
        event.data.sessionId === f.call.id &&
        event.data.sendDiagnostic.trigger === 'late_callback',
    ),
  );
  assert.equal(f.manager.activeSession?.id, next.id);
  assert.equal(f.manager.hasEndIntent(next.id), false);
  assert.equal(f.local.audio().length, beforeAudio);
  assert.equal(f.created.length, 1);
  assert.equal(f.models.size, 2);
});
