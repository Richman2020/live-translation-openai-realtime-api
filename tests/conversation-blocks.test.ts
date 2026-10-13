import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adaptTranscriptEvent,
  createConversationModel,
  groupConversationUtterances,
  type ConversationTextEvent,
} from '../public/conversation-model.js';

const source = (
  id: string,
  role: 'local' | 'remote',
  at: number,
  changes: Partial<ConversationTextEvent> = {},
): ConversationTextEvent => ({
  type: 'text',
  sessionId: 'block-call',
  utteranceId: id,
  role,
  kind: 'original',
  text: role === 'local' ? '我需要两间房。' : 'Please confirm two rooms.',
  final: false,
  revision: 1,
  at,
  sequence: at,
  pairing: 'explicit',
  boundary: 'semantic',
  ...changes,
});
const blocks = (model: ReturnType<typeof createConversationModel>) =>
  groupConversationUtterances(model.getUtterances());

test('provider finals and semantic sections stay as paragraphs within one same-speaker block', () => {
  const model = createConversationModel('block-call');
  for (let index = 1; index <= 3; index += 1)
    model.apply(
      source(`section-${index}`, 'remote', index, {
        final: true,
        speakerTurnId: 'remote-one',
        speakerTurnSequence: 1,
        speakerTurnRevision: 1,
        speakerSourceSequence: index,
      }),
    );
  assert.equal(blocks(model).length, 1);
  assert.deepEqual(
    blocks(model)[0].utterances.map((row) => row.id),
    ['section-1', 'section-2', 'section-3'],
  );
  assert.ok(blocks(model)[0].utterances.every((row) => row.original?.final));
});

test('late A translation updates its original block and never joins the later A after B', () => {
  const model = createConversationModel('block-call');
  const a = source('a-first', 'local', 100, {
    speakerTurnId: 'a1',
    speakerTurnSequence: 1,
    speakerTurnRevision: 1,
  });
  model.apply(a);
  model.apply(
    source('b', 'remote', 200, {
      speakerTurnId: 'b1',
      speakerTurnSequence: 2,
      speakerTurnRevision: 1,
    }),
  );
  model.apply(
    source('a-again', 'local', 300, {
      speakerTurnId: 'a2',
      speakerTurnSequence: 3,
      speakerTurnRevision: 1,
    }),
  );
  model.apply({
    ...a,
    kind: 'translation',
    text: 'I need two rooms.',
    final: true,
    at: 900,
    revision: 2,
  });
  const grouped = blocks(model);
  assert.deepEqual(
    grouped.map((block) => block.role),
    ['local', 'remote', 'local'],
  );
  assert.equal(grouped[0].utterances[0].translation?.text, 'I need two rooms.');
  assert.equal(grouped[2].utterances[0].translation, null);
});

test('same source timestamp uses registration order instead of late arrival order within a block', () => {
  const model = createConversationModel('block-call');
  const binding = {
    speakerTurnId: 'remote-one',
    speakerTurnSequence: 1,
    speakerTurnRevision: 1,
  };
  model.apply(
    source('second', 'remote', 100, {
      ...binding,
      speakerSourceSequence: 2,
      sequence: 1,
    }),
  );
  model.apply(
    source('first', 'remote', 100, {
      ...binding,
      speakerSourceSequence: 1,
      sequence: 99,
    }),
  );
  assert.deepEqual(
    model.getUtterances().map((row) => row.id),
    ['first', 'second'],
  );
  assert.deepEqual(
    blocks(model)[0].utterances.map((row) => row.id),
    ['first', 'second'],
  );
});

test('legacy fallback only changes speaker at nonempty original source and is corrected by a late original', () => {
  const model = createConversationModel('block-call');
  model.apply(source('a-before', 'local', 100));
  const b = source('b', 'remote', 150, {
    kind: 'translation',
    text: '请等一下。',
  });
  model.apply(b);
  model.apply(source('a-after', 'local', 200));
  assert.equal(
    blocks(model).filter((block) => !block.sourceUnassigned).length,
    1,
  );
  model.apply({ ...b, kind: 'original', text: 'Please wait.', revision: 1 });
  assert.equal(model.getLastChange()?.orderChanged, true);
  assert.deepEqual(
    blocks(model).map((block) => block.role),
    ['local', 'remote', 'local'],
  );
});

