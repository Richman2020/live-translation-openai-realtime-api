import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ConversationSpeakerTurns,
  type ConversationSource,
} from '../src/solo/conversation-speaker-turns';

function original(
  registry: ConversationSpeakerTurns,
  sourceId: string,
  role: ConversationSource['role'],
  at: number,
  text: string,
  revision = 1,
) {
  const accepted = registry.acceptOriginal({
    sourceId,
    role,
    at,
    text,
    revision,
  });
  assert.equal(accepted.accepted, true);
  assert.ok(accepted.binding);
  return accepted;
}

test('completed fragments, pauses and long same-speaker speech retain one display turn', () => {
  const registry = new ConversationSpeakerTurns();
  const first = original(registry, 'first', 'remote', 10, 'For the');
  const continuation = original(
    registry,
    'next',
    'remote',
    9000,
    'collection. I mean the corrected description.',
  );
  const long = original(
    registry,
    'article',
    'remote',
    190000,
    'A long continuous article. '.repeat(400),
  );
  assert.equal(first.binding.speakerTurnId, continuation.binding.speakerTurnId);
  assert.equal(first.binding.speakerTurnId, long.binding.speakerTurnId);
  assert.equal(long.binding.speakerTurnSequence, 1);
  assert.equal(continuation.updates.length, 0);
  assert.equal(long.updates.length, 0);
});

test('effective A-B-A speech creates three blocks, without merging both A turns', () => {
  const registry = new ConversationSpeakerTurns();
  const a = original(registry, 'a', 'local', 10, '我先说');
  const b = original(registry, 'b', 'remote', 20, 'I reply.');
  const nextA = original(registry, 'next-a', 'local', 30, '我再回答');
  assert.deepEqual(
    [a.binding, b.binding, nextA.binding].map(
      (binding) => binding.speakerTurnSequence,
    ),
    [1, 2, 3],
  );
  assert.equal(
    new Set(
      [a.binding, b.binding, nextA.binding].map(
        (binding) => binding.speakerTurnId,
      ),
    ).size,
    3,
  );
  assert.equal(
    registry.currentTurn().speakerTurnId,
    nextA.binding.speakerTurnId,
  );
});

test('source registration, empty text and punctuation never seize the current speaker', () => {
  const registry = new ConversationSpeakerTurns();
  const first = original(registry, 'local', 'local', 10, '继续');
  assert.equal(
    registry.registerSource({ sourceId: 'unspoken', role: 'remote', at: 20 }),
    true,
  );
  for (const [index, text] of ['', '   ', '...?!', '—……'].entries()) {
    const result = registry.acceptOriginal({
      sourceId: 'unspoken',
      role: 'remote',
      at: 20,
      text,
      revision: index,
    });
    assert.equal(result.accepted, false);
    assert.equal(result.binding, undefined);
  }
  assert.equal(registry.lookup('unspoken', 'remote'), undefined);
  const continuation = original(registry, 'next', 'local', 30, '仍是同一方');
  assert.equal(first.binding.speakerTurnId, continuation.binding.speakerTurnId);
});

test('late translation uses its exact old source without switching the current turn', () => {
  const registry = new ConversationSpeakerTurns();
  const firstA = original(registry, 'a', 'local', 10, '早先内容');
  original(registry, 'b', 'remote', 20, 'Reply.');
  const currentA = original(registry, 'later-a', 'local', 30, '现在内容');
  assert.deepEqual(registry.lookup('a', 'local'), firstA.binding);
  assert.equal(registry.lookup('a', 'remote'), undefined);
  assert.equal(registry.lookup('unbound-native-output', 'local'), undefined);
  assert.equal(
    registry.currentTurn().speakerTurnId,
    currentA.binding.speakerTurnId,
  );
});

test('a late original between known A sources splits the provisional turn and returns correction metadata', () => {
  const registry = new ConversationSpeakerTurns();
  const firstA = original(registry, 'a', 'local', 10, 'First A.');
  assert.equal(
    registry.registerSource({ sourceId: 'late-b', role: 'remote', at: 20 }),
    true,
  );
  const provisionalA = original(
    registry,
    'next-a',
    'local',
    30,
    'Following A.',
  );
  assert.equal(
    firstA.binding.speakerTurnId,
    provisionalA.binding.speakerTurnId,
  );
  const lateB = original(registry, 'late-b', 'remote', 20, 'Delayed B.');
  assert.equal(lateB.binding.speakerTurnSequence, 2);
  assert.equal(lateB.updates.length, 1);
  const correctedA = lateB.updates[0];
  assert.equal(correctedA.sourceId, 'next-a');
  assert.equal(correctedA.role, 'local');
  assert.equal(correctedA.at, 30);
  assert.equal(correctedA.binding.speakerTurnSequence, 3);
  assert.notEqual(
    correctedA.binding.speakerTurnId,
    firstA.binding.speakerTurnId,
  );
  assert.ok(
    correctedA.binding.speakerTurnRevision >
      provisionalA.binding.speakerTurnRevision,
  );
  assert.equal(
    registry.currentTurn().speakerTurnId,
    correctedA.binding.speakerTurnId,
  );
});

