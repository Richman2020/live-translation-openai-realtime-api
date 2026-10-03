import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { validateQualityRecordings } from '../src/experiments/quality-recordings';

const fixture = JSON.parse(
  readFileSync('tests/fixtures/phone-quality-v1.json', 'utf8'),
);
function bundle() {
  const pcm = Buffer.alloc(4000);
  for (let i = 0; i < 2000; i += 1)
    pcm.writeInt16LE(i % 2 ? -1000 : 1000, i * 2);
  return {
    version: 'phone-quality-recordings/1',
    kind: 'human',
    format: 'PCM16LE_8000_mono',
    consentForProjectEvaluation: true,
    cases: fixture.cases.map((item: { id: string }) => ({
      id: item.id,
      pcm16Base64: pcm.toString('base64'),
    })),
  };
}

test('local recording import keeps fixture content, validates all cases and uses G711 encoding', () => {
  const result = validateQualityRecordings(bundle(), fixture.cases);
  assert.equal(result.length, 14);
  assert.equal(result[0].pcmu.length, 2000);
  assert.equal(result[0].pcmu[0], 206);
  assert.equal(result[0].pcmu[1], 78);
  assert.equal(result[0].sourceText, fixture.cases[0].sourceText);
});

test('recording input rejects absent consent, wrong format, missing and repeated cases', () => {
  for (const update of [
    { consentForProjectEvaluation: false },
    { format: 'webm' },
    { kind: 'synthetic' },
    { cases: bundle().cases.slice(1) },
    { cases: Array(14).fill(bundle().cases[0]) },
  ])
    assert.throws(() =>
      validateQualityRecordings({ ...bundle(), ...update }, fixture.cases),
    );
});

test('recording input rejects malformed, oversized, silent and odd-length audio', () => {
  for (const value of [
    '!',
    '',
    'Zg==',
    Buffer.alloc(4001).toString('base64'),
    Buffer.alloc(4000).toString('base64'),
    'A'.repeat(1280004),
  ]) {
    const input = bundle();
    input.cases[0].pcm16Base64 = value;
    assert.throws(() => validateQualityRecordings(input, fixture.cases));
  }
});

test('recording fixtures reject traversal, Windows devices, role reversal and invalid fields before import', () => {
  for (const update of [
    { id: '../../../unexpected' },
    { id: 'C:\\outside' },
    { id: '01:secret' },
    { id: 'CON' },
    { id: 'nul' },
    { targetLanguage: 'zh' },
    { role: 'caller' },
    { kind: 'other' },
    { sourceText: '' },
    { expectedTranslation: 'x'.repeat(2001) },
  ]) {
    const fixtures = fixture.cases.map((item: object, index: number) =>
      index === 0 ? { ...item, ...update } : { ...item },
    );
    const input = bundle();
    input.cases[0].id = fixtures[0].id;
    assert.throws(
      () => validateQualityRecordings(input, fixtures),
      /INVALID_RECORDING_FIXTURES/,
    );
  }
  const cases = fixture.cases.map((item: object) => ({ ...item }));
  cases[0].id = 'caseA';
  cases[1].id = 'CASEa';
  assert.throws(
    () => validateQualityRecordings(bundle(), cases),
    /INVALID_RECORDING_FIXTURES/,
  );
  assert.throws(
    () => validateQualityRecordings(bundle(), undefined),
    /INVALID_RECORDING_FIXTURES/,
  );
});

test('recording fixtures reject invalid corpus mix and exclude unrelated metadata from import', () => {
  const cases = fixture.cases.map((item: object) => ({ ...item }));
  cases[0].kind = 'long';
  assert.throws(
    () => validateQualityRecordings(bundle(), cases),
    /INVALID_RECORDING_FIXTURE_MIX/,
  );
  const result = validateQualityRecordings(
    bundle(),
    fixture.cases.map((item: object) => ({
      ...item,
      unsafePath: '../other',
      secret: 'not a fixture field',
    })),
  );
  assert.equal('unsafePath' in result[0], false);
  assert.equal('secret' in result[0], false);
});

test('public recording script mirrors the exact versioned test cases', async () => {
  const { qualityFixtures: mirrored } = await import(
    new URL('../public/quality-fixtures.js', import.meta.url).href
  );
  assert.deepEqual(mirrored, fixture);
  const guide = readFileSync('PHONE_TEST_V1.md', 'utf8');
  for (const item of fixture.cases) assert.ok(guide.includes(item.sourceText));
});
