import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { actualPhoneCodec, pcmStats, resolveFreshOutput, sha256, validateFilteredPcm, verifySourcePcm, wav } from '../scripts/build-nano-phone-clarity';
import { muLawToPcm16, Pcm24kToPcmu } from '../src/solo/translation-pcm';

test('authorized source mismatch and invalid PCM stop before processing', () => {
  const pcm = Buffer.from([1, 0, 255, 127]);
  assert.doesNotThrow(() => verifySourcePcm(pcm, sha256(pcm)));
  assert.throws(() => verifySourcePcm(Buffer.from([2, 0, 255, 127]), sha256(pcm)), /SOURCE_HASH_MISMATCH/);
  assert.throws(() => verifySourcePcm(Buffer.alloc(1), sha256(Buffer.alloc(1))), /SOURCE_PCM_INVALID/);
});

test('output guard rejects overwrite and locations outside fresh private runtime prefix', () => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'nano-clarity-test-')));
  mkdirSync(resolve(root, '.runtime'));
  try {
    const candidate = resolveFreshOutput(root, '.runtime/voice-clarity-review-test');
    assert.equal(candidate, resolve(root, '.runtime/voice-clarity-review-test'));
    assert.throws(() => resolveFreshOutput(root, 'voice-clarity-review-test'), /OUTPUT_PATH_NOT_ALLOWED/);
    assert.throws(() => resolveFreshOutput(root, '.runtime/another-output'), /OUTPUT_PATH_NOT_ALLOWED/);
    mkdirSync(candidate);
    assert.throws(() => resolveFreshOutput(root, '.runtime/voice-clarity-review-test'), /OUTPUT_ALREADY_EXISTS/);
  } finally {
    assert.equal(realpathSync(root), root);
    assert.ok(root.startsWith(resolve(tmpdir(), 'nano-clarity-test-')));
    rmSync(root, { recursive: true, force: true });
  }
});

test('telephone candidate uses exact live resampler and 384-byte tail drain', () => {
  const input = Buffer.alloc(4800);
  for (let i = 0; i < input.length / 2; i += 1) input.writeInt16LE(Math.round(12000 * Math.sin(i * .11)), i * 2);
  const actual = actualPhoneCodec(input);
  const live = new Pcm24kToPcmu();
  assert.deepEqual(actual.pcmu, Buffer.concat([live.push(input), live.push(Buffer.alloc(384))]));
  assert.equal(actual.pcmu.length, 800 + 64);
  actual.pcmu.forEach((code, i) => assert.equal(actual.decoded.readInt16LE(i * 2), muLawToPcm16(code)));
});

test('separate sentence codec drains are preserved rather than re-encoding concatenated input', () => {
  const first = Buffer.alloc(4800); first.writeInt16LE(30000, first.length - 2);
  const second = Buffer.alloc(4800); second.writeInt16LE(-30000, 0);
  const joined = Buffer.concat([actualPhoneCodec(first).pcmu, actualPhoneCodec(second).pcmu]);
  assert.equal(joined.length, 2 * (800 + 64));
  assert.notDeepEqual(joined, actualPhoneCodec(Buffer.concat([first, second])).pcmu);
});

test('filter duration validation detects lost tails or duplicate output without claiming speech completeness', () => {
  const sourceSamples = 24000;
  const expected = Math.ceil((sourceSamples + 6000) / .92);
  const result = validateFilteredPcm(Buffer.alloc(expected * 2), sourceSamples);
  assert.ok(Math.abs(result.differenceMs) < 1);
  assert.ok(result.addedDurationBeyondTempoOnlyMs > 270);
  assert.equal(result.speechCompleteness, 'PENDING_HUMAN_LISTENING');
  assert.throws(() => validateFilteredPcm(Buffer.alloc(24000), sourceSamples), /FILTER_DURATION_OUT_OF_RANGE/);
  assert.throws(() => validateFilteredPcm(Buffer.alloc(1), sourceSamples), /FILTER_OUTPUT_INVALID/);
});

test('numeric audio evidence and WAV retain original signed PCM without gain changes', () => {
  const pcm = Buffer.alloc(960);
  pcm.writeInt16LE(-32768, 0); pcm.writeInt16LE(32767, 2);
  const stats = pcmStats(pcm, 24000);
  assert.equal(stats.durationMs, 20);
  assert.equal(stats.clippedSamples, 2);
  assert.equal(stats.peakAbsPcm16, 32768);
  assert.equal(stats.rms20ms.windows, 1);
  const output = wav(pcm, 24000);
  assert.equal(output.readUInt32LE(24), 24000);
  assert.equal(output.readUInt32LE(40), pcm.length);
  assert.deepEqual(output.subarray(44), pcm);
});