test('a late earlier original is ordered by source time and corrects existing block order', () => {
  const registry = new ConversationSpeakerTurns();
  const later = original(registry, 'later', 'remote', 30, 'Already visible.');
  const earliest = original(
    registry,
    'earlier',
    'local',
    10,
    'Earlier source.',
  );
  assert.equal(earliest.binding.speakerTurnSequence, 1);
  assert.equal(earliest.updates.length, 1);
  assert.equal(earliest.updates[0].sourceId, 'later');
  assert.equal(earliest.updates[0].binding.speakerTurnSequence, 2);
  assert.equal(
    earliest.updates[0].binding.speakerTurnId,
    later.binding.speakerTurnId,
  );
  assert.equal(registry.currentTurn().role, 'remote');
});

test('registered original order supplies a stable tie breaker for equal timestamps', () => {
  const registry = new ConversationSpeakerTurns();
  registry.registerSource({ sourceId: 'a', role: 'local', at: 100 });
  registry.registerSource({ sourceId: 'b', role: 'remote', at: 100 });
  registry.registerSource({ sourceId: 'c', role: 'local', at: 100 });
  original(registry, 'c', 'local', 100, 'Third source arrives first.');
  original(registry, 'b', 'remote', 100, 'Second source arrives next.');
  original(registry, 'a', 'local', 100, 'First source arrives last.');
  assert.deepEqual(
    ['a', 'b', 'c'].map(
      (id, index) =>
        registry.lookup(id, index === 1 ? 'remote' : 'local')
          .speakerTurnSequence,
    ),
    [1, 2, 3],
  );
  assert.equal(
    registry.currentTurn().speakerTurnId,
    registry.lookup('c', 'local').speakerTurnId,
  );
});

test('identical supplier source IDs from different directions are isolated', () => {
  const registry = new ConversationSpeakerTurns();
  const a = original(registry, 'supplier-1', 'local', 10, '我说');
  const b = original(registry, 'supplier-1', 'remote', 20, 'I say.');
  assert.notEqual(a.binding.speakerTurnId, b.binding.speakerTurnId);
  assert.deepEqual(registry.lookup('supplier-1', 'local'), a.binding);
  assert.deepEqual(registry.lookup('supplier-1', 'remote'), b.binding);
});

test('stale or duplicate original revisions cannot rebind an old source or seize the turn', () => {
  const registry = new ConversationSpeakerTurns();
  const a = original(registry, 'a', 'local', 10, 'No, twenty dollars.', 3);
  const b = original(registry, 'b', 'remote', 20, 'Understood.', 1);
  for (const revision of [2, 3]) {
    const rejected = registry.acceptOriginal({
      sourceId: 'a',
      role: 'local',
      at: 10,
      text: 'Stale numbers must not replace current content.',
      revision,
    });
    assert.equal(rejected.accepted, false);
    assert.deepEqual(rejected.binding, a.binding);
    assert.equal(rejected.updates.length, 0);
  }
  assert.equal(registry.currentTurn().speakerTurnId, b.binding.speakerTurnId);
  const update = original(registry, 'a', 'local', 10, 'No, thirty dollars.', 4);
  assert.deepEqual(update.binding, a.binding);
  assert.equal(registry.currentTurn().speakerTurnId, b.binding.speakerTurnId);
});

test('an existing source timestamp is immutable even when a later result changes it', () => {
  const registry = new ConversationSpeakerTurns();
  const first = original(registry, 'source', 'local', 10, 'Original.');
  const rejected = registry.acceptOriginal({
    sourceId: 'source',
    role: 'local',
    at: 50,
    text: 'Wrong timestamp.',
    revision: 2,
  });
  assert.equal(rejected.accepted, false);
  assert.deepEqual(registry.lookup('source', 'local'), first.binding);
});

test('ten thousand source sections keep bounded metadata and never revive evicted anchors', () => {
  const registry = new ConversationSpeakerTurns({ maxSources: 8 });
  const first = original(registry, 'part-0', 'remote', 1, 'First section.');
  let latest = first;
  for (let index = 1; index < 10000; index += 1) {
    latest = original(
      registry,
      `part-${index}`,
      'remote',
      index * 1000 + 1,
      'Following section.',
    );
    assert.ok(registry.retainedSourceCount() <= 8);
    assert.equal(latest.binding.speakerTurnId, first.binding.speakerTurnId);
  }
  assert.equal(registry.lookup('part-0', 'remote'), undefined);
  assert.equal(registry.lookup('part-9989', 'remote'), undefined);
  assert.equal(registry.lookup('part-9999', 'remote').speakerTurnSequence, 1);
  assert.equal(
    registry.acceptOriginal({
      sourceId: 'part-0',
      role: 'remote',
      at: 1,
      text: 'Late old source.',
      revision: 200,
    }).accepted,
    false,
  );
  assert.deepEqual(registry.lookup('part-9999', 'remote'), latest.binding);
});

