import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { ContinuousTranslationBridge } from '../src/solo/continuous-translation-bridge';
import type { ContinuousTranslationOptions } from '../src/solo/continuous-translation-client';
import type { RemoteCaptionOptions } from '../src/solo/remote-caption-client';
import { PcmuToPcm24k } from '../src/solo/translation-pcm';

class Phone extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: any[] = [];
  send(raw: string, cb: (error?: Error) => void) {
    this.sent.push(JSON.parse(raw));
    cb();
  }
  terminate() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  receive(event: any) {
    this.emit('message', JSON.stringify(event));
  }
}
function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(t: any, abortThrows = false) {
  const local = new Phone(),
    remote = new Phone();
  const captionGate = deferred(),
    translationGate = deferred();
  let caption!: RemoteCaptionOptions;
  const providers: ContinuousTranslationOptions[] = [];
  const appended: Buffer[] = [];
  const failures: string[] = [],
    states: string[] = [],
    transcripts: any[] = [],
    diagnostics: any[] = [];
  let aborted = 0;
  const bridge = new ContinuousTranslationBridge({
    apiKey: 'fake',
    model: 'gpt-realtime-1.5',
    remoteCaptions: true,
    localVoice: {
      ready: Promise.resolve(),
      synthesize: async () => ({
        pcm: Buffer.alloc(960),
        sampleRate: 24000,
        metrics: { generationMs: 1, audioMs: 20 },
      }),
    },
    createClient(options) {
      providers.push(options);
      return {
        ready: translationGate.promise,
        append() {},
        finish: async () => {},
        abort() {},
      };
    },
    createCaptionClient(options) {
      caption = options;
      return {
        ready: captionGate.promise,
        append(pcm) {
          appended.push(Buffer.from(pcm));
        },
        finish: async () => {},
        abort() {
          aborted += 1;
          if (abortThrows) throw new Error('PRIVATE_ABORT_ERROR');
        },
      };
    },
    onFailure: (reason) => failures.push(reason),
    onTranscript: (e) => transcripts.push(e),
    onCaptionState: (e) => states.push(e.state),
    onAudioDiagnostic: (e) => diagnostics.push(e),
  });
  bridge.attach('local', local as unknown as WebSocket, 'MZ_local');
  bridge.attach('remote', remote as unknown as WebSocket, 'MZ_remote');
  const media = (bytes: Buffer) =>
    remote.receive({
      event: 'media',
      streamSid: 'MZ_remote',
      media: { track: 'inbound', payload: bytes.toString('base64') },
    });
  const bytes = () =>
    Buffer.concat(
      local.sent
        .filter((e) => e.event === 'media')
        .map((e) => Buffer.from(e.media.payload, 'base64')),
    );
  t.after(() => bridge.close());
  return {
    bridge,
    local,
    remote,
    caption,
    providers,
    captionGate,
    translationGate,
    appended,
    failures,
    states,
    transcripts,
    diagnostics,
    media,
    bytes,
    aborted: () => aborted,
  };
}

test('original English is immediate byte-identical PCMU before either AI branch is ready', async (t) => {
  const f = fixture(t);
  const audio = Buffer.from(Array.from({ length: 160 }, (_, i) => i));
  f.media(audio);
  assert.deepEqual(f.bytes(), audio);
  assert.equal(f.providers.length, 1);
  assert.equal(f.providers[0].targetLanguage, 'en');
  assert.equal(f.appended.length, 0);
  f.captionGate.resolve();
  await delay(0);
  assert.deepEqual(Buffer.concat(f.appended), new PcmuToPcm24k().push(audio));
  assert.deepEqual(f.states, ['connecting', 'ready']);
  assert.equal(f.remote.sent.filter((e) => e.event === 'media').length, 0);
  assert.deepEqual(f.failures, []);
});

