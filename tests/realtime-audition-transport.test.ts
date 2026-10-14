import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';

import { createAuditionTransport } from '../src/experiments/realtime-audition-transport';

class FakeSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING as number;

  bufferedAmount = 0;

  sent: Record<string, any>[] = [];

  terminated = 0;

  failSend = false;

  throwTerminate = false;

  onSend?: (event: Record<string, any>) => void;

  send(value: string, callback?: (error?: Error) => void) {
    const event = JSON.parse(value);
    this.sent.push(event);
    this.onSend?.(event);
    callback?.(this.failSend ? new Error('private provider body') : undefined);
  }

  terminate() {
    this.terminated += 1;
    if (this.throwTerminate) throw new Error('secret');
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}
const session = () => ({
  type: 'realtime',
  instructions: 'Translate Chinese faithfully into English. Do not answer.',
  output_modalities: ['audio'],
  audio: {
    input: {
      format: { type: 'audio/pcm', rate: 24000 },
      transcription: {
        model: 'gpt-4o-transcribe',
        language: 'zh',
        prompt: 'Faithful raw transcript.',
      },
      turn_detection: null,
    },
    output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'echo' },
  },
  tools: [],
  tool_choice: 'none',
  tracing: null,
});
function fixture(options: Record<string, any> = {}) {
  const raw = new FakeSocket();
  const stops: string[] = [];
  let factories = 0;
  const transport = createAuditionTransport({
    createWebSocket: () => {
      factories += 1;
      return raw as unknown as WebSocket;
    },
    onStop: (reason) => stops.push(reason),
    cleanupTimeoutMs: 5,
    readyTimeoutMs: 1000,
    progressTimeoutMs: 1000,
    wallTimeoutMs: 1000,
    ...options,
  });
  const socket = transport.createWebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1',
    { headers: { Authorization: 'Bearer fake-offline-key' } },
  );
  const forwarded: Record<string, any>[] = [];
  socket.on('message', (value) => forwarded.push(JSON.parse(value.toString())));
  let eventSequence = 0;
  const inbound = (event: Record<string, any>) => {
    eventSequence += 1;
    raw.emit(
      'message',
      JSON.stringify({ event_id: `event_${eventSequence}`, ...event }),
    );
  };
  const send = (event: object) => socket.send(JSON.stringify(event), () => {});
  const ready = () => {
    raw.readyState = WebSocket.OPEN;
    raw.emit('open');
    send({ type: 'session.update', session: session() });
    inbound({
      type: 'session.updated',
      session: {
        ...session(),
        model: 'gpt-realtime-2.1',
        max_output_tokens: 512,
      },
    });
  };
  const asr = (sequence: number, text = '你好。') => {
    inbound({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: `source_${sequence}`,
      content_index: 0,
      transcript: text,
      usage: {
        type: 'tokens',
        input_tokens: 5,
        output_tokens: 3,
        total_tokens: 8,
        input_token_details: { audio_tokens: 4, text_tokens: 1 },
      },
    });
  };
  const source = (
    sequence: number,
    audio = Buffer.alloc(4800, sequence),
    text = '你好。',
  ) => {
    send({
      type: 'input_audio_buffer.append',
      audio: audio.toString('base64'),
    });
    send({ type: 'input_audio_buffer.commit' });
    inbound({
      type: 'input_audio_buffer.committed',
      item_id: `source_${sequence}`,
    });
    asr(sequence, text);
    return audio;
  };
  const request = (
    sequence: number,
    audio = Buffer.alloc(4800, sequence),
    text = '你好。',
  ) => ({
    type: 'response.create',
    response: {
      conversation: 'none',
      output_modalities: ['audio'],
      instructions: session().instructions,
      audio: session().audio,
      tools: [],
      tool_choice: 'none',
      metadata: { prototype_request: `request_${sequence}` },
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({
                current_asr_observation: text,
                recent_raw_call_context: [],
              }),
            },
            { type: 'input_audio', audio: audio.toString('base64') },
          ],
        },
      ],
    },
  });
  const created = (sequence: number, ...caps: unknown[]) => {
    const cap = caps.length ? caps[0] : 512;
    inbound({
      type: 'response.created',
      response: {
        id: `response_${sequence}`,
        metadata: { prototype_request: `request_${sequence}` },
        max_output_tokens: cap,
      },
    });
  };
  const done = (sequence: number, status = 'completed') => {
    inbound({
      type: 'response.done',
      response: {
        id: `response_${sequence}`,
        status,
        usage: {
          input_tokens: 20,
          output_tokens: 10,
          total_tokens: 30,
          input_token_details: {
            audio_tokens: 12,
            text_tokens: 8,
            cached_tokens: 4,
            cached_tokens_details: { audio_tokens: 3, text_tokens: 1 },
          },
          output_token_details: { audio_tokens: 7, text_tokens: 3 },
        },
      },
    });
  };
  return {
    raw,
    transport,
    socket,
    stops,
    forwarded,
    inbound,
    send,
    ready,
    source,
    asr,
    request,
    created,
    done,
    factories: () => factories,
  };
}

