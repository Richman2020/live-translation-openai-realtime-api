import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';

import {
  FIXED_VOICE_SETTINGS,
  FixedSpeechError,
  fixedSpeechWave,
  synthesizeFixedSpeech,
  type FixedSpeechOptions,
} from '../src/experiments/elevenlabs-speech-client';
import { muLawToPcm16 } from '../src/solo/translation-pcm';

// Fake transport only: no provider key, paid request, clone or telephone call.
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;

  sent: Record<string, unknown>[] = [];

  terminated = 0;

  sendFailure = false;

  open() {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }

  receive(event: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(event)), false);
  }

  send(raw: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(raw));
    callback?.(
      this.sendFailure
        ? new Error('secret-api-key-in-upstream-error')
        : undefined,
    );
  }

  terminate() {
    this.terminated += 1;
    this.readyState = WebSocket.CLOSED;
  }
}

function fixture(changes: Partial<FixedSpeechOptions> = {}) {
  const socket = new FakeSocket();
  let url = '';
  let config: WebSocket.ClientOptions;
  const result = synthesizeFixedSpeech({
    apiKey: 'offline-fixture-key',
    voiceId: 'fixtureVoice123',
    language: 'en',
    text: 'I do not want coffee.',
    createWebSocket(endpoint, options) {
      url = endpoint;
      config = options;
      return socket as unknown as WebSocket;
    },
    ...changes,
  });
  return { socket, result, connection: () => ({ url, config }) };
}

test('fixed voice URL, auth header, language and flush stay fixed; final audio is retained', async () => {
  const f = fixture();
  f.socket.open();
  const url = new URL(f.connection().url);
  assert.equal(url.hostname, 'api.elevenlabs.io');
  assert.equal(url.pathname, '/v1/text-to-speech/fixtureVoice123/stream-input');
  assert.equal(url.searchParams.get('model_id'), 'eleven_flash_v2_5');
  assert.equal(url.searchParams.get('output_format'), 'ulaw_8000');
  assert.equal(url.searchParams.get('language_code'), 'en');
  assert.ok(!url.href.includes('offline-fixture-key'));
  assert.equal(
    f.connection().config.headers['xi-api-key'],
    'offline-fixture-key',
  );
  assert.equal(f.connection().config.followRedirects, false);
  assert.deepEqual(f.socket.sent, [
    { text: ' ', voice_settings: FIXED_VOICE_SETTINGS },
    { text: 'I do not want coffee. ', flush: true },
    { text: '' },
  ]);
  const sound = Buffer.alloc(160, 0x80);
  f.socket.receive({
    audio: Buffer.alloc(160, 0xff).toString('base64'),
    is_final: false,
  });
  f.socket.receive({ audio: sound.toString('base64'), is_final: true });
  const result = await f.result;
  assert.equal(result.pcmu.length, 320);
  assert.equal(result.metrics.audioDurationMs, 40);
  assert.notEqual(result.metrics.firstNonSilentArrivalFromTextMs, null);
  assert.ok(
    result.metrics.firstNonSilentArrivalFromTextMs >=
      result.metrics.firstAudioFromTextMs,
  );
  assert.equal(
    result.metrics.boundary,
    'client-observed-arrival-not-phone-playback-or-human-hearing',
  );
  assert.equal(f.socket.terminated, 1);
  assert.equal(f.socket.listenerCount('message'), 0);
});

test('legacy camel-case final flag works; silence does not become a speech latency score', async () => {
  const f = fixture({ language: 'zh' });
  f.socket.open();
  f.socket.receive({ audio: Buffer.alloc(200, 0xff).toString('base64') });
  f.socket.receive({ isFinal: true });
  const result = await f.result;
  assert.equal(
    new URL(f.connection().url).searchParams.get('language_code'),
    'zh',
  );
  assert.equal(result.metrics.firstNonSilentArrivalFromTextMs, null);
  assert.equal(result.pcmu.length, 200);
});

test('short final energy window and split windows are measured without dropping samples', async () => {
  const f = fixture();
  f.socket.open();
  f.socket.receive({ audio: Buffer.alloc(80, 0xff).toString('base64') });
  f.socket.receive({ audio: Buffer.alloc(81, 0x80).toString('base64') });
  f.socket.receive({ is_final: true });
  const result = await f.result;
  assert.equal(result.pcmu.length, 161);
  assert.notEqual(result.metrics.firstNonSilentArrivalFromTextMs, null);
});

for (const [name, event, code] of [
  ['noncanonical base64', { audio: 'Zh==' }, 'INVALID_AUDIO_BASE64'],
  ['invalid base64', { audio: '!%%%=' }, 'INVALID_AUDIO_BASE64'],
  ['empty audio', { audio: '' }, 'INVALID_AUDIO_BASE64'],
  ['string final flag', { is_final: 'true' }, 'INVALID_FINAL_FLAG'],
  [
    'contradictory flags',
    { is_final: true, isFinal: false },
    'INVALID_FINAL_FLAG',
  ],
  ['empty result', { is_final: true }, 'EMPTY_AUDIO'],
  [
    'provider rejection',
    { error: 'secret-api-key-in-upstream-error' },
    'PROVIDER_REJECTED',
  ],
  [
    'unexpected event',
    { detail: 'secret-api-key-in-upstream-error' },
    'PROVIDER_REJECTED',
  ],
  ['unknown event', { something: 1 }, 'INVALID_EVENT'],
  ['JSON array', [], 'INVALID_EVENT'],
  [
    'wrong container',
    { audio: Buffer.from('RIFF1234WAVE').toString('base64') },
    'UNEXPECTED_AUDIO_CONTAINER',
  ],
] as const) {
  test(`rejects ${name} with sanitized error and cleanup`, async () => {
    const f = fixture();
    f.socket.open();
    f.socket.receive(event);
    await assert.rejects(
      f.result,
      (error: FixedSpeechError) =>
        error.code === code && !error.message.includes('secret-api'),
    );
    assert.equal(f.socket.terminated, 1);
  });
}