test('original audio marks are batched without delaying media and preserve byte accounting', async (t) => {
  const f = fixture(t);
  f.captionGate.resolve();
  await delay(0);
  const frame = Buffer.alloc(160, 170);
  for (let i = 0; i < 50; i++) f.media(frame);
  assert.equal(f.local.sent.filter((e) => e.event === 'media').length, 50);
  const marks = f.local.sent.filter((e) => e.event === 'mark');
  assert.equal(marks.length, 5);
  for (const mark of marks) f.local.receive(mark);
  assert.equal(
    f.diagnostics
      .filter((e) => e.stage === 'playback_confirmed')
      .reduce((n, e) => n + e.sentBytes, 0),
    8000,
  );
  assert.ok(f.diagnostics.every((e) => e.audioKind === 'original'));
  f.media(frame);
  assert.equal(f.bytes().length, 8160);
  await delay(250);
  assert.equal(f.local.sent.filter((e) => e.event === 'mark').length, 6);
  assert.deepEqual(f.failures, []);
});

test('caption failure drops only captions, preserves subsequent original audio, ignores late text', async (t) => {
  const f = fixture(t);
  f.captionGate.resolve();
  await delay(0);
  f.caption.onError?.('PRIVATE_PROVIDER_DETAIL');
  f.media(Buffer.alloc(160, 20));
  f.caption.onTranscript({
    id: 'remote:translation:item:0',
    role: 'remote',
    kind: 'translation',
    text: 'late',
    final: true,
    at: 1,
  });
  assert.equal(f.bytes().length, 160);
  assert.equal(f.local.readyState, WebSocket.OPEN);
  assert.deepEqual(f.states, ['connecting', 'ready', 'failed']);
  assert.deepEqual(f.failures, []);
  assert.equal(f.transcripts.length, 0);
  assert.equal(f.aborted(), 1);
});

test('slow ASR startup cannot buffer or stop original audio after caption input bound', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 110; i++) {
    f.media(Buffer.alloc(160, 80));
    for (const mark of f.local.sent.filter((e) => e.event === 'mark'))
      f.local.receive(mark);
  }
  assert.equal(f.bytes().length, 17600);
  assert.deepEqual(f.states, ['connecting', 'failed']);
  f.captionGate.resolve();
  await delay(0);
  assert.equal(f.appended.length, 0);
  assert.deepEqual(f.failures, []);
});

test('hangup aborts captions and prevents late handshake/text/audio and timer writes', async (t) => {
  const f = fixture(t);
  f.media(Buffer.alloc(160, 80));
  f.bridge.close();
  const count = f.local.sent.length;
  f.captionGate.resolve();
  f.translationGate.resolve();
  await delay(250);
  f.caption.onTranscript({
    id: 'remote:original:item:0',
    role: 'remote',
    kind: 'original',
    text: 'late',
    final: true,
    at: 1,
  });
  assert.equal(f.local.sent.length, count);
  assert.equal(f.local.readyState, WebSocket.CLOSED);
  assert.equal(f.remote.readyState, WebSocket.CLOSED);
  assert.equal(f.transcripts.length, 0);
  assert.equal(f.appended.length, 0);
});

test('actual original-audio transport backpressure remains a call failure', (t) => {
  const f = fixture(t);
  f.local.bufferedAmount = 150000;
  f.media(Buffer.alloc(160));
  assert.deepEqual(f.failures, ['continuous_phone_backpressure:local']);
  assert.equal(f.bytes().length, 0);
});

test('throwing caption abort cannot terminate original audio or prevent final cleanup', (t) => {
  const f = fixture(t, true);
  f.caption.onError('error');
  f.media(Buffer.alloc(160, 50));
  assert.equal(f.bytes().length, 160);
  assert.deepEqual(f.failures, []);
  f.bridge.close();
  assert.equal(f.local.readyState, WebSocket.CLOSED);
  assert.equal(f.remote.readyState, WebSocket.CLOSED);
});
