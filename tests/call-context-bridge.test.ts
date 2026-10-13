import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import WebSocket from 'ws';

import { ContinuousTranslationBridge } from '../src/solo/continuous-translation-bridge';
import type { ContinuousTranslationOptions } from '../src/solo/continuous-translation-client';
import type { RemoteCaptionOptions } from '../src/solo/remote-caption-client';

class Phone extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  send(_payload: string, callback?: (error?: Error) => void) {
    callback?.();
  }

  terminate() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

async function fixture(t: any) {
  let time = 1000;
  let native!: ContinuousTranslationOptions;
  let captions!: RemoteCaptionOptions;
  let nativeCreates = 0;
  let captionCreates = 0;
  const bridge = new ContinuousTranslationBridge({
    apiKey: 'offline-fake',
    model: 'gpt-realtime-1.5',
    remoteCaptions: true,
    now: () => time,
    onTranscript() {},
    onFailure() {},
    createClient(options) {
      nativeCreates += 1;
      native = options;
      return {
        ready: Promise.resolve(),
        append() {},
        async finish() {},
        abort() {},
      };
    },
    createCaptionClient(options) {
      captionCreates += 1;
      captions = options;
      return {
        ready: Promise.resolve(),
        append() {},
        async finish() {},
        abort() {},
        breakSection() {},
      };
    },
  });
  t.after(() => bridge.close());
  bridge.attach('local', new Phone() as unknown as WebSocket, 'MZ_local');
  bridge.attach('remote', new Phone() as unknown as WebSocket, 'MZ_remote');
  await tick();
  return {
    bridge,
    native,
    captions,
    setTime: (value: number) => {
      time = value;
    },
    counts: () => ({ nativeCreates, captionCreates }),
  };
}

test('production caption route receives bounded per-call observations with honest native provenance', async (t) => {
  const f = await fixture(t);
  f.native.onTranscript?.('Please keep the appointment.', {});
  f.setTime(2000);
  f.captions.onTranscript({
    id: 'remote:original:first:0',
    utteranceId: 'remote:first:0',
    role: 'remote',
    kind: 'original',
    text: 'Do not change the amount.',
    at: 1500,
    sourceEndAt: 1800,
    sourceRevision: 1,
    final: true,
  });
  const snapshot = f.captions.getContext!({ role: 'remote', at: 2500 });
  assert.deepEqual(
    snapshot.entries.map((entry) => [
      entry.role,
      entry.sourceKind,
      entry.generated,
      entry.provisional,
    ]),
    [
      ['local', 'native_output', true, true],
      ['remote', 'asr', false, false],
    ],
  );
  assert.deepEqual(f.counts(), { nativeCreates: 1, captionCreates: 1 });
  assert.equal(f.native.targetLanguage, 'en');
  assert.ok(
    !('voice' in f.native) && !('instructions' in f.native),
    'no unsupported native configuration',
  );
});

test('a late final with a known earlier ASR end can aid text context without importing future native words', async (t) => {
  const f = await fixture(t);
  f.native.onInputTranscript?.('不要改日期。', {});
  f.setTime(2500);
  f.native.onInputTranscript?.('也不要改金额。', {});
  f.captions.onTranscript({
    id: 'remote:original:earlier:0',
    utteranceId: 'remote:earlier:0',
    role: 'remote',
    kind: 'original',
    text: 'Not fifty, fifteen.',
    at: 1200,
    sourceEndAt: 1500,
    sourceRevision: 1,
    final: true,
  });
  const snapshot = f.captions.getContext!({
    role: 'remote',
    at: 2000,
    observedBeforeAt: 2500,
    allowLateFinal: true,
  });
  assert.equal(
    snapshot.entries.find((entry) => entry.role === 'local')?.text,
    '不要改日期。',
  );
  assert.equal(
    snapshot.entries.find((entry) => entry.role === 'remote')?.text,
    'Not fifty, fifteen.',
  );
  assert.ok(!snapshot.entries.some((entry) => entry.text.includes('金额')));
});

test('bridge close releases call context and a new authenticated call has none of the prior content', async (t) => {
  const first = await fixture(t);
  first.native.onTranscript?.('An observed generated phrase.', {});
  assert.equal(
    first.captions.getContext!({ role: 'remote', at: 2000 }).entries.length,
    1,
  );
  const second = await fixture(t);
  assert.deepEqual(
    second.captions.getContext!({ role: 'remote', at: 2000 }).entries,
    [],
  );
  first.bridge.close();
  first.setTime(3000);
  first.native.onTranscript?.('A late callback must be ignored.', {});
  assert.deepEqual(
    first.captions.getContext!({ role: 'remote', at: 4000 }).entries,
    [],
  );
  assert.deepEqual(second.counts(), { nativeCreates: 1, captionCreates: 1 });
});
