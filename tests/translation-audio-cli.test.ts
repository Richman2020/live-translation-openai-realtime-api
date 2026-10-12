import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

// These invocations fail before any audio, .env, provider connection or output
// directory is accessed. The output boundary is checked after option parsing.
function rejectedInvocation(extra: string[]) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve('scripts/compare-translation-audio.ts'),
      '--input',
      'unused-input.pcmu',
      '--role',
      'local',
      '--out',
      resolve('.'),
      ...extra,
    ],
    { encoding: 'utf8', timeout: 15000 },
  );
}

test('comparison CLI accepts noise options but retains the private output boundary', () => {
  for (const value of [undefined, 'off', 'near_field', 'far_field']) {
    const result = rejectedInvocation(
      value === undefined ? [] : ['--noise-reduction', value],
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OUTPUT_MUST_BE_INSIDE_RUNTIME/);
    assert.equal(result.stdout, '');
  }
});

test('comparison CLI rejects unsupported noise options before filesystem or providers', () => {
  for (const value of ['auto', 'null', 'NEAR_FIELD']) {
    const result = rejectedInvocation(['--noise-reduction', value]);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /NOISE_REDUCTION_MUST_BE_OFF_NEAR_FIELD_OR_FAR_FIELD/,
    );
    assert.equal(result.stdout, '');
  }
});
