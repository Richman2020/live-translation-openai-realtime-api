import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adaptTranscriptEvent,
  createConversationModel,
  splitSemanticText,
  type ConversationTextEvent,
  type ConversationPlaybackEvent,
} from '../public/conversation-model.js';
import { ConversationEventAdapter } from '../src/solo/conversation-events';

const text = (changes: Partial<ConversationTextEvent> = {}): ConversationTextEvent => ({
  type: 'text', sessionId: 'call-a', utteranceId: 'local:u1:0', role: 'local',
  kind: 'original', text: '我想预约明天下午三点。', final: false, revision: 1,
  at: 100, sequence: 1, pairing: 'explicit', boundary: 'semantic', ...changes,
});
const playback = (changes: Partial<ConversationPlaybackEvent> = {}): ConversationPlaybackEvent => ({
  type: 'playback', sessionId: 'call-a', utteranceId: 'local:u1:0', role: 'local',
  status: 'queued', revision: 1, evidence: 'none', at: 100, sequence: 1, ...changes,
});

test('delayed paired translation stays at its source slot around an interruption', () => {
  const model = createConversationModel({ sessionId: 'call-a' });
  model.apply(text());
  model.apply(text({ utteranceId: 'remote:r1:0', role: 'remote', text: 'Wait, did you say three?', at: 150, sequence: 2 }));
  model.apply(text({ utteranceId: 'local:u2:0', text: '不是三点，是四点。', at: 200, sequence: 3 }));
  model.apply(text({ kind: 'translation', text: "I'd like to book tomorrow at three.", final: true, at: 100 }));
  const rows = model.getUtterances();
  assert.deepEqual(rows.map(row => row.id), ['local:u1:0', 'remote:r1:0', 'local:u2:0']);
  assert.equal(rows[0].translation?.text, "I'd like to book tomorrow at three.");
  assert.equal(rows.length, 3);
});

test('source and translation revisions finalize independently without stale draft regression', () => {
  const model = createConversationModel('call-a');
  model.apply(text({ final: true, revision: 2 }));
  model.apply(text({ kind: 'translation', text: 'Tomorrow at', revision: 5 }));
  assert.equal(model.apply(text({ revision: 1, text: '昨天' })), false);
  assert.equal(model.apply(text({ revision: 3, final: false, text: '昨天' })), false);
  assert.equal(model.apply(text({ kind: 'translation', revision: 4, text: 'Yesterday' })), false);
  model.apply(text({ kind: 'translation', text: 'Tomorrow at three.', final: true, revision: 6 }));
  assert.deepEqual(model.snapshot()[0].translation, { text: 'Tomorrow at three.', final: true, revision: 6 });
  assert.equal(model.snapshot()[0].original?.revision, 2);
});

test('cross-call IDs and conflicting speaker reuse cannot modify a conversation', () => {
  const a = createConversationModel('call-a');
  const b = createConversationModel('call-b');
  a.apply(text());
  assert.equal(a.apply(text({ sessionId: 'call-b', revision: 2, text: 'wrong call' })), false);
  assert.equal(a.apply(text({ role: 'remote', revision: 2, text: 'wrong role' })), false);
  assert.equal(b.apply(text()), false);
  assert.equal(a.snapshot()[0].original?.text, '我想预约明天下午三点。');
  assert.deepEqual(b.snapshot(), []);
});

test('a late original supplies the source time for a translation-only placeholder', () => {
  const model = createConversationModel('call-a');
  model.apply(text({ kind: 'translation', at: 300, text: 'Four, not three.', final: true }));
  model.apply(text({ utteranceId: 'remote:r1:0', role: 'remote', at: 200, text: 'Three?' }));
  model.apply(text({ at: 100 }));
  assert.deepEqual(model.snapshot().map(row => row.at), [100, 200]);
});