test('unbound native output is an auxiliary stream and cannot switch or seize a source block', () => {
  const model = createConversationModel('block-call');
  model.apply(source('a-before', 'local', 100));
  model.apply(source('b', 'remote', 200));
  model.apply(source('a-after', 'local', 300));
  model.applyTranscript({
    id: 'native_old',
    role: 'local',
    kind: 'translation',
    text: 'An earlier generated phrase.',
    at: 1000,
    final: false,
    pairing: 'unpaired',
    boundary: 'diagnostic',
    captionSource: 'native_output',
    audioCorrespondence: 'generated_only',
  });
  const grouped = blocks(model);
  assert.deepEqual(
    grouped
      .filter((block) => !block.sourceUnassigned)
      .map((block) => block.utterances.map((row) => row.id)),
    [['a-before'], ['b'], ['a-after']],
  );
  const auxiliary = grouped.find((block) => block.sourceUnassigned);
  assert.equal(auxiliary?.utterances[0].pairing, 'unpaired');
  assert.equal(auxiliary?.utterances[0].playback.status, 'unknown');
});

test('unbound translated excerpts never guess a source by role or timestamp or merge across an interruption', () => {
  const model = createConversationModel('block-call');
  model.apply(source('a-before', 'local', 100));
  model.apply(
    source('unknown-first', 'local', 100, {
      kind: 'translation',
      text: 'Possibly earlier.',
    }),
  );
  model.apply(source('b', 'remote', 200));
  model.apply(source('a-after', 'local', 300));
  model.apply(
    source('unknown-after', 'local', 300, {
      kind: 'translation',
      text: 'Possibly later.',
    }),
  );
  const grouped = blocks(model);
  assert.deepEqual(
    grouped
      .filter((block) => !block.sourceUnassigned)
      .map((block) => block.utterances.map((row) => row.id)),
    [['a-before'], ['b'], ['a-after']],
  );
  assert.deepEqual(
    grouped
      .filter((block) => block.sourceUnassigned)
      .map((block) => block.utterances.map((row) => row.id)),
    [['unknown-first'], ['unknown-after']],
  );
});

test('a higher binding epoch can correct a same-revision paragraph without rolling back its body or playback', () => {
  const model = createConversationModel('block-call');
  const original = source('a-later', 'local', 300, {
    final: true,
    sourceRevision: 2,
    speakerTurnId: 'a-one',
    speakerTurnSequence: 1,
    speakerTurnRevision: 1,
    speakerSourceSequence: 3,
  });
  model.apply(original);
  model.apply({
    type: 'playback',
    sessionId: 'block-call',
    utteranceId: 'a-later',
    role: 'local',
    status: 'queued',
    revision: 1,
    evidence: 'none',
    at: 300,
    sequence: 3,
  });
  const corrected = {
    ...original,
    speakerTurnId: 'a-after-b',
    speakerTurnSequence: 3,
    speakerTurnRevision: 2,
  };
  assert.equal(model.apply(corrected), true);
  assert.equal(model.getLastChange()?.orderChanged, true);
  assert.equal(model.getUtterance('a-later')?.original?.revision, 1);
  assert.equal(model.getUtterance('a-later')?.playback.status, 'queued');
  assert.equal(
    model.apply({ ...original, revision: 99, text: '旧绑定迟到正文' }),
    false,
  );
  assert.equal(
    model.apply({
      ...corrected,
      speakerTurnRevision: 3,
      text: '同文本版本不能换正文',
    }),
    false,
  );
  assert.equal(model.getUtterance('a-later')?.original?.text, original.text);
});

test('binding-only replay cannot erase conservative display or apply another speaker', () => {
  const model = createConversationModel('block-call');
  const original = source('raw', 'remote', 100, {
    text: 'the the room',
    displayText: 'the room',
    normalization: 'conservative',
    sourceRevision: 1,
    speakerTurnId: 'r',
    speakerTurnSequence: 1,
    speakerTurnRevision: 1,
  });
  model.apply(original);
  assert.equal(model.apply({ ...original, speakerTurnRevision: 2 }), true);
  assert.equal(
    model.apply({
      ...original,
      speakerTurnId: 'r2',
      speakerTurnSequence: 2,
      speakerTurnRevision: 3,
      displayText: undefined,
      normalization: undefined,
    }),
    false,
  );
  assert.equal(
    model.apply({ ...original, role: 'local', speakerTurnRevision: 3 }),
    false,
  );
  assert.equal(model.getUtterance('raw')?.original?.text, 'the the room');
  assert.equal(model.getUtterance('raw')?.original?.displayText, 'the room');
});

