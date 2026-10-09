import { createConversationModel } from './conversation-model.js';
import { createConversationView } from './conversation-view.js';
import { conversationFixture, historyFixtureEvents } from './conversation-fixtures.js';

const $ = id => document.getElementById(id);
let model = createConversationModel(conversationFixture.sessionId);
let cursor = 0;
let replay = null;
let historyBatch = 0;
const view = createConversationView({
  container: $('transcript'), scrollContainer: $('transcript-scroll'),
  emptyNode: $('empty-conversation'), latestButton: $('conversation-latest'),
  historyStatus: $('conversation-history-status'),
});
function render() {
  const utterances = model.getUtterances();
  view.render(utterances);
  $('demo-count').textContent = `${utterances.length} 句`;
  $('demo-step').disabled = cursor >= conversationFixture.steps.length;
  $('demo-all').disabled = cursor >= conversationFixture.steps.length;
  $('demo-play').disabled = cursor >= conversationFixture.steps.length && !replay;
}
function pause() { clearInterval(replay); replay = null; $('demo-play').textContent = '自动重放'; }
function step() {
  const current = conversationFixture.steps[cursor++];
  if (!current) { pause(); render(); return; }
  model.apply(current.event);
  $('demo-progress').textContent = `事件 ${cursor}/${conversationFixture.steps.length} · ${current.label}`;
  if (cursor === conversationFixture.steps.length) pause();
  render();
}
$('demo-step').addEventListener('click', () => { pause(); step(); });
$('demo-play').addEventListener('click', () => {
  if (replay) { pause(); return; }
  $('demo-play').textContent = '暂停重放';
  replay = setInterval(step, 650); step();
});
$('demo-all').addEventListener('click', () => { pause(); while (cursor < conversationFixture.steps.length) step(); });
$('demo-history').addEventListener('click', () => {
  pause();
  for (const event of historyFixtureEvents()) {
    model.apply({ ...event, utteranceId: `${event.utteranceId}-batch-${historyBatch}`, at: event.at + historyBatch * 60000, sequence: event.sequence + historyBatch * 30 });
  }
  historyBatch += 1;
  $('demo-progress').textContent = `已追加 ${historyBatch * 30} 句历史；向上滚动可暂停跟随。`;
  render();
});
function reset() {
  pause(); cursor = 0; historyBatch = 0;
  model = createConversationModel(conversationFixture.sessionId); view.reset();
  $('demo-progress').textContent = '等待重放模拟事件。'; render();
}
$('demo-reset').addEventListener('click', reset);
// Introspection is limited to the offline replay and never touches phone APIs.
window.conversationDemo = {
  apply(event) { const changed = model.apply(event); if (changed) render(); return changed; },
  snapshot: () => model.getUtterances(),
  fixture: conversationFixture, step, reset,
  get following() { return view.following; },
};
window.addEventListener('pagehide', () => { pause(); view.dispose(); });
render();
