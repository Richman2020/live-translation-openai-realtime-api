import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createNanoTextCommitter,
  type NanoTextCommitterOptions,
} from '../src/solo/nano-text-committer';

function fixture(options: Partial<NanoTextCommitterOptions> = {}) {
  const committed: string[] = [];
  const errors: string[] = [];
  const committer = createNanoTextCommitter({
    onCommit: (text) => committed.push(text),
    onError: (code) => errors.push(code),
    ...options,
  });
  return { committer, committed, errors };
}

test('raw fragments retain spaces and split words; only punctuation commits', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  ['Hello,', ' thank', ' you for call', 'ing', '.'].forEach(f.committer.append);
  assert.deepEqual(f.committed, []);
  t.mock.timers.tick(299);
  assert.deepEqual(f.committed, []);
  t.mock.timers.tick(1);
  assert.deepEqual(f.committed, ['Hello, thank you for calling.']);
  assert.deepEqual(f.errors, []);
  f.committer.close();
});

test('multiple complete sentences and natural semicolons retain every word once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.committer.append(
    'I do not need coffee. Tomorrow at three; not today! Is that clear?',
  );
  assert.deepEqual(f.committed, [
    'I do not need coffee.',
    'Tomorrow at three;',
    'not today!',
  ]);
  t.mock.timers.tick(300);
  assert.deepEqual(f.committed, [
    'I do not need coffee.',
    'Tomorrow at three;',
    'not today!',
    'Is that clear?',
  ]);
  f.committer.close();
});

test('a split decimal cancels the pending period before synthesis', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.committer.append('The amount is 3.');
  t.mock.timers.tick(200);
  f.committer.append('14 dollars.');
  t.mock.timers.tick(299);
  assert.deepEqual(f.committed, []);
  t.mock.timers.tick(1);
  assert.deepEqual(f.committed, ['The amount is 3.14 dollars.']);
  f.committer.close();
});

test('titles, initials, dotted times and countries are held through split deltas', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  [
    'Ask Mr.',
    ' Smith and Dr.',
    ' Lee at 9 a.',
    'm.',
    ' in the U.',
    'S.',
    ' office.',
  ].forEach((delta) => {
    f.committer.append(delta);
    t.mock.timers.tick(500);
  });
  assert.deepEqual(f.committed, [
    'Ask Mr. Smith and Dr. Lee at 9 a.m. in the U.S. office.',
  ]);
  assert.deepEqual(f.errors, []);
  f.committer.close();
});

test('ambiguous abbreviation at sentence end stays buffered, never time-finalized', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.committer.append('The office is in the U.S.');
  t.mock.timers.tick(60000);
  assert.deepEqual(f.committed, []);
  f.committer.append(' Can we talk tomorrow?');
  t.mock.timers.tick(300);
  assert.deepEqual(f.committed, [
    'The office is in the U.S. Can we talk tomorrow?',
  ]);
  f.committer.close();
});

test('closing quotes and punctuation split across deltas stay with the sentence', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.committer.append('He said, “No.');
  t.mock.timers.tick(200);
  f.committer.append('”');
  t.mock.timers.tick(300);
  assert.deepEqual(f.committed, ['He said, “No.”']);
  f.committer.append('Really!');
  t.mock.timers.tick(100);
  f.committer.append('?');
  t.mock.timers.tick(300);
  assert.deepEqual(f.committed, ['He said, “No.”', 'Really!?']);
  f.committer.close();
});

test('ellipses, decimals and web addresses do not create false internal boundaries', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.committer.append('Wait... the amount is 12.50 on example.com; check it.');
  assert.deepEqual(f.committed, [
    'Wait... the amount is 12.50 on example.com;',
  ]);
  t.mock.timers.tick(300);
  assert.deepEqual(f.committed, [
    'Wait... the amount is 12.50 on example.com;',
    'check it.',
  ]);
  f.committer.close();
});

test('silence cannot commit an unpunctuated tail and closing cannot flush it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.committer.append('I do not');
  t.mock.timers.tick(60000);
  assert.deepEqual(f.committed, []);
  f.committer.close();
  f.committer.append(' need coffee.');
  t.mock.timers.tick(60000);
  assert.deepEqual(f.committed, []);
});

test('close cancels a punctuated tail timer and drops late data', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.committer.append('Do not play after hangup.');
  f.committer.close();
  f.committer.close();
  t.mock.timers.tick(1000);
  f.committer.append('Another sentence.');
  t.mock.timers.tick(1000);
  assert.deepEqual(f.committed, []);
  assert.deepEqual(f.errors, []);
});

test('empty and punctuation-only fragments never create a synthesis job', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  ['', '  ', '?', '\n', '!!!', '。'].forEach(f.committer.append);
  t.mock.timers.tick(1000);
  assert.deepEqual(f.committed, []);
  f.committer.append('   Hello.  ');
  t.mock.timers.tick(300);
  assert.deepEqual(f.committed, ['Hello.']);
  f.committer.close();
});

test('oversize sentence fails exactly once instead of clipping, even with terminal punctuation', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const text of ['x'.repeat(241), `${'x'.repeat(240)}.`]) {
    const f = fixture();
    f.committer.append(text);
    f.committer.append('Ignore this.');
    t.mock.timers.tick(1000);
    assert.deepEqual(f.errors, ['NANO_TEXT_SENTENCE_TOO_LONG']);
    assert.deepEqual(f.committed, []);
  }
});

test('a large valid multi-sentence delta is processed in order; buffer overflow fails before partial emission', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.committer.append(`${'x'.repeat(238)}. ${'y'.repeat(238)}.`);
  t.mock.timers.tick(300);
  assert.deepEqual(f.committed, [`${'x'.repeat(238)}.`, `${'y'.repeat(238)}.`]);
  f.committer.close();
  const g = fixture();
  g.committer.append('ok. '.repeat(121));
  assert.deepEqual(g.errors, ['NANO_TEXT_BUFFER_OVERFLOW']);
  assert.deepEqual(g.committed, []);
});

test('commit callback failure is terminal and cannot leak private details', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({
    onCommit: () => {
      throw new Error('private text');
    },
  });
  f.committer.append('Hello. Another sentence.');
  t.mock.timers.tick(1000);
  assert.deepEqual(f.errors, ['NANO_TEXT_COMMIT_FAILED']);
  assert.deepEqual(f.committed, []);
});

test('closing inside commit prevents later sentences from the same delta', () => {
  const committed: string[] = [];
  const f = fixture({
    onCommit(text) {
      committed.push(text);
      f.committer.close();
    },
  });
  f.committer.append('Hello. Another sentence.');
  assert.deepEqual(committed, ['Hello.']);
});

test('invalid settings and non-string data fail closed', () => {
  for (const options of [
    { boundaryDelayMs: 0 },
    { boundaryDelayMs: Infinity },
    { maxSentenceChars: 241 },
    { maxBufferChars: 481 },
    { maxSentenceChars: 240, maxBufferChars: 200 },
    { onCommit: undefined },
    { onError: undefined },
  ])
    assert.throws(
      () => fixture(options),
      /INVALID_NANO_TEXT_COMMITTER_OPTIONS/,
    );
  const f = fixture();
  f.committer.append(null as unknown as string);
  assert.deepEqual(f.errors, ['NANO_TEXT_INVALID_DELTA']);
});
