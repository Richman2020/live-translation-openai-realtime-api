import { assertAliyunPlanBConfig } from './aliyun-planb-config';
import { createPlanBFetch } from './aliyun-planb-network';
import { translateAliyunPlanB } from './aliyun-planb-translation';
import { assertCurrentTranslationGuard } from './aliyun-planb-translation-guard';
import type {
  CurrentTranslationGuard,
  CurrentTranslationMemory,
} from './aliyun-planb-translation-guard';
import type {
  PlanBTranslationOptions,
  PlanBTranslationResult,
} from './aliyun-planb-types';

export const ALIYUN_CURRENT_TRANSLATION_LIMITS = Object.freeze({
  sourceCharacters: 4096,
  memoryPairs: 6,
  memoryCharacters: 1600,
  memorySourceCharacters: 600,
  outputMaxTokens: 2048,
});

/**
 * Official API: https://help.aliyun.com/zh/model-studio/qwen-mt-api
 * Feature: https://help.aliyun.com/zh/model-studio/machine-translation
 * tm_list contains source/target sentence pairs. It is translation memory,
 * not a multi-turn chat or a source-only conversation-history parameter.
 * Its style/consistency benefit does not guarantee conversational reasoning.
 * domains is an English domain/style hint; no raw history is put there.
 * The limits above are local bounds, not documented provider pair/token caps.
 */
export type CurrentTranslationOptions = PlanBTranslationOptions & {
  translationMemory?: readonly CurrentTranslationMemory[];
  currentSourceIds?: readonly number[];
  translationGuard?: CurrentTranslationGuard;
};
export type CurrentTranslationResult = PlanBTranslationResult & {
  /** Exact cumulative SSE content, before the reused parser trims its text. */
  rawText: string;
  memory: {
    mode: 'official_tm_list';
    origin: 'prior_validated_current_call_translation';
    sourceIds: number[];
    pairs: number;
    omittedPairs: number;
  };
};

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const fixedError = (suffix: string): never => {
  throw new Error(`PLANB_CURRENT_MT_${suffix}`);
};
const validIds = (ids: readonly number[]) =>
  Array.isArray(ids) &&
  ids.length > 0 &&
  ids.every(
    (id, index) => positiveInteger(id) && (index === 0 || id > ids[index - 1]),
  );

/**
 * One current source is the only user message. Optional prior real
 * source/validated-translation pairs use the documented tm_list field. No
 * prompt envelope, source-only history, terms, domains, or external answers
 * are silently converted into translation memory.
 */
export async function translateAliyunCurrentSource(
  options: CurrentTranslationOptions,
): Promise<CurrentTranslationResult> {
  const config = Object.freeze({ ...options.config });
  assertAliyunPlanBConfig(config);
  const { role } = options;
  if (
    config.region !== 'beijing' ||
    !['local', 'remote'].includes(role) ||
    typeof options.text !== 'string' ||
    !options.text.trim() ||
    options.text.length > ALIYUN_CURRENT_TRANSLATION_LIMITS.sourceCharacters ||
    !options.context ||
    !Array.isArray(options.context.entries) ||
    !positiveInteger(options.sequence) ||
    (options.currentSourceIds !== undefined &&
      !validIds(options.currentSourceIds))
  )
    fixedError('INPUT_INVALID');
  const memory = options.translationMemory ?? [];
  if (!Array.isArray(memory)) fixedError('MEMORY_INVALID');
  if (options.translationGuard)
    assertCurrentTranslationGuard(options.translationGuard);
  if (
    memory.length &&
    (!validIds(options.currentSourceIds ?? []) || !options.translationGuard)
  )
    fixedError('MEMORY_INVALID');
  // A legacy source-only context is not silently discarded. The pipeline must
  // explicitly supply current-run translations through the new typed port.
  if (options.context.entries.length && !memory.length)
    fixedError('MEMORY_REQUIRED');
  const seenIds = new Set<number>();
  let previousSequence = 0;
  for (const pair of memory) {
    try {
      options.translationGuard!.assertMemory(pair);
    } catch {
      fixedError('MEMORY_INVALID');
    }
    if (
      !pair ||
      pair.origin !== 'prior_validated_current_call_translation' ||
      pair.role !== role ||
      !positiveInteger(pair.sequence) ||
      pair.sequence <= previousSequence ||
      pair.sequence >= options.sequence ||
      !validIds(pair.sourceIds) ||
      pair.sourceIds.some(
        (id) =>
          seenIds.has(id) ||
          (options.currentSourceIds !== undefined &&
            id >= options.currentSourceIds[0]),
      ) ||
      typeof pair.source !== 'string' ||
      !pair.source.trim() ||
      pair.source.length > 4096 ||
      typeof pair.target !== 'string' ||
      !pair.target.trim() ||
      pair.target.length > 8192
    )
      fixedError('MEMORY_INVALID');
    previousSequence = pair.sequence;
    pair.sourceIds.forEach((id) => seenIds.add(id));
  }
  // Freeze exact strings before transport or callbacks can mutate the caller's
  // memory. Keep only complete recent pairs; never slice a number or sentence.
  const selected: CurrentTranslationMemory[] = [];
  let characters = 0;
  for (const pair of [...memory].reverse()) {
    const size = pair.source.length + pair.target.length;
    if (
      selected.length < ALIYUN_CURRENT_TRANSLATION_LIMITS.memoryPairs &&
      pair.source.length <=
        ALIYUN_CURRENT_TRANSLATION_LIMITS.memorySourceCharacters &&
      characters + size <= ALIYUN_CURRENT_TRANSLATION_LIMITS.memoryCharacters
    ) {
      selected.push({ ...pair, sourceIds: [...pair.sourceIds] });
      characters += size;
    }
  }
  selected.reverse();
  const source = options.text;
  const memoryReport: CurrentTranslationResult['memory'] = {
    mode: 'official_tm_list',
    origin: 'prior_validated_current_call_translation',
    sourceIds: selected.flatMap((pair) => [...pair.sourceIds]),
    pairs: selected.length,
    omittedPairs: memory.length - selected.length,
  };
  const transport = options.fetch ?? createPlanBFetch(config);
  let rawText = '';
  const translated = await translateAliyunPlanB({
    ...options,
    config,
    role,
    // Prevent the reused production prompt builder from reading raw history.
    // Its prompt is then replaced completely at the sole fetch boundary.
    context: { version: 0, entries: [] },
    onDelta: (text) => {
      rawText = text;
      options.onDelta?.(text);
    },
    fetch: async (input, init) => {
      const requestBody = init?.body;
      if (typeof requestBody !== 'string') return fixedError('REQUEST_INVALID');
      const body = JSON.parse(requestBody);
      if (
        body.model !== 'qwen-mt-flash' ||
        body.max_tokens !== 2048 ||
        body.stream !== true ||
        body.stream_options?.include_usage !== true
      )
        fixedError('REQUEST_INVALID');
      return transport(input, {
        ...init,
        body: JSON.stringify({
          model: 'qwen-mt-flash',
          messages: [{ role: 'user', content: source }],
          translation_options: {
            source_lang: role === 'local' ? 'Chinese' : 'English',
            target_lang: role === 'local' ? 'English' : 'Chinese',
            ...(selected.length
              ? {
                  tm_list: selected.map((pair) => ({
                    source: pair.source,
                    target: pair.target,
                  })),
                }
              : {}),
          },
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: 2048,
        }),
      });
    },
  });
  return { ...translated, rawText, memory: memoryReport };
}
