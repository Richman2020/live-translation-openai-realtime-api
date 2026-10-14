import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  AUDITION_CANDIDATE,
  assertAuditionCandidate,
  auditionMain,
  parseAuditionArgs,
  readAuditionApproval,
  validateAuditionOutput,
} from '../scripts/realtime-audition.mjs';
import {
  auditionAccountingReview,
  auditionWave,
  calculateAuditionUsageCost,
  reserveAuditionOutput,
  writeAuditionArtifacts,
} from '../src/experiments/realtime-audition-artifacts';
import { prepareAuditionInput } from '../src/experiments/realtime-audition-input';
import type { RealtimeAuditionResult } from '../src/experiments/realtime-audition-runner';
import type { AuditionTransportSnapshot } from '../src/experiments/realtime-audition-transport';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'audition-cli-test-'));
  const pcm = Buffer.alloc(24000);
  for (let offset = 0; offset < pcm.length; offset += 2)
    pcm.writeInt16LE(1500, offset);
  const wave = auditionWave(pcm);
  const sampleSha256 = createHash('sha256').update(wave).digest('hex');
  const manifest = join(directory, 'manifest.json');
  writeFileSync(join(directory, 'test-only-synthetic.wav'), wave);
  writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      sourceKind: 'licensed-test',
      sourceDescription:
        'Synthetic non-speech waveform for offline unit tests only.',
      rightsConfirmed: true,
      voiceConsentConfirmed: true,
      containsRealCall: false,
      file: { path: 'test-only-synthetic.wav', sha256: sampleSha256 },
      segments: [
        {
          id: 'one',
          startSample: 0,
          endSample: 12000,
          sourceText: '离线测试占位，不是真实识别。',
        },
      ],
    }),
  );
  const approval = {
    version: 1,
    parentCandidate: AUDITION_CANDIDATE,
    approvedUsd: 1,
    approvalReference: 'Unit test only, not an actual paid approval.',
    sampleUseReference: 'Synthetic fixture only.',
    sampleSha256,
  };
  const approvalPath = join(directory, 'approval.json');
  writeFileSync(approvalPath, JSON.stringify(approval));
  return {
    directory,
    manifest,
    approvalPath,
    approval,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function snapshot(): AuditionTransportSnapshot {
  return {
    state: 'closed',
    connections: 1,
    commits: 1,
    responses: 1,
    appendBytes: 24000,
    inlineBytes: 24000,
    sessionCapConfirmed: true,
    sessionInstructionBytes: 644,
    asrPromptBytes: 156,
    responseCapConfirmed: 1,
    requestAccounting: [
      {
        request: 1,
        sourceSequence: 1,
        inputTextBytes: 120,
        instructionBytes: 644,
        audioBytes: 24000,
        contextChars: 10,
        sourceChars: 10,
        priorAudioBytes: 0,
      },
    ],
    usage: [],
    cancellations: [],
    unknownUsage: true,
    allClosed: true,
  };
}

function fakeResult(): RealtimeAuditionResult {
  return {
    status: 'completed',
    model: 'gpt-realtime-2.1',
    voice: 'echo',
    parentCandidate: AUDITION_CANDIDATE,
    responses: [
      {
        sourceSequence: 1,
        responseId: 'R1',
        pcm: Buffer.alloc(480),
        rawAsrText: '实际模拟识别',
        translationText: 'Simulated result.',
        status: 'completed',
        timing: { firstAudioMs: 20, firstEnergyAudioMs: 22, completedMs: 30 },
      },
    ],
    transcripts: [],
    corrections: [],
    usage: [],
    counts: {
      inputBytesFed: 24000,
      inputSamples: 12000,
      outputBytesSaved: 480,
      asrCommits: 1,
      responsesRequested: 1,
      connections: 1,
    },
    accounting: snapshot(),
    timing: {
      startedAt: '2026-10-14T00:00:00Z',
      durationMs: 30,
      firstInputMs: 0,
      firstInputEnergyMs: 0,
      firstOutputMs: 20,
      firstOutputEnergyMs: 22,
      sources: [],
    },
  };
}

test('audition CLI defaults offline and rejects ambiguous/extra execution flags', () => {
  assert.equal(parseAuditionArgs(['--manifest', 'a.json']).executeOnce, false);
  assert.equal(
    parseAuditionArgs(['--manifest', 'a.json', '--dry-run']).executeOnce,
    false,
  );
  for (const args of [
    [],
    ['--manifest'],
    ['--unknown'],
    ['--help', '--dry-run'],
    ['--manifest', 'a.json', '--manifest', 'b.json'],
    ['--manifest', 'a.json', '--execute-once'],
    ['--manifest', 'a.json', '--execute-once', '--dry-run'],
    ['--manifest', 'a.json', '--output', 'out'],
    ['--manifest', 'a.json', '--approval', 'approval.json'],
    ['--manifest', 'a.json', '--voice', 'another'],
    ['--manifest', 'a.json', '--retry', '1'],
  ])
    assert.throws(() => parseAuditionArgs(args));
});

test('dry-run cannot read credentials, execute, write files, or print source text', async () => {
  const item = fixture();
  try {
    writeFileSync(
      join(item.directory, '.env'),
      'OPENAI_API_KEY=never-read-this-sentinel',
    );
    const before = readdirSync(item.directory).sort();
    let output = '';
    await auditionMain(['--manifest', item.manifest], {
      readEnvironment: () => {
        throw new Error('CREDENTIAL_ACCESS_FORBIDDEN');
      },
      execute: async () => {
        throw new Error('EXECUTION_FORBIDDEN');
      },
      stdout: (value) => {
        output += value;
      },
    });
    const summary = JSON.parse(output);
    assert.equal(summary.mode, 'offline_dry_run');
    assert.equal(summary.voice, 'echo');
    assert.equal(summary.maxOutputTokensPerResponse, 512);
    assert.equal(summary.credentialsRead, false);
    assert.equal(summary.paidCalls, 0);
    assert.equal(summary.budgetApproved, false);
    assert.equal(output.includes('离线测试占位'), false);
    assert.equal(output.includes('never-read-this-sentinel'), false);
    assert.deepEqual(readdirSync(item.directory).sort(), before);
  } finally {
    item.cleanup();
  }
});

test('real CLI subprocess dry-run inherits an inert fake key without leaking it or using proxy', () => {
  const item = fixture();
  try {
    const response = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve('scripts/realtime-audition.mts'),
        '--manifest',
        item.manifest,
      ],
      {
        cwd: resolve('.'),
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          OPENAI_API_KEY: 'fake-key-sentinel-do-not-use',
          HTTPS_PROXY: 'invalid-do-not-connect',
        },
      },
    );
    assert.equal(response.status, 0, response.stderr);
    assert.equal(response.stderr, '');
    assert.equal(response.stdout.includes('fake-key-sentinel'), false);
    assert.equal(JSON.parse(response.stdout).paidCalls, 0);
  } finally {
    item.cleanup();
  }
});

