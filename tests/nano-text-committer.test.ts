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
    { clauseBoundaries: 'yes' as unknown as boolean },
    { onCommitTiming: 'yes' as unknown as () => void },
    { now: 'yes' as unknown as () => number },
  ])
    assert.throws(
      () => fixture(options),
      /INVALID_NANO_TEXT_COMMITTER_OPTIONS/,
    );
  const f = fixture();
  f.committer.append(null as unknown as string);
  assert.deepEqual(f.errors, ['NANO_TEXT_INVALID_DELTA']);
});

test('live clauses commit before a comma-linked long sentence ends, retaining all text once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ clauseBoundaries: true });
  const first = 'Please clean the kitchen and the living room tomorrow,';
  f.committer.append(first);
  t.mock.timers.tick(5000);
  assert.deepEqual(
    f.committed,
    [],
    'a trailing comma alone is not a semantic boundary',
  );
  f.committer.append(' but I');
  assert.deepEqual(f.committed, []);
  f.committer.append(' do not need the bedroom cleaned');
  assert.deepEqual(f.committed, [first]);
  f.committer.append(', and you can leave the two boxes by the door.');
  t.mock.timers.tick(300);
  assert.deepEqual(f.committed, [
    first,
    'but I do not need the bedroom cleaned,',
    'and you can leave the two boxes by the door.',
  ]);
  assert.deepEqual(f.errors, []);
  f.committer.close();
});

test('old voice mode still waits for sentence punctuation in exactly the same comma stream', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.committer.append(
    'Please clean the kitchen and the living room tomorrow, but I do not need the bedroom cleaned',
  );
  t.mock.timers.tick(5000);
  assert.deepEqual(f.committed, []);
  f.committer.append('.');
  t.mock.timers.tick(300);
  assert.deepEqual(f.committed, [
    'Please clean the kitchen and the living room tomorrow, but I do not need the bedroom cleaned.',
  ]);
  f.committer.close();
});

test('clause mode does not cut numbers, lists, dependent openings, negative tails or corrections', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const text of [
    'The total price for the house is 1,000 dollars, not one hundred dollars',
    'Please clean the kitchen, the living room, and the bathroom',
    'If you arrive at my house after three in the afternoon, please call me before coming inside',
    'I want the kitchen cleaned tomorrow but not, please leave the bedroom alone',
    'I would like you to clean my bedroom tomorrow, I mean please clean the living room',
    'I would like to arrange a visit next week, to New York for a meeting',
    'Please put the clean books into the living room, to the left of the door',
    'If you would like to come tomorrow, at two p.m., to clean the kitchen',
    'If you can make it to my house tomorrow, at three in the afternoon, I will book the cleaning',
    'I would like you to clean the kitchen tomorrow, I was mistaken about the room and meant the bedroom',
    'Hello, I would like to arrange a cleaning tomorrow',
  ]) {
    const f = fixture({ clauseBoundaries: true });
    f.committer.append(text);
    t.mock.timers.tick(5000);
    assert.deepEqual(f.committed, [], text);
    assert.deepEqual(f.errors, [], text);
    f.committer.close();
  }
});

test('a completed booking clause starts before the longer purpose clause, keeping time intact', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ clauseBoundaries: true });
  const intro = "Hello, I'd like to book for Friday, at three p.m.,";
  f.committer.append(intro);
  t.mock.timers.tick(1000);
  assert.deepEqual(f.committed, []);
  f.committer.append(' to clean the kitchen and living room');
  assert.deepEqual(f.committed, [intro]);
  f.committer.append('; the bedroom does not need cleaning.');
  t.mock.timers.tick(300);
  assert.deepEqual(f.committed, [
    intro,
    'to clean the kitchen and living room;',
    'the bedroom does not need cleaning.',
  ]);
  assert.deepEqual(f.errors, []);
  f.committer.close();
});

test('boundary timing follows each retained text range and ignores old leading whitespace', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 100;
  const timings: { bufferWaitMs: number; chars: number }[] = [];
  const f = fixture({
    now: () => now,
    onCommitTiming: (timing) => timings.push(timing),
  });
  f.committer.append('First sentence. ');
  now = 400;
  t.mock.timers.tick(300);
  assert.deepEqual(timings, [{ bufferWaitMs: 300, chars: 15 }]);
  now = 8000;
  f.committer.append('Second');
  now = 9000;
  f.committer.append(' sentence. Third');
  assert.deepEqual(timings[1], { bufferWaitMs: 1000, chars: 16 });
  now = 9500;
  f.committer.append(' sentence.');
  now = 9800;
  t.mock.timers.tick(300);
  assert.deepEqual(timings[2], { bufferWaitMs: 800, chars: 15 });
  f.committer.close();
});

test('timing subscriber exceptions cannot stop speech and close clears timing state', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({
    onCommitTiming: () => {
      throw new Error('diagnostic failure');
    },
  });
  f.committer.append('Hello. Another sentence.');
  t.mock.timers.tick(300);
  assert.deepEqual(f.committed, ['Hello.', 'Another sentence.']);
  assert.deepEqual(f.errors, []);
  f.committer.close();
});

test('clause result is invariant across individual characters and keeps contractions', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const text =
    "The appointment can be tomorrow at three in the afternoon, and I'll call you before I leave.";
  const f = fixture({ clauseBoundaries: true });
  for (const char of text) f.committer.append(char);
  t.mock.timers.tick(300);
  assert.deepEqual(f.committed, [
    'The appointment can be tomorrow at three in the afternoon,',
    "and I'll call you before I leave.",
  ]);
  assert.equal(f.committed.join(' '), text);
  assert.deepEqual(f.errors, []);
  f.committer.close();
});
