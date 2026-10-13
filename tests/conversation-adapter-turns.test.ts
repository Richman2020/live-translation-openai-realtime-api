import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createConversationModel,
  groupConversationUtterances,
} from '../public/conversation-model.js';
import { ConversationEventAdapter } from '../src/solo/conversation-events';
import type { TranscriptEvent } from '../src/solo/translation-bridge';

function fixture() {
  const adapter = new ConversationEventAdapter('call-a');
  const model = createConversationModel('call-a');
  const push = (value: TranscriptEvent) => {
    const event = adapter.transcript(value);
    if (event) assert.equal(model.apply(event), true);
    const updates = adapter.takeTurnUpdates();
    for (const update of updates) assert.equal(model.apply(update), true);
    return { event, updates };
  };
  const blocks = () => groupConversationUtterances(model.snapshot());
  return { adapter, model, push, blocks };
}

const source = (
  role: 'local' | 'remote',
  id: string,
  at: number,
  text: string,
  extra: Partial<TranscriptEvent> = {},
): TranscriptEvent => ({
  id: `${role}:original:${id}:0`,
  utteranceId: `${role}:${id}:0`,
  role,
  kind: 'original',
  text,
  at,
  final: true,
  revision: 1,
  sourceRevision: 1,
  pairing: 'explicit',
  boundary: 'semantic',
  ...extra,
});

test('provider finals and semantic paragraphs remain in one continuous speaker block', () => {
  const f = fixture();
  f.push(source('remote', 'first', 100, 'I would like to change the date.'));
  f.push(source('remote', 'second', 200, 'No, the fifteenth, not the fifth.'));
  f.push(source('remote', 'third', 300, 'And keep the amount at two fifty.'));
  assert.equal(f.blocks().length, 1);
  assert.deepEqual(
    f.blocks()[0].utterances.map((row) => row.original?.text),
    [
      'I would like to change the date.',
      'No, the fifteenth, not the fifth.',
      'And keep the amount at two fifty.',
    ],
  );
});

test('late source interruption splits A-B-A with metadata-only revisions of existing text', () => {
  const f = fixture();
  f.push(source('local', 'a1', 100, '我要十五日。'));
  const a2 = f.push(source('local', 'a2', 300, '不是第五日。'));
  assert.equal(f.blocks().length, 1);
  const late = f.push(source('remote', 'b1', 200, 'Did you mean the fifth?'));
  assert.equal(late.updates.length, 1);
  assert.equal(late.updates[0].text, a2.event?.text);
  assert.equal(late.updates[0].revision, a2.event?.revision);
  assert.ok(
    late.updates[0].speakerTurnRevision! > a2.event!.speakerTurnRevision!,
  );
  assert.deepEqual(
    f.blocks().map((block) => block.role),
    ['local', 'remote', 'local'],
  );
  assert.deepEqual(
    f.blocks().map((block) => block.utterances[0].original?.text),
    ['我要十五日。', 'Did you mean the fifth?', '不是第五日。'],
  );
  assert.equal(
    f.model.snapshot().length,
    3,
    'binding correction does not duplicate the text',
  );
});

test('delayed translation updates its original block without switching the active speaker', () => {
  const f = fixture();
  const original = source('remote', 'a1', 100, 'Not fifty, fifteen.');
  f.push(original);
  f.push(source('local', 'b1', 200, '我明白了。'));
  f.push(source('remote', 'a2', 300, 'Please keep that correction.'));
  const translated = f.push({
    ...original,
    id: 'remote:translation:a1:0',
    kind: 'translation',
    text: '不是五十，是十五。',
    at: 900,
  });
  assert.equal(translated.event?.at, 100);
  assert.equal(translated.event?.speakerTurnSequence, 1);
  assert.deepEqual(
    f.blocks().map((block) => block.role),
    ['remote', 'local', 'remote'],
  );
  assert.equal(
    f.blocks()[0].utterances[0].translation?.text,
    '不是五十，是十五。',
  );
});

test('translation-first placeholders receive the later original source time and binding', () => {
  const f = fixture();
  const original = source('remote', 'a1', 100, 'June fifteenth.');
  f.push({
    ...original,
    id: 'remote:translation:a1:0',
    kind: 'translation',
    text: '六月十五日。',
    at: 400,
  });
  f.push(source('local', 'b1', 200, '哪一天？'));
  f.push(original);
  assert.deepEqual(
    f.blocks().map((block) => block.role),
    ['remote', 'local'],
  );
  assert.equal(f.blocks()[0].utterances[0].at, 100);
  assert.equal(f.blocks()[0].utterances[0].translation?.text, '六月十五日。');
});

test('rejected old originals cannot create an interruption or rebinding event', () => {
  const f = fixture();
  const original = source('remote', 'a1', 100, 'Do not change the date.', {
    revision: 2,
    sourceRevision: 2,
  });
  f.push(original);
  f.push(source('local', 'b1', 200, '好的。'));
  const stale = f.push({
    ...original,
    revision: 1,
    sourceRevision: 1,
    text: 'Change the date.',
  });
  assert.equal(stale.event, null);
  assert.deepEqual(stale.updates, []);
  assert.deepEqual(
    f.blocks().map((block) => block.role),
    ['remote', 'local'],
  );
  assert.equal(f.model.snapshot()[0].original?.text, 'Do not change the date.');
});

