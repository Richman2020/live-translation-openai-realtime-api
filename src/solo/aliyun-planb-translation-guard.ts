import { createHash } from 'node:crypto';

import type { TranslationRole } from './translation-bridge';

export type CurrentTranslationJob = {
  sequence: number;
  sourceIds: number[];
  raw: string;
};
export type CurrentTranslationReceipt = Readonly<{
  role: TranslationRole;
  contract: 'aliyun-current-plain-text-v2';
  jobSequence: number;
  requestSequence: number;
  sourceIds: readonly number[];
  sourceSha256: string;
  rawModelText: string;
  ttsText: string;
}>;
export type CurrentTranslationTextInspection = {
  accepted: boolean;
  code: string | null;
  text: string | null;
  bodyKind: string;
};

const CONTRACT = 'aliyun-current-plain-text-v2' as const;
const MAX_OUTPUT = 8192;
const receiptKeys = Object.freeze([
  'role',
  'contract',
  'jobSequence',
  'requestSequence',
  'sourceIds',
  'sourceSha256',
  'rawModelText',
  'ttsText',
]);
const errorCode = (reason: string) => `PLANB_CURRENT_TRANSLATION_${reason}`;
const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const sha256 = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * A conservative syntax gate, not proof of translation meaning or accuracy.
 * Meta prefixes are heuristics: arbitrary natural-language explanations cannot
 * be formally distinguished from quoted speech by this local inspection.
 * Rejected text is never repaired, unpacked, or stripped into speakable text.
 */
