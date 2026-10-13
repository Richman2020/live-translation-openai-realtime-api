import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createCallContext,
  recentWholeContext,
  CALL_CONTEXT_MAX_CHARACTERS,
  CALL_CONTEXT_MAX_ENTRY_CHARACTERS,
  type CallContextObservation,
} from '../src/solo/call-context';

const observation = (
  overrides: Partial<CallContextObservation> = {},
): CallContextObservation => ({
  role: 'remote',
  sourceId: 'source',
  sourceKind: 'asr',
  at: 10,
  order: 1,
  revision: 1,
  observedAt: 10,
  text: 'A complete original.',
  final: true,
  ...overrides,
});

test('per-call context distinguishes both roles, provisional raw and generated native output', () => {
  const context = createCallContext();
  context.observe(
    observation({ role: 'local', sourceKind: 'native_source', final: false }),
  );
  context.observe(
    observation({
      at: 20,
      observedAt: 20,
      order: 2,
      text: 'I do not want that one.',
    }),
  );
  context.observe(
    observation({
      role: 'local',
      sourceId: 'output',
      sourceKind: 'native_output',
      at: 30,
      observedAt: 30,
      order: 3,
      final: true,
      text: 'Generated English.',
    }),
  );
  const result = context.snapshot({ beforeAt: 40 });
  assert.deepEqual(
    result.entries.map((row) => [row.role, row.generated, row.provisional]),
    [
      ['local', false, true],
      ['remote', false, false],
      ['local', true, true],
    ],
  );
  assert.ok(Object.isFrozen(result.entries));
  assert.ok(Object.isFrozen(result.entries[0]));
  assert.deepEqual(createCallContext().snapshot({ beforeAt: 40 }).entries, []);
});

test('source starts and visible revision time prevent future words in an old turn snapshot', () => {
  const context = createCallContext();
  context.observe(
    observation({ final: false, text: 'I want the appointment.' }),
  );
  const frozen = context.snapshot({ beforeAt: 30 });
  context.observe(
    observation({
      final: false,
      revision: 2,
      observedAt: 40,
      text: 'I do not want the appointment.',
    }),
  );
  assert.equal(
    context.snapshot({ beforeAt: 30 }).entries[0].text,
    'I want the appointment.',
  );
  assert.equal(
    context.snapshot({ beforeAt: 50 }).entries[0].text,
    'I do not want the appointment.',
  );
  assert.equal(frozen.entries[0].text, 'I want the appointment.');
  assert.equal(
    context.snapshot({ beforeAt: 50, maxVersion: frozen.version }).entries[0]
      .text,
    'I want the appointment.',
  );
  assert.equal(
    context.observe(
      observation({
        final: false,
        revision: 1,
        observedAt: 45,
        text: 'late old value',
      }),
    ),
    false,
  );
});

test('same timestamp needs explicit source order; completion arrival does not reorder the call', () => {
  const context = createCallContext();
  context.observe(
    observation({ sourceId: 'later', at: 20, observedAt: 20, order: 2 }),
  );
  context.observe(
    observation({
      sourceId: 'earlier',
      at: 10,
      observedAt: 25,
      order: 1,
      text: 'The earlier turn.',
    }),
  );
  assert.deepEqual(context.snapshot({ beforeAt: 20 }).entries, []);
  assert.deepEqual(
    context
      .snapshot({ beforeAt: 20, beforeOrder: 3 })
      .entries.map((row) => row.sourceId),
    ['later'],
  );
  assert.deepEqual(
    context.snapshot({ beforeAt: 30 }).entries.map((row) => row.sourceId),
    ['earlier', 'later'],
  );
});

test('dense one-speaker revisions retain opposite-role context without growing history', () => {
  const context = createCallContext();
  context.observe(observation({ text: 'Earlier remote fact, not a guess.' }));
  for (let i = 0; i < 300; i += 1)
    context.observe(
      observation({
        role: 'local',
        sourceKind: 'native_source',
        final: false,
        sourceId: 'stream',
        at: 20,
        order: 2,
        revision: i + 1,
        observedAt: 20 + i,
        text: `Observed local revision ${i}.`,
      }),
    );
  const snapshot = context.snapshot({ beforeAt: 400 });
  assert.equal(snapshot.entries.length, 2);
  assert.equal(snapshot.entries[0].role, 'remote');
  assert.equal(snapshot.entries[1].revision, 300);
});

