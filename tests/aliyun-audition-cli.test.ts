import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  ALIYUN_AUDITION_PARENT,
  aliyunAuditionMain,
  parseAliyunAuditionArgs,
  readAliyunAuditionApproval,
  type AliyunAuditionApproval,
} from '../scripts/aliyun-audition.mjs';
import {
  aliyunAuditionWave,
  calculateAliyunAuditionCost,
  estimateAliyunAuditionCost,
  reserveAliyunAuditionOutput,
  writeAliyunAuditionArtifacts,
} from '../src/experiments/aliyun-audition-artifacts';
import { prepareAliyunAuditionInput } from '../src/experiments/aliyun-audition-input';
import type {
  AliyunAuditionResult,
  AliyunAuditionRunnerOptions,
} from '../src/experiments/aliyun-audition-runner';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aliyun-audition-cli-test-'));
  const wave = aliyunAuditionWave(Buffer.alloc(48000, 1));
  const remoteWave = aliyunAuditionWave(Buffer.alloc(48000, 2));
  const sha256 = createHash('sha256').update(wave).digest('hex');
  const remoteSha256 = createHash('sha256').update(remoteWave).digest('hex');
  writeFileSync(join(directory, 'local-test.wav'), wave);
  writeFileSync(join(directory, 'remote-test.wav'), remoteWave);
  const manifest = join(directory, 'manifest.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      region: 'beijing',
      clips: [
        {
          id: 'zh',
          role: 'local',
          wav: 'local-test.wav',
          sha256,
          speechEndMs: 800,
        },
        {
          id: 'en',
          role: 'remote',
          wav: 'remote-test.wav',
          sha256: remoteSha256,
        },
      ],
    }),
  );
  const input = prepareAliyunAuditionInput(manifest);
  const approval: AliyunAuditionApproval = {
    version: 1,
    provider: 'aliyun-plan-b',
    parentCandidate: ALIYUN_AUDITION_PARENT,
    region: input.region,
    manifestSha256: input.manifestSha256,
    sampleHashes: input.clips.map(({ id, sha256: hash }) => ({
      id,
      sha256: hash,
    })),
    models: {
      asr: 'fun-asr-realtime',
      translation: 'qwen-mt-flash',
      tts: 'cosyvoice-v3-flash',
    },
    voice: 'loongandy_v3',
    currency: 'CNY',
    approvedAmountCny: 1,
    dataSendApproved: true,
    executeOnce: true,
    approvalReference: 'Offline unit fixture only; not a real paid approval.',
    approvedAt: '2026-10-14T00:00:00Z',
  };
  const approvalPath = join(directory, 'approval.json');
  writeFileSync(approvalPath, JSON.stringify(approval));
  return {
    directory,
    manifest,
    input,
    approval,
    approvalPath,
    stateDirectory: join(directory, 'test-state'),
    output: join(directory, 'new-results'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function fakeResult(): AliyunAuditionResult {
  return {
    status: 'completed',
    startedAt: 0,
    endedAt: 2100,
    configuration: {
      region: 'beijing',
      asrModel: 'fun-asr-realtime',
      textModel: 'qwen-mt-flash',
      ttsModel: 'cosyvoice-v3-flash',
      voice: 'loongandy_v3',
      sampleRate: 24000,
      translationMaxTokens: 2048,
      automaticRetries: 0,
      automaticReconnects: 0,
    },
    counters: {
      asrTasks: 2,
      translationRequests: 2,
      ttsTasks: 1,
      ttsCharacters: 20,
      inputBytesSent: 96000,
      outputBytesReceived: 480,
      duplicateFinalsIgnored: 0,
      lateRevisionsIgnored: 0,
    },
    segments: [
      {
        clipId: 'zh',
        role: 'local',
        sourceSequence: 1,
        sourceRevision: 2,
        raw: '这是模拟，不是付费调用。',
        translation: 'This is a simulation.',
        contextSourceIds: [],
        pcm: Buffer.alloc(480),
        latency: {
          sourceEndBasis: 'provider_stream_estimate',
          sourceEndAt: 800,
          asrFinalReceivedAt: 900,
          sourceEndToFinalMs: 100,
          queueMs: 10,
          translationStartedAt: 910,
          translationCompletedAt: 1030,
          translationMs: 120,
          ttsRequestedAt: 1030,
          translationEndToTtsMs: 0,
          ttsFirstPcmMs: 50,
          sourceEndToFirstPcmMs: 280,
          annotatedClipSpeechEndToFirstPcmMs: 280,
          firstPcmAt: 1080,
        },
      },
      {
        clipId: 'en',
        role: 'remote',
        sourceSequence: 1,
        sourceRevision: 1,
        raw: 'It is not twenty dollars.',
        translation: '不是二十美元。',
        contextSourceIds: ['local:1'],
        pcm: Buffer.alloc(0),
        latency: {
          sourceEndBasis: 'unknown',
          sourceEndAt: null,
          asrFinalReceivedAt: 1900,
          sourceEndToFinalMs: null,
          queueMs: 0,
          translationStartedAt: 1900,
          translationCompletedAt: 2000,
          translationMs: 100,
          ttsRequestedAt: null,
          translationEndToTtsMs: null,
          ttsFirstPcmMs: null,
          sourceEndToFirstPcmMs: null,
          annotatedClipSpeechEndToFirstPcmMs: null,
          firstPcmAt: null,
        },
      },
    ],
    usage: [
      {
        clipId: 'zh',
        layer: 'asr',
        role: 'local',
        taskSequence: 1,
        region: 'beijing',
        durationSeconds: 1,
        basis: 'provider_reported',
      },
      {
        clipId: 'en',
        layer: 'asr',
        role: 'remote',
        taskSequence: 1,
        region: 'beijing',
        durationSeconds: 1,
        basis: 'provider_reported',
      },
      {
        clipId: 'zh',
        layer: 'translation',
        role: 'local',
        taskSequence: 1,
        region: 'beijing',
        inputTokens: 100,
        outputTokens: 10,
        basis: 'provider_reported',
      },
      {
        clipId: 'en',
        layer: 'translation',
        role: 'remote',
        taskSequence: 1,
        region: 'beijing',
        basis: 'unknown',
      },
      {
        clipId: 'zh',
        layer: 'tts',
        role: 'local',
        taskSequence: 1,
        region: 'beijing',
        characters: 20,
        basis: 'provider_reported',
      },
    ],
    evidence: [],
    clips: [],
  };
}

function runArgs(f: ReturnType<typeof fixture>, output = f.output) {
  return [
    '--manifest',
    f.manifest,
    '--run',
    '--approval',
    f.approvalPath,
    '--out',
    output,
  ];
}

function spent(f: ReturnType<typeof fixture>): string[] {
  return existsSync(f.stateDirectory)
    ? readdirSync(f.stateDirectory).filter((file) => file.endsWith('.spent'))
    : [];
}

test('Aliyun CLI defaults offline and rejects duplicate/incomplete execution flags', () => {
  assert.equal(parseAliyunAuditionArgs(['--manifest', 'm']).executeOnce, false);
  assert.equal(parseAliyunAuditionArgs(['--help']).help, true);
  for (const args of [
    [],
    ['--manifest'],
    ['--unknown'],
    ['--help', '--run'],
    ['--manifest', 'm', '--manifest', 'n'],
    ['--manifest', 'm', '--run'],
    ['--manifest', 'm', '--approval', 'a'],
    ['--manifest', 'm', '--out', 'o'],
  ])
    assert.throws(() => parseAliyunAuditionArgs(args), /ALIYUN_AUDITION_CLI_/);
});

test('offline preflight never reads credential/proxy environment or invokes runner', async () => {
  const f = fixture();
  try {
    const lines: string[] = [];
    const code = await aliyunAuditionMain(['--manifest', f.manifest], {
      env: new Proxy(
        {},
        {
          get: () => {
            throw new Error('ENV_MUST_NOT_BE_READ');
          },
        },
      ),
      run: async () => {
        throw new Error('RUNNER_MUST_NOT_BE_CALLED');
      },
      write: (line) => lines.push(line),
    });
    assert.equal(code, 0);
    const receipt = JSON.parse(lines[0]);
    assert.equal(receipt.credentialRead, false);
    assert.equal(receipt.supplierRequests, 0);
    assert.equal(receipt.totalSeconds, 2);
    assert.equal(receipt.manifestSha256, f.input.manifestSha256);
    assert.equal(receipt.model.asr, 'fun-asr-realtime');
    assert.equal(receipt.referenceAnswers, 'not_read_or_uploaded');
    assert.equal(spent(f).length, 0);
  } finally {
    f.cleanup();
  }
});

test('approval binds region, manifest, each sample and fixed models; OpenAI/USD approval rejected', () => {
  const f = fixture();
  try {
    assert.deepEqual(
      readAliyunAuditionApproval(f.approvalPath, f.input),
      f.approval,
    );
    const variants: unknown[] = [
      { version: 1, approvedUsd: 1, sampleSha256: f.input.clips[0].sha256 },
      { ...f.approval, region: 'singapore' },
      { ...f.approval, manifestSha256: '0'.repeat(64) },
      { ...f.approval, dataSendApproved: false },
      { ...f.approval, executeOnce: false },
      { ...f.approval, approvedAmountCny: 0.99 },
      { ...f.approval, currency: 'USD' },
      { ...f.approval, voice: 'echo' },
      {
        ...f.approval,
        models: { ...f.approval.models, asr: 'fun-asr-flash-8k-realtime' },
      },
      { ...f.approval, sampleHashes: [...f.approval.sampleHashes].reverse() },
      { ...f.approval, referenceTranslation: 'not permitted' },
      { ...f.approval, approvedAt: 'not a timestamp' },
    ];
    for (const value of variants) {
      writeFileSync(f.approvalPath, JSON.stringify(value));
      assert.throws(
        () => readAliyunAuditionApproval(f.approvalPath, f.input),
        /APPROVAL_BINDING_INVALID/,
      );
    }
  } finally {
    f.cleanup();
  }
});

test('one fake authorized execution freezes selected region and saves English WAV plus both captions', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const lines: string[] = [];
    const env = Object.freeze({
      ALIYUN_BEIJING_API_KEY: 'offline-test-key-only',
    });
    const code = await aliyunAuditionMain(runArgs(f), {
      stateDirectory: f.stateDirectory,
      env,
      write: (line) => lines.push(line),
      run: async (options: AliyunAuditionRunnerOptions) => {
        calls += 1;
        assert.equal(options.config.voice, 'loongandy_v3');
        assert.equal(options.config.region, 'beijing');
        assert.equal(options.config.asrModel, 'fun-asr-realtime');
        assert.equal(options.clips.length, 2);
        assert.equal(options.signal?.aborted, false);
        return fakeResult();
      },
    });
    assert.equal(code, 0);
    assert.equal(calls, 1);
    const report = JSON.parse(
      readFileSync(join(f.output, 'report.json'), 'utf8'),
    );
    assert.equal(report.segments[0].raw, fakeResult().segments[0].raw);
    assert.equal(report.segments[0].latency.sourceEndToFirstPcmMs, 280);
    assert.equal(report.segments[1].outputFile, null);
    assert.equal(report.costs.actualPlatformBilledCny, null);
    assert.equal(report.costs.allReportedUsagePriced, false);
    assert.equal(existsSync(join(f.output, 'english-combined.wav')), true);
    assert.equal(
      JSON.stringify(report).includes('offline-test-key-only'),
      false,
    );
    assert.equal(lines.join('\n').includes('offline-test-key-only'), false);
    assert.equal(env.ALIYUN_BEIJING_API_KEY, 'offline-test-key-only');
    assert.equal(spent(f).length, 1);
  } finally {
    f.cleanup();
  }
});