export function inspectCurrentTranslationText(
  raw: unknown,
): CurrentTranslationTextInspection {
  const reject = (
    reason: string,
    bodyKind: string,
  ): CurrentTranslationTextInspection => ({
    accepted: false,
    code: errorCode(reason),
    text: null,
    bodyKind,
  });
  if (typeof raw !== 'string') return reject('BODY_TYPE', 'invalid');
  if (raw.length > MAX_OUTPUT) return reject('BODY_LIMIT', 'oversize');
  // CR, LF and TAB remain ordinary text whitespace. Other control/format
  // characters cannot conceal a wrapper from the following syntax checks.
  // eslint-disable-next-line no-control-regex -- Reject hidden controls rather than cleaning a model wrapper.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}]/u.test(raw))
    return reject('BODY_CONTROL', 'control_char');
  const text = raw.trim();
  if (!text) return reject('EMPTY', 'empty');
  if (/```|~~~/u.test(text)) return reject('BODY_FENCE', 'fenced_code');
  if (/\b(?:RECENT_RAW_CONTEXT|CURRENT_SOURCE)\b/iu.test(text))
    return reject('BODY_RESERVED', 'reserved_wrapper');
  try {
    const parsed: unknown = JSON.parse(text);
    // Bare numbers can be genuine spoken amounts or dates. Preserve the
    // exact string; never convert through the parsed numeric value.
    if (typeof parsed !== 'number') {
      let kind = 'json_literal';
      if (typeof parsed === 'string') kind = 'json_string';
      else if (Array.isArray(parsed)) kind = 'json_array';
      else if (parsed !== null && typeof parsed === 'object')
        kind = 'json_object';
      return reject('BODY_JSON', kind);
    }
  } catch {
    /* Plain speech usually is not JSON. */
  }
  if (/^(?:true|false|null)$/iu.test(text))
    return reject('BODY_JSON', 'json_literal');
  if (/^[{["]/u.test(text))
    return reject('BODY_JSON_FRAGMENT', 'json_fragment');
  if (/^(?:'[^]*'|“[^]*”|‘[^]*’)$/u.test(text))
    return reject('BODY_JSON', 'json_string');
  if (/^<(?:\?xml\b|!DOCTYPE\b|\/?[A-Za-z][^>]*>)/iu.test(text))
    return reject('BODY_STRUCTURE', 'structured_markup');
  if (
    /^(?:(?:here(?:['’]s| is)|below is)\s+(?:(?:the|a|an)\s+)?(?:(?:English|Chinese|Mandarin)\s+)?translation\b|(?:the\s+)?(?:(?:English|Chinese|Mandarin)\s+)?translation\s*(?::|：|is\b)|(?:translated text|translated version|English|Chinese|Mandarin|中文|英文|assistant|system|user|note|explanation|analysis|reasoning|answer|response)\s*[:：]|(?:sure|certainly|of course)[,!:.\s]+(?:here\b|the\s+translation\b)|as\s+an?\s+(?:AI|language model)\b|(?:以下是|下面是).{0,12}(?:翻译|译文)|(?:英文翻译|中文翻译|翻译|译文|说明|解释|注释|分析)\s*(?:[:：]|如下))/iu.test(
      text,
    )
  )
    return reject('BODY_META_PREFIX', 'meta_prefix');
  return { accepted: true, code: null, text, bodyKind: 'plain_text_candidate' };
}

function snapshotJob(job: CurrentTranslationJob): CurrentTranslationJob {
  try {
    if (!job || typeof job !== 'object') throw new Error();
    const { sequence, raw, sourceIds: ids } = job;
    if (
      !positiveInteger(sequence) ||
      typeof raw !== 'string' ||
      !raw.trim() ||
      raw.length > 4096 ||
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 512
    )
      throw new Error();
    const sourceIds = [...ids];
    if (
      !sourceIds.every(
        (id, index) =>
          positiveInteger(id) && (index === 0 || id > sourceIds[index - 1]),
      )
    )
      throw new Error();
    return { sequence, sourceIds, raw };
  } catch {
    throw new Error(errorCode('JOB_INVALID'));
  }
}

/** Real source/target pairs issued only after this call commits its receipt. */
export type CurrentTranslationMemory = Readonly<{
  origin: 'prior_validated_current_call_translation';
  role: TranslationRole;
  sequence: number;
  sourceIds: readonly number[];
  source: string;
  target: string;
}>;
export type CurrentTranslationGuard = Readonly<{
  issue(
    job: CurrentTranslationJob,
    requestSequence: number,
    rawModelText: string,
    history?: readonly CurrentTranslationMemory[],
  ): CurrentTranslationReceipt;
  assert(value: unknown, job: CurrentTranslationJob): CurrentTranslationReceipt;
  consume(
    value: unknown,
    job: CurrentTranslationJob,
  ): CurrentTranslationReceipt;
  toMemory(
    value: unknown,
    job: CurrentTranslationJob,
  ): CurrentTranslationMemory;
  assertMemory(value: unknown): CurrentTranslationMemory;
}>;

/**
 * This issuer is private to one role in one call. A copied, cross-call or
 * cross-role receipt/memory cannot authorize audio or become provider memory.
 * It proves local provenance and syntax, never model semantic correctness.
 */
const guards = new WeakSet<object>();

export function assertCurrentTranslationGuard(
  value: unknown,
): asserts value is CurrentTranslationGuard {
  if (!value || typeof value !== 'object' || !guards.has(value))
    throw new Error(errorCode('GUARD_UNISSUED'));
}

export function createCurrentTranslationGuard(
  role: TranslationRole,
): CurrentTranslationGuard {
  if (role !== 'local' && role !== 'remote')
    throw new Error(errorCode('ROLE_INVALID'));
  let lastIssuedRequest = 0;
  const consumedJobs = new Set<number>();
  let retiredConsumedJob = 0;
  const issued = new WeakSet<object>();
  const consumed = new WeakSet<object>();
  const originalSources = new WeakMap<object, string>();
  const memories = new WeakSet<object>();
  const memoryForReceipt = new WeakMap<object, CurrentTranslationMemory>();
  const assert = (
    value: unknown,
    job: CurrentTranslationJob,
  ): CurrentTranslationReceipt => {
    const source = snapshotJob(job);
    if (!value || typeof value !== 'object')
      throw new Error(errorCode('RECEIPT_INVALID'));
    // Identity must be checked before reading any untrusted getter/proxy.
    if (!issued.has(value)) throw new Error(errorCode('RECEIPT_UNISSUED'));
    const receipt = value as CurrentTranslationReceipt;
    const keys = Reflect.ownKeys(receipt);
    if (
      keys.length !== receiptKeys.length ||
      !keys.every(
        (key) => typeof key === 'string' && receiptKeys.includes(key),
      ) ||
      !Object.isFrozen(receipt) ||
      !Object.isFrozen(receipt.sourceIds) ||
      receipt.role !== role ||
      receipt.contract !== CONTRACT ||
      !positiveInteger(receipt.jobSequence) ||
      !positiveInteger(receipt.requestSequence) ||
      !/^[a-f0-9]{64}$/u.test(receipt.sourceSha256)
    )
      throw new Error(errorCode('RECEIPT_INVALID'));
    const inspection = inspectCurrentTranslationText(receipt.rawModelText);
    if (!inspection.accepted || receipt.ttsText !== inspection.text)
      throw new Error(errorCode('RECEIPT_INVALID'));
    if (
      receipt.jobSequence !== source.sequence ||
      receipt.sourceSha256 !== sha256(source.raw) ||
      originalSources.get(receipt) !== source.raw ||
      receipt.sourceIds.length !== source.sourceIds.length ||
      !receipt.sourceIds.every((id, index) => id === source.sourceIds[index])
    )
      throw new Error(errorCode('RECEIPT_JOB_MISMATCH'));
    return receipt;
  };
  const guard: CurrentTranslationGuard = Object.freeze({
    issue(
      job: CurrentTranslationJob,
      requestSequence: number,
      rawModelText: string,
      history: readonly CurrentTranslationMemory[] = [],
    ) {
      const source = snapshotJob(job);
      if (
        !positiveInteger(requestSequence) ||
        requestSequence <= lastIssuedRequest
      )
        throw new Error(errorCode('REQUEST_INVALID'));
      const inspection = inspectCurrentTranslationText(rawModelText);
      if (!inspection.accepted) throw new Error(inspection.code!);
      if (!Array.isArray(history) || history.length > 6)
        throw new Error(errorCode('MEMORY_INVALID'));
      for (const pair of history) {
        if (!pair || typeof pair !== 'object' || !memories.has(pair))
          throw new Error(errorCode('MEMORY_UNISSUED'));
      }
      // Fail closed only on an exact, complete known-history prefix with new
      // content, or a complete multi-pair replay. A single identical target
      // alone is allowed: a different current source can be a true synonym.
      // This is conservative syntax evidence, not a semantic classifier. Never
      // remove a prefix and speak the remainder; surface the entire failure.
      const speech = inspection.text!;
      for (const pair of history) {
        if (
          !source.raw.includes(pair.source) &&
          /[.!?。！？][”’"）)]*$/u.test(pair.target) &&
          speech.startsWith(pair.target) &&
          /^\s+\S/u.test(speech.slice(pair.target.length))
        )
          throw new Error(errorCode('HISTORY_REPLAY_SUSPECT'));
      }
      if (history.length > 1) {
        for (let start = 0; start < history.length - 1; start += 1) {
          for (let end = start + 2; end <= history.length; end += 1) {
            const span = history.slice(start, end);
            const allCurrent = span.every((pair) =>
              source.raw.includes(pair.source),
            );
            if (
              !allCurrent &&
              [' ', '\n', '\n\n'].some(
                (joiner) =>
                  speech === span.map((pair) => pair.target).join(joiner),
              )
            )
              throw new Error(errorCode('HISTORY_REPLAY_SUSPECT'));
          }
        }
      }
      const receipt: CurrentTranslationReceipt = Object.freeze({
        role,
        contract: CONTRACT,
        jobSequence: source.sequence,
        requestSequence,
        sourceIds: Object.freeze([...source.sourceIds]),
        sourceSha256: sha256(source.raw),
        rawModelText,
        ttsText: inspection.text!,
      });
      originalSources.set(receipt, source.raw);
      issued.add(receipt);
      lastIssuedRequest = requestSequence;
      return receipt;
    },
    assert,
    consume(value: unknown, job: CurrentTranslationJob) {
      const receipt = assert(value, job);
      if (consumed.has(receipt)) throw new Error(errorCode('RECEIPT_CONSUMED'));
      if (
        consumedJobs.has(receipt.jobSequence) ||
        receipt.jobSequence <= retiredConsumedJob
      )
        throw new Error(errorCode('SOURCE_REPLAY'));
      consumed.add(receipt);
      consumedJobs.add(receipt.jobSequence);
      if (consumedJobs.size > 512) {
        const oldest = Math.min(...consumedJobs);
        consumedJobs.delete(oldest);
        retiredConsumedJob = Math.max(retiredConsumedJob, oldest);
      }
      return receipt;
    },
    toMemory(value: unknown, job: CurrentTranslationJob) {
      const receipt = assert(value, job);
      if (!consumed.has(receipt))
        throw new Error(errorCode('RECEIPT_UNCONSUMED'));
      const existing = memoryForReceipt.get(receipt);
      if (existing) return existing;
      const pair: CurrentTranslationMemory = Object.freeze({
        origin: 'prior_validated_current_call_translation',
        role,
        sequence: receipt.requestSequence,
        sourceIds: Object.freeze([...receipt.sourceIds]),
        source: originalSources.get(receipt)!,
        target: receipt.ttsText,
      });
      memories.add(pair);
      memoryForReceipt.set(receipt, pair);
      return pair;
    },
    assertMemory(value: unknown) {
      if (!value || typeof value !== 'object' || !memories.has(value))
        throw new Error(errorCode('MEMORY_UNISSUED'));
      return value as CurrentTranslationMemory;
    },
  });
  guards.add(guard);
  return guard;
}
