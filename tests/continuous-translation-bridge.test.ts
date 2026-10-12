/* eslint-disable max-classes-per-file -- Both transport fakes belong to the same routing fixture. */
/* eslint-disable no-await-in-loop -- Each scenario must fully finish before starting the next isolated fixture. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

import {
  ContinuousTranslationBridge,
  type ContinuousTranslationBridgeOptions,
} from '../src/solo/continuous-translation-bridge';
import type {
  ContinuousTranslationClient,
  ContinuousTranslationOptions,
} from '../src/solo/continuous-translation-client';
import {
  muLawToPcm16,
  Pcm24kToPcmu,
  PcmuToPcm24k,
} from '../src/solo/translation-pcm';
import type {
  TranscriptEvent,
  TranslationAudioDiagnostic,
  TranslationConnection,
  TranslationInputDiagnostic,
  TranslationMetric,
  TranslationProviderDiagnostic,
  TranslationRole,
} from '../src/solo/translation-bridge';

// In-memory phone transports and provider clients only. This validates routing
// and lifetime boundaries, never actual translation or human audible quality.
class Phone extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  sent: Record<string, any>[] = [];

  writes: ((error?: Error) => void)[] = [];

  deferWrites = false;

  failSend?: 'throw' | 'callback';

  closeCount = 0;

  send(payload: string, callback: (error?: Error) => void) {
    if (this.failSend === 'throw') throw new Error('PRIVATE_ERROR');
    if (this.failSend === 'callback') {
      callback(new Error('PRIVATE_ERROR'));
      return;
    }
    this.sent.push(JSON.parse(payload));
    if (this.deferWrites) this.writes.push(callback);
    else callback();
  }

  receive(event: unknown) {
    this.emit('message', JSON.stringify(event));
  }

  terminate() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.closeCount += 1;
    this.emit('close');
  }

  socket() {
    return this as unknown as WebSocket;
  }
}

class Provider implements ContinuousTranslationClient {
  options: ContinuousTranslationOptions;

  ready: Promise<void>;

  resolve: () => void;

  reject: (error: Error) => void;

  appended: Buffer[] = [];

  aborted = 0;

  finished = 0;

  failAppend = false;

  constructor(options: ContinuousTranslationOptions) {
    this.options = options;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  append(pcm: Buffer) {
    if (this.failAppend) throw new Error('PRIVATE_APPEND_ERROR');
    this.appended.push(Buffer.from(pcm));
  }

  async finish() {
    this.finished += 1;
  }

  abort() {
    this.aborted += 1;
  }

  audio(pcm: Buffer) {
    this.options.onAudio(pcm);
  }
}

function fixture(options: Partial<ContinuousTranslationBridgeOptions> = {}) {
  const providers: Provider[] = [];
  const phones = { local: new Phone(), remote: new Phone() };
  const failures: string[] = [];
  const connections: TranslationConnection[] = [];
  const audio: TranslationAudioDiagnostic[] = [];
  const transcripts: TranscriptEvent[] = [];
  const metrics: TranslationMetric[] = [];
  const bridge = new ContinuousTranslationBridge({
    apiKey: 'test-not-a-real-credential',
    model: 'legacy-model-is-not-used',
    onFailure: (reason) => failures.push(reason),
    onConnection: (event) => connections.push(event),
    onTranscript: (event) => transcripts.push(event),
    onAudioDiagnostic: (event) => audio.push(event),
    onMetric: (event) => metrics.push(event),
    createClient(clientOptions) {
      const provider = new Provider(clientOptions);
      providers.push(provider);
      return provider;
    },
    ...options,
  });
  const attach = (role: TranslationRole) =>
    bridge.attach(role, phones[role].socket(), `MZ_${role}`);
  const provider = (role: TranslationRole) =>
    providers[role === 'local' ? 0 : 1];
  const ready = async (role: TranslationRole) => {
    provider(role).resolve();
    await Promise.resolve();
  };
  const pair = async () => {
    attach('local');
    attach('remote');
    await ready('local');
    await ready('remote');
  };
  const media = (
    role: TranslationRole,
    bytes = Buffer.alloc(160, 0xff),
    timestamp?: unknown,
  ) =>
    phones[role].receive({
      event: 'media',
      streamSid: `MZ_${role}`,
      media: { track: 'inbound', payload: bytes.toString('base64'), timestamp },
    });
  const mark = (role: TranslationRole, name: string) =>
    phones[role].receive({
      event: 'mark',
      streamSid: `MZ_${role}`,
      mark: { name },
    });
  const assertClosed = () => {
    for (const phone of Object.values(phones)) {
      assert.equal(phone.readyState, WebSocket.CLOSED);
      assert.equal(phone.closeCount, 1);
    }
    for (const client of providers) {
      assert.equal(client.aborted, 1);
      assert.equal(client.finished, 0);
    }
  };
  return {
    bridge,
    phones,
    providers,
    provider,
    attach,
    ready,
    pair,
    media,
    mark,
    failures,
    connections,
    audio,
    transcripts,
    metrics,
    assertClosed,
  };
}

function tone(bytes = 9600): Buffer {
  const pcm = Buffer.alloc(bytes);
  for (let offset = 0; offset + 1 < bytes; offset += 2)
    pcm.writeInt16LE(Math.round(10000 * Math.sin(offset / 12)), offset);
  return pcm;
}

function mediaBytes(phone: Phone): Buffer {
  return Buffer.concat(
    phone.sent
      .filter((event) => event.event === 'media')
      .map((event) => Buffer.from(event.media.payload, 'base64')),
  );
}

test('delivery diagnostics match exact delayed marks with a monotonic clock despite wall-clock jumps', async () => {
  let monotonic = 1000;
  let wall = 1900000000000;
  const f = fixture({ monotonicNow: () => monotonic, now: () => wall });
  await f.pair();
  f.phones.remote.deferWrites = true;
  monotonic = 1010;
  const pcm = tone();
  f.provider('local').options.onAudio(pcm, { providerElapsedMs: 1200 });
  const first = f.phones.remote.sent.find((event) => event.event === 'mark')
    .mark.name;
  monotonic = 1020;
  f.phones.remote.writes.shift()();
  monotonic = 1025;
  f.phones.remote.writes.shift()();
  f.phones.remote.deferWrites = false;
  monotonic = 1030;
  wall -= 3600000;
  f.provider('local').audio(pcm);
  const second = f.phones.remote.sent.filter(
    (event) => event.event === 'mark',
  )[1].mark.name;
  monotonic = 1050;
  f.mark('remote', second);
  monotonic = 1080;
  wall += 7200000;
  f.mark('remote', first);
  const confirmed = f.audio.filter(
    (event) => event.stage === 'playback_confirmed',
  );
  assert.deepEqual(
    confirmed.map((event) => [
      event.deliveryId,
      event.createdAtMs,
      event.sentAtMs,
      event.acknowledgedAtMs,
      event.sentToMarkMs,
      event.outstandingAudioMs,
    ]),
    [
      [second, 30, 30, 50, 20, 200],
      [first, 10, 25, 80, 55, 0],
    ],
  );
  assert.match(
    confirmed[0].pipelineId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(new Set(f.audio.map((event) => event.pipelineId)).size, 1);
  assert.ok(f.audio.every((event) => event.clock === 'bridge_monotonic'));
  assert.equal(confirmed[1].providerElapsedMs, 1200);
  assert.equal(confirmed[0].providerElapsedMs, undefined);
  assert.equal(confirmed[0].audioDurationMs, 200);
  assert.ok(confirmed[0].peak > 0 && confirmed[0].rms > 0);
  const converter = new Pcm24kToPcmu();
  assert.deepEqual(
    mediaBytes(f.phones.remote),
    Buffer.concat([converter.push(pcm), converter.push(pcm)]),
  );
  f.mark('remote', first);
  assert.equal(
    f.audio.filter((event) => event.stage === 'playback_confirmed').length,
    2,
  );
  f.bridge.close();
});

test('silence retains all audio bytes and reports zero energy without claiming speech latency', async () => {
  const f = fixture();
  await f.pair();
  f.provider('local').audio(Buffer.alloc(9600));
  const sent = f.audio.find((event) => event.stage === 'sent');
  assert.equal(sent.audioDurationMs, 200);
  assert.equal(sent.rms, 0);
  assert.equal(sent.peak, 0);
  assert.equal(sent.sentToMarkMs, undefined);
  assert.equal(mediaBytes(f.phones.remote).length, 1600);
  assert.ok(mediaBytes(f.phones.remote).every((sample) => sample === 0xff));
  f.bridge.close();
  const closed = f.audio.at(-1);
  assert.equal(closed.stage, 'unconfirmed');
  assert.equal(closed.deliveryId, sent.deliveryId);
  assert.equal(closed.acknowledgedAtMs, undefined);
});

test('early mark receipt is retained without inventing a negative send-to-mark interval', async () => {
  let now = 0;
  const f = fixture({ monotonicNow: () => now });
  await f.pair();
  f.phones.remote.deferWrites = true;
  now = 10;
  f.provider('local').audio(tone());
  now = 20;
  f.mark('remote', f.phones.remote.sent[1].mark.name);
  now = 30;
  f.phones.remote.writes.splice(0).forEach((write) => write());
  const confirmed = f.audio.at(-1);
  assert.equal(confirmed.sentAtMs, 30);
  assert.equal(confirmed.acknowledgedAtMs, 20);
  assert.equal(confirmed.sentToMarkMs, undefined);
  f.bridge.close();
});

test('original audio diagnostics cover sealed marks and an unsealed hangup tail without buffering media', async () => {
  let now = 0;
  const f = fixture({
    monotonicNow: () => now,
    remoteCaptions: true,
    createCaptionClient: () => ({
      ready: Promise.resolve(),
      append() {},
      async finish() {
        return undefined;
      },
      abort() {},
    }),
  });
  f.attach('local');
  f.attach('remote');
  await f.ready('local');
  for (let i = 0; i < 10; i += 1) {
    now = 10 + i * 20;
    f.media('remote');
    assert.equal(mediaBytes(f.phones.local).length, (i + 1) * 160);
  }
  const sent = f.audio.find((event) => event.stage === 'sent');
  assert.equal(sent.deliveryId, 'original_1');
  assert.equal(sent.createdAtMs, 10);
  assert.equal(sent.sentAtMs, 190);
  now = 250;
  f.mark('local', sent.deliveryId);
  assert.equal(f.audio.at(-1).sentToMarkMs, 60);
  now = 270;
  f.media('remote');
  now = 300;
  f.bridge.close();
  const tail = f.audio.at(-1);
  assert.equal(tail.stage, 'unconfirmed');
  assert.equal(tail.deliveryId, 'original_2');
  assert.equal(tail.audioDurationMs, 20);
  assert.equal(tail.outstandingAudioMs, 20);
  assert.equal(tail.createdAtMs, 270);
  assert.equal(tail.sentAtMs, undefined);
  assert.equal(tail.rms, 0);
  assert.equal(tail.peak, 0);
});

test('provider metadata shares pipeline clock, never exposes private IDs and stops after cleanup', async () => {
  let now = 100;
  const metadata: TranslationProviderDiagnostic[] = [];
  const f = fixture({
    monotonicNow: () => now,
    onProviderDiagnostic: (event) => metadata.push(event),
  });
  await f.pair();
  now = 150;
  f.provider('local').options.onSessionMetadata({
    stage: 'session_updated',
    expiresAtEpochSeconds: 1900000000,
  });
  f.provider('local').audio(tone());
  assert.deepEqual(metadata, [
    {
      pipelineId: f.audio[0].pipelineId,
      role: 'local',
      stage: 'session_updated',
      expiresAtEpochSeconds: 1900000000,
      observedAtMs: 50,
    },
  ]);
  f.bridge.close();
  f.provider('local').options.onSessionMetadata({
    stage: 'session_updated',
    expiresAtEpochSeconds: 1900000000,
  });
  assert.equal(metadata.length, 1);
  const broken = fixture({
    onProviderDiagnostic() {
      throw new Error('optional');
    },
    monotonicNow() {
      throw new Error('clock only');
    },
  });
  await broken.pair();
  broken.provider('local').options.onSessionMetadata({
    stage: 'session_created',
    expiresAtEpochSeconds: 1900000000,
  });
  broken.provider('local').audio(tone());
  assert.equal(mediaBytes(broken.phones.remote).length, 1600);
  assert.equal(broken.audio[0].createdAtMs, 0);
  assert.deepEqual(broken.failures, []);
  broken.bridge.close();
});

test('input energy windows preserve exact local input, silence, partial tails and validated media timestamps', async () => {
  let now = 0;
  const inputs: TranslationInputDiagnostic[] = [];
  const f = fixture({
    monotonicNow: () => now,
    onInputDiagnostic: (event) => inputs.push(event),
  });
  f.attach('local');
  f.media('local', Buffer.alloc(1600), '0');
  assert.equal(
    inputs.length,
    0,
    'ringing audio is not part of the conversation',
  );
  f.attach('remote');
  await f.ready('local');
  await f.ready('remote');
  now = 10;
  const silence = Buffer.alloc(800, 0xff);
  f.media('local', silence, '0');
  assert.equal(inputs.length, 0);
  now = 50;
  const speech = Buffer.alloc(1120, 0x80);
  f.media('local', speech, '100');
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0], {
    pipelineId: inputs[0].pipelineId,
    role: 'local',
    clock: 'bridge_monotonic',
    observedAtMs: 50,
    windowStartedAtMs: 10,
    windowEndedAtMs: 50,
    audioDurationMs: 200,
    rms: Math.round(Math.abs(muLawToPcm16(0x80)) / Math.sqrt(2)),
    peak: Math.abs(muLawToPcm16(0x80)),
    mediaTimestampMs: 0,
  });
  const expected = new PcmuToPcm24k().push(Buffer.concat([silence, speech]));
  assert.deepEqual(Buffer.concat(f.provider('local').appended), expected);
  now = 60;
  f.media('remote', Buffer.alloc(1600, 0xff), '-20');
  assert.equal(inputs[1].role, 'remote');
  assert.equal(inputs[1].rms, 0);
  assert.equal(inputs[1].mediaTimestampMs, undefined);
  now = 70;
  f.bridge.close();
  const tail = inputs.at(-1);
  assert.equal(tail.audioDurationMs, 40);
  assert.equal(tail.windowStartedAtMs, 50);
  assert.equal(tail.windowEndedAtMs, 50);
  assert.equal(tail.observedAtMs, 70);
  assert.equal(tail.mediaTimestampMs, 200);
  assert.equal(tail.rms, Math.abs(muLawToPcm16(0x80)));
  const count = inputs.length;
  f.bridge.close();
  f.media('local');
  assert.equal(inputs.length, count);
});

test('throwing input telemetry and invalid diagnostic clocks cannot suppress speech', async () => {
  let clock = 100;
  const f = fixture({
    monotonicNow: () => clock,
    onInputDiagnostic() {
      throw new Error('optional');
    },
  });
  await f.pair();
  const pcmu = Buffer.alloc(3200, 0x80);
  clock = 150;
  f.media('local', pcmu);
  f.provider('local').audio(tone());
  clock = 90;
  f.provider('local').audio(tone());
  clock = Number.NaN;
  f.provider('local').audio(tone());
  assert.deepEqual(
    Buffer.concat(f.provider('local').appended),
    new PcmuToPcm24k().push(pcmu),
  );
  assert.deepEqual(
    f.audio
      .filter((event) => event.stage === 'generated')
      .map((event) => event.createdAtMs),
    [50, 50, 50],
  );
  assert.deepEqual(f.failures, []);
  f.bridge.close();
});

test('65 virtual minutes of native output and direct return keep diagnostics bounded and matching marks drained', async () => {
  let now = 0;
  const f = fixture({
    monotonicNow: () => now,
    remoteCaptions: true,
    // Exercise the isolated original-audio path after a caption failure; no ASR.
    createCaptionClient: () => ({
      ready: Promise.resolve(),
      append() {
        throw new Error('caption unavailable in this offline fixture');
      },
      async finish() {
        return undefined;
      },
      abort() {},
    }),
  });
  f.attach('local');
  f.attach('remote');
  await f.ready('local');
  const pcm = Buffer.alloc(9600);
  const original = Buffer.alloc(1600, 0xff);
  const waiting: { at: number; role: TranslationRole; name: string }[] = [];
  let lastSequence = 0;
  let generatedCount = 0;
  let confirmedCount = 0;
  let peakOutstanding = 0;
  let maximumFixturePending = 0;
  const inspect = () => {
    for (const event of f.audio) {
      peakOutstanding = Math.max(peakOutstanding, event.outstandingAudioMs);
      if (event.stage === 'generated') {
        const sequence = Number(event.deliveryId.split('_')[1]);
        assert.equal(sequence, lastSequence + 1);
        lastSequence = sequence;
        generatedCount += 1;
        assert.equal(event.audioDurationMs, 200);
      }
      if (event.stage === 'playback_confirmed') {
        confirmedCount += 1;
        assert.equal(event.sentToMarkMs, 600);
      }
    }
    f.audio.length = 0;
  };
  const acknowledge = () => {
    while (waiting.length && waiting[0].at <= now) {
      const mark = waiting.shift();
      f.mark(mark.role, mark.name);
    }
  };
  for (let frame = 0; frame < (65 * 60 * 1000) / 200; frame += 1) {
    now = frame * 200;
    acknowledge();
    f.provider('local').audio(pcm);
    f.media('remote', original);
    for (const role of ['local', 'remote'] as const) {
      for (const event of f.phones[role].sent) {
        if (event.event === 'mark')
          waiting.push({ at: now + 600, role, name: event.mark.name });
        if (event.event === 'media')
          assert.equal(Buffer.from(event.media.payload, 'base64').length, 1600);
      }
      // Fake transports must not retain an hour of history during a soak test.
      f.phones[role].sent.length = 0;
    }
    maximumFixturePending = Math.max(maximumFixturePending, waiting.length);
    inspect();
  }
  for (let tail = 0; tail < 3; tail += 1) {
    now += 200;
    acknowledge();
    inspect();
  }
  assert.equal(generatedCount, 39000);
  assert.equal(confirmedCount, generatedCount);
  assert.equal(maximumFixturePending, 6);
  assert.equal(peakOutstanding, 600);
  assert.equal(waiting.length, 0);
  assert.deepEqual(f.failures, []);
  f.bridge.close();
  assert.equal(f.audio.length, 0, 'no outstanding deliveries left on close');
  assert.equal(f.phones.local.listenerCount('message'), 0);
  assert.equal(f.phones.remote.listenerCount('message'), 0);
  f.provider('local').audio(pcm);
  assert.equal(
    f.audio.length,
    0,
    'stale provider output cannot restart delivery',
  );
});

test('Nano candidate suppresses original English audio and keeps reverse Chinese routing', async () => {
  const calls: string[] = [];
  const pcm = tone();
  const f = fixture({
    sentenceBoundaryDelayMs: 1,
    localVoice: {
      ready: Promise.resolve(),
      async synthesize(text) {
        calls.push(text);
        return {
          pcm,
          sampleRate: 24000,
          metrics: { generationMs: 10, audioMs: 200 },
        };
      },
    },
  });
  await f.pair();
  f.provider('local').audio(tone(4800));
  assert.equal(mediaBytes(f.phones.remote).length, 0);
  f.provider('remote').audio(tone(4800));
  assert.equal(mediaBytes(f.phones.local).length, 800);
  f.provider('local').options.onTranslatedText('Hello, thank you for calling.');
  await delay(15);
  assert.deepEqual(calls, ['Hello, thank you for calling.']);
  const codec = new Pcm24kToPcmu();
  assert.deepEqual(
    mediaBytes(f.phones.remote),
    Buffer.concat([codec.push(pcm), codec.push(Buffer.alloc(384))]),
  );
  assert.equal(f.metrics[0].name, 'nano_text_to_audio_ms');
  assert.equal(f.metrics[0].scope, 'local_synthesis');
  assert.deepEqual(f.failures, []);
  f.bridge.close();
});

test('Nano hangup aborts pending synthesis and discards its late completion', async () => {
  let resolve: (value: any) => void;
  let signal: AbortSignal;
  const f = fixture({
    sentenceBoundaryDelayMs: 1,
    localVoice: {
      ready: Promise.resolve(),
      synthesize(_text, supplied) {
        signal = supplied;
        return new Promise((yes) => {
          resolve = yes;
        });
      },
    },
  });
  await f.pair();
  f.provider('local').options.onTranslatedText('A complete sentence.');
  await delay(10);
  f.bridge.close();
  assert.equal(signal.aborted, true);
  assert.ok(f.phones.remote.sent.some((event) => event.event === 'clear'));
  resolve({
    pcm: tone(),
    sampleRate: 24000,
    metrics: { generationMs: 20, audioMs: 200 },
  });
  await delay(5);
  assert.equal(mediaBytes(f.phones.remote).length, 0);
  assert.deepEqual(f.failures, []);
});

test('Nano synthesis queue fails closed instead of dropping or duplicating translated sentences', async () => {
  const f = fixture({
    localVoice: {
      ready: Promise.resolve(),
      synthesize() {
        return new Promise(() => {});
      },
    },
  });
  await f.pair();
  f.provider('local').options.onTranslatedText(
    'First. Second. Third. Fourth. Fifth. Sixth',
  );
  assert.deepEqual(f.failures, ['nano_synthesis_queue_full:local']);
  f.assertClosed();
  assert.equal(mediaBytes(f.phones.remote).length, 0);
});

test('Nano long waveform waits for playback marks and keeps at most four seconds buffered', async () => {
  const pcm = tone(6 * 48000);
  const f = fixture({
    sentenceBoundaryDelayMs: 1,
    localVoice: {
      ready: Promise.resolve(),
      async synthesize() {
        return {
          pcm,
          sampleRate: 24000,
          metrics: { generationMs: 1, audioMs: 6000 },
        };
      },
    },
  });
  await f.pair();
  f.provider('local').options.onTranslatedText(
    'This longer sentence must retain every audio sample.',
  );
  await delay(15);
  assert.equal(mediaBytes(f.phones.remote).length, 32000);
  const markers = f.phones.remote.sent.filter(
    (event) => event.event === 'mark',
  );
  for (const marker of markers) f.mark('remote', marker.mark.name);
  await delay(10);
  assert.equal(mediaBytes(f.phones.remote).length, 48064);
  assert.deepEqual(f.failures, []);
  f.bridge.close();
});

test('Nano failure terminates both legs without falling back to provider audio', async () => {
  const f = fixture({
    sentenceBoundaryDelayMs: 1,
    localVoice: {
      ready: Promise.resolve(),
      async synthesize() {
        throw new Error('PRIVATE_FAILURE');
      },
    },
  });
  await f.pair();
  f.provider('local').options.onTranslatedText('This is a sentence.');
  await delay(10);
  assert.deepEqual(f.failures, ['nano_synthesis_failed:local']);
  f.assertClosed();
  assert.equal(mediaBytes(f.phones.remote).length, 0);
});

test('continuous providers start only when both authenticated legs exist and direction is fixed', async () => {
  const f = fixture();
  f.attach('local');
  f.attach('local');
  assert.equal(f.providers.length, 0);
  f.attach('remote');
  f.attach('remote');
  assert.equal(f.providers.length, 2);
  assert.equal(f.provider('local').options.targetLanguage, 'en');
  assert.equal(f.provider('remote').options.targetLanguage, 'zh');
  assert.deepEqual(f.connections, []);
  await f.ready('local');
  assert.deepEqual(f.connections, [{ role: 'local', state: 'ready' }]);
  await f.ready('remote');
  assert.deepEqual(f.connections[1], { role: 'remote', state: 'ready' });
  f.bridge.close();
  f.assertClosed();
});

test('continuous audio goes to opposite phone before any text and does not report turn latency', async () => {
  const f = fixture();
  await f.pair();
  const localPcm = tone();
  const remotePcm = Buffer.alloc(9600);
  f.provider('local').audio(localPcm);
  assert.equal(mediaBytes(f.phones.local).length, 0);
  assert.deepEqual(
    mediaBytes(f.phones.remote),
    new Pcm24kToPcmu().push(localPcm),
  );
  f.provider('remote').audio(remotePcm);
  assert.deepEqual(
    mediaBytes(f.phones.local),
    new Pcm24kToPcmu().push(remotePcm),
  );
  assert.deepEqual(f.transcripts, []);
  assert.deepEqual(f.metrics, []);
  assert.deepEqual(f.failures, []);
  f.bridge.close();
});

test('input including silence is retained in order before readiness, with independent streaming codec state', async () => {
  const f = fixture();
  const first = Buffer.from([0, 0xff, 0x7f, 1]);
  const second = Buffer.alloc(15996, 0xff);
  f.attach('local');
  f.attach('remote');
  f.media('local', first);
  f.media('local', second);
  assert.deepEqual(f.provider('local').appended, []);
  await f.ready('local');
  assert.deepEqual(
    Buffer.concat(f.provider('local').appended),
    new PcmuToPcm24k().push(Buffer.concat([first, second])),
  );
  assert.ok(
    f.provider('local').appended.every((chunk) => chunk.length <= 48000),
  );
  assert.deepEqual(f.provider('remote').appended, []);
  await f.ready('remote');
  f.media('remote');
  assert.deepEqual(
    Buffer.concat(f.provider('remote').appended),
    new PcmuToPcm24k().push(Buffer.alloc(160, 0xff)),
  );
  f.bridge.close();
});

test('ringing media before the second phone attaches is neither queued nor replayed', async () => {
  const f = fixture();
  f.attach('local');
  for (let second = 0; second < 15; second += 1)
    f.media('local', Buffer.alloc(8000, 0xff));
  assert.deepEqual(f.failures, []);
  assert.equal(f.providers.length, 0);
  f.attach('remote');
  await f.ready('local');
  await f.ready('remote');
  assert.deepEqual(f.provider('local').appended, []);
  assert.deepEqual(f.provider('remote').appended, []);
  f.media('local');
  assert.equal(f.provider('local').appended.length, 1);
  f.bridge.close();
});

test('pre-ready overflow fails explicitly instead of keeping only the final two seconds', async () => {
  const f = fixture();
  f.attach('local');
  f.attach('remote');
  f.media('local', Buffer.alloc(16000, 0xff));
  f.media('local', Buffer.from([0xff]));
  assert.deepEqual(f.failures, [
    'continuous_input_before_ready_overflow:local',
  ]);
  await f.ready('local');
  assert.deepEqual(f.provider('local').appended, []);
  f.assertClosed();
});

test('stateful output retains chunk remainders without padding or dropping at chunk boundaries', async () => {
  const f = fixture();
  await f.pair();
  const pcm = tone(9600);
  f.provider('local').audio(pcm.subarray(0, 2));
  f.provider('local').audio(pcm.subarray(2, 14));
  f.provider('local').audio(pcm.subarray(14));
  const expected = new Pcm24kToPcmu().push(pcm);
  assert.deepEqual(mediaBytes(f.phones.remote), expected);
  await delay(150);
  assert.deepEqual(
    mediaBytes(f.phones.remote),
    expected,
    'transport idle must not synthesize padding',
  );
  f.bridge.close();
});

test('marks acknowledge the recipient stream only and await both media and mark write callbacks', async () => {
  const f = fixture();
  await f.pair();
  f.phones.remote.deferWrites = true;
  f.provider('local').audio(tone());
  const { name } = f.phones.remote.sent.find(
    (event) => event.event === 'mark',
  ).mark;
  f.mark('remote', name);
  assert.deepEqual(
    f.audio.map((event) => event.stage),
    ['generated'],
  );
  f.phones.remote.writes.shift()();
  assert.deepEqual(
    f.audio.map((event) => event.stage),
    ['generated'],
  );
  f.phones.remote.writes.shift()();
  assert.deepEqual(
    f.audio.map((event) => event.stage),
    ['generated', 'sent', 'playback_confirmed'],
  );
  assert.equal(f.audio[2].generatedBytes, 1600);
  assert.equal(f.audio[2].sentBytes, 1600);
  f.mark('remote', name);
  assert.equal(f.audio.length, 3);
  f.bridge.close();
  assert.equal(f.audio.length, 3);
});

test('unknown stream, wrong inbound track, malformed payload and wrong destination mark fail closed', async () => {
  const cases = [
    {
      event: 'media',
      streamSid: 'MZ_other',
      media: { track: 'inbound', payload: '/w==' },
    },
    {
      event: 'media',
      streamSid: 'MZ_local',
      media: { track: 'outbound', payload: '/w==' },
    },
    {
      event: 'media',
      streamSid: 'MZ_local',
      media: { track: 'inbound', payload: '%%%=' },
    },
    {
      event: 'media',
      streamSid: 'MZ_local',
      media: { track: 'inbound', payload: '/x==' },
    },
    { event: 'start', streamSid: 'MZ_local' },
  ];
  for (const event of cases) {
    const f = fixture();
    await f.pair();
    f.phones.local.receive(event);
    assert.equal(f.failures.length, 1);
    assert.match(f.failures[0], /^continuous_/);
    f.assertClosed();
  }
  const f = fixture();
  await f.pair();
  f.provider('local').audio(tone());
  const { name } = f.phones.remote.sent[1].mark;
  f.mark('local', name);
  assert.deepEqual(f.failures, ['continuous_invalid_phone_event:local']);
  assert.equal(f.audio.at(-1).stage, 'unconfirmed');
});

test('a large audio delta is sent completely in bounded chunks and acknowledged playback frees the cap', async () => {
  const f = fixture();
  await f.pair();
  const input = tone(96000);
  const expected = new Pcm24kToPcmu().push(input);
  for (let round = 0; round < 6; round += 1) {
    f.provider('local').audio(input);
    const marks = f.phones.remote.sent.filter(
      (event) => event.event === 'mark',
    );
    for (const event of marks) f.mark('remote', event.mark.name);
  }
  assert.equal(expected.length, 16000);
  assert.equal(mediaBytes(f.phones.remote).length, expected.length * 6);
  assert.ok(
    f.phones.remote.sent
      .filter((event) => event.event === 'media')
      .every(
        (event) => Buffer.from(event.media.payload, 'base64').length <= 1600,
      ),
  );
  assert.deepEqual(f.failures, []);
  assert.equal(
    f.audio.filter((event) => event.stage === 'playback_confirmed').length,
    60,
  );
  f.bridge.close();
});

test('unacknowledged playback has a byte limit and errors instead of dropping older speech', async () => {
  const f = fixture();
  await f.pair();
  for (let count = 0; count < 40; count += 1) f.provider('local').audio(tone());
  assert.equal(mediaBytes(f.phones.remote).length, 64000);
  f.provider('local').audio(tone());
  assert.deepEqual(f.failures, ['continuous_playback_overflow:remote']);
  assert.equal(mediaBytes(f.phones.remote).length, 64000);
  assert.equal(
    f.audio.filter((event) => event.stage === 'unconfirmed').length,
    40,
  );
  f.assertClosed();
});

test('tiny output chunks also have a bounded pending mark count', async () => {
  const f = fixture();
  await f.pair();
  for (let count = 0; count < 257; count += 1)
    f.provider('local').audio(Buffer.alloc(6));
  assert.deepEqual(f.failures, ['continuous_playback_overflow:remote']);
  assert.equal(mediaBytes(f.phones.remote).length, 256);
  f.assertClosed();
});

test('playback acknowledgement timeout fails without silently retiring the marker', async () => {
  const f = fixture({ playbackTimeoutMs: 10 });
  await f.pair();
  f.provider('local').audio(tone());
  await delay(25);
  assert.deepEqual(f.failures, ['continuous_playback_timeout:remote']);
  assert.equal(f.audio.at(-1).stage, 'unconfirmed');
  f.assertClosed();
});

test('phone transport backpressure and send errors are sanitized and abort both providers', async () => {
  for (const failure of ['buffered', 'throw', 'callback'] as const) {
    const f = fixture();
    await f.pair();
    if (failure === 'buffered') f.phones.remote.bufferedAmount = 128 * 1024;
    else f.phones.remote.failSend = failure;
    f.provider('local').audio(tone());
    assert.equal(f.failures.length, 1);
    assert.match(
      f.failures[0],
      /^continuous_phone_(backpressure|send_failed):remote$/,
    );
    assert.equal(f.audio.at(-1).stage, 'unconfirmed');
    f.assertClosed();
  }
});

test('provider failures, failed input append and rejected readiness never reconnect or expose details', async () => {
  for (const failure of ['provider', 'append', 'ready'] as const) {
    const f = fixture();
    if (failure === 'ready') {
      f.attach('local');
      f.attach('remote');
      f.provider('local').reject(new Error('PRIVATE_PROVIDER_DETAILS'));
      await Promise.resolve();
      await Promise.resolve();
    } else {
      await f.pair();
      if (failure === 'provider')
        f.provider('local').options.onError('PRIVATE_PROVIDER_DETAILS');
      else {
        f.provider('local').failAppend = true;
        f.media('local');
      }
    }
    assert.equal(f.failures.length, 1);
    assert.doesNotMatch(f.failures[0], /PRIVATE/);
    assert.equal(f.providers.length, 2);
    f.assertClosed();
  }
});

test('hangup aborts immediately, settles unconfirmed output once and ignores late provider/write callbacks', async () => {
  const f = fixture();
  await f.pair();
  f.phones.remote.deferWrites = true;
  f.provider('local').audio(tone());
  const sentBefore = f.phones.remote.sent.length;
  f.bridge.close();
  f.bridge.close();
  f.provider('local').audio(tone());
  f.provider('local').options.onTranscript('late');
  f.provider('local').options.onError('late');
  for (const callback of f.phones.remote.writes) callback(new Error('late'));
  f.phones.local.emit('error', new Error('late'));
  assert.equal(f.phones.remote.sent.length, sentBefore);
  assert.deepEqual(
    f.audio.map((event) => event.stage),
    ['generated', 'unconfirmed'],
  );
  assert.deepEqual(f.transcripts, []);
  assert.deepEqual(f.failures, []);
  f.assertClosed();
});

test('phone stop, error and close clean up both directions once', async () => {
  for (const event of ['stop', 'error', 'close'] as const) {
    const f = fixture();
    await f.pair();
    if (event === 'stop')
      f.phones.local.receive({ event: 'stop', streamSid: 'MZ_local' });
    else if (event === 'error')
      f.phones.local.emit('error', new Error('PRIVATE'));
    else f.phones.local.terminate();
    assert.equal(f.failures.length, 1);
    f.assertClosed();
  }
});

test('transcripts are optional bounded cumulative excerpts, and diagnostic callback failures do not stop audio', async () => {
  const f = fixture();
  await f.pair();
  f.provider('local').options.onTranscript('a'.repeat(600));
  f.provider('local').options.onTranscript('b'.repeat(600));
  assert.deepEqual(
    f.transcripts.map((event) => event.text.length),
    [600, 1000, 200],
  );
  assert.equal(f.transcripts[0].id, f.transcripts[1].id);
  assert.notEqual(f.transcripts[1].id, f.transcripts[2].id);
  assert.ok(
    f.transcripts.every(
      (event) => event.kind === 'translation' && !event.final,
    ),
  );
  f.bridge.close();
  const broken = fixture({
    onTranscript: () => {
      throw new Error('UI_FAILED');
    },
    onAudioDiagnostic: () => {
      throw new Error('UI_FAILED');
    },
    onConnection: () => {
      throw new Error('UI_FAILED');
    },
  });
  await broken.pair();
  broken.provider('local').options.onTranscript('hello');
  broken.provider('local').audio(tone());
  assert.equal(mediaBytes(broken.phones.remote).length, 1600);
  assert.deepEqual(broken.failures, []);
  broken.bridge.close();
});

test('duplicate or cross-role phone attachment fails and closes the unexpected socket', () => {
  const f = fixture();
  f.attach('local');
  f.bridge.attach('remote', f.phones.local.socket(), 'MZ_remote');
  assert.deepEqual(f.failures, ['continuous_invalid_phone_stream']);
  assert.equal(f.phones.local.closeCount, 1);
  assert.equal(f.providers.length, 0);
  f.bridge.attach('remote', f.phones.remote.socket(), 'MZ_remote');
  assert.equal(f.phones.remote.closeCount, 1);
});
