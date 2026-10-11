import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCloudCallUsageBudget,
  type CloudProviderAdmission,
} from '../src/solo/cloud-call-usage';

type Budget = ReturnType<typeof createCloudCallUsageBudget>;
const rejected = /CLOUD_CALL_USAGE_REJECTED/;
const make = (
  reservationUsdMicros = 5_000_000,
  outgoingPairedCaptions = true,
) =>
  createCloudCallUsageBudget({ reservationUsdMicros, outgoingPairedCaptions });
const send = (b: Budget, connectionId: string, data: unknown) =>
  b.admit({ stage: 'send', connectionId, data: JSON.stringify(data) });
const connect = (
  b: Budget,
  connectionId: string,
  path: 'native_translation' | 'remote_captions' | 'outgoing_captions',
  text = false,
) =>
  b.admit({
    stage: 'connect',
    connectionId,
    path,
    role: path === 'remote_captions' ? 'remote' : 'local',
    url:
      path === 'native_translation'
        ? 'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate'
        : text
          ? 'wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5'
          : 'wss://api.openai.com/v1/realtime?intent=transcription',
  });
const textSession = (instructions = 'Translate only.') => ({
  type: 'session.update',
  session: {
    type: 'realtime',
    model: 'gpt-realtime-1.5',
    output_modalities: ['text'],
    instructions,
    audio: { input: { turn_detection: null } },
    tools: [],
  },
});
const request = (text = 'hello', max_output_tokens = 1200) => ({
  type: 'response.create',
  event_id: 'caption_request_1',
  response: {
    conversation: 'none',
    metadata: { caption_request: 'caption_request_1' },
    output_modalities: ['text'],
    instructions: 'Translate only.',
    max_output_tokens,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: JSON.stringify({
              preceding_final_english_context: ['Earlier sentence'],
              current_english_transcript: text,
            }),
          },
        ],
      },
    ],
  },
});
const readyText = (
  b: Budget,
  connectionId = 'remote',
  instructions?: string,
) => {
  connect(
    b,
    connectionId,
    connectionId === 'outgoing' ? 'outgoing_captions' : 'remote_captions',
    true,
  );
  send(b, connectionId, textSession(instructions));
};
const asrSession = (outgoing = false) => ({
  type: 'session.update',
  session: {
    type: 'transcription',
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription: outgoing
          ? { model: 'gpt-live-transcribe', languages: ['zh-cn'], delay: 'low' }
          : {
              model: 'gpt-4o-transcribe',
              language: 'en',
              prompt: 'Transcribe English.',
            },
        turn_detection: outgoing
          ? null
          : {
              type: 'server_vad',
              threshold: 0.3,
              prefix_padding_ms: 300,
              silence_duration_ms: 400,
            },
      },
    },
  },
});
const append = (
  b: Budget,
  connectionId: string,
  bytes: number,
  native = false,
) =>
  send(b, connectionId, {
    type: native
      ? 'session.input_audio_buffer.append'
      : 'input_audio_buffer.append',
    audio: Buffer.alloc(bytes).toString('base64'),
  });

test('five physical connections share sixty text reservations and fail permanently before request 61', () => {
  const b = make();
  readyText(b);
  readyText(b, 'outgoing');
  connect(b, 'native', 'native_translation');
  connect(b, 'remoteAsr', 'remote_captions');
  connect(b, 'outgoingAsr', 'outgoing_captions');
  for (let i = 0; i < 60; i += 1)
    send(b, i % 2 ? 'outgoing' : 'remote', request());
  const before = b.snapshot;
  assert.equal(before.connections, 5);
  assert.equal(before.textRequests, 60);
  assert.equal(before.outputTokensReserved, 72000);
  assert.throws(() => send(b, 'remote', request()), rejected);
  assert.deepEqual(b.snapshot, { ...before, closed: true });
  assert.throws(
    () => send(b, 'remote', { type: 'response.cancel', response_id: 'r1' }),
    rejected,
  );
});

test('UTF8, escaped JSON, repeated contexts and session instructions are charged each time; cancellation never refunds', () => {
  const b = make();
  const instructions = '翻译🙂';
  readyText(b, 'remote', instructions);
  const r = request('中文🙂\n"quoted"\\');
  const raw = JSON.stringify(r);
  const units = Buffer.byteLength(raw) + Buffer.byteLength(instructions) + 4096;
  assert.ok(Buffer.byteLength(raw) > raw.length);
  send(b, 'remote', r);
  send(b, 'remote', {
    type: 'response.cancel',
    event_id: 'cancel_1',
    response_id: 'r1',
  });
  send(b, 'remote', r);
  assert.equal(b.snapshot.inputUnits, units * 2);
  assert.equal(b.snapshot.textReservedUsdMicros, (units * 4 + 1200 * 16) * 2);
  b.close();
  assert.equal(b.snapshot.textRequests, 2);
  assert.throws(() => send(b, 'remote', r), rejected);
});

