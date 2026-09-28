import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTranslationEngineSelection, translationEngineLabel, translationReadiness } from '../public/translation-engine.js';

const engines = ['legacy', 'continuous'];

test('engine selection starts with the current version and only uses server-advertised options', () => {
  const selection = createTranslationEngineSelection();
  assert.equal(selection.snapshot.value, 'legacy');
  assert.equal(selection.select('continuous'), false);
  selection.update({ engines: ['legacy'], session: null, locked: false });
  assert.equal(selection.select('continuous'), false);
  selection.update({ engines, session: null, locked: false });
  assert.equal(selection.select('continuous'), true);
  assert.equal(selection.select('invented'), false);
  assert.equal(selection.snapshot.value, 'continuous');
  assert.equal(createTranslationEngineSelection().snapshot.value, 'legacy');
});

test('dialing, verification, saving and cleanup locks cannot change the selected engine', () => {
  const selection = createTranslationEngineSelection();
  selection.update({ engines, session: null, locked: false });
  selection.select('continuous');
  selection.update({ engines, session: null, locked: true });
  assert.equal(selection.select('legacy'), false);
  assert.equal(selection.snapshot.value, 'continuous');
  selection.update({ engines, session: null, locked: false });
  assert.equal(selection.select('legacy'), true);
});

test('an active incoming call shows the server engine without replacing the next outgoing choice', () => {
  const selection = createTranslationEngineSelection();
  selection.update({ engines, session: null, locked: false });
  selection.select('continuous');
  selection.update({ engines, session: { translationEngine: 'legacy' }, locked: false });
  assert.equal(selection.snapshot.value, 'legacy');
  assert.equal(selection.snapshot.sessionEngine, 'legacy');
  assert.equal(selection.snapshot.selected, 'continuous');
  assert.equal(selection.select('continuous'), false);
  selection.update({ engines, session: null, locked: false });
  assert.equal(selection.snapshot.value, 'continuous');
});

test('capability removal falls back safely and returned lists cannot modify availability', () => {
  const selection = createTranslationEngineSelection();
  selection.update({ engines, session: null, locked: false });
  selection.select('continuous');
  selection.snapshot.available.length = 0;
  assert.equal(selection.select('legacy'), true);
  selection.select('continuous');
  selection.update({ engines: undefined, session: null, locked: false });
  assert.equal(selection.snapshot.value, 'legacy');
  assert.equal(selection.select('continuous'), false);
});

test('connected phone legs never imply translation readiness, including old service snapshots', () => {
  assert.equal(translationReadiness({ status: 'ringing', translationReady: true }), null);
  for (const value of [undefined, false, 'true', 1]) {
    const message = translationReadiness({ status: 'active', translationReady: value });
    assert.equal(message.ready, false);
    assert.match(message.instruction, /请等就绪后说话/);
  }
  assert.equal(translationReadiness({ status: 'active', translationReady: true }).ready, true);
  assert.equal(translationReadiness({ status: 'active', translationReady: false }).ready, false);
  assert.equal(translationReadiness({ status: 'completed', translationReady: true }), null);
});

test('history labels distinguish both engines and avoid inferring old missing metadata', () => {
  assert.equal(translationEngineLabel('legacy'), '当前版本');
  assert.equal(translationEngineLabel('continuous'), '连续翻译实验版');
  assert.equal(translationEngineLabel('continuous-nano'), '本人声线实验版');
  assert.equal(translationEngineLabel(undefined), '版本未记录');
});

test('own voice is opt-in, server-advertised and locked to the active call', () => {
  const selection = createTranslationEngineSelection();
  selection.update({ engines, session: null, locked: false });
  assert.equal(selection.select('continuous-nano'), false);
  selection.update({ engines: [...engines, 'continuous-nano'], session: null, locked: false });
  assert.equal(selection.snapshot.value, 'legacy');
  assert.equal(selection.select('continuous-nano'), true);
  selection.update({ engines: [...engines, 'continuous-nano'], session: { translationEngine: 'continuous-nano' }, locked: false });
  assert.equal(selection.snapshot.sessionEngine, 'continuous-nano');
  assert.equal(selection.select('legacy'), false);
  assert.equal(createTranslationEngineSelection().snapshot.value, 'legacy');
});

test('own voice readiness requires explicit server readiness and explains sentence synthesis', () => {
  const pending = translationReadiness({ status: 'active', translationEngine: 'continuous-nano' });
  assert.equal(pending.ready, false);
  assert.match(pending.label, /本人声线准备中/);
  assert.match(pending.instruction, /请等就绪后说话/);
  const ready = translationReadiness({ status: 'active', translationEngine: 'continuous-nano', translationReady: true });
  assert.equal(ready.ready, true);
  assert.match(ready.instruction, /明确句尾.*分句合成后播放/);
});
