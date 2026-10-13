import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CAPTION_SECTION_MAX_COMPLETED,
  CAPTION_SECTION_MAX_SPLIT,
  CAPTION_SECTION_MAX_SOURCES,
  captionNeedsContinuation,
  createCaptionSections,
} from '../src/solo/caption-sections';

test('source endpoints for short fragments remain draft and continue with one section ID', () => {
  const sections = createCaptionSections();
  sections.register('first', 100);
  assert.deepEqual(sections.update('first', 'for the', true), [
    { id: 'first', at: 100, text: 'for the', final: false },
  ]);
  sections.register('second', 500);
  assert.deepEqual(sections.update('second', 'appointment next week.', true), [
    {
      id: 'first',
      at: 100,
      text: 'for the appointment next week.',
      final: true,
    },
  ]);
  assert.equal(sections.hasOpen(), false);
});

test('continuation classification is shared by natural boundaries and the owners idle grace', () => {
  for (const text of [
    '',
    'Hello.',
    'for the',
    'for the."',
    'Just one room.',
    'Please arrange the appointment for the.',
  ])
    assert.equal(captionNeedsContinuation(text), true);
  for (const text of [
    'I need two rooms.',
    'Please book the appointment tomorrow',
    'Do not change the date.',
  ])
    assert.equal(captionNeedsContinuation(text), false);
  const sections = createCaptionSections();
  sections.register('complete', 1);
  assert.deepEqual(sections.update('complete', 'I need two rooms.', true), [
    { id: 'complete', at: 1, text: 'I need two rooms.', final: true },
  ]);
});

test('the owner can end the short-pause grace without a timer in the helper', () => {
  const sections = createCaptionSections();
  sections.register('hello', 1);
  assert.equal(sections.update('hello', 'Hello.', true)[0].final, false);
  assert.equal(sections.hasOpen(), true);
  assert.deepEqual(sections.seal(), [
    { id: 'hello', at: 1, text: 'Hello.', final: true },
  ]);
  sections.register('next', 1500);
  assert.equal(sections.update('next', 'for the', true)[0].id, 'next');
});

test('actual truncated words are preserved and final text can correct negation', () => {
  const sections = createCaptionSections();
  sections.register('start', 1);
  sections.update('start', 'for the', true);
  sections.register('tail', 2);
  assert.equal(
    sections.update('tail', 'ection', false)[0].text,
    'for the ection',
  );
  assert.deepEqual(
    sections.update('tail', 'appointment, not the consultation.', true),
    [
      {
        id: 'start',
        at: 1,
        text: 'for the appointment, not the consultation.',
        final: true,
      },
    ],
  );
});

test('a cumulative same-source delta is not reinterpreted as separate words', () => {
  const sections = createCaptionSections();
  sections.register('one', 1);
  sections.update('one', 'for the', false);
  assert.equal(
    sections.update('one', 'for theection', false)[0].text,
    'for theection',
  );
  assert.equal(
    sections.update('one', 'for the section on taxes.', true)[0].text,
    'for the section on taxes.',
  );
});

test('registration does not preassign the next source before a sentence completes', () => {
  const sections = createCaptionSections();
  sections.register('first', 1);
  sections.register('second', 2);
  assert.deepEqual(
    sections.update('first', 'This is the first sentence.', true),
    [{ id: 'first', at: 1, text: 'This is the first sentence.', final: true }],
  );
  assert.deepEqual(
    sections.update('second', 'This is the second sentence.', true),
    [
      {
        id: 'second',
        at: 2,
        text: 'This is the second sentence.',
        final: true,
      },
    ],
  );
});

test('late source text keeps its earlier timestamp without moving displayed text between IDs', () => {
  const sections = createCaptionSections();
  sections.register('earlier', 100);
  sections.register('later', 200);
  assert.deepEqual(sections.update('later', 'the appointment', true), [
    { id: 'later', at: 200, text: 'the appointment', final: false },
  ]);
  assert.deepEqual(sections.update('earlier', 'for', true), [
    { id: 'earlier', at: 100, text: 'for', final: false },
  ]);
  assert.deepEqual(sections.seal(), [
    { id: 'earlier', at: 100, text: 'for', final: true },
    { id: 'later', at: 200, text: 'the appointment', final: true },
  ]);
});

test('an unknown earlier source blocks continuation across a gap', () => {
  const sections = createCaptionSections();
  sections.register('first', 1);
  sections.update('first', 'Please arrange', true);
  sections.register('unknown', 2);
  sections.register('third', 3);
  assert.equal(
    sections.update('third', 'the appointment', true)[0].id,
    'third',
  );
  assert.equal(sections.update('unknown', 'for Tuesday', true)[0].id, 'first');
  assert.deepEqual(
    sections.seal().map(({ id, text }) => ({ id, text })),
    [
      { id: 'first', text: 'Please arrange for Tuesday' },
      { id: 'third', text: 'the appointment' },
    ],
  );
});