test('exact monetary remainder admits the last request; one micro less refuses without accounting partial work', () => {
  const r = request();
  const fee =
    (Buffer.byteLength(JSON.stringify(r)) +
      Buffer.byteLength('Translate only.') +
      4096) *
      4 +
    1200 * 16;
  const b = make(2_000_000 + fee);
  readyText(b);
  send(b, 'remote', r);
  assert.equal(b.snapshot.textReservedUsdMicros, fee);
  assert.throws(() => send(b, 'remote', r), rejected);
  assert.equal(b.snapshot.textRequests, 1);
  const short = make(2_000_000 + fee - 1);
  readyText(short);
  assert.throws(() => send(short, 'remote', r), rejected);
  assert.equal(short.snapshot.inputUnits, 0);
});

test('actual audio uploads include preroll, padding and finish while each stream has its own cap', () => {
  const b = make();
  connect(b, 'n', 'native_translation');
  send(b, 'n', {
    type: 'session.update',
    session: { audio: { output: { language: 'en' } } },
  });
  connect(b, 'r', 'remote_captions');
  send(b, 'r', asrSession());
  connect(b, 'o', 'outgoing_captions');
  send(b, 'o', asrSession(true));
  for (const name of ['n', 'r', 'o']) {
    append(b, name, 9600, name === 'n');
    append(b, name, 14_385_600, name === 'n');
    append(b, name, 4800, name === 'n');
  }
  send(b, 'r', {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: { input: { turn_detection: null } },
    },
  });
  send(b, 'r', { type: 'input_audio_buffer.commit' });
  send(b, 'o', { type: 'input_audio_buffer.commit' });
  send(b, 'n', { type: 'session.close' });
  assert.equal(b.snapshot.nativeInputBytes, 14_400_000);
  assert.equal(b.snapshot.remoteAsrInputBytes, 14_400_000);
  assert.equal(b.snapshot.outgoingAsrInputBytes, 14_400_000);
  assert.throws(() => append(b, 'o', 2), rejected);
  assert.equal(b.snapshot.outgoingAsrInputBytes, 14_400_000);
});

test('each playback boundary admits the exact limit, then closes without refund', () => {
  for (const path of ['native_translation', 'return_original'] as const) {
    const b = make();
    const bytes = path === 'native_translation' ? 14_400_000 : 2_400_000;
    b.consumePlayback({ path, bytes });
    const before = b.snapshot;
    assert.throws(() => b.consumePlayback({ path, bytes: 2 }), rejected);
    assert.deepEqual(b.snapshot, { ...before, closed: true });
  }
});

test('connection slots cannot be reused and unexpected URLs, roles and optional paths fail closed', () => {
  const b = make();
  connect(b, 'r1', 'remote_captions');
  assert.throws(() => connect(b, 'r2', 'remote_captions'), rejected);
  assert.equal(b.snapshot.connections, 1);
  const off = make(5_000_000, false);
  assert.throws(() => connect(off, 'o', 'outgoing_captions'), rejected);
  for (const patch of [
    { url: 'wss://api.openai.com/v1/realtime?model=gpt-realtime' },
    { url: 'wss://api.openai.com.evil/v1/realtime?model=gpt-realtime-1.5' },
    { role: 'local' },
    {
      url: 'wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5&tools=true',
    },
  ]) {
    const guard = make();
    assert.throws(
      () =>
        guard.admit({
          stage: 'connect',
          connectionId: 'r',
          path: 'remote_captions',
          role: 'remote',
          url: 'wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5',
          ...patch,
        } as CloudProviderAdmission),
      rejected,
    );
    assert.equal(guard.snapshot.closed, true);
  }
});

test('generation must be explicit text with fixed output and no hidden tools or conversation history', () => {
  for (const patch of [
    { conversation: undefined },
    { conversation: 'auto' },
    { max_output_tokens: 1201 },
    { max_output_tokens: 1.5 },
    { max_output_tokens: 0 },
    { tools: [] },
    { model: 'other' },
    { output_modalities: ['audio'] },
    { input: [] },
    { input: [{ type: 'item_reference', id: 'old' }] },
  ]) {
    const b = make();
    readyText(b);
    const r = request();
    Object.assign(r.response, patch);
    assert.throws(() => send(b, 'remote', r), rejected);
    assert.equal(b.snapshot.textRequests, 0);
  }
  for (const type of [
    'conversation.item.create',
    'response.generate',
    'input_audio_buffer.commit',
  ]) {
    const b = make();
    readyText(b);
    assert.throws(() => send(b, 'remote', { type }), rejected);
  }
});

