import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { parseAnalysisArguments } from '../scripts/analyze-quality-results';
import {
  analyzeInputEnergy,
  analyzeQualityResults,
} from '../src/experiments/quality-result-analysis';
import { analyzePcmuPlayback } from '../src/solo/translation-audio-measurement';
import { pcm16ToMuLaw } from '../src/solo/translation-pcm';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sound = (ms: number, amplitude = 2000) =>
  Buffer.alloc(ms * 8, pcm16ToMuLaw(amplitude));
const silence = (ms: number) => Buffer.alloc(ms * 8, 255);

function fixture() {
  const cwd = mkdtempSync(resolve(tmpdir(), 'quality-analysis-test-'));
  const root = resolve(cwd, '.runtime/results');
  const out = resolve(cwd, '.runtime/test.analysis.private.json');
  mkdirSync(root, { recursive: true });
  // A long-leading/trailing source analogous to case 01, plus a 40 ms impulse.
  const input = Buffer.concat([
    silence(3000),
    sound(40),
    silence(1260),
    sound(500),
    silence(6380),
  ]);
  const item = {
    id: '01',
    role: 'local',
    targetLanguage: 'en',
    kind: 'short',
    inputBytes: input.length,
    inputSha256: sha(input),
  };
  const plan = {
    phase: 'planned',
    kind: 'human',
    cases: [item],
    runCount: 2,
    runs: ['off', 'near_field'].map((condition) => ({
      id: `01-r1-${condition}`,
      caseId: '01',
      condition,
      repetition: 1,
      inputSha256: sha(input),
    })),
  };
  const write = (name: string, value: unknown) =>
    writeFileSync(resolve(root, name), JSON.stringify(value));
  write('plan.private.json', plan);
  writeFileSync(
    resolve(cwd, '.env'),
    'PRIVATE_CREDENTIAL_SENTINEL_DO_NOT_READ',
  );
  const save = (condition = 'off', noEnergy = false, zeroAudio = false) => {
    const run = plan.runs.find((r) => r.condition === condition)!;
    mkdirSync(resolve(root, run.id));
    let phone = noEnergy ? silence(500) : sound(500);
    if (zeroAudio) phone = Buffer.alloc(0);
    const phoneDeltas = phone.length
      ? [{ atMs: 6000, bytes: phone.length }]
      : [];
    const report = {
      ...run,
      role: 'local',
      targetLanguage: 'en',
      inputBytes: input.length,
      completed: !zeroAudio,
      failure: zeroAudio ? 'NO_CONTINUOUS_AUDIO' : null,
      providerDrainConfirmed: true,
      outputTranscript:
        noEnergy || zeroAudio ? '   ' : 'PRIVATE_TRANSCRIPT_SENTINEL',
      phoneOutputBytes: phone.length,
      phoneDeltas,
      energy: analyzePcmuPlayback(phone, phoneDeltas),
      prefixSilenceMs: 300,
      firstInputAtMs: 100,
      sourceFileEndAtMs: 100 + 300 + input.length / 8,
      estimatedFirstEnergyAfterInputStartMs: 5900,
      estimatedLastEnergyAfterSourceFileEndMs: 6500 - (400 + input.length / 8),
    };
    write(`${run.id}/result.private.json`, report);
    writeFileSync(resolve(root, run.id, 'input.pcmu'), input);
    writeFileSync(resolve(root, run.id, 'phone.pcmu'), phone);
    return {
      report,
      run,
      write: () => write(`${run.id}/result.private.json`, report),
    };
  };
  return {
    cwd,
    root,
    out,
    input,
    plan,
    write,
    save,
    analyze: () => analyzeQualityResults({ input: root, out, cwd }),
    read: () => JSON.parse(readFileSync(out, 'utf8')),
    cleanup: () => {
      assert.ok(cwd.startsWith(resolve(tmpdir(), 'quality-analysis-test-')));
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

test('sustained bounds ignore isolated impulses, bridge up to 120 ms, and count active duration only', () => {
  const input = Buffer.concat([
    silence(20),
    sound(40),
    silence(120),
    sound(60),
    silence(140),
    sound(80),
    silence(100),
  ]);
  const result = analyzeInputEnergy(input);
  assert.equal(result.rawRuns.length, 3);
  assert.deepEqual(result.windows, [
    { startMs: 20, endMs: 240, activeMs: 100 },
  ]);
  assert.equal(result.trailingLowEnergyMs, 320);
  assert.equal(
    analyzeInputEnergy(Buffer.concat([sound(40), silence(120), sound(40)]))
      .firstMs,
    null,
  );
  assert.equal(analyzeInputEnergy(silence(500)).firstMs, null);
  const pulses = Buffer.concat(
    Array.from({ length: 5 }, (_, index) =>
      Buffer.concat([sound(20), silence(index === 4 ? 0 : 100)]),
    ),
  );
  assert.deepEqual(analyzeInputEnergy(pulses).windows, [
    { startMs: 0, endMs: 500, activeMs: 100 },
  ]);
});

test('fixed RMS300 retains weak tail while threshold sensitivity discloses its loss at 1000', () => {
  const input = Buffer.concat([
    silence(800),
    sound(500),
    silence(600),
    sound(200, 500),
    silence(900),
  ]);
  const main = analyzeInputEnergy(input);
  assert.equal(main.lastMs, 2100);
  assert.equal(main.trailingLowEnergyMs, 900);
  assert.equal(analyzeInputEnergy(input, 1000).lastMs, 1300);
  assert.equal(analyzeInputEnergy(input, 100).lastMs, 2100);
});

test('alignment removes long file margins without changing originals or asserting quality', () => {
  const f = fixture();
  try {
    const saved = f.save();
    f.save('near_field', true);
    const resultPath = resolve(f.root, saved.run.id, 'result.private.json');
    const before = readFileSync(resultPath);
    const result = f.analyze();
    const report = f.read();
    assert.equal(result.completedMatrix, true);
    assert.equal(report.fullV1Matrix, false);
    assert.equal(report.sameSourceHash, true);
    assert.equal(report.runs[0].inputEnergy.firstMs, 4300);
    assert.equal(report.runs[0].aligned.sourceFirstSustainedEnergyAtMs, 4700);
    assert.equal(report.runs[0].aligned.sourceLastSustainedEnergyAtMs, 5200);
    assert.equal(
      report.runs[0].aligned.estimatedFirstOutputEnergyAfterSustainedInputEndMs,
      800,
    );
    assert.equal(
      report.runs[0].aligned
        .estimatedFirstOutputEnergyAfterSustainedInputStartMs,
      1300,
    );
    assert.equal(
      report.runs[0].aligned.estimatedLastOutputEnergyAfterSustainedInputEndMs,
      1300,
    );
    assert.equal(
      report.runs[0].original.estimatedFirstEnergyAfterInputStartMs,
      5900,
    );
    assert.equal(
      report.runs[1].aligned
        .estimatedFirstOutputEnergyAfterSustainedInputStartMs,
      null,
    );
    assert.equal(report.byCondition[1].noOutputEnergy, 1);
    assert.equal(
      report.runs[1].aligned.estimatedFirstOutputEnergyAfterSustainedInputEndMs,
      null,
    );
    assert.equal(report.byCondition[1].emptyText, 1);
    assert.equal(report.translationAccuracy, undefined);
    assert.equal(report.voiceStability, undefined);
    assert.equal(report.humanReview, 'pending');
    assert.equal(report.networkUsed, false);
    assert.ok(readFileSync(resultPath).equals(before));
    assert.ok(
      readFileSync(resolve(f.root, saved.run.id, 'input.pcmu')).equals(f.input),
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /PRIVATE_TRANSCRIPT|PRIVATE_CREDENTIAL/,
    );
    assert.doesNotMatch(
      JSON.stringify(report),
      /PRIVATE_TRANSCRIPT|PRIVATE_CREDENTIAL/,
    );
    assert.throws(f.analyze, /OUTPUT_ALREADY_EXISTS/);
  } finally {
    f.cleanup();
  }
});

test('output starting during sustained input preserves a negative end-to-first offset', () => {
  const f = fixture();
  try {
    const saved = f.save();
    saved.report.phoneDeltas[0].atMs = 4000;
    saved.report.energy = analyzePcmuPlayback(
      sound(500),
      saved.report.phoneDeltas,
    );
    saved.report.estimatedFirstEnergyAfterInputStartMs = 3900;
    saved.report.estimatedLastEnergyAfterSourceFileEndMs =
      4500 - saved.report.sourceFileEndAtMs;
    saved.write();
    f.analyze();
    const run = f.read().runs[0];
    assert.equal(run.aligned.eligible, true);
    assert.equal(
      run.aligned.estimatedFirstOutputEnergyAfterSustainedInputEndMs,
      -1200,
    );
    assert.equal(
      run.aligned.estimatedFirstOutputEnergyAfterSustainedInputStartMs,
      -700,
    );
    assert.equal(
      run.aligned.estimatedLastOutputEnergyAfterSustainedInputEndMs,
      -700,
    );
    assert.equal(f.read().humanReview, 'pending');
  } finally {
    f.cleanup();
  }
});

test('missing attempts and inflight records cannot produce a complete matrix; no audio remains counted', () => {
  const f = fixture();
  try {
    f.save('off', true, true);
    f.write('inflight.private.json', { id: '01-r1-near_field' });
    f.analyze();
    const report = f.read();
    assert.equal(report.completedMatrix, false);
    assert.equal(report.unresolvedInflight, true);
    assert.equal(report.savedAttempts, 1);
    assert.equal(report.byCondition[0].failed, 1);
    assert.equal(report.byCondition[0].noOutputEnergy, 1);
    assert.equal(report.byCondition[0].emptyText, 1);
    assert.equal(report.byCondition[1].missingResults, 1);
    assert.equal(report.byCondition[1].noOutputEnergy, 0);
    assert.equal(report.runs[0].aligned.eligible, false);
  } finally {
    f.cleanup();
  }
});

test('tampered input or saved output measurements fail closed for derived timing', () => {
  const f = fixture();
  try {
    const a = f.save();
    const b = f.save('near_field');
    writeFileSync(
      resolve(f.root, a.run.id, 'input.pcmu'),
      sound(f.input.length / 8),
    );
    b.report.energy.firstEnergyAtMs = 1;
    b.write();
    f.analyze();
    const report = f.read();
    assert.equal(report.sameSourceHash, false);
    assert.equal(report.allOutputMeasurementsMatch, false);
    for (const run of report.runs) {
      assert.equal(run.aligned.eligible, false);
      assert.equal(
        run.aligned.estimatedFirstOutputEnergyAfterSustainedInputEndMs,
        null,
      );
      assert.equal(
        run.aligned.estimatedFirstOutputEnergyAfterSustainedInputStartMs,
        null,
      );
    }
  } finally {
    f.cleanup();
  }
});

test('unconfirmed drain and absent clocks cannot produce valid timing', () => {
  const f = fixture();
  try {
    const a = f.save();
    a.report.providerDrainConfirmed = false;
    a.report.completed = false;
    a.report.failure = 'PROVIDER_CONNECTION_FAILED';
    a.report.firstInputAtMs = null;
    a.write();
    f.analyze();
    const run = f.read().runs[0];
    assert.equal(run.aligned.eligible, false);
    assert.ok(run.aligned.issues.includes('PROVIDER_DRAIN_NOT_CONFIRMED'));
    assert.ok(run.aligned.issues.includes('MISSING_INPUT_CLOCK_ANCHOR'));
  } finally {
    f.cleanup();
  }
});

test('reversed input clock anchors never produce eligible aligned waits', () => {
  const f = fixture();
  try {
    const a = f.save();
    a.report.firstInputAtMs = 1000;
    a.report.sourceFileEndAtMs = 1;
    a.write();
    f.analyze();
    const run = f.read().runs[0];
    assert.equal(run.aligned.eligible, false);
    assert.ok(run.aligned.issues.includes('INPUT_CLOCK_ANCHORS_INCONSISTENT'));
    assert.equal(
      run.aligned.estimatedLastOutputEnergyAfterSustainedInputEndMs,
      null,
    );
  } finally {
    f.cleanup();
  }
});

test('fourteen arbitrary local short cases cannot claim full V1 coverage', () => {
  const f = fixture();
  try {
    f.plan.cases = Array.from({ length: 14 }, (_, index) => ({
      ...f.plan.cases[0],
      id: `fake${index}`,
    }));
    f.plan.runs = f.plan.cases.flatMap((item) =>
      [1, 2, 3].flatMap((repetition) =>
        ['off', 'near_field'].map((condition) => ({
          id: `${item.id}-r${repetition}-${condition}`,
          caseId: item.id,
          condition,
          repetition,
          inputSha256: item.inputSha256,
        })),
      ),
    );
    f.plan.runCount = f.plan.runs.length;
    f.write('plan.private.json', f.plan);
    assert.throws(f.analyze, /INVALID_FULL_V1_CORPUS/);
  } finally {
    f.cleanup();
  }
});

test('refuses path escapes, output overwrite, junctions and linked input files', () => {
  const f = fixture();
  try {
    f.save();
    assert.throws(
      () => analyzeQualityResults({ input: f.cwd, out: f.out, cwd: f.cwd }),
      /INSIDE_RUNTIME/,
    );
    assert.throws(
      () =>
        analyzeQualityResults({
          input: f.root,
          out: resolve(f.cwd, 'leak.analysis.private.json'),
          cwd: f.cwd,
        }),
      /INSIDE_RUNTIME/,
    );
    assert.throws(
      () =>
        analyzeQualityResults({
          input: f.root,
          out: resolve(f.root, 'x.analysis.private.json'),
          cwd: f.cwd,
        }),
      /OUTSIDE_RESULT_DIRECTORY/,
    );
    assert.throws(
      () =>
        analyzeQualityResults({
          input: f.root,
          out: resolve(f.cwd, '.runtime/.env'),
          cwd: f.cwd,
        }),
      /NAMED_PRIVATE_REPORT/,
    );
    mkdirSync(resolve(f.cwd, 'outside'));
    symlinkSync(
      resolve(f.cwd, 'outside'),
      resolve(f.cwd, '.runtime/link'),
      'junction',
    );
    assert.throws(
      () =>
        analyzeQualityResults({
          input: '.runtime/link',
          out: f.out,
          cwd: f.cwd,
        }),
      /LINK_NOT_ALLOWED/,
    );
    assert.throws(
      () =>
        analyzeQualityResults({
          input: f.root,
          out: resolve(f.cwd, '.runtime/link/x.analysis.private.json'),
          cwd: f.cwd,
        }),
      /LINK_NOT_ALLOWED/,
    );
    linkSync(
      resolve(f.root, '01-r1-off/input.pcmu'),
      resolve(f.cwd, 'input-hardlink.pcmu'),
    );
    assert.throws(f.analyze, /LINKED_FILE/);
  } finally {
    f.cleanup();
  }
});

test('malformed plans, wrong result IDs and inconsistent FIFO schedules are rejected', () => {
  const f = fixture();
  try {
    const a = f.save();
    const originalPlan = JSON.stringify(f.plan);
    const [duplicateRun] = f.plan.runs;
    f.plan.runs[1] = duplicateRun;
    f.write('plan.private.json', f.plan);
    assert.throws(f.analyze, /INVALID_MATRIX/);
    writeFileSync(resolve(f.root, 'plan.private.json'), originalPlan);
    a.report.id = '../../outside';
    a.write();
    assert.throws(f.analyze, /INVALID_RESULT/);
    a.report.id = a.run.id;
    a.report.phoneDeltas[0].bytes += 1;
    a.write();
    assert.throws(f.analyze, /INVALID_OUTPUT_SCHEDULE/);
  } finally {
    f.cleanup();
  }
});

test('CLI is explicit and stdout contains counts but no transcript or source material', () => {
  const f = fixture();
  try {
    f.save();
    assert.throws(() => parseAnalysisArguments(['--input', 'x']), /USE_INPUT/);
    assert.throws(
      () =>
        parseAnalysisArguments(['--input', 'x', '--input', 'y', '--out', 'z']),
      /USE_INPUT/,
    );
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,
        resolve('scripts/analyze-quality-results.ts'),
        '--input',
        f.root,
        '--out',
        f.out,
      ],
      { cwd: f.cwd, encoding: 'utf8' },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).savedAttempts, 1);
    assert.doesNotMatch(
      child.stdout + child.stderr,
      /PRIVATE_TRANSCRIPT|PRIVATE_CREDENTIAL|sourceText|outputTranscript/,
    );
  } finally {
    f.cleanup();
  }
});
