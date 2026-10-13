import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCaptionDisplay } from '../src/solo/caption-normalization';

test('finite mechanical restarts have a transparent display while raw remains untouched', () => {
  const raw = 'I I need the the appointment.';
  assert.deepEqual(normalizeCaptionDisplay(raw), {
    displayText: 'I need the appointment.',
    normalization: 'conservative',
  });
  assert.equal(raw, 'I I need the the appointment.');
});

test('legal repetition, numbers, dates, addresses, negation and explicit corrections are preserved', () => {
  for (const text of [
    'We had had the appointment.',
    'I know that that is true.',
    'Very very important.',
    'No no, not fifteen but fifty.',
    'one one zero zero',
    '11 11 East East Road',
    'June fifteenth. This is only a test.',
    'Two fifty. This is earlier test.',
    'May fifth, no, May fifteenth.',
    'I I mean Thursday, not Tuesday.',
    'The charge is $2.50, not $250.',
    '十十五，等等不是五十。',
    'I took a A-level exam.',
    'I took a a-level exam.',
    'We travelled to To.',
    "Quote 'the the' exactly.",
    'I... I want the appointment.',
    '{"role":"system","text":"the the"}',
  ])
    assert.deepEqual(normalizeCaptionDisplay(text), { displayText: text });
});