test('duplicate or copied/reformatted approval cannot execute again, including after provider failure', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const deps = {
      stateDirectory: f.stateDirectory,
      env: { ALIYUN_BEIJING_API_KEY: 'offline-test-only' },
      write: () => {},
      run: async () => {
        calls += 1;
        return {
          ...fakeResult(),
          status: 'failed' as const,
          errorCode: 'PLAN_B_ASR_FAILED',
        };
      },
    };
    assert.equal(await aliyunAuditionMain(runArgs(f), deps), 1);
    writeFileSync(f.approvalPath, JSON.stringify(f.approval, null, 2));
    assert.equal(
      await aliyunAuditionMain(
        runArgs(f, join(f.directory, 'second-results')),
        deps,
      ),
      1,
    );
    assert.equal(calls, 1);
  } finally {
    f.cleanup();
  }
});

test('same approval copied with its manifest to another directory still shares the one-shot state', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const deps = {
      stateDirectory: f.stateDirectory,
      env: { ALIYUN_BEIJING_API_KEY: 'offline-test-only' },
      write: () => {},
      run: async () => {
        calls += 1;
        return fakeResult();
      },
    };
    assert.equal(await aliyunAuditionMain(runArgs(f), deps), 0);
    const copied = join(f.directory, 'copied-material');
    mkdirSync(copied);
    for (const file of [
      'manifest.json',
      'approval.json',
      'local-test.wav',
      'remote-test.wav',
    ])
      writeFileSync(join(copied, file), readFileSync(join(f.directory, file)));
    assert.equal(
      await aliyunAuditionMain(
        [
          '--manifest',
          join(copied, 'manifest.json'),
          '--run',
          '--approval',
          join(copied, 'approval.json'),
          '--out',
          join(copied, 'out'),
        ],
        deps,
      ),
      1,
    );
    assert.equal(calls, 1);
    assert.equal(spent(f).length, 1);
  } finally {
    f.cleanup();
  }
});

