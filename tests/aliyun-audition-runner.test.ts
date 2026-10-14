import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  runAliyunAudition,
  type AliyunAuditionRunnerOptions,
} from '../src/experiments/aliyun-audition-runner';
import type { AliyunAuditionClip } from '../src/experiments/aliyun-audition-input';
import type {
  AliyunPlanBConfig,
  PlanBAsrOptions,
  PlanBAsrSource,
  PlanBTranslationOptions,
  PlanBTtsOptions,
} from '../src/solo/aliyun-planb-types';

const config: AliyunPlanBConfig = {
  region: 'beijing',
  apiKey: 'offline-test-no-live-credential',
  asrModel: 'fun-asr-realtime',
  textModel: 'qwen-mt-flash',
  ttsModel: 'cosyvoice-v3-flash',
  voice: 'loongandy_v3',
  sampleRate: 24000,
  webSocketUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
  translationUrl:
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
};
const clip = (
  id = 'zh',
  role: 'local' | 'remote' = 'local',
  durationMs = 100,
): AliyunAuditionClip => ({
  id,
  role,
  pcm: Buffer.alloc(durationMs * 48),
  durationMs,
  speechEndMs: 60,
  sha256: 'a'.repeat(64),
  wavPath: '/offline-fixture-not-opened.wav',
});
type Hooks = {
  append?: (options: PlanBAsrOptions, frame: number, anchor: number) => void;
  finish?: (options: PlanBAsrOptions, anchor: number) => Promise<void> | void;
  translate?: (options: PlanBTranslationOptions) => Promise<string>;
  tts?: (text: string, options: PlanBTtsOptions) => AsyncIterable<Buffer>;
  abortTts?: (options: PlanBTtsOptions) => void;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  ready?: Promise<void>;
};
function harness(hooks: Hooks = {}) {
  let time = 100;
  let asrAborts = 0;
  let ttsAborts = 0;
  let finishCalls = 0;
  const requests: PlanBTranslationOptions[] = [];
  const spoken: string[] = [];
  const asrOptions: PlanBAsrOptions[] = [];
  const voices: string[] = [];
  const ttsOptions: PlanBTtsOptions[] = [];
  const frameTimes: number[] = [];
  const deps: NonNullable<AliyunAuditionRunnerOptions['deps']> = {
    createAsr(options) {
      asrOptions.push(options);
      const anchor = time;
      let frames = 0;
      return {
        ready: hooks.ready ?? Promise.resolve(),
        append() {
          frames += 1;
          frameTimes.push(time);
          hooks.append?.(options, frames, anchor);
        },
        async finish() {
          finishCalls += 1;
          if (hooks.finish) await hooks.finish(options, anchor);
          else
            options.onSource({
              sequence: 1,
              revision: 1,
              text:
                options.role === 'local'
                  ? '不是十五美元，是五十美元。'
                  : 'Do not cancel it.',
              final: true,
              at: anchor,
              endAt: anchor + 60,
            });
          options.onUsage?.({
            layer: 'asr',
            role: options.role,
            taskSequence: 1,
            region: config.region,
            durationSeconds: 0.1,
            basis: 'provider_reported',
          });
        },
        abort() {
          asrAborts += 1;
        },
      };
    },
    async translate(options) {
      requests.push(options);
      time += 12;
      let text =
        options.role === 'local'
          ? 'Not fifteen dollars, but fifty dollars.'
          : '不要取消。';
      if (hooks.translate) text = await hooks.translate(options);
      options.onUsage?.({
        layer: 'translation',
        role: options.role,
        taskSequence: options.sequence,
        region: config.region,
        inputTokens: 300,
        outputTokens: 12,
        basis: 'provider_reported',
      });
      return { text };
    },
    createTts(options) {
      ttsOptions.push(options);
      voices.push(options.config.voice);
      return {
        async *synthesize(text, sequence) {
          spoken.push(text);
          time += 18;
          options.onUsage?.({
            layer: 'tts',
            role: 'local',
            taskSequence: sequence,
            region: config.region,
            characters: text.length,
            basis: 'provider_reported',
          });
          if (hooks.tts) yield* hooks.tts(text, options);
          else yield Buffer.alloc(480, 2);
        },
        abort() {
          ttsAborts += 1;
          hooks.abortTts?.(options);
        },
      };
    },
  };
  const run = (
    clips = [clip()],
    extras: Partial<AliyunAuditionRunnerOptions> = {},
  ) =>
    runAliyunAudition({
      config,
      clips,
      deps,
      now: () => time,
      delay:
        hooks.delay ??
        (async (ms) => {
          time += ms;
        }),
      ...extras,
    });
  return {
    run,
    requests,
    spoken,
    asrOptions,
    voices,
    ttsOptions,
    frameTimes,
    get asrAborts() {
      return asrAborts;
    },
    get ttsAborts() {
      return ttsAborts;
    },
    get finishCalls() {
      return finishCalls;
    },
    advance(ms: number) {
      time += ms;
    },
  };
}
const source = (
  anchor: number,
  sequence: number,
  text: string,
  revision = 1,
  final = true,
): PlanBAsrSource => ({
  sequence,
  revision,
  text,
  final,
  at: anchor,
  ...(final ? { endAt: anchor + 20 } : {}),
});

