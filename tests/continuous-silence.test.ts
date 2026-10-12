import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import {
  evaluateSilence,
  prepareSilencePlan,
  silenceDryRun,
  summarizeSilence,
} from '../src/experiments/continuous-silence';
import { runQualitySession } from '../src/experiments/continuous-quality-matrix';
import type { ContinuousTranslationOptions } from '../src/solo/continuous-translation-client';

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'phone-silence-test-'));
  return {
    root,
    cleanup() {
      assert.equal(realpathSync(root), root);
      assert.ok(root.startsWith(resolve(tmpdir(), 'phone-silence-test-')));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function fakeRun(
  plan: ReturnType<typeof prepareSilencePlan>['plan'],
  text = '',
  amplitude?: number,
) {
  let clock = 0;
  let aborts = 0;
  const sent: Buffer[] = [];
  let options: ContinuousTranslationOptions;
  const result = await runQualitySession(
    plan.cases[0],
    plan.runs[0],
    { apiKey: 'offline-test' },
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      createClient: (settings) => {
        options = settings;
        return {
          ready: Promise.resolve(),
          append: (pcm) => {
            sent.push(pcm);
          },
          finish: async () => {
            if (text) settings.onTranscript?.(text);
            if (amplitude !== undefined) {
              const audio = Buffer.alloc(960);
              for (let i = 0; i < 480; i += 1)
                audio.writeInt16LE(amplitude, i * 2);
              settings.onAudio(audio);
            }
          },
          abort: () => {
            aborts += 1;
          },
        };
      },
    },
  );
  return { result, sent, aborts, options };
}

test('silence plan fixes eight seconds, both languages, both noise conditions and four requests', () => {
  const f = fixture();
  try {
    const { plan, dryRun } = prepareSilencePlan(
      ['--out', '.runtime/silence', '--dry-run'],
      f.root,
    );
    assert.equal(dryRun, true);
    assert.equal(plan.runs.length, 4);
    assert.deepEqual(
      plan.cases.map((item) => item.targetLanguage),
      ['en', 'zh'],
    );
    assert.deepEqual(
      plan.runs.map((item) => item.condition),
      ['off', 'near_field', 'off', 'near_field'],
    );
    assert.ok(
      plan.cases.every(
        (item) =>
          item.input.length === 64000 &&
          item.input.every((value) => value === 255),
      ),
    );
    assert.equal(silenceDryRun(plan).writesPerformed, false);
    assert.equal(existsSync(resolve(f.root, '.runtime')), false);
    for (const args of [
      [],
      ['--out', 'public'],
      ['--out', '.runtime/s', '--repeat', '2'],
      ['--out', '.runtime/s', '--dry-run', '--dry-run'],
    ])
      assert.throws(() => prepareSilencePlan(args, f.root));
  } finally {
    f.cleanup();
  }
});

test('drained zero audio is synthetic silence evidence and never phone success', async () => {
  const f = fixture();
  try {
    const { plan } = prepareSilencePlan(['--out', '.runtime/s'], f.root);
    const run = await fakeRun(plan);
    assert.equal(run.result.report.failure, 'NO_CONTINUOUS_AUDIO');
    assert.equal(run.result.report.providerDrainConfirmed, true);
    assert.equal(run.result.report.completed, false);
    assert.ok(Buffer.concat(run.sent).every((value) => value === 0));
    assert.equal(run.result.sentInput.length, 98400);
    assert.equal(run.aborts, 1);
    const evaluation = evaluateSilence(run.result);
    assert.equal(evaluation.status, 'SYNTHETIC_SILENCE_NO_ACTIVITY');
    assert.equal(evaluation.phoneCallSucceeded, false);
    assert.equal(evaluation.realEnvironmentAccepted, false);
  } finally {
    f.cleanup();
  }
});

test('text alone or raw energy at threshold fails, explicit silent frames do not', async () => {
  const f = fixture();
  try {
    const { plan } = prepareSilencePlan(['--out', '.runtime/s'], f.root);
    assert.equal(
      evaluateSilence((await fakeRun(plan, 'Hello')).result).status,
      'FAIL',
    );
    assert.equal(
      evaluateSilence((await fakeRun(plan, '', 300)).result).status,
      'FAIL',
    );
    assert.equal(
      evaluateSilence((await fakeRun(plan, '', 0)).result).status,
      'SYNTHETIC_SILENCE_NO_ACTIVITY',
    );
    const { result } = await fakeRun(plan, '', 0);
    result.report.providerDrainConfirmed = false;
    assert.equal(evaluateSilence(result).status, 'INCONCLUSIVE');
    result.report.providerDrainConfirmed = true;
    result.report.failure = 'CONNECTION_FAILED';
    assert.equal(evaluateSilence(result).status, 'INCONCLUSIVE');
  } finally {
    f.cleanup();
  }
});

test('summary requires all four results and preserves failure and inconclusive boundaries', () => {
  const noActivity = {
    status: 'SYNTHETIC_SILENCE_NO_ACTIVITY' as const,
    reason: 'fixture',
    hasOutputText: false,
    rawEnergyDetected: false,
    phoneEnergyDetected: false,
    thresholdRms: 300 as const,
    frameMs: 20 as const,
    realEnvironmentAccepted: false as const,
    phoneCallSucceeded: false as const,
  };
  const entries: Parameters<typeof summarizeSilence>[0] = Array.from(
    { length: 4 },
    (_, i) => ({
      id: String(i),
      evaluation: noActivity,
    }),
  );
  assert.equal(summarizeSilence(entries.slice(0, 3)).status, 'INCONCLUSIVE');
  assert.equal(
    summarizeSilence(entries).status,
    'SYNTHETIC_SILENCE_NO_ACTIVITY',
  );
  entries[1].evaluation = {
    ...noActivity,
    status: 'FAIL',
  };
  assert.equal(summarizeSilence(entries).status, 'FAIL');
  entries[2].evaluation = {
    ...noActivity,
    status: 'INCONCLUSIVE',
  };
  assert.equal(summarizeSilence(entries).status, 'INCONCLUSIVE');
  assert.equal(summarizeSilence(entries).activityDetected, true);
});

test('CLI dry-run works without env, writes nothing and reports no provider use', () => {
  const f = fixture();
  try {
    const script = resolve('scripts/check-continuous-silence.ts');
    const loader = pathToFileURL(
      resolve('node_modules/tsx/dist/loader.mjs'),
    ).href;
    const output = execFileSync(
      process.execPath,
      ['--import', loader, script, '--out', '.runtime/silence', '--dry-run'],
      { cwd: f.root, encoding: 'utf8' },
    );
    const result = JSON.parse(output);
    assert.equal(result.runCount, 4);
    assert.equal(result.credentialsRead, false);
    assert.equal(result.networkUsed, false);
    assert.equal(existsSync(resolve(f.root, '.runtime')), false);
  } finally {
    f.cleanup();
  }
});