test('versioned speaker bindings reject missing metadata without losing the corrected epoch or source order', () => {
  const original = source('a-later', 'local', 300, {
    final: true,
    sourceRevision: 2,
    speakerTurnId: 'a-one',
    speakerTurnSequence: 1,
    speakerTurnRevision: 1,
    speakerSourceSequence: 3,
  });
  const corrected = {
    ...original,
    speakerTurnId: 'a-after-b',
    speakerTurnSequence: 3,
    speakerTurnRevision: 2,
  };
  for (const omitted of [
    {
      speakerTurnId: undefined,
      speakerTurnSequence: undefined,
      speakerTurnRevision: undefined,
      speakerSourceSequence: undefined,
    },
    { speakerTurnRevision: undefined },
    { speakerSourceSequence: undefined },
    { speakerTurnId: undefined },
    { speakerTurnSequence: undefined },
  ]) {
    const model = createConversationModel('block-call');
    model.apply(original);
    model.apply(corrected);
    assert.equal(
      model.apply({ ...corrected, revision: 20, ...omitted }),
      false,
      `omitted binding fields: ${Object.keys(omitted).join(',')}`,
    );
    assert.equal(model.getUtterance('a-later')?.speakerTurnRevision, 2);
    assert.equal(model.getUtterance('a-later')?.speakerSourceSequence, 3);
    assert.equal(
      model.apply({ ...original, revision: 99 }),
      false,
      'an old binding cannot exploit a missing-metadata replay',
    );
    assert.equal(model.getUtterance('a-later')?.speakerTurnId, 'a-after-b');
    assert.equal(model.getUtterance('a-later')?.original?.revision, 1);
    assert.equal(
      model.apply({ ...corrected, revision: 21 }),
      true,
      'complete current binding still accepts a newer text event',
    );
  }
});

test('an unknown-version translation received first stays pending when a versioned original later arrives', () => {
  const model = createConversationModel('block-call');
  const translated = source('translation-first', 'remote', 100, {
    kind: 'translation',
    final: true,
    text: '三间房',
  });
  model.apply(translated);
  assert.equal(
    model.getUtterance('translation-first')?.translation?.text,
    '三间房',
  );
  model.apply({
    ...translated,
    kind: 'original',
    sourceRevision: 3,
    text: 'not three rooms, two rooms',
  });
  assert.equal(model.getUtterance('translation-first')?.translation, null);
  assert.equal(
    model.getUtterance('translation-first')?.translationPending,
    true,
  );
  assert.equal(
    model.apply({ ...translated, revision: 2, text: '未知版本再次迟到' }),
    false,
  );
  assert.equal(
    model.apply({
      ...translated,
      revision: 2,
      sourceRevision: 3,
      text: '不是三间房，是两间房。',
    }),
    true,
  );
  assert.equal(
    model.getUtterance('translation-first')?.translation?.text,
    '不是三间房，是两间房。',
  );
  assert.equal(
    model.getUtterance('translation-first')?.translationPending,
    undefined,
  );
});