test('older explicit turn IDs pair; continuous excerpts and different prefix IDs stay unpaired', () => {
  const model = createConversationModel('call-a');
  const old = { sessionId: 'call-a', role: 'remote', final: false, at: 100 };
  model.applyTranscript({ ...old, id: 'remote:original:turn1:0', kind: 'original', text: 'Hello' });
  model.applyTranscript({ ...old, id: 'remote:translation:turn1:0', kind: 'translation', text: '你好' });
  model.applyTranscript({ ...old, id: 'remote:original:turn1:0', kind: 'original', text: 'Hello there', final: true });
  assert.equal(model.snapshot().length, 1);
  assert.equal(model.snapshot()[0].original?.text, 'Hello there');
  assert.equal(adaptTranscriptEvent({ ...old, id: 'continuous_remote_0', kind: 'translation', text: '你好' })?.pairing, 'unpaired');
  model.applyTranscript({ ...old, role: 'local', id: 'local:original:asr1:0', kind: 'original', text: '你好，我想预约' });
  model.applyTranscript({ ...old, role: 'local', id: 'local:translation:prefix_1:0', kind: 'translation', text: 'Hello' });
  assert.equal(model.snapshot().length, 3);
});

test('all delivery marks and the sealed producer count are required before whole-utterance played', () => {
  const model = createConversationModel('call-a');
  model.apply(text());
  model.apply(playback());
  assert.equal(model.snapshot()[0].playback.status, 'queued');
  // The producer seal can arrive ahead of one delivery's earlier events.
  model.apply(playback({ status: 'sent', revision: 2, sealed: true, expectedDeliveryCount: 2 }));
  model.apply(playback({ status: 'played', evidence: 'twilio_mark', deliveryId: 'd1' }));
  assert.equal(model.snapshot()[0].playback.status, 'sent');
  model.apply(playback({ deliveryId: 'd2', evidence: 'transport' }));
  assert.equal(model.snapshot()[0].playback.status, 'queued');
  model.apply(playback({ deliveryId: 'd2', status: 'sent', evidence: 'transport', revision: 2 }));
  assert.equal(model.snapshot()[0].playback.status, 'sent');
  model.apply(playback({ deliveryId: 'd2', status: 'played', evidence: 'twilio_mark', revision: 3 }));
  assert.equal(model.snapshot()[0].playback.status, 'played');
  assert.equal(model.snapshot()[0].playback.evidence, 'twilio_mark');
  assert.equal(model.apply(playback({ deliveryId: 'd2', status: 'sent', evidence: 'transport', revision: 99 })), false);
});

test('send completion cannot assert played, and marks without a producer watermark stay pending', () => {
  const model = createConversationModel('call-a');
  model.apply(text());
  assert.equal(model.apply(playback({ status: 'played', evidence: 'transport', deliveryId: 'd1' })), false);
  assert.equal(model.apply(playback({ status: 'sent', sealed: true })), false);
  model.apply(playback({ status: 'played', evidence: 'twilio_mark', deliveryId: 'd1' }));
  assert.equal(model.snapshot()[0].playback.status, 'sent');
});

test('cancelled queued work and sent-but-unconfirmed deliveries remain distinct at cleanup', () => {
  const model = createConversationModel('call-a');
  model.apply(text());
  model.apply(playback());
  model.apply(playback({ status: 'cancelled', revision: 2 }));
  assert.equal(model.snapshot()[0].playback.status, 'cancelled');
  model.apply(playback({ deliveryId: 'd1', status: 'unconfirmed', evidence: 'transport' }));
  assert.equal(model.snapshot()[0].playback.status, 'unconfirmed');
});

test('final empty caption cancellation hides the row while retaining revision tombstones', () => {
  const model = createConversationModel('call-a');
  model.apply(text({ text: 'noise' }));
  model.apply(text({ kind: 'translation', text: '噪声' }));
  model.apply(text({ text: '', final: true, revision: 2 }));
  model.apply(text({ kind: 'translation', text: '', final: true, revision: 2 }));
  assert.deepEqual(model.snapshot(), []);
  assert.equal(model.apply(text({ revision: 1 })), false);
  assert.deepEqual(model.snapshot(), []);
});

