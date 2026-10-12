import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';

import {
  ContinuousTranslationBridge,
  type LocalVoiceSynthesizer,
} from '../src/solo/continuous-translation-bridge';
import type { ContinuousTranslationOptions } from '../src/solo/continuous-translation-client';
import { Pcm24kToPcmu } from '../src/solo/translation-pcm';
import { diagnosticLogRecord } from '../src/solo/diagnostic-log';

// Transport seams only: these tests do not call a model/provider or a real phone.
class Phone extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: any[] = [];
  send(raw: string, done?: (error?: Error) => void) {
    this.sent.push(JSON.parse(raw));
    done?.();
  }
  terminate() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  receive(event: unknown) {
    this.emit('message', JSON.stringify(event));
  }
  socket() {
    return this as unknown as WebSocket;
  }
}
function pcm(seconds: number, phase = 12) {
  const out = Buffer.alloc(Math.round(seconds * 48000));
  for (let i = 0; i < out.length; i += 2)
    out.writeInt16LE(Math.round(9000 * Math.sin(i / phase)), i);
  return out;
}
function bytes(phone: Phone) {
  return Buffer.concat(
    phone.sent
      .filter((e) => e.event === 'media')
      .map((e) => Buffer.from(e.media.payload, 'base64')),
  );
}
function encoded(chunks: Buffer[]) {
  const converter = new Pcm24kToPcmu();
  return Buffer.concat([
    ...chunks.map((chunk) => converter.push(chunk)),
    converter.push(Buffer.alloc(384)),
  ]);
}
function fixture() {
  const local = new Phone(),
    remote = new Phone();
  const failures: string[] = [],
    metrics: any[] = [],
    inputs: Buffer[] = [];
  let options: ContinuousTranslationOptions;
  let finished = 0;
  let wholeWaveCalls = 0;
  type Item = { pcm: Buffer; sampleRate: 24000 } | 'done' | Error;
  const jobs: {
    text: string;
    signal?: AbortSignal;
    push: (item: Item) => void;
    pulled: number;
    returned: boolean;
  }[] = [];
  const voice: LocalVoiceSynthesizer = {
    diagnosticPrefix: 'pocket',
    ready: Promise.resolve(),
    async synthesize() {
      wholeWaveCalls += 1;
      throw new Error('NO_WHOLE_WAVE_PATH');
    },
    async *synthesizeStream(text, signal) {
      const pending: Item[] = [];
      let wake: () => void;
      const job = {
        text,
        signal,
        push(item: Item) {
          pending.push(item);
          wake?.();
        },
        pulled: 0,
        returned: false,
      };
      jobs.push(job);
      try {
        while (true) {
          while (!pending.length)
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          const item = pending.shift();
          if (item === 'done') return;
          if (item instanceof Error) throw item;
          job.pulled += 1;
          yield item;
        }
      } finally {
        job.returned = true;
      }
    },
  };
  const bridge = new ContinuousTranslationBridge({
    apiKey: 'fake',
    model: 'test-only',
    remoteCaptions: true,
    localVoice: voice,
    onTranscript() {},
    onFailure: (reason) => failures.push(reason),
    onMetric: (metric) => metrics.push(metric),
    createClient(value) {
      options = value;
      return {
        ready: Promise.resolve(),
        append: (audio) => inputs.push(audio),
        async finish() {
          finished += 1;
        },
        abort() {},
      };
    },
    createCaptionClient() {
      return {
        ready: Promise.resolve(),
        append() {},
        async finish() {},
        abort() {},
      };
    },
  });
  bridge.attach('local', local.socket(), 'MZ_local');
  bridge.attach('remote', remote.socket(), 'MZ_remote');
  return {
    bridge,
    local,
    remote,
    jobs,
    failures,
    metrics,
    inputs,
    text: (delta: string) => options.onTranslatedText(delta),
    providerAudio: (audio: Buffer) => options.onAudio(audio),
    input: (role: 'local' | 'remote', audio: Buffer) =>
      (role === 'local' ? local : remote).receive({
        event: 'media',
        streamSid: `MZ_${role}`,
        media: { track: 'inbound', payload: audio.toString('base64') },
      }),
    ack() {
      for (const event of remote.sent.filter((e) => e.event === 'mark'))
        remote.receive({
          event: 'mark',
          streamSid: 'MZ_remote',
          mark: event.mark,
        });
    },
    state: () => ({ finished, wholeWaveCalls }),
  };
}

