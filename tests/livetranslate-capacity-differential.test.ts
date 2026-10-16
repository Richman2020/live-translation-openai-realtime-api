import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { after, before, test, type TestContext } from 'node:test';
import WebSocket from 'ws';

import { createLiveTranslateClient } from '../src/experiments/livetranslate-client';
import type { LiveTranslateClientOptions } from '../src/experiments/livetranslate-types';
import {
  CF62_BASELINE_COMMIT,
  loadFrozenCf62Baseline,
} from './helpers/livetranslate-cf62-baseline';

/** Capacity scenarios use synthetic audio and events. One explicitly labelled
 * case replays a historical redacted five-frame configuration prefix; it has
 * no audio, usage or capacity capture and establishes no telephone playback. */
type Role = 'local' | 'remote';
type Action =
  | { kind: 'receive'; frame: Record<string, any> }
  | { kind: 'append'; bytes: number }
  | { kind: 'finish' | 'abort' };
type Trace = { step: number; at: number; kind: string; value: unknown }[];
const epoch = 1792110000000;
const jsonCopy = (value: unknown) => JSON.parse(JSON.stringify(value));
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
let frozen: Awaited<ReturnType<typeof loadFrozenCf62Baseline>>;
const results: Record<string, unknown>[] = [];
const receiptDirectory = process.env.LIVETRANSLATE_DIFFERENTIAL_RECEIPT_DIR;

before(async () => {
  frozen = await loadFrozenCf62Baseline();
  if (receiptDirectory) {
    mkdirSync(receiptDirectory, { recursive: true });
    writeFileSync(
      join(receiptDirectory, 'CF62_FROZEN_BLOBS.json'),
      JSON.stringify(
        {
          commit: frozen.commit,
          blobs: frozen.blobs,
          unmodifiedRelativeImports: true,
          candidateHelpersUsedForBaseline: false,
        },
        null,
        2,
      ),
    );
  }
});
after(() => {
  if (receiptDirectory)
    writeFileSync(
      join(receiptDirectory, 'DIFFERENTIAL_RESULTS.json'),
      JSON.stringify(
        {
          baseline: CF62_BASELINE_COMMIT,
          evidenceKinds: [
            'synthetic_capacity_events',
            'actual_redacted_five_frame_prefix',
          ],
          actualCapacity257Captured: false,
          paidCalls: 0,
          results,
        },
        null,
        2,
      ),
    );
  frozen?.dispose();
});

class SyntheticSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  closes = 0;
  sent: unknown[] = [];
  constructor(private readonly record: (kind: string, value: unknown) => void) {
    super();
  }
  send(raw: string, callback?: (error?: Error) => void) {
    const value = JSON.parse(raw);
    this.sent.push(value);
    this.record('model_input_wire', value);
    callback?.();
  }
  terminate() {
    this.closes += 1;
    this.readyState = WebSocket.CLOSED;
    this.record('socket_close', { code: 1006 });
    this.emit('close', 1006);
  }
  close() {
    this.closes += 1;
    this.readyState = WebSocket.CLOSED;
    this.record('socket_close', { code: 1000 });
    this.emit('close', 1000);
  }
}

