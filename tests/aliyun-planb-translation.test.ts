/* eslint-disable no-await-in-loop -- Table regressions run deterministic fake streams. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReadableStream } from 'node:stream/web';

import { translateAliyunPlanB } from '../src/solo/aliyun-planb-translation';
import type {
  AliyunPlanBConfig,
  PlanBTranslationOptions,
  PlanBUsage,
} from '../src/solo/aliyun-planb-types';

const config: AliyunPlanBConfig = {
  region: 'beijing',
  apiKey: 'test-only-not-a-real-key',
  asrModel: 'fun-asr-realtime',
  textModel: 'qwen-mt-flash',
  ttsModel: 'cosyvoice-v3-flash',
  voice: 'loongandy_v3',
  sampleRate: 24000,
  webSocketUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
  translationUrl:
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
};
const chunk = (content: string, finishReason: string | null = null) => ({
  choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
});
const event = (value: unknown, id?: string) =>
  `${id ? `id: ${id}\n` : ''}data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const sse = (frames: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(Buffer.from(frame));
        controller.close();
      },
    }),
    { status: 200 },
  );
const base = (fetcher: typeof fetch): PlanBTranslationOptions => ({
  config,
  role: 'local',
  text: '不是二百五十元，是二十五元。',
  context: { version: 0, entries: [] },
  sequence: 1,
  fetch: fetcher,
  timeoutMs: 1000,
});

test('Qwen-MT uses only one user prompt, contextual originals and official fields', async () => {
  let request: any;
  let calls = 0;
  const usages: PlanBUsage[] = [];
  const deltas: string[] = [];
  const options = base(async (_url, init) => {
    calls += 1;
    request = JSON.parse(String(init?.body));
    return sse([
      event(chunk('Not 250 yuan, ')),
      event(chunk('but 25 yuan.', 'stop')),
      event({
        choices: [],
        usage: { prompt_tokens: 231, completion_tokens: 12 },
      }),
      event('[DONE]'),
    ]);
  });
  options.context = {
    version: 1,
    entries: [
      {
        role: 'remote',
        sourceId: 'raw_1',
        sourceKind: 'asr',
        at: 0,
        order: 1,
        revision: 1,
        observedAt: 0,
        text: 'How much is it?',
        provisional: false,
        generated: false,
      },
      {
        role: 'local',
        sourceId: 'generated_1',
        sourceKind: 'native_output',
        at: 0,
        order: 2,
        revision: 1,
        observedAt: 0,
        text: 'CANARY_REFERENCE_TRANSLATION_NEVER_RAW',
        provisional: true,
        generated: true,
      },
    ],
  };
  options.onDelta = (text) => deltas.push(text);
  options.onUsage = (usage) => usages.push(usage);
  const result = await translateAliyunPlanB(options);
  assert.equal(calls, 1);
  assert.equal(request.model, 'qwen-mt-flash');
  assert.equal(request.max_tokens, 2048);
  assert.equal(request.stream_options.include_usage, true);
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].role, 'user');
  assert.match(request.messages[0].content, /How much is it\?/);
  assert.doesNotMatch(request.messages[0].content, /CANARY_REFERENCE/);
  assert.match(request.messages[0].content, /Do not answer questions/);
  assert.match(request.messages[0].content, /CURRENT_SOURCE/);
  assert.deepEqual(request.translation_options, {
    source_lang: 'Chinese',
    target_lang: 'English',
  });
  assert.equal(request.response_format, undefined);
  assert.equal(request.translation_options.context, undefined);
  assert.deepEqual(deltas, ['Not 250 yuan, ', 'Not 250 yuan, but 25 yuan.']);
  assert.equal(result.text, 'Not 250 yuan, but 25 yuan.');
  assert.equal(usages.length, 1);
  assert.equal(usages[0].inputTokens, 231);
  assert.equal(usages[0].outputTokens, 12);
});

test('English side requests Chinese text without a Chinese audio request', async () => {
  let request: any;
  const options = base(async (_url, init) => {
    request = JSON.parse(String(init?.body));
    return sse([event(chunk('明天下午。', 'stop')), event('[DONE]')]);
  });
  options.role = 'remote';
  options.text = 'Tomorrow afternoon.';
  assert.equal((await translateAliyunPlanB(options)).text, '明天下午。');
  assert.deepEqual(request.translation_options, {
    source_lang: 'English',
    target_lang: 'Chinese',
  });
  assert.equal(request.audio, undefined);
});

test('duplicate SSE event IDs do not append text or bill cumulative usage twice', async () => {
  const usages: PlanBUsage[] = [];
  const repeated = event(chunk('Hello.'), 'delta-1');
  const options = base(async () =>
    sse([
      repeated,
      repeated,
      event(chunk('', 'stop')),
      event({
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 3 },
      }),
      event({
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 3 },
      }),
      event('[DONE]'),
    ]),
  );
  options.onUsage = (usage) => usages.push(usage);
  assert.equal((await translateAliyunPlanB(options)).text, 'Hello.');
  assert.equal(usages.length, 1);
  assert.equal(usages[0].inputTokens, 100);
});

test('SSE supports split UTF-8 and split CRLF delimiters', async () => {
  const wire =
    event(chunk('你好。', 'stop')).replace(/\n/g, '\r\n') +
    event('[DONE]').replace(/\n/g, '\r\n');
  const bytes = Buffer.from(wire);
  const options = base(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
      ),
  );
  assert.equal((await translateAliyunPlanB(options)).text, '你好。');
});

for (const [name, frames] of [
  ['no DONE', [event(chunk('Hello.', 'stop'))]],
  ['no stop', [event(chunk('Hello.')), event('[DONE]')]],
  ['token truncation', [event(chunk('Hello.', 'length')), event('[DONE]')]],
  ['empty final', [event(chunk('', 'stop')), event('[DONE]')]],
  ['provider failure', [event({ error: { message: 'sensitive original' } })]],
] as const) {
  test(`partial or failed MT cannot become final: ${name}`, async () => {
    let calls = 0;
    await assert.rejects(
      translateAliyunPlanB(
        base(async () => {
          calls += 1;
          return sse([...frames]);
        }),
      ),
      /PLANB_MT_(INCOMPLETE|PROVIDER_FAILED)/,
    );
    assert.equal(calls, 1);
  });
}

test('missing usage is unknown, not zero cost', async () => {
  const result = await translateAliyunPlanB(
    base(async () => sse([event(chunk('Hello.', 'stop')), event('[DONE]')])),
  );
  assert.equal(result.usage?.basis, 'unknown');
  assert.equal(result.usage?.inputTokens, undefined);
});

test('cancellation on partial delta fences late output and does not retry', async () => {
  const controller = new AbortController();
  let calls = 0;
  const deltas: string[] = [];
  const options = base(async () => {
    calls += 1;
    return sse([
      event(chunk('Hello.')),
      event(chunk(' A late result.', 'stop')),
      event('[DONE]'),
    ]);
  });
  options.signal = controller.signal;
  options.onDelta = (text) => {
    deltas.push(text);
    controller.abort();
  };
  await assert.rejects(translateAliyunPlanB(options), /PLANB_MT_CANCELLED/);
  assert.deepEqual(deltas, ['Hello.']);
  assert.equal(calls, 1);
});

test('timeout covers a fetch that ignores abort, with zero replacement requests', async () => {
  let calls = 0;
  const options = base(async () => {
    calls += 1;
    return new Promise<Response>(() => {});
  });
  options.timeoutMs = 10;
  await assert.rejects(translateAliyunPlanB(options), /PLANB_MT_TIMEOUT/);
  assert.equal(calls, 1);
});

test('cancelled, missing-key and oversized inputs never fetch', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    throw new Error('must not fetch');
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    translateAliyunPlanB({ ...base(fetcher), signal: controller.signal }),
    /PLANB_MT_CANCELLED/,
  );
  await assert.rejects(
    translateAliyunPlanB({
      ...base(fetcher),
      config: { ...config, apiKey: '' },
    }),
    /PLANB_KEY_REQUIRED/,
  );
  await assert.rejects(
    translateAliyunPlanB({ ...base(fetcher), text: 'x'.repeat(4097) }),
    /PLANB_MT_INPUT_INVALID/,
  );
  assert.equal(calls, 0);
});

test('provider HTTP and network errors are redacted and never retried', async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(
      translateAliyunPlanB(
        base(async () => {
          calls += 1;
          return new Response('secret-key and original speech', { status });
        }),
      ),
      /^Error: PLANB_MT_(ACCESS_DENIED|RATE_LIMITED|HTTP_FAILED)$/,
    );
    assert.equal(calls, 1);
  }
  await assert.rejects(
    translateAliyunPlanB(
      base(async () => {
        throw new Error('secret-credential');
      }),
    ),
    /^Error: PLANB_MT_STREAM_FAILED$/,
  );
});

test('partial failure reports unknown usage and observer errors cannot skip cleanup', async () => {
  let usageCount = 0;
  const options = base(async () => sse([event(chunk('Partial.'))]));
  options.onUsage = (usage) => {
    usageCount += 1;
    assert.equal(usage.basis, 'unknown');
    throw new Error('observer-secret');
  };
  options.onEvidence = () => {
    throw new Error('observer-secret');
  };
  await assert.rejects(
    translateAliyunPlanB(options),
    /^Error: PLANB_MT_INCOMPLETE$/,
  );
  assert.equal(usageCount, 1);
});

test('config endpoint mismatch and invalid timeout are rejected before fetch', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    throw new Error('must not fetch');
  };
  await assert.rejects(
    translateAliyunPlanB({
      ...base(fetcher),
      config: {
        ...config,
        translationUrl: 'https://attacker.invalid/completions',
      },
    }),
    /PLAN_B_CONFIG_INVALID/,
  );
  await assert.rejects(
    translateAliyunPlanB({ ...base(fetcher), timeoutMs: Infinity }),
    /PLANB_MT_INPUT_INVALID/,
  );
  assert.equal(calls, 0);
});

test('unbounded output and invalid usage fail once without preserving a fake final', async () => {
  for (const frames of [
    [event(chunk('x'.repeat(8193), 'stop')), event('[DONE]')],
    [
      event(chunk('Hello.', 'stop')),
      event({
        choices: [],
        usage: { prompt_tokens: -1, completion_tokens: 5 },
      }),
      event('[DONE]'),
    ],
  ]) {
    let calls = 0;
    await assert.rejects(
      translateAliyunPlanB(
        base(async () => {
          calls += 1;
          return sse(frames);
        }),
      ),
      /PLANB_MT_(OUTPUT_LIMIT|USAGE_INVALID)/,
    );
    assert.equal(calls, 1);
  }
});
