/* eslint-disable no-await-in-loop -- Assert each offline request/failure count in order. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALIYUN_CURRENT_TRANSLATION_LIMITS,
  translateAliyunCurrentSource,
  type CurrentTranslationOptions,
} from '../src/solo/aliyun-planb-current-translation';
import {
  createCurrentTranslationGuard,
  type CurrentTranslationGuard,
  type CurrentTranslationMemory,
} from '../src/solo/aliyun-planb-translation-guard';
import type {
  AliyunPlanBConfig,
  PlanBUsage,
} from '../src/solo/aliyun-planb-types';
import type { TranslationRole } from '../src/solo/translation-bridge';

const config: AliyunPlanBConfig = {
  region: 'beijing',
  apiKey: 'offline-current-translation-fixture',
  asrModel: 'fun-asr-realtime',
  textModel: 'qwen-mt-flash',
  ttsModel: 'cosyvoice-v3-flash',
  voice: 'loongandy_v3',
  sampleRate: 24000,
  webSocketUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
  translationUrl:
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
};
const frame = (value: unknown) =>
  `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
function response(text: string, reason = 'stop') {
  return new Response(
    frame({
      choices: [{ index: 0, delta: { content: text }, finish_reason: reason }],
    }) +
      frame({
        choices: [],
        usage: { prompt_tokens: 70, completion_tokens: 8 },
      }) +
      frame('[DONE]'),
  );
}
function fixture(
  role: TranslationRole = 'local',
  text = '更正，不是二十五元，是二百五十元。',
  sequence = 1,
  output = 'Correction, not twenty-five yuan, but two hundred and fifty yuan.',
) {
  const requests: { url: string; body: any }[] = [];
  const usages: PlanBUsage[] = [];
  const guard = createCurrentTranslationGuard(role);
  const options: CurrentTranslationOptions = {
    config,
    role,
    text,
    sequence,
    currentSourceIds: [sequence],
    translationGuard: guard,
    context: { version: 0, entries: [] },
    onUsage: (value) => usages.push(value),
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return response(output);
    },
  };
  return { options, requests, usages, guard };
}
function memory(
  guard: CurrentTranslationGuard,
  sequence: number,
  source: string,
  target: string,
): CurrentTranslationMemory {
  const job = { sequence, sourceIds: [sequence], raw: source };
  const receipt = guard.issue(job, sequence, target);
  guard.consume(receipt, job);
  return guard.toMemory(receipt, job);
}

test('local current-only raw user request preserves existing streaming usage and output cap', async () => {
  const f = fixture();
  const result = await translateAliyunCurrentSource(f.options);
  assert.deepEqual(f.requests, [
    {
      url: config.translationUrl,
      body: {
        model: 'qwen-mt-flash',
        messages: [{ role: 'user', content: f.options.text }],
        translation_options: { source_lang: 'Chinese', target_lang: 'English' },
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 2048,
      },
    },
  ]);
  assert.equal(
    result.text,
    'Correction, not twenty-five yuan, but two hundred and fifty yuan.',
  );
  assert.equal(result.rawText, result.text);
  assert.equal(result.memory.pairs, 0);
  assert.equal(result.usage?.inputTokens, 70);
  assert.equal(f.usages.length, 1);
});

test('remote current-only request uses English to Chinese and only this role memory', async () => {
  const f = fixture(
    'remote',
    'Do not cancel it. The corrected amount is 250, not 25.',
    2,
    '不要取消。更正后的金额是250，不是25。',
  );
  const prior = memory(f.guard, 1, 'The amount is 25.', '金额是25。');
  f.options.translationMemory = [prior];
  const result = await translateAliyunCurrentSource(f.options);
  assert.deepEqual(f.requests[0].body.messages, [
    { role: 'user', content: f.options.text },
  ]);
  assert.deepEqual(f.requests[0].body.translation_options, {
    source_lang: 'English',
    target_lang: 'Chinese',
    tm_list: [{ source: prior.source, target: prior.target }],
  });
  assert.equal(result.text, '不要取消。更正后的金额是250，不是25。');
  assert.deepEqual(result.memory.sourceIds, [1]);
});

test('official tm_list uses only guarded current-call pair values, never raw-history prompt or reference', async () => {
  const f = fixture(
    'local',
    '更正，是星期二。',
    2,
    'Correction, it is Tuesday.',
  );
  const prior = memory(
    f.guard,
    1,
    '会议是星期一。',
    'The meeting is on Monday.',
  );
  f.options.translationMemory = [prior];
  f.options.context.entries = [
    {
      role: 'remote',
      sourceId: 'reference',
      sourceKind: 'native_output',
      at: 0,
      observedAt: 0,
      order: 1,
      revision: 1,
      text: 'EXTERNAL_REFERENCE_NEVER_SENT',
      provisional: false,
      generated: true,
    },
  ];
  await translateAliyunCurrentSource(f.options);
  const { body } = f.requests[0];
  assert.deepEqual(body.translation_options.tm_list, [
    { source: prior.source, target: prior.target },
  ]);
  assert.deepEqual(Object.keys(body.translation_options).sort(), [
    'source_lang',
    'target_lang',
    'tm_list',
  ]);
  assert.doesNotMatch(
    JSON.stringify(body.messages),
    /CURRENT_SOURCE|RECENT_RAW_CONTEXT|Monday|星期一|EXTERNAL_REFERENCE/u,
  );
  assert.doesNotMatch(JSON.stringify(body), /EXTERNAL_REFERENCE/u);
});

test('non-empty legacy raw-only history is refused rather than copied or silently claimed as memory', async () => {
  const f = fixture();
  f.options.context.entries = [
    {
      role: 'local',
      sourceId: 'raw_history',
      sourceKind: 'asr',
      at: 0,
      observedAt: 0,
      order: 1,
      revision: 1,
      text: '历史原文',
      provisional: false,
      generated: false,
    },
  ];
  await assert.rejects(
    translateAliyunCurrentSource(f.options),
    /PLANB_CURRENT_MT_MEMORY_REQUIRED$/u,
  );
  assert.equal(f.requests.length, 0);
});

test('forged, cross-call, cross-role, future and duplicate memory fail before transport', async () => {
  const f = fixture('local', '当前。', 3);
  const good = memory(f.guard, 1, '先前。', 'Earlier.');
  const other = createCurrentTranslationGuard('local');
  const crossCall = memory(other, 1, '其他通话。', 'Another call.');
  const remote = createCurrentTranslationGuard('remote');
  const crossRole = memory(remote, 1, 'A different speaker.', '另一个说话方。');
  const future = memory(f.guard, 3, '未来。', 'Future.');
  for (const list of [
    [{ ...good }],
    [crossCall],
    [crossRole],
    [future],
    [good, good],
    [
      {
        origin: good.origin,
        role: 'local',
        sourceIds: [1],
        sequence: 1,
        source: 'Test reference',
        target: 'Injected answer',
      },
    ],
  ]) {
    f.options.translationMemory = list as any;
    await assert.rejects(
      translateAliyunCurrentSource(f.options),
      /PLANB_CURRENT_MT_MEMORY_INVALID$/u,
    );
  }
  f.options.translationMemory = [good];
  f.options.translationGuard = { assertMemory: (x: unknown) => x } as any;
  await assert.rejects(
    translateAliyunCurrentSource(f.options),
    /GUARD_UNISSUED$/u,
  );
  assert.equal(f.requests.length, 0);
});

test('true repeated speech with different source identity is not text-deduplicated', async () => {
  const raw = '不要取消。';
  const translated = 'Do not cancel.';
  const f = fixture('local', raw, 2, translated);
  f.options.translationMemory = [memory(f.guard, 1, raw, translated)];
  const result = await translateAliyunCurrentSource(f.options);
  assert.equal(result.text, translated);
  const current = { sequence: 2, sourceIds: [2], raw };
  const receipt = f.guard.issue(current, 2, result.rawText);
  assert.equal(f.guard.consume(receipt, current).ttsText, translated);
  assert.equal(f.requests.length, 1);
});

test('complete memory pairs are bounded to recent six and 1600 characters without cutting a sentence', async () => {
  const f = fixture('local', '当前。', 10);
  f.options.translationMemory = Array.from({ length: 9 }, (_, index) =>
    memory(f.guard, index + 1, `历史${index + 1}`, `Prior ${index + 1}.`),
  );
  const result = await translateAliyunCurrentSource(f.options);
  assert.equal(
    result.memory.pairs,
    ALIYUN_CURRENT_TRANSLATION_LIMITS.memoryPairs,
  );
  assert.equal(result.memory.omittedPairs, 3);
  assert.deepEqual(
    f.requests[0].body.translation_options.tm_list,
    f.options.translationMemory
      .slice(-6)
      .map(({ source, target }) => ({ source, target })),
  );
  const large = fixture('local', '当前。', 4);
  large.options.translationMemory = [
    memory(large.guard, 1, '甲'.repeat(601), 'Whole oversized history.'),
    memory(large.guard, 2, '乙'.repeat(550), 'B'.repeat(900)),
    memory(large.guard, 3, '丙'.repeat(200), 'C'.repeat(200)),
  ];
  const bounded = await translateAliyunCurrentSource(large.options);
  assert.equal(bounded.memory.pairs, 1);
  assert.deepEqual(large.requests[0].body.translation_options.tm_list, [
    { source: '丙'.repeat(200), target: 'C'.repeat(200) },
  ]);
});

test('no audition sequence cap, current limit enforced, and region/model mismatch fails without fallback', async () => {
  const f = fixture('local', '长通话后的当前原文。', 500);
  await translateAliyunCurrentSource(f.options);
  assert.equal(f.requests.length, 1);
  for (const change of [
    { text: '字'.repeat(4097) },
    { sequence: 0 },
    { currentSourceIds: [2, 2] },
    {
      config: {
        ...config,
        region: 'singapore',
        webSocketUrl: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference',
        translationUrl:
          'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
      },
    },
    { config: { ...config, textModel: 'another-model' } },
  ]) {
    const bad = fixture();
    Object.assign(bad.options, change);
    await assert.rejects(translateAliyunCurrentSource(bad.options));
    assert.equal(bad.requests.length, 0);
  }
});

test('raw JSON, meta and historical wrapper survive intact for mandatory receipt rejection, never extraction', async () => {
  for (const output of [
    ' {"translation":"A pretend clean answer."} ',
    'Translation: A pretend clean answer.',
    'RECENT_RAW_CONTEXT: synthetic history',
  ]) {
    const f = fixture('local', '当前。', 1, output);
    const result = await translateAliyunCurrentSource(f.options);
    assert.equal(result.rawText, output);
    assert.equal(result.text, output.trim());
    assert.throws(
      () =>
        f.guard.issue(
          { sequence: 1, sourceIds: [1], raw: f.options.text },
          1,
          result.rawText,
        ),
      /BODY_/u,
    );
  }
});

test('transport failure, timeout, incomplete output and cancellation make no retry or fallback', async () => {
  const failed = fixture();
  let calls = 0;
  failed.options.fetch = async () => {
    calls += 1;
    throw new Error('private canary');
  };
  await assert.rejects(
    translateAliyunCurrentSource(failed.options),
    /PLANB_MT_STREAM_FAILED$/u,
  );
  assert.equal(calls, 1);
  const incomplete = fixture();
  incomplete.options.fetch = async () => response('Incomplete', 'length');
  await assert.rejects(
    translateAliyunCurrentSource(incomplete.options),
    /PLANB_MT_INCOMPLETE$/u,
  );
  const timed = fixture();
  timed.options.timeoutMs = 5;
  timed.options.fetch = async () => {
    calls += 1;
    return new Promise(() => {});
  };
  await assert.rejects(
    translateAliyunCurrentSource(timed.options),
    /PLANB_MT_TIMEOUT$/u,
  );
  assert.equal(calls, 2);
  const cancelled = fixture();
  const abort = new AbortController();
  abort.abort();
  cancelled.options.signal = abort.signal;
  await assert.rejects(
    translateAliyunCurrentSource(cancelled.options),
    /PLANB_MT_CANCELLED$/u,
  );
  assert.equal(cancelled.requests.length, 0);
});
