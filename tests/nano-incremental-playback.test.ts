import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';

import {
  ContinuousTranslationBridge,
  type LocalVoiceSynthesizer,
} from '../src/solo/continuous-translation-bridge';
import type { ContinuousTranslationOptions } from '../src/solo/continuous-translation-client';
import { Pcm24kToPcmu, PcmuToPcm24k } from '../src/solo/translation-pcm';

type Generated = Awaited<ReturnType<LocalVoiceSynthesizer['synthesize']>>;

// These are deterministic transport/worker seams. A media write proves routing,
// not actual provider latency, a human hearing it, or cloned-voice quality.
class Phone extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  sent: Record<string, any>[] = [];

  send(payload: string, callback: (error?: Error) => void) {
    this.sent.push(JSON.parse(payload));
    callback();
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

function tone(seconds: number, divisor = 12) {
  const pcm = Buffer.alloc(Math.round(seconds * 48000));
  for (let offset = 0; offset < pcm.length; offset += 2)
    pcm.writeInt16LE(Math.round(9000 * Math.sin(offset / divisor)), offset);
  return pcm;
}

function encoded(pcm: Buffer) {
  const converter = new Pcm24kToPcmu();
  return Buffer.concat([
    converter.push(pcm),
    converter.push(Buffer.alloc(384)),
  ]);
}

function mediaBytes(phone: Phone) {
  return Buffer.concat(
    phone.sent
      .filter((event) => event.event === 'media')
      .map((event) => Buffer.from(event.media.payload, 'base64')),
  );
}

async function settled() {
  // Resolve promise continuations without advancing any mock boundary timer.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function fixture() {
  const phones = { local: new Phone(), remote: new Phone() };
  const jobs: {
    text: string;
    signal?: AbortSignal;
    resolve: (generated: Generated) => void;
  }[] = [];
  const microphone: Buffer[] = [];
  const failures: string[] = [];
  let provider: ContinuousTranslationOptions;
  let finished = 0;
  let aborted = 0;
  const bridge = new ContinuousTranslationBridge({
    apiKey: 'test-not-a-credential',
    model: 'test-text-only',
    remoteCaptions: true,
    onTranscript() {},
    onFailure: (reason) => failures.push(reason),
    createClient(options) {
      assert.equal(provider, undefined, 'hybrid mode needs one voice provider');
      provider = options;
      return {
        ready: Promise.resolve(),
        append: (pcm) => microphone.push(Buffer.from(pcm)),
        async finish() {
          finished += 1;
        },
        abort() {
          aborted += 1;
        },
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
    localVoice: {
      ready: Promise.resolve(),
      synthesize(text, signal) {
        return new Promise((resolve) => jobs.push({ text, signal, resolve }));
      },
    },
  });
  bridge.attach('local', phones.local.socket(), 'MZ_local');
  bridge.attach('remote', phones.remote.socket(), 'MZ_remote');
  const input = (role: 'local' | 'remote', pcmu: Buffer) =>
    phones[role].receive({
      event: 'media',
      streamSid: `MZ_${role}`,
      media: { track: 'inbound', payload: pcmu.toString('base64') },
    });
  const complete = (index: number, pcm: Buffer) =>
    jobs[index].resolve({
      pcm,
      sampleRate: 24000,
      metrics: { generationMs: 1, audioMs: pcm.length / 48 },
    });
  const acknowledgeCurrent = () => {
    const markers = phones.remote.sent.filter(
      (event) => event.event === 'mark',
    );
    for (const event of markers)
      phones.remote.receive({
        event: 'mark',
        streamSid: 'MZ_remote',
        mark: event.mark,
      });
  };
  return {
    bridge,
    phones,
    jobs,
    microphone,
    failures,
    input,
    complete,
    acknowledgeCurrent,
    text: (delta: string) => provider.onTranslatedText(delta),
    rawProviderAudio: (pcm: Buffer) => provider.onAudio(pcm),
    lifetime: () => ({ finished, aborted }),
  };
}

test('first complete sentence reaches the phone before later sentences or provider end while microphone remains live', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.bridge.close());
  await settled();
  const inputs = [
    Buffer.alloc(160, 0x42),
    Buffer.alloc(160, 0x61),
    Buffer.alloc(160, 0x55),
  ];
  f.input('local', inputs[0]);
  f.text('I need help tomorrow.');
  t.mock.timers.tick(299);
  assert.equal(
    f.jobs.length,
    0,
    'trailing punctuation receives its short safety hold',
  );
  t.mock.timers.tick(1);
  assert.deepEqual(
    f.jobs.map((job) => job.text),
    ['I need help tomorrow.'],
  );
  assert.equal(
    mediaBytes(f.phones.remote).length,
    0,
    'complete waveform is not yet available',
  );

  f.input('local', inputs[1]);
  assert.equal(
    f.microphone.length,
    2,
    'synthesis does not pause microphone forwarding',
  );
  f.rawProviderAudio(tone(0.1));
  assert.equal(
    mediaBytes(f.phones.remote).length,
    0,
    'provider voice must not double-play',
  );
  const first = tone(0.2);
  f.complete(0, first);
  await settled();
  assert.deepEqual(mediaBytes(f.phones.remote), encoded(first));
  assert.deepEqual(f.lifetime(), { finished: 0, aborted: 0 });

  // The next sentence does not even exist at the provider seam until after the
  // first one's actual media writes. There is no whole-paragraph/end trigger.
  f.text(' I have two rooms.');
  f.input('local', inputs[2]);
  t.mock.timers.tick(300);
  assert.deepEqual(
    f.jobs.map((job) => job.text),
    ['I need help tomorrow.', 'I have two rooms.'],
  );
  const second = tone(0.2, 17);
  f.complete(1, second);
  await settled();
  assert.deepEqual(
    mediaBytes(f.phones.remote),
    Buffer.concat([encoded(first), encoded(second)]),
  );
  const inputCodec = new PcmuToPcm24k();
  assert.deepEqual(
    Buffer.concat(f.microphone),
    inputCodec.push(Buffer.concat(inputs)),
  );
  assert.deepEqual(f.failures, []);
});

test('FIFO sentences retain their audio under four-second playback backpressure without blocking either live input', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.bridge.close());
  await settled();
  f.text('First sentence. Second sentence. Third sentence.');
  t.mock.timers.tick(300);
  assert.deepEqual(
    f.jobs.map((job) => job.text),
    ['First sentence.'],
  );
  const first = tone(6);
  f.complete(0, first);
  await settled();
  assert.equal(
    mediaBytes(f.phones.remote).length,
    32000,
    'at most four seconds await phone playback acknowledgements',
  );
  assert.equal(
    f.jobs.length,
    1,
    'backpressure must not reorder or discard pending sentences',
  );
  f.input('local', Buffer.alloc(160, 0x42));
  assert.equal(
    f.microphone.length,
    1,
    'microphone still reaches the translator during playback backpressure',
  );
  const original = Buffer.alloc(160, 0x5a);
  f.input('remote', original);
  assert.deepEqual(
    mediaBytes(f.phones.local),
    original,
    'return English original also remains independent',
  );

  f.acknowledgeCurrent();
  await settled();
  assert.deepEqual(mediaBytes(f.phones.remote), encoded(first));
  assert.deepEqual(
    f.jobs.map((job) => job.text),
    ['First sentence.', 'Second sentence.'],
  );
  const second = tone(0.2, 17);
  f.complete(1, second);
  await settled();
  assert.deepEqual(
    f.jobs.map((job) => job.text),
    ['First sentence.', 'Second sentence.', 'Third sentence.'],
  );
  const third = tone(0.2, 23);
  f.complete(2, third);
  await settled();
  assert.deepEqual(
    mediaBytes(f.phones.remote),
    Buffer.concat([encoded(first), encoded(second), encoded(third)]),
  );
  assert.deepEqual(f.lifetime(), { finished: 0, aborted: 0 });
  assert.deepEqual(f.failures, []);
});

