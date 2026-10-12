import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  parseMediaTraceArguments,
  runMediaTraceAnalysis,
} from '../scripts/analyze-media-trace';
import {
  analyzeMediaTrace,
  parseMediaTrace,
  simulateMediaFifo,
  traceStatistics,
} from '../src/solo/media-trace-analysis';

const pipeline = '11111111-1111-4111-8111-111111111111';
function events(at = 0, index = 1, confirmed = true) {
  const common = {
    event: 'translation-audio',
    pipelineId: pipeline,
    role: 'local',
    recipientRole: 'remote',
    clock: 'bridge_monotonic',
    deliveryId: `continuous_${index}`,
    createdAtMs: at,
    generatedBytes: 1600,
    rms: 300,
    transcript: 'PRIVATE_CONTENT_CANARY',
    credential: 'PRIVATE_CREDENTIAL_CANARY',
  };
  return [
    { ...common, stage: 'generated', observedAtMs: at + 0.01, sentBytes: 0 },
    {
      ...common,
      stage: 'sent',
      observedAtMs: at + 0.3,
      sentAtMs: at + 0.3,
      sentBytes: 1600,
    },
    {
      ...common,
      stage: confirmed ? 'playback_confirmed' : 'unconfirmed',
      observedAtMs: at + 250,
      sentAtMs: at + 0.3,
      sentBytes: 1600,
      ...(confirmed ? { acknowledgedAtMs: at + 250 } : {}),
    },
  ];
}
const log = (items: unknown[]) =>
  items.map((item) => JSON.stringify(item)).join('\n');

test('paced FIFO moves burst backlog locally without improving a single completion', () => {
  const chunks = Array.from({ length: 4 }, () => ({
    availableAtMs: 0,
    durationMs: 200,
  }));
  const immediate = simulateMediaFifo(chunks, { mode: 'immediate' });
  const paced = simulateMediaFifo(chunks, { mode: 'paced' });
  assert.deepEqual(immediate.completions, [200, 400, 600, 800]);
  assert.deepEqual(paced.completions, immediate.completions);
  assert.equal(immediate.summary.maxLocalAudioMs, 0);
  assert.equal(immediate.summary.maxDownstreamAudioMs, 800);
  assert.equal(paced.summary.maxLocalAudioMs, 780);
  assert.equal(paced.summary.maxDownstreamAudioMs, 20);
  assert.equal(paced.summary.maxCombinedAudioMs, 800);
  assert.equal(paced.summary.firstAvailabilityToAllCompleteMs, 800);
  assert.equal(paced.summary.totalAudioMs, immediate.summary.totalAudioMs);
});

test('gaps, tied arrivals and partial frames preserve order and sample duration', () => {
  const chunks = [
    { availableAtMs: 25, durationMs: 30.125 },
    { availableAtMs: 25, durationMs: 40 },
    { availableAtMs: 500, durationMs: 20 },
  ];
  const direct = simulateMediaFifo(chunks, { mode: 'immediate' });
  assert.deepEqual(direct.completions, [55.125, 95.125, 520]);
  for (const lookaheadMs of [0, 40, 100, 200]) {
    const paced = simulateMediaFifo(chunks, { mode: 'paced', lookaheadMs });
    assert.deepEqual(paced.completions, direct.completions);
    assert.equal(paced.summary.totalAudioMs, 90.125);
    assert.equal(paced.summary.firstAvailabilityToPlaybackMs, 0);
  }
});

test('adding startup buffering worsens original-arrival latency even if downstream queue shrinks', () => {
  const chunks = [{ availableAtMs: 100, durationMs: 1000 }];
  const result = simulateMediaFifo(chunks, {
    mode: 'paced',
    startupDelayMs: 100,
  });
  assert.equal(result.summary.firstAvailabilityToPlaybackMs, 100);
  assert.equal(result.summary.firstAvailabilityToAllCompleteMs, 1100);
  assert.equal(result.summary.maxDownstreamAudioMs, 20);
  assert.equal(result.summary.maxCombinedAudioMs, 1000);
});

test('deterministic variable traces never complete earlier by delaying ordered samples', () => {
  let seed = 17;
  const next = () => {
    seed = (seed * 16807) % 2147483647;
    return seed;
  };
  for (let run = 0; run < 30; run += 1) {
    let at = 1000;
    const chunks = Array.from({ length: 25 }, () => {
      at += next() % 301;
      return {
        availableAtMs: at,
        durationMs: [0.125, 20, 63.25, 200, 240.125][next() % 5],
      };
    });
    const direct = simulateMediaFifo(chunks, { mode: 'immediate' });
    const paced = simulateMediaFifo(chunks, {
      mode: 'paced',
      lookaheadMs: next() % 201,
    });
    assert.equal(paced.summary.totalAudioMs, direct.summary.totalAudioMs);
    paced.completions.forEach((end, i) =>
      assert.ok(end + 0.000001 >= direct.completions[i]),
    );
  }
});