test('bounded distinct source quotas preserve both directions and skip complete oversized facts', () => {
  const context = createCallContext();
  for (let role = 0; role < 2; role += 1)
    for (let i = 0; i < 20; i += 1)
      context.observe(
        observation({
          role: role ? 'local' : 'remote',
          sourceId: `item_${i}`,
          at: i + role * 20 + 1,
          observedAt: i + role * 20 + 1,
          order: i + role * 20 + 1,
          text: 'A bounded complete statement. '.repeat(12),
        }),
      );
  const snapshot = context.snapshot({ beforeAt: 50 });
  assert.ok(snapshot.entries.length <= 6);
  assert.ok(snapshot.entries.some((row) => row.role === 'remote'));
  assert.ok(snapshot.entries.some((row) => row.role === 'local'));
  assert.ok(
    snapshot.entries.reduce((sum, row) => sum + row.text.length, 0) <=
      CALL_CONTEXT_MAX_CHARACTERS,
  );
  assert.ok(
    snapshot.entries.every(
      (row) => row.text.length <= CALL_CONTEXT_MAX_ENTRY_CHARACTERS,
    ),
  );
  const long = 'x'.repeat(650) + ' not fifteen';
  assert.equal(recentWholeContext(long), undefined);
  context.observe(
    observation({
      sourceId: 'invalid_tail',
      at: 60,
      observedAt: 60,
      order: 60,
      final: false,
    }),
  );
  context.observe(
    observation({
      sourceId: 'invalid_tail',
      at: 60,
      observedAt: 70,
      order: 60,
      revision: 2,
      final: false,
      text: long,
    }),
  );
  assert.ok(
    !context
      .snapshot({ beforeAt: 80 })
      .entries.some((row) => row.sourceId === 'invalid_tail'),
  );
});

test('long observed native sources use existing whole recent sentences, never complete a tail', () => {
  const raw =
    'Earlier complete sentence. '.repeat(40) + 'I do not want the fifteenth.';
  const selected = recentWholeContext(raw);
  assert.ok(selected?.excerpt);
  assert.ok(selected.text.endsWith('I do not want the fifteenth.'));
  assert.ok(!selected.text.includes('unfinished'));
  assert.ok(raw.includes(selected.text));
  assert.equal(recentWholeContext('x'.repeat(700) + ' Dr.'), undefined);
});

test('an oversized source with any unfinished correction tail omits the whole context rather than reviving an earlier fact', () => {
  for (const raw of [
    'I need three rooms. Actually, not three rooms, I need two rooms, ' +
      'and I also need '.repeat(45),
    'The date is June fifteenth. No, the date is June fifth, ' +
      'and we should ask '.repeat(45),
    'I want that appointment. Actually, I do not want that appointment, ' +
      'and the reason is '.repeat(45),
    'Earlier complete sentence. '.repeat(40) +
      'I do not want the fifteenth. I have an unfinished',
  ]) {
    assert.ok(raw.length > CALL_CONTEXT_MAX_ENTRY_CHARACTERS);
    assert.equal(recentWholeContext(raw), undefined);
  }
  assert.deepEqual(
    recentWholeContext(
      'I need three rooms. Actually, not three rooms, I need two rooms, ',
    ),
    {
      text: 'I need three rooms. Actually, not three rooms, I need two rooms, ',
    },
  );
});

test('close clears one call and rejects late callbacks; age is tied to visible observation', () => {
  const context = createCallContext();
  context.observe(observation({ final: false, observedAt: 120010 }));
  assert.equal(context.snapshot({ beforeAt: 120011 }).entries.length, 1);
  assert.equal(context.snapshot({ beforeAt: 240011 }).entries.length, 0);
  context.close();
  assert.equal(context.observe(observation()), false);
  assert.deepEqual(context.snapshot({ beforeAt: 120011 }).entries, []);
});

