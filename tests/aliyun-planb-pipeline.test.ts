import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  setImmediate as tick,
  setTimeout as delay,
} from 'node:timers/promises';

import { createAliyunPlanBPipeline } from '../src/solo/aliyun-planb-pipeline';
import type {
  AliyunPlanBConfig,
  PlanBAsrOptions,
  PlanBAsrSource,
  PlanBTranslationOptions,
} from '../src/solo/aliyun-planb-types';
import type { TranscriptEvent } from '../src/solo/translation-bridge';

const config: AliyunPlanBConfig = {
  region: 'beijing',
  apiKey: 'offline-fake',
  asrModel: 'fun-asr-realtime',
  textModel: 'qwen-mt-flash',
  ttsModel: 'cosyvoice-v3-flash',
  voice: 'loongandy_v3',
  sampleRate: 24000,
  webSocketUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
  translationUrl:
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
};
function harness(
  role: 'local' | 'remote' = 'local',
  extras: Record<string, unknown> = {},
) {
  let asrOptions: PlanBAsrOptions;
  let aborted = 0;
  let ttsAborted = 0;
  let ttsCreated = 0;
  const translated: PlanBTranslationOptions[] = [];
  const spoken: string[] = [];
  const audio: Buffer[] = [];
  const transcripts: TranscriptEvent[] = [];
  const failures: string[] = [];
  const corrections: any[] = [];
  const pipeline = createAliyunPlanBPipeline({
    config,
    role,
    now: () => 5000,
    pauseMs: 5,
    createAsr: (options) => {
      asrOptions = options;
      return {
        ready: Promise.resolve(),
        append() {},
        async finish() {
          /* The fake has no queued provider work. */
        },
        abort() {
          aborted += 1;
        },
      };
    },
    translate: async (options) => {
      translated.push(options);
      options.onDelta?.(`draft:${options.text}`);
      return { text: `translated:${options.text}` };
    },
    createTts: () => {
      ttsCreated += 1;
      return {
        async *synthesize(text) {
          spoken.push(text);
          yield Buffer.alloc(480, 1);
        },
        abort() {
          ttsAborted += 1;
        },
      };
    },
    onTranscript: (event) => transcripts.push(event),
    onAudio: (pcm) => audio.push(Buffer.from(pcm)),
    onError: (code) => failures.push(code),
    onCorrection: (event) => corrections.push(event),
    ...extras,
  });
  const source = (
    sequence: number,
    text: string,
    final = true,
    revision = 1,
    at = sequence * 100,
  ) => {
    asrOptions.onSource({
      sequence,
      revision,
      text,
      final,
      at,
      ...(final ? { endAt: at + 20 } : {}),
    });
  };
  return {
    pipeline,
    source,
    translated,
    spoken,
    audio,
    transcripts,
    failures,
    corrections,
    asr: () => asrOptions,
    counts: () => ({ aborted, ttsAborted, ttsCreated }),
  };
}

test('Plan B freezes one guarded translation for caption and fixed-voice TTS; raw context stays ASR-only', async () => {
  const context = {
    version: 1,
    entries: [
      {
        role: 'remote' as const,
        sourceId: 'prior',
        sourceKind: 'asr' as const,
        at: 1,
        order: 1,
        observedAt: 2,
        revision: 1,
        text: 'What time?',
        provisional: false,
        generated: false,
      },
    ],
  };
  const h = harness('local', { getContext: () => context });
  await h.pipeline.ready;
  h.source(1, '时间是下午两点，不是三点。');
  await h.pipeline.finish();
  assert.equal(h.spoken.length, 1);
  const final = h.transcripts.find(
    (event) => event.kind === 'translation' && event.final,
  );
  assert.equal(h.spoken[0], final.text);
  assert.equal(h.translated.at(-1).context.entries.length, 0);
  assert.equal(h.asr().getContext().entries[0].text, 'What time?');
  assert.equal(
    h.transcripts.find((event) => event.kind === 'original' && event.final)
      .text,
    '时间是下午两点，不是三点。',
  );
  assert.equal(h.counts().ttsCreated, 1);
  assert.equal(h.failures.length, 0);
  h.pipeline.abort();
});