test('bounded retirement preserves A-B-A boundaries and chronological numbering', () => {
  const registry = new ConversationSpeakerTurns({ maxSources: 2 });
  original(registry, 'a', 'local', 10, 'A.');
  const b = original(registry, 'b', 'remote', 20, 'B.');
  const nextA = original(registry, 'next-a', 'local', 30, 'Next A.');
  assert.equal(registry.lookup('a', 'local'), undefined);
  assert.deepEqual(registry.lookup('b', 'remote'), b.binding);
  assert.equal(nextA.binding.speakerTurnSequence, 3);
  const anotherA = original(registry, 'continuation', 'local', 40, 'Still A.');
  assert.equal(anotherA.binding.speakerTurnId, nextA.binding.speakerTurnId);
  assert.equal(anotherA.binding.speakerTurnSequence, 3);
  assert.equal(registry.retainedSourceCount(), 2);
});

test('retired timestamp collisions conservatively stay unbound rather than reusing an old turn', () => {
  const registry = new ConversationSpeakerTurns({ maxSources: 1 });
  original(registry, 'old', 'local', 10, 'Old.');
  original(registry, 'retained', 'remote', 20, 'Retained.');
  assert.equal(
    registry.registerSource({ sourceId: 'unknown-old', role: 'local', at: 10 }),
    false,
  );
  assert.equal(registry.lookup('unknown-old', 'local'), undefined);
  assert.equal(registry.currentTurn().role, 'remote');
});

test('turn lookup cannot mutate internal bindings and lifecycle cleanup does not reuse IDs', () => {
  const registry = new ConversationSpeakerTurns();
  const first = original(registry, 'id', 'local', 10, 'First.');
  const returned = registry.lookup('id', 'local');
  returned.speakerTurnId = 'tampered';
  returned.speakerTurnRevision = 999;
  assert.deepEqual(registry.lookup('id', 'local'), first.binding);
  registry.clear();
  assert.equal(registry.retainedSourceCount(), 0);
  assert.equal(registry.lookup('id', 'local'), undefined);
  assert.equal(registry.currentTurn(), undefined);
  const next = original(registry, 'id', 'local', 10, 'After cleanup.');
  assert.notEqual(next.binding.speakerTurnId, first.binding.speakerTurnId);
  assert.ok(
    next.binding.speakerTurnRevision > first.binding.speakerTurnRevision,
  );
});

test('invalid source metadata and revision never create a display turn', () => {
  const registry = new ConversationSpeakerTurns();
  for (const at of [NaN, Infinity, -1, 0.5])
    assert.equal(
      registry.registerSource({ sourceId: 'source', role: 'local', at }),
      false,
    );
  for (const sourceId of ['', 'invalid\nsource', 'x'.repeat(513)])
    assert.equal(
      registry.registerSource({ sourceId, role: 'local', at: 1 }),
      false,
    );
  for (const revision of [-1, NaN, Infinity, 1.5])
    assert.equal(
      registry.acceptOriginal({
        sourceId: 'valid',
        role: 'local',
        at: 10,
        text: 'Present.',
        revision,
      }).accepted,
      false,
    );
  assert.equal(registry.retainedSourceCount(), 0);
  assert.equal(registry.currentTurn(), undefined);
  for (const maxSources of [0, 8193, NaN, 1.5])
    assert.throws(
      () => new ConversationSpeakerTurns({ maxSources }),
      RangeError,
    );
});

test('registry stores source metadata without retaining raw call text', () => {
  const registry = new ConversationSpeakerTurns();
  original(registry, 'source', 'local', 10, 'PRIVATE_RAW_CALL_TEXT_123');
  const maps = Object.values(registry).filter((value) => value instanceof Map);
  assert.equal(maps.length, 1);
  assert.equal(
    JSON.stringify([...maps[0].values()]).includes('PRIVATE_RAW_CALL_TEXT_123'),
    false,
  );
});