test('one session and explicit actual 512 caps; snapshots expose only safe accounting', async () => {
  const f = fixture();
  f.ready();
  const audio = f.source(1);
  f.send(f.request(1, audio));
  assert.equal(f.raw.sent[0].session.max_output_tokens, 512);
  assert.equal(f.raw.sent.at(-1)?.response.max_output_tokens, 512);
  f.created(1);
  f.done(1);
  await f.transport.closeSuccess();
  const snapshot = f.transport.snapshot();
  assert.equal(snapshot.state, 'closed');
  assert.equal(snapshot.allClosed, true);
  assert.equal(snapshot.connections, 1);
  assert.equal(snapshot.responseCapConfirmed, 1);
  assert.equal(snapshot.sessionCapConfirmed, true);
  assert.equal(
    snapshot.sessionInstructionBytes,
    Buffer.byteLength(session().instructions),
  );
  assert.equal(snapshot.requestAccounting[0].sourceSequence, 1);
  assert.equal(snapshot.requestAccounting[0].priorAudioBytes, 0);
  assert.equal(snapshot.usage[1].cachedAudioInputTokens, 3);
  assert.equal(snapshot.usage[1].cachedTextInputTokens, 1);
  assert.equal(snapshot.unknownUsage, false);
  assert.equal(f.factories(), 1);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /fake-offline-key|你好|response_1|source_1/,
  );
});

for (const cap of [undefined, 'inf', 511, 513]) {
  test(`session cap ACK ${String(cap)} rejects before any audio submission`, async () => {
    const f = fixture();
    f.raw.readyState = WebSocket.OPEN;
    f.send({ type: 'session.update', session: session() });
    f.inbound({
      type: 'session.updated',
      session: {
        ...session(),
        model: 'gpt-realtime-2.1',
        max_output_tokens: cap,
      },
    });
    f.send({
      type: 'input_audio_buffer.append',
      audio: Buffer.alloc(2).toString('base64'),
    });
    await f.transport.closed;
    assert.equal(f.transport.snapshot().appendBytes, 0);
    assert.equal(f.raw.sent.length, 1);
    assert.deepEqual(f.stops, ['AUDITION_SESSION_MISMATCH']);
  });
  test(`response cap ACK ${String(cap)} cancels by known OOB id and admits no audio`, async () => {
    const f = fixture();
    f.ready();
    const audio = f.source(1);
    f.send(f.request(1, audio));
    f.created(1, cap);
    f.inbound({
      type: 'response.output_audio.delta',
      response_id: 'response_1',
      delta: 'AAAA',
    });
    await f.transport.closed;
    assert.equal(f.transport.snapshot().responseCapConfirmed, 0);
    assert.equal(
      f.forwarded.some((event) => event.type === 'response.output_audio.delta'),
      false,
    );
    assert.deepEqual(f.raw.sent.at(-1), {
      type: 'response.cancel',
      response_id: 'response_1',
    });
    assert.deepEqual(f.stops, ['AUDITION_OUTPUT_CAP_UNCONFIRMED']);
  });
}

test('audio before response cap ACK fails closed without a default cancel', async () => {
  const f = fixture();
  f.ready();
  f.source(1);
  f.send(f.request(1));
  f.inbound({
    type: 'response.output_audio.delta',
    response_id: 'response_1',
    delta: 'AAAA',
  });
  await f.transport.closed;
  assert.equal(
    f.raw.sent.some((event) => event.type === 'response.cancel'),
    false,
  );
  assert.deepEqual(f.stops, ['AUDITION_AUDIO_BEFORE_CAP_ACK']);
});