test('remote English produces incremental Chinese captions and never constructs TTS', async () => {
  const h = harness('remote');
  h.source(1, 'The appointment is June fifteenth.');
  await h.pipeline.finish();
  assert(
    h.transcripts.some((event) => event.kind === 'translation' && event.final),
  );
  assert.equal(h.counts().ttsCreated, 0);
  assert.equal(h.audio.length, 0);
  h.pipeline.abort();
});

test('short English fragments and pauses revise one natural section rather than finalizing each word', async () => {
  const h = harness('remote', { pauseMs: 30 });
  h.source(1, 'for the');
  await tick();
  assert(!h.transcripts.some((event) => event.final));
  h.source(2, 'connection');
  await h.pipeline.finish();
  const original = h.transcripts.filter((event) => event.kind === 'original');
  assert.equal(new Set(original.map((event) => event.utteranceId)).size, 1);
  assert.equal(original.at(-1).text, 'for the connection');
  assert.equal(original.at(-1).final, true);
  h.pipeline.abort();
});

test('partial stutters and self-correction supersede drafts; no provisional text is spoken', async () => {
  const h = harness();
  h.source(1, '金额是二百', false, 1);
  await tick();
  assert.equal(h.spoken.length, 0);
  h.source(1, '金额是二十五，不是二百五十。', true, 2);
  await h.pipeline.finish();
  assert.deepEqual(h.spoken, ['translated:金额是二十五，不是二百五十。']);
  assert.equal(
    h.transcripts.filter((event) => event.kind === 'original').at(-1).text,
    '金额是二十五，不是二百五十。',
  );
  h.pipeline.abort();
});

test('long continuous speech naturally queues several clauses in source order without cancelling prior voice', async () => {
  let release: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signals: AbortSignal[] = [];
  const output: string[] = [];
  const h = harness('local', {
    createTts: () => ({
      async *synthesize(text: string, sequence: number, signal: AbortSignal) {
        signals.push(signal);
        output.push(text);
        if (sequence === 1) await blocked;
        yield Buffer.alloc(480);
      },
      abort() {},
    }),
  });
  h.source(1, '第一句话。');
  await tick();
  h.source(2, '第二句话，金额二十五元。');
  h.source(3, '第三句话，时间下午三点。');
  await tick();
  assert.equal(signals[0].aborted, false);
  release();
  await h.pipeline.finish();
  assert.deepEqual(output, [
    'translated:第一句话。',
    'translated:第二句话，金额二十五元。',
    'translated:第三句话，时间下午三点。',
  ]);
  h.pipeline.abort();
});

test('a delayed superseded draft cannot replace a newer corrected final or trigger old TTS', async () => {
  let release: (value: { text: string }) => void;
  const first = new Promise<{ text: string }>((resolve) => {
    release = resolve;
  });
  const h = harness('local', {
    translate: (options: PlanBTranslationOptions) =>
      options.text === '十五'
        ? first
        : Promise.resolve({ text: 'Fifty, not fifteen.' }),
  });
  h.source(1, '十五', false);
  h.source(1, '五十，不是十五。', true, 2);
  release({ text: 'Fifteen.' });
  await h.pipeline.finish();
  assert.deepEqual(h.spoken, ['Fifty, not fifteen.']);
  assert(!h.transcripts.some((event) => event.text === 'Fifteen.'));
  h.pipeline.abort();
});

test('duplicate ASR revisions do not add model or synthesis requests', async () => {
  const h = harness();
  h.source(1, '你好。');
  await tick();
  const before = h.translated.length;
  h.source(1, '你好。');
  await h.pipeline.finish();
  assert.equal(h.translated.length, before);
  assert.equal(h.spoken.length, 1);
  h.pipeline.abort();
});

test('late correction after exposed audio is separate evidence and never silently rewrites or replays', async () => {
  const h = harness();
  h.source(1, '日期是六月十五日。');
  await tick();
  await tick();
  const before = h.transcripts.length;
  h.source(1, '日期是六月五日。', true, 2);
  await h.pipeline.finish();
  assert.equal(h.transcripts.length, before);
  assert.equal(h.spoken.length, 1);
  assert.equal(h.corrections.length, 1);
  assert.equal(h.corrections[0].audioExposed, true);
  assert.equal(h.corrections[0].rawText, '日期是六月五日。');
  h.pipeline.abort();
});