function fixture(
  factory: typeof createLiveTranslateClient,
  role: Role,
  clock: { step: number },
  extras: Pick<LiveTranslateClientOptions, 'allowMissingVoiceCloneEcho'> = {},
) {
  const trace: Trace = [];
  const record = (kind: string, value: unknown) =>
    trace.push({
      step: clock.step,
      at: epoch + clock.step * 10,
      kind,
      value: jsonCopy(value),
    });
  const socket = new SyntheticSocket(record);
  const errors: string[] = [];
  let connects = 0;
  const client = factory({
    enabled: true,
    usage: 'phone',
    role,
    voice: role === 'local' ? 'Andre' : 'Tina',
    allowAndreTopLevelWithTinaOutput: role === 'local',
    workspaceId: 'synthetic-differential',
    apiKey: 'SYNTHETIC_UNUSED_DIFFERENTIAL_KEY',
    now: () => epoch + clock.step * 10,
    createWebSocket: () => {
      connects += 1;
      return socket as unknown as WebSocket;
    },
    onSource: (value) => record('source', value),
    onTranslation: (value) => record('translation', value),
    onAssociation: (value) => record('association', value),
    onAudio: (pcm, metadata) =>
      record('audio', { pcmHex: pcm.toString('hex'), metadata }),
    onUsage: (value) => record('usage', value),
    onTiming: (value) => record('timing', value),
    onSessionConfiguration: (value) => record('session_configuration', value),
    onVoiceEvidence: (value) => record('voice_evidence', value),
    onProtocolEvent: (value) => record('protocol_event', value),
    onProtocolDiagnostic: (value) => record('protocol_diagnostic', value),
    onSendObservation: (value) => record('send_observation', value),
    onError: (code, details) => {
      errors.push(code);
      record('error', { code, details });
    },
    ...extras,
  } satisfies LiveTranslateClientOptions);
  client.ready.then(
    (value) => record('ready', value),
    (error) => record('ready_rejected', { code: error.message }),
  );
  client.transportClosed?.then((value) => record('transport_closed', value));
  const apply = (action: Action) => {
    if (action.kind === 'receive') {
      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            event_id: `synthetic_diff_${clock.step}`,
            ...action.frame,
          }),
        ),
        false,
      );
    } else if (action.kind === 'append') {
      try {
        client.append(Buffer.alloc(action.bytes));
        record('append_returned', { bytes: action.bytes });
      } catch (error) {
        record('append_rejected', { code: (error as Error).message });
      }
    } else if (action.kind === 'abort') client.abort();
    else
      client.finish().then(
        () => record('finished', { success: true }),
        (error) => record('finished_rejected', { code: error.message }),
      );
  };
  return { trace, errors, socket, client, apply, connects: () => connects };
}

const frame = (value: Record<string, any>): Action => ({
  kind: 'receive',
  frame: value,
});
function session(role: Role) {
  return {
    id: `synthetic_diff_${role}`,
    model: 'qwen3.8-livetranslate-flash-realtime',
    voice: role === 'local' ? 'Andre' : 'Tina',
    output_modalities: role === 'local' ? ['text', 'audio'] : ['text'],
    enable_voice_clone: false,
    audio: {
      input: {
        format: { type: 'pcm', sample_rate: 16000 },
        turn_detection: { type: 'speaker_detection', threshold: 0.5 },
      },
      output: { format: { type: 'pcm', sample_rate: 24000 }, voice: 'Tina' },
    },
    translation: { language: role === 'local' ? 'en' : 'zh' },
  };
}
function source(
  id: string,
  offset: number,
  final = true,
  raw = 'Synthetic actual repetition, not twenty but fifteen.',
): Action[] {
  return [
    frame({
      type: 'input_audio_buffer.speech_started',
      item_id: id,
      audio_start_ms: offset,
    }),
    ...(final
      ? [
          frame({
            type: 'input_audio_buffer.speech_stopped',
            item_id: id,
            audio_end_ms: offset + 400,
          }),
        ]
      : []),
    frame({
      type: `conversation.item.input_audio_transcription.${final ? 'completed' : 'delta'}`,
      item_id: id,
      content_index: 0,
      ...(final ? { transcript: raw } : { delta: raw }),
    }),
  ];
}
function output(
  role: Role,
  index: number,
  type: string,
  patch: Record<string, unknown> = {},
): Action {
  return frame({
    type,
    response_id: `response_${index}`,
    item_id: `translation_${index}`,
    output_index: 0,
    content_index: 0,
    ...patch,
  });
}
const created = (index: number) =>
  frame({
    type: 'response.created',
    response: { id: `response_${index}`, status: 'in_progress' },
  });
const link = (index: number, id: string) =>
  frame({
    type: 'conversation.item.created',
    previous_item_id: id,
    item: { id: `translation_${index}`, role: 'assistant', content: [] },
  });
const translatedText = (index: number) =>
  `Synthetic faithful translation ${index}.`;