test('audio before text submission fails closed', async () => {
  const f = fixture();
  f.socket.receive({ audio: Buffer.alloc(160, 0x80).toString('base64') });
  await assert.rejects(f.result, { message: 'AUDIO_BEFORE_TEXT' });
});

test('early close does not report incomplete audio as completed', async () => {
  const f = fixture();
  f.socket.open();
  f.socket.receive({ audio: Buffer.alloc(160, 0x80).toString('base64') });
  f.socket.emit('close', 1000, Buffer.from('private reason'));
  await assert.rejects(f.result, { message: 'CLOSED_BEFORE_FINAL' });
});

test('timeout and cancellation terminate pending connections', async () => {
  const timed = fixture({ timeoutMs: 10 });
  await assert.rejects(timed.result, { message: 'TIMEOUT' });
  assert.equal(timed.socket.terminated, 1);
  const controller = new AbortController();
  const cancelled = fixture({ signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled.result, { message: 'ABORTED' });
  assert.equal(cancelled.socket.terminated, 1);
});

test('pre-abort and invalid input never open the connection', async () => {
  const controller = new AbortController();
  controller.abort();
  let created = 0;
  const options: FixedSpeechOptions = {
    apiKey: 'offline-key',
    voiceId: 'fixtureVoice',
    language: 'en',
    text: 'Hello.',
    createWebSocket: () => {
      created += 1;
      throw new Error('unreachable');
    },
  };
  await assert.rejects(
    synthesizeFixedSpeech({ ...options, signal: controller.signal }),
    { message: 'ABORTED' },
  );
  await assert.rejects(
    synthesizeFixedSpeech({ ...options, voiceId: '../wrong' }),
    { message: 'INVALID_VOICE_ID' },
  );
  await assert.rejects(
    synthesizeFixedSpeech({ ...options, text: 'x'.repeat(2001) }),
    { message: 'INVALID_TEXT' },
  );
  await assert.rejects(
    synthesizeFixedSpeech({ ...options, timeoutMs: 120001 }),
    { message: 'INVALID_TIMEOUT' },
  );
  assert.equal(created, 0);
});

test('send failure and transport error never leak provider details', async () => {
  const send = fixture();
  send.socket.sendFailure = true;
  send.socket.open();
  await assert.rejects(send.result, { message: 'SEND_FAILED' });
  assert.equal(send.socket.sent.length, 1);
  const transport = fixture();
  transport.socket.emit('error', new Error('secret-api-key-in-upstream-error'));
  await assert.rejects(transport.result, { message: 'CONNECTION_FAILED' });
  transport.socket.emit('error', new Error('safe late error sink'));
});

test('malformed JSON, binary frames, message size and audio duration are bounded', async () => {
  const malformed = fixture();
  malformed.socket.open();
  malformed.socket.emit('message', Buffer.from('{broken'), false);
  await assert.rejects(malformed.result, { message: 'INVALID_MESSAGE' });
  const binary = fixture();
  binary.socket.open();
  binary.socket.emit('message', Buffer.from('{}'), true);
  await assert.rejects(binary.result, { message: 'UNEXPECTED_BINARY_MESSAGE' });
  const oversized = fixture();
  oversized.socket.open();
  oversized.socket.emit('message', Buffer.alloc(1024 * 1024 + 1), false);
  await assert.rejects(oversized.result, { message: 'MESSAGE_LIMIT' });
  const duration = fixture();
  duration.socket.open();
  duration.socket.receive({
    audio: Buffer.alloc(480001, 0xff).toString('base64'),
  });
  await assert.rejects(duration.result, { message: 'AUDIO_LIMIT' });
});

test('handshake rejection destroys response body and uses a fixed code', async () => {
  const f = fixture();
  let destroyed = 0;
  f.socket.emit(
    'unexpected-response',
    {},
    {
      destroy: () => {
        destroyed += 1;
      },
    },
  );
  await assert.rejects(f.result, { message: 'HANDSHAKE_REJECTED' });
  assert.equal(destroyed, 1);
});

test('WAV preserves all μ-law samples and labels mono PCM16 at 8 kHz', () => {
  const pcmu = Buffer.from([0xff, 0x80, 0x00, 0x7f]);
  const wav = fixedSpeechWave(pcmu);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 8000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), 8);
  pcmu.forEach((code, index) =>
    assert.equal(wav.readInt16LE(44 + index * 2), muLawToPcm16(code)),
  );
  assert.throws(() => fixedSpeechWave(Buffer.alloc(0)), {
    message: 'INVALID_AUDIO_SIZE',
  });
});