test('speaker change seals text but never cancels an active confirmed local synthesis', async () => {
  let release: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal: AbortSignal;
  const h = harness('local', {
    createTts: () => ({
      async *synthesize(_text: string, _sequence: number, token: AbortSignal) {
        signal = token;
        await wait;
        yield Buffer.alloc(480);
      },
      abort() {},
    }),
  });
  h.source(1, '请保持这句翻译。');
  await tick();
  h.pipeline.breakSection();
  assert.equal(signal.aborted, false);
  release();
  await h.pipeline.finish();
  h.pipeline.abort();
});

test('hangup fences late ASR and model completions and releases ASR/TTS resources', async () => {
  let release: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness('local', {
    createTts: () => ({
      async *synthesize() {
        await wait;
        yield Buffer.alloc(480);
      },
      abort() {
        release();
      },
    }),
  });
  h.source(1, '你好。');
  await tick();
  h.pipeline.abort();
  h.source(2, '这是迟到事件。');
  await tick();
  assert.equal(h.audio.length, 0);
  assert.equal(h.counts().aborted, 1);
  assert.equal(h.failures.length, 0);
});

test('actual supplier failure is fatal and performs no alternate provider request', async () => {
  const h = harness('local', {
    translate: async () => {
      throw new Error('secret must not escape');
    },
  });
  h.source(1, '你好。');
  await tick();
  assert.deepEqual(h.failures, ['PLANB_PIPELINE_PROVIDER_FAILED']);
  assert.equal(h.counts().aborted, 1);
  assert.equal(h.counts().ttsCreated, 0);
  h.source(2, '迟到。');
  assert.equal(h.failures.length, 1);
});

test('playback ACK must match exact source and may arrive synchronously at audio completion', async () => {
  let complete: string;
  const h = harness('local', {
    waitForPlayback: true,
    onAudioComplete: (metadata: any) => {
      complete = metadata.utteranceId;
      assert.equal(h.pipeline.acknowledgeAudio('wrong-source'), false);
      assert.equal(h.pipeline.acknowledgeAudio(metadata.utteranceId), true);
    },
  });
  h.source(1, '你好。');
  await h.pipeline.finish();
  assert(complete);
  assert.equal(h.pipeline.acknowledgeAudio(complete), false);
  h.pipeline.abort();
});

test('missing playback acknowledgement triggers bounded cleanup without a total call limit', async () => {
  const h = harness('local', { waitForPlayback: true, timeoutMs: 10 });
  h.source(1, '你好。');
  const finish = h.pipeline.finish();
  await delay(20);
  await assert.rejects(finish, /PLANB_PLAYBACK_UNCONFIRMED/);
  assert.deepEqual(h.failures, ['PLANB_PLAYBACK_UNCONFIRMED']);
});

test('conflicting same-version ASR is rejected and old revisions cannot seize newer text', async () => {
  const h = harness('remote');
  h.source(1, 'newer draft', false, 2);
  h.source(1, 'old draft', false, 1);
  assert(!h.transcripts.some((event) => event.text === 'old draft'));
  h.source(1, 'conflicting draft', false, 2);
  assert.deepEqual(h.failures, ['PLANB_ASR_SOURCE_CONFLICT']);
});

test('empty context remains empty, numeric source is neither guessed nor replaced by a reference answer', async () => {
  const h = harness('remote');
  h.source(1, 'Two fifty. This is earlier test.');
  await h.pipeline.finish();
  assert.equal(h.translated[0].context.entries.length, 0);
  assert(h.translated.some((request) => request.text.includes('Two fifty.')));
  assert(
    !h.translated.some((request) => request.text.includes('June fifteenth')),
  );
  h.pipeline.abort();
});

test('invalid or oversized recognition payload stops with fixed safe errors', async () => {
  const h = harness();
  h.asr().onSource({
    sequence: 1,
    revision: 1,
    text: 'x'.repeat(4097),
    final: true,
    at: 1,
  } as PlanBAsrSource);
  assert.deepEqual(h.failures, ['PLANB_ASR_INVALID_SOURCE']);
  assert.equal(h.counts().ttsCreated, 0);
});

