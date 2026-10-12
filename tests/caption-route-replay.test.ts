import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type WebSocket from 'ws';

import {
  captionProtocolEvidence,
  prepareCaptionPlan,
  runCaptionReplay,
  summarizeCaptions,
  type CaptionTimelineEvent,
} from '../scripts/check-caption-route';
import { PcmuToPcm24k } from '../src/solo/translation-pcm';

const hash = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
function files() {
  const root = mkdtempSync(resolve(tmpdir(), 'caption-replay-test-'));
  const source = resolve(root, '.runtime/source');
  mkdirSync(source, { recursive: true });
  const input = Buffer.from([0xff, 0x80, 0, 0x7f, 0xfe]);
  const manifest = {
    version: 'phone-quality-inputs/1',
    kind: 'human',
    consentForProjectEvaluation: true,
    format: 'PCMU_8000_mono',
    cases: ['04', '06', 'L02'].map((id) => ({
      id,
      role: 'remote',
      targetLanguage: 'zh',
      inputFile: `${id}.pcmu`,
      inputSha256: hash(input),
      sourceText: 'DO NOT SEND SOURCE WORDS',
      expectedTranslation: 'DO NOT SEND EXPECTED WORDS',
    })),
  };
  for (const item of manifest.cases)
    writeFileSync(resolve(source, item.inputFile), input);
  const manifestFile = resolve(source, 'manifest.json');
  const save = () => writeFileSync(manifestFile, JSON.stringify(manifest));
  save();
  return {
    root,
    input,
    manifest,
    manifestFile,
    save,
    args: [
      '--manifest',
      '.runtime/source/manifest.json',
      '--out',
      '.runtime/new-result',
      '--dry-run',
    ],
    cleanup() {
      const actual = realpathSync(root);
      assert.equal(actual, root);
      assert.ok(actual.startsWith(resolve(tmpdir(), 'caption-replay-test-')));
      rmSync(actual, { recursive: true, force: true });
    },
  };
}

test('plan verifies authorization and exact required PCMUs without reading keys or retaining expected words', () => {
  const f = files();
  try {
    const plan = prepareCaptionPlan([...f.args, '--include-silence'], f.root);
    assert.deepEqual(
      plan.fixtures.map((fixture) => fixture.id),
      ['04', '06', 'L02', 'silence'],
    );
    assert.ok(plan.dryRun);
    assert.equal(plan.fixtures[0].input.compare(f.input), 0);
    assert.equal(JSON.stringify(plan).includes('DO NOT SEND'), false);
    assert.equal(
      plan.fixtures[0].provenance.manifestSha256,
      hash(readFileSync(f.manifestFile)),
    );
    f.manifest.consentForProjectEvaluation = false;
    f.save();
    assert.throws(() => prepareCaptionPlan(f.args, f.root), /MISSING_CONSENT/);
  } finally {
    f.cleanup();
  }
});

test('plan fails before provider creation for tampering, traversal, duplicate cases, or reused output', () => {
  const f = files();
  try {
    writeFileSync(resolve(f.root, '.runtime/source/04.pcmu'), Buffer.from([1]));
    assert.throws(() => prepareCaptionPlan(f.args, f.root), /SHA256_MISMATCH/);
    writeFileSync(resolve(f.root, '.runtime/source/04.pcmu'), f.input);
    f.manifest.cases[0].inputFile = '../outside.pcmu';
    f.save();
    assert.throws(
      () => prepareCaptionPlan(f.args, f.root),
      /PATH_ESCAPES_MANIFEST/,
    );
    f.manifest.cases[0].inputFile = '04.pcmu';
    f.manifest.cases.push(f.manifest.cases[0]);
    f.save();
    assert.throws(
      () => prepareCaptionPlan(f.args, f.root),
      /DUPLICATE_REQUIRED_CASE/,
    );
    f.manifest.cases.pop();
    f.save();
    mkdirSync(resolve(f.root, '.runtime/new-result'));
    assert.throws(
      () => prepareCaptionPlan(f.args, f.root),
      /OUTPUT_ALREADY_EXISTS/,
    );
    assert.throws(
      () => prepareCaptionPlan(['--out', 'public/results'], f.root),
      /INSIDE_RUNTIME/,
    );
    assert.throws(
      () => prepareCaptionPlan([...f.args, '--unknown'], f.root),
      /INVALID_ARGUMENTS/,
    );
  } finally {
    f.cleanup();
  }
});

function caption(
  kind: 'original' | 'translation',
  text: string,
  final: boolean,
  atMs = 0,
): CaptionTimelineEvent {
  return {
    id: `remote:${kind}:item-1:0`,
    role: 'remote',
    kind,
    text,
    final,
    at: 1,
    atMs,
  };
}