test('raw and conservative display text retain one version without changing the heard words', () => {
  const f = fixture();
  f.push(
    source('remote', 'a1', 100, 'I I I need the fifteenth, not the fifth.', {
      displayText: 'I need the fifteenth, not the fifth.',
      normalization: 'conservative',
    }),
  );
  const row = f.model.snapshot()[0];
  assert.equal(row.original?.text, 'I I I need the fifteenth, not the fifth.');
  assert.equal(
    row.original?.displayText,
    'I need the fifteenth, not the fifth.',
  );
  assert.equal(row.original?.sourceRevision, 1);
});

test('unpaired native output never impersonates a source-turn or claims audio pairing', () => {
  const f = fixture();
  f.push(source('remote', 'a1', 100, 'Tell me the date.'));
  const native = f.push({
    id: 'continuous_local_0',
    role: 'local',
    kind: 'translation',
    text: 'The fifteenth.',
    final: false,
    at: 200,
    pairing: 'unpaired',
    boundary: 'diagnostic',
    captionSource: 'native_output',
    audioCorrespondence: 'generated_only',
  } as TranscriptEvent);
  assert.equal(native.event?.speakerTurnId, undefined);
  assert.equal(native.event?.pairing, 'unpaired');
  assert.equal(f.blocks()[0].role, 'remote');
  assert.equal(f.blocks().at(-1)?.sourceUnassigned, true);
});

test('a withdrawn final ASR fragment removes a ghost interruption without reviving late translation', () => {
  const f = fixture();
  f.push(source('local', 'a1', 100, '我要继续说下去。'));
  const mistaken = source('remote', 'noise', 200, 'misheard noise', {
    final: false,
  });
  f.push(mistaken);
  f.push(source('local', 'a2', 300, '这是同一次发言。'));
  assert.deepEqual(
    f
      .blocks()
      .filter((block) => !block.sourceUnassigned)
      .map((block) => block.role),
    ['local', 'remote', 'local'],
  );
  const withdrawn = f.push({
    ...mistaken,
    text: '',
    final: true,
    revision: 2,
    sourceRevision: 2,
  });
  assert.equal(
    withdrawn.updates.length,
    1,
    'the later A source moves into its actual continuous block',
  );
  assert.deepEqual(
    f
      .blocks()
      .filter((block) => !block.sourceUnassigned)
      .map((block) => block.role),
    ['local'],
  );
  assert.deepEqual(
    f.blocks()[0].utterances.map((row) => row.original?.text),
    ['我要继续说下去。', '这是同一次发言。'],
  );
  const stale = f.push({
    ...mistaken,
    id: 'remote:translation:noise:0',
    kind: 'translation',
    text: '旧错误识别的中文',
    final: true,
    revision: 1,
    sourceRevision: 1,
  });
  assert.equal(stale.event, null);
  assert.deepEqual(
    f
      .blocks()
      .filter((block) => !block.sourceUnassigned)
      .map((block) => block.role),
    ['local'],
  );
});

test('source withdrawal hides already translated Chinese, merges A blocks, and a newer valid raw reactivates the original position', () => {
  for (const withdrawnText of ['', '？！ …']) {
    const f = fixture();
    f.push(source('local', 'before', 100, '我要继续说下去。'));
    const b = source('remote', 'withdrawn', 200, 'misheard fragment', {
      final: false,
    });
    f.push(b);
    f.push({
      ...b,
      id: 'remote:translation:withdrawn:0',
      kind: 'translation',
      text: '已经显示的旧中文字幕',
      final: true,
    });
    f.push(source('local', 'after', 300, '这是同一次发言。'));
    assert.equal(f.blocks().length, 3);
    f.push({
      ...b,
      text: withdrawnText,
      final: true,
      revision: 2,
      sourceRevision: 2,
    });
    assert.deepEqual(
      f.blocks().map((block) => block.utterances.map((row) => row.id)),
      [['local:before:0', 'local:after:0']],
    );
    assert.equal(
      f.model.getUtterance('remote:withdrawn:0')?.original?.text,
      withdrawnText,
    );
    assert.equal(
      f.model.getUtterance('remote:withdrawn:0')?.sourceWithdrawn,
      true,
    );
    assert.equal(
      f.push({
        ...b,
        id: 'remote:translation:withdrawn:0',
        kind: 'translation',
        text: '晚到旧字幕',
        final: true,
        revision: 99,
      }).event,
      null,
    );
    const restored = f.push({
      ...b,
      text: 'Please confirm two rooms.',
      revision: 3,
      sourceRevision: 3,
    });
    assert.equal(restored.event?.at, 200);
    assert.deepEqual(
      f.blocks().map((block) => block.role),
      ['local', 'remote', 'local'],
    );
    assert.equal(f.model.getUtterance('remote:withdrawn:0')?.translation, null);
    f.push({
      ...b,
      id: 'remote:translation:withdrawn:0',
      kind: 'translation',
      text: '请确认两间房。',
      revision: 2,
      sourceRevision: 3,
    });
    assert.equal(
      f.model.getUtterance('remote:withdrawn:0')?.translation?.text,
      '请确认两间房。',
    );
  }
});
