import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeEach, test } from 'node:test';

import {
  createCurrentTranslationGuard,
  inspectCurrentTranslationText,
  type CurrentTranslationJob,
} from '../src/solo/aliyun-planb-translation-guard';

let guard = createCurrentTranslationGuard('local');
beforeEach(() => {
  guard = createCurrentTranslationGuard('local');
});
const issueCurrentTranslationReceipt = (
  job: CurrentTranslationJob,
  sequence: number,
  text: string,
) => guard.issue(job, sequence, text);
const assertCurrentTranslationReceipt = (
  value: unknown,
  job: CurrentTranslationJob,
) => guard.assert(value, job);
const consumeCurrentTranslationReceipt = (
  value: unknown,
  job: CurrentTranslationJob,
) => guard.consume(value, job);

const job = (
  sequence = 1,
  sourceIds = [2],
  raw = '人工构造的当前正文。',
): CurrentTranslationJob => ({ sequence, sourceIds, raw });
const fixedError = /^PLANB_CURRENT_TRANSLATION_[A-Z_]+$/u;

test('inspector preserves plain speech exactly except outer whitespace, including real numbers and repetition', () => {
  for (const text of [
    'Please confirm the appointment for June 15 at 2 p.m., not 3 p.m.',
    'No. No, please do not cancel.',
    '25',
    '-25',
    '25.50',
    '2e3',
    'First paragraph.\nSecond paragraph.',
    'A tab\tbetween words.',
    'The word translation appears inside this sentence.',
    'He said, "Here is the translation," and continued speaking.',
  ]) {
    const result = inspectCurrentTranslationText(` \r\n${text}\t `);
    assert.equal(result.accepted, true, text);
    assert.equal(result.code, null);
    assert.equal(result.text, text);
    assert.equal(result.bodyKind, 'plain_text_candidate');
  }
});

test('the actual failed response JSON shape is represented only by separately synthetic content', () => {
  // Only the observed wrapper keys/shape are reproduced. All values here are
  // artificial; this fixture contains no private real source or translation.
  const synthetic = JSON.stringify({
    RECENT_RAW_CONTEXT: [
      { role: 'local', raw_source: 'SYNTHETIC_HISTORY_ONLY' },
    ],
    CURRENT_SOURCE: { role: 'local', raw_source: 'SYNTHETIC_CURRENT_ONLY' },
  });
  const result = inspectCurrentTranslationText(synthetic);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'PLANB_CURRENT_TRANSLATION_BODY_RESERVED');
  assert.equal(result.text, null);
  assert.throws(
    () => issueCurrentTranslationReceipt(job(), 1, synthetic),
    /BODY_RESERVED$/u,
  );
});