test('source timestamps determine adjacency even when starts were registered out of order', () => {
  const sections = createCaptionSections();
  sections.register('second', 2);
  sections.register('first', 1);
  sections.update('first', 'for the', true);
  assert.deepEqual(sections.update('second', 'appointment', true), [
    { id: 'first', at: 1, text: 'for the appointment', final: false },
  ]);
});

test('completed source boundaries remain visible to adjacency after their text is released', () => {
  const sections = createCaptionSections();
  sections.register('old', 1);
  sections.update('old', 'unfinished', false);
  sections.register('middle', 2);
  sections.update('middle', 'This source is already complete.', true);
  sections.update('old', 'unfinished', true);
  sections.register('new', 3);
  assert.equal(sections.update('new', 'next fragment', true)[0].id, 'new');
});

test('explicit speaker break seals complete fragments and prevents future continuation', () => {
  const sections = createCaptionSections();
  sections.register('before', 1);
  sections.update('before', 'for the', true);
  assert.deepEqual(sections.break(), [
    { id: 'before', at: 1, text: 'for the', final: true },
  ]);
  sections.register('after', 2);
  assert.equal(sections.update('after', 'appointment', true)[0].id, 'after');
});

test('break waits for pending final replacement and isolates already registered older sources', () => {
  const sections = createCaptionSections();
  sections.register('pending', 1);
  sections.register('old_start', 2);
  sections.update('pending', 'six', false);
  assert.deepEqual(sections.break(), []);
  sections.register('next_speaker', 3);
  assert.equal(
    sections.update('next_speaker', 'new statement', true)[0].id,
    'next_speaker',
  );
  assert.deepEqual(sections.update('pending', 'not six', true), [
    { id: 'pending', at: 1, text: 'not six', final: true },
  ]);
  assert.deepEqual(sections.update('old_start', 'old fragment', true), [
    { id: 'old_start', at: 2, text: 'old fragment', final: true },
  ]);
});

test('source final and section final never regress when duplicate or late drafts arrive', () => {
  const sections = createCaptionSections();
  sections.register('one', 1);
  sections.update('one', 'for the', true);
  assert.deepEqual(sections.update('one', 'for', false), []);
  assert.deepEqual(sections.update('one', 'for the', true), []);
  sections.seal();
  sections.register('one', 999);
  assert.deepEqual(sections.update('one', 'changed old text', true), []);
  assert.deepEqual(sections.update('one', 'late draft', false), []);
  assert.deepEqual(sections.seal(), []);
  assert.deepEqual(sections.break(), []);
});

test('an empty final replacement clears a previously visible draft', () => {
  const sections = createCaptionSections();
  sections.register('empty', 1);
  sections.update('empty', 'misheard speech', false);
  assert.deepEqual(sections.update('empty', '', true), [
    { id: 'empty', at: 1, text: '', final: true },
  ]);
  assert.equal(sections.hasOpen(), false);
  assert.deepEqual(sections.update('empty', 'late phantom', false), []);
  sections.register('silent', 2);
  assert.deepEqual(sections.update('silent', '', true), []);
});

test('an empty source final removes only its source text and preserves other section text', () => {
  const sections = createCaptionSections();
  sections.register('first', 1);
  sections.update('first', 'for the', true);
  sections.register('second', 2);
  sections.update('second', 'wrong word', false);
  assert.deepEqual(sections.update('second', '', true), [
    { id: 'first', at: 1, text: 'for the', final: false },
  ]);
  assert.deepEqual(sections.seal(), [
    { id: 'first', at: 1, text: 'for the', final: true },
  ]);
});

test('a correction of an earlier source cannot seal a later unfinished source', () => {
  const sections = createCaptionSections();
  sections.register('first', 1);
  sections.update('first', 'incorrect', true);
  sections.register('second', 2);
  sections.update('second', 'still speaking', false);
  assert.deepEqual(sections.update('first', '', true), [
    { id: 'first', at: 1, text: 'still speaking', final: false },
  ]);
  assert.deepEqual(sections.seal(), []);
  assert.deepEqual(sections.update('second', 'corrected statement', true), [
    { id: 'first', at: 1, text: 'corrected statement', final: true },
  ]);
});

test('natural source boundaries seal long accumulated sections without splitting a source item', () => {
  const sections = createCaptionSections();
  sections.register('long', 1);
  const text = 'one long unfinished source phrase '.repeat(12).trim();
  assert.ok(text.length > 240);
  assert.deepEqual(sections.update('long', text, false), [
    { id: 'long', at: 1, text, final: false },
  ]);
  assert.deepEqual(sections.update('long', text, true), [
    { id: 'long', at: 1, text, final: true },
  ]);
});