async function fakeReplay(
  mode:
    | 'complete'
    | 'empty'
    | 'unfinished'
    | 'provider-error'
    | 'truncated'
    | 'silence',
) {
  let clock = 0;
  let aborts = 0;
  const input =
    mode === 'silence' ? Buffer.alloc(163, 255) : Buffer.alloc(163, 0x80);
  const sent: Buffer[] = [];
  const outbound: string[] = [];
  const socket = Object.assign(new EventEmitter(), {
    send: (raw: string) => {
      outbound.push(raw);
    },
  });
  const result = await runCaptionReplay(
    {
      id: '04',
      kind: mode === 'silence' ? 'synthetic_silence' : 'human',
      input,
      provenance: { expectedTextSentToProvider: false },
    },
    { apiKey: 'offline-key' },
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      socketFactory: () => socket as unknown as WebSocket,
      createClient: (options) => {
        assert.deepEqual(Object.keys(options).sort(), [
          'apiKey',
          'createWebSocket',
          'onError',
          'onTranscript',
        ]);
        const observedSocket = options.createWebSocket!(
          'wss://offline.invalid',
          {},
        );
        observedSocket.send(
          JSON.stringify({
            type: 'response.create',
            event_id: 'r1',
            response: {
              instructions: 'PRIVATE_PROMPT',
              input: [{ text: 'PRIVATE_WORDS' }],
            },
          }),
        );
        return {
          ready: Promise.resolve(),
          append: (pcm) => {
            sent.push(Buffer.from(pcm));
            if (sent.length === 20 && !['empty', 'silence'].includes(mode)) {
              options.onTranscript(caption('original', 'draft', false));
              options.onTranscript(caption('translation', '草稿', false));
            }
            if (mode === 'provider-error')
              options.onError('PROVIDER_UNAVAILABLE');
          },
          finish: async () => {
            clock += 25;
            if (['complete', 'truncated'].includes(mode)) {
              options.onTranscript(caption('original', 'final source', true));
              options.onTranscript(caption('translation', '最终译文', true));
            }
            if (mode === 'truncated')
              socket.emit(
                'message',
                Buffer.from(
                  JSON.stringify({
                    type: 'response.done',
                    response: {
                      id: 'r1',
                      status: 'incomplete',
                      status_details: { reason: 'max_output_tokens' },
                    },
                  }),
                ),
              );
          },
          abort: () => {
            aborts += 1;
          },
        };
      },
    },
  );
  return { result, sent, input, aborts, outbound };
}

test('paced replay preserves every source byte and partial final frame through the production resampler', async () => {
  const { result, sent, input, aborts, outbound } =
    await fakeReplay('complete');
  const padded = Buffer.concat([
    Buffer.alloc(2400, 255),
    input,
    Buffer.alloc(32000, 255),
  ]);
  const expected = new PcmuToPcm24k().push(padded);
  assert.deepEqual(Buffer.concat(sent), expected);
  assert.equal(result.input.sentPcmuSha256, hash(padded));
  assert.equal(result.input.sentPcm24kSha256, hash(expected));
  assert.equal(result.input.sentPcmuBytes, padded.length);
  assert.equal(result.input.frames.at(-1)?.bytes, padded.length % 160);
  assert.ok(
    result.input.frames.every((frame) => frame.atMs === frame.offset / 8),
  );
  assert.equal(result.quality.failure, null);
  assert.equal(result.lifecycle.finishResolved, true);
  assert.equal(result.captions.translation.draftEvents, 1);
  assert.equal(result.captions.translation.finalItems.length, 1);
  assert.equal(result.quality.accuracyAccepted, false);
  assert.equal(result.realPhone, false);
  assert.equal(aborts, 1);
  assert.equal(outbound.length, 1);
  assert.ok(outbound[0].includes('PRIVATE_PROMPT'));
  assert.equal(JSON.stringify(result).includes('PRIVATE_PROMPT'), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_WORDS'), false);
  assert.equal(result.protocol[0].type, 'client.response.create');
});

test('empty, unfinished, provider error, and truncated output never count as complete replay', async () => {
  for (const [mode, failure] of [
    ['empty', 'EMPTY_FINAL_CAPTION'],
    ['unfinished', 'EMPTY_FINAL_CAPTION'],
    ['provider-error', 'PROVIDER_UNAVAILABLE'],
    ['truncated', 'INCOMPLETE_PROVIDER_OUTPUT'],
  ] as const) {
    const { result } = await fakeReplay(mode);
    assert.equal(result.quality.failure, failure);
    assert.equal(result.quality.status, 'REPLAY_FAILED_OR_INCOMPLETE');
  }
});

test('silence control requires no nonempty captions and has no fabricated energy latency', async () => {
  const { result } = await fakeReplay('silence');
  assert.equal(result.quality.failure, null);
  assert.equal(result.quality.unexpectedSilenceCaption, false);
  assert.equal(result.input.energy.firstEnergyAtMs, null);
  assert.equal(
    result.timing.translation.firstNonemptyAfterFirstInputEnergyMs,
    null,
  );
});

test('caption summary retains draft rewrites and detects missing pair/final revision', () => {
  const summary = summarizeCaptions([
    caption('original', 'source', true, 10),
    caption('translation', '草稿', false, 20),
    caption('translation', '修改', false, 30),
    caption('translation', '定稿', true, 40),
    caption('translation', '意外重写', true, 50),
    caption('translation', '又成草稿', false, 60),
  ]);
  assert.equal(summary.translation.firstDraftAtMs, 20);
  assert.equal(summary.translation.firstFinalAtMs, 40);
  assert.equal(summary.finalRevisions, 1);
  assert.equal(summary.draftAfterFinal, 1);
  assert.deepEqual(summary.originalFinalsWithoutTranslation, [
    'remote:original:item-1:0',
  ]);
});

test('protocol recording allowlists metadata and removes error messages, instructions, audio, and text', () => {
  const error = captionProtocolEvidence({
    type: 'error',
    error: { message: 'secret-value', code: 'secret-code' },
  });
  assert.equal(JSON.stringify(error).includes('secret'), false);
  const response = captionProtocolEvidence({
    type: 'response.done',
    response: { status: 'completed', output: [{ text: 'secret-output' }] },
  });
  assert.equal(JSON.stringify(response).includes('secret'), false);
  const session = captionProtocolEvidence({
    type: 'session.updated',
    session: {
      model: 'gpt-realtime-1.5',
      instructions: 'secret-prompt',
      audio: {
        input: {
          transcription: {
            model: 'gpt-4o-transcribe',
            language: 'en',
            prompt: 'secret-prompt',
          },
        },
      },
    },
  });
  assert.equal(session?.transcriptionModel, 'gpt-4o-transcribe');
  assert.equal(JSON.stringify(session).includes('secret'), false);
});