test('late prior ASR finals need an earlier trusted endpoint; later and provisional words remain excluded', () => {
  const context = createCallContext();
  context.observe(
    observation({ sourceId: 'prior', final: false, text: 'I want Tuesday.' }),
  );
  context.observe(
    observation({
      role: 'local',
      sourceId: 'native',
      sourceKind: 'native_output',
      at: 5,
      observedAt: 8,
      order: 0,
      final: false,
      text: 'Earlier generated observation.',
    }),
  );
  const frozen = context.snapshot({ beforeAt: 20 });
  context.observe(
    observation({
      sourceId: 'prior',
      revision: 2,
      observedAt: 40,
      sourceEndAt: 15,
      text: 'I do not want Tuesday.',
    }),
  );
  context.observe(
    observation({
      role: 'local',
      sourceId: 'native',
      sourceKind: 'native_output',
      at: 5,
      observedAt: 40,
      order: 0,
      revision: 2,
      final: true,
      sourceEndAt: 15,
      text: 'Later generated words.',
    }),
  );
  for (const [id, at, end] of [
    ['future', 30, 35],
    ['overlap', 11, 25],
    ['equal_endpoint', 12, 20],
    ['no_endpoint', 13, undefined],
  ] as const) {
    const unproven = createCallContext();
    unproven.observe(
      observation({
        sourceId: id,
        at,
        observedAt: 40,
        order: at,
        sourceEndAt: end,
        text: `${id} words.`,
      }),
    );
    assert.deepEqual(
      unproven.snapshot({
        beforeAt: 20,
        observedBeforeAt: 45,
        allowLateFinal: true,
      }).entries,
      [],
    );
  }
  const late = context.snapshot({
    beforeAt: 20,
    observedBeforeAt: 45,
    allowLateFinal: true,
  });
  assert.deepEqual(
    late.entries.map((row) => row.text),
    ['Earlier generated observation.', 'I do not want Tuesday.'],
  );
  assert.deepEqual(
    frozen.entries.map((row) => row.text),
    ['Earlier generated observation.', 'I want Tuesday.'],
  );
  assert.equal(
    context.observe(
      observation({
        sourceId: 'prior',
        revision: 3,
        observedAt: 46,
        sourceEndAt: 16,
      }),
    ),
    false,
  );
  assert.equal(
    context.observe(
      observation({ sourceId: 'invalid', observedAt: 40, sourceEndAt: 50 }),
    ),
    false,
  );
});

test('trusted late empty or unbounded finals are tombstones, and a boundary-only revision is not swallowed', () => {
  const context = createCallContext();
  context.observe(observation({ final: false, text: 'An obsolete draft.' }));
  context.observe(
    observation({ observedAt: 40, sourceEndAt: 15, revision: 2, text: '' }),
  );
  assert.deepEqual(
    context.snapshot({
      beforeAt: 20,
      observedBeforeAt: 45,
      allowLateFinal: true,
    }).entries,
    [],
  );
  context.observe(
    observation({
      sourceId: 'big',
      final: false,
      text: 'Another obsolete draft.',
    }),
  );
  context.observe(
    observation({
      sourceId: 'big',
      observedAt: 40,
      sourceEndAt: 15,
      revision: 2,
      text: 'x'.repeat(700),
    }),
  );
  assert.deepEqual(
    context.snapshot({
      beforeAt: 20,
      observedBeforeAt: 45,
      allowLateFinal: true,
    }).entries,
    [],
  );
  context.observe(observation({ sourceId: 'boundary', observedAt: 40 }));
  assert.equal(
    context.observe(
      observation({ sourceId: 'boundary', observedAt: 41, sourceEndAt: 15 }),
    ),
    true,
  );
  assert.equal(
    context.snapshot({
      beforeAt: 20,
      observedBeforeAt: 45,
      allowLateFinal: true,
    }).entries[0].sourceEndAt,
    15,
  );
});