test('simulation rejects malformed, backwards and excessive traces before allocating frames', () => {
  assert.throws(
    () => simulateMediaFifo([], { mode: 'immediate' }),
    /INVALID_MEDIA_FIFO_OPTIONS/,
  );
  assert.throws(
    () =>
      simulateMediaFifo([{ availableAtMs: 0, durationMs: 20 }], {
        mode: 'paced',
        frameMs: 0,
      }),
    /INVALID_MEDIA_FIFO_OPTIONS/,
  );
  assert.throws(
    () =>
      simulateMediaFifo(
        [
          { availableAtMs: 1, durationMs: 20 },
          { availableAtMs: 0, durationMs: 20 },
        ],
        { mode: 'immediate' },
      ),
    /INVALID_MEDIA_FIFO_CHUNK/,
  );
  assert.throws(
    () =>
      simulateMediaFifo([{ availableAtMs: 0, durationMs: Number.NaN }], {
        mode: 'immediate',
      }),
    /INVALID_MEDIA_FIFO_CHUNK/,
  );
  assert.throws(
    () =>
      simulateMediaFifo(
        Array.from({ length: 101 }, () => ({
          availableAtMs: 0,
          durationMs: 10000,
        })),
        { mode: 'paced', frameMs: 1 },
      ),
    /MEDIA_FIFO_TOO_LARGE/,
  );
});

test('parser and report retain numerical evidence but exclude identifiers and private fields', () => {
  const raw = `${log(events())}\nPRIVATE_STARTUP_CANARY\n${log(events(400, 2, false))}\n${log(events(500).map((e) => ({ ...e, pipelineId: 'unrelated' })))}`;
  const trace = parseMediaTrace(raw, pipeline);
  assert.equal(trace.chunks.length, 2);
  assert.equal(trace.chunks[1].acknowledgedAtMs, undefined);
  const report = analyzeMediaTrace(trace);
  assert.equal(report.observed.sentToMarkMs.count, 1);
  assert.equal(report.observed.unconfirmedChunks, 1);
  assert.equal(report.observed.nonzeroUnconfirmedChunks, 1);
  assert.equal(report.simulation.immediate.totalAudioMs, 400);
  for (const candidate of report.simulation.pacedCandidates) {
    assert.equal(candidate.improvedChunks, 0);
    assert.equal(candidate.worsenedChunks, 0);
    assert.equal(candidate.totalAudioMs, 400);
  }
  const serialized = JSON.stringify({ trace, report });
  for (const secret of ['PRIVATE_', pipeline, 'continuous_1', 'unrelated'])
    assert.equal(serialized.includes(secret), false);
});

test('invalid selected evidence fails closed instead of becoming favorable missing data', () => {
  assert.throws(() => parseMediaTrace(log([]), pipeline), /MEDIA_TRACE_EMPTY/);
  assert.throws(
    () => parseMediaTrace(log([...events(), events()[0]]), pipeline),
    /DUPLICATE_MEDIA_TRACE_STAGE/,
  );
  assert.throws(
    () =>
      parseMediaTrace(
        log(events().map((e) => ({ ...e, clock: 'wall' }))),
        pipeline,
      ),
    /INVALID_MEDIA_TRACE_CLOCK/,
  );
  assert.throws(
    () => parseMediaTrace(log(events().slice(1)), pipeline),
    /INCOMPLETE_MEDIA_TRACE_DELIVERY/,
  );
  const inconsistent = events();
  assert.throws(
    () =>
      parseMediaTrace(
        log(events().map((e) => ({ ...e, audioDurationMs: 100 }))),
        pipeline,
      ),
    /INCONSISTENT_MEDIA_TRACE_DELIVERY/,
  );
  const badAck = events();
  badAck[2].sentBytes = 800;
  assert.throws(
    () => parseMediaTrace(log(badAck), pipeline),
    /INVALID_MEDIA_TRACE_COMPLETION/,
  );
  inconsistent[1].generatedBytes = 800;
  assert.throws(
    () => parseMediaTrace(log(inconsistent), pipeline),
    /INCONSISTENT_MEDIA_TRACE_DELIVERY/,
  );
  assert.throws(
    () => parseMediaTrace(log([...events(400), ...events(0, 2)]), pipeline),
    /NON_MONOTONIC_MEDIA_TRACE/,
  );
  assert.throws(
    () =>
      parseMediaTrace(
        log(events().map((e) => ({ ...e, generatedBytes: 0 }))),
        pipeline,
      ),
    /INVALID_MEDIA_TRACE_DELIVERY/,
  );
});

