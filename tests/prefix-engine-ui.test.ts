import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTranslationEngineSelection,
  translationEngineLabel,
  translationReadiness,
  usesLocalVoice,
  usesPocketVoice,
  usesRemoteCaptions,
} from '../public/translation-engine.js';
import {
  isTranslationEngine,
  usesPocketVoice as serverPocket,
  usesRemoteCaptions as serverCaptions,
} from '../src/solo/translation-engine';

test('prefix candidate is advertised explicitly and preserves incoming/default choices', () => {
  const selection = createTranslationEngineSelection();
  assert.equal(selection.snapshot.value, 'legacy');
  assert.equal(selection.select('pocket-prefix'), false);
  const engines = ['legacy', 'pocket-captions', 'pocket-prefix'];
  selection.update({ engines, session: null, locked: false });
  assert.equal(selection.select('pocket-prefix'), true);
  selection.update({
    engines,
    session: { translationEngine: 'legacy' },
    locked: false,
  });
  assert.equal(selection.snapshot.value, 'legacy');
  assert.equal(selection.snapshot.selected, 'pocket-prefix');
  assert.equal(selection.select('pocket-captions'), false);
  selection.update({ engines, session: null, locked: false });
  assert.equal(selection.snapshot.value, 'pocket-prefix');
});

test('prefix capability removal is fail-closed and keeps original Pocket selectable', () => {
  const selection = createTranslationEngineSelection();
  selection.update({
    engines: ['legacy', 'pocket-captions', 'pocket-prefix'],
    locked: false,
  });
  selection.select('pocket-prefix');
  selection.update({ engines: ['legacy', 'pocket-captions'], locked: false });
  assert.equal(selection.snapshot.value, 'legacy');
  assert.equal(selection.select('pocket-prefix'), false);
  assert.equal(selection.select('pocket-captions'), true);
});

test('prefix uses fixed Pocket voice and original-English captions consistently', () => {
  assert.equal(isTranslationEngine('pocket-prefix'), true);
  for (const check of [
    usesLocalVoice,
    usesPocketVoice,
    serverPocket,
    usesRemoteCaptions,
    serverCaptions,
  ]) {
    assert.equal(check('pocket-prefix'), true);
    assert.equal(check('unknown-prefix'), false);
  }
  assert.equal(
    translationEngineLabel('pocket-prefix'),
    'Pocket 边讲边播（新测试版）',
  );
});

test('prefix readiness still requires explicit ready and explains actual-test limits', () => {
  const session = {
    status: 'active',
    translationEngine: 'pocket-prefix',
    captionState: 'failed',
  };
  const pending = translationReadiness(session);
  assert.equal(pending.ready, false);
  assert.match(pending.instruction, /请等就绪后说话/);
  const ready = translationReadiness({ ...session, translationReady: true });
  assert.equal(ready.ready, true);
  assert.match(ready.instruction, /短词组.*继续接收后文/);
  assert.match(ready.instruction, /直接听英文原声.*中英字幕/);
  assert.match(ready.instruction, /尚未验证 0.5–1 秒.*最多 5 分钟/);
  assert.equal(translationReadiness({ ...session, status: 'completed' }), null);
});