test('invalid approval or reused output stops before the environment getter', async () => {
  const item = fixture();
  try {
    let environmentReads = 0;
    const dependencies = {
      readEnvironment: () => {
        environmentReads += 1;
        return {};
      },
      execute: async () => {
        throw new Error('MUST_NOT_EXECUTE');
      },
    };
    writeFileSync(
      item.approvalPath,
      JSON.stringify({ ...item.approval, approvedUsd: 2 }),
    );
    await assert.rejects(
      auditionMain(
        [
          '--manifest',
          item.manifest,
          '--execute-once',
          '--approval',
          item.approvalPath,
          '--output',
          join(item.directory, 'new-output'),
        ],
        dependencies,
      ),
    );
    assert.equal(environmentReads, 0);
    writeFileSync(item.approvalPath, JSON.stringify(item.approval));
    await assert.rejects(
      auditionMain(
        [
          '--manifest',
          item.manifest,
          '--execute-once',
          '--approval',
          item.approvalPath,
          '--output',
          item.directory,
        ],
        dependencies,
      ),
    );
    assert.equal(environmentReads, 0);
    assert.equal(existsSync(join(item.directory, 'new-output')), false);
  } finally {
    item.cleanup();
  }
});

test('approval binds exact parent, sample hash and explicit amount; symlinks are rejected', () => {
  const item = fixture();
  try {
    const input = prepareAuditionInput(item.manifest);
    assert.equal(readAuditionApproval(item.approvalPath, input).approvedUsd, 1);
    for (const override of [
      { parentCandidate: '0'.repeat(40) },
      { sampleSha256: '0'.repeat(64) },
      { approvalReference: '' },
      { sampleUseReference: '' },
      { extra: 'forbidden' },
    ]) {
      writeFileSync(
        item.approvalPath,
        JSON.stringify({ ...item.approval, ...override }),
      );
      assert.throws(() => readAuditionApproval(item.approvalPath, input));
    }
    const link = join(item.directory, 'linked-approval.json');
    symlinkSync(item.approvalPath, link);
    assert.throws(() => readAuditionApproval(link, input), /SYMLINK/);
    const linkedParent = join(item.directory, 'linked-parent');
    symlinkSync(item.directory, linkedParent);
    assert.throws(
      () => validateAuditionOutput(join(linkedParent, 'new-output')),
      /SYMLINK/,
    );
  } finally {
    item.cleanup();
  }
});