const audio = (role: Role, index: number, eventId?: string) => {
  const pcm = Buffer.alloc(4);
  pcm.writeInt16LE(index + 1, 0);
  pcm.writeInt16LE(-(index + 1), 2);
  return output(role, index, 'response.audio.delta', {
    delta: pcm.toString('base64'),
    ...(eventId ? { event_id: eventId } : {}),
  });
};
function done(role: Role, index: number, text = translatedText(index)): Action {
  return frame({
    type: 'response.done',
    response: {
      id: `response_${index}`,
      status: 'completed',
      usage: {
        input_tokens: 4,
        output_tokens: 3,
        input_tokens_details: { audio_tokens: 3, text_tokens: 1 },
        output_tokens_details: {
          audio_tokens: role === 'local' ? 2 : 0,
          text_tokens: role === 'local' ? 1 : 3,
        },
      },
      output: [
        {
          id: `translation_${index}`,
          content: [
            {
              type: role === 'local' ? 'audio' : 'text',
              ...(role === 'local' ? { transcript: text } : { text }),
            },
          ],
        },
      ],
    },
  });
}
function response(
  role: Role,
  index: number,
  id: string,
  options: { created?: boolean; done?: boolean; partial?: boolean } = {},
): Action[] {
  const text = translatedText(index);
  return [
    ...(options.created === false ? [] : [created(index)]),
    link(index, id),
    ...(options.partial
      ? [
          output(
            role,
            index,
            role === 'local'
              ? 'response.audio_transcript.delta'
              : 'response.text.delta',
            { delta: 'Synthetic ' },
          ),
        ]
      : []),
    output(
      role,
      index,
      role === 'local'
        ? 'response.audio_transcript.done'
        : 'response.text.done',
      role === 'local' ? { transcript: text } : { text },
    ),
    ...(role === 'local'
      ? [audio(role, index), output(role, index, 'response.audio.done')]
      : []),
    ...(options.done === false ? [] : [done(role, index)]),
  ];
}

async function pair(
  t: TestContext,
  role: Role,
  clock = { step: 0 },
  mockMonotonic = true,
  extras: Pick<LiveTranslateClientOptions, 'allowMissingVoiceCloneEcho'> = {},
) {
  // Both local-write durations and public epoch timestamps are controlled.
  // No critical timing field is removed to make the traces agree.
  if (mockMonotonic) t.mock.method(performance, 'now', () => clock.step * 10);
  const baseline = fixture(
    frozen.module.createLiveTranslateClient,
    role,
    clock,
    extras,
  );
  const candidate = fixture(createLiveTranslateClient, role, clock, extras);
  let cursor = 0;
  t.after(() => {
    baseline.client.abort();
    candidate.client.abort();
  });
  const step = async (action: Action, equal = true) => {
    clock.step += 1;
    baseline.apply(action);
    candidate.apply(action);
    await Promise.resolve();
    if (equal) {
      assert.deepEqual(
        candidate.trace.slice(cursor),
        baseline.trace.slice(cursor),
        `same public events and exact simulated time after step ${clock.step}`,
      );
      cursor = baseline.trace.length;
    }
  };
  const run = async (actions: Action[], equal = true) => {
    for (const action of actions) await step(action, equal);
  };
  const start = async () => {
    await step(frame({ type: 'session.created', session: session(role) }));
    await step(frame({ type: 'session.updated', session: session(role) }));
    await Promise.all([baseline.client.ready, candidate.client.ready]);
  };
  const save = (
    name: string,
    equal: boolean,
    evidence: Record<string, unknown> = { kind: 'synthetic_events_only' },
  ) => {
    const record = {
      name,
      role,
      equal,
      steps: clock.step,
      baselineTraceSha256: digest(baseline.trace),
      candidateTraceSha256: digest(candidate.trace),
      baselineEvents: baseline.trace.length,
      candidateEvents: candidate.trace.length,
      baselineErrors: baseline.errors,
      candidateErrors: candidate.errors,
      baselineConnections: baseline.connects(),
      candidateConnections: candidate.connects(),
      evidence,
    };
    results.push(record);
    if (receiptDirectory)
      writeFileSync(
        join(receiptDirectory, `${name}-${role}-traces.json`),
        JSON.stringify(
          {
            syntheticOnly: evidence.kind === 'synthetic_events_only',
            record,
            baseline: baseline.trace,
            candidate: candidate.trace,
          },
          null,
          2,
        ),
      );
  };
  return { baseline, candidate, step, run, start, save };
}

test('baseline executes five exact immutable cf62 blobs including its real send helper', () => {
  assert.equal(frozen.commit, CF62_BASELINE_COMMIT);
  assert.deepEqual(
    frozen.blobs.map((item) => item.path),
    [
      'package.json',
      'src/experiments/livetranslate-client.ts',
      'src/experiments/livetranslate-types.ts',
      'src/experiments/livetranslate-send-pump.ts',
      'src/solo/openai-websocket.ts',
    ],
  );
  assert.ok(frozen.directory.includes('.runtime'));
  assert.equal(
    frozen.module.LIVE_TRANSLATE_MODEL,
    'qwen3.8-livetranslate-flash-realtime',
  );
});

