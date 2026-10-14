import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import WebSocket from 'ws';

import type { PreparedAuditionInput } from '../src/experiments/realtime-audition-input';
import {
  AUDITION_PARENT_CANDIDATE,
  runRealtimeAudition,
  validateAuditionApproval,
  type AuditionApproval,
} from '../src/experiments/realtime-audition-runner';
import { RealtimePrototypeInput } from '../src/solo/realtime-prototype-input';

const INPUT_HASH = 'a'.repeat(64);
function input(seconds = 4): PreparedAuditionInput {
  const pcm = Buffer.alloc(seconds * 48000);
  for (let index = 0; index < pcm.length; index += 2)
    pcm.writeInt16LE(1000, index);
  const slicer = new RealtimePrototypeInput();
  const events = [];
  for (let offset = 0; offset < pcm.length; offset += 480)
    events.push(...slicer.append(pcm.subarray(offset, offset + 480)));
  events.push(...slicer.flush());
  const sources = events
    .filter((event) => event.type === 'commit')
    .map((event) => ({
      sequence: event.sourceSequence,
      startSample: event.startAtMs * 24,
      endSample: event.endAtMs * 24,
      pcmBytes: event.inputMs * 48,
    }));
  return {
    manifestPath: '/offline-fixture.json',
    wavPath: '/offline-fixture.wav',
    wavSha256: INPUT_HASH,
    pcm,
    sampleRate: 24000,
    segments: [{ id: 'test', sourceText: 'REFERENCE_CANARY_DO_NOT_SEND', pcm }],
    totalSamples: pcm.length / 2,
    totalSeconds: seconds,
    preflightCommits: sources.length,
    preflightSources: sources,
    preflightCommitSamples: sources.map((entry) => entry.pcmBytes / 2),
    preflightSubmittedSamples: pcm.length / 2,
  };
}
const authorization: AuditionApproval = {
  version: 1,
  parentCandidate: AUDITION_PARENT_CANDIDATE,
  approvedUsd: 1,
  approvalReference: 'OFFLINE FAKE approval only',
  sampleUseReference: 'SYNTHETIC test fixture',
  sampleSha256: INPUT_HASH,
};
class Socket extends EventEmitter {
  readyState = WebSocket.CONNECTING as number;

  bufferedAmount = 0;

  sent: any[] = [];

  terminated = 0;

  onSend: (event: any) => void = () => {};

  send(value: string, callback?: (error?: Error) => void) {
    const event = JSON.parse(value);
    this.sent.push(event);
    callback?.();
    queueMicrotask(() => this.onSend(event));
  }