test('withdrawn final raw hides the whole paragraph despite old Chinese text, retains evidence and may reactivate at its source time', () => {
  for (const cancelledText of ['', '？！ …']) {
    const model = createConversationModel('block-call');
    const a1 = source('a-first', 'local', 100, {
      final: true,
      sourceRevision: 1,
      speakerTurnId: 'a1',
      speakerTurnSequence: 1,
      speakerTurnRevision: 1,
      speakerSourceSequence: 1,
    });
    const b = source('b', 'remote', 200, {
      sourceRevision: 1,
      text: 'misheard fragment',
      speakerTurnId: 'b',
      speakerTurnSequence: 2,
      speakerTurnRevision: 2,
      speakerSourceSequence: 2,
    });
    const a2 = source('a-last', 'local', 300, {
      final: true,
      sourceRevision: 1,
      speakerTurnId: 'a2',
      speakerTurnSequence: 3,
      speakerTurnRevision: 3,
      speakerSourceSequence: 3,
    });
    model.apply(a1);
    model.apply(b);
    model.apply({
      ...b,
      kind: 'translation',
      text: '旧的中文字幕',
      final: true,
    });
    model.apply(a2);
    assert.equal(blocks(model).length, 3);
    model.apply({
      ...b,
      text: cancelledText,
      final: true,
      revision: 2,
      sourceRevision: 2,
    });
    model.apply({
      ...a2,
      speakerTurnId: 'a1',
      speakerTurnSequence: 1,
      speakerTurnRevision: 4,
    });
    assert.deepEqual(
      model.snapshot().map((row) => row.id),
      ['a-first', 'a-last'],
    );
    assert.deepEqual(
      blocks(model).map((block) => block.utterances.map((row) => row.id)),
      [['a-first', 'a-last']],
    );
    const evidence = model.getUtterance('b');
    assert.equal(evidence?.sourceWithdrawn, true);
    assert.equal(evidence?.original?.text, cancelledText);
    assert.equal(evidence?.original?.sourceRevision, 2);
    assert.equal(
      groupConversationUtterances([evidence!]).length,
      0,
      'audit lookup cannot recreate a withdrawn speaker card',
    );
    assert.equal(
      model.apply({
        ...b,
        kind: 'translation',
        revision: 99,
        text: '晚到旧中文',
        final: true,
      }),
      false,
    );
    const restored = {
      ...b,
      text: 'Please confirm two rooms.',
      revision: 3,
      sourceRevision: 3,
      speakerTurnRevision: 5,
    };
    assert.equal(model.apply(restored), true);
    model.apply({ ...a2, speakerTurnRevision: 5 });
    assert.equal(model.getUtterance('b')?.sourceWithdrawn, undefined);
    assert.equal(model.getUtterance('b')?.at, 200);
    assert.deepEqual(
      blocks(model).map((block) => block.role),
      ['local', 'remote', 'local'],
    );
    assert.equal(
      model.getUtterance('b')?.translation,
      null,
      'old Chinese cannot match the reactivated raw',
    );
    assert.equal(
      model.apply({
        ...restored,
        kind: 'translation',
        revision: 2,
        text: '请确认两间房。',
      }),
      true,
    );
    assert.equal(model.getUtterance('b')?.translation?.text, '请确认两间房。');
  }
});

test('legacy translation-only auxiliary text survives while a final punctuation-only source is withdrawn', () => {
  const model = createConversationModel('block-call');
  model.apply(
    source('orphan', 'remote', 100, {
      kind: 'translation',
      text: '仅翻译来源尚未知',
      final: true,
    }),
  );
  model.apply(
    source('punctuation', 'remote', 200, { text: '？！', final: true }),
  );
  assert.deepEqual(
    model.snapshot().map((row) => row.id),
    ['orphan'],
  );
  assert.equal(blocks(model)[0].sourceUnassigned, true);
});

test('future-source translation remains pending until its corresponding source arrives', () => {
  const model = createConversationModel('block-call');
  const original = source('changing', 'remote', 100, {
    sourceRevision: 2,
    text: 'two rooms',
  });
  model.apply(original);
  const translated = {
    ...original,
    kind: 'translation' as const,
    sourceRevision: 3,
    text: '不是三间，而是两间。',
    final: true,
  };
  assert.equal(model.apply(translated), true);
  assert.equal(model.getUtterance('changing')?.translation, null);
  assert.equal(model.getUtterance('changing')?.translationPending, true);
  model.apply({
    ...original,
    revision: 2,
    sourceRevision: 3,
    text: 'not three rooms, two rooms',
    final: true,
  });
  assert.equal(
    model.getUtterance('changing')?.translation?.text,
    '不是三间，而是两间。',
  );
  assert.equal(model.getUtterance('changing')?.translationPending, undefined);
});

test('older raw, display and translated source revisions cannot override a newer source', () => {
  const model = createConversationModel('block-call');
  const original = source('changing', 'remote', 100, {
    sourceRevision: 3,
    text: 'not three rooms',
  });
  model.apply(original);
  assert.equal(
    model.apply({
      ...original,
      revision: 20,
      sourceRevision: 2,
      text: 'three rooms',
      displayText: 'three rooms',
      normalization: 'conservative',
    }),
    false,
  );
  assert.equal(
    model.apply({
      ...original,
      kind: 'translation',
      revision: 20,
      sourceRevision: 2,
      text: '三间房',
    }),
    false,
  );
  assert.equal(
    model.getUtterance('changing')?.original?.text,
    'not three rooms',
  );
});