test('Chinese TTS and English captions share fixed models; English never gets TTS', async () => {
  const h = harness();
  const result = await h.run([clip(), clip('en', 'remote')]);
  assert.equal(result.status, 'completed');
  assert.deepEqual(
    h.asrOptions.map((value) => value.role),
    ['local', 'remote'],
  );
  assert.equal(h.spoken.length, 1);
  assert.equal(result.segments[1].pcm.length, 0);
  assert.equal(result.segments[1].translation, '不要取消。');
  assert.equal(result.segments[0].translation, h.spoken[0]);
  assert.deepEqual(h.voices, ['loongandy_v3']);
  assert.equal(result.configuration.automaticRetries, 0);
  assert.equal(result.configuration.automaticReconnects, 0);
  assert.equal(result.configuration.translationMaxTokens, 2048);
  assert.equal(result.usage.length, 5);
  assert.equal(h.asrAborts, 2);
  assert.equal(h.ttsAborts, 1);
});

test('Complete endpoint latency includes ASR final, MT and TTS, plus marked endpoint', async () => {
  const h = harness();
  const result = await h.run();
  const { latency } = result.segments[0];
  assert.equal(latency.sourceEndToFinalMs, 40);
  assert.equal(latency.translationMs, 12);
  assert.equal(latency.ttsFirstPcmMs, 18);
  assert.equal(latency.translationStartedAt, 200);
  assert.equal(latency.translationCompletedAt, 212);
  assert.equal(latency.ttsRequestedAt, 212);
  assert.equal(latency.translationEndToTtsMs, 0);
  assert.equal(latency.sourceEndToFirstPcmMs, 70);
  assert.equal(latency.annotatedClipSpeechEndToFirstPcmMs, 70);
  assert.equal(latency.queueMs, 0);
  assert.equal(
    latency.sourceEndToFirstPcmMs,
    latency.sourceEndToFinalMs! +
      latency.queueMs +
      latency.translationMs! +
      latency.translationEndToTtsMs! +
      latency.ttsFirstPcmMs!,
  );
  assert.equal(latency.sourceEndBasis, 'provider_stream_estimate');
  assert.equal(result.clips[0].finalizationAfterFinishObserved, true);
});

test('Missing or future provider endpoint remains unknown rather than zero', async () => {
  const h = harness({
    finish: (options, anchor) =>
      options.onSource({ ...source(anchor, 1, '测试。'), endAt: undefined }),
  });
  const result = await h.run();
  assert.equal(result.segments[0].latency.sourceEndToFinalMs, null);
  assert.equal(result.segments[0].latency.sourceEndToFirstPcmMs, null);
  assert.equal(result.segments[0].latency.sourceEndBasis, 'unknown');
  const h2 = harness({
    finish: (options, anchor) =>
      options.onSource({
        ...source(anchor, 1, '测试。'),
        endAt: anchor + 1000,
      }),
  });
  assert.equal((await h2.run()).segments[0].latency.sourceEndAt, null);
});

test('20ms realtime pacing and final FIFO begin before file finish', async () => {
  const h = harness({
    append(options, frame, anchor) {
      if (frame === 2) options.onSource(source(anchor, 1, '第一句。'));
    },
    finish() {},
  });
  const result = await h.run([clip('zh', 'local', 200)]);
  assert.equal(result.status, 'completed');
  assert.equal(result.clips[0].finalsBeforeFinish, 1);
  assert.ok(
    result.segments[0].latency.firstPcmAt! < result.clips[0].finishRequestedAt!,
  );
  assert.equal(h.frameTimes[0], 100);
  assert.equal(h.frameTimes[1], 120);
  assert.equal(h.frameTimes.length, 10);
  assert.equal(result.counters.inputBytesSent, 9600);
});