test(
  'FIFO approval is rejected without blocking the CLI',
  { skip: process.platform === 'win32' },
  () => {
    const item = fixture();
    try {
      const fifo = join(item.directory, 'approval.fifo');
      const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
      assert.equal(created.status, 0, created.stderr);
      const response = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve('scripts/realtime-audition.mts'),
          '--manifest',
          item.manifest,
          '--execute-once',
          '--approval',
          fifo,
          '--output',
          join(item.directory, 'results'),
        ],
        { cwd: resolve('.'), encoding: 'utf8', timeout: 3000 },
      );
      assert.equal(
        response.signal,
        null,
        'approval preflight must not wait for a FIFO writer',
      );
      assert.equal(response.status, 1);
      assert.match(response.stderr, /AUDITION_CLI_APPROVAL_FILE_INVALID/);
      assert.equal(existsSync(join(item.directory, 'results')), false);
    } finally {
      item.cleanup();
    }
  },
);

test('output reservation failure precedes environment reads and any execution', async () => {
  const item = fixture();
  try {
    const output = join(item.directory, 'raced-output');
    let environmentReads = 0;
    let executions = 0;
    await assert.rejects(
      auditionMain(
        [
          '--manifest',
          item.manifest,
          '--execute-once',
          '--approval',
          item.approvalPath,
          '--output',
          output,
        ],
        {
          // Simulate a path becoming occupied after read-only output validation.
          reserveOutput: (path) => {
            mkdirSync(path);
            return reserveAuditionOutput(path);
          },
          readEnvironment: () => {
            environmentReads += 1;
            return { OPENAI_API_KEY: 'fake' };
          },
          execute: async () => {
            executions += 1;
          },
        },
      ),
    );
    assert.equal(environmentReads, 0);
    assert.equal(executions, 0);
    assert.deepEqual(readdirSync(output), []);
  } finally {
    item.cleanup();
  }
});

test('approved-path mock receives a private writable reservation before any environment read', async () => {
  const item = fixture();
  try {
    const output = join(item.directory, 'reserved-output');
    let executions = 0;
    await auditionMain(
      [
        '--manifest',
        item.manifest,
        '--execute-once',
        '--approval',
        item.approvalPath,
        '--output',
        output,
      ],
      {
        readEnvironment: () => {
          assert.equal(statSync(output).mode % 0o1000, 0o700);
          assert.equal(
            statSync(join(output, 'reservation.json')).mode % 0o1000,
            0o600,
          );
          return { OPENAI_API_KEY: 'fake-offline-key-not-used' };
        },
        execute: async (input, _approval, path, _environment, reservation) => {
          executions += 1;
          writeAuditionArtifacts(path, input, fakeResult(), reservation);
        },
        stdout: () => {},
      },
    );
    assert.equal(executions, 1);
    assert.equal(existsSync(join(output, 'report.json')), true);
  } finally {
    item.cleanup();
  }
});

test('artifact reservation cannot be forged, reused or redirected to a replacement directory', () => {
  const item = fixture();
  try {
    const input = prepareAuditionInput(item.manifest);
    const output = join(item.directory, 'reserved');
    const reservation = reserveAuditionOutput(output);
    assert.throws(
      () => writeAuditionArtifacts(output, input, fakeResult(), { output }),
      /INVALID_RESERVATION/,
    );
    renameSync(output, `${output}-original`);
    mkdirSync(output, { mode: 0o700 });
    assert.throws(
      () => writeAuditionArtifacts(output, input, fakeResult(), reservation),
      /RESERVATION_CHANGED/,
    );
    assert.deepEqual(readdirSync(output), []);
    const usableOutput = join(item.directory, 'usable');
    const usable = reserveAuditionOutput(usableOutput);
    writeAuditionArtifacts(usableOutput, input, fakeResult(), usable);
    assert.throws(
      () => writeAuditionArtifacts(usableOutput, input, fakeResult(), usable),
      /INVALID_RESERVATION/,
    );
  } finally {
    item.cleanup();
  }
});