test('withdrawal of an empty final original merges same-side sources and returns newer binding corrections', () => {
  const registry = new ConversationSpeakerTurns();
  const firstA = original(registry, 'a', 'local', 10, 'First A.');
  original(registry, 'b', 'remote', 20, 'Draft B.');
  const nextA = original(registry, 'next-a', 'local', 30, 'Following A.');
  assert.equal(nextA.binding.speakerTurnSequence, 3);
  const withdrawal = {
    sourceId: 'b',
    role: 'remote' as const,
    at: 20,
    text: '',
    revision: 2,
    final: true,
  };
  const result = registry.acceptOriginal(withdrawal);
  assert.equal(result.accepted, true);
  assert.equal(result.binding, undefined);
  assert.equal(registry.lookup('b', 'remote'), undefined);
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0].sourceId, 'next-a');
  assert.equal(
    result.updates[0].binding.speakerTurnId,
    firstA.binding.speakerTurnId,
  );
  assert.equal(result.updates[0].binding.speakerTurnSequence, 1);
  assert.ok(
    result.updates[0].binding.speakerTurnRevision >
      nextA.binding.speakerTurnRevision,
  );
  assert.equal(
    registry.currentTurn().speakerTurnId,
    firstA.binding.speakerTurnId,
  );
});

test('withdrawal of a punctuation-only final original does not leave a ghost speaker boundary', () => {
  const registry = new ConversationSpeakerTurns();
  const firstA = original(registry, 'a', 'local', 10, 'First A.');
  original(registry, 'b', 'remote', 20, 'Draft B.');
  const withdrawal = {
    sourceId: 'b',
    role: 'remote' as const,
    at: 20,
    text: ' ...?! —— ',
    revision: 2,
    final: true,
  };
  const result = registry.acceptOriginal(withdrawal);
  assert.equal(result.accepted, true);
  assert.equal(registry.lookup('b', 'remote'), undefined);
  assert.equal(
    registry.currentTurn().speakerTurnId,
    firstA.binding.speakerTurnId,
  );
  const nextA = original(registry, 'next-a', 'local', 30, 'Following A.');
  assert.equal(nextA.binding.speakerTurnId, firstA.binding.speakerTurnId);
});

test('a temporary empty draft and stale empty final do not withdraw established speech', () => {
  const registry = new ConversationSpeakerTurns();
  original(registry, 'a', 'local', 10, 'A.');
  const b = original(registry, 'b', 'remote', 20, 'Confirmed source draft.');
  const emptyDraft = {
    sourceId: 'b',
    role: 'remote' as const,
    at: 20,
    text: '',
    revision: 2,
    final: false,
  };
  assert.equal(registry.acceptOriginal(emptyDraft).accepted, false);
  assert.deepEqual(registry.lookup('b', 'remote'), b.binding);
  assert.equal(
    registry.acceptOriginal({ ...emptyDraft, final: true }).accepted,
    false,
  );
  assert.deepEqual(registry.lookup('b', 'remote'), b.binding);
  const nextA = original(registry, 'next-a', 'local', 30, 'Next A.');
  assert.equal(nextA.binding.speakerTurnSequence, 3);
});

test('a withdrawn source remains unbound to late translations and reactivates only with newer valid raw at its original position', () => {
  const registry = new ConversationSpeakerTurns();
  const firstA = original(registry, 'a', 'local', 10, 'First A.');
  const draftB = original(registry, 'b', 'remote', 20, 'Draft B.');
  const nextA = original(registry, 'next-a', 'local', 30, 'Following A.');
  const withdrawal = {
    sourceId: 'b',
    role: 'remote' as const,
    at: 20,
    text: '',
    revision: 2,
    final: true,
  };
  registry.acceptOriginal(withdrawal);
  assert.equal(registry.lookup('b', 'remote'), undefined);
  assert.equal(registry.lookup('b', 'local'), undefined);
  assert.equal(
    registry.currentTurn().speakerTurnId,
    firstA.binding.speakerTurnId,
  );
  assert.equal(
    registry.acceptOriginal({ ...withdrawal, text: 'Old draft.', revision: 1 })
      .accepted,
    false,
  );
  assert.equal(registry.lookup('b', 'remote'), undefined);
  const reactivatedB = original(
    registry,
    'b',
    'remote',
    20,
    'Actual corrected B.',
    3,
  );
  assert.equal(
    reactivatedB.binding.speakerTurnId,
    draftB.binding.speakerTurnId,
  );
  assert.equal(reactivatedB.binding.speakerTurnSequence, 2);
  assert.ok(
    reactivatedB.binding.speakerTurnRevision >
      draftB.binding.speakerTurnRevision,
  );
  assert.equal(reactivatedB.updates.length, 1);
  assert.equal(reactivatedB.updates[0].sourceId, 'next-a');
  assert.equal(
    reactivatedB.updates[0].binding.speakerTurnId,
    nextA.binding.speakerTurnId,
  );
  assert.equal(
    registry.currentTurn().speakerTurnId,
    nextA.binding.speakerTurnId,
  );
});