test('a known earlier unfinished source reserves playback order when a later source final arrives first', async () => {
  const h = harness();
  h.source(1, '第一', false);
  h.source(2, '第二句。', true);
  await tick();
  await tick();
  assert.equal(h.spoken.length, 0);
  h.source(1, '第一句。', true, 2);
  await h.pipeline.finish();
  assert.deepEqual(h.spoken, ['translated:第一句。', 'translated:第二句。']);
  assert.equal(h.failures.length, 0);
  h.pipeline.abort();
});

test('an earlier source that never finalizes fails cleanup rather than speaking a later sentence first', async () => {
  const h = harness('local', { timeoutMs: 10 });
  h.source(1, '未完成的较早来源', false);
  h.source(2, '不得先说后一句。', true);
  const finish = h.pipeline.finish();
  await delay(20);
  await assert.rejects(finish, /PLANB_SOURCE_ORDER_UNRESOLVED/);
  assert.equal(h.spoken.length, 0);
  assert.deepEqual(h.failures, ['PLANB_SOURCE_ORDER_UNRESOLVED']);
});

test('rapid partials update original captions without sending provisional raw or model deltas to speech', async () => {
  const h = harness();
  h.source(1, '第一', false, 1);
  await tick();
  h.source(1, '第一部分', false, 2);
  h.source(1, '第一部分仍在更正', false, 3);
  await tick();
  assert.equal(h.translated.length, 0);
  assert.equal(
    h.transcripts.filter((event) => event.kind === 'translation').length,
    0,
  );
  h.source(1, '更正完成，金额五十元。', true, 4);
  await h.pipeline.finish();
  assert.equal(h.translated.length, 1);
  assert.deepEqual(
    h.translated.map((request) => request.sequence),
    [1],
  );
  assert.deepEqual(h.spoken, ['translated:更正完成，金额五十元。']);
  h.pipeline.abort();
});

test('empty final ASR withdraws a draft, clears translated text and writes a raw-context tombstone', async () => {
  const observations: any[] = [];
  const h = harness('local', {
    onSource: (event: any) => observations.push(event),
  });
  h.source(1, '你好', false);
  await tick();
  assert.equal(h.translated.length, 0);
  assert.equal(
    h.transcripts.filter((event) => event.kind === 'translation').length,
    0,
  );
  h.source(1, '', true, 2);
  await h.pipeline.finish();
  const originals = h.transcripts.filter((event) => event.kind === 'original');
  const translations = h.transcripts.filter(
    (event) => event.kind === 'translation',
  );
  assert.equal(originals.at(-1).text, '');
  assert.equal(originals.at(-1).final, true);
  assert.equal(translations.at(-1).text, '');
  assert.equal(observations.at(-1).text, '');
  assert.equal(observations.at(-1).final, true);
  assert.equal(h.spoken.length, 0);
  h.pipeline.abort();
});

test('empty withdrawal before the first audio cancels confirmed pending synthesis without speaking stale text', async () => {
  let release: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness('local', {
    createTts: () => ({
      async *synthesize() {
        await wait;
        yield Buffer.alloc(480);
      },
      abort() {
        release();
      },
    }),
  });
  h.source(1, '你好。');
  await tick();
  h.source(1, '', true, 2);
  release();
  await h.pipeline.finish();
  assert.equal(h.audio.length, 0);
  assert.equal(
    h.transcripts.filter((event) => event.kind === 'original').at(-1).text,
    '',
  );
  assert.equal(
    h.transcripts.filter((event) => event.kind === 'translation').at(-1).text,
    '',
  );
  h.pipeline.abort();
});

test('withdrawal after exposed audio preserves the frozen snapshot and emits explicit separate correction evidence', async () => {
  const h = harness();
  h.source(1, '你好。');
  await tick();
  await tick();
  const before = h.transcripts.length;
  h.source(1, '', true, 2);
  await h.pipeline.finish();
  assert.equal(h.transcripts.length, before);
  assert.equal(h.corrections[0].audioExposed, true);
  assert.equal(h.corrections[0].rawText, '');
  assert.equal(h.spoken.length, 1);
  h.pipeline.abort();
});