test('observed bursts and pauses reconstruct duration drift without labeling modeled residual as network latency', () => {
  const availability = [0, 1, 601, 602];
  const completions = [200, 400, 801, 1001];
  const report = analyzeMediaTrace({
    chunks: availability.map((availableAtMs, index) => ({
      availableAtMs,
      generatedAtMs: availableAtMs + 0.01,
      sentAtMs: availableAtMs + 0.3,
      acknowledgedAtMs: completions[index] + 300,
      durationMs: 200,
      rms: 0,
      unconfirmed: false,
    })),
    inputWindows: [{ startedAtMs: 0, endedAtMs: 600, durationMs: 200 }],
  });
  assert.equal(report.observed.arrivalGapMs.max, 600);
  assert.equal(report.observed.gapsOver500Ms, 1);
  assert.equal(report.observed.burstsWithAdjacentGapAtMost20Ms.count, 2);
  assert.equal(
    report.observed.burstsWithAdjacentGapAtMost20Ms.audioMs.max,
    400,
  );
  assert.equal(report.observed.totalAudioMs, 800);
  assert.equal(report.observed.availableClockSpanMs, 602);
  assert.equal(report.observed.cumulativeAudioMinusAvailableClockMs, 198);
  assert.equal(
    report.observed.modelResidualMarkMinusIdealCompletionMs.median,
    300,
  );
  assert.equal(
    report.simulation.immediate.firstAvailabilityToAllCompleteMs,
    1001,
  );
  assert.equal(report.simulation.immediate.maxCombinedAudioMs, 399);
  assert.equal(report.observed.inputAudioMs, 200);
  assert.equal(report.observed.inputWindowReceiptSpanMs.max, 600);
});

test('quantiles are explicit and a missing confirmation is never zero latency', () => {
  assert.deepEqual(traceStatistics([]), { count: 0 });
  assert.deepEqual(traceStatistics([10, 20, 30, 40]), {
    count: 4,
    min: 10,
    median: 25,
    p95: 40,
    max: 40,
  });
  const report = analyzeMediaTrace(
    parseMediaTrace(log(events(0, 1, false)), pipeline),
  );
  assert.deepEqual(report.observed.sentToMarkMs, { count: 0 });
  assert.equal(report.observed.missingTerminalEvidenceChunks, 0);
  const truncated = analyzeMediaTrace(
    parseMediaTrace(log([events()[0]]), pipeline),
  );
  assert.equal(truncated.observed.unconfirmedChunks, 0);
  assert.equal(truncated.observed.missingTerminalEvidenceChunks, 1);
  assert.equal(truncated.observed.withoutCompletedSendChunks, 1);
  assert.deepEqual(truncated.observed.sentToMarkMs, { count: 0 });
});

test('CLI binds the source hash, writes only a new private report, and never echoes source content', (t) => {
  const root = resolve('.runtime');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'media-trace-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'input.log');
  const out = join(dir, 'report.json');
  const raw = log(events());
  writeFileSync(input, raw);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const options = parseMediaTraceArguments([
    '--input',
    input,
    '--pipeline',
    pipeline,
    '--sha256',
    sha256,
    '--out',
    out,
  ]);
  assert.throws(
    () => runMediaTraceAnalysis({ ...options, sha256: '0'.repeat(64) }),
    /MEDIA_TRACE_HASH_MISMATCH/,
  );
  assert.equal(existsSync(out), false);
  assert.throws(
    () =>
      runMediaTraceAnalysis({
        ...options,
        out: join(tmpdir(), 'not-an-allowed-media-report.json'),
      }),
    /MEDIA_TRACE_OUTPUT_MUST_STAY_PRIVATE/,
  );
  const summary = runMediaTraceAnalysis(options);
  assert.equal(summary.chunks, 1);
  assert.equal(JSON.stringify(summary).includes(pipeline), false);
  assert.equal(readFileSync(out, 'utf8').includes('PRIVATE_'), false);
  assert.throws(() => runMediaTraceAnalysis(options), /EEXIST/);
  assert.throws(
    () => parseMediaTraceArguments(['--input', input]),
    /USE_INPUT_PIPELINE_SHA256_AND_PRIVATE_OUT/,
  );
});