for (const [text, reason] of [
  ['{}', 'BODY_JSON'],
  ['{"translation":"synthetic"}', 'BODY_JSON'],
  ['[]', 'BODY_JSON'],
  ['["synthetic"]', 'BODY_JSON'],
  ['"synthetic quoted JSON string"', 'BODY_JSON'],
  ["'single quoted wrapper'", 'BODY_JSON'],
  ['“curly quoted wrapper”', 'BODY_JSON'],
  ['true', 'BODY_JSON'],
  ['FALSE', 'BODY_JSON'],
  ['null', 'BODY_JSON'],
  ['{"unfinished":', 'BODY_JSON_FRAGMENT'],
  ['[unfinished', 'BODY_JSON_FRAGMENT'],
  ['"unfinished string', 'BODY_JSON_FRAGMENT'],
  ['```json\n{"translation":"synthetic"}\n```', 'BODY_FENCE'],
  ['~~~\nsynthetic\n~~~', 'BODY_FENCE'],
  ['prefix ```hidden fenced code``` suffix', 'BODY_FENCE'],
  ['CURRENT_SOURCE: synthetic', 'BODY_RESERVED'],
  ['recent_raw_context contains synthetic history', 'BODY_RESERVED'],
  ['<translation>synthetic</translation>', 'BODY_STRUCTURE'],
  ['<?xml version="1.0"?><result>synthetic</result>', 'BODY_STRUCTURE'],
  ['Translation: synthetic output.', 'BODY_META_PREFIX'],
  ['English: synthetic output.', 'BODY_META_PREFIX'],
  ['Chinese: 人工译文。', 'BODY_META_PREFIX'],
  ['中文翻译：人工译文。', 'BODY_META_PREFIX'],
  ['Here is the Chinese translation: 人工译文。', 'BODY_META_PREFIX'],
  ['Here is the English translation: synthetic output.', 'BODY_META_PREFIX'],
  ["Here's the translation: synthetic output.", 'BODY_META_PREFIX'],
  ['The translation is synthetic output.', 'BODY_META_PREFIX'],
  ['Sure, here is the translation.', 'BODY_META_PREFIX'],
  ['Assistant: synthetic output.', 'BODY_META_PREFIX'],
  ['Note: this is a synthetic explanatory note.', 'BODY_META_PREFIX'],
  ['As an AI, I offer this synthetic explanation.', 'BODY_META_PREFIX'],
  ['译文：人工测试。', 'BODY_META_PREFIX'],
  ['以下是英文翻译：人工测试。', 'BODY_META_PREFIX'],
] as const) {
  test(`inspector rejects ${reason}: ${text.slice(0, 42)}`, () => {
    const result = inspectCurrentTranslationText(text);
    assert.equal(result.accepted, false);
    assert.equal(result.code, `PLANB_CURRENT_TRANSLATION_${reason}`);
    assert.equal(result.text, null);
  });
}

test('non-string, blank, oversized and concealed control content never throws from the inspector', () => {
  const throwingObject = {
    toString() {
      throw new Error('private canary');
    },
  };
  for (const value of [
    undefined,
    null,
    true,
    25,
    {},
    [],
    throwingObject,
    Symbol('private'),
  ]) {
    const result = inspectCurrentTranslationText(value);
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'PLANB_CURRENT_TRANSLATION_BODY_TYPE');
  }
  for (const value of ['', ' \r\n\t '])
    assert.equal(
      inspectCurrentTranslationText(value).code,
      'PLANB_CURRENT_TRANSLATION_EMPTY',
    );
  assert.equal(
    inspectCurrentTranslationText('x'.repeat(8193)).code,
    'PLANB_CURRENT_TRANSLATION_BODY_LIMIT',
  );
  for (const control of [
    '\u0000',
    '\u0008',
    '\u000B',
    '\u001B',
    '\u007F',
    '\u0085',
    '\u200B',
    '\u202E',
    '\u2066',
    '\uFEFF',
  ]) {
    assert.equal(
      inspectCurrentTranslationText(`body${control}tail`).code,
      'PLANB_CURRENT_TRANSLATION_BODY_CONTROL',
    );
    assert.equal(
      inspectCurrentTranslationText(`${control}{"hidden":"wrapper"}`).accepted,
      false,
    );
  }
});

test('issued receipt has exactly frozen scalar fields and frozen copied IDs, with raw and trimmed text separate', () => {
  const source = job(3, [4, 6], '原始正文的外围空白也属于任务。 ');
  const output = ' \nSynthetic English only.\t ';
  const receipt = issueCurrentTranslationReceipt(source, 7, output);
  assert.deepEqual(Object.keys(receipt), [
    'role',
    'contract',
    'jobSequence',
    'requestSequence',
    'sourceIds',
    'sourceSha256',
    'rawModelText',
    'ttsText',
  ]);
  assert.equal(receipt.contract, 'aliyun-current-plain-text-v2');
  assert.equal(receipt.jobSequence, 3);
  assert.equal(receipt.requestSequence, 7);
  assert.deepEqual(receipt.sourceIds, [4, 6]);
  assert.notStrictEqual(receipt.sourceIds, source.sourceIds);
  assert.equal(
    receipt.sourceSha256,
    createHash('sha256').update(source.raw, 'utf8').digest('hex'),
  );
  assert.equal(receipt.rawModelText, output);
  assert.equal(receipt.ttsText, 'Synthetic English only.');
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.sourceIds), true);
  assert.throws(() => {
    (receipt as any).ttsText = 'tampered';
  }, TypeError);
  assert.throws(() => {
    (receipt.sourceIds as number[]).push(9);
  }, TypeError);
});