test('only validated same-role source-target pairs become bounded translation memory; current raw stays isolated', async () => {
  const h = harness('local', {
    translate: async (options: any) => {
      h.translated.push(options);
      return {
        text:
          options.text === '金额二十五元。'
            ? 'The amount is twenty-five yuan.'
            : 'Correction: fifty yuan, not twenty-five yuan.',
      };
    },
  });
  h.source(1, '金额二十五元。');
  await tick();
  await tick();
  h.source(2, '更正，五十元，不是二十五元。');
  await h.pipeline.finish();
  assert.equal(h.translated.length, 2);
  const current: any = h.translated[1];
  assert.equal(current.text, '更正，五十元，不是二十五元。');
  assert.equal(current.context.entries.length, 0);
  assert.equal(current.translationMemory.length, 1);
  assert.equal(current.translationMemory[0].source, '金额二十五元。');
  assert.equal(
    current.translationMemory[0].target,
    'The amount is twenty-five yuan.',
  );
  assert.equal(current.translationMemory[0].role, 'local');
  assert.deepEqual(current.currentSourceIds, [2]);
  assert.deepEqual(h.spoken, [
    'The amount is twenty-five yuan.',
    'Correction: fifty yuan, not twenty-five yuan.',
  ]);
  h.pipeline.abort();
});

test('JSON, fenced, meta and history-wrapper model bodies fail without final captions, unpacking or TTS', async () => {
  for (const text of [
    '{"translation":"Hello."}',
    '["Hello."]',
    '"Hello."',
    '```text\nHello.\n```',
    'Here is the translation: Hello.',
    'RECENT_RAW_CONTEXT: old CURRENT_SOURCE: new',
  ]) {
    const h = harness('local', { translate: async () => ({ text }) });
    h.source(1, '你好。');
    // eslint-disable-next-line no-await-in-loop -- Each rejected model body owns an isolated pipeline.
    await assert.rejects(h.pipeline.finish(), /PLANB_CURRENT_TRANSLATION_/);
    assert.equal(h.audio.length, 0);
    assert.equal(h.counts().ttsCreated, 0);
    assert.equal(
      h.transcripts.filter((event) => event.kind === 'translation').length,
      0,
    );
    h.pipeline.abort();
  }
});

test('a legitimate repeated source in a new utterance and following correction all remain audible', async () => {
  const h = harness('local', {
    translate: async (options: any) => {
      h.translated.push(options);
      return {
        text:
          options.text === '不要取消预约。'
            ? 'Do not cancel the appointment.'
            : 'Correction: cancel the appointment.',
      };
    },
  });
  h.source(1, '不要取消预约。');
  await tick();
  h.source(2, '不要取消预约。');
  await tick();
  h.source(3, '更正，取消预约。');
  await h.pipeline.finish();
  assert.deepEqual(h.spoken, [
    'Do not cancel the appointment.',
    'Do not cancel the appointment.',
    'Correction: cancel the appointment.',
  ]);
  assert.deepEqual(
    h.translated.map((entry: any) => entry.currentSourceIds),
    [[1], [2], [3]],
  );
  h.pipeline.abort();
});

test('same ASR source splitting into identical natural subsections is not mistaken for a request replay', async () => {
  const h = harness('local', {
    translate: async () => ({ text: 'Please do not cancel.' }),
  });
  h.source(1, 'Please do not cancel. Please do not cancel.');
  await h.pipeline.finish();
  assert.deepEqual(h.spoken, [
    'Please do not cancel.',
    'Please do not cancel.',
  ]);
  assert.deepEqual(h.failures, []);
  h.pipeline.abort();
});