  terminate() {
    this.terminated += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}
function fixture(
  behavior:
    | 'complete'
    | 'cap'
    | 'error'
    | 'stall'
    | 'oversize'
    | 'invalid-terminal' = 'complete',
) {
  const socket = new Socket();
  let sequence = 0;
  let events = 0;
  let connections = 0;
  const inbound = (event: any) => {
    events += 1;
    return socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          event_id: `event_${events}`,
          ...event,
        }),
      ),
    );
  };
  socket.onSend = (event) => {
    if (event.type === 'session.update') {
      inbound({
        type: 'session.updated',
        session: {
          ...event.session,
          model: 'gpt-realtime-2.1',
          max_output_tokens: behavior === 'cap' ? 'inf' : 512,
        },
      });
    }
    if (event.type === 'input_audio_buffer.commit') {
      sequence += 1;
      const item = `source_${sequence}`;
      inbound({ type: 'input_audio_buffer.committed', item_id: item });
      const final = {
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: item,
        content_index: 0,
        transcript: `原始识别${sequence}`,
        usage: { type: 'duration', seconds: 4 },
      };
      inbound(final);
      inbound(final);
    }
    if (event.type === 'response.create') {
      const id = `response_${sequence}`;
      inbound({
        type: 'response.created',
        response: {
          id,
          metadata: event.response.metadata,
          max_output_tokens: 512,
        },
      });
      if (behavior === 'stall') return;
      if (behavior === 'error') {
        inbound({
          type: 'error',
          error: { message: 'NEVER_LEAK_PRIVATE_VALUE' },
        });
        return;
      }
      const output = (type: string, extra: any = {}) =>
        inbound({
          type,
          response_id: id,
          item_id: `output_${id}`,
          output_index: 0,
          content_index: 0,
          ...extra,
        });
      const audio = Buffer.alloc(
        behavior === 'oversize' ? 480000 : 480,
        1,
      ).toString('base64');
      output('response.output_audio.delta', { delta: audio });
      if (behavior === 'oversize') {
        output('response.output_audio.delta', { delta: audio });
        output('response.output_audio.delta', { delta: audio });
        output('response.output_audio.delta', { delta: audio });
      }
      output('response.output_audio.done');
      output('response.output_audio_transcript.done', {
        transcript: 'A faithful translation.',
      });
      const terminal = {
        type: 'response.done',
        response: {
          id,
          status: 'completed',
          output:
            behavior === 'invalid-terminal'
              ? []
              : [
                  {
                    id: `output_${id}`,
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [
                      {
                        type: 'output_audio',
                        transcript: 'A faithful translation.',
                      },
                    ],
                  },
                ],
          usage: {
            input_tokens: 20,
            output_tokens: 10,
            total_tokens: 30,
            input_token_details: {
              audio_tokens: 10,
              text_tokens: 10,
              cached_tokens: 0,
            },
            output_token_details: { audio_tokens: 8, text_tokens: 2 },
          },
        },
      };
      inbound(terminal);
      inbound(terminal);
    }
    if (event.type === 'response.cancel')
      inbound({
        type: 'response.done',
        response: {
          id: event.response_id,
          status: 'cancelled',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
  };
  const run = (
    overrides: Partial<Parameters<typeof runRealtimeAudition>[0]> = {},
  ) =>
    runRealtimeAudition({
      input: input(),
      authorization,
      apiKey: 'offline-fixture-only',
      createWebSocket() {
        connections += 1;
        queueMicrotask(() => {
          socket.readyState = WebSocket.OPEN;
          socket.emit('open');
        });
        return socket as unknown as WebSocket;
      },
      pace: async () => {
        await Promise.resolve();
      },
      timeouts: {
        readyTimeoutMs: 1000,
        progressTimeoutMs: 1000,
        wallTimeoutMs: 2000,
        cleanupTimeoutMs: 5,
      },
      ...overrides,
    });
  return { run, socket, inbound, connections: () => connections };
}

test('one-shot integrated parent+guard: 24 seconds, 6 responses/ASR, fixed caps and no reference injection', async () => {
  const f = fixture();
  const result = await f.run({ input: input(24) });
  assert.equal(result.status, 'completed');
  assert.equal(result.counts.connections, 1);
  assert.equal(result.counts.asrCommits, 6);
  assert.equal(result.counts.responsesRequested, 6);
  assert.equal(result.responses.length, 6);
  assert.equal(result.usage.length, 12);
  assert.equal(result.counts.inputSamples, 24 * 24000);
  assert.ok(result.accounting.allClosed);
  assert.ok(result.accounting.sessionCapConfirmed);
  assert.equal(result.accounting.responseCapConfirmed, 6);
  const requests = f.socket.sent.filter(
    (event) => event.type === 'response.create',
  );
  for (const request of requests) {
    assert.equal(request.response.max_output_tokens, 512);
    assert.equal(request.response.conversation, 'none');
    assert.equal(request.response.audio.output.voice, 'echo');
  }
  assert.ok(
    requests[1].response.input[0].content[0].text.includes('原始识别1'),
  );
  assert.ok(!JSON.stringify(f.socket.sent).includes('REFERENCE_CANARY'));
  assert.ok(
    result.accounting.requestAccounting.every(
      (entry) => entry.priorAudioBytes === 0,
    ),
  );
  assert.equal(result.accounting.inlineBytes, result.accounting.appendBytes);
  assert.equal(result.responses[0].rawAsrText, '原始识别1');
  assert.equal(result.responses[0].translationText, 'A faithful translation.');
  assert.ok(result.timing.sources[0].firstEnergyOutputMs !== undefined);
});

test('unsupported provider cap fails before any audio upload or responses', async () => {
  const f = fixture('cap');
  const result = await f.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.counts.inputBytesFed, 0);
  assert.equal(result.counts.asrCommits, 0);
  assert.equal(f.connections(), 1);
});

test('provider error cancels known response once and late/duplicate events cannot append requests', async () => {
  const f = fixture('error');
  const result = await f.run({ input: input(24) });
  assert.equal(result.status, 'failed');
  assert.equal(result.counts.responsesRequested, 1);
  assert.equal(
    f.socket.sent.filter((event) => event.type === 'response.cancel').length,
    1,
  );
  const count = f.socket.sent.length;
  f.inbound({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'late',
    content_index: 0,
    transcript: 'late',
  });
  await delay(5);
  assert.equal(f.socket.sent.length, count);
  assert.ok(!JSON.stringify(result).includes('NEVER_LEAK_PRIVATE_VALUE'));
});

test('progress timeout terminates one session with no retries/reconnect', async () => {
  const f = fixture('stall');
  const result = await f.run({
    timeouts: {
      readyTimeoutMs: 100,
      progressTimeoutMs: 20,
      wallTimeoutMs: 200,
      cleanupTimeoutMs: 5,
    },
  });
  assert.equal(result.status, 'failed');
  assert.equal(f.connections(), 1);
  assert.equal(result.counts.responsesRequested, 1);
  assert.ok(result.accounting.allClosed);
});

test('explicit cancel stops feed, cancels generation once, and closes', async () => {
  const f = fixture('stall');
  const controller = new AbortController();
  let frames = 0;
  const result = await f.run({
    signal: controller.signal,
    pace: async () => {
      frames += 1;
      if (frames === 401) controller.abort();
    },
    input: input(8),
  });
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'AUDITION_USER_CANCELLED');
  assert.ok(result.counts.inputBytesFed < 8 * 48000);
  assert.ok(result.accounting.allClosed);
  assert.equal(
    f.socket.sent.filter((event) => event.type === 'response.cancel').length,
    1,
  );
});

test('pre-aborted and invalid authorization cannot create any socket', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  const result = await f.run({ signal: controller.signal });
  assert.equal(result.status, 'stopped');
  assert.equal(f.connections(), 0);
  await assert.rejects(
    f.run({ authorization: { ...authorization, approvedUsd: 0 as 1 } }),
    /APPROVAL_REQUIRED/,
  );
  assert.throws(
    () =>
      validateAuditionApproval(
        { ...authorization, sampleSha256: 'b'.repeat(64) },
        input(),
      ),
    /APPROVAL_REQUIRED/,
  );
  assert.equal(f.connections(), 0);
});

test('completed transport terminal with invalid parent content must still fail', async () => {
  const result = await fixture('invalid-terminal').run();
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'PROTOTYPE_RESPONSE_INCOMPLETE');
});

test('36-second capture bound stops without treating it as a billing cap', async () => {
  const f = fixture('oversize');
  const result = await f.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'AUDITION_OUTPUT_LIMIT');
  assert.equal(result.counts.outputBytesSaved, 36 * 48000);
  assert.equal(
    f.socket.sent.filter((event) => event.type === 'response.cancel').length,
    1,
  );
  assert.equal(result.counts.connections, 1);
});
