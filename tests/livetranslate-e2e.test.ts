import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';

import { createLiveTranslateClient } from '../src/experiments/livetranslate-client';
import { runLiveTranslateAudition } from '../src/experiments/livetranslate-audition-runner';
import {
  reserveLiveTranslateAuditionOutput,
  writeLiveTranslateAuditionArtifacts,
} from '../src/experiments/livetranslate-audition-artifacts';
import type { PreparedLiveTranslateAuditionInput } from '../src/experiments/livetranslate-audition-input';
import type {
  LiveTranslateClientOptions,
  LiveTranslateRole,
} from '../src/experiments/livetranslate-types';

const MODEL = 'qwen3.8-livetranslate-flash-realtime';
const HOST = 'offline-workspace.cn-beijing.maas.aliyuncs.com';
const pcm = (sample: number) => Buffer.from([sample, 0]);
/** Protocol peer only. No network socket, microphone or model is created. */
class Wire extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  sent: any[] = [];

  closed = 0;

  onFinish?: () => void;

  private sequence = 0;

  constructor(readonly role: LiveTranslateRole) {
    super();
  }

  session() {
    return {
      id: `session_${this.role}`,
      model: MODEL,
      output_modalities: this.role === 'local' ? ['text', 'audio'] : ['text'],
      enable_voice_clone: false,
      audio: {
        input: {
          format: { type: 'pcm', sample_rate: 16000 },
          turn_detection: { type: 'speaker_detection', threshold: 0.5 },
        },
        output: {
          format: { type: 'pcm', sample_rate: 24000 },
          voice: 'Aiden',
        },
      },
      translation: { language: this.role === 'local' ? 'en' : 'zh' },
    };
  }

  receive(event: Record<string, unknown>) {
    this.sequence += 1;
    this.emit(
      'message',
      Buffer.from(
        JSON.stringify({ event_id: `event_${this.sequence}`, ...event }),
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
    if (event.type === 'session.finish')
      queueMicrotask(() => this.onFinish?.());
  }

  close() {
    this.closed += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1000, Buffer.from('private fake close reason'));
  }

  terminate() {
    this.close();
  }

  source(id: string, text: string) {
    this.receive({
      type: 'input_audio_buffer.speech_started',
      item_id: id,
      audio_start_ms: 0,
      speaker_id: 1,
    });
    this.receive({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: id,
      content_index: 0,
      delta: text.slice(0, 2),
    });
    this.receive({
      type: 'input_audio_buffer.speech_stopped',
      item_id: id,
      audio_end_ms: 100,
    });
    this.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: id,
      content_index: 0,
      transcript: text,
    });
  }

  response(id: string, translationId: string, sourceId: string) {
    this.receive({
      type: 'response.created',
      response: { id, status: 'in_progress' },
    });
    this.receive({
      type: 'conversation.item.created',
      previous_item_id: sourceId,
      item: { id: translationId, role: 'assistant', content: [] },
    });
  }

  output(
    type: string,
    responseId: string,
    translationId: string,
    value: Record<string, unknown> = {},
  ) {
    this.receive({
      type,
      response_id: responseId,
      item_id: translationId,
      output_index: 0,
      content_index: 0,
      ...value,
    });
  }

  text(responseId: string, translationId: string, text: string, final = false) {
    const kind = this.role === 'local' ? 'audio_transcript' : 'text';
    this.output(
      `response.${kind}.${final ? 'done' : 'delta'}`,
      responseId,
      translationId,
      final
        ? { [this.role === 'local' ? 'transcript' : 'text']: text }
        : { delta: text },
    );
  }

  audio(
    responseId: string,
    translationId: string,
    sample: number,
    eventId?: string,
  ) {
    this.output('response.audio.delta', responseId, translationId, {
      delta: pcm(sample).toString('base64'),
      ...(eventId ? { event_id: eventId } : {}),
    });
  }

  done(responseId: string, translationId: string, text: string) {
    const audioTokens = this.role === 'local' ? 12 : 0;
    this.receive({
      type: 'response.done',
      response: {
        id: responseId,
        status: 'completed',
        output: [
          {
            id: translationId,
            role: 'assistant',
            content: [
              this.role === 'local'
                ? { type: 'audio', transcript: text }
                : { type: 'text', text },
            ],
          },
        ],
        usage: {
          input_tokens: 7,
          output_tokens: 3 + audioTokens,
          total_tokens: 10 + audioTokens,
          input_tokens_details: { audio_tokens: 7, text_tokens: 0 },
          output_tokens_details: { audio_tokens: audioTokens, text_tokens: 3 },
        },
      },
    });
  }
}