test('differential actual capture: identical five historical redacted frames retain cf62 voice/configuration observations', async (t) => {
  const bytes = readFileSync(
    new URL(
      './fixtures/livetranslate-protocol/actual-andre-session-tina-response-andre.redacted.json',
      import.meta.url,
    ),
  );
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '03069cac40af09bb838f828c2c4d6a7f37560b6f965143e026fc53c7f0dab20a',
  );
  const captured = JSON.parse(bytes.toString('utf8'));
  assert.equal(
    captured.provenance,
    'actual_provider_redacted_inbound_and_captured_outbound_configuration',
  );
  assert.equal(captured.providerFrames.length, 5);
  const p = await pair(t, 'local', { step: 0 }, true, {
    allowMissingVoiceCloneEcho: true,
  });
  for (const item of captured.providerFrames) {
    assert.equal(item.binary, false);
    await p.step(frame(item.event));
  }
  assert.deepEqual(p.candidate.errors, []);
  assert.equal(p.candidate.socket.sent.length, 1);
  assert.equal(
    JSON.stringify(p.candidate.socket.sent[0]),
    captured.outboundSerializedUtf8,
  );
  assert.equal(
    p.candidate.trace.filter((item) => item.kind === 'audio').length,
    0,
  );
  assert.equal(
    p.candidate.trace.filter((item) => item.kind === 'usage').length,
    0,
  );
  await p.step({ kind: 'abort' });
  p.save('actual-five-frame-voice-prefix', true, {
    kind: 'actual_redacted_provider_frames_replayed_offline',
    sourceCandidate: captured.sourceCandidate,
    sourceJournalSha256: captured.sourceJournalSha256,
    fixtureSha256: createHash('sha256').update(bytes).digest('hex'),
    frames: 5,
    completeAudioCaptured: false,
    usageCaptured: false,
    capacity257Captured: false,
    clock: 'controlled_frame_steps_not_real_model_latency',
    realModelConnections: 0,
    recordingBytesUploaded: 0,
  });
});

test('differential duplex: alternating directions retain independent sessions and the same shared synthetic chronology', async (t) => {
  const clock = { step: 0 };
  const local = await pair(t, 'local', clock);
  const remote = await pair(t, 'remote', clock, false);
  await local.start();
  await remote.start();
  await local.run(source('local_a', 100));
  await local.run(response('local', 0, 'local_a'));
  await remote.run(source('remote_a', 100));
  await remote.run(response('remote', 0, 'remote_a'));
  await local.run(source('local_b', 1200));
  await local.run(response('local', 1, 'local_b'));
  await remote.run(source('remote_b', 1400));
  await remote.run(response('remote', 1, 'remote_b'));
  await local.step({ kind: 'finish' });
  await remote.step({ kind: 'finish' });
  await local.step(frame({ type: 'session.finished' }));
  await remote.step(frame({ type: 'session.finished' }));
  assert.deepEqual(local.candidate.errors, []);
  assert.deepEqual(remote.candidate.errors, []);
  assert.equal(
    local.candidate.trace.filter((item) => item.kind === 'audio').length,
    2,
  );
  assert.equal(
    remote.candidate.trace.filter((item) => item.kind === 'audio').length,
    0,
  );
  assert.equal(local.candidate.connects(), 1);
  assert.equal(remote.candidate.connects(), 1);
  local.save('duplex-shared-clock', true);
  remote.save('duplex-shared-clock', true);
});