test('hangup drops active synthesis, queued sentences, incomplete text and late provider output', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.bridge.close());
  await settled();
  f.text('Already started. Waiting sentence. This is unfinished');
  assert.deepEqual(
    f.jobs.map((job) => job.text),
    ['Already started.'],
  );
  f.bridge.close();
  assert.equal(f.jobs[0].signal?.aborted, true);
  assert.ok(f.phones.remote.sent.some((event) => event.event === 'clear'));
  f.complete(0, tone(0.2));
  f.text(' but later completed. A new sentence.');
  f.rawProviderAudio(tone(0.1));
  t.mock.timers.tick(30000);
  await settled();
  assert.equal(mediaBytes(f.phones.remote).length, 0);
  assert.deepEqual(
    f.jobs.map((job) => job.text),
    ['Already started.'],
  );
  assert.deepEqual(f.lifetime(), { finished: 0, aborted: 1 });
  assert.deepEqual(f.failures, []);
});

test('a comma-linked complete clause reaches phone before the long sentence final full stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.bridge.close());
  await settled();
  f.input('local', Buffer.alloc(160, 0x42));
  f.text('Please clean the kitchen and living room tomorrow afternoon,');
  t.mock.timers.tick(500);
  assert.equal(f.jobs.length, 0, 'comma requires next-clause context');
  f.text(' but I do not need the bedroom');
  assert.deepEqual(
    f.jobs.map((job) => job.text),
    ['Please clean the kitchen and living room tomorrow afternoon,'],
  );
  const first = tone(0.2);
  f.complete(0, first);
  await settled();
  assert.deepEqual(mediaBytes(f.phones.remote), encoded(first));
  assert.deepEqual(f.lifetime(), { finished: 0, aborted: 0 });
  f.input('local', Buffer.alloc(160, 0x55));
  assert.equal(f.microphone.length, 2);
  assert.equal(f.jobs.length, 1, 'incomplete second clause remains buffered');
  f.text(' cleaned.');
  t.mock.timers.tick(300);
  assert.deepEqual(
    f.jobs.map((job) => job.text),
    [
      'Please clean the kitchen and living room tomorrow afternoon,',
      'but I do not need the bedroom cleaned.',
    ],
  );
  const second = tone(0.2, 17);
  f.complete(1, second);
  await settled();
  assert.deepEqual(
    mediaBytes(f.phones.remote),
    Buffer.concat([encoded(first), encoded(second)]),
  );
  assert.deepEqual(f.failures, []);
});