test('missing regional key stops before first supplier request and never reads other region key', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const lines: string[] = [];
    const env = {
      get ALIYUN_SINGAPORE_API_KEY(): string {
        throw new Error('WRONG_REGION_READ');
      },
    };
    assert.equal(
      await aliyunAuditionMain(runArgs(f), {
        stateDirectory: f.stateDirectory,
        env,
        run: async () => {
          calls += 1;
          return fakeResult();
        },
        write: (line) => lines.push(line),
      }),
      1,
    );
    assert.equal(calls, 0);
    assert.equal(
      lines.join(''),
      '{"status":"stopped","errorCode":"CLOUD_PLAN_B_KEY_MISSING:ALIYUN_BEIJING_API_KEY"}',
    );
    assert.equal(spent(f).length, 0);
  } finally {
    f.cleanup();
  }
});

test('output reservation refuses existing directory, symlink parent and FIFO before runner', async () => {
  const f = fixture();
  try {
    reserveAliyunAuditionOutput(f.output);
    assert.throws(() => reserveAliyunAuditionOutput(f.output));
    symlinkSync(f.directory, join(f.directory, 'linked'), 'dir');
    assert.throws(
      () => reserveAliyunAuditionOutput(join(f.directory, 'linked', 'out')),
      /SYMLINK_FORBIDDEN/,
    );
    if (process.platform !== 'win32') {
      const fifo = join(f.directory, 'fifo');
      assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
      assert.throws(() => reserveAliyunAuditionOutput(fifo));
      assert.throws(
        () => readAliyunAuditionApproval(fifo, f.input),
        /APPROVAL_FILE_INVALID/,
      );
    }
  } finally {
    f.cleanup();
  }
});