test('Pocket sends its first native chunk before stream completion, later sentences and provider end', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.bridge.close());
  await tick();
  f.text('Please clean the kitchen and living room tomorrow afternoon,');
  t.mock.timers.tick(500);
  assert.equal(f.jobs.length, 0, 'comma needs context to protect meaning');
  f.text(' but I do not need the bedroom');
  assert.equal(f.jobs.length, 1);
  const chunks = [pcm(0.01), pcm(0.01, 19), pcm(0.12, 23)];
  const converter = new Pcm24kToPcmu();
  f.jobs[0].push({ pcm: chunks[0], sampleRate: 24000 });
  await tick();
  assert.deepEqual(bytes(f.remote), converter.push(chunks[0]));
  assert.ok(bytes(f.remote).length > 0);
  assert.equal(f.jobs[0].returned, false);
  assert.equal(
    f.metrics.filter((m) => m.name === 'pocket_text_to_first_chunk_ms').length,
    1,
  );
  assert.equal(
    f.metrics.filter((m) => m.name === 'pocket_text_to_first_voiced_ms').length,
    0,
  );
  f.providerAudio(pcm(0.2));
  assert.deepEqual(
    bytes(f.remote),
    encoded([chunks[0]]).subarray(0, bytes(f.remote).length),
    'no model fallback/double audio',
  );
  f.input('local', Buffer.alloc(160, 0x44));
  const original = Buffer.alloc(160, 0x55);
  f.input('remote', original);
  assert.equal(f.inputs.length, 1);
  assert.deepEqual(
    bytes(f.local),
    original,
    'headset original remains independent of TTS',
  );
  f.jobs[0].push({ pcm: chunks[1], sampleRate: 24000 });
  await tick();
  assert.equal(
    f.metrics.filter((m) => m.name === 'pocket_text_to_first_voiced_ms').length,
    1,
    'energy frame state crosses chunks',
  );
  f.jobs[0].push({ pcm: chunks[2], sampleRate: 24000 });
  f.jobs[0].push('done');
  await tick();
  assert.deepEqual(
    bytes(f.remote),
    encoded(chunks),
    'one continuous converter and one final tail',
  );
  assert.equal(f.jobs.length, 1, 'remaining clause is still incomplete');
  f.text(' cleaned.');
  t.mock.timers.tick(300);
  await tick();
  assert.equal(f.jobs[1].text, 'but I do not need the bedroom cleaned.');
  assert.deepEqual(f.state(), { finished: 0, wholeWaveCalls: 0 });
  assert.deepEqual(f.failures, []);
  for (const metric of f.metrics)
    assert.equal(
      diagnosticLogRecord('translation-metric', metric)?.name,
      metric.name,
    );
});

test('Pocket bounds outstanding playback to four seconds and stops pulling without truncating FIFO output', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.bridge.close());
  await tick();
  f.text('First sentence. Second sentence.');
  t.mock.timers.tick(300);
  await tick();
  const chunks = Array.from({ length: 6 }, (_, i) => pcm(1, 12 + i));
  chunks.forEach((chunk) => f.jobs[0].push({ pcm: chunk, sampleRate: 24000 }));
  f.jobs[0].push('done');
  await tick();
  assert.ok(bytes(f.remote).length <= 32000);
  assert.ok(
    f.jobs[0].pulled <= 5,
    'backpressure halts native iterator consumption',
  );
  assert.equal(f.jobs.length, 1);
  f.input('local', Buffer.alloc(160, 0x44));
  assert.equal(f.inputs.length, 1);
  f.ack();
  await tick();
  assert.deepEqual(bytes(f.remote), encoded(chunks));
  assert.equal(f.jobs[1].text, 'Second sentence.');
  assert.deepEqual(f.failures, []);
});

test('hangup aborts Pocket, clears playback and rejects late chunks and queued clauses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.bridge.close());
  await tick();
  f.text('First sentence. Waiting sentence.');
  t.mock.timers.tick(300);
  await tick();
  f.jobs[0].push({ pcm: pcm(0.1), sampleRate: 24000 });
  await tick();
  const size = bytes(f.remote).length;
  f.bridge.close();
  assert.equal(f.jobs[0].signal.aborted, true);
  assert.ok(f.remote.sent.some((event) => event.event === 'clear'));
  f.jobs[0].push({ pcm: pcm(0.1), sampleRate: 24000 });
  await tick();
  assert.equal(bytes(f.remote).length, size);
  assert.equal(f.jobs[0].returned, true);
  assert.equal(f.jobs.length, 1);
  assert.deepEqual(f.failures, []);
});

test('Pocket native stream failure ends the bridge without silent fallback or tail padding', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.bridge.close());
  await tick();
  f.text('First sentence. Waiting sentence.');
  t.mock.timers.tick(300);
  await tick();
  f.jobs[0].push({ pcm: pcm(0.1), sampleRate: 24000 });
  await tick();
  const size = bytes(f.remote).length;
  f.jobs[0].push(new Error('PRIVATE_MODEL_ERROR'));
  await tick();
  assert.deepEqual(f.failures, ['pocket_synthesis_failed:local']);
  assert.equal(bytes(f.remote).length, size);
  assert.equal(f.jobs.length, 1);
  assert.equal(f.state().wholeWaveCalls, 0);
  assert.equal(f.jobs[0].signal.aborted, true);
});

test('missing phone playback marks end a blocked Pocket stream and release its native iterator', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.bridge.close());
  await tick();
  f.text('First sentence. Waiting sentence.');
  t.mock.timers.tick(300);
  await tick();
  for (let i = 0; i < 6; i += 1)
    f.jobs[0].push({ pcm: pcm(1), sampleRate: 24000 });
  await tick();
  const before = bytes(f.remote).length;
  assert.ok(before <= 32000);
  t.mock.timers.tick(20001);
  await tick();
  assert.deepEqual(f.failures, ['continuous_playback_timeout:remote']);
  assert.equal(f.jobs[0].signal.aborted, true);
  assert.equal(f.jobs[0].returned, true);
  assert.equal(bytes(f.remote).length, before);
  assert.equal(f.jobs.length, 1);
});

test('Pocket rejects empty streams, malformed chunks, and excessive queued text', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const item of [
    'done',
    { pcm: Buffer.alloc(3), sampleRate: 24000 },
  ] as const) {
    const f = fixture();
    t.after(() => f.bridge.close());
    await tick();
    f.text('Ready sentence.');
    t.mock.timers.tick(300);
    await tick();
    f.jobs[0].push(item);
    await tick();
    assert.deepEqual(f.failures, ['pocket_synthesis_failed:local']);
    assert.equal(bytes(f.remote).length, 0);
  }
  const full = fixture();
  t.after(() => full.bridge.close());
  await tick();
  full.text('Short sentence. '.repeat(13));
  t.mock.timers.tick(300);
  await tick();
  assert.deepEqual(full.failures, ['pocket_synthesis_queue_full:local']);
  assert.equal(full.jobs[0].signal.aborted, true);
});
