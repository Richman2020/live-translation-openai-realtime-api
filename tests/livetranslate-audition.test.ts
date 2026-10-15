/* eslint-disable no-await-in-loop -- Independent one-shot fixtures must be asserted serially. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';

import { createLiveTranslateClient } from '../src/experiments/livetranslate-client';
import {
  liveTranslateAuditionMain,
  readLiveTranslateAuditionApproval,
  verifyLiveTranslateAuditionRuntime,
} from '../scripts/livetranslate-audition.mjs';
import {
  prepareLiveTranslateAuditionInput,
  LIVETRANSLATE_AUDITION_MODEL,
  LIVETRANSLATE_AUDITION_PARENT,
  LIVETRANSLATE_AUDITION_SCOPE,
  LIVETRANSLATE_SINGLE_LOCAL_SCOPE,
  LIVETRANSLATE_SINGLE_LOCAL_PARENT,
  type PreparedLiveTranslateAuditionInput,
} from '../src/experiments/livetranslate-audition-input';
import {
  calculateLiveTranslateAuditionCost,
  estimateLiveTranslateAuditionCost,
  reserveLiveTranslateAuditionOutput,
  writeLiveTranslateAuditionArtifacts,
} from '../src/experiments/livetranslate-audition-artifacts';
import {
  runLiveTranslateAudition,
  type LiveTranslateAuditionRunnerOptions,
} from '../src/experiments/livetranslate-audition-runner';
import type {
  LiveTranslateClientOptions,
  LiveTranslateSession,
} from '../src/experiments/livetranslate-types';

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function wav(seconds = 1, rate = 16000, seed = 1) {
  const pcm = Buffer.alloc(seconds * rate * 2, seed);
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'livet-audition-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const clips = ['local', 'remote'].map((role, index) => {
    const data = wav(1, 16000, index + 1);
    const file = `${role}.wav`;
    writeFileSync(join(directory, file), data);
    return { id: role, role, wav: file, sha256: sha(data), speechEndMs: 800 };
  });
  const manifest = { version: 1, workspaceId: 'offline-workspace', clips };
  const path = join(directory, 'input.json');
  const save = () => writeFileSync(path, JSON.stringify(manifest));
  save();
  return {
    directory,
    manifest,
    path,
    save,
    input: () => prepareLiveTranslateAuditionInput(path),
  };
}
const candidate = 'a'.repeat(40);
const fixedNow = Date.parse('2026-10-15T13:00:00+08:00');
function approval(input: PreparedLiveTranslateAuditionInput) {
  return {
    version: 1,
    scope: LIVETRANSLATE_AUDITION_SCOPE,
    parentCandidate: LIVETRANSLATE_AUDITION_PARENT,
    candidateSha: candidate,
    model: LIVETRANSLATE_AUDITION_MODEL,
    voice: 'Aiden',
    spaceHost: input.spaceHost,
    manifestSha256: input.manifestSha256,
    sampleHashes: input.clips.map(({ id, sha256 }) => ({ id, sha256 })),
    currency: 'CNY',
    approvedAmountCny: 5,
    dataSendApproved: true,
    executeOnce: true,
    acceptsLocalStopsNotBillingCap: true,
    acceptsUnpricedHistoryRisk: true,
    approvalReference:
      'Synthetic offline approval fixture only, never user authorization',
    approvedAt: new Date(fixedNow).toISOString(),
    preflight: {
      modelAndVoiceAccess: 'verify_in_authorized_session',
      exactHostNetworkPolicyVerified: true,
      currentPriceVerified: true,
      checkedAt: new Date(fixedNow).toISOString(),
      evidenceReference: 'Synthetic offline evidence only',
    },
  };
}
function mock(
  input: PreparedLiveTranslateAuditionInput,
  behavior?: (options: LiveTranslateClientOptions, phase: string) => void,
) {
  const captured: LiveTranslateClientOptions[] = [];
  let clock = 0;
  let aborts = 0;
  const appended: number[] = [];
  const options: LiveTranslateAuditionRunnerOptions = {
    input,
    apiKey: 'offline-fake',
    now: () => clock,
    delay: async (ms) => {
      clock += ms;
    },
    clientFactory: (client) => {
      captured.push(client);
      const sid = `session_${client.role}`;
      const responseId = `response_${client.role}`;
      const translationId = `translation_${client.role}`;
      const sourceId = `source_${client.role}`;
      const base = { role: client.role, sessionId: sid };
      const time = (
        stage: Parameters<
          NonNullable<LiveTranslateClientOptions['onTiming']>
        >[0]['stage'],
      ) =>
        client.onTiming?.({
          ...base,
          responseId,
          translationId,
          sourceId,
          stage,
          at: clock,
        });
      return {
        ready: Promise.resolve({
          ...base,
          model: LIVETRANSLATE_AUDITION_MODEL,
          voice: client.voice ?? 'Aiden',
          voiceCloneEnabled: false,
          targetLanguage: client.role === 'local' ? 'en' : 'zh',
          configurationAcknowledgement: {
            eventId: 'offline_ack',
            receiveSequence: 1,
            receivedAt: clock,
            basis: 'provider_session_updated',
          },
          inputSampleRate: 16000,
          outputSampleRate: 24000,
          outputModalities:
            client.role === 'local' ? ['text', 'audio'] : ['text'],
        } as LiveTranslateSession),
        append: (frame) => {
          appended.push(frame.length);
          behavior?.(client, 'append');
        },
        async finish() {
          if (behavior) {
            behavior(client, 'finish');
            return;
          }
          time('response_created');
          client.onSource?.({
            ...base,
            sourceId,
            revision: 1,
            text:
              client.role === 'local'
                ? '不是十五，是五十。'
                : 'Do not cancel it.',
            final: true,
            startMs: 0,
            endMs: 800,
            at: clock,
          });
          client.onTranslation?.({
            ...base,
            translationId,
            responseId,
            sourceId,
            pairing: 'explicit',
            revision: 1,
            text:
              client.role === 'local' ? 'Not fifteen; fifty.' : '不要取消。',
            final: true,
            at: clock,
          });
          time('translation_completed');
          clock += 25;
          if (client.role === 'local') {
            time('audio_first_sample');
            client.onAudio?.(Buffer.alloc(480), {
              ...base,
              responseId,
              translationId,
              sourceId,
              pairing: 'explicit',
              eventId: 'audio1',
              sequence: 1,
            });
          }
          clock += 30;
          time('response_completed');
          client.onUsage?.({
            ...base,
            responseId,
            basis: 'provider_reported',
            inputAudioTokens: 7,
            inputTextTokens: 0,
            outputAudioTokens: client.role === 'local' ? 1 : 0,
            outputTextTokens: 5,
          });
        },
        abort() {
          aborts += 1;
        },
      };
    },
  };
  return { options, captured, appended, aborts: () => aborts };
}

test('strict 16k local/remote manifest is local-only and never imports a reference answer', (t) => {
  const f = fixture(t);
  const input = f.input();
  assert.equal(input.totalSeconds, 2);
  assert.equal(input.clips[0].pcm.length, 32000);
  assert.equal(
    input.spaceHost,
    'offline-workspace.cn-beijing.maas.aliyuncs.com',
  );
  assert.equal(input.manifestSha256, sha(readFileSync(f.path)));
  assert.ok(!('reference' in input));
});
test('24k source is rejected without conversion or modification', (t) => {
  const f = fixture(t);
  const file = join(f.directory, 'local.wav');
  const old = wav(1, 24000);
  writeFileSync(file, old);
  f.manifest.clips[0].sha256 = sha(old);
  f.save();
  assert.throws(f.input, /WAV_REQUIRES_PCM16_MONO_16K$/u);
  assert.equal(sha(readFileSync(file)), sha(old));
});
for (const change of ['hash', 'role', 'path', 'reference', 'host', 'duration'])
  test(`manifest rejects ${change} before any supplier work`, (t) => {
    const f = fixture(t);
    if (change === 'hash') f.manifest.clips[0].sha256 = 'f'.repeat(64);
    if (change === 'role') f.manifest.clips[1].role = 'local';
    if (change === 'path') f.manifest.clips[0].wav = '../outside.wav';
    if (change === 'reference')
      Object.assign(f.manifest, { referenceAnswer: 'Never upload me' });
    if (change === 'host') f.manifest.workspaceId = 'user@evil.example';
    if (change === 'duration') {
      const data = wav(24);
      writeFileSync(join(f.directory, 'local.wav'), data);
      f.manifest.clips[0].sha256 = sha(data);
    }
    f.save();
    assert.throws(f.input, /LIVETRANSLATE_AUDITION_INPUT_/u);
  });
test('symlink WAV is never followed', (t) => {
  const f = fixture(t);
  symlinkSync(join(f.directory, 'local.wav'), join(f.directory, 'alias.wav'));
  f.manifest.clips[0].wav = 'alias.wav';
  f.save();
  assert.throws(f.input, /SYMLINK_FORBIDDEN$/u);
});
test('dry run neither reads credentials nor starts supplier clients', async (t) => {
  const f = fixture(t);
  let reads = 0;
  const env = Object.defineProperty({}, 'ALIYUN_BEIJING_API_KEY', {
    get() {
      reads += 1;
      throw new Error('secret');
    },
  });
  const lines: string[] = [];
  assert.equal(
    await liveTranslateAuditionMain(['--manifest', f.path], {
      env,
      write: (line) => lines.push(line),
      run: async () => {
        throw new Error('must not run');
      },
    }),
    0,
  );
  assert.equal(reads, 0);
  const report = JSON.parse(lines[0]);
  assert.equal(report.credentialRead, false);
  assert.equal(report.supplierRequests, 0);
  assert.equal(report.planning.isBillingHardCap, false);
  assert.match(report.comparison, /pending/u);
});
test('missing or old approval rejects before key and output directory', async (t) => {
  const f = fixture(t);
  const out = join(f.directory, 'output');
  let reads = 0;
  const env = Object.defineProperty({}, 'ALIYUN_BEIJING_API_KEY', {
    get() {
      reads += 1;
      return 'private';
    },
  });
  for (const content of [
    undefined,
    { version: 1, provider: 'aliyun-plan-b', approvedAmountCny: 1 },
  ]) {
    const approvalPath = join(f.directory, 'approval.json');
    if (content) writeFileSync(approvalPath, JSON.stringify(content));
    assert.equal(
      await liveTranslateAuditionMain(
        [
          '--manifest',
          f.path,
          '--run',
          '--approval',
          approvalPath,
          '--out',
          out,
        ],
        { env, write() {}, candidate: () => candidate },
      ),
      1,
    );
    assert.equal(reads, 0);
    assert.equal(existsSync(out), false);
  }
});
for (const field of [
  'spaceHost',
  'model',
  'voice',
  'candidateSha',
  'manifestSha256',
  'approvedAt',
  'preflight',
  'approvedAmountCny',
  'acceptsLocalStopsNotBillingCap',
])
  test(`new approval requires exact fresh ${field}`, (t) => {
    const f = fixture(t);
    const value: Record<string, unknown> = approval(f.input());
    if (field === 'preflight')
      value.preflight = {
        ...approval(f.input()).preflight,
        exactHostNetworkPolicyVerified: false,
      };
    else if (field === 'approvedAmountCny') value[field] = 1;
    else if (field === 'acceptsLocalStopsNotBillingCap') value[field] = false;
    else
      value[field] =
        field === 'approvedAt' ? '2026-10-01T00:00:00Z' : 'not-the-binding';
    const path = join(f.directory, 'approval.json');
    writeFileSync(path, JSON.stringify(value));
    assert.throws(
      () =>
        readLiveTranslateAuditionApproval(path, f.input(), candidate, fixedNow),
      /LIVETRANSLATE_AUDITION_CLI_/u,
    );
  });
test('runtime binding rejects shared-helper dirty code while allowing uncommitted documents', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.directory, 'src'));
  writeFileSync(join(f.directory, '.gitignore'), 'node_modules\n.runtime\n');
  writeFileSync(join(f.directory, 'tsconfig.json'), '{"compilerOptions":{}}');
  writeFileSync(
    join(f.directory, 'src', 'shared-helper.ts'),
    'export const before=1;',
  );
  for (const args of [
    ['init', f.directory],
    ['-C', f.directory, 'add', '.'],
    [
      '-C',
      f.directory,
      '-c',
      'user.name=Offline',
      '-c',
      'user.email=offline@example.invalid',
      'commit',
      '-m',
      'offline fixture',
    ],
  ])
    assert.equal(spawnSync('git', args, { encoding: 'utf8' }).status, 0);
  const initial = verifyLiveTranslateAuditionRuntime(f.directory);
  assert.match(initial, /^[a-f0-9]{40}$/u);
  writeFileSync(join(f.directory, 'PROGRESS.md'), 'uncommitted notes');
  assert.equal(verifyLiveTranslateAuditionRuntime(f.directory), initial);
  writeFileSync(
    join(f.directory, 'src', 'shared-helper.ts'),
    'export const changed=2;',
  );
  assert.throws(
    () => verifyLiveTranslateAuditionRuntime(f.directory),
    /CANDIDATE_FILES_CHANGED$/u,
  );
});
test('mock run completes each direction once, no Chinese audio, and saves full-text and response timing separately', async (t) => {
  const f = fixture(t);
  const h = mock(f.input());
  const result = await runLiveTranslateAudition(h.options);
  assert.equal(result.status, 'completed');
  assert.equal(result.counters.sessions, 2);
  assert.equal(h.aborts(), 2);
  assert.equal(result.audio.length, 1);
  assert.equal(result.translations.length, 2);
  assert.equal(result.audio[0].actualPlaybackStartedAt, null);
  assert.ok(result.audio[0].responseDoneAt! > result.audio[0].firstPcmAt);
  const reservation = reserveLiveTranslateAuditionOutput(
    join(f.directory, 'private-output'),
  );
  writeLiveTranslateAuditionArtifacts(f.input(), result, reservation);
  const report = JSON.parse(
    readFileSync(join(reservation.output, 'report.json'), 'utf8'),
  );
  assert.ok(report.audio[0].fullTranslationDoneAt < report.audio[0].firstPcmAt);
  assert.equal(report.audio[0].providerEndToFirstPcmMs, 225);
  assert.equal(report.audio[0].annotatedSpeechEndToFirstPcmMs, 225);
  assert.equal(report.costs.actualPlatformBilledCny, null);
  assert.equal(lstatSync(reservation.output).mode % 0o1000, 0o700);
  assert.equal(
    lstatSync(join(reservation.output, 'english-combined.wav')).mode % 0o1000,
    0o600,
  );
  assert.throws(
    () => writeLiveTranslateAuditionArtifacts(f.input(), result, reservation),
    /RESERVATION_INVALID$/u,
  );
});
test('response-created with no output is still locally stopped on seventh unique response', async (t) => {
  const f = fixture(t);
  const h = mock(f.input(), (client, phase) => {
    if (phase !== 'append') return;
    for (let i = 0; i < 7; i += 1)
      client.onTiming?.({
        role: client.role,
        sessionId: 's',
        responseId: `response_${i}`,
        stage: 'response_created',
        at: 0,
      });
  });
  const result = await runLiveTranslateAudition(h.options);
  assert.equal(
    result.errorCode,
    'LIVETRANSLATE_AUDITION_RESPONSE_OBSERVATION_LIMIT',
  );
  assert.equal(result.counters.observedResponses, 7);
  assert.equal(result.counters.acceptedResponses, 6);
  assert.equal(result.counters.sessions, 1);
  assert.equal(h.captured.length, 1);
});
test('empty or partial-only finish cannot be reported as a completed audition or start another session', async (t) => {
  const f = fixture(t);
  for (const partial of [false, true]) {
    const h = mock(f.input(), (client, phase) => {
      if (partial && phase === 'finish')
        client.onSource?.({
          role: client.role,
          sessionId: 's',
          sourceId: 'source',
          revision: 1,
          text: '临时',
          final: false,
          at: 1,
        });
    });
    const result = await runLiveTranslateAudition(h.options);
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'LIVETRANSLATE_AUDITION_INCOMPLETE_OUTPUT');
    assert.equal(result.counters.sessions, 1);
  }
});
test('first exact supplier reason and bounded close code survive late errors; invented prefixes remain secret', async (t) => {
  const f = fixture(t);
  const h = mock(f.input(), (client, phase) => {
    if (phase === 'append') {
      client.onError?.('LIVETRANSLATE_CONNECTION_CLOSED', { closeCode: 1006 });
      client.onError?.('LIVETRANSLATE_secret_private', { closeCode: 4999 });
    }
  });
  const result = await runLiveTranslateAudition(h.options);
  assert.equal(result.errorCode, 'LIVETRANSLATE_CONNECTION_CLOSED');
  assert.equal(result.closeCode, 1006);
  assert.equal(result.counters.sessions, 1);
  const bad = mock(f.input(), (client, phase) => {
    if (phase === 'append')
      client.onError?.('LIVETRANSLATE_AUDITION_CLI_SECRET', { closeCode: NaN });
  });
  const unknown = await runLiveTranslateAudition(bad.options);
  assert.equal(unknown.errorCode, 'LIVETRANSLATE_AUDITION_SUPPLIER_FAILED');
  assert.equal(unknown.closeCode, undefined);
});
test('pre-aborted and never-ready timeout do not retry or reconnect', async (t) => {
  const f = fixture(t);
  const signal = new AbortController();
  signal.abort();
  const h = mock(f.input());
  assert.equal(
    (await runLiveTranslateAudition({ ...h.options, signal: signal.signal }))
      .status,
    'cancelled',
  );
  assert.equal(h.captured.length, 0);
  let calls = 0;
  let closed = 0;
  const result = await runLiveTranslateAudition({
    input: f.input(),
    apiKey: 'fake',
    timeoutMs: 5,
    clientFactory: () => {
      calls += 1;
      return {
        ready: new Promise(() => {}),
        append() {},
        finish: async () => {},
        abort() {
          closed += 1;
        },
      };
    },
  });
  assert.equal(result.errorCode, 'LIVETRANSLATE_AUDITION_TIMEOUT');
  assert.equal(calls, 1);
  assert.ok(closed >= 1);
});
test('provider and CLI errors never expose fabricated credential-bearing prefixes', async (t) => {
  const f = fixture(t);
  const path = join(f.directory, 'approval.json');
  writeFileSync(path, JSON.stringify(approval(f.input())));
  const lines: string[] = [];
  const status = await liveTranslateAuditionMain(
    [
      '--manifest',
      f.path,
      '--run',
      '--approval',
      path,
      '--out',
      join(f.directory, 'out'),
    ],
    {
      env: { ALIYUN_BEIJING_API_KEY: 'private-not-real' },
      candidate: () => candidate,
      now: () => fixedNow,
      stateDirectory: join(f.directory, 'state'),
      write: (line) => lines.push(line),
      run: async () => {
        throw new Error('LIVETRANSLATE_AUDITION_CLI_PRIVATE_CREDENTIAL');
      },
    },
  );
  assert.equal(status, 1);
  assert.ok(!lines.join('').includes('PRIVATE_CREDENTIAL'));
  assert.ok(!lines.join('').includes('private-not-real'));
  assert.deepEqual(readdirSync(join(f.directory, 'out')), ['reservation.json']);
});
test('one-shot approval cannot be reused, and output cannot overwrite an existing path', async (t) => {
  const f = fixture(t);
  const path = join(f.directory, 'approval.json');
  writeFileSync(path, JSON.stringify(approval(f.input())));
  let runs = 0;
  const run = async (options: LiveTranslateAuditionRunnerOptions) => {
    runs += 1;
    return runLiveTranslateAudition(mock(options.input).options);
  };
  const deps = {
    env: { ALIYUN_BEIJING_API_KEY: 'offline' },
    candidate: () => candidate,
    now: () => fixedNow,
    stateDirectory: join(f.directory, 'state'),
    write() {},
    run,
  };
  const first = join(f.directory, 'out1');
  assert.equal(
    await liveTranslateAuditionMain(
      ['--manifest', f.path, '--run', '--approval', path, '--out', first],
      deps,
    ),
    0,
  );
  assert.equal(
    await liveTranslateAuditionMain(
      [
        '--manifest',
        f.path,
        '--run',
        '--approval',
        path,
        '--out',
        join(f.directory, 'out2'),
      ],
      deps,
    ),
    1,
  );
  assert.equal(runs, 1);
  assert.equal(
    await liveTranslateAuditionMain(
      ['--manifest', f.path, '--run', '--approval', path, '--out', first],
      deps,
    ),
    1,
  );
  assert.equal(runs, 1);
});
test('pricing separates observation reserve from actual classified usage and never calls missing usage zero', () => {
  const plan = estimateLiveTranslateAuditionCost();
  assert.ok(Math.abs(plan.expected.estimatedCny - 0.28352) < 1e-10);
  assert.ok(Math.abs(plan.planningReserve.estimatedCny - 3.97248) < 1e-10);
  assert.equal(plan.isBillingHardCap, false);
  const empty = calculateLiveTranslateAuditionCost([]);
  assert.equal(empty.allReportedUsagePriced, false);
  assert.equal(empty.knownSubtotalCny, null);
  assert.equal(empty.actualPlatformBilledCny, null);
  const unknown = calculateLiveTranslateAuditionCost([
    {
      role: 'local',
      sessionId: 's',
      responseId: 'r',
      basis: 'provider_reported',
      inputTokens: 20,
      outputTokens: 30,
    },
  ]);
  assert.equal(unknown.entries[0].audioInputCny, null);
  assert.equal(unknown.entries[0].textInputCny, null);
  assert.equal(unknown.allReportedUsagePriced, false);
});

function complete(
  client: LiveTranslateClientOptions,
  audioBytes = 480,
  duplicate = false,
) {
  const base = { role: client.role, sessionId: `session_${client.role}` };
  const responseId = `response_${client.role}`;
  const translationId = `translation_${client.role}`;
  const sourceId = `source_${client.role}`;
  for (let index = 0; index < (duplicate ? 2 : 1); index += 1)
    client.onTiming?.({
      ...base,
      responseId,
      stage: 'response_created',
      at: 0,
    });
  client.onSource?.({
    ...base,
    sourceId,
    text: 'Synthetic raw source.',
    final: true,
    revision: 1,
    startMs: 0,
    endMs: 800,
    at: 0,
  });
  client.onTranslation?.({
    ...base,
    translationId,
    responseId,
    sourceId,
    pairing: 'explicit',
    text: 'Synthetic translation.',
    final: true,
    revision: 1,
    at: 0,
  });
  client.onTiming?.({
    ...base,
    translationId,
    responseId,
    stage: 'translation_completed',
    at: 1,
  });
  if (client.role === 'local')
    for (let index = 0; index < (duplicate ? 2 : 1); index += 1)
      client.onAudio?.(Buffer.alloc(audioBytes), {
        ...base,
        responseId,
        translationId,
        sourceId,
        pairing: 'explicit',
        eventId: 'audio1',
        sequence: 1,
      });
  client.onTiming?.({
    ...base,
    responseId,
    stage: 'response_completed',
    at: 2,
  });
}
test('duplicated created/audio events are received once per source identity without duplicate saved sound or new sessions', async (t) => {
  const f = fixture(t);
  const h = mock(f.input(), (client, phase) => {
    if (phase === 'finish') complete(client, 480, true);
  });
  const result = await runLiveTranslateAudition(h.options);
  assert.equal(result.status, 'completed');
  assert.equal(result.counters.sessions, 2);
  assert.equal(result.counters.observedResponses, 2);
  assert.equal(result.counters.audioBytesReceived, 960);
  assert.equal(result.counters.audioBytesSaved, 480);
  assert.equal(result.audio[0].pcm.length, 480);
});
test('output observation truncates saved PCM at 36 seconds but reports bytes actually received above that limit', async (t) => {
  const f = fixture(t);
  const h = mock(f.input(), (client, phase) => {
    if (phase === 'finish') complete(client, 36 * 48000 + 480);
  });
  const result = await runLiveTranslateAudition(h.options);
  assert.equal(
    result.errorCode,
    'LIVETRANSLATE_AUDITION_OUTPUT_OBSERVATION_LIMIT',
  );
  assert.equal(result.counters.audioBytesSaved, 36 * 48000);
  assert.equal(result.counters.audioBytesReceived, 36 * 48000 + 480);
  assert.equal(result.counters.sessions, 1);
  assert.equal(result.audio[0].pcm.length, 36 * 48000);
});
test('finished-session late sources, audio and errors cannot contaminate the next direction', async (t) => {
  const f = fixture(t);
  const h = mock(f.input());
  const original = h.options.clientFactory!;
  h.options.clientFactory = (options) => {
    if (options.role === 'remote') {
      const old = h.captured[0];
      old.onSource?.({
        role: 'local',
        sessionId: 'session_local',
        sourceId: 'late',
        revision: 1,
        text: 'LATE_PRIVATE_WORDS',
        final: true,
        at: 0,
      });
      old.onError?.('LIVETRANSLATE_CONNECTION_CLOSED', { closeCode: 1006 });
      old.onAudio?.(Buffer.alloc(480), {
        role: 'local',
        sessionId: 'session_local',
        translationId: 'late',
        responseId: 'late',
        eventId: 'late',
        sequence: 2,
        pairing: 'unpaired',
      });
    }
    return original(options);
  };
  const result = await runLiveTranslateAudition(h.options);
  assert.equal(result.status, 'completed');
  assert.equal(result.sources.length, 2);
  assert.equal(result.counters.audioBytesReceived, 480);
  assert.ok(!JSON.stringify(result.sources).includes('LATE_PRIVATE_WORDS'));
  assert.equal(result.errorCode, undefined);
});
test('remote audio is forbidden, counted as received, and cannot be saved as Chinese synthesis', async (t) => {
  const f = fixture(t);
  const h = mock(f.input(), (client, phase) => {
    if (phase !== 'finish') return;
    complete(client);
    if (client.role === 'remote')
      client.onAudio?.(Buffer.alloc(480), {
        role: 'remote',
        sessionId: 'session_remote',
        translationId: 'translation_remote',
        responseId: 'response_remote',
        eventId: 'bad-audio',
        sequence: 1,
        pairing: 'unpaired',
      });
  });
  const result = await runLiveTranslateAudition(h.options);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'LIVETRANSLATE_AUDITION_AUDIO_INVALID');
  assert.equal(result.counters.audioBytesReceived, 960);
  assert.equal(result.counters.audioBytesSaved, 480);
  assert.equal(result.audio.length, 1);
});
test('missing remote translated subtitle is incomplete without retries or a third session', async (t) => {
  const f = fixture(t);
  const h = mock(f.input(), (client, phase) => {
    if (phase !== 'finish') return;
    if (client.role === 'local') complete(client);
    else
      client.onSource?.({
        role: 'remote',
        sessionId: 'session_remote',
        sourceId: 'source_remote',
        text: 'Synthetic English.',
        final: true,
        revision: 1,
        at: 0,
      });
  });
  const result = await runLiveTranslateAudition(h.options);
  assert.equal(result.errorCode, 'LIVETRANSLATE_AUDITION_INCOMPLETE_OUTPUT');
  assert.equal(result.counters.sessions, 2);
});
test('cancel during input stops further sends and does not create the other direction', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const h = mock(f.input(), (_client, phase) => {
    if (phase === 'append') controller.abort();
  });
  const result = await runLiveTranslateAudition({
    ...h.options,
    signal: controller.signal,
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.counters.sessions, 1);
  assert.equal(result.counters.inputBytesSent, 640);
  assert.equal(h.appended.length, 1);
  assert.equal(result.sends.length, 1);
  assert.equal(result.clips[0].sendCompletedAt, null);
  assert.equal(result.clips[0].sendElapsedMs, null);
});
test('usage is classified without summing cumulative repeats or pricing unlisted input-text', () => {
  const event = {
    role: 'local' as const,
    sessionId: 's',
    responseId: 'r',
    basis: 'provider_reported' as const,
    inputAudioTokens: 7,
    inputTextTokens: 3,
    outputAudioTokens: 5,
    outputTextTokens: 10,
  };
  const report = calculateLiveTranslateAuditionCost([event, event]);
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].textInputCny, null);
  assert.equal(report.allReportedUsagePriced, false);
  assert.equal(
    report.knownSubtotalCny,
    (7 * 40) / 1e6 + (5 * 160) / 1e6 + (10 * 100) / 1e6,
  );
});

test('integrated audio preceding source/text final preserves signed timing and never invents a playback queue wait', async (t) => {
  const f = fixture(t);
  let clock = 0;
  const h = mock(f.input(), (client, phase) => {
    if (phase !== 'finish') return;
    const base = { role: client.role, sessionId: `session_${client.role}` };
    const sourceId = `source_${client.role}`;
    const responseId = `response_${client.role}`;
    const translationId = `translation_${client.role}`;
    client.onTiming?.({
      ...base,
      responseId,
      stage: 'response_created',
      at: clock,
    });
    if (client.role === 'local') {
      client.onTiming?.({
        ...base,
        responseId,
        translationId,
        stage: 'audio_first_sample',
        at: clock,
      });
      client.onAudio?.(Buffer.alloc(480), {
        ...base,
        sourceId,
        responseId,
        translationId,
        pairing: 'explicit',
        sequence: 1,
        eventId: 'audio1',
      });
    }
    clock += 25;
    client.onSource?.({
      ...base,
      sourceId,
      revision: 1,
      text: 'Synthetic source.',
      final: true,
      endMs: 800,
      at: clock,
    });
    client.onTranslation?.({
      ...base,
      sourceId,
      responseId,
      translationId,
      revision: 1,
      pairing: 'explicit',
      text: 'Synthetic translation.',
      final: true,
      at: clock,
    });
    client.onTiming?.({
      ...base,
      responseId,
      translationId,
      stage: 'translation_completed',
      at: clock,
    });
    client.onTiming?.({
      ...base,
      responseId,
      stage: 'response_completed',
      at: clock + 5,
    });
  });
  h.options.now = () => clock;
  h.options.delay = async (ms) => {
    clock += ms;
  };
  const result = await runLiveTranslateAudition(h.options);
  assert.equal(result.status, 'completed');
  const reservation = reserveLiveTranslateAuditionOutput(
    join(f.directory, 'output'),
  );
  writeLiveTranslateAuditionArtifacts(f.input(), result, reservation);
  const report = JSON.parse(
    readFileSync(join(reservation.output, 'report.json'), 'utf8'),
  );
  assert.equal(report.audio[0].sourceFinalToFirstPcmMs, -25);
  assert.ok(report.audio[0].fullTranslationDoneAt > report.audio[0].firstPcmAt);
  assert.equal(report.audio[0].playbackQueueWaitMs, null);
  assert.equal(report.audio[0].queueMeasurement, 'not_attached_to_playback');
  assert.equal(report.audio[0].actualPlaybackStartedAt, null);
});

for (const filename of ['tsconfig.json', '.gitignore']) {
  test(`dirty ${filename} blocks approved execution before credentials or output`, async (t) => {
    const f = fixture(t);
    writeFileSync(join(f.directory, 'tsconfig.json'), '{"compilerOptions":{}}');
    writeFileSync(join(f.directory, '.gitignore'), 'node_modules\n.runtime\n');
    for (const args of [
      ['init', f.directory],
      ['-C', f.directory, 'add', '.'],
      [
        '-C',
        f.directory,
        '-c',
        'user.name=Offline',
        '-c',
        'user.email=offline@example.invalid',
        'commit',
        '-m',
        'tracked runtime fixture',
      ],
    ])
      assert.equal(spawnSync('git', args, { encoding: 'utf8' }).status, 0);
    const head = verifyLiveTranslateAuditionRuntime(f.directory);
    const value = { ...approval(f.input()), candidateSha: head };
    const approvalPath = join(f.directory, 'approval.json');
    writeFileSync(approvalPath, JSON.stringify(value));
    writeFileSync(
      join(f.directory, filename),
      filename === 'tsconfig.json'
        ? '{"compilerOptions":{"paths":{"*":[]}}}'
        : 'node_modules\n.runtime\nsrc\n',
    );
    let keyReads = 0;
    let runs = 0;
    const env = Object.defineProperty({}, 'ALIYUN_BEIJING_API_KEY', {
      get() {
        keyReads += 1;
        return 'offline-secret';
      },
    });
    const output = join(f.directory, 'must-not-create');
    const lines: string[] = [];
    const status = await liveTranslateAuditionMain(
      [
        '--manifest',
        f.path,
        '--run',
        '--approval',
        approvalPath,
        '--out',
        output,
      ],
      {
        env,
        now: () => fixedNow,
        candidate: () => verifyLiveTranslateAuditionRuntime(f.directory),
        write: (line) => lines.push(line),
        run: async () => {
          runs += 1;
          throw new Error('unexpected');
        },
      },
    );
    assert.equal(status, 1);
    assert.equal(keyReads, 0);
    assert.equal(runs, 0);
    assert.equal(existsSync(output), false);
    assert.equal(
      JSON.parse(lines[0]).errorCode,
      'LIVETRANSLATE_AUDITION_CLI_CANDIDATE_FILES_CHANGED',
    );
  });
}

test('FIFO-delayed delivery uses bound receive timing and pre-delivery done; missing timing remains unknown', async (t) => {
  const f = fixture(t);
  f.manifest.clips[0].speechEndMs = 10;
  f.save();
  for (const hasReceiveTiming of [true, false]) {
    let clock = 0;
    const input = f.input();
    const h = mock(input, (client, phase) => {
      if (phase !== 'finish') return;
      if (client.role === 'remote') {
        complete(client);
        return;
      }
      const base = { role: client.role, sessionId: 'session_local' };
      const responseId = 'response_r2';
      const translationId = 'translation_r2';
      const sourceId = 'source_r2';
      client.onTiming?.({
        ...base,
        responseId,
        stage: 'response_created',
        at: 0,
      });
      clock = 10;
      client.onSource?.({
        ...base,
        sourceId,
        revision: 1,
        text: 'Synthetic source two.',
        final: true,
        startMs: 0,
        endMs: 10,
        at: clock,
      });
      clock = 20;
      if (hasReceiveTiming)
        client.onTiming?.({
          ...base,
          responseId,
          translationId,
          sourceId,
          stage: 'audio_first_sample',
          at: clock,
        });
      clock = 25;
      client.onTranslation?.({
        ...base,
        responseId,
        translationId,
        sourceId,
        pairing: 'explicit',
        revision: 1,
        text: 'Synthetic translation two.',
        final: true,
        at: clock,
      });
      client.onTiming?.({
        ...base,
        responseId,
        translationId,
        stage: 'translation_completed',
        at: clock,
      });
      clock = 30;
      client.onTiming?.({
        ...base,
        responseId,
        stage: 'response_completed',
        at: clock,
      });
      // A different output item in this response must not take this item's text-done timestamp.
      client.onTiming?.({
        ...base,
        responseId,
        translationId: 'another_item',
        stage: 'translation_completed',
        at: 35,
      });
      clock = 50;
      client.onAudio?.(Buffer.alloc(480), {
        ...base,
        responseId,
        translationId,
        sourceId,
        pairing: 'explicit',
        eventId: 'audio_r2',
        sequence: 2,
      });
    });
    h.options.now = () => clock;
    h.options.delay = async () => {};
    const result = await runLiveTranslateAudition(h.options);
    assert.equal(result.status, 'completed');
    const audio = result.audio[0];
    assert.equal(audio.firstPcmAt, hasReceiveTiming ? 20 : null);
    assert.equal(
      audio.firstPcmBasis,
      hasReceiveTiming ? 'client_receive_timing' : 'delivery_callback_only',
    );
    assert.equal(audio.collectedQueueAt, 50);
    assert.equal(audio.clientFifoWaitMs, hasReceiveTiming ? 30 : null);
    assert.equal(audio.responseDoneAt, 30);
    const reservation = reserveLiveTranslateAuditionOutput(
      join(f.directory, hasReceiveTiming ? 'timed' : 'untimed'),
    );
    writeLiveTranslateAuditionArtifacts(input, result, reservation);
    const report = JSON.parse(
      readFileSync(join(reservation.output, 'report.json'), 'utf8'),
    );
    assert.equal(report.audio[0].fullTranslationDoneAt, 25);
    assert.equal(
      report.audio[0].providerEndToFirstPcmMs,
      hasReceiveTiming ? 10 : null,
    );
    assert.equal(
      report.audio[0].annotatedSpeechEndToFirstPcmMs,
      hasReceiveTiming ? 10 : null,
    );
    assert.equal(
      report.audio[0].sourceFinalToFirstPcmMs,
      hasReceiveTiming ? 10 : null,
    );
    assert.equal(report.audio[0].actualPlaybackStartedAt, null);
    assert.equal(report.audio[0].playbackQueueWaitMs, null);
  }
});

function singleFixture(t: TestContext, seconds = 1) {
  const f = fixture(t);
  const bytes = wav(seconds);
  writeFileSync(join(f.directory, 'local.wav'), bytes);
  f.manifest.version = 2;
  f.manifest.clips = [
    {
      ...f.manifest.clips[0],
      sha256: sha(bytes),
      speechEndMs: Math.min(800, seconds * 1000),
    },
  ];
  Object.assign(f.manifest, { mode: 'single-local' });
  rmSync(join(f.directory, 'remote.wav'));
  f.save();
  return f;
}
function singleApproval(input: PreparedLiveTranslateAuditionInput) {
  return {
    ...approval(input),
    voice: 'Tina',
    version: 2,
    mode: 'single-local',
    scope: LIVETRANSLATE_SINGLE_LOCAL_SCOPE,
    parentCandidate: LIVETRANSLATE_SINGLE_LOCAL_PARENT,
  };
}
test('single-local v2 accepts full Chinese file without an English file and reports its actual duration cost offline', async (t) => {
  const f = singleFixture(t, 21.097375);
  const input = f.input();
  assert.equal(input.mode, 'single-local');
  assert.equal(input.clips.length, 1);
  assert.equal(input.clips[0].pcm.length, 675116);
  assert.equal(input.totalSeconds, 21.097375);
  assert.equal(existsSync(join(f.directory, 'remote.wav')), false);
  let reads = 0;
  let runs = 0;
  const env = Object.defineProperty({}, 'ALIYUN_BEIJING_API_KEY', {
    get() {
      reads += 1;
      throw new Error('private');
    },
  });
  const lines: string[] = [];
  assert.equal(
    await liveTranslateAuditionMain(['--manifest', f.path], {
      env,
      write: (line) => lines.push(line),
      run: async () => {
        runs += 1;
        throw new Error('unexpected');
      },
    }),
    0,
  );
  assert.equal(reads, 0);
  assert.equal(runs, 0);
  const report = JSON.parse(lines[0]);
  assert.equal(report.mode, 'offline_preflight');
  assert.equal(report.auditionMode, 'single-local');
  assert.equal(report.scope, LIVETRANSLATE_SINGLE_LOCAL_SCOPE);
  assert.equal(report.parentCandidate, LIVETRANSLATE_SINGLE_LOCAL_PARENT);
  assert.equal(report.planning.assumptions.sessions, 1);
  assert.equal(report.planning.assumptions.actualInputSeconds, 21.097375);
  assert.equal(report.planning.expected.outputTextTokenReserve, 1024);
  assert.ok(
    Math.abs(report.planning.expected.estimatedCny - 0.180307265) < 1e-9,
  );
  assert.equal(report.planning.localStops.acceptedResponses, 6);
  assert.equal(report.planning.isBillingHardCap, false);
  assert.equal(report.planning.planningReserve.recommendedApprovalCny, 5);
  assert.equal(report.planning.legacyDual24SecondExample.estimatedCny, 0.28352);
});
test('single manifest rejects remote-only and omitted or ambiguous direction mode', (t) => {
  const f = singleFixture(t);
  f.manifest.clips[0].role = 'remote';
  f.save();
  assert.throws(f.input, /CLIP_INVALID$/u);
  f.manifest.clips[0].role = 'local';
  delete (f.manifest as any).mode;
  f.save();
  assert.throws(f.input, /MANIFEST_INVALID$/u);
  Object.assign(f.manifest, { mode: 'dual' });
  f.save();
  assert.throws(f.input, /MANIFEST_INVALID$/u);
});
test('single-local mock uses exactly one session and preserves first receive, full-text and response completion timing', async (t) => {
  const f = singleFixture(t);
  const h = mock(f.input());
  const result = await runLiveTranslateAudition(h.options);
  assert.equal(result.status, 'completed');
  assert.equal(result.configuration.mode, 'single-local');
  assert.equal(result.configuration.voice, 'Tina');
  assert.equal(result.counters.sessions, 1);
  assert.equal(h.captured.length, 1);
  assert.equal(h.captured[0].role, 'local');
  assert.equal(h.captured[0].voice, 'Tina');
  assert.equal(result.confirmedSessions[0].voice, 'Tina');
  assert.equal(result.audio.length, 1);
  assert.equal(result.audio[0].firstPcmBasis, 'client_receive_timing');
  assert.equal(result.audio[0].firstPcmAt, 1025);
  assert.equal(result.audio[0].responseDoneAt, 1055);
  assert.equal(result.audio[0].actualPlaybackStartedAt, null);
});
test('full single-local sample retains every paced frame, its partial tail and a bounded send timeline without inventing speech end', async (t) => {
  const f = singleFixture(t, 21.097375);
  delete (f.manifest.clips[0] as Partial<(typeof f.manifest.clips)[0]>)
    .speechEndMs;
  f.save();
  const input = f.input();
  const h = mock(input);
  let clock = 0;
  const delays: number[] = [];
  const result = await runLiveTranslateAudition({
    ...h.options,
    now: () => clock,
    delay: async (ms, signal) => {
      assert.equal(signal.aborted, false);
      delays.push(ms);
      clock += ms;
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.counters.sessions, 1);
  assert.equal(result.counters.inputBytesSent, 675116);
  assert.equal(result.sends.length, 1055);
  assert.equal(result.sends[0].sentAt, 0);
  assert.equal(result.sends.at(-1)!.sentAt, 21080);
  assert.equal(result.sends.at(-1)!.bytes, 556);
  assert.equal(result.sends.at(-1)!.streamEndMs, 21097.375);
  assert.equal(delays.length, 1055);
  assert.equal(delays.at(-1), 17.375);
  for (const [index, frame] of result.sends.entries()) {
    assert.ok(frame.bytes > 0 && frame.bytes <= 640);
    assert.equal(frame.offsetBytes, index * 640);
    assert.equal(frame.streamStartMs, frame.offsetBytes / 32);
    assert.equal(frame.sentAt, frame.streamStartMs);
    assert.equal(frame.basis, 'application_append_observed');
  }
  assert.equal(result.clips[0].nominalDurationMs, 21097.375);
  assert.equal(result.clips[0].sendCompletedAt, 21097.375);
  assert.equal(result.clips[0].sendElapsedMs, 21097.375);
  assert.equal(result.audio[0].annotatedSpeechEndToFirstPcmMs, null);
  const output = join(f.directory, 'timeline-output');
  const reservation = reserveLiveTranslateAuditionOutput(output);
  writeLiveTranslateAuditionArtifacts(input, result, reservation);
  const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
  assert.equal(report.input.clips[0].speechEndMs, null);
  assert.equal(report.sends.length, 1055);
  assert.equal(report.audioCollectionCompletedAt, result.endedAt);
  assert.equal(
    report.audioFileWriteBasis,
    'synchronous_write_returned_not_fsync_or_playback',
  );
  assert.equal(typeof report.audioFilesSavedCompletedAtEpochMs, 'number');
  assert.equal(report.audio[0].actualPlaybackStartedAt, null);
});
test('dual clips keep both partial tail frames rather than dropping audio to fit a 1200-frame log', async (t) => {
  const f = fixture(t);
  for (const [index, clip] of f.manifest.clips.entries()) {
    const bytes = wav(index === 0 ? 11.9999375 : 12.0000625);
    writeFileSync(join(f.directory, clip.wav), bytes);
    clip.sha256 = sha(bytes);
  }
  f.save();
  const h = mock(f.input());
  const result = await runLiveTranslateAudition(h.options);
  assert.equal(result.status, 'completed');
  assert.equal(result.configuration.voice, 'Aiden');
  assert.ok(h.captured.every(({ voice }) => voice === 'Aiden'));
  assert.ok(result.confirmedSessions.every(({ voice }) => voice === 'Aiden'));
  assert.equal(result.sends.length, 1201);
  assert.deepEqual(
    result.sends
      .filter((frame) => frame.bytes < 640)
      .map((frame) => frame.bytes),
    [638, 2],
  );
  assert.equal(result.counters.inputBytesSent, 768000);
});
test('single-local approval has a fresh isolated scope and cannot exchange authorization with dual mode', async (t) => {
  const f = singleFixture(t);
  const input = f.input();
  const path = join(f.directory, 'approval.json');
  writeFileSync(path, JSON.stringify(singleApproval(input)));
  const value = readLiveTranslateAuditionApproval(
    path,
    input,
    candidate,
    fixedNow,
  );
  assert.equal(value.scope, LIVETRANSLATE_SINGLE_LOCAL_SCOPE);
  assert.equal(value.scope, 'livetranslate-single-local-tina-audition-v1');
  assert.equal(value.parentCandidate, 'a66fd3f5881f0258ee704988592ea5640a3d0559');
  assert.equal(value.mode, 'single-local');
  writeFileSync(path, JSON.stringify(approval(input)));
  assert.throws(
    () => readLiveTranslateAuditionApproval(path, input, candidate, fixedNow),
    /APPROVAL_BINDING_INVALID$/u,
  );
  const dual = fixture(t);
  writeFileSync(
    path,
    JSON.stringify({ ...singleApproval(dual.input()), mode: 'single-local' }),
  );
  assert.throws(
    () =>
      readLiveTranslateAuditionApproval(
        path,
        dual.input(),
        candidate,
        fixedNow,
      ),
    /APPROVAL_BINDING_INVALID$/u,
  );
  writeFileSync(path, JSON.stringify(singleApproval(input)));
  let runs = 0;
  const out = join(f.directory, 'single-output');
  assert.equal(
    await liveTranslateAuditionMain(
      ['--manifest', f.path, '--run', '--approval', path, '--out', out],
      {
        env: { ALIYUN_BEIJING_API_KEY: 'offline-fake' },
        candidate: () => candidate,
        now: () => fixedNow,
        stateDirectory: join(f.directory, 'one-shot'),
        write() {},
        run: async (opts) => {
          runs += 1;
          return runLiveTranslateAudition(mock(opts.input).options);
        },
      },
    ),
    0,
  );
  assert.equal(runs, 1);
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  assert.equal(report.input.mode, 'single-local');
  assert.equal(report.parentCandidate, LIVETRANSLATE_SINGLE_LOCAL_PARENT);
  assert.equal(report.counters.sessions, 1);
});
test('single-local does not need remote but still requires every observed response to complete', async (t) => {
  const f = singleFixture(t);
  const h = mock(f.input(), (client, phase) => {
    if (phase !== 'finish') return;
    complete(client);
    client.onTiming?.({
      role: 'local',
      sessionId: 'session_local',
      responseId: 'unfinished_extra',
      stage: 'response_created',
      at: 1,
    });
  });
  const result = await runLiveTranslateAudition(h.options);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'LIVETRANSLATE_AUDITION_INCOMPLETE_OUTPUT');
  assert.equal(result.counters.sessions, 1);
});
test('single-local retains six observed response acceptance and detects the seventh without another session', async (t) => {
  const f = singleFixture(t);
  const h = mock(f.input(), (client, phase) => {
    if (phase !== 'append') return;
    for (let index = 0; index < 7; index += 1)
      client.onTiming?.({
        role: 'local',
        sessionId: 'session_local',
        responseId: `single_${index}`,
        stage: 'response_created',
        at: 0,
      });
  });
  const result = await runLiveTranslateAudition(h.options);
  assert.equal(
    result.errorCode,
    'LIVETRANSLATE_AUDITION_RESPONSE_OBSERVATION_LIMIT',
  );
  assert.equal(result.counters.observedResponses, 7);
  assert.equal(result.counters.acceptedResponses, 6);
  assert.equal(result.counters.sessions, 1);
});
test('single-local timeout and late callbacks cannot retry, reopen or append a second session', async (t) => {
  const f = singleFixture(t);
  let captured: LiveTranslateClientOptions;
  let creates = 0;
  const result = await runLiveTranslateAudition({
    input: f.input(),
    apiKey: 'offline',
    timeoutMs: 5,
    clientFactory: (options) => {
      captured = options;
      creates += 1;
      return {
        ready: new Promise(() => {}),
        append() {},
        finish: async () => {},
        abort() {},
      };
    },
  });
  assert.equal(result.errorCode, 'LIVETRANSLATE_AUDITION_TIMEOUT');
  captured!.onSource?.({
    role: 'local',
    sessionId: 'late',
    sourceId: 'late',
    revision: 1,
    final: true,
    text: 'late words',
    at: 1,
  });
  captured!.onError?.('LIVETRANSLATE_CONNECTION_CLOSED', { closeCode: 1006 });
  assert.equal(result.sources.length, 0);
  assert.equal(result.errorCode, 'LIVETRANSLATE_AUDITION_TIMEOUT');
  assert.equal(creates, 1);
});
class SingleAuditionWire extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  sent: any[] = [];

  appendedAt: number[] = [];

  private sequence = 0;

  session() {
    return {
      id: 'single_session',
      model: LIVETRANSLATE_AUDITION_MODEL,
      output_modalities: ['text', 'audio'],
      enable_voice_clone: false,
      audio: {
        input: {
          format: { type: 'pcm', sample_rate: 16000 },
          turn_detection: { type: 'speaker_detection', threshold: 0.5 },
        },
        output: { format: { type: 'pcm', sample_rate: 24000 }, voice: 'Tina' },
      },
      translation: { language: 'en' },
    };
  }

  receive(event: Record<string, unknown>) {
    this.sequence += 1;
    this.emit(
      'message',
      Buffer.from(
        JSON.stringify({ event_id: `single_event_${this.sequence}`, ...event }),
      ),
      false,
    );
  }

  send(raw: string, callback?: (error?: Error) => void) {
    const event = JSON.parse(raw);
    this.sent.push(event);
    callback?.();
    if (event.type === 'session.update')
      queueMicrotask(() =>
        this.receive({ type: 'session.updated', session: this.session() }),
      );
    if (event.type === 'input_audio_buffer.append')
      this.appendedAt.push(Date.now());
    if (event.type === 'session.finish')
      queueMicrotask(() => {
        this.receive({
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'single_source',
          content_index: 0,
          transcript: '不是十五，是五十。',
        });
        this.receive({
          type: 'response.created',
          response: { id: 'single_response', status: 'in_progress' },
        });
        this.receive({
          type: 'conversation.item.created',
          previous_item_id: 'single_source',
          item: { id: 'single_translation', role: 'assistant', content: [] },
        });
        const base = {
          response_id: 'single_response',
          item_id: 'single_translation',
          output_index: 0,
          content_index: 0,
        };
        this.receive({
          type: 'response.audio_transcript.done',
          ...base,
          transcript: 'Not fifteen; fifty.',
        });
        this.receive({
          type: 'response.audio.delta',
          ...base,
          delta: Buffer.alloc(480).toString('base64'),
        });
        this.receive({ type: 'response.audio.done', ...base });
        this.receive({
          type: 'response.done',
          response: {
            id: 'single_response',
            status: 'completed',
            output: [
              {
                id: 'single_translation',
                role: 'assistant',
                content: [{ type: 'audio', transcript: 'Not fifteen; fifty.' }],
              },
            ],
            usage: {
              input_tokens: 7,
              output_tokens: 15,
              total_tokens: 22,
              input_tokens_details: { audio_tokens: 7, text_tokens: 0 },
              output_tokens_details: { audio_tokens: 12, text_tokens: 3 },
            },
          },
        });
        this.receive({ type: 'session.finished' });
      });
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1000);
  }

  terminate() {
    this.close();
  }
}
test('single-local real client plus fake wire preserves default 20ms pacing and never connects a remote session', async (t) => {
  const f = singleFixture(t, 0.12);
  const wire = new SingleAuditionWire();
  let creates = 0;
  const started = Date.now();
  const result = await runLiveTranslateAudition({
    input: f.input(),
    apiKey: 'offline-not-a-secret',
    clientFactory: (options) => {
      creates += 1;
      assert.equal(options.role, 'local');
      assert.equal(options.voice, 'Tina');
      const client = createLiveTranslateClient({
        ...options,
        createWebSocket: (url) => {
          assert.equal(
            url,
            'wss://offline-workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime',
          );
          return wire as unknown as WebSocket;
        },
      });
      queueMicrotask(() => {
        wire.emit('open');
        wire.receive({ type: 'session.created', session: wire.session() });
      });
      return client;
    },
  });
  assert.equal(result.status, 'completed', result.errorCode);
  assert.equal(creates, 1);
  assert.equal(result.counters.sessions, 1);
  assert.equal(result.configuration.voice, 'Tina');
  assert.equal(result.confirmedSessions[0].voice, 'Tina');
  assert.equal(result.counters.inputBytesSent, 3840);
  assert.equal(wire.appendedAt.length, 6);
  assert.equal(result.sends.length, 6);
  assert.equal(result.clips[0].nominalDurationMs, 120);
  assert.ok(result.clips[0].sendElapsedMs! >= 100);
  assert.ok(wire.appendedAt.at(-1)! - wire.appendedAt[0] >= 80);
  assert.ok(Date.now() - started >= 100);
  assert.equal(result.sources.at(-1)!.text, '不是十五，是五十。');
  assert.equal(result.translations.at(-1)!.text, 'Not fifteen; fifty.');
  assert.equal(result.audio[0].pcm.length, 480);
  assert.equal(result.audio[0].firstPcmBasis, 'client_receive_timing');
  assert.equal(result.audio[0].actualPlaybackStartedAt, null);
  assert.ok(!JSON.stringify(wire.sent).includes('Not fifteen'));
  assert.ok(!JSON.stringify(wire.sent).includes('不是十五'));
  const stages = result.protocolEvents.map((event) => event.stage);
  assert.ok(stages.includes('transport_open'));
  assert.ok(stages.includes('transport_close_requested'));
  assert.ok(stages.includes('transport_close'));
  const ack = result.protocolEvents.findIndex((event) => event.stage === 'configuration_accepted');
  const firstAppend = result.protocolEvents.findIndex((event) =>
    event.stage === 'client_event_sent' && event.eventType === 'input_audio_buffer.append');
  assert.ok(ack >= 0 && firstAppend > ack);
  assert.equal(result.protocolDiagnostics.length, 0);
  assert.ok(!JSON.stringify(result.protocolEvents).includes('Not fifteen'));
  const reservation = reserveLiveTranslateAuditionOutput(join(f.directory, 'journal-output'));
  writeLiveTranslateAuditionArtifacts(f.input(), result, reservation);
  const report = JSON.parse(readFileSync(join(reservation.output, 'report.json'), 'utf8'));
  assert.equal(report.protocolEvidence.timeline.connectionEstablished.status, 'captured');
  assert.equal(report.protocolEvidence.timeline.sessionUpdateSubmitted.status, 'captured');
  assert.equal(report.protocolEvidence.timeline.configurationAccepted.status, 'captured');
  assert.equal(report.protocolEvidence.timeline.transportClosed.status, 'captured');
  assert.equal(report.protocolEvidence.actualModelAndVoice, 'see_confirmed_sessions');
  assert.equal(report.protocolTraceTruncated, false);
});

test('Tina single-local one-shot approval records pending in-session validation and rejects Aiden or a fabricated prior access claim', (t) => {
  const f = singleFixture(t);
  const value = singleApproval(f.input());
  const path = join(f.directory, 'approval.json');
  writeFileSync(path, JSON.stringify(value));
  const accepted = readLiveTranslateAuditionApproval(
    path, f.input(), candidate, fixedNow,
  );
  assert.equal(accepted.voice, 'Tina');
  assert.equal(
    accepted.preflight.modelAndVoiceAccess, 'verify_in_authorized_session',
  );
  writeFileSync(path, JSON.stringify({ ...value, voice: 'Aiden' }));
  assert.throws(
    () => readLiveTranslateAuditionApproval(path, f.input(), candidate, fixedNow),
    /APPROVAL_BINDING_INVALID$/u,
  );
  const priorClaim: Record<string, unknown> = {
    ...value.preflight, accountModelAccessVerified: true,
  };
  delete priorClaim.modelAndVoiceAccess;
  writeFileSync(path, JSON.stringify({ ...value, preflight: priorClaim }));
  assert.throws(
    () => readLiveTranslateAuditionApproval(path, f.input(), candidate, fixedNow),
    /PREFLIGHT_EVIDENCE_REQUIRED$/u,
  );
});
