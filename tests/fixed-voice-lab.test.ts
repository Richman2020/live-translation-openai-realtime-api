import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  fixedVoiceOutputPath,
  parseFixedVoiceArgs,
  validateFixedVoiceFixtures,
} from '../scripts/compare-fixed-voice';

const entry = {
  id: '01',
  role: 'local',
  sourceText: '我不要咖啡。',
  expectedTranslation: 'I do not want coffee.',
  targetLanguage: 'en',
  kind: 'short',
};
const fixture = { version: 'phone-quality-v1', cases: [entry] };

test('fixed voice CLI defaults to three repeats and no implicit voice or clone', () => {
  const args = parseFixedVoiceArgs([]);
  assert.equal(args.repeat, 3);
  assert.equal(args.voiceEn, undefined);
  assert.equal(args.voiceZh, undefined);
  assert.equal(args.dryRun, false);
  assert.ok(args.fixtures.endsWith('phone-quality-v1.json'));
});

test('fixed voice dry-run and one case can be selected without credentials', () => {
  const args = parseFixedVoiceArgs([
    '--dry-run',
    '--case',
    '01',
    '--repeat',
    '1',
  ]);
  assert.equal(args.dryRun, true);
  assert.equal(args.caseId, '01');
  assert.equal(args.repeat, 1);
});

test('invalid, duplicate, missing or unbounded CLI arguments are rejected', () => {
  for (const args of [
    ['--repeat', '0'],
    ['--repeat', '4'],
    ['--repeat', '3x'],
    ['--case', '../bad'],
    ['--voice-en', 'bad/?id'],
    ['--whatever', '1'],
    ['--repeat'],
    ['--dry-run', '--dry-run'],
  ]) {
    assert.throws(() => parseFixedVoiceArgs(args));
  }
});

test('fixtures send reviewed expected translation and retain source only as evidence', () => {
  const checked = validateFixedVoiceFixtures({
    ...fixture,
    cases: [{ ...entry, ignored: 'metadata' }],
  });
  assert.deepEqual(checked, [entry]);
  assert.equal(checked[0].expectedTranslation, 'I do not want coffee.');
});

test('fixtures reject role reversal, duplicate ids, traversal, empty text and oversized batches', () => {
  for (const value of [
    null,
    {},
    { ...fixture, version: 'v2' },
    { ...fixture, cases: [] },
    { ...fixture, cases: [entry, entry] },
    { ...fixture, cases: [{ ...entry, targetLanguage: 'zh' }] },
    { ...fixture, cases: [{ ...entry, id: '../01' }] },
    { ...fixture, cases: [{ ...entry, expectedTranslation: '' }] },
    {
      ...fixture,
      cases: [{ ...entry, expectedTranslation: 'x'.repeat(2001) }],
    },
    { ...fixture, cases: Array(15).fill(entry) },
  ]) {
    assert.throws(() => validateFixedVoiceFixtures(value));
  }
});

test('fixed voice outputs reject redirected runtime and lab parents even inside the repository', () => {
  for (const parent of ['runtime', 'lab']) {
    const root = mkdtempSync(resolve(tmpdir(), 'fixed-voice-path-'));
    const target = resolve(root, 'public');
    try {
      mkdirSync(target);
      if (parent === 'runtime')
        symlinkSync(target, resolve(root, '.runtime'), 'junction');
      else {
        mkdirSync(resolve(root, '.runtime'));
        symlinkSync(
          target,
          resolve(root, '.runtime/fixed-voice-lab'),
          'junction',
        );
      }
      assert.throws(
        () => fixedVoiceOutputPath(root, 'run-01'),
        /OUTPUT_PATH_MUST_NOT_REDIRECT/,
      );
      assert.equal(existsSync(resolve(target, 'run-01')), false);
    } finally {
      // The deletion target is exactly the isolated temporary root we created.
      assert.equal(realpathSync(root), root);
      assert.ok(root.startsWith(resolve(tmpdir(), 'fixed-voice-path-')));
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('fixed voice output validates missing private parents without creating files', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'fixed-voice-path-'));
  try {
    assert.equal(
      fixedVoiceOutputPath(root, 'run-01'),
      resolve(root, '.runtime/fixed-voice-lab/run-01'),
    );
    assert.equal(existsSync(resolve(root, '.runtime')), false);
    assert.throws(
      () => fixedVoiceOutputPath(root, '../outside'),
      /INVALID_RUN_NAME/,
    );
    mkdirSync(resolve(root, '.runtime/fixed-voice-lab/run-01'), {
      recursive: true,
    });
    assert.throws(
      () => fixedVoiceOutputPath(root, 'run-01'),
      /OUTPUT_ALREADY_EXISTS/,
    );
  } finally {
    assert.equal(realpathSync(root), root);
    assert.ok(root.startsWith(resolve(tmpdir(), 'fixed-voice-path-')));
    rmSync(root, { recursive: true, force: true });
  }
});
