import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTranslationEngineSelection, translationEngineLabel, translationReadiness, usesNanoVoice } from '../public/translation-engine.js';
import { isTranslationEngine } from '../src/solo/translation-engine.js';

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
  assert.equal(translationEngineLabel('nano-captions'), '英文原声＋中文字幕');
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

test('original audio and captions is opt-in, advertised, session-locked and a supported server engine', () => {
  const selection = createTranslationEngineSelection();
  selection.update({ engines: [...engines, 'continuous-nano'], session: null, locked: false });
  assert.equal(selection.select('nano-captions'), false);
  const available = [...engines, 'continuous-nano', 'nano-captions'];
  selection.update({ engines: available, session: null, locked: false });
  assert.equal(selection.snapshot.value, 'legacy');
  assert.equal(selection.select('nano-captions'), true);
  selection.update({ engines: available, session: { translationEngine: 'nano-captions' }, locked: false });
  assert.equal(selection.snapshot.sessionEngine, 'nano-captions');
  assert.equal(selection.select('legacy'), false);
  selection.update({ engines: available, session: { translationEngine: 'legacy' }, locked: false });
  assert.equal(selection.snapshot.value, 'legacy');
  assert.equal(selection.snapshot.selected, 'nano-captions');
  assert.equal(createTranslationEngineSelection().snapshot.value, 'legacy');
  assert.equal(isTranslationEngine('nano-captions'), true);
  assert.equal(usesNanoVoice('nano-captions'), true);
  assert.equal(usesNanoVoice('legacy'), false);
});

test('caption availability does not gate audio readiness or claim generated Chinese audio', () => {
  const session = { status: 'active', translationEngine: 'nano-captions', captionState: 'failed' };
  assert.equal(translationReadiness(session).ready, false);
  const ready = translationReadiness({ ...session, translationReady: true });
  assert.equal(ready.ready, true);
  assert.match(ready.label, /英文原声已就绪/);
  assert.match(ready.instruction, /直接听英文原声.*中英字幕.*字幕状态单独显示/);
});