test('finer clauses from one paragraph do not exhaust the old four sentence job count', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.bridge.close());
  await settled();
  const clauses = [
    'I want the kitchen and the living room cleaned,',
    'and I want the two boxes left by the door,',
    'and I do not want the books moved today,',
    'and you can call me before you leave tomorrow,',
    'and I will open the front door for you,',
    'and I will pay you after the work is done.',
  ];
  f.text(clauses.join(' '));
  t.mock.timers.tick(300);
  assert.deepEqual(f.failures, []);
  const outputs: Buffer[] = [];
  for (let i = 0; i < clauses.length; i += 1) {
    assert.equal(f.jobs[i]?.text, clauses[i]);
    const pcm = tone(0.2, i + 12);
    outputs.push(encoded(pcm));
    f.complete(i, pcm);
    await settled();
  }
  assert.deepEqual(mediaBytes(f.phones.remote), Buffer.concat(outputs));
  assert.deepEqual(f.failures, []);
});

test('hybrid smaller jobs remain bounded by count and the original total text allowance', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const byCount = fixture();
  const byChars = fixture();
  t.after(() => {
    byCount.bridge.close();
    byChars.bridge.close();
  });
  await settled();
  byCount.text('Small phrase. '.repeat(13));
  t.mock.timers.tick(300);
  assert.deepEqual(byCount.failures, ['nano_synthesis_queue_full:local']);
  for (let i = 0; i < 4; i += 1) {
    byChars.text(`${'x'.repeat(239)}.`);
    t.mock.timers.tick(300);
  }
  assert.deepEqual(byChars.failures, []);
  byChars.text('Another.');
  t.mock.timers.tick(300);
  assert.deepEqual(byChars.failures, ['nano_synthesis_queue_full:local']);
});