test('semantic display sections preserve decimals, negations and every input character', () => {
  const source = '请预约明天下午四点。不是三点！价格是3.5美元；不要加糖。';
  assert.deepEqual(splitSemanticText(source), ['请预约明天下午四点。', '不是三点！', '价格是3.5美元；', '不要加糖。']);
  const english = 'It costs 3.5 dollars. No sugar, please! Tomorrow at four, not three.';
  assert.equal(splitSemanticText(english).join(''), english);
  assert.equal(splitSemanticText(source).join(''), source);
});

test('a higher-revision caption correction can restore an empty-final tombstone as a draft', () => {
  const model = createConversationModel('call-a');
  model.apply(text({ text: '', final: true }));
  assert.equal(model.getUtterance('local:u1:0'), null);
  assert.equal(model.apply(text({ revision: 2, text: '新的正确字幕', final: false })), true);
  assert.equal(model.getUtterance('local:u1:0')?.original?.text, '新的正确字幕');
  assert.equal(model.getLastChange()?.orderChanged, true);
  assert.equal(model.getLastChange()?.event.revision, 2);
  model.apply(text({ revision: 3, text: '新的正确字幕。', final: true }));
  assert.equal(model.apply(text({ revision: 4, text: '迟到草稿', final: false })), false);
});

test('single-utterance snapshots and accepted event revisions support constant-time UI updates', () => {
  const model = createConversationModel('call-a');
  model.applyTranscript({ id: 'local:original:u1:0', role: 'local', kind: 'original', text: '初稿', final: false, at: 100 });
  const first = model.getUtterance('local:u1:0');
  assert.equal(model.getLastChange()?.orderChanged, true);
  model.applyTranscript({ id: 'local:original:u1:0', role: 'local', kind: 'original', text: '修订', final: false, at: 100 });
  assert.equal(model.getLastChange()?.orderChanged, false);
  assert.equal(model.getLastChange()?.event.revision, 2);
  assert.notEqual(first, model.getUtterance('local:u1:0'));
  assert.equal(model.getUtterance('local:u1:0'), model.getUtterance('local:u1:0'));
  assert.equal(first?.original?.text, '初稿', 'prior frozen snapshot remains unchanged');
});

test('ordinary revisions reuse chronological ordering for a long conversation', () => {
  const model = createConversationModel('call-a');
  for (let index = 0; index < 150; index += 1) model.apply(text({ utteranceId: `u${index}`, at: index, sequence: index }));
  model.snapshot();
  const originalSort = Array.prototype.sort;
  let sorts = 0;
  Array.prototype.sort = function (...args: any[]) { sorts += 1; return originalSort.apply(this, args as any); };
  try {
    for (let revision = 2; revision <= 201; revision += 1) {
      model.apply(text({ utteranceId: 'u149', at: 149, sequence: 149, revision, text: `revision ${revision}` }));
      model.snapshot();
    }
  } finally { Array.prototype.sort = originalSort; }
  assert.equal(sorts, 0);
  assert.equal(model.snapshot().length, 150);
});

test('session adapter emits independent revisions and refuses audio with no semantic correlation', () => {
  const adapter = new ConversationEventAdapter('call-a', () => 100);
  const input = { id: 'remote:original:turn1:0', role: 'remote' as const, kind: 'original' as const, text: 'Hello', final: false, at: 50 };
  const first = adapter.transcript(input);
  const second = adapter.transcript({ ...input, text: 'Hello there', final: true });
  assert.equal(first?.revision, 1);
  assert.equal(second?.revision, 2);
  const translation = adapter.transcript({ ...input, id: 'remote:translation:turn1:0', kind: 'translation', text: '你好', at: 300 });
  assert.equal(translation?.at, 50);
  assert.equal(translation?.revision, 1);
  assert.equal(adapter.audio({ role: 'local', recipientRole: 'remote', stage: 'sent', generatedBytes: 100, sentBytes: 100, deliveryId: 'd1' }), null);
});