test('assertion does not consume; consuming a receipt twice is refused without text deduplication', () => {
  const source = job();
  const receipt = issueCurrentTranslationReceipt(
    source,
    1,
    'Same legitimate statement.',
  );
  assert.strictEqual(assertCurrentTranslationReceipt(receipt, source), receipt);
  assert.strictEqual(assertCurrentTranslationReceipt(receipt, source), receipt);
  assert.strictEqual(
    consumeCurrentTranslationReceipt(receipt, source),
    receipt,
  );
  assert.strictEqual(assertCurrentTranslationReceipt(receipt, source), receipt);
  assert.throws(
    () => consumeCurrentTranslationReceipt(receipt, source),
    /RECEIPT_CONSUMED$/u,
  );
  const repeatedSource = job(2, [3], source.raw);
  const repeated = issueCurrentTranslationReceipt(
    repeatedSource,
    2,
    receipt.rawModelText,
  );
  assert.strictEqual(
    consumeCurrentTranslationReceipt(repeated, repeatedSource),
    repeated,
  );
  assert.equal(repeated.ttsText, receipt.ttsText);
});

test('job sequence, exact ID array, raw text and raw whitespace must match the issued receipt', () => {
  const source = job(2, [3, 5], '人工正文，数字25，不能改成250。 ');
  const receipt = issueCurrentTranslationReceipt(
    source,
    2,
    'Synthetic valid body.',
  );
  for (const changed of [
    { ...source, sequence: 3 },
    { ...source, sourceIds: [3, 6] },
    { ...source, sourceIds: [3] },
    { ...source, raw: source.raw.trim() },
    { ...source, raw: source.raw.replace('25，', '250，') },
  ])
    assert.throws(
      () => assertCurrentTranslationReceipt(receipt, changed),
      /RECEIPT_JOB_MISMATCH$/u,
    );
  assert.strictEqual(
    assertCurrentTranslationReceipt(receipt, structuredClone(source)),
    receipt,
  );
  consumeCurrentTranslationReceipt(receipt, source);
});

test('a UTF8 replacement collision cannot bypass exact internal source binding', () => {
  const source = job(1, [1], 'synthetic\uD800');
  const other = job(1, [1], 'synthetic\uFFFD');
  assert.equal(
    createHash('sha256').update(source.raw).digest('hex'),
    createHash('sha256').update(other.raw).digest('hex'),
  );
  const receipt = issueCurrentTranslationReceipt(source, 1, 'Synthetic body.');
  assert.throws(
    () => assertCurrentTranslationReceipt(receipt, other),
    /RECEIPT_JOB_MISMATCH$/u,
  );
});