test('a long function-word ending stays draft and a later source continues without invented letters', () => {
  const sections = createCaptionSections();
  sections.register('long_prefix', 1);
  const text = `${'one long unfinished source phrase '.repeat(12)}for the`;
  assert.ok(text.length > 240);
  assert.deepEqual(sections.update('long_prefix', text, true), [
    { id: 'long_prefix', at: 1, text, final: false },
  ]);
  assert.equal(sections.hasOpen(), true);
  sections.register('actual_suffix', 2001);
  assert.deepEqual(sections.update('actual_suffix', 'ection', false), [
    { id: 'long_prefix', at: 1, text: `${text} ection`, final: false },
  ]);
  assert.deepEqual(sections.update('actual_suffix', 'ection', true), [
    { id: 'long_prefix', at: 1, text: `${text} ection`, final: true },
  ]);
});

test('provider punctuation does not turn an unfinished function-word ending into a complete sentence', () => {
  for (const ending of ['for the.', 'for the."', 'and!', 'to?', 'because.']) {
    for (const prefix of [
      'Please arrange the appointment ',
      'one long unfinished source phrase '.repeat(12),
    ]) {
      const sections = createCaptionSections();
      sections.register('unfinished', 1);
      const text = `${prefix}${ending}`;
      assert.deepEqual(sections.update('unfinished', text, true), [
        { id: 'unfinished', at: 1, text, final: false },
      ]);
    }
  }
});

test('explicit sealing can still settle an unfinished long source without completing its words', () => {
  const sections = createCaptionSections();
  sections.register('unfinished', 1);
  const text = `${'one long unfinished source phrase '.repeat(12)}for the.`;
  sections.update('unfinished', text, true);
  assert.deepEqual(sections.seal(), [
    { id: 'unfinished', at: 1, text, final: true },
  ]);
});

test('a long source with reliable complete sentences replaces the whole draft with exact natural sections', () => {
  const sections = createCaptionSections();
  sections.register('multi', 100);
  const first = 'Please arrange the appointment for next Tuesday.';
  const second = 'Do not change it to Wednesday.';
  const third = 'The consultation costs exactly twelve dollars.';
  const text = `${first}\n${second} ${third}`;
  assert.deepEqual(sections.update('multi', text, false), [
    { id: 'multi', at: 100, text, final: false },
  ]);
  assert.deepEqual(sections.update('multi', text, true), [
    { id: 'multi', at: 100, text: first, final: true },
    { id: 'caption:multi:2', at: 100, text: second, final: true },
    { id: 'caption:multi:3', at: 100, text: third, final: true },
  ]);
  assert.equal(sections.hasOpen(), false);
  assert.deepEqual(sections.update('multi', 'late whole draft', false), []);
  assert.deepEqual(sections.update('multi', text, true), []);
  assert.deepEqual(sections.seal(), []);
});

test('final negation correction supplies the exact text for every resulting section', () => {
  const sections = createCaptionSections();
  sections.register('corrected', 1);
  sections.update(
    'corrected',
    'Please book it for Tuesday. Please charge fifty dollars.',
    false,
  );
  assert.deepEqual(
    sections.update(
      'corrected',
      'Do not book it for Tuesday. Please charge fifteen dollars.',
      true,
    ),
    [
      {
        id: 'corrected',
        at: 1,
        text: 'Do not book it for Tuesday.',
        final: true,
      },
      {
        id: 'caption:corrected:2',
        at: 1,
        text: 'Please charge fifteen dollars.',
        final: true,
      },
    ],
  );
});

test('sentence splitting preserves titles, initials, abbreviations, decimals and ellipses', () => {
  const sections = createCaptionSections();
  sections.register('precise', 1);
  const first =
    'Please ask Dr. A. Smith at Acme Inc. about appointment No. 5 in the U.S. on Oct. 13 at 3.14 dollars.';
  const second = 'We are still thinking... please wait for our final decision.';
  assert.deepEqual(sections.update('precise', `${first} ${second}`, true), [
    { id: 'precise', at: 1, text: first, final: true },
    { id: 'caption:precise:2', at: 1, text: second, final: true },
  ]);
});

test('an incomplete final tail waits for an explicit pause and remains exactly as received', () => {
  const sections = createCaptionSections();
  sections.register('tail', 1);
  const first = 'This is a complete first sentence.';
  const text = `${first} for the`;
  assert.deepEqual(sections.update('tail', text, true), [
    { id: 'tail', at: 1, text, final: false },
  ]);
  assert.deepEqual(sections.seal(), [
    { id: 'tail', at: 1, text: first, final: true },
    { id: 'caption:tail:2', at: 1, text: 'for the', final: true },
  ]);
});