test('exact 24 second PCM input is accepted; the next sample is rejected before sending', async () => {
  const f = fixture();
  f.ready();
  f.send({
    type: 'input_audio_buffer.append',
    audio: Buffer.alloc(1152000).toString('base64'),
  });
  f.send({
    type: 'input_audio_buffer.append',
    audio: Buffer.alloc(2).toString('base64'),
  });
  await f.transport.closed;
  assert.equal(f.transport.snapshot().appendBytes, 1152000);
  assert.equal(
    f.raw.sent.filter((event) => event.type === 'input_audio_buffer.append')
      .length,
    1,
  );
  assert.deepEqual(f.stops, ['AUDITION_INPUT_LIMIT']);
});

test('six sources and responses pass; seventh request cannot create a response', async () => {
  const f = fixture();
  f.ready();
  for (let n = 1; n <= 6; n += 1) {
    const audio = f.source(n);
    f.send(f.request(n, audio));
    f.created(n);
    f.done(n);
  }
  f.send(f.request(7));
  await f.transport.closed;
  const snapshot = f.transport.snapshot();
  assert.equal(snapshot.responses, 6);
  assert.equal(snapshot.commits, 6);
  assert.equal(snapshot.inlineBytes, 6 * 4800);
  assert.deepEqual(f.stops, ['AUDITION_RESPONSE_LIMIT']);
  assert.equal(
    f.raw.sent.filter((event) => event.type === 'response.create').length,
    6,
  );
});

test('seventh commit is rejected and cannot be retried by a duplicate event', async () => {
  const f = fixture();
  f.ready();
  for (let n = 1; n <= 6; n += 1) f.source(n);
  f.send({ type: 'input_audio_buffer.commit' });
  f.send({ type: 'input_audio_buffer.commit' });
  await f.transport.closed;
  assert.equal(f.transport.snapshot().commits, 6);
  assert.deepEqual(f.stops, ['AUDITION_COMMIT_LIMIT']);
});

test('inline audio must match its source commit; prior audio/references cannot be reused', async () => {
  const f = fixture();
  f.ready();
  f.source(1);
  f.send(f.request(1, Buffer.alloc(4800, 2)));
  await f.transport.closed;
  assert.equal(f.transport.snapshot().inlineBytes, 0);
  assert.equal(f.transport.snapshot().responses, 0);
  assert.deepEqual(f.stops, ['AUDITION_AUDIO_BINDING_MISMATCH']);
});

test('default conversation/history input, and oversized actual context, fail without truncation', async () => {
  const f = fixture();
  f.ready();
  f.source(1);
  const request = f.request(1);
  request.response.conversation = 'auto';
  f.send(request);
  await f.transport.closed;
  assert.deepEqual(f.stops, ['AUDITION_RESPONSE_INPUT_MISMATCH']);
  const g = fixture();
  g.ready();
  g.source(1);
  const oversized = g.request(1);
  oversized.response.input[0].content[0].text = JSON.stringify({
    current_asr_observation: '你好。',
    recent_raw_call_context: [{ role: 'local', text: '中'.repeat(1000) }],
  });
  g.send(oversized);
  await g.transport.closed;
  assert.deepEqual(g.stops, ['AUDITION_TEXT_LIMIT']);
});

test('ASR-before-commit ACK is reordered safely, deduplicated by source and counted once', async () => {
  const f = fixture();
  f.ready();
  f.send({
    type: 'input_audio_buffer.append',
    audio: Buffer.alloc(4800, 1).toString('base64'),
  });
  f.send({ type: 'input_audio_buffer.commit' });
  f.asr(1);
  f.inbound({ type: 'input_audio_buffer.committed', item_id: 'source_1' });
  f.asr(1);
  f.asr(1);
  f.send(f.request(1));
  f.created(1);
  f.done(1);
  f.done(1);
  await f.transport.closeSuccess();
  assert.equal(f.transport.snapshot().usage.length, 2);
  const types = f.forwarded.map((event) => event.type);
  assert.ok(
    types.indexOf('input_audio_buffer.committed') <
      types.indexOf('conversation.item.input_audio_transcription.completed'),
  );
  assert.equal(types.filter((type) => type === 'response.done').length, 1);
});