test('timing separates provider endpoint estimate, actual final arrival, translation and first PCM; no body leaves observers', async () => {
  let clock = 1000;
  const timings: any[] = [];
  const h = harness('local', {
    now: () => clock,
    onTiming: (event: any) => timings.push(event),
    translate: async () => {
      clock = 1800;
      return { text: 'Do not charge twice.' };
    },
    createTts: () => ({
      async *synthesize() {
        clock = 2100;
        yield Buffer.alloc(480);
      },
      abort() {},
    }),
  });
  h.source(1, '不要重复收费。', true, 1, 500);
  await h.pipeline.finish();
  assert.deepEqual(
    timings.map((event) => [event.stage, event.at, event.basis]),
    [
      ['provider_endpoint_estimate', 520, 'provider_stream_estimate'],
      ['asr_final', 1000, 'application_observed'],
      ['section_ready', 1000, 'application_observed'],
      ['translation_start', 1000, 'application_observed'],
      ['translation_complete', 1800, 'application_observed'],
      ['synthesis_start', 1800, 'application_observed'],
      ['audio_first_sample', 2100, 'application_observed'],
    ],
  );
  assert(
    timings.every(
      (event) =>
        event.utteranceId === timings[0].utteranceId &&
        event.sourceRevision === timings[0].sourceRevision &&
        event.sessionEpoch === 1 &&
        event.sourceIds[0] === 1,
    ),
  );
  assert(!JSON.stringify(timings).includes('不要'));
  assert(!JSON.stringify(timings).includes('charge'));
  assert(!timings.some((event) => event.stage === 'playback_start'));
  h.pipeline.abort();
});

test('long provisional source waits visibly without fabricating speech, while confirmed natural clauses start before speaker-block completion', async () => {
  const h = harness();
  h.source(1, '尚未完成'.repeat(60), false, 1);
  await tick();
  assert.equal(h.translated.length, 0);
  assert.equal(h.spoken.length, 0);
  assert(h.transcripts.at(-1).text.length > 200);
  h.source(1, '第一段已经完成。', true, 2);
  await tick();
  await tick();
  assert.equal(h.spoken.length, 1);
  h.source(2, '第二段仍然说话', false);
  await tick();
  assert.equal(h.spoken.length, 1);
  h.source(2, '第二段也已完成。', true, 2);
  await h.pipeline.finish();
  assert.equal(h.spoken.length, 2);
  h.pipeline.abort();
});

test('phone current-source pipeline rejects non-Beijing selection before constructing any supplier clients', () => {
  let constructed = 0;
  assert.throws(
    () =>
      harness('local', {
        config: { ...config, region: 'singapore' },
        createAsr() {
          constructed += 1;
          throw new Error('must not run');
        },
      }),
    /PLANB_PIPELINE_REGION_UNSUPPORTED/,
  );
  assert.equal(constructed, 0);
});

test('known history sentence prefixed to a new translation is rejected whole; no stripping, replay or retry', async () => {
  let requests = 0;
  const h = harness('local', {
    translate: async () => {
      requests += 1;
      return {
        text:
          requests === 1
            ? 'The appointment is June fifteenth.'
            : 'The appointment is June fifteenth. Do not charge twice.',
      };
    },
  });
  h.source(1, '预约六月十五日。');
  await tick();
  await tick();
  assert.deepEqual(h.spoken, ['The appointment is June fifteenth.']);
  h.source(2, '不要重复收费。');
  await assert.rejects(
    h.pipeline.finish(),
    /PLANB_CURRENT_TRANSLATION_HISTORY_REPLAY_SUSPECT/,
  );
  assert.equal(requests, 2);
  assert.deepEqual(h.spoken, ['The appointment is June fifteenth.']);
  assert.equal(
    h.transcripts.filter((event) => event.kind === 'translation' && event.final)
      .length,
    1,
  );
  assert.deepEqual(h.failures, [
    'PLANB_CURRENT_TRANSLATION_HISTORY_REPLAY_SUSPECT',
  ]);
});

test('a speaker explicitly repeating historical source before a correction is preserved, even when translation begins with that old sentence', async () => {
  let requests = 0;
  const h = harness('local', {
    translate: async () => {
      requests += 1;
      return {
        text:
          requests === 1
            ? 'The appointment is June fifteenth.'
            : 'The appointment is June fifteenth. Correction: June sixteenth, not June fifteenth.',
      };
    },
  });
  h.source(1, '预约六月十五日。');
  await tick();
  await tick();
  h.source(2, '预约六月十五日。更正，是六月十六日，不是十五日。');
  await h.pipeline.finish();
  assert.equal(requests, 2);
  assert.equal(h.spoken.length, 2);
  assert.equal(
    h.spoken[1],
    'The appointment is June fifteenth. Correction: June sixteenth, not June fifteenth.',
  );
  assert.deepEqual(h.failures, []);
  h.pipeline.abort();
});