test('Long provisional sentence does not call MT until provider confirms; elapsed wait recorded', async () => {
  let priorCalls = -1;
  const h = harness({
    append(options, frame, anchor) {
      options.onSource(
        source(
          anchor,
          1,
          `重复，重复，${'继续讲话'.repeat(frame)}`,
          frame,
          false,
        ),
      );
      priorCalls = h.requests.length;
    },
    finish(options, anchor) {
      options.onSource(
        source(anchor, 1, '重复后继续讲话，不要预订六月十五日。', 51),
      );
    },
  });
  const result = await h.run([clip('zh', 'local', 1000)]);
  assert.equal(priorCalls, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(result.clips[0].maxPartialWaitMs, 1000);
  assert.equal(result.clips[0].finalsAfterFinish, 1);
  assert.equal(result.segments[0].raw, '重复后继续讲话，不要预订六月十五日。');
});

test('Context contains confirmed raw only and CURRENT_SOURCE is sent exactly once', async () => {
  const h = harness({
    finish(options, anchor) {
      options.onSource(source(anchor, 1, '我说十五，呃，不对，五十美元。'));
      options.onSource(source(anchor + 1, 2, '不是今天，是六月十五日。'));
    },
  });
  const result = await h.run();
  assert.equal(result.status, 'completed');
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[0].context.entries, []);
  assert.equal(h.requests[1].text, '不是今天，是六月十五日。');
  assert.equal(
    h.requests[1].context.entries[0].text,
    '我说十五，呃，不对，五十美元。',
  );
  assert.equal(h.requests[1].context.entries[0].generated, false);
  assert.equal(h.requests[1].context.entries[0].provisional, false);
  assert.deepEqual(result.segments[1].contextSourceIds, ['zh:1']);
  assert.equal(h.spoken.length, 2);
});

test('Earlier partial blocks later final; no reordered speech or partial context', async () => {
  const h = harness({
    append(options, frame, anchor) {
      if (frame === 1) options.onSource(source(anchor, 1, '第一', 1, false));
      if (frame === 2) options.onSource(source(anchor + 1, 2, '第二句。'));
    },
    finish(options, anchor) {
      options.onSource(source(anchor, 1, '第一句。', 2));
    },
  });
  const result = await h.run();
  assert.equal(result.status, 'completed');
  assert.deepEqual(
    h.requests.map((value) => value.text),
    ['第一句。', '第二句。'],
  );
  assert.ok(result.segments[1].latency.queueMs > 0);
});

test('Duplicate finals and late changed revisions do not cause new requests or replay', async () => {
  const h = harness({
    finish(options, anchor) {
      options.onSource(source(anchor, 1, '不是五美元。'));
      options.onSource(source(anchor, 1, '不是五美元。'));
      options.onSource(source(anchor, 1, '是五美元。', 2));
    },
  });
  const result = await h.run();
  assert.equal(result.status, 'completed');
  assert.equal(result.counters.duplicateFinalsIgnored, 1);
  assert.equal(result.counters.lateRevisionsIgnored, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.spoken.length, 1);
  assert.equal(result.segments[0].raw, '不是五美元。');
  assert.equal(
    result.evidence.at(-1)?.code,
    'ALIYUN_AUDITION_LATE_REVISION_IGNORED',
  );
});

test('Empty confirmed withdrawal does not translate or synthesize', async () => {
  const h = harness({
    finish: (options, anchor) => options.onSource(source(anchor, 1, '')),
  });
  const result = await h.run();
  assert.equal(result.status, 'completed');
  assert.equal(h.requests.length, 0);
  assert.equal(h.spoken.length, 0);
});

test('Unconfirmed source remaining after task end fails without inventing a final', async () => {
  const h = harness({
    finish: (options, anchor) =>
      options.onSource(source(anchor, 1, '未完成', 1, false)),
  });
  const result = await h.run();
  assert.equal(result.errorCode, 'ALIYUN_AUDITION_ASR_FINAL_MISSING');
  assert.equal(result.counters.translationRequests, 0);
  assert.equal(h.asrAborts, 1);
});

test('Input limits are checked before ASR construction', async () => {
  const h = harness();
  await assert.rejects(
    h.run(Array.from({ length: 5 }, (_, index) => clip(`c${index}`))),
    /INPUT_INVALID/,
  );
  await assert.rejects(h.run([clip('long', 'local', 24020)]), /INPUT_LIMIT/);
  await assert.rejects(
    h.run([{ ...clip(), durationMs: 999 }]),
    /INPUT_INVALID/,
  );
  assert.equal(h.asrOptions.length, 0);
});

