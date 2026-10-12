import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';
import { ContinuousTranslationBridge } from '../src/solo/continuous-translation-bridge';
import type { OutgoingPrefixOptions } from '../src/solo/outgoing-prefix-client';
import { diagnosticLogRecord } from '../src/solo/diagnostic-log';

class Phone extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: any[] = [];
  send(raw: string, done?: () => void) {
    this.sent.push(JSON.parse(raw));
    done?.();
  }
  terminate() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  receive(raw: object) {
    this.emit('message', JSON.stringify(raw));
  }
  socket() {
    return this as unknown as WebSocket;
  }
}
function fixture() {
  const local = new Phone(),
    remote = new Phone();
  let opts: OutgoingPrefixOptions;
  let clients = 0,
    aborts = 0;
  const inputs: Buffer[] = [],
    jobs: any[] = [],
    metrics: any[] = [];
  const traces: any[] = [],
    transcripts: any[] = [],
    failures: string[] = [];
  let current = 1000;
  const bridge = new ContinuousTranslationBridge({
    apiKey: 'fake',
    model: 'test-only',
    outgoingPrefixes: true,
    remoteCaptions: true,
    now: () => current,
    onTranscript: (e) => transcripts.push(e),
    onFailure: (e) => failures.push(e),
    onMetric: (e) => metrics.push(e),
    onAudioDiagnostic: (e) => traces.push(e),
    createClient() {
      throw Error('CONTINUOUS_MUST_NOT_BE_USED');
    },
    createPrefixClient(value) {
      opts = value;
      clients += 1;
      return {
        ready: Promise.resolve(),
        append: (b) => inputs.push(b),
        finish: async () => {},
        abort: () => {
          aborts += 1;
        },
      };
    },
    createCaptionClient() {
      return {
        ready: Promise.resolve(),
        append() {},
        finish: async () => {},
        abort() {},
      };
    },
    localVoice: {
      diagnosticPrefix: 'pocket',
      ready: Promise.resolve(),
      synthesize: async () => {
        throw Error('WHOLE_WAV_MUST_NOT_BE_USED');
      },
      async *synthesizeStream(text, signal) {
        const queue: (Buffer | null)[] = [];
        let wake: (() => void) | undefined;
        const job = {
          text,
          signal,
          ended: false,
          push: (pcm: Buffer | null) => {
            queue.push(pcm);
            wake?.();
          },
        };
        jobs.push(job);
        try {
          while (true) {
            while (!queue.length)
              await new Promise<void>((yes) => {
                wake = yes;
              });
            const pcm = queue.shift();
            if (pcm === null) return;
            yield { pcm: pcm!, sampleRate: 24000 as const };
          }
        } finally {
          job.ended = true;
        }
      },
    },
  });
  const media = (phone: Phone, sid: string) =>
    phone.receive({
      event: 'media',
      streamSid: sid,
      media: {
        track: 'inbound',
        payload: Buffer.alloc(160, 0x44).toString('base64'),
      },
    });
  return {
    bridge,
    local,
    remote,
    inputs,
    jobs,
    metrics,
    traces,
    transcripts,
    failures,
    opts: () => opts,
    counts: () => ({ clients, aborts }),
    setTime: (at: number) => {
      current = at;
    },
    localMedia: () => media(local, 'MZ_local'),
    remoteMedia: () => media(remote, 'MZ_remote'),
    commit: (text: string) =>
      opts.onCommit({
        id: 'private-provider-id',
        text,
        source: 'private source never logged',
        firstDeltaAt: 500,
        committedAt: current,
      }),
  };
}
function voiced() {
  const pcm = Buffer.alloc(1920);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(6000, i);
  return pcm;
}
test('prefix preconnects while ringing; sends confirmed Hello without full English sentence', async (t) => {
  const f = fixture();
  t.after(() => f.bridge.close());
  f.bridge.attach('local', f.local.socket(), 'MZ_local');
  assert.equal(f.counts().clients, 1);
  await tick();
  f.localMedia();
  assert.equal(f.inputs.length, 0, 'ringing mic is never replayed');
  f.bridge.attach('remote', f.remote.socket(), 'MZ_remote');
  await tick();
  assert.equal(
    f.counts().clients,
    1,
    'second leg does not recreate text provider',
  );
  f.localMedia();
  assert.equal(f.inputs.length, 1);
  f.commit('Hello');
  assert.equal(f.jobs.length, 1, 'no punctuation / 300ms second gate');
  f.jobs[0].push(voiced());
  await tick();
  assert.ok(f.remote.sent.some((x) => x.event === 'media'));
  assert.equal(
    f.jobs[0].ended,
    false,
    'first chunk sent before entire voice job finishes',
  );
  f.remoteMedia();
  assert.ok(
    f.local.sent.some((x) => x.event === 'media'),
    'original English bypasses TTS',
  );
  assert.deepEqual(f.failures, []);
});
test('prefix FIFO, source/voice/audio association and content-free diagnostics', async (t) => {
  const f = fixture();
  t.after(() => f.bridge.close());
  f.bridge.attach('local', f.local.socket(), 'MZ_local');
  f.bridge.attach('remote', f.remote.socket(), 'MZ_remote');
  await tick();
  f.commit('Hello');
  f.commit("I'd like to book an appointment.");
  assert.equal(f.jobs.length, 1);
  f.jobs[0].push(voiced());
  f.jobs[0].push(null);
  await tick();
  assert.equal(f.jobs.length, 2);
  f.jobs[1].push(voiced());
  f.jobs[1].push(null);
  await tick();
  const submit = f.metrics.filter(
    (x) => x.name === 'prefix_source_to_submit_ms',
  );
  assert.deepEqual(
    submit.map((x) => x.prefixSequence),
    [1, 2],
  );
  assert.ok(
    f.metrics.some(
      (x) =>
        x.name === 'pocket_text_to_first_voiced_ms' && x.prefixSequence === 1,
    ),
  );
  assert.ok(f.traces.some((x) => x.stage === 'sent' && x.prefixSequence === 2));
  for (const raw of [...f.metrics, ...f.traces]) {
    const event = raw.name ? 'translation-metric' : 'translation-audio';
    const logged = diagnosticLogRecord(event, {
      ...raw,
      text: 'secret transcript',
      source: 'secret source',
    });
    const json = JSON.stringify(logged);
    assert.ok(!json.includes('secret'));
    assert.ok(!json.includes('private-provider-id'));
    if (raw.prefixSequence)
      assert.equal(logged?.prefixSequence, raw.prefixSequence);
  }
  assert.deepEqual(f.failures, []);
});
test('new prefix callbacks cannot synthesize or update transcripts after hangup', async () => {
  const f = fixture();
  f.bridge.attach('local', f.local.socket(), 'MZ_local');
  f.bridge.attach('remote', f.remote.socket(), 'MZ_remote');
  await tick();
  f.commit('Hello');
  f.jobs[0].push(voiced());
  await tick();
  f.bridge.close();
  const before = f.remote.sent.length;
  f.commit('Late sentence');
  f.opts().onTranscript({
    id: 'late',
    role: 'local',
    kind: 'original',
    text: 'late',
    final: true,
    at: 10,
  });
  f.jobs[0].push(voiced());
  f.jobs[0].push(null);
  await tick();
  assert.equal(f.remote.sent.length, before);
  assert.equal(f.jobs.length, 1);
  assert.equal(f.transcripts.length, 0);
  assert.equal(f.counts().aborts, 1);
  assert.equal(f.jobs[0].signal.aborted, true);
});
test('prefix provider failure tears down both legs without switching voice', async () => {
  const f = fixture();
  f.bridge.attach('local', f.local.socket(), 'MZ_local');
  f.bridge.attach('remote', f.remote.socket(), 'MZ_remote');
  await tick();
  f.opts().onError('PREFIX_ASR_FAILED');
  assert.deepEqual(f.failures, ['prefix_provider_failed:local']);
  assert.equal(f.local.readyState, WebSocket.CLOSED);
  assert.equal(f.remote.readyState, WebSocket.CLOSED);
  f.commit('No fallback');
  assert.equal(f.jobs.length, 0);
});
test('prefix bridge requires original-audio captions and local voice explicitly', () => {
  assert.throws(
    () =>
      new ContinuousTranslationBridge({
        apiKey: 'fake',
        model: 'test-only',
        outgoingPrefixes: true,
        remoteCaptions: true,
        onTranscript() {},
        onFailure() {},
      }),
    /INVALID_PREFIX_BRIDGE_OPTIONS/,
  );
});