for (const role of ['local', 'remote'] as const) {
  test(`differential ${role}: multi-source and same-source genuine repetitions preserve all callbacks, requests and finish timing`, async (t) => {
    const p = await pair(t, role);
    await p.start();
    await p.step({ kind: 'append', bytes: 640 });
    await p.run(source('source_a', 100));
    await p.run(response(role, 0, 'source_a', { partial: true }));
    await p.run(response(role, 1, 'source_a'));
    await p.run(source('source_b', 1000));
    await p.step({ kind: 'append', bytes: 640 });
    await p.run(response(role, 2, 'source_b', { partial: true }));
    await p.step({ kind: 'finish' });
    await p.step(frame({ type: 'session.finished' }));
    assert.deepEqual(p.candidate.errors, []);
    assert.equal(
      p.candidate.trace.filter((item) => item.kind === 'finished').length,
      1,
    );
    assert.equal(p.candidate.connects(), 1);
    p.save('normal-repetition-finish', true);
  });

  test(`differential ${role}: output before source final and text revisions do not acquire new waiting or earlier playback`, async (t) => {
    const p = await pair(t, role);
    await p.start();
    await p.run(
      source('source_open', 100, false, 'Synthetic hesitation: not twenty.'),
    );
    await p.step(created(0));
    await p.step(link(0, 'source_open'));
    const provisional = output(
      role,
      0,
      role === 'local'
        ? 'response.audio_transcript.delta'
        : 'response.text.delta',
      {
        delta: 'Synthetic provisional ',
        event_id: 'synthetic_exact_text_duplicate',
      },
    );
    await p.step(provisional);
    await p.step(provisional);
    if (role === 'local') {
      const firstAudio = audio(role, 0, 'synthetic_exact_audio_duplicate');
      await p.step(firstAudio);
      await p.step(firstAudio);
      assert.equal(
        p.candidate.trace.filter((item) => item.kind === 'audio').length,
        1,
      );
    }
    assert.ok(
      p.candidate.trace.some(
        (item) => item.kind === (role === 'local' ? 'audio' : 'translation'),
      ),
    );
    await p.step(
      frame({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'source_open',
        content_index: 0,
        delta: ' Fifteen; correction is explicit.',
      }),
    );
    await p.step(
      output(
        role,
        0,
        role === 'local'
          ? 'response.audio_transcript.done'
          : 'response.text.done',
        role === 'local'
          ? { transcript: translatedText(0) }
          : { text: translatedText(0) },
      ),
    );
    if (role === 'local') await p.step(output(role, 0, 'response.audio.done'));
    await p.step(done(role, 0));
    await p.step(
      frame({
        type: 'input_audio_buffer.speech_stopped',
        item_id: 'source_open',
        audio_end_ms: 700,
      }),
    );
    await p.step(
      frame({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'source_open',
        content_index: 0,
        transcript:
          'Synthetic hesitation: not twenty. Fifteen; correction is explicit.',
      }),
    );
    await p.step({ kind: 'finish' });
    await p.step(frame({ type: 'session.finished' }));
    assert.deepEqual(p.candidate.errors, []);
    p.save('early-output-revisions', true);
  });

  test(`differential ${role}: reversed source responses, duplicate events and late completed results retain exactly the cf62 order`, async (t) => {
    const p = await pair(t, role);
    await p.start();
    await p.run(source('source_a', 100));
    await p.run(source('source_b', 1000));
    await p.run(response(role, 1, 'source_b'));
    assert.equal(
      p.candidate.trace.filter((item) => item.kind === 'audio').length,
      0,
    );
    await p.run(response(role, 0, 'source_a'));
    const counts = p.candidate.trace.filter((item) =>
      ['audio', 'translation', 'usage'].includes(item.kind),
    ).length;
    await p.step(done(role, 0));
    await p.step(
      output(
        role,
        0,
        role === 'local'
          ? 'response.audio_transcript.delta'
          : 'response.text.delta',
        { delta: 'Synthetic late stale fragment.' },
      ),
    );
    if (role === 'local') await p.step(audio(role, 0, 'synthetic_late_audio'));
    assert.equal(
      p.candidate.trace.filter((item) =>
        ['audio', 'translation', 'usage'].includes(item.kind),
      ).length,
      counts,
    );
    await p.step({ kind: 'abort' });
    assert.deepEqual(p.candidate.errors, []);
    p.save('reverse-duplicate-late', true);
  });

  test(`differential ${role}: legitimate empty response and unfinished source preserve strict finish failure`, async (t) => {
    const p = await pair(t, role);
    await p.start();
    await p.step(created(90));
    await p.step(
      frame({
        type: 'response.done',
        response: { id: 'response_90', status: 'completed', output: [] },
      }),
    );
    await p.run(source('source_open', 100, false));
    await p.run(response(role, 0, 'source_open'));
    await p.step({ kind: 'finish' });
    await p.step(frame({ type: 'session.finished' }));
    assert.deepEqual(p.candidate.errors, ['LIVETRANSLATE_FINISH_INCOMPLETE']);
    p.save('empty-and-unfinished', true);
  });

  test(`differential ${role}: abort clears held output and ignores late results without another request or session`, async (t) => {
    const p = await pair(t, role);
    await p.start();
    await p.run(source('source_a', 100));
    await p.run(source('source_b', 1000));
    await p.run(response(role, 1, 'source_b'));
    await p.step({ kind: 'abort' });
    const before = p.candidate.trace.filter((item) =>
      ['audio', 'translation', 'model_input_wire'].includes(item.kind),
    ).length;
    await p.run(response(role, 0, 'source_a'));
    await p.step(frame({ type: 'input_audio_buffer.cleared' }));
    await p.step({ kind: 'append', bytes: 640 });
    assert.equal(
      p.candidate.trace.filter((item) =>
        ['audio', 'translation', 'model_input_wire'].includes(item.kind),
      ).length,
      before,
    );
    assert.equal(p.candidate.connects(), 1);
    assert.equal(p.candidate.socket.closes, 1);
    p.save('abort-late', true);
  });

  test(`differential ${role}: real source/output identity conflict stays fail-closed with unchanged validation and voice`, async (t) => {
    const p = await pair(t, role);
    await p.start();
    await p.run(source('translation_0', 100));
    await p.step(created(0));
    await p.step(
      output(
        role,
        0,
        role === 'local'
          ? 'response.audio_transcript.delta'
          : 'response.text.delta',
        { delta: 'Synthetic conflict must not display.' },
      ),
    );
    assert.deepEqual(p.candidate.errors, ['LIVETRANSLATE_ITEM_CONFLICT']);
    assert.equal(
      p.candidate.trace.filter((item) => item.kind === 'audio').length,
      0,
    );
    p.save('identity-conflict', true);
  });

  test(`differential ${role}: single-source 256 prefix is identical; old 257 capacity failure and candidate continuation are explicitly different`, async (t) => {
    const p = await pair(t, role);
    await p.start();
    // Keep the ASR source unfinished while mature output identities compact.
    await p.run(source('source_dense', 100, false));
    for (let index = 0; index < 256; index += 1)
      await p.run(
        response(role, index, 'source_dense').map((action, actionIndex) =>
          index === 0 && actionIndex === 0 && action.kind === 'receive'
            ? frame({
                ...action.frame,
                event_id: 'synthetic_dense_first_created',
              })
            : action,
        ),
      );
    const emittedOutput = p.candidate.trace.filter((item) =>
      ['audio', 'translation', 'usage'].includes(item.kind),
    ).length;
    // These new event IDs target an old mature output, beyond the proposed
    // heavy-object cache. Preserve cf62's public observation/validation order
    // as well as its no-repeat audio/text/usage behavior.
    await p.step(created(0));
    await p.step(
      frame({
        ...(created(0) as Extract<Action, { kind: 'receive' }>).frame,
        event_id: 'synthetic_dense_first_created',
      }),
    );
    await p.step(done(role, 0));
    await p.step(
      output(
        role,
        0,
        role === 'local'
          ? 'response.audio_transcript.delta'
          : 'response.text.delta',
        { delta: 'Synthetic old finalized fragment must not replay.' },
      ),
    );
    if (role === 'local') await p.step(audio(role, 0));
    assert.equal(
      p.candidate.trace.filter((item) =>
        ['audio', 'translation', 'usage'].includes(item.kind),
      ).length,
      emittedOutput,
    );
    // Finalizing the still-open source changes digest retirement eligibility;
    // it must not change any public source/translation or late-result behavior.
    await p.step(
      frame({
        type: 'input_audio_buffer.speech_stopped',
        item_id: 'source_dense',
        audio_end_ms: 800,
      }),
    );
    await p.step(
      frame({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'source_dense',
        content_index: 0,
        transcript: 'Synthetic actual repetition, not twenty but fifteen.',
      }),
    );
    await p.step(created(0));
    await p.step(done(role, 0));
    assert.deepEqual(p.baseline.errors, []);
    assert.deepEqual(p.candidate.errors, []);
    assert.equal(digest(p.baseline.trace), digest(p.candidate.trace));
    await p.run(response(role, 256, 'source_dense'), false);
    assert.deepEqual(p.baseline.errors, ['LIVETRANSLATE_ITEM_CAPACITY']);
    assert.deepEqual(p.candidate.errors, []);
    assert.equal(
      p.candidate.trace.filter((item) => item.kind === 'audio').length,
      role === 'local' ? 257 : 0,
    );
    assert.equal(
      p.baseline.trace.filter((item) => item.kind === 'audio').length,
      role === 'local' ? 256 : 0,
    );
    assert.equal(p.candidate.connects(), 1);
    assert.equal(p.baseline.connects(), 1);
    await p.step({ kind: 'finish' }, false);
    await p.step(frame({ type: 'session.finished' }), false);
    assert.equal(
      p.candidate.trace.filter((item) => item.kind === 'finished').length,
      1,
    );
    assert.equal(
      p.baseline.trace.filter((item) => item.kind === 'finished_rejected')
        .length,
      1,
    );
    p.save('256-equivalent-257-intentional-change', false);
    await p.step({ kind: 'abort' }, false);
  });
}