test('MT submission cap reserves before invoking ninth request', async () => {
  const h = harness({
    finish(options, anchor) {
      for (let index = 1; index <= 9; index += 1)
        options.onSource(source(anchor, index, `Sentence ${index}.`));
    },
  });
  const result = await h.run([clip('en', 'remote')]);
  assert.equal(result.errorCode, 'ALIYUN_AUDITION_TRANSLATION_LIMIT');
  assert.equal(h.requests.length, 8);
  assert.equal(result.counters.translationRequests, 8);
  assert.equal(h.spoken.length, 0);
});

test('TTS submission cap reserves before fifth provider task', async () => {
  const h = harness({
    finish(options, anchor) {
      for (let index = 1; index <= 5; index += 1)
        options.onSource(source(anchor, index, `第${index}句。`));
    },
  });
  const result = await h.run();
  assert.equal(result.errorCode, 'ALIYUN_AUDITION_TTS_LIMIT');
  assert.equal(h.spoken.length, 4);
  assert.equal(result.counters.ttsTasks, 4);
  assert.deepEqual(h.voices, Array(4).fill('loongandy_v3'));
});

test('TTS characters checked before submission and never claimed as billing cap', async () => {
  const h = harness({ translate: async () => 'x'.repeat(2001) });
  const result = await h.run();
  assert.equal(result.errorCode, 'ALIYUN_AUDITION_TTS_CHARACTER_LIMIT');
  assert.equal(result.counters.ttsTasks, 0);
  assert.equal(h.spoken.length, 0);
});

test('Output observation cap stops resource use and retains only capped received PCM', async () => {
  const h = harness({
    async *tts() {
      yield Buffer.alloc(36 * 48000 + 2);
    },
  });
  const result = await h.run();
  assert.equal(result.errorCode, 'ALIYUN_AUDITION_OUTPUT_OBSERVATION_LIMIT');
  assert.equal(result.counters.outputBytesReceived, 36 * 48000);
  assert.equal(result.segments[0].pcm.length, 36 * 48000);
  assert.equal(h.spoken.length, 1);
  assert.ok(h.ttsAborts >= 1);
});

test('Provider failure stops next clips, pending finals and never exposes raw error text', async () => {
  const h = harness({
    translate: async () => {
      throw new Error('secret-real-key-and-call-body');
    },
  });
  const result = await h.run([clip(), clip('en', 'remote')]);
  assert.equal(result.errorCode, 'ALIYUN_AUDITION_PROVIDER_FAILED');
  assert.equal(h.asrOptions.length, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.spoken.length, 0);
  assert.ok(!JSON.stringify(result).includes('secret-real-key'));
  const before = h.requests.length;
  h.asrOptions[0].onSource(source(100, 2, '迟到。'));
  assert.equal(h.requests.length, before);
});

test('ASR synchronous failure fences all further audio and requests', async () => {
  const h = harness({
    append(options) {
      options.onError('PLAN_B_ASR_PROVIDER_FAILED');
    },
  });
  const result = await h.run();
  assert.equal(result.errorCode, 'PLAN_B_ASR_PROVIDER_FAILED');
  assert.equal(h.frameTimes.length, 1);
  assert.equal(h.finishCalls, 0);
  assert.equal(h.requests.length, 0);
});

test('Pre-cancelled and mid-input cancellation close resources with zero later request', async () => {
  const before = new AbortController();
  before.abort();
  const h = harness();
  assert.equal(
    (await h.run(undefined, { signal: before.signal })).status,
    'cancelled',
  );
  assert.equal(h.asrOptions.length, 0);
  const mid = new AbortController();
  const h2 = harness({
    append() {
      mid.abort();
    },
  });
  assert.equal(
    (await h2.run(undefined, { signal: mid.signal })).status,
    'cancelled',
  );
  assert.equal(h2.frameTimes.length, 1);
  assert.equal(h2.requests.length, 0);
  assert.equal(h2.asrAborts, 1);
});

test('Timeout waiting for ASR ready returns and cleans without retry', async () => {
  const h = harness({ ready: new Promise(() => {}) });
  const result = await h.run(undefined, { timeoutMs: 5 });
  assert.equal(result.errorCode, 'ALIYUN_AUDITION_TIMEOUT');
  assert.equal(h.asrOptions.length, 1);
  assert.equal(h.frameTimes.length, 0);
  assert.equal(h.asrAborts, 1);
  assert.equal(h.requests.length, 0);
});