test('withdrawing one ASR source retires every unexposed natural subsection and cannot request or speak the stale tail', async () => {
  let release: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spoken: string[] = [];
  const h = harness('local', {
    createTts: () => ({
      async *synthesize(text: string) {
        spoken.push(text);
        await blocked;
        yield Buffer.alloc(480);
      },
      abort() {
        release();
      },
    }),
  });
  h.source(1, 'Please do not cancel. Please do not cancel.');
  await tick();
  assert.equal(h.translated.length, 1);
  h.source(1, '', true, 2);
  release();
  await h.pipeline.finish();
  assert.equal(h.translated.length, 1);
  assert.equal(spoken.length, 1);
  assert.equal(h.audio.length, 0);
  for (const kind of ['original', 'translation']) {
    const tombstones = h.transcripts.filter(
      (event) => event.kind === kind && event.final && event.text === '',
    );
    assert.equal(tombstones.length, 2);
    assert.equal(new Set(tombstones.map((event) => event.utteranceId)).size, 2);
  }
  assert.deepEqual(h.failures, []);
  h.pipeline.abort();
});

test('withdrawal freezes an already exposed subsection, clears every unexposed tail and removes that source from future TM', async () => {
  let release: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const h = harness('local', {
    createTts: () => ({
      async *synthesize() {
        calls += 1;
        if (calls === 2) await blocked;
        yield Buffer.alloc(480);
      },
      abort() {
        release();
      },
    }),
  });
  h.source(1, 'Please do not cancel. Please do not cancel.');
  await tick();
  await tick();
  assert.equal(h.audio.length, 1);
  assert.equal(h.translated.length, 2);
  const firstId = h.transcripts.find(
    (event) => event.kind === 'translation' && event.final,
  ).utteranceId;
  h.source(1, '', true, 2);
  release();
  await tick();
  await tick();
  assert.equal(h.audio.length, 1);
  assert.equal(h.corrections.length, 1);
  assert.equal(h.corrections[0].utteranceId, firstId);
  assert.equal(h.corrections[0].audioExposed, true);
  assert(
    !h.transcripts.some(
      (event) => event.utteranceId === firstId && event.text === '',
    ),
  );
  assert(
    h.transcripts.some(
      (event) =>
        event.kind === 'original' &&
        event.final &&
        event.text === '' &&
        event.utteranceId !== firstId,
    ),
  );
  h.source(2, '这是新的真实句子。');
  await h.pipeline.finish();
  assert.equal(h.translated.length, 3);
  assert.equal((h.translated[2] as any).translationMemory.length, 0);
  assert.equal(h.audio.length, 2);
  h.pipeline.abort();
});

test('an exposed source withdrawn while audio is draining cannot resurrect translation memory on late completion', async () => {
  let release: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const h = harness('local', {
    createTts: () => ({
      async *synthesize() {
        calls += 1;
        yield Buffer.alloc(480);
        if (calls === 1) await blocked;
      },
      abort() {
        release();
      },
    }),
  });
  h.source(1, '这句话稍后撤回。');
  await tick();
  assert.equal(h.audio.length, 1);
  h.source(1, '', true, 2);
  h.source(2, '这是一句新的有效原文。');
  release();
  await h.pipeline.finish();
  assert.equal(h.audio.length, 2);
  assert.equal(h.corrections.length, 1);
  assert.equal(h.corrections[0].audioExposed, true);
  assert.equal(h.translated.length, 2);
  assert.equal((h.translated[1] as any).translationMemory.length, 0);
  assert.deepEqual(h.failures, []);
  h.pipeline.abort();
});

test('withdrawal reentered by audio-completion observer cannot republish an exposed source into TM', async () => {
  const h = harness('local', {
    onAudioComplete: () => {
      if (h.translated.length === 1) h.source(1, '', true, 2);
    },
  });
  h.source(1, '观察者撤回这句。');
  await tick();
  await tick();
  assert.equal(h.audio.length, 1);
  h.source(2, '随后这句保持有效。');
  await h.pipeline.finish();
  assert.equal(h.translated.length, 2);
  assert.equal((h.translated[1] as any).translationMemory.length, 0);
  assert.equal(h.corrections.length, 1);
  assert.equal(h.audio.length, 2);
  assert.deepEqual(h.failures, []);
  h.pipeline.abort();
});