test('evicted older sources cannot evict recent sources or refresh an expired endpoint by arriving late', () => {
  const context = createCallContext();
  for (let at = 20; at < 25; at += 1)
    context.observe(
      observation({ sourceId: `new_${at}`, at, observedAt: at, order: at }),
    );
  context.observe(
    observation({
      sourceId: 'retired',
      at: 1,
      observedAt: 30,
      order: 99,
      sourceEndAt: 2,
    }),
  );
  assert.ok(
    !context
      .snapshot({ beforeAt: 40 })
      .entries.some((row) => row.sourceId === 'retired'),
  );
  const old = createCallContext();
  old.observe(observation({ at: 1, observedAt: 180000, sourceEndAt: 2 }));
  assert.deepEqual(
    old.snapshot({
      beforeAt: 170000,
      observedBeforeAt: 180000,
      allowLateFinal: true,
    }).entries,
    [],
  );
});

test('unchanged high revisions advance the fence against late number and negation corrections', () => {
  for (const [latestText, staleText] of [
    ['Fifteen.', 'Fifty.'],
    ['I do not want that.', 'I want that.'],
  ]) {
    const context = createCallContext();
    context.observe(observation({ final: false, text: latestText }));
    assert.equal(
      context.observe(
        observation({
          final: false,
          text: latestText,
          revision: 3,
          observedAt: 30,
        }),
      ),
      true,
    );
    assert.equal(
      context.observe(
        observation({
          final: false,
          text: staleText,
          revision: 2,
          observedAt: 40,
        }),
      ),
      false,
    );
    assert.equal(
      context.snapshot({ beforeAt: 50 }).entries[0].text,
      latestText,
    );
    assert.equal(context.snapshot({ beforeAt: 50 }).entries[0].revision, 3);
    context.observe(
      observation({
        final: false,
        text: staleText,
        revision: 4,
        observedAt: 50,
      }),
    );
    context.observe(
      observation({
        final: false,
        text: latestText,
        revision: 5,
        observedAt: 60,
      }),
    );
    assert.equal(
      context.observe(
        observation({
          final: false,
          text: staleText,
          revision: 4,
          observedAt: 70,
        }),
      ),
      false,
    );
    assert.equal(
      context.snapshot({ beforeAt: 80 }).entries[0].text,
      latestText,
    );
    assert.equal(context.snapshot({ beforeAt: 80 }).entries[0].revision, 5);
  }
});

test('a continuing partial section clears its old endpoint before later final proof can be used', () => {
  const context = createCallContext();
  context.observe(
    observation({
      final: false,
      sourceEndAt: 15,
      observedAt: 16,
      text: 'We should ask for the',
    }),
  );
  assert.equal(
    context.observe(
      observation({
        final: false,
        revision: 2,
        observedAt: 25,
        text: 'We should ask for the two rooms',
      }),
    ),
    true,
  );
  assert.equal(
    context.snapshot({ beforeAt: 30 }).entries[0].sourceEndAt,
    undefined,
  );
  assert.equal(
    context.snapshot({
      beforeAt: 20,
      observedBeforeAt: 30,
      allowLateFinal: true,
    }).entries[0].text,
    'We should ask for the',
  );
  assert.equal(
    context.observe(
      observation({
        revision: 3,
        observedAt: 40,
        sourceEndAt: 35,
        text: 'We should ask for the two rooms, not three.',
      }),
    ),
    true,
  );
  assert.equal(
    context.snapshot({
      beforeAt: 30,
      observedBeforeAt: 45,
      allowLateFinal: true,
    }).entries[0].text,
    'We should ask for the two rooms',
  );
  assert.equal(
    context.snapshot({
      beforeAt: 36,
      observedBeforeAt: 45,
      allowLateFinal: true,
    }).entries[0].text,
    'We should ask for the two rooms, not three.',
  );
  assert.equal(
    context.observe(
      observation({
        revision: 4,
        observedAt: 46,
        sourceEndAt: 34,
        text: 'An incompatible boundary.',
      }),
    ),
    false,
  );
});