test('empty ASR source is retired; later source response retains its original sourceSequence', async () => {
  const f = fixture();
  f.ready();
  f.source(1, Buffer.alloc(4800, 1), '');
  f.send({ type: 'conversation.item.delete', item_id: 'source_1' });
  const audio = f.source(2);
  f.send(f.request(2, audio));
  f.created(2);
  f.done(2);
  await f.transport.closeSuccess();
  assert.equal(f.transport.snapshot().requestAccounting[0].sourceSequence, 2);
  assert.equal(f.transport.snapshot().requestAccounting[0].request, 1);
});

test('stop fences synchronous onStop reentrancy but preserves independent raw cancel usage', async () => {
  const f = fixture();
  f.ready();
  f.source(1);
  f.send(f.request(1));
  f.created(1);
  const promise = f.transport.stop('AUDITION_MANUAL_STOP');
  f.socket.removeAllListeners();
  f.socket.terminate();
  f.send(f.request(2));
  f.done(1, 'cancelled');
  f.done(1, 'cancelled');
  await promise;
  assert.equal(f.transport.snapshot().usage.length, 2);
  assert.equal(f.transport.snapshot().cancellations.length, 1);
  assert.equal(f.transport.snapshot().cancellations[0].terminal, true);
  assert.equal(
    f.raw.sent.filter((event) => event.type === 'response.create').length,
    1,
  );
});

test('late created after stop receives exactly one targeted cancel, never a new request', async () => {
  const f = fixture();
  f.ready();
  f.source(1);
  f.send(f.request(1));
  const promise = f.transport.stop('AUDITION_MANUAL_STOP');
  f.created(1);
  f.created(1);
  f.done(1, 'cancelled');
  await promise;
  assert.equal(
    f.raw.sent.filter((event) => event.type === 'response.cancel').length,
    1,
  );
  assert.equal(f.transport.snapshot().cancellations[0].terminal, true);
  assert.equal(f.transport.snapshot().responses, 1);
});

test('provider rejection, synchronous send failure, ready/progress/wall timeout never retry', async () => {
  const f = fixture();
  f.ready();
  f.inbound({
    type: 'error',
    error: { message: 'secret', code: 'unsupported_max_output_tokens' },
  });
  await f.transport.closed;
  assert.deepEqual(f.stops, ['AUDITION_PROVIDER_REJECTED']);
  assert.equal(f.factories(), 1);
  const g = fixture();
  g.raw.readyState = WebSocket.OPEN;
  g.raw.failSend = true;
  g.send({ type: 'session.update', session: session() });
  await g.transport.closed;
  assert.deepEqual(g.stops, ['AUDITION_SEND_FAILED']);
  const h = fixture({ readyTimeoutMs: 5 });
  await h.transport.closed;
  assert.deepEqual(h.stops, ['AUDITION_READY_TIMEOUT']);
  const i = fixture({ progressTimeoutMs: 5 });
  i.ready();
  i.source(1);
  await i.transport.closed;
  assert.deepEqual(i.stops, ['AUDITION_PROGRESS_TIMEOUT']);
  const j = fixture({ wallTimeoutMs: 5 });
  j.ready();
  await j.transport.closed;
  assert.deepEqual(j.stops, ['AUDITION_WALL_TIMEOUT']);
});

test('cancelled/incomplete terminals collect usage, halt remaining requests, and never retry', async () => {
  await Promise.all(
    ['cancelled', 'incomplete', 'failed'].map(async (status) => {
      const f = fixture();
      f.ready();
      f.source(1);
      f.send(f.request(1));
      f.created(1);
      f.done(1, status);
      f.send(f.request(2));
      await f.transport.closed;
      assert.deepEqual(f.stops, ['AUDITION_RESPONSE_NOT_COMPLETED']);
      assert.equal(f.transport.snapshot().usage.length, 2);
      assert.equal(f.transport.snapshot().responses, 1);
      assert.equal(f.factories(), 1);
    }),
  );
});

