/* eslint-disable no-await-in-loop -- Settle each isolated offline scenario. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';

import type { SoloConfig } from '../src/solo/config';
import {
  sanitizeTerminationCause,
  createCallTerminationDiagnostic,
  type CallTerminationDiagnostic,
} from '../src/solo/call-termination-diagnostics';
import { ContinuousTranslationBridge } from '../src/solo/continuous-translation-bridge';
import { createContinuousTranslationClient } from '../src/solo/continuous-translation-client';
import { SessionManager } from '../src/solo/session-manager';

const privateText = 'PRIVATE_TOKEN_NONCE_SID_PHONE_TEXT_CLOSE_REASON';
const localSid = `CA${'1'.repeat(32)}`;
const remoteSid = `CA${'2'.repeat(32)}`;
const config = {
  PUBLIC_BASE_URL: 'https://phone.example.test',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_CALLER_NUMBER: '+12025550100',
  OPENAI_API_KEY: 'offline-not-a-credential',
  OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
  OPENAI_TRANSCRIPTION_MODEL: 'whisper-1',
} as SoloConfig;

class Socket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  frames: any[] = [];
  challenge?: Buffer;
  open() {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }
  receive(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }
  send(raw: string, done?: (error?: Error) => void) {
    this.frames.push(JSON.parse(raw));
    done?.();
  }
  ping(data: Buffer, _mask: boolean, done?: (error?: Error) => void) {
    this.challenge = Buffer.from(data);
    done?.();
  }
  close(code = 1000, reason = Buffer.from(privateText)) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, reason);
  }
  terminate() {
    this.close(1006);
  }
  socket() {
    return this as unknown as WebSocket;
  }
}

async function fixture(t: TestContext, maintain = false, fatalCaptions = true) {
  let time = 10000;
  let failCleanup = false;
  const providers: Socket[] = [];
  const phones = { local: new Socket(), remote: new Socket() };
  const hangups: string[] = [];
  const creates: Record<string, unknown>[] = [];
  const diagnostics: CallTerminationDiagnostic[] = [];
  const manager = new SessionManager({
    now: () => time,
    maxCallMs: null,
    providerFactory: () => ({
      create: async (options) => {
        creates.push(options);
        return { sid: remoteSid };
      },
      hangup: async (sid) => {
        hangups.push(sid);
        if (failCleanup) throw new Error(privateText);
      },
    }),
    bridgeFactory: (settings) =>
      new ContinuousTranslationBridge({
        ...settings,
        remoteCaptions: true,
        captionFailureEndsCall: fatalCaptions,
        createWebSocket: () => {
          const socket = new Socket();
          providers.push(socket);
          return socket.socket();
        },
      }),
  });
  manager.on('diagnostic', (value) => diagnostics.push(value));
  t.after(async () => {
    failCleanup = false;
    await manager.close();
  });
  manager.setPresence(true);
  const identity = maintain ? 'offline-per-call' : 'ai-phone';
  const call = manager.createOutbound(
    config,
    '+12025550101',
    'continuous-captions',
    maintain
      ? {
          browserIdentity: identity,
          deferBrowserJoin: true,
          maintainControllerConnection: true,
          authorizeCurrent: () => {},
          authorizeBrowserJoin: () => 'join',
          beforePublish: () => {},
        }
      : undefined,
  );
  manager.connectBrowser({
    ...call.connectionParams,
    From: `client:${identity}`,
    CallSid: localSid,
  });
  phones.local.open();
  assert.equal(
    manager.attachMedia(phones.local.socket(), {
      accountSid: config.TWILIO_ACCOUNT_SID,
      callSid: localSid,
      streamSid: `MZ${'3'.repeat(32)}`,
      customParameters: { ...call.connectionParams, role: 'local' },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    }),
    true,
  );
  const native = providers[0];
  native.open();
  const session = {
    id: privateText,
    model: 'gpt-realtime-translate',
    expires_at: 1900000000,
    audio: { output: { language: 'en' } },
  };
  native.receive({ type: 'session.created', session });
  native.receive({ type: 'session.updated', session });
  await tick();
  assert.equal(creates.length, 1);
  const target = new URL(String(creates[0].url));
  const nonce = target.searchParams.get('nonce')!;
  manager.connectLeg(call.id, 'remote', nonce, remoteSid);
  phones.remote.open();
  assert.equal(
    manager.attachMedia(phones.remote.socket(), {
      accountSid: config.TWILIO_ACCOUNT_SID,
      callSid: remoteSid,
      streamSid: `MZ${'4'.repeat(32)}`,
      customParameters: { sessionId: call.id, role: 'remote', nonce },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    }),
    true,
  );
  assert.equal(manager.activeSession?.status, 'active');
  return {
    manager,
    call,
    providers,
    phones,
    native,
    diagnostics,
    hangups,
    setTime: (value: number) => {
      time = value;
    },
    failCleanup: (value: boolean) => {
      failCleanup = value;
    },
  };
}

async function readyCaptions(f: Awaited<ReturnType<typeof fixture>>) {
  for (const socket of f.providers.slice(1)) {
    socket.open();
    socket.receive({
      type: 'session.updated',
      session: socket.frames[0].session,
    });
  }
  await tick();
}

test('native provider close preserves safe first cause and numeric expiry, never payload or close reason', async (t) => {
  const f = await fixture(t);
  f.setTime(191000);
  f.native.close(1011);
  await tick();
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
  assert.deepEqual(new Set(f.hangups), new Set([localSid, remoteSid]));
  assert.deepEqual(f.diagnostics, [
    {
      event: 'CLOUD_CALL_TERMINATION',
      reason: 'PROVIDER_CLOSED_UNEXPECTEDLY',
      layer: 'provider',
      role: 'local',
      wsCloseCode: 1011,
      sessionExpiresAtEpochSeconds: 1900000000,
      observedAtMs: 191000,
      elapsedMs: 181000,
    },
  ]);
  f.native.emit('error', new Error(privateText));
  await f.manager.end(f.call.id, privateText);
  assert.equal(f.diagnostics.length, 1);
  assert.ok(!JSON.stringify(f.diagnostics).includes(privateText));
  assert.ok(!JSON.stringify(f.diagnostics).includes(localSid));
  assert.ok(
    !JSON.stringify(f.diagnostics).includes(config.TWILIO_CALLER_NUMBER),
  );
});

test('media close records its own numeric code first while cleanup failure remains retryable', async (t) => {
  const f = await fixture(t);
  f.failCleanup(true);
  f.setTime(25000);
  f.phones.remote.close(1006);
  await tick();
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), false);
  assert.equal(f.manager.activeSession?.error, 'CALL_CLEANUP_FAILED');
  assert.deepEqual(f.diagnostics, [
    {
      event: 'CLOUD_CALL_TERMINATION',
      reason: 'PHONE_STREAM_CLOSED',
      layer: 'media',
      role: 'remote',
      wsCloseCode: 1006,
      observedAtMs: 25000,
      elapsedMs: 15000,
    },
  ]);
  f.failCleanup(false);
  await f.manager.end(f.call.id);
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
  assert.equal(f.diagnostics.length, 1);
  assert.ok(!JSON.stringify(f.diagnostics).includes(privateText));
});

test('diagnostic sink failures cannot strand provider termination or manufacture a cause during abort', async (t) => {
  const f = await fixture(t);
  f.manager.on('diagnostic', () => {
    throw new Error(privateText);
  });
  f.native.receive({
    type: 'error',
    error: { message: privateText, code: privateText },
  });
  await tick();
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
  assert.deepEqual(new Set(f.hangups), new Set([localSid, remoteSid]));
  assert.equal(f.diagnostics.length, 1);
  assert.equal(f.diagnostics[0].reason, 'PROVIDER_SESSION_REJECTED');
  assert.ok(!JSON.stringify(f.diagnostics).includes(privateText));
});

test('an application end request records once without asserting who initiated it and rejects injected metadata', async (t) => {
  const f = await fixture(t);
  await f.manager.end(f.call.id);
  assert.equal(f.diagnostics[0].reason, 'CALL_END_REQUESTED');
  assert.equal(f.diagnostics.length, 1);
  let accessorCalls = 0;
  const input = {
    reason: privateText,
    layer: privateText,
    role: privateText,
    token: privateText,
    wsCloseCode: '1011',
    sessionExpiresAtEpochSeconds: Infinity,
    get message() {
      accessorCalls += 1;
      return privateText;
    },
  };
  assert.deepEqual(sanitizeTerminationCause(input), {
    reason: 'UNCLASSIFIED_TERMINATION',
    layer: 'application',
    role: 'unknown',
  });
  assert.equal(accessorCalls, 0);
  const projected = createCallTerminationDiagnostic(input, Infinity, 10);
  assert.equal(projected.observedAtMs, null);
  assert.equal(projected.elapsedMs, null);
  assert.ok(!JSON.stringify(projected).includes(privateText));
});

test('fresh controller witness requires a matching pong and cannot survive stale or ended media', async (t) => {
  const f = await fixture(t, true);
  assert.equal(f.manager.hasFreshControllerPong(f.call.id), false);
  f.phones.local.emit('pong', Buffer.from(privateText));
  assert.equal(f.manager.hasFreshControllerPong(f.call.id), false);
  assert.ok(f.phones.local.challenge);
  f.phones.local.emit('pong', f.phones.local.challenge);
  assert.equal(f.manager.hasFreshControllerPong(f.call.id), true);
  f.setTime(9000);
  assert.equal(f.manager.hasFreshControllerPong(f.call.id), false);
  f.setTime(40000);
  assert.equal(f.manager.hasFreshControllerPong(f.call.id), false);
  await f.manager.end(f.call.id);
  assert.equal(f.manager.hasFreshControllerPong(f.call.id), false);
});

test('a throwing native diagnostic callback still delivers the original fixed error and closes transport', async () => {
  const socket = new Socket();
  const errors: string[] = [];
  const client = createContinuousTranslationClient({
    apiKey: 'offline-not-a-credential',
    targetLanguage: 'en',
    onAudio: () => {},
    onError: (code) => errors.push(code),
    onTerminationDiagnostic: () => {
      throw new Error(privateText);
    },
    createWebSocket: () => socket.socket(),
  });
  socket.open();
  socket.receive({
    type: 'session.updated',
    session: {
      model: 'gpt-realtime-translate',
      audio: { output: { language: 'en' } },
    },
  });
  await client.ready;
  socket.emit('error', new Error(privateText));
  assert.deepEqual(errors, ['PROVIDER_CONNECTION_FAILED']);
  assert.equal(socket.readyState, WebSocket.CLOSED);
  client.abort();
  assert.equal(errors.length, 1);
});

for (const [index, reason] of [
  [1, 'CAPTION_ASR_CLOSED'],
  [2, 'CAPTION_TRANSLATION_CLOSED'],
] as const) {
  test(`required ${reason} records its own first cause and closes both fake telephone legs`, async (t) => {
    const f = await fixture(t);
    await readyCaptions(f);
    f.setTime(191000);
    f.providers[index].close(1011);
    await tick();
    assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
    assert.deepEqual(new Set(f.hangups), new Set([localSid, remoteSid]));
    assert.deepEqual(f.diagnostics, [
      {
        event: 'CLOUD_CALL_TERMINATION',
        reason,
        layer: 'provider',
        role: 'remote',
        wsCloseCode: 1011,
        observedAtMs: 191000,
        elapsedMs: 181000,
      },
    ]);
    assert.ok(!JSON.stringify(f.diagnostics).includes(privateText));
    assert.ok(!JSON.stringify(f.diagnostics).includes(remoteSid));
    await f.manager.end(f.call.id);
    assert.equal(f.diagnostics.length, 1);
  });
}

for (const source of ['asr', 'translation'] as const) {
  test(`required caption ${source} request timeout preserves fixed cause without transcription or response data`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await fixture(t);
    await readyCaptions(f);
    const asr = f.providers[1];
    if (source === 'asr')
      asr.receive({
        type: 'input_audio_buffer.committed',
        item_id: privateText,
      });
    else {
      asr.receive({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: privateText,
        content_index: 0,
        transcript: `My private text is ${privateText}.`,
      });
      assert.ok(
        f.providers[2].frames.some((value) => value.type === 'response.create'),
      );
    }
    f.setTime(31000);
    t.mock.timers.tick(15001);
    await tick();
    assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
    assert.deepEqual(new Set(f.hangups), new Set([localSid, remoteSid]));
    assert.equal(f.diagnostics.length, 1);
    assert.equal(
      f.diagnostics[0].reason,
      source === 'asr' ? 'CAPTION_ASR_TIMEOUT' : 'CAPTION_TRANSLATION_TIMEOUT',
    );
    assert.equal(f.diagnostics[0].role, 'remote');
    assert.ok(!JSON.stringify(f.diagnostics).includes(privateText));
  });
}

test('nonfatal caption failure cannot contaminate a later media termination cause', async (t) => {
  const f = await fixture(t, false, false);
  await readyCaptions(f);
  f.providers[1].close(1006);
  await tick();
  assert.equal(f.manager.activeSession?.status, 'active');
  assert.equal(f.diagnostics.length, 0);
  f.phones.local.close(1006);
  await tick();
  assert.equal(f.diagnostics.length, 1);
  assert.equal(f.diagnostics[0].reason, 'PHONE_STREAM_CLOSED');
  assert.equal(f.diagnostics[0].role, 'local');
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
});