test('an empty final after a whole multi-sentence draft clears the draft without phantom subrows', () => {
  const sections = createCaptionSections();
  sections.register('cleared', 1);
  sections.update(
    'cleared',
    'This is the first sentence. This is the second sentence.',
    false,
  );
  assert.deepEqual(sections.update('cleared', '', true), [
    { id: 'cleared', at: 1, text: '', final: true },
  ]);
  assert.deepEqual(sections.seal(), []);
});

test('the split limit preserves all remaining source text in the last natural section', () => {
  const sections = createCaptionSections();
  sections.register('many', 1);
  const sentences = Array.from(
    { length: 20 },
    (_, i) => `This is the complete sentence number ${i}.`,
  );
  const text = sentences.join(' ');
  const updates = sections.update('many', text, true);
  assert.equal(updates.length, CAPTION_SECTION_MAX_SPLIT);
  assert.deepEqual(
    updates.slice(0, -1).map(({ text: part }) => part),
    sentences.slice(0, CAPTION_SECTION_MAX_SPLIT - 1),
  );
  assert.equal(
    updates.at(-1)!.text,
    sentences.slice(CAPTION_SECTION_MAX_SPLIT - 1).join(' '),
  );
  assert.equal(updates.map(({ text: part }) => part).join(' '), text);
  assert.ok(updates.every(({ at, final }) => at === 1 && final));
});

test('synthetic section IDs cannot collide with accepted provider source IDs', () => {
  const sections = createCaptionSections();
  sections.register('provider', 1);
  const updates = sections.update(
    'provider',
    'This is the first sentence. This is the next sentence.',
    true,
  );
  assert.equal(updates[1].id, 'caption:provider:2');
  assert.throws(
    () => sections.register(updates[1].id, 2),
    /INVALID_CAPTION_SOURCE/,
  );
  sections.register('caption_provider_2', 2);
  assert.equal(
    sections.update('caption_provider_2', 'independent source', true)[0].id,
    'caption_provider_2',
  );
});

test('titles and ellipses do not impersonate reliable sentence endings', () => {
  for (const text of [
    'Please speak to Dr.',
    'This thought is unfinished..',
    'This thought is unfinished...',
    'I spoke to Mr.',
  ]) {
    const sections = createCaptionSections();
    sections.register('one', 1);
    assert.equal(sections.update('one', text, true)[0].final, false);
    assert.equal(sections.seal()[0].final, true);
  }
});

test('joins preserve received punctuation and only add a necessary source boundary space', () => {
  const sections = createCaptionSections();
  sections.register('first', 1);
  sections.update('first', 'Tuesday', true);
  sections.register('second', 2);
  assert.equal(
    sections.update('second', ', not Monday', true)[0].text,
    'Tuesday, not Monday',
  );
});

test('pending records have a hard limit and are never silently evicted', () => {
  const sections = createCaptionSections();
  for (let i = 0; i < CAPTION_SECTION_MAX_SOURCES; i += 1)
    sections.register(`pending_${i}`, i);
  assert.throws(
    () => sections.register('overflow', 9999),
    /CAPTION_SECTION_LIMIT/,
  );
  assert.deepEqual(sections.update('pending_0', 'still retained', false), [
    { id: 'pending_0', at: 0, text: 'still retained', final: false },
  ]);
  assert.deepEqual(sections.update('pending_0', '', true), [
    { id: 'pending_0', at: 0, text: '', final: true },
  ]);
  sections.register('after_release', 9999);
});

test('closed records release capacity and retain bounded recent deduplication', () => {
  const sections = createCaptionSections();
  for (let i = 0; i < CAPTION_SECTION_MAX_COMPLETED + 20; i += 1) {
    const id = `complete_${i}`;
    sections.register(id, i);
    sections.update(id, 'short', true);
    sections.seal();
  }
  assert.equal(sections.hasOpen(), false);
  const recent = `complete_${CAPTION_SECTION_MAX_COMPLETED + 19}`;
  sections.register(recent, 9999);
  assert.deepEqual(sections.update(recent, 'late text', false), []);
  assert.throws(
    () => sections.update('complete_0', 'evicted old id', false),
    /INVALID_CAPTION_SOURCE/,
  );
});

test('invalid and unregistered inputs fail with fixed errors', () => {
  const sections = createCaptionSections();
  assert.throws(() => sections.register('bad id', 1), /INVALID_CAPTION_SOURCE/);
  assert.throws(
    () => sections.register('bad_time', NaN),
    /INVALID_CAPTION_SOURCE/,
  );
  assert.throws(
    () => sections.update('missing', 'text', false),
    /INVALID_CAPTION_SOURCE/,
  );
  sections.register('valid', 1);
  assert.throws(
    () => sections.update('valid', 'x'.repeat(4097), false),
    /INVALID_CAPTION_SOURCE/,
  );
});