test('dropping source-version metadata cannot bypass a versioned source or its translation fence', () => {
  const model = createConversationModel('block-call');
  const original = source('changing', 'remote', 100, {
    sourceRevision: 3,
    text: 'not three rooms',
  });
  model.apply(original);
  assert.equal(
    model.apply({
      ...original,
      revision: 20,
      sourceRevision: undefined,
      text: 'three rooms',
    }),
    false,
  );
  assert.equal(
    model.apply({
      ...original,
      kind: 'translation',
      revision: 20,
      sourceRevision: undefined,
      text: '三间房',
    }),
    false,
  );
  assert.equal(model.getUtterance('changing')?.original?.sourceRevision, 3);
  assert.equal(model.getUtterance('changing')?.translation, null);
  // Older providers that never supplied source revisions retain their explicit-ID pairing.
  const legacy = source('legacy', 'remote', 200);
  assert.equal(model.apply(legacy), true);
  assert.equal(
    model.apply({ ...legacy, kind: 'translation', text: '请确认两间房。' }),
    true,
  );
});

test('a genuinely newer source revision may show a new Chinese draft after the older source was final', () => {
  const model = createConversationModel('block-call');
  const original = source('changing', 'remote', 100, {
    sourceRevision: 1,
    final: true,
    text: 'three rooms',
  });
  model.apply(original);
  model.apply({ ...original, kind: 'translation', text: '三间房' });
  assert.equal(
    model.apply({
      ...original,
      revision: 2,
      sourceRevision: 2,
      final: false,
      text: 'not three rooms, two rooms',
    }),
    true,
  );
  assert.equal(model.getUtterance('changing')?.translationPending, true);
  assert.equal(
    model.apply({
      ...original,
      kind: 'translation',
      revision: 2,
      sourceRevision: 2,
      final: false,
      text: '不是三间',
    }),
    true,
  );
  assert.equal(model.getUtterance('changing')?.translation?.text, '不是三间');
  assert.equal(model.getUtterance('changing')?.translation?.final, false);
  assert.equal(
    model.apply({
      ...original,
      kind: 'translation',
      revision: 99,
      sourceRevision: 1,
      final: true,
      text: '旧的三间',
    }),
    false,
  );
});

test('raw recognition and conservative display remain independently inspectable in immutable snapshots', () => {
  const model = createConversationModel('block-call');
  const original = source('raw', 'remote', 100, {
    text: 'I I need two rooms',
    sourceRevision: 1,
  });
  model.apply(original);
  const before = model.getUtterance('raw');
  model.apply({
    ...original,
    revision: 2,
    displayText: 'I need two rooms',
    normalization: 'conservative',
  });
  const after = model.getUtterance('raw');
  assert.equal(after?.original?.text, 'I I need two rooms');
  assert.equal(after?.original?.displayText, 'I need two rooms');
  assert.equal(after?.original?.normalization, 'conservative');
  assert.equal(before?.original?.displayText, undefined);
});

test('invalid turn metadata and cross-call events cannot acquire a speaker block', () => {
  const model = createConversationModel('block-call');
  assert.equal(
    model.apply(source('bad', 'local', 100, { speakerTurnSequence: 1 })),
    false,
  );
  assert.equal(
    model.apply(
      source('bad', 'local', 100, {
        speakerTurnId: 'a',
        speakerTurnSequence: 0,
      }),
    ),
    false,
  );
  assert.equal(
    model.apply(source('bad', 'local', 100, { sourceRevision: 0 })),
    false,
  );
  assert.equal(
    model.apply(source('bad', 'local', 100, { sessionId: 'other-call' })),
    false,
  );
  assert.equal(
    adaptTranscriptEvent({
      id: 'bad',
      sessionId: 'block-call',
      role: 'local',
      kind: 'original',
      text: '原话',
      at: 100,
      speakerTurnSequence: 1,
    }),
    null,
  );
  assert.deepEqual(blocks(model), []);
});