test('pre-aborted execution sends nothing; a single signal abort is propagated and listeners removed', async () => {
  const f = fixture();
  try {
    const aborted = new AbortController();
    aborted.abort();
    let calls = 0;
    const listenersBefore = process.listenerCount('SIGINT');
    assert.equal(
      await aliyunAuditionMain(runArgs(f), {
        stateDirectory: f.stateDirectory,
        env: { ALIYUN_BEIJING_API_KEY: 'offline-test-only' },
        signal: aborted.signal,
        run: async () => {
          calls += 1;
          return fakeResult();
        },
        write: () => {},
      }),
      1,
    );
    assert.equal(calls, 0);
    const signal = new AbortController();
    assert.equal(
      await aliyunAuditionMain(
        runArgs(f, join(f.directory, 'signal-results')),
        {
          stateDirectory: f.stateDirectory,
          env: { ALIYUN_BEIJING_API_KEY: 'offline-test-only' },
          signal: signal.signal,
          run: async (options) => {
            calls += 1;
            let aborts = 0;
            options.signal!.addEventListener('abort', () => {
              aborts += 1;
            });
            signal.abort();
            signal.abort();
            assert.equal(aborts, 1);
            return {
              ...fakeResult(),
              status: 'cancelled' as const,
              errorCode: 'ALIYUN_AUDITION_CANCELLED',
            };
          },
          write: () => {},
        },
      ),
      1,
    );
    assert.equal(calls, 1);
    assert.equal(process.listenerCount('SIGINT'), listenersBefore);
  } finally {
    f.cleanup();
  }
});