test('copies, deserialized envelopes, forged shapes, symbols, proxies and getters cannot issue a receipt', () => {
  const source = job();
  const receipt = issueCurrentTranslationReceipt(
    source,
    1,
    'Synthetic valid body.',
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const values = [
    null,
    undefined,
    1,
    'body',
    [],
    {},
    { ...receipt },
    JSON.parse(JSON.stringify(receipt)),
    Object.freeze({ ...receipt }),
    new Proxy(receipt, {}),
    revoked.proxy,
    Object.defineProperty({}, 'ttsText', {
      get() {
        throw new Error('private getter');
      },
    }),
  ];
  for (const value of values)
    assert.throws(
      () => assertCurrentTranslationReceipt(value, source),
      (error: unknown) =>
        error instanceof Error && fixedError.test(error.message),
    );
  assert.strictEqual(
    consumeCurrentTranslationReceipt(receipt, source),
    receipt,
  );
});

test('invalid jobs and request sequences fail with fixed codes and never leak thrown accessor messages', () => {
  for (const source of [
    job(0),
    job(1, []),
    job(1, [2, 2]),
    job(1, [3, 2]),
    job(1, [0]),
    job(1, [1.5]),
    job(1, [1], ' '),
    job(1, [1], 'x'.repeat(4097)),
    Object.defineProperty({}, 'sequence', {
      get() {
        throw new Error('private getter');
      },
    }),
  ])
    assert.throws(
      () =>
        issueCurrentTranslationReceipt(
          source as CurrentTranslationJob,
          1,
          'Valid body.',
        ),
      /JOB_INVALID$/u,
    );
  for (const request of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(
      () => issueCurrentTranslationReceipt(job(), request, 'Valid body.'),
      /REQUEST_INVALID$/u,
    );
});

test('the syntax gate does not claim arbitrary natural-language semantic verification', () => {
  // An unlabelled explanation can be indistinguishable from real quoted
  // speech. Acceptance here is intentionally only a syntax/binding candidate,
  // never a claim that this sentence is a correct translation of the job.
  const indistinguishable =
    'This sentence discusses how an interpretation might work.';
  assert.equal(inspectCurrentTranslationText(indistinguishable).accepted, true);
  assert.equal(
    inspectCurrentTranslationText(indistinguishable).bodyKind,
    'plain_text_candidate',
  );
});

test('call and role issuers cannot exchange receipts or memory; forged shapes never authorize either', () => {
  const currentGuard = guard;
  const source = job();
  const receipt = guard.issue(source, 1, 'Synthetic current English.');
  const remote = createCurrentTranslationGuard('remote');
  const nextCall = createCurrentTranslationGuard('local');
  for (const other of [remote, nextCall]) {
    assert.throws(() => other.consume(receipt, source), /RECEIPT_UNISSUED$/u);
  }
  assert.throws(() => guard.toMemory(receipt, source), /RECEIPT_UNCONSUMED$/u);
  guard.consume(receipt, source);
  const pair = guard.toMemory(receipt, source);
  assert.equal(pair.role, 'local');
  assert.equal(pair.origin, 'prior_validated_current_call_translation');
  assert.equal(Object.isFrozen(pair), true);
  assert.equal(Object.isFrozen(pair.sourceIds), true);
  assert.strictEqual(guard.toMemory(receipt, source), pair);
  assert.strictEqual(guard.assertMemory(pair), pair);
  for (const other of [remote, nextCall])
    assert.throws(() => other.assertMemory(pair), /MEMORY_UNISSUED$/u);
  for (const value of [
    { ...pair },
    structuredClone(pair),
    {
      origin: pair.origin,
      role: 'local',
      source: 'reference',
      target: 'external answer',
    },
  ])
    assert.throws(() => currentGuard.assertMemory(value), /MEMORY_UNISSUED$/u);
});

test('one finalized job cannot authorize a second response; same-source natural subsegments and real repetition remain playable', () => {
  const source = job(1, [2], '请重复。');
  const first = guard.issue(source, 1, 'Please repeat.');
  guard.consume(first, source);
  const duplicate = guard.issue(source, 2, 'Please repeat.');
  assert.throws(() => guard.consume(duplicate, source), /SOURCE_REPLAY$/u);
  const nextSubsection = job(2, [2], source.raw);
  const second = guard.issue(nextSubsection, 3, 'Please repeat.');
  guard.consume(second, nextSubsection);
  const realNextSpeech = job(3, [3], source.raw);
  const third = guard.issue(realNextSpeech, 4, 'Please repeat.');
  guard.consume(third, realNextSpeech);
  const correction = job(4, [4], '更正，不是二十五元，是二百五十元。');
  const fourth = guard.issue(
    correction,
    5,
    'Correction, not twenty-five yuan, but two hundred and fifty yuan.',
  );
  assert.equal(guard.consume(fourth, correction).ttsText, fourth.ttsText);
});

test('request identity is monotonic without a test-run count cap', () => {
  for (let index = 1; index <= 520; index += 1) {
    const source = job(index, [index], `人工原文${index}`);
    const receipt = guard.issue(
      source,
      index,
      `Synthetic translation ${index}.`,
    );
    guard.consume(receipt, source);
  }
  assert.throws(
    () => guard.issue(job(521, [521]), 520, 'Current.'),
    /REQUEST_INVALID$/u,
  );
  const oldJob = job(1, [1], '人工原文1');
  const replay = guard.issue(oldJob, 521, 'Synthetic translation 1.');
  assert.throws(() => guard.consume(replay, oldJob), /SOURCE_REPLAY$/u);
});

test('known complete history prefix plus new body is refused whole, without cleaning or a second request', () => {
  const prior = job(1, [1], '今天不取消。');
  const first = guard.issue(prior, 1, 'Do not cancel today.');
  guard.consume(first, prior);
  const history = [guard.toMemory(first, prior)];
  const current = job(2, [2], '更正，是明天。');
  assert.throws(
    () =>
      guard.issue(
        current,
        2,
        'Do not cancel today. Correction, it is tomorrow.',
        history,
      ),
    /HISTORY_REPLAY_SUSPECT$/u,
  );
  // The gate never returns a stripped tail, a substitute or a preferred answer.
  const safe = guard.issue(current, 2, 'Correction, it is tomorrow.', history);
  assert.equal(
    guard.consume(safe, current).ttsText,
    'Correction, it is tomorrow.',
  );
});

test('one equal historical target for a synonymous current source remains valid', () => {
  const prior = job(1, [1], '不要取消。');
  const first = guard.issue(prior, 1, 'Do not cancel.');
  guard.consume(first, prior);
  const history = [guard.toMemory(first, prior)];
  const synonym = job(2, [2], '请别取消。');
  const second = guard.issue(synonym, 2, 'Do not cancel.', history);
  assert.equal(guard.consume(second, synonym).ttsText, 'Do not cancel.');
});

test('current original containing known history allows true repetition and subsequent explicit correction', () => {
  const prior = job(1, [1], '费用是二十五元。');
  const first = guard.issue(prior, 1, 'The fee is twenty-five yuan.');
  guard.consume(first, prior);
  const history = [guard.toMemory(first, prior)];
  const repeated = job(2, [2], '费用是二十五元。费用是二十五元。');
  const second = guard.issue(
    repeated,
    2,
    'The fee is twenty-five yuan. The fee is twenty-five yuan.',
    history,
  );
  guard.consume(second, repeated);
  const corrected = job(
    3,
    [3],
    '费用是二十五元。更正，不是二十五元，是二百五十元。',
  );
  const third = guard.issue(
    corrected,
    3,
    'The fee is twenty-five yuan. Correction, not twenty-five yuan, but two hundred and fifty yuan.',
    history,
  );
  guard.consume(third, corrected);
});

test('complete multi-pair replay is refused, while source-grounded full repetition is allowed', () => {
  const prior = job(1, [1], '是');
  const first = guard.issue(prior, 1, 'Yes');
  guard.consume(first, prior);
  const next = job(2, [2], '不是');
  const second = guard.issue(next, 2, 'No');
  guard.consume(second, next);
  const history = [guard.toMemory(first, prior), guard.toMemory(second, next)];
  const current = job(3, [3], '金额二十五。');
  assert.throws(
    () => guard.issue(current, 3, 'Yes No', history),
    /HISTORY_REPLAY_SUSPECT$/u,
  );
  const repeat = job(4, [4], '是，不是');
  assert.equal(
    guard.consume(guard.issue(repeat, 3, 'Yes No', history), repeat).ttsText,
    'Yes No',
  );
});

test('history cannot be forged or imported from another call for a false replay allegation', () => {
  const other = createCurrentTranslationGuard('local');
  const source = job();
  const original = other.issue(source, 1, 'Artificial previous sentence.');
  other.consume(original, source);
  const alien = other.toMemory(original, source);
  assert.throws(
    () =>
      guard.issue(job(), 1, 'Artificial previous sentence. Current.', [alien]),
    /MEMORY_UNISSUED$/u,
  );
  assert.throws(
    () => guard.issue(job(), 1, 'Current.', [{ ...alien }]),
    /MEMORY_UNISSUED$/u,
  );
});