test('extra socket/model/session update rejected; transport cannot silently reconnect', async () => {
  const f = fixture();
  f.ready();
  assert.throws(
    () =>
      f.transport.createWebSocket(
        'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1',
        {},
      ),
    /AUDITION_CONNECTION_LIMIT/,
  );
  await f.transport.closed;
  assert.equal(f.factories(), 1);
  const g = fixture();
  g.ready();
  g.send({ type: 'session.update', session: session() });
  await g.transport.closed;
  assert.deepEqual(g.stops, ['AUDITION_EXTRA_SESSION_UPDATE']);
  let calls = 0;
  const transport = createAuditionTransport({
    createWebSocket: () => {
      calls += 1;
      throw new Error('unused');
    },
  });
  assert.throws(
    () =>
      transport.createWebSocket(
        'wss://api.openai.com/v1/realtime?model=other',
        {},
      ),
    /AUDITION_MODEL_ENDPOINT_MISMATCH/,
  );
  await transport.closed;
  assert.equal(calls, 0);
});

test('missing usage stays unknown, cleanup throw settles without claiming socket closed', async () => {
  const f = fixture();
  f.ready();
  f.source(1);
  f.send(f.request(1));
  f.created(1);
  f.inbound({
    type: 'response.done',
    response: { id: 'response_1', status: 'completed' },
  });
  f.raw.throwTerminate = true;
  await f.transport.closeSuccess();
  assert.equal(f.transport.snapshot().unknownUsage, true);
  assert.equal(f.transport.snapshot().allClosed, false);
  assert.equal(f.transport.snapshot().usage[1].basis, 'unknown');
});

test('parent terminate while ASR is pending is an error and still collects late usage', async () => {
  const f = fixture();
  f.ready();
  f.send({
    type: 'input_audio_buffer.append',
    audio: Buffer.alloc(4800, 1).toString('base64'),
  });
  f.send({ type: 'input_audio_buffer.commit' });
  f.inbound({ type: 'input_audio_buffer.committed', item_id: 'source_1' });
  f.socket.terminate();
  assert.equal(f.transport.snapshot().state, 'stopping');
  f.asr(1);
  await f.transport.closed;
  assert.deepEqual(f.stops, ['AUDITION_PARENT_TERMINATED']);
  assert.equal(f.transport.snapshot().usage.length, 1);
  assert.equal(f.transport.snapshot().responses, 0);
  assert.equal(f.transport.snapshot().unknownUsage, false);
});

test('parent terminate after known completed work is clean; uncommitted audio is not', async () => {
  const f = fixture();
  f.ready();
  f.source(1);
  f.send(f.request(1));
  f.created(1);
  f.done(1);
  f.socket.terminate();
  await f.transport.closed;
  assert.equal(f.transport.snapshot().reason, 'AUDITION_COMPLETE');
  assert.deepEqual(f.stops, []);
  const g = fixture();
  g.ready();
  g.send({
    type: 'input_audio_buffer.append',
    audio: Buffer.alloc(4800).toString('base64'),
  });
  g.socket.terminate();
  await g.transport.closed;
  assert.equal(g.transport.snapshot().reason, 'AUDITION_PARENT_TERMINATED');
});

test('stop before late ASR fences subscriber-generated response requests', async () => {
  const f = fixture();
  f.ready();
  f.send({
    type: 'input_audio_buffer.append',
    audio: Buffer.alloc(4800, 1).toString('base64'),
  });
  f.send({ type: 'input_audio_buffer.commit' });
  f.inbound({ type: 'input_audio_buffer.committed', item_id: 'source_1' });
  f.socket.on('message', (value) => {
    if (
      JSON.parse(value.toString()).type ===
      'conversation.item.input_audio_transcription.completed'
    )
      f.send(f.request(1));
  });
  const result = f.transport.stop('AUDITION_MANUAL_STOP');
  f.asr(1);
  f.asr(1);
  await result;
  assert.equal(f.transport.snapshot().usage.length, 1);
  assert.equal(f.transport.snapshot().responses, 0);
  assert.equal(
    f.raw.sent.some((event) => event.type === 'response.create'),
    false,
  );
});