test('raw provider exceptions never print request credentials or payloads and do not retry', async () => {
  const f = fixture();
  try {
    const lines: string[] = [];
    let calls = 0;
    assert.equal(
      await aliyunAuditionMain(runArgs(f), {
        stateDirectory: f.stateDirectory,
        env: { ALIYUN_BEIJING_API_KEY: 'offline-test-only' },
        write: (line) => lines.push(line),
        run: async () => {
          calls += 1;
          throw new Error('Authorization Bearer SECRET, source text private');
        },
      }),
      1,
    );
    assert.equal(calls, 1);
    assert.equal(
      lines.join(''),
      '{"status":"stopped","errorCode":"ALIYUN_AUDITION_CLI_FAILED"}',
    );
    assert.equal(spent(f).length, 1);
  } finally {
    f.cleanup();
  }
});

test('regional estimates include bounded outputs, input/context reserve and remain estimates', () => {
  const beijing = estimateAliyunAuditionCost('beijing');
  const singapore = estimateAliyunAuditionCost('singapore');
  assert.equal(beijing.estimate.estimatedCny, 0.3798688);
  assert.equal(singapore.estimate.estimatedCny, 0.500376864);
  assert.equal(beijing.isBillingHardCap, false);
  assert.equal(beijing.locallyControlled.translationRequests, 8);
  assert.equal(beijing.locallyControlled.translationMaxTokens, 2048);
  assert.equal(beijing.estimatesOnly.translationInputTokens, 200000);
});

test('cumulative usage is deduplicated per clip/task and unknown counters remain pending', () => {
  const { usage } = fakeResult();
  const priced = calculateAliyunAuditionCost([...usage, usage[0]], 'beijing');
  assert.equal(priced.entries.length, 5);
  assert.equal(priced.allReportedUsagePriced, false);
  assert.equal(priced.actualPlatformBilledStatus, 'not_verified');
  assert.equal(
    calculateAliyunAuditionCost([], 'beijing').allReportedUsagePriced,
    false,
  );
  assert.throws(
    () => calculateAliyunAuditionCost(usage, 'singapore'),
    /USAGE_REGION_MISMATCH/,
  );
});

test('two ASR clips of the same role and task sequence are both charged once', () => {
  const { usage } = fakeResult();
  const one = usage[0];
  const two = { ...one, clipId: 'zh-second', durationSeconds: 2 };
  const costs = calculateAliyunAuditionCost([one, two, one], 'beijing');
  assert.equal(costs.entries.length, 2);
  assert.equal(costs.knownSubtotalCny, 3 * 0.00033);
  assert.equal(costs.allReportedUsagePriced, true);
});

test('artifacts reject remote audio and output limits; one reservation cannot be reused', () => {
  const f = fixture();
  try {
    const bad = fakeResult();
    bad.segments[1].pcm = Buffer.alloc(2);
    const reservation = reserveAliyunAuditionOutput(f.output);
    assert.throws(
      () => writeAliyunAuditionArtifacts(f.input, bad, reservation),
      /REMOTE_TTS_FORBIDDEN/,
    );
    assert.throws(
      () => writeAliyunAuditionArtifacts(f.input, fakeResult(), reservation),
      /INVALID_RESERVATION/,
    );
    assert.throws(
      () => aliyunAuditionWave(Buffer.alloc(36 * 48000 + 2)),
      /INVALID_PCM/,
    );
  } finally {
    f.cleanup();
  }
});

test('actual CLI invocation with default arguments exits offline without credentials or network', () => {
  const f = fixture();
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve('scripts/aliyun-audition.mts'),
        '--manifest',
        f.manifest,
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          ALIYUN_BEIJING_API_KEY: undefined,
          ALIYUN_SINGAPORE_API_KEY: undefined,
        },
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout.trim()).mode, 'offline_preflight');
    assert.equal(JSON.parse(child.stdout.trim()).supplierRequests, 0);
  } finally {
    f.cleanup();
  }
});
