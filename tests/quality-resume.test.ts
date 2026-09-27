/* eslint-disable no-await-in-loop -- Explicitly ordered experiment history. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  beginQualityAttempt,
  copyQualityResume,
  extractQualityResumeArgument,
  finishQualityAttempt,
  isContinuableQualityFailure,
  validateQualityResume,
} from '../src/experiments/quality-resume';
import {
  createQualityOutput,
  runQualitySession,
  saveQualityRun,
  summarizeQualityRuns,
  type QualityPlan,
} from '../src/experiments/continuous-quality-matrix';

async function fixture(failedFirst = false) {
  const cwd = mkdtempSync(resolve(tmpdir(), 'quality-resume-test-'));
  const input = Buffer.alloc(320, 180);
  const inputSha256 = createHash('sha256').update(input).digest('hex');
  const previous: QualityPlan = {
    kind: 'synthetic',
    repeat: 3,
    outputRoot: resolve(cwd, '.runtime/old'),
    cases: [
      {
        id: '01',
        role: 'local',
        targetLanguage: 'en',
        kind: 'short',
        inputFile: 'unused.pcmu',
        sourceText: 'Hello.',
        expectedTranslation: '你好。',
        input,
        inputSha256,
      },
    ],
    runs: Array.from({ length: 6 }, (_, index) => ({
      id: `01-r${Math.floor(index / 2) + 1}-${index % 2 ? 'near_field' : 'off'}`,
      caseId: '01',
      repetition: Math.floor(index / 2) + 1,
      condition: index % 2 ? ('near_field' as const) : ('off' as const),
      inputSha256,
    })),
  };
  createQualityOutput(previous);
  const reports = [];
  for (const run of previous.runs.slice(0, 2)) {
    let time = 0;
    const result = await runQualitySession(
      previous.cases[0],
      run,
      { apiKey: 'offline-fixture' },
      {
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
        createClient: (options) => ({
          ready: Promise.resolve(),
          append() {},
          abort() {},
          finish: async () => {
            if (run.condition === (failedFirst ? 'near_field' : 'off'))
              options.onAudio(Buffer.alloc(960));
            options.onTranscript?.('Hello.');
          },
        }),
      },
    );
    saveQualityRun(previous.outputRoot, result);
    reports.push(result.report);
  }
  const writeSummary = () =>
    writeFileSync(
      resolve(previous.outputRoot, 'summary.json'),
      JSON.stringify(summarizeQualityRuns(previous, reports)),
    );
  writeSummary();
  const next = { ...previous, outputRoot: resolve(cwd, '.runtime/new') };
  return {
    cwd,
    previous,
    next,
    reports,
    writeSummary,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

test('explicit resume keeps successful and no-audio attempts unchanged and never schedules them again', async () => {
  const f = await fixture();
  try {
    const resume = validateQualityResume(f.next, f.previous.outputRoot, f.cwd);
    assert.equal(resume.reports.length, 2);
    assert.equal(resume.reports[1].failure, 'NO_CONTINUOUS_AUDIO');
    assert.equal(isContinuableQualityFailure(resume.reports[1]), true);
    assert.equal(f.next.runs.slice(resume.reports.length).length, 4);
    assert.equal(
      existsSync(resolve(f.previous.outputRoot, '01-r2-off')),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test('copy produces a fresh independent private directory and preserves all seven artifact bytes', async () => {
  const f = await fixture();
  try {
    const resume = validateQualityResume(f.next, f.previous.outputRoot, f.cwd);
    const before = new Map(
      resume.artifacts.map((item) => [
        `${item.runId}/${item.name}`,
        readFileSync(resolve(f.previous.outputRoot, item.runId, item.name)),
      ]),
    );
    createQualityOutput(f.next);
    copyQualityResume(f.next, resume, f.cwd);
    for (const [name, bytes] of before) {
      assert.deepEqual(readFileSync(resolve(f.next.outputRoot, name)), bytes);
      assert.deepEqual(
        readFileSync(resolve(f.previous.outputRoot, name)),
        bytes,
      );
    }
    assert.throws(() => copyQualityResume(f.next, resume, f.cwd), /NOT_FRESH/);
    const meta = JSON.parse(
      readFileSync(resolve(f.next.outputRoot, 'resume.private.json'), 'utf8'),
    );
    assert.equal(meta.priorAttemptedRuns, 2);
    assert.deepEqual(
      meta.copiedRunIds,
      f.previous.runs.slice(0, 2).map((run) => run.id),
    );
  } finally {
    f.cleanup();
  }
});

test('resume rejects altered plans, different input audio, holes, and unknown run files', async () => {
  const f = await fixture();
  try {
    const altered = {
      ...f.next,
      runs: f.next.runs.map((item) => ({ ...item })),
    };
    altered.runs[0].inputSha256 = '0'.repeat(64);
    assert.throws(
      () => validateQualityResume(altered, f.previous.outputRoot, f.cwd),
      /PLAN_MISMATCH/,
    );
    const path = resolve(f.previous.outputRoot, '01-r1-off/input.pcmu');
    writeFileSync(path, Buffer.alloc(320, 0));
    assert.throws(
      () => validateQualityResume(f.next, f.previous.outputRoot, f.cwd),
      /INPUT_OR_ID_MISMATCH/,
    );
    writeFileSync(path, f.previous.cases[0].input);
    renameSync(
      resolve(f.previous.outputRoot, '01-r1-off'),
      resolve(f.previous.outputRoot, '01-r2-off'),
    );
    assert.throws(
      () => validateQualityResume(f.next, f.previous.outputRoot, f.cwd),
      /PREFIX_HAS_HOLE/,
    );
    renameSync(
      resolve(f.previous.outputRoot, '01-r2-off'),
      resolve(f.previous.outputRoot, '01-r1-off'),
    );
    writeFileSync(
      resolve(f.previous.outputRoot, '01-r1-off/unknown.txt'),
      'extra',
    );
    assert.throws(
      () => validateQualityResume(f.next, f.previous.outputRoot, f.cwd),
      /UNKNOWN_OR_MISSING/,
    );
  } finally {
    f.cleanup();
  }
});

test('resume rejects unresolved provider failures, incorrect summary and unacknowledged attempts after failure', async () => {
  const f = await fixture();
  try {
    const reportPath = resolve(
      f.previous.outputRoot,
      '01-r1-near_field/result.private.json',
    );
    const saved = readFileSync(reportPath);
    const changed = JSON.parse(saved.toString());
    changed.failure = 'PROVIDER_CONNECTION_FAILED';
    writeFileSync(reportPath, JSON.stringify(changed));
    assert.throws(
      () => validateQualityResume(f.next, f.previous.outputRoot, f.cwd),
      /UNRESOLVED_TRANSPORT/,
    );
    writeFileSync(reportPath, saved);
    const summaryPath = resolve(f.previous.outputRoot, 'summary.json');
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    summary.attemptedRuns = 0;
    writeFileSync(summaryPath, JSON.stringify(summary));
    assert.throws(
      () => validateQualityResume(f.next, f.previous.outputRoot, f.cwd),
      /SUMMARY_MISMATCH/,
    );
    f.writeSummary();
    assert.equal(
      isContinuableQualityFailure({
        ...f.reports[1],
        providerDrainConfirmed: false,
      }),
      false,
    );
    assert.equal(
      isContinuableQualityFailure({ ...f.reports[1], rawOutputBytes: 2 }),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test('resume rejects nested outputs, links and source changes between validation and copy', async () => {
  const f = await fixture();
  try {
    assert.throws(
      () =>
        validateQualityResume(
          { ...f.next, outputRoot: resolve(f.previous.outputRoot, 'nested') },
          f.previous.outputRoot,
          f.cwd,
        ),
      /SEPARATE_NEW/,
    );
    mkdirSync(resolve(f.cwd, 'outside'));
    symlinkSync(
      resolve(f.cwd, 'outside'),
      resolve(f.cwd, '.runtime/link'),
      'junction',
    );
    assert.throws(
      () => validateQualityResume(f.next, '.runtime/link', f.cwd),
      /LINK_NOT_ALLOWED/,
    );
    const resume = validateQualityResume(f.next, f.previous.outputRoot, f.cwd);
    createQualityOutput(f.next);
    writeFileSync(
      resolve(f.previous.outputRoot, '01-r1-off/input.pcmu'),
      Buffer.alloc(320),
    );
    assert.throws(
      () => copyQualityResume(f.next, resume, f.cwd),
      /SOURCE_CHANGED_BEFORE_COPY/,
    );
  } finally {
    f.cleanup();
  }
});

test('resume switch is explicit, unique, and removed before ordinary CLI parsing', () => {
  assert.deepEqual(
    extractQualityResumeArgument([
      '--manifest',
      'input',
      '--resume-from',
      'old',
      '--out',
      'new',
    ]),
    { args: ['--manifest', 'input', '--out', 'new'], resumeFrom: 'old' },
  );
  assert.equal(
    extractQualityResumeArgument(['--manifest', 'input']).resumeFrom,
    undefined,
  );
  assert.throws(
    () =>
      extractQualityResumeArgument([
        '--resume-from',
        'one',
        '--resume-from',
        'two',
      ]),
    /INVALID_RESUME/,
  );
  assert.throws(
    () => extractQualityResumeArgument(['--resume-from']),
    /INVALID_RESUME/,
  );
});

test('a fresh source cannot silently contain attempted runs after its first failure', async () => {
  const f = await fixture(true);
  try {
    assert.throws(
      () => validateQualityResume(f.next, f.previous.outputRoot, f.cwd),
      /ATTEMPTS_AFTER_UNACKNOWLEDGED_FAILURE/,
    );
    writeFileSync(resolve(f.previous.outputRoot, 'resume.private.json'), '{}');
    assert.throws(
      () => validateQualityResume(f.next, f.previous.outputRoot, f.cwd),
      /INVALID_PROVENANCE/,
    );
  } finally {
    f.cleanup();
  }
});

test('inflight marker blocks unknown paid retries and is cleared only for its own run', async () => {
  const f = await fixture();
  try {
    const run = f.previous.runs[2];
    beginQualityAttempt(f.previous.outputRoot, run);
    assert.throws(() => beginQualityAttempt(f.previous.outputRoot, run));
    assert.throws(
      () => validateQualityResume(f.next, f.previous.outputRoot, f.cwd),
      /UNRESOLVED_INFLIGHT/,
    );
    assert.throws(
      () => finishQualityAttempt(f.previous.outputRoot, f.previous.runs[3]),
      /ID_MISMATCH/,
    );
    assert.equal(
      existsSync(resolve(f.previous.outputRoot, 'inflight.private.json')),
      true,
    );
    finishQualityAttempt(f.previous.outputRoot, run);
    assert.equal(
      existsSync(resolve(f.previous.outputRoot, 'inflight.private.json')),
      false,
    );
    assert.equal(
      validateQualityResume(f.next, f.previous.outputRoot, f.cwd).reports
        .length,
      2,
    );
  } finally {
    f.cleanup();
  }
});
