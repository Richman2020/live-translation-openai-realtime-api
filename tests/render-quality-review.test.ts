import assert from 'node:assert/strict';
import {
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

import {
  escapeReviewText,
  renderQualityReview,
} from '../scripts/render-quality-review';

function fixture() {
  const cwd = mkdtempSync(resolve(tmpdir(), 'quality-review-test-'));
  const root = resolve(cwd, '.runtime/results');
  mkdirSync(root, { recursive: true });
  const cases = [{ id: '01' }, { id: 'L02' }];
  const summary = {
    version: 'continuous-quality-results/1',
    kind: 'synthetic',
    cases: cases.map((item) => ({
      ...item,
      conditions: ['off', 'near_field'].map((condition) => ({
        condition,
        expectedRuns: 3,
      })),
    })),
  };
  const plan = {
    cases: cases.map((item) => ({
      ...item,
      sourceText: 'Source sentence.',
      expectedTranslation: 'Expected meaning.',
    })),
  };
  const write = (name: string, value: unknown) =>
    writeFileSync(resolve(root, name), JSON.stringify(value));
  write('summary.json', summary);
  write('plan.private.json', plan);
  const report = (id = '01', condition = 'off', repetition = 1) => {
    const runId = `${id}-r${repetition}-${condition}`;
    const dir = resolve(root, runId);
    mkdirSync(dir);
    const result = {
      id: runId,
      caseId: id,
      condition,
      repetition,
      role: 'local',
      targetLanguage: 'en',
      completed: true,
      failure: null,
      providerDrainConfirmed: true,
      sourceText: 'Source sentence.',
      expectedTranslation: 'Expected meaning.',
      outputTranscript: 'Actual meaning.',
      sentInputBytes: 8000,
      rawOutputBytes: 48000,
      estimatedFirstEnergyAfterInputStartMs: 1234,
      estimatedLastEnergyAfterSourceFileEndMs: 987,
      localFilterDrainBytes: 64,
    };
    write(`${runId}/result.private.json`, result);
    for (const name of ['input-8k.wav', 'provider-24k.wav', 'phone-8k.wav'])
      writeFileSync(resolve(dir, name), Buffer.alloc(44));
    return {
      dir,
      result,
      save: () => write(`${runId}/result.private.json`, result),
    };
  };
  return {
    cwd,
    root,
    summary,
    plan,
    write,
    report,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

test('review shows every planned case and repeat, marks absent results, and uses lazy local audio', () => {
  const f = fixture();
  try {
    f.report();
    const result = renderQualityReview({ input: f.root, cwd: f.cwd });
    assert.equal(result.plannedRuns, 12);
    assert.equal(result.completeRuns, 1);
    assert.equal(result.missingRuns, 11);
    assert.equal(result.humanReview, 'pending');
    const html = readFileSync(result.output, 'utf8');
    assert.match(html, /案例 L02/);
    assert.equal((html.match(/第 3 次/g) ?? []).length, 2);
    assert.equal((html.match(/未完成／无结果文件/g) ?? []).length, 11);
    assert.equal(
      (html.match(/<audio controls preload="none"/g) ?? []).length,
      3,
    );
    assert.match(html, /src="\.\/01-r1-off\/provider-24k\.wav"/);
    assert.match(html, /完成次数不是准确率/);
    assert.match(html, /不是耳听延迟/);
    assert.doesNotMatch(html, /<script|https?:\/\//i);
    assert.match(html, /connect-src 'none'/);
  } finally {
    f.cleanup();
  }
});

test('review escapes injected source, expected text, transcript and failure; long text is labelled truncated', () => {
  const f = fixture();
  try {
    const payload =
      '<script>alert("private")</script><audio src="https://bad.example/x">&\'';
    f.plan.cases[0].sourceText = payload;
    f.plan.cases[0].expectedTranslation = payload;
    f.write('plan.private.json', f.plan);
    const run = f.report();
    run.result.outputTranscript = payload + 'x'.repeat(13000);
    run.result.failure = payload;
    run.result.completed = false;
    run.save();
    const result = renderQualityReview({ input: f.root, cwd: f.cwd });
    const html = readFileSync(result.output, 'utf8');
    assert.doesNotMatch(html, /<script>|<audio src="https:/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&quot;private&quot;/);
    assert.match(html, /&#39;/);
    assert.match(html, /展示已截断/);
    assert.equal(result.completeRuns, 0);
    assert.equal(escapeReviewText('<b>&'), '&lt;b&gt;&amp;');
  } finally {
    f.cleanup();
  }
});

test('review refuses root traversal, source junctions, malformed IDs and overwriting without force', () => {
  const f = fixture();
  try {
    assert.throws(
      () => renderQualityReview({ input: f.cwd, cwd: f.cwd }),
      /INSIDE_RUNTIME/,
    );
    mkdirSync(resolve(f.cwd, 'outside'));
    symlinkSync(
      resolve(f.cwd, 'outside'),
      resolve(f.cwd, '.runtime/linked'),
      'junction',
    );
    assert.throws(
      () => renderQualityReview({ input: '.runtime/linked', cwd: f.cwd }),
      /SYMLINK_OR_JUNCTION/,
    );
    renderQualityReview({ input: f.root, cwd: f.cwd });
    assert.throws(
      () => renderQualityReview({ input: f.root, cwd: f.cwd }),
      /ALREADY_EXISTS/,
    );
    assert.doesNotThrow(() =>
      renderQualityReview({ input: f.root, cwd: f.cwd, force: true }),
    );
    f.summary.cases[0].id = '../../outside';
    f.write('summary.json', f.summary);
    assert.throws(
      () => renderQualityReview({ input: f.root, cwd: f.cwd, force: true }),
      /INVALID_REVIEW_CASE/,
    );
  } finally {
    f.cleanup();
  }
});

test('run junctions and mismatched report identity remain visible as rejected runs with no audio links', () => {
  const f = fixture();
  try {
    mkdirSync(resolve(f.cwd, 'outside'));
    symlinkSync(
      resolve(f.cwd, 'outside'),
      resolve(f.root, '01-r1-off'),
      'junction',
    );
    const mismatch = f.report('01', 'near_field');
    mismatch.result.caseId = 'L02';
    mismatch.save();
    const result = renderQualityReview({ input: f.root, cwd: f.cwd });
    const html = readFileSync(result.output, 'utf8');
    assert.match(html, /SYMLINK_OR_JUNCTION_NOT_ALLOWED/);
    assert.match(html, /RESULT_ID_OR_DIRECTION_MISMATCH/);
    assert.doesNotMatch(html, /<audio /);
    assert.equal(result.missingRuns, 12);
  } finally {
    f.cleanup();
  }
});

test('oversized result JSON is rejected per run and unsafe output destinations are never replaced', () => {
  const f = fixture();
  try {
    const run = f.report();
    writeFileSync(
      resolve(run.dir, 'result.private.json'),
      'x'.repeat(2 * 1024 * 1024 + 1),
    );
    const result = renderQualityReview({ input: f.root, cwd: f.cwd });
    assert.match(
      readFileSync(result.output, 'utf8'),
      /RESULT_JSON_TOO_LARGE_OR_NOT_FILE/,
    );
    rmSync(result.output);
    mkdirSync(resolve(f.cwd, 'outside'));
    symlinkSync(resolve(f.cwd, 'outside'), result.output, 'junction');
    assert.throws(
      () => renderQualityReview({ input: f.root, cwd: f.cwd, force: true }),
      /SYMLINK_OR_JUNCTION/,
    );
  } finally {
    f.cleanup();
  }
});

test('missing plan still permits fixed-path result review and corrupted summaries fail closed', () => {
  const f = fixture();
  try {
    f.report();
    rmSync(resolve(f.root, 'plan.private.json'));
    const result = renderQualityReview({ input: f.root, cwd: f.cwd });
    assert.match(readFileSync(result.output, 'utf8'), /Source sentence\./);
    f.summary.cases[0].conditions[1].expectedRuns = 4;
    f.write('summary.json', f.summary);
    assert.throws(
      () => renderQualityReview({ input: f.root, cwd: f.cwd, force: true }),
      /INVALID_REPETITION/,
    );
  } finally {
    f.cleanup();
  }
});