test('Cancellation while MT pending prevents late fulfillment from creating TTS', async () => {
  const abort = new AbortController();
  let resolve!: (text: string) => void;
  const h = harness({
    translate: () =>
      new Promise((done) => {
        resolve = done;
        queueMicrotask(() => abort.abort());
      }),
  });
  const result = await h.run(undefined, { signal: abort.signal });
  assert.equal(result.status, 'cancelled');
  resolve('Late correct translation.');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.spoken.length, 0);
  assert.equal(result.counters.translationRequests, 1);
});

test('Usage records distinguish clip tasks and do not sum cumulative duplicate ASR reports', async () => {
  const h = harness({
    finish(options, anchor) {
      options.onSource(source(anchor, 1, '测试。'));
      for (const durationSeconds of [0.05, 0.1])
        options.onUsage?.({
          layer: 'asr',
          role: options.role,
          taskSequence: 1,
          region: config.region,
          durationSeconds,
          basis: 'provider_reported',
        });
    },
  });
  const result = await h.run([clip('one'), clip('two')]);
  const usage = result.usage.filter((entry) => entry.layer === 'asr');
  assert.equal(usage.length, 2);
  assert.deepEqual(
    usage.map((entry) => entry.durationSeconds),
    [0.1, 0.1],
  );
  assert.deepEqual(
    result.usage
      .filter((entry) => entry.layer === 'tts')
      .map((entry) => entry.clipId),
    ['one', 'two'],
  );
});

test('Out-of-order cumulative usage and unknown terminal reports retain known maxima', async () => {
  const h = harness({
    finish(options, anchor) {
      options.onSource(source(anchor, 1, '测试。'));
      for (const durationSeconds of [0.3, 0.05])
        options.onUsage?.({
          layer: 'asr',
          role: options.role,
          taskSequence: 1,
          region: config.region,
          durationSeconds,
          basis: 'provider_reported',
        });
      options.onUsage?.({
        layer: 'asr',
        role: options.role,
        taskSequence: 1,
        region: config.region,
        basis: 'unknown',
      });
    },
  });
  const result = await h.run();
  const usage = result.usage.find((value) => value.layer === 'asr')!;
  assert.equal(usage.durationSeconds, 0.3);
  assert.equal(usage.basis, 'provider_reported');
});

test('Clip endpoint annotation belongs only to its final source', async () => {
  const h = harness({
    finish(options, anchor) {
      options.onSource(source(anchor, 1, '第一句。'));
      options.onSource(source(anchor + 1, 2, '第二句。'));
    },
  });
  const result = await h.run();
  assert.equal(
    result.segments[0].latency.annotatedClipSpeechEndToFirstPcmMs,
    null,
  );
  assert.equal(
    typeof result.segments[1].latency.annotatedClipSpeechEndToFirstPcmMs,
    'number',
  );
});

test('Provider configuration is snapshotted once, not changed between tasks', async () => {
  const mutable = { ...config };
  const h = harness({
    append() {
      mutable.apiKey = 'changed-offline-fixture';
      mutable.webSocketUrl = 'wss://wrong.invalid';
    },
  });
  const result = await h.run(undefined, { config: mutable });
  assert.equal(result.status, 'completed');
  assert.equal(h.asrOptions[0].config.webSocketUrl, config.webSocketUrl);
  assert.equal(h.requests[0].config.apiKey, config.apiKey);
  assert.equal(Object.isFrozen(h.requests[0].config), true);
});

test('Cleanup usage is retained after cancellation; callbacks after return cannot mutate receipt', async () => {
  const controller = new AbortController();
  const h = harness({
    async *tts() {
      controller.abort();
      yield Buffer.alloc(480);
    },
    abortTts(options) {
      options.onUsage?.({
        layer: 'tts',
        role: 'local',
        taskSequence: 1,
        region: config.region,
        characters: 200,
        basis: 'provider_reported',
      });
    },
  });
  const result = await h.run(undefined, { signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  const receipt = result.usage.find((entry) => entry.layer === 'tts')!;
  assert.equal(receipt.characters, 200);
  h.ttsOptions[0].onUsage?.({
    layer: 'tts',
    role: 'local',
    taskSequence: 1,
    region: config.region,
    characters: 999,
    basis: 'provider_reported',
  });
  assert.equal(receipt.characters, 200);
  assert.equal(
    result.usage.find((entry) => entry.layer === 'tts')?.characters,
    200,
  );
  assert.equal(h.spoken.length, 1);
});