test('synchronous cancel terminal and throwing onStop do not duplicate cleanup or generation', async () => {
  const f = fixture({
    onStop: () => {
      throw new Error('private error');
    },
  });
  f.ready();
  f.source(1);
  f.send(f.request(1));
  f.created(1);
  f.raw.onSend = (event) => {
    if (event.type === 'response.cancel') f.done(1, 'cancelled');
  };
  await f.transport.stop('AUDITION_MANUAL_STOP');
  await f.transport.stop('AUDITION_MANUAL_STOP');
  assert.equal(f.transport.snapshot().usage.length, 2);
  assert.equal(f.transport.snapshot().cancellations.length, 1);
  assert.equal(f.transport.snapshot().cancellations[0].terminal, true);
  assert.equal(f.raw.terminated, 1);
});

test('provider output tokens exceeding acknowledged cap halt further requests', async () => {
  const f = fixture();
  f.ready();
  f.source(1);
  f.send(f.request(1));
  f.created(1);
  f.inbound({
    type: 'response.done',
    response: {
      id: 'response_1',
      status: 'completed',
      usage: { output_tokens: 513 },
    },
  });
  await f.transport.closed;
  assert.deepEqual(f.stops, ['AUDITION_OUTPUT_CAP_VIOLATED']);
  assert.equal(f.transport.snapshot().usage[1].outputTokens, 513);
  assert.equal(f.transport.snapshot().responses, 1);
});

test('transcription duration usage remains separate from token usage and missing terminal is unknown', async () => {
  const f = fixture();
  f.ready();
  f.send({
    type: 'input_audio_buffer.append',
    audio: Buffer.alloc(4800, 1).toString('base64'),
  });
  f.send({ type: 'input_audio_buffer.commit' });
  f.inbound({ type: 'input_audio_buffer.committed', item_id: 'source_1' });
  f.inbound({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'source_1',
    content_index: 0,
    transcript: '你好。',
    usage: { type: 'duration', seconds: 0.1 },
  });
  f.send(f.request(1));
  await f.transport.stop('AUDITION_MANUAL_STOP');
  assert.equal(f.transport.snapshot().usage[0].basis, 'duration');
  assert.equal(f.transport.snapshot().usage[0].seconds, 0.1);
  assert.equal(f.transport.snapshot().usage[0].inputTokens, undefined);
  assert.equal(f.transport.snapshot().unknownUsage, true);
  assert.equal(f.transport.snapshot().cancellations.length, 0);
});

test('partial token usage and missing cached split remain unknown, not free', async () => {
  const f = fixture();
  f.ready();
  f.source(1);
  f.send(f.request(1));
  f.created(1);
  f.inbound({
    type: 'response.done',
    response: {
      id: 'response_1',
      status: 'completed',
      usage: { output_tokens: 10 },
    },
  });
  await f.transport.closeSuccess();
  assert.equal(f.transport.snapshot().usage[1].basis, 'tokens');
  assert.equal(f.transport.snapshot().usage[1].inputTokens, undefined);
  assert.equal(f.transport.snapshot().unknownUsage, true);
});

test('second session.created event cannot admit another logical session', async () => {
  const f = fixture();
  f.inbound({ type: 'session.created', session: { id: 'session_1' } });
  f.inbound({ type: 'session.created', session: { id: 'session_2' } });
  await f.transport.closed;
  assert.deepEqual(f.stops, ['AUDITION_EXTRA_SESSION_CREATED']);
  assert.equal(f.factories(), 1);
});

test('cancel terminal waits for other pending ASR usage within the bounded drain', async () => {
  const f = fixture({ cleanupTimeoutMs: 100 });
  f.ready();
  f.source(1);
  f.send(f.request(1));
  f.created(1);
  f.send({
    type: 'input_audio_buffer.append',
    audio: Buffer.alloc(4800, 2).toString('base64'),
  });
  f.send({ type: 'input_audio_buffer.commit' });
  f.inbound({ type: 'input_audio_buffer.committed', item_id: 'source_2' });
  const result = f.transport.stop('AUDITION_MANUAL_STOP');
  f.done(1, 'cancelled');
  assert.equal(f.transport.snapshot().state, 'stopping');
  assert.equal(f.transport.snapshot().unknownUsage, true);
  assert.equal(f.raw.terminated, 0);
  f.asr(2);
  await result;
  assert.equal(f.transport.snapshot().state, 'closed');
  assert.equal(f.transport.snapshot().usage.length, 3);
  assert.equal(f.transport.snapshot().unknownUsage, false);
  assert.equal(f.transport.snapshot().responses, 1);
  assert.equal(f.raw.terminated, 1);
});