function realFactory(wires: Wire[], configure?: (wire: Wire) => void) {
  return (options: LiveTranslateClientOptions) => {
    const wire = new Wire(options.role);
    wires.push(wire);
    configure?.(wire);
    const client = createLiveTranslateClient({
      ...options,
      createWebSocket(address) {
        assert.equal(
          address,
          `wss://${HOST}/api-ws/v1/realtime?model=${MODEL}`,
        );
        return wire as unknown as WebSocket;
      },
    });
    queueMicrotask(() =>
      wire.receive({ type: 'session.created', session: wire.session() }),
    );
    return client;
  };
}

test('real audition runner and protocol client consume two synthetic PCM clips, retain final timing and usage without playback claims', async () => {
  const wires: Wire[] = [];
  let now = 0;
  const clips = (['local', 'remote'] as const).map((role, index) => {
    const input = Buffer.alloc(6400, index + 1);
    return {
      id: role,
      role,
      pcm: input,
      durationMs: 200,
      speechEndMs: 100,
      sha256: createHash('sha256').update(input).digest('hex'),
      wavPath: `synthetic-${role}.wav`,
    };
  });
  const input: PreparedLiveTranslateAuditionInput = {
    manifestPath: 'synthetic-offline-only.json',
    manifestSha256: 'a'.repeat(64),
    workspaceId: 'offline-workspace',
    spaceHost: HOST,
    clips,
    totalSeconds: 0.4,
  };
  const result = await runLiveTranslateAudition({
    input,
    apiKey: 'offline-fake-not-a-credential',
    now: () => now,
    delay: async (ms) => {
      now += ms;
    },
    clientFactory: realFactory(wires, (wire) => {
      wire.onFinish = () => {
        now += 30;
        wire.source(
          'audition_source',
          wire.role === 'local' ? '费用不是五十元。' : 'Do not cancel.',
        );
        now += 20;
        wire.response(
          'audition_response',
          'audition_translated',
          'audition_source',
        );
        wire.text(
          'audition_response',
          'audition_translated',
          wire.role === 'local' ? 'The fee' : '不要',
        );
        if (wire.role === 'local') {
          now += 40;
          wire.audio('audition_response', 'audition_translated', 7);
          wire.output(
            'response.audio.done',
            'audition_response',
            'audition_translated',
          );
        }
        now += 20;
        const text =
          wire.role === 'local' ? 'The fee is not fifty yuan.' : '不要取消。';
        wire.text('audition_response', 'audition_translated', text, true);
        now += 10;
        wire.done('audition_response', 'audition_translated', text);
        wire.receive({ type: 'session.finished' });
      };
    }),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.counters.sessions, 2);
  assert.equal(result.confirmedSessions.length, 2);
  assert.equal(result.observedSessionConfigurations.length, 2);
  assert(result.confirmedSessions.every((session) =>
    session.voice === 'Aiden' &&
    session.voiceCloneEnabled === false &&
    session.configurationAcknowledgement.basis === 'provider_session_updated',
  ));
  assert.equal(result.counters.observedResponses, 2);
  assert.equal(result.counters.acceptedResponses, 2);
  assert.equal(result.counters.inputBytesSent, 12800);
  assert.equal(result.audio.length, 1);
  assert.deepEqual(result.audio[0].pcm, pcm(7));
  assert.equal(result.audio[0].firstPcmAt, 290);
  assert.equal(result.audio[0].firstPcmBasis, 'client_receive_timing');
  assert.equal(result.audio[0].clientFifoWaitMs, 0);
  assert.equal(result.audio[0].responseDoneAt, 320);
  assert.equal(result.audio[0].annotatedSpeechEndToFirstPcmMs, 190);
  assert.equal(result.audio[0].actualPlaybackStartedAt, null);
  assert.equal(result.audio[0].playbackQueueWaitMs, null);
  assert.equal(result.audio[0].queueMeasurement, 'not_attached_to_playback');
  const completed = result.timing.filter(
    (event) => event.stage === 'translation_completed',
  );
  assert.deepEqual(
    completed.map((event) => [event.role, event.at]),
    [
      ['local', 310],
      ['remote', 590],
    ],
  );
  assert.equal(result.usage.length, 2);
  assert.equal(result.usage[0].inputAudioTokens, 7);
  assert.equal(result.usage[0].outputAudioTokens, 12);
  assert.equal(result.usage[1].outputAudioTokens, 0);
  assert.equal(result.usage[1].outputTextTokens, 3);
  assert(result.usage.every((event) => event.basis === 'provider_reported'));
  assert.deepEqual(
    result.translations
      .filter((event) => event.final)
      .map((event) => [event.role, event.text, event.pairing]),
    [
      ['local', 'The fee is not fifty yuan.', 'explicit'],
      ['remote', '不要取消。', 'explicit'],
    ],
  );
  assert.equal(wires.length, 2);
  assert.deepEqual(
    wires.map((wire) => wire.role),
    ['local', 'remote'],
  );
  assert.deepEqual(
    wires.map((wire) => wire.sent[0].session.output_modalities),
    [['text', 'audio'], ['text']],
  );
  wires.forEach((wire, index) => {
    assert.equal(wire.sent[0].session.voice, 'Aiden');
    assert.equal(wire.sent[0].session.enable_voice_clone, false);
    assert(
      wire.sent.every((event) =>
        [
          'session.update',
          'input_audio_buffer.append',
          'session.finish',
        ].includes(event.type),
      ),
    );
    assert.equal(
      wire.sent.filter((event) => event.type === 'session.finish').length,
      1,
    );
    const sentPcm = Buffer.concat(
      wire.sent
        .filter((event) => event.type === 'input_audio_buffer.append')
        .map((event) => Buffer.from(event.audio, 'base64')),
    );
    assert.deepEqual(sentPcm, clips[index].pcm);
  });
  assert(wires.every((wire) => wire.closed === 1));
  assert.equal(result.configuration.providerOutputTokenLimit, null);
  assert.equal(result.configuration.providerCancelSupported, false);
});

test('single-local real protocol runner never sends recording on an unconfirmed or incompatible Aiden configuration', async () => {
  const sample = Buffer.alloc(3200, 1);
  const input: PreparedLiveTranslateAuditionInput = {
    mode: 'single-local',
    manifestPath: 'synthetic-offline-only.json',
    manifestSha256: 'a'.repeat(64),
    workspaceId: 'offline-workspace',
    spaceHost: HOST,
    clips: [{
      id: 'local', role: 'local', pcm: sample, durationMs: 100,
      sha256: createHash('sha256').update(sample).digest('hex'),
      wavPath: 'synthetic-local.wav',
    }],
    totalSeconds: 0.1,
  };
  const cases = [
    { voice: 'Tina', patch: (session: any) => ({ ...session, audio: { ...session.audio, output: { ...session.audio.output, voice: 'Tina' } } }) },
    { voice: null, patch: (session: any) => ({ ...session, audio: { ...session.audio, output: { ...session.audio.output, voice: undefined } } }) },
    { voice: 'Aiden', patch: (session: any) => ({ ...session, enable_voice_clone: undefined }) },
    { voice: 'Aiden', patch: (session: any) => ({ ...session, enable_voice_clone: true }) },
    { voice: 'Aiden', patch: (session: any) => ({ ...session, translation: { language: 'zh' } }) },
  ];
  for (const item of cases) {
    const wires: Wire[] = [];
    // eslint-disable-next-line no-await-in-loop -- Every rejection has exactly one isolated fake protocol session.
    const result = await runLiveTranslateAudition({
      input,
      apiKey: 'offline-fake-not-a-credential',
      delay: async () => { assert.fail('No recording frame may be sent'); },
      clientFactory: realFactory(wires, (wire) => {
        const session = wire.session.bind(wire);
        wire.session = () => item.patch(session());
      }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'LIVETRANSLATE_CONFIGURATION_REJECTED');
    assert.equal(result.counters.sessions, 1);
    assert.equal(result.counters.inputBytesSent, 0);
    assert.equal(result.confirmedSessions.length, 0);
    assert.equal(result.observedSessionConfigurations.length, 1);
    assert.equal(result.observedSessionConfigurations[0].accepted, false);
    assert.equal(result.observedSessionConfigurations[0].voice, item.voice);
    assert.equal(wires.length, 1);
    assert.equal(wires[0].sent.length, 1);
    assert.equal(wires[0].sent[0].session.voice, 'Aiden');
    assert.equal(wires[0].closed, 1);
  }
});

test('real client response FIFO cannot turn delayed artifact delivery into model first-PCM or lose an earlier completed response', async (t) => {
  const wires: Wire[] = [];
  let now = 0;
  const clips = (['local', 'remote'] as const).map((role, index) => {
    const input = Buffer.alloc(6400, index + 1);
    return {
      id: role,
      role,
      pcm: input,
      durationMs: 200,
      speechEndMs: 100,
      sha256: createHash('sha256').update(input).digest('hex'),
      wavPath: `synthetic-${role}.wav`,
    };
  });
  const input: PreparedLiveTranslateAuditionInput = {
    manifestPath: 'synthetic-offline-fifo.json',
    manifestSha256: 'b'.repeat(64),
    workspaceId: 'offline-workspace',
    spaceHost: HOST,
    clips,
    totalSeconds: 0.4,
  };
  const result = await runLiveTranslateAudition({
    input,
    apiKey: 'offline-fake-not-a-credential',
    now: () => now,
    delay: async (ms) => {
      now += ms;
    },
    clientFactory: realFactory(wires, (wire) => {
      wire.onFinish = () => {
        const origin = now;
        if (wire.role === 'remote') {
          wire.source('remote_source', 'Do not replay.');
          wire.response(
            'remote_response',
            'remote_translated',
            'remote_source',
          );
          wire.text('remote_response', 'remote_translated', '不要重播。', true);
          wire.done('remote_response', 'remote_translated', '不要重播。');
          wire.receive({ type: 'session.finished' });
          return;
        }
        wire.source('source_first', '第一句。');
        wire.source('source_second', '第二句。');
        wire.response('response_first', 'translated_first', 'source_first');
        wire.response('response_second', 'translated_second', 'source_second');
        now = origin + 10;
        wire.text('response_first', 'translated_first', 'First sentence.');
        wire.audio('response_first', 'translated_first', 1);
        now = origin + 20;
        wire.text('response_second', 'translated_second', 'Second sentence.');
        wire.audio('response_second', 'translated_second', 2);
        wire.output(
          'response.audio.done',
          'response_second',
          'translated_second',
        );
        now = origin + 25;
        wire.text(
          'response_second',
          'translated_second',
          'Second sentence.',
          true,
        );
        now = origin + 30;
        wire.done('response_second', 'translated_second', 'Second sentence.');
        // The second response is fully received but cannot be delivered until
        // the first response relinquishes the real client's audio FIFO.
        now = origin + 50;
        wire.text(
          'response_first',
          'translated_first',
          'First sentence.',
          true,
        );
        wire.output(
          'response.audio.done',
          'response_first',
          'translated_first',
        );
        wire.done('response_first', 'translated_first', 'First sentence.');
        now = origin + 60;
        wire.receive({ type: 'session.finished' });
      };
    }),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.counters.sessions, 2);
  assert.equal(result.counters.observedResponses, 3);
  assert.equal(result.usage.length, 3);
  assert.deepEqual(
    result.audio.map((audio) => audio.metadata.responseId),
    ['response_first', 'response_second'],
  );
  assert.deepEqual(
    result.audio.map((audio) => audio.pcm),
    [pcm(1), pcm(2)],
  );
  const second = result.audio[1];
  assert.equal(second.firstPcmAt, 220);
  assert.equal(second.firstPcmBasis, 'client_receive_timing');
  assert.equal(second.collectedQueueAt, 250);
  assert.equal(second.clientFifoWaitMs, 30);
  assert.equal(second.responseDoneAt, 230);
  assert.equal(second.annotatedSpeechEndToFirstPcmMs, 120);
  assert.equal(second.actualPlaybackStartedAt, null);
  assert.equal(second.playbackQueueWaitMs, null);
  const outputRoot = mkdtempSync(join(tmpdir(), 'livet-e2e-fifo-'));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));
  const reservation = reserveLiveTranslateAuditionOutput(
    join(outputRoot, 'private-output'),
  );
  writeLiveTranslateAuditionArtifacts(input, result, reservation);
  const report = JSON.parse(
    readFileSync(join(reservation.output, 'report.json'), 'utf8'),
  );
  const recorded = report.audio.find(
    (audio: any) => audio.metadata.responseId === 'response_second',
  );
  assert.equal(recorded.firstPcmAt, 220);
  assert.equal(recorded.collectedQueueAt, 250);
  assert.equal(recorded.clientFifoWaitMs, 30);
  assert.equal(recorded.fullTranslationDoneAt, 225);
  assert.equal(recorded.responseDoneAt, 230);
  assert.equal(recorded.providerEndToFirstPcmMs, 120);
  assert.equal(recorded.actualPlaybackStartedAt, null);
  assert.equal(report.costs.actualPlatformBilledCny, null);
  assert(wires.every((wire) => wire.closed === 1));
});