test('session models and repeated settings are fixed, including remote ASR language/VAD', () => {
  for (const edit of [
    (v: any) => {
      v.session.model = 'other';
    },
    (v: any) => {
      v.session.audio.input.turn_detection = { type: 'server_vad' };
    },
    (v: any) => {
      v.session.instructions = 'x'.repeat(16385);
    },
  ]) {
    const b = make();
    connect(b, 'r', 'remote_captions', true);
    const s = textSession();
    edit(s);
    assert.throws(() => send(b, 'r', s), rejected);
  }
  const b = make();
  readyText(b);
  assert.throws(() => send(b, 'remote', textSession()), rejected);
  for (const s of [
    asrSession(true),
    { ...asrSession(), session: { ...asrSession().session, model: 'other' } },
  ]) {
    const g = make();
    connect(g, 'r', 'remote_captions');
    assert.throws(() => send(g, 'r', s), rejected);
  }
});

test('per-request and combined input proxy ceilings are checked before increment', () => {
  const b = make();
  readyText(b, 'remote', 's'.repeat(16000));
  assert.throws(() => send(b, 'remote', request('x'.repeat(15000))), rejected);
  assert.equal(b.snapshot.inputUnits, 0);
  const combined = make();
  readyText(combined);
  readyText(combined, 'outgoing');
  const r = request('x'.repeat(10000), 1);
  const units =
    Buffer.byteLength(JSON.stringify(r)) +
    Buffer.byteLength('Translate only.') +
    4096;
  const count = Math.floor(450000 / units);
  for (let i = 0; i < count; i += 1)
    send(combined, i % 2 ? 'outgoing' : 'remote', r);
  assert.throws(() => send(combined, 'remote', r), rejected);
  assert.equal(combined.snapshot.inputUnits, units * count);
});

test('invalid numbers, malformed JSON and non-canonical PCM are rejected with no secret-bearing error', () => {
  for (const amount of [
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    -1,
    2000000,
    5000001,
    3000000.5,
  ])
    assert.throws(() => make(amount), rejected);
  for (const data of ['{"secret":', Buffer.from('secret'), '{}']) {
    const b = make();
    readyText(b);
    assert.throws(
      () => b.admit({ stage: 'send', connectionId: 'remote', data }),
      rejected,
    );
    assert.equal(b.snapshot.closed, true);
  }
  for (const audio of ['!!!=', 'A===', 'AAA', 'AA==', 'AAB=']) {
    const b = make();
    connect(b, 'r', 'remote_captions');
    send(b, 'r', asrSession());
    assert.throws(
      () => send(b, 'r', { type: 'input_audio_buffer.append', audio }),
      rejected,
    );
  }
  for (const bytes of [
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    -1,
    0,
    0.5,
  ]) {
    const b = make();
    assert.throws(
      () => b.consumePlayback({ path: 'return_original', bytes }),
      rejected,
    );
    assert.equal(b.snapshot.closed, true);
  }
  const b = make();
  assert.equal(b.snapshot.scope, 'application_reserved');
  assert.equal(b.snapshot.billed, false);
  assert.equal(b.snapshot.costBoundVerified, false);
});

test('exact per-request input boundary accepts 32768 units and rejects the next byte', () => {
  const r = request('x'.repeat(15000), 1);
  const instructionSize = 32768 - Buffer.byteLength(JSON.stringify(r)) - 4096;
  assert.ok(instructionSize > 0 && instructionSize <= 16384);
  const b = make();
  readyText(b, 'remote', 's'.repeat(instructionSize));
  send(b, 'remote', r);
  assert.equal(b.snapshot.inputUnits, 32768);
  const before = b.snapshot;
  assert.throws(
    () => send(b, 'remote', request('x'.repeat(15001), 1)),
    rejected,
  );
  assert.deepEqual(b.snapshot, { ...before, closed: true });
});

test('configuration and returned snapshots cannot mutate an existing reservation', () => {
  const options = {
    reservationUsdMicros: 2_000_001,
    outgoingPairedCaptions: false,
  };
  const b = createCloudCallUsageBudget(options);
  options.reservationUsdMicros = 5_000_000;
  options.outgoingPairedCaptions = true;
  readyText(b);
  const view = b.snapshot;
  view.textRequests = -100;
  assert.throws(() => send(b, 'remote', request()), rejected);
  assert.equal(b.snapshot.reservationUsdMicros, 2_000_001);
  assert.equal(b.snapshot.textRequests, 0);
});
