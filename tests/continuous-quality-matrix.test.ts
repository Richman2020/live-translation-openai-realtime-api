/* eslint-disable no-await-in-loop -- Matrix sessions are intentionally sequential. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
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

import {
  createQualityOutput,
  parseQualityArguments,
  pcmuWav,
  prepareQualityPlan,
  qualityDryRunSummary,
  runQualitySession,
  safeQualityError,
  saveQualityRun,
  summarizeQualityRuns,
  validatePrivateQualityOutput,
} from '../src/experiments/continuous-quality-matrix';
import type { ContinuousTranslationOptions } from '../src/solo/continuous-translation-client';

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'phone-quality-test-'));
  mkdirSync(resolve(root, '.runtime'));
  const input = Buffer.alloc(320, 180);
  writeFileSync(resolve(root, '.runtime/input.pcmu'), input);
  const manifest = {
    version: 'phone-quality-inputs/1',
    kind: 'synthetic',
    format: 'PCMU_8000_mono',
    consentForProjectEvaluation: false,
    cases: Array.from({ length: 14 }, (_, index) => ({
      id: String(index + 1).padStart(2, '0'),
      role: index % 2 === 0 ? 'local' : 'remote',
      targetLanguage: index % 2 === 0 ? 'en' : 'zh',
      kind: index < 12 ? 'short' : 'long',
      inputFile: 'input.pcmu',
      sourceText: 'PRIVATE SOURCE',
      expectedTranslation: 'PRIVATE TRANSLATION',
    })),
  };
  const manifestPath = resolve(root, '.runtime/manifest.json');
  const save = () => writeFileSync(manifestPath, JSON.stringify(manifest));
  save();
  const args = parseQualityArguments([
    '--manifest',
    manifestPath,
    '--out',
    '.runtime/new-run',
  ]);
  return {
    root,
    input,
    manifest,
    manifestPath,
    args,
    save,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('matrix plans 84 runs with identical hashes and interleaved condition order', () => {
  const f = fixture();
  try {
    const plan = prepareQualityPlan(f.args, f.root);
    assert.equal(plan.runs.length, 84);
    assert.deepEqual(
      plan.runs.slice(0, 4).map((run) => run.condition),
      ['off', 'near_field', 'near_field', 'off'],
    );
    assert.deepEqual(
      plan.runs.slice(28, 30).map((run) => run.condition),
      ['near_field', 'off'],
    );
    for (const item of plan.cases) {
      for (const condition of ['off', 'near_field']) {
        const runs = plan.runs.filter(
          (run) => run.caseId === item.id && run.condition === condition,
        );
        assert.equal(runs.length, 3);
        assert.ok(runs.every((run) => run.inputSha256 === item.inputSha256));
      }
    }
    const summary = qualityDryRunSummary(plan);
    assert.equal(summary.networkUsed, false);
    assert.equal(summary.writesPerformed, false);
    assert.equal(summary.addedPhoneLatency, null);
    assert.equal(JSON.stringify(summary).includes('PRIVATE'), false);
    assert.equal(existsSync(plan.outputRoot), false);
  } finally {
    f.cleanup();
  }
});

test('arguments reject excess spend, duplicates and unsupported switches', () => {
  for (const extra of [
    ['--repeat', '0'],
    ['--repeat', '4'],
    ['--repeat', '1.5'],
    ['--out', 'again'],
    ['--resume'],
    ['--case'],
  ]) {
    assert.throws(() =>
      parseQualityArguments([
        '--manifest',
        'file',
        '--out',
        '.runtime/x',
        ...extra,
      ]),
    );
  }
});

test('manifest format is explicit and human input requires recorded evaluation consent before keys', () => {
  const f = fixture();
  try {
    delete f.manifest.format;
    f.save();
    assert.equal(prepareQualityPlan(f.args, f.root).kind, 'synthetic');
    f.manifest.kind = 'human';
    f.manifest.format = 'PCM16LE_24000_mono';
    f.save();
    assert.throws(
      () => prepareQualityPlan(f.args, f.root),
      /REQUIRE_PCMU_8000_MONO_MANIFEST/,
    );
    f.manifest.format = 'PCMU_8000_mono';
    f.manifest.kind = 'human';
    f.save();
    assert.throws(
      () => prepareQualityPlan(f.args, f.root),
      /HUMAN_EVALUATION_CONSENT_REQUIRED/,
    );
    delete f.manifest.consentForProjectEvaluation;
    f.save();
    assert.throws(
      () => prepareQualityPlan(f.args, f.root),
      /HUMAN_EVALUATION_CONSENT_REQUIRED/,
    );
    f.manifest.consentForProjectEvaluation = true;
    f.save();
    assert.equal(prepareQualityPlan(f.args, f.root).kind, 'human');
    const withoutFormat = { ...f.manifest };
    delete withoutFormat.format;
    writeFileSync(f.manifestPath, JSON.stringify(withoutFormat));
    assert.throws(
      () => prepareQualityPlan(f.args, f.root),
      /REQUIRE_PCMU_8000_MONO_MANIFEST/,
    );
    assert.equal(existsSync(resolve(f.root, '.runtime/new-run')), false);
  } finally {
    f.cleanup();
  }
});

test('manifest validates all inputs before single-case selection and rejects wrong language', () => {
  const f = fixture();
  try {
    const plan = prepareQualityPlan({ ...f.args, caseId: '01' }, f.root);
    assert.equal(plan.runs.length, 6);
    f.manifest.cases[13].targetLanguage = 'en';
    f.save();
    assert.throws(
      () => prepareQualityPlan({ ...f.args, caseId: '01' }, f.root),
      /INVALID_OR_DUPLICATE/,
    );
    f.manifest.cases[13].targetLanguage = 'zh';
    f.manifest.cases[13].id = '01';
    f.save();
    assert.throws(
      () => prepareQualityPlan(f.args, f.root),
      /INVALID_OR_DUPLICATE/,
    );
  } finally {
    f.cleanup();
  }
});

test('manifest rejects missing inputs, oversized PCMU, incomplete corpus and invalid mix', () => {
  const f = fixture();
  try {
    writeFileSync(resolve(f.root, '.runtime/input.pcmu'), Buffer.alloc(480001));
    assert.throws(() => prepareQualityPlan(f.args, f.root), /INPUT_LIMIT/);
    writeFileSync(
      resolve(f.root, '.runtime/input.pcmu'),
      Buffer.from('RIFFabcd'),
    );
    assert.throws(() => prepareQualityPlan(f.args, f.root), /WAVE_HEADER/);
    writeFileSync(resolve(f.root, '.runtime/input.pcmu'), f.input);
    f.manifest.cases[0].kind = 'long';
    f.save();
    assert.throws(
      () => prepareQualityPlan(f.args, f.root),
      /SIX_SHORT_ONE_LONG/,
    );
    f.manifest.cases.pop();
    f.save();
    assert.throws(() => prepareQualityPlan(f.args, f.root), /14_CASE/);
  } finally {
    f.cleanup();
  }
});

test('private output rejects existing directory, traversal, and redirected parent', () => {
  const f = fixture();
  try {
    for (const out of ['.', '.runtime', '.runtime/../public', 'new-run'])
      assert.throws(
        () => validatePrivateQualityOutput(f.root, out),
        /INSIDE_RUNTIME/,
      );
    mkdirSync(resolve(f.root, '.runtime/existing'));
    assert.throws(
      () => validatePrivateQualityOutput(f.root, '.runtime/existing'),
      /ALREADY_EXISTS/,
    );
    mkdirSync(resolve(f.root, 'outside'));
    symlinkSync(
      resolve(f.root, 'outside'),
      resolve(f.root, '.runtime/link'),
      'junction',
    );
    assert.throws(
      () => validatePrivateQualityOutput(f.root, '.runtime/link/new'),
      /MUST_NOT_REDIRECT/,
    );
  } finally {
    f.cleanup();
  }
});

function fakeDependencies(outputSamples = 480) {
  let time = 0;
  let options: ContinuousTranslationOptions;
  let finishCount = 0;
  let abortCount = 0;
  const input: Buffer[] = [];
  return {
    dependencies: {
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
      createClient: (settings: ContinuousTranslationOptions) => {
        options = settings;
        return {
          ready: Promise.resolve(),
          append: (pcm: Buffer) => {
            input.push(Buffer.from(pcm));
          },
          finish: async () => {
            finishCount += 1;
            const pcm = Buffer.alloc(outputSamples * 2);
            for (let index = 0; index < outputSamples; index += 1)
              pcm.writeInt16LE(3000, index * 2);
            settings.onAudio(pcm);
            settings.onTranscript?.('PRIVATE OUTPUT');
          },
          abort: () => {
            abortCount += 1;
          },
        };
      },
    },
    snapshot: () => ({ options, input, finishCount, abortCount }),
  };
}

test('run explicitly configures each condition and preserves input, silence, provider output and drain', async () => {
  const f = fixture();
  try {
    const plan = prepareQualityPlan(
      { ...f.args, caseId: '01', repeat: 1 },
      f.root,
    );
    const reports = [];
    createQualityOutput(plan);
    for (const run of plan.runs) {
      const fake = fakeDependencies();
      const result = await runQualitySession(
        plan.cases[0],
        run,
        { apiKey: 'offline-fixture' },
        fake.dependencies,
      );
      assert.equal(
        fake.snapshot().options.noiseReduction,
        run.condition === 'off' ? null : 'near_field',
      );
      assert.equal(fake.snapshot().options.targetLanguage, 'en');
      assert.equal(fake.snapshot().finishCount, 1);
      assert.equal(fake.snapshot().abortCount, 1);
      assert.equal(result.report.completed, true);
      assert.equal(result.report.providerDrainConfirmed, true);
      assert.equal(result.report.sentInputBytes, 2400 + f.input.length + 32000);
      assert.deepEqual(
        result.sentInput.subarray(2400, 2400 + f.input.length),
        f.input,
      );
      assert.ok(
        result.sentInput.subarray(0, 2400).every((byte) => byte === 255),
      );
      assert.equal(
        Buffer.concat(fake.snapshot().input).length,
        result.sentInput.length * 6,
      );
      assert.equal(result.rawPcm.length, 960);
      assert.equal(result.phonePcmu.length, 160 + 64);
      assert.equal(result.report.localFilterDrainBytes, 64);
      assert.equal(result.report.addedPhoneLatency, null);
      assert.equal(result.report.translationAccuracy, null);
      assert.equal(result.report.voiceStability, null);
      saveQualityRun(plan.outputRoot, result);
      assert.throws(() => saveQualityRun(plan.outputRoot, result));
      const phoneWav = readFileSync(
        resolve(plan.outputRoot, run.id, 'phone-8k.wav'),
      );
      const rawWav = readFileSync(
        resolve(plan.outputRoot, run.id, 'provider-24k.wav'),
      );
      assert.equal(phoneWav.readUInt32LE(24), 8000);
      assert.equal(rawWav.readUInt32LE(24), 24000);
      assert.deepEqual(rawWav.subarray(44), result.rawPcm);
      reports.push(result.report);
    }
    const summary = summarizeQualityRuns(plan, reports);
    assert.equal(summary.completedRuns, 2);
    assert.ok(
      summary.cases[0].conditions.every((entry) => entry.sameSourceHash),
    );
    assert.equal(JSON.stringify(summary).includes('PRIVATE'), false);
  } finally {
    f.cleanup();
  }
});

test('failed session preserves received audio and records failure without approving quality', async () => {
  const f = fixture();
  try {
    const plan = prepareQualityPlan({ ...f.args, caseId: '02' }, f.root);
    const fake = fakeDependencies();
    const original = fake.dependencies.createClient;
    fake.dependencies.createClient = (options) => {
      const client = original(options);
      return {
        ...client,
        finish: async () => {
          await client.finish();
          throw new Error('Bearer private secret');
        },
      };
    };
    const result = await runQualitySession(
      plan.cases[0],
      plan.runs[0],
      { apiKey: 'offline-fixture' },
      fake.dependencies,
    );
    assert.equal(result.report.completed, false);
    assert.equal(result.report.failure, 'QUALITY_EXPERIMENT_FAILED');
    assert.ok(result.rawPcm.length > 0);
    assert.equal(result.report.localFilterDrainBytes, 0);
    assert.equal(
      summarizeQualityRuns(plan, [result.report]).stoppedOnFailure,
      true,
    );
    assert.equal(fake.snapshot().options.targetLanguage, 'zh');
  } finally {
    f.cleanup();
  }
});

test('hard deadline aborts a client whose ready promise never resolves', async () => {
  const f = fixture();
  try {
    const plan = prepareQualityPlan({ ...f.args, caseId: '01' }, f.root);
    let aborted = 0;
    const result = await runQualitySession(
      plan.cases[0],
      plan.runs[0],
      { apiKey: 'fixture' },
      {
        hardLimitMs: 10,
        createClient: () => ({
          ready: new Promise(() => {}),
          append() {},
          finish: async () => {},
          abort() {
            aborted += 1;
          },
        }),
      },
    );
    assert.equal(result.report.failure, 'HARD_LIMIT_100_SECONDS');
    assert.equal(result.report.sentInputBytes, 0);
    assert.ok(aborted > 0);
  } finally {
    f.cleanup();
  }
});

test('pacing stalls stop the run rather than speeding through input to catch up', async () => {
  const f = fixture();
  try {
    const plan = prepareQualityPlan({ ...f.args, caseId: '01' }, f.root);
    const fake = fakeDependencies();
    let clock = 0;
    fake.dependencies.now = () => clock;
    fake.dependencies.sleep = async () => {
      clock += 500;
    };
    const result = await runQualitySession(
      plan.cases[0],
      plan.runs[0],
      { apiKey: 'fixture' },
      fake.dependencies,
    );
    assert.equal(result.report.failure, 'INPUT_PACING_STALL');
    assert.equal(result.report.sentInputBytes, 0);
    assert.equal(fake.snapshot().finishCount, 0);
  } finally {
    f.cleanup();
  }
});

test('output bounds stop generation and raw errors are never printed verbatim', async () => {
  const f = fixture();
  try {
    const plan = prepareQualityPlan({ ...f.args, caseId: '01' }, f.root);
    const fake = fakeDependencies(120 * 24000 + 1);
    const result = await runQualitySession(
      plan.cases[0],
      plan.runs[0],
      { apiKey: 'fixture' },
      fake.dependencies,
    );
    assert.equal(result.report.failure, 'OUTPUT_LIMIT_120_SECONDS');
    assert.equal(result.rawPcm.length, 0);
    assert.equal(
      safeQualityError(new Error('https://secret:value@example.test/')),
      'QUALITY_EXPERIMENT_FAILED',
    );
    assert.equal(pcmuWav(Buffer.from([255, 127])).readInt16LE(44), 0);
  } finally {
    f.cleanup();
  }
});

test('CLI dry run succeeds without .env or writes, invalid manifests fail before key read', () => {
  const f = fixture();
  try {
    const script = resolve('scripts/compare-continuous-quality.ts');
    const loader = pathToFileURL(
      resolve('node_modules/tsx/dist/loader.mjs'),
    ).href;
    const args = [
      '--import',
      loader,
      script,
      '--manifest',
      f.manifestPath,
      '--out',
      '.runtime/run',
      '--dry-run',
    ];
    const output = execFileSync(process.execPath, args, {
      cwd: f.root,
      encoding: 'utf8',
    });
    assert.equal(JSON.parse(output).runCount, 84);
    assert.equal(existsSync(resolve(f.root, '.runtime/run')), false);
    assert.equal(output.includes('PRIVATE'), false);
    f.manifest.cases[0].targetLanguage = 'zh';
    f.save();
    assert.throws(
      () =>
        execFileSync(process.execPath, args.slice(0, -1), {
          cwd: f.root,
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      (error: { stderr: string }) => {
        assert.match(error.stderr, /INVALID_OR_DUPLICATE_QUALITY_CASE/);
        assert.equal(error.stderr.includes('ENOENT'), false);
        return true;
      },
    );
  } finally {
    f.cleanup();
  }
});

test('all 84 attempts including a preserved quality failure are complete without falsely reporting a stopped matrix', async () => {
  const f = fixture();
  try {
    const plan = prepareQualityPlan(f.args, f.root);
    const fake = fakeDependencies();
    const baseline = await runQualitySession(
      plan.cases[0],
      plan.runs[0],
      { apiKey: 'offline-fixture' },
      fake.dependencies,
    );
    const reports = plan.runs.map((run, index) => ({
      ...baseline.report,
      ...run,
      completed: index !== 29,
      failure: index === 29 ? 'NO_CONTINUOUS_AUDIO' : null,
    }));
    const summary = summarizeQualityRuns(plan, reports);
    assert.equal(summary.plannedRuns, 84);
    assert.equal(summary.attemptedRuns, 84);
    assert.equal(summary.completedRuns, 83);
    assert.equal(summary.hasFailures, true);
    assert.equal(summary.stoppedOnFailure, false);
    assert.equal(summary.translationAccuracy, null);
    assert.equal(summary.humanReview, 'pending');
    assert.equal(
      summarizeQualityRuns(plan, reports.slice(0, 30)).stoppedOnFailure,
      true,
    );
  } finally {
    f.cleanup();
  }
});