test('candidate check verifies fixed source and refuses unrelated repositories', () => {
  assert.doesNotThrow(() => assertAuditionCandidate());
  const directory = mkdtempSync(join(tmpdir(), 'audition-not-git-'));
  try {
    assert.throws(
      () => assertAuditionCandidate(directory),
      /CANDIDATE_UNAVAILABLE/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('usage cost preserves unknown ASR/cache breakdown and never doubles totals', () => {
  const priced = calculateAuditionUsageCost([
    {
      source: 'response',
      sequence: 1,
      basis: 'tokens',
      inputTokens: 1100,
      outputTokens: 25,
      totalTokens: 1125,
      audioInputTokens: 1000,
      textInputTokens: 100,
      cachedInputTokens: 100,
      cachedAudioInputTokens: 100,
      cachedTextInputTokens: 0,
      audioOutputTokens: 20,
      textOutputTokens: 5,
    },
  ]);
  assert.equal(priced.totalCalculatedUsd, 0.03064);
  assert.equal(priced.actualPlatformBilledUsd, null);
  const unknown = calculateAuditionUsageCost([
    {
      source: 'response',
      sequence: 1,
      basis: 'tokens',
      inputTokens: 10,
      cachedInputTokens: 5,
    },
    { source: 'transcription', sequence: 1, basis: 'duration', seconds: 2 },
  ]);
  assert.equal(unknown.totalCalculatedUsd, null);
  assert.equal(unknown.entries[0].calculatedUsd, null);
  assert.equal(unknown.entries[1].estimatedUsd, 0.0002);
  assert.equal(calculateAuditionUsageCost([]).allUsagePriced, false);
});

test('accounting distinguishes exact request bytes, zero prior audio and planning tokens', () => {
  const review = auditionAccountingReview(snapshot());
  assert.equal(review.measuredLocalBytes.requestTextBytes, 120);
  assert.equal(review.measuredLocalBytes.repeatedInstructionBytes, 644);
  assert.equal(review.measuredLocalBytes.priorAudioResubmittedBytes, 0);
  assert.equal(
    review.measuredLocalBytes.combinedBufferAndInlineAudioSeconds,
    1,
  );
  assert.equal(review.estimateReservations.usdIsHardCap, false);
  assert.equal(
    review.estimateReservations.tokenReservationsAreProviderLimits,
    false,
  );
});

test('private artifacts contain bounded WAVs and separate source, ASR and actual translation', () => {
  const item = fixture();
  try {
    const input = prepareAuditionInput(item.manifest);
    const output = join(item.directory, 'results');
    const result = writeAuditionArtifacts(output, input, fakeResult());
    assert.ok(result.files.includes('report.json'));
    const report = JSON.parse(
      readFileSync(join(output, 'report.json'), 'utf8'),
    );
    assert.equal(report.responses[0].rawAsrText, '实际模拟识别');
    assert.equal(
      report.responses[0].actualGeneratedTranslation,
      'Simulated result.',
    );
    assert.equal(report.responses[0].referenceTranslation.value, null);
    assert.equal(report.costs.actualPlatformBilledStatus, 'not_verified');
    assert.equal(readFileSync(join(output, 'combined.wav')).length, 524);
    assert.equal(statSync(output).mode % 0o1000, 0o700);
    assert.equal(statSync(join(output, 'report.json')).mode % 0o1000, 0o600);
    assert.throws(() => writeAuditionArtifacts(output, input, fakeResult()));
    const tooMuch = fakeResult();
    tooMuch.responses[0].pcm = Buffer.alloc(36 * 48000 + 2);
    const rejectedOutput = join(item.directory, 'too-much');
    assert.throws(
      () => writeAuditionArtifacts(rejectedOutput, input, tooMuch),
      /36_SECONDS/,
    );
    assert.equal(existsSync(rejectedOutput), false);
  } finally {
    item.cleanup();
  }
});
