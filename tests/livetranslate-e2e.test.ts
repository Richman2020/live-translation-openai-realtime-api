import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import WebSocket from 'ws';

import { createLiveTranslateClient } from '../src/experiments/livetranslate-client';
import { runLiveTranslateAudition } from '../src/experiments/livetranslate-audition-runner';
import { describeLiveTranslateProtocolEvidence } from '../src/experiments/livetranslate-protocol-evidence';
import {
  calculateLiveTranslateAuditionCost,
  reserveLiveTranslateAuditionOutput,
  writeLiveTranslateAuditionArtifacts,
} from '../src/experiments/livetranslate-audition-artifacts';
import type { PreparedLiveTranslateAuditionInput } from '../src/experiments/livetranslate-audition-input';
import type {
  LiveTranslateClientOptions,
  LiveTranslateProtocolDiagnostic,
  LiveTranslateRole,
  LiveTranslateSession,
  LiveTranslateSessionConfiguration,
  LiveTranslateVoice,
  LiveTranslateVoiceEvidence,
  LiveTranslateProtocolEvent,
  LiveTranslateAudioMetadata,
  LiveTranslateTiming,
  LiveTranslateUsage,
} from '../src/experiments/livetranslate-types';

const MODEL = 'qwen3.8-livetranslate-flash-realtime';
const HOST = 'offline-workspace.cn-beijing.maas.aliyuncs.com';
const pcm = (sample: number) => Buffer.from([sample, 0]);
/** Protocol peer only. No network socket, microphone or model is created. */
class Wire extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  sent: any[] = [];

  received: any[] = [];

  closed = 0;

  onFinish?: () => void;

  private sequence = 0;

  constructor(
    readonly role: LiveTranslateRole,
    readonly voice: LiveTranslateVoice = 'Aiden',
  ) {
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
          voice: this.voice,
        },
      },
      translation: { language: this.role === 'local' ? 'en' : 'zh' },
    };
  }

  receive(event: Record<string, unknown>) {
    this.sequence += 1;
    const delivered = { event_id: `event_${this.sequence}`, ...event };
    this.received.push(delivered);
    this.emit('message', Buffer.from(JSON.stringify(delivered)), false);
    return delivered;
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

  response(
    id: string,
    translationId: string,
    sourceId: string,
    voice?: unknown,
  ) {
    this.receive({
      type: 'response.created',
      response: {
        id,
        status: 'in_progress',
        output: [],
        ...(voice === undefined ? {} : { voice }),
      },
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

  done(
    responseId: string,
    translationId: string,
    text: string,
    voice?: unknown,
    includeUsage = true,
  ) {
    const audioTokens = this.role === 'local' ? 12 : 0;
    return this.receive({
      type: 'response.done',
      response: {
        id: responseId,
        status: 'completed',
        ...(voice === undefined ? {} : { voice }),
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
        ...(includeUsage
          ? {
              usage: {
                input_tokens: 7,
                output_tokens: 3 + audioTokens,
                total_tokens: 10 + audioTokens,
                input_tokens_details: { audio_tokens: 7, text_tokens: 0 },
                output_tokens_details: {
                  audio_tokens: audioTokens,
                  text_tokens: 3,
                },
              },
            }
          : {}),
      },
    });
  }
}

function realFactory(wires: Wire[], configure?: (wire: Wire) => void) {
  return (options: LiveTranslateClientOptions) => {
    const wire = new Wire(options.role, options.voice);
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
  assert(
    result.confirmedSessions.every(
      (session) =>
        session.voice === 'Aiden' &&
        session.voiceCloneEnabled === false &&
        session.configurationAcknowledgement.basis ===
          'provider_session_updated',
    ),
  );
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

test('single-local runner requests the Andre candidate, permits an authorized missing clone echo with a warning and rejects incompatible configurations', async () => {
  const sample = Buffer.alloc(3200, 1);
  const input: PreparedLiveTranslateAuditionInput = {
    mode: 'single-local',
    manifestPath: 'synthetic-offline-only.json',
    manifestSha256: 'a'.repeat(64),
    workspaceId: 'offline-workspace',
    spaceHost: HOST,
    clips: [
      {
        id: 'local',
        role: 'local',
        pcm: sample,
        durationMs: 100,
        sha256: createHash('sha256').update(sample).digest('hex'),
        wavPath: 'synthetic-local.wav',
      },
    ],
    totalSeconds: 0.1,
  };
  const cases = [
    { voice: 'Andre', success: true, patch: (session: any) => session },
    {
      voice: 'Tina',
      patch: (session: any) => ({
        ...session,
        audio: {
          ...session.audio,
          output: { ...session.audio.output, voice: 'Tina' },
        },
      }),
    },
    {
      voice: 'Aiden',
      patch: (session: any) => ({
        ...session,
        audio: {
          ...session.audio,
          output: { ...session.audio.output, voice: 'Aiden' },
        },
      }),
    },
    {
      voice: null,
      patch: (session: any) => ({
        ...session,
        audio: {
          ...session.audio,
          output: { ...session.audio.output, voice: undefined },
        },
      }),
    },
    {
      voice: 'Andre',
      success: true,
      missingCloneEcho: true,
      patch: (session: any) => ({ ...session, enable_voice_clone: undefined }),
    },
    {
      voice: 'Andre',
      patch: (session: any) => ({ ...session, enable_voice_clone: true }),
    },
    {
      voice: 'Andre',
      patch: (session: any) => ({ ...session, enable_voice_clone: null }),
    },
    {
      voice: 'Andre',
      patch: (session: any) => ({ ...session, enable_voice_clone: 'false' }),
    },
    {
      voice: 'Andre',
      patch: (session: any) => ({
        ...session,
        model: 'qwen3.5-livetranslate-flash-realtime',
      }),
    },
    {
      voice: 'Andre',
      patch: (session: any) => ({
        ...session,
        translation: { language: 'zh' },
      }),
    },
    {
      voice: 'Andre',
      patch: (session: any) => ({ ...session, translation: undefined }),
    },
    {
      voice: 'Andre',
      patch: (session: any) => ({
        ...session,
        audio: {
          ...session.audio,
          input: {
            ...session.audio.input,
            format: { type: 'pcm', sample_rate: 24000 },
          },
        },
      }),
    },
    {
      voice: 'Andre',
      patch: (session: any) => ({
        ...session,
        audio: {
          ...session.audio,
          output: { ...session.audio.output, format: undefined },
        },
      }),
    },
  ];
  for (const item of cases) {
    const wires: Wire[] = [];
    let now = 0;
    // eslint-disable-next-line no-await-in-loop -- Every outcome has exactly one isolated fake protocol session.
    const result = await runLiveTranslateAudition({
      input,
      apiKey: 'offline-fake-not-a-credential',
      now: () => now,
      delay: async (ms) => {
        if (!item.success) assert.fail('No recording frame may be sent');
        now += ms;
      },
      clientFactory: realFactory(wires, (wire) => {
        const session = wire.session.bind(wire);
        // Only the configuration ACK is patched; the created event keeps the exact model.
        let created = false;
        wire.session = () => {
          if (!created) {
            created = true;
            return session();
          }
          return item.patch(session());
        };
        if (item.success)
          wire.onFinish = () => {
            wire.source('synthetic_source', '人工离线样例。');
            wire.response(
              'synthetic_response',
              'synthetic_translation',
              'synthetic_source',
            );
            wire.text(
              'synthetic_response',
              'synthetic_translation',
              'Synthetic sample.',
            );
            wire.audio('synthetic_response', 'synthetic_translation', 7);
            wire.text(
              'synthetic_response',
              'synthetic_translation',
              'Synthetic sample.',
              true,
            );
            wire.output(
              'response.audio.done',
              'synthetic_response',
              'synthetic_translation',
            );
            wire.done(
              'synthetic_response',
              'synthetic_translation',
              'Synthetic sample.',
            );
            wire.receive({ type: 'session.finished' });
          };
      }),
    });
    assert.equal(result.counters.sessions, 1);
    assert.equal(wires.length, 1);
    assert.equal(wires[0].sent[0].session.voice, 'Andre');
    assert.equal(wires[0].sent[0].session.enable_voice_clone, false);
    assert.equal(wires[0].closed, 1);
    if (item.success) {
      assert.equal(result.status, 'completed');
      assert.equal(result.errorCode, undefined);
      assert.equal(result.counters.inputBytesSent, sample.length);
      assert.equal(result.confirmedSessions.length, 1);
      assert.equal(result.observedSessionConfigurations.length, 1);
      const confirmed = result.confirmedSessions[0];
      const acknowledged = result.observedSessionConfigurations[0];
      assert.equal(result.configuration.voice, 'Andre');
      assert.equal(confirmed.voice, 'Andre');
      assert.equal(acknowledged.voice, 'Andre');
      assert.equal(acknowledged.accepted, true);
      assert.equal(
        acknowledged.voiceCloneEnabled,
        item.missingCloneEcho ? null : false,
      );
      assert.equal(
        confirmed.voiceCloneEnabled,
        item.missingCloneEcho ? null : false,
      );
      assert.equal(
        confirmed.voiceCloneConfirmation,
        item.missingCloneEcho ? 'missing_echo_warning' : 'explicit_false',
      );
      assert.equal(acknowledged.sessionId, confirmed.sessionId);
      assert.equal(
        acknowledged.eventId,
        confirmed.configurationAcknowledgement.eventId,
      );
      assert.equal(
        acknowledged.receiveSequence,
        confirmed.configurationAcknowledgement.receiveSequence,
      );
      assert.equal(
        acknowledged.receivedAt,
        confirmed.configurationAcknowledgement.receivedAt,
      );
      const warning = result.protocolDiagnostics.find(
        (event) => event.code === 'LIVETRANSLATE_CLONE_CONFIRMATION_MISSING',
      );
      if (item.missingCloneEcho) {
        assert(warning);
        assert.equal(warning.fatal, false);
        assert.equal(warning.eventType, 'session.updated');
        assert.equal(warning.stage, 'configuring');
        assert.equal(warning.validationPath, 'session.enable_voice_clone');
        assert.equal(warning.actualType, 'missing');
        assert.equal(
          warning.at,
          confirmed.configurationAcknowledgement.receivedAt,
        );
      } else assert.equal(warning, undefined);
      const accepted = result.protocolEvents.findIndex(
        (event) => event.stage === 'configuration_accepted',
      );
      const firstAppend = result.protocolEvents.findIndex(
        (event) =>
          event.stage === 'client_event_sent' &&
          event.eventType === 'input_audio_buffer.append',
      );
      assert(accepted >= 0 && firstAppend > accepted);
      assert.deepEqual(
        Buffer.concat(
          wires[0].sent
            .filter((event) => event.type === 'input_audio_buffer.append')
            .map((event) => Buffer.from(event.audio, 'base64')),
        ),
        sample,
      );
      assert.deepEqual(result.audio[0].pcm, pcm(7));
      const evidence = describeLiveTranslateProtocolEvidence(result);
      assert.equal(
        evidence.voiceCloneDisabledConfirmation,
        item.missingCloneEcho
          ? 'unknown_missing_echo'
          : 'see_observed_configuration_if_any',
      );
      assert.equal(evidence.classification, 'protocol_finished_observed');
      assert.equal(
        Boolean(evidence.configurationWarning),
        Boolean(item.missingCloneEcho),
      );
      // eslint-disable-next-line no-continue -- This completed fixture must not execute the rejection-only assertions below.
      continue;
    }
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'LIVETRANSLATE_CONFIGURATION_REJECTED');
    assert.equal(result.counters.inputBytesSent, 0);
    assert.equal(result.confirmedSessions.length, 0);
    assert.equal(result.observedSessionConfigurations.length, 1);
    assert.equal(result.observedSessionConfigurations[0].accepted, false);
    assert.equal(result.observedSessionConfigurations[0].voice, item.voice);
    assert.equal(wires[0].sent.length, 1);
  }
});

test('synthetic single-local runner keeps the Andre request separate from approved ACK and response voice metadata through a complete fake session', async () => {
  const sample = Buffer.alloc(3200, 1);
  const input: PreparedLiveTranslateAuditionInput = {
    mode: 'single-local',
    manifestPath: 'synthetic-offline-only.json',
    manifestSha256: 'a'.repeat(64),
    workspaceId: 'offline-workspace',
    spaceHost: HOST,
    totalSeconds: 0.1,
    clips: [
      {
        id: 'local',
        role: 'local',
        pcm: sample,
        durationMs: 100,
        sha256: createHash('sha256').update(sample).digest('hex'),
        wavPath: 'synthetic-local.wav',
      },
    ],
  };
  const conflict = (session: any) => ({
    ...session,
    voice: 'Andre',
    audio: {
      ...session.audio,
      output: { ...session.audio.output, voice: 'Tina' },
    },
  });
  const cases: {
    name: string;
    success?: boolean;
    missingCloneEcho?: boolean;
    responseVoice?: unknown;
    responseDoneVoice?: unknown;
    failureAfterInput?: boolean;
    failureAfterOutput?: 'no-audio' | 'partial-audio';
    missingUsage?: boolean;
    patch?: (session: any) => any;
  }[] = [
    {
      name: 'approved conflict with response Tina metadata',
      success: true,
      responseVoice: 'Tina',
      responseDoneVoice: 'Tina',
    },
    {
      name: 'approved conflict with response Andre metadata',
      success: true,
      responseVoice: 'Andre',
      responseDoneVoice: 'Andre',
    },
    {
      name: 'created Andre and done Tina are independent metadata',
      success: true,
      responseVoice: 'Andre',
      responseDoneVoice: 'Tina',
    },
    {
      name: 'created Tina and done Andre are independent metadata',
      success: true,
      responseVoice: 'Tina',
      responseDoneVoice: 'Andre',
    },
    {
      name: 'approved conflict without an optional response voice',
      success: true,
    },
    {
      name: 'complete English audio can have missing usage',
      success: true,
      missingUsage: true,
      responseVoice: 'Andre',
      responseDoneVoice: 'Tina',
    },
    {
      name: 'approved metadata does not excuse no English audio',
      failureAfterOutput: 'no-audio',
      responseVoice: 'Andre',
      responseDoneVoice: 'Tina',
    },
    {
      name: 'approved metadata does not excuse unfinished English audio',
      failureAfterOutput: 'partial-audio',
      responseVoice: 'Tina',
      responseDoneVoice: 'Andre',
    },
    {
      name: 'approved conflict and missing clone echo',
      success: true,
      missingCloneEcho: true,
      responseVoice: 'Tina',
      patch: (session) => ({ ...session, enable_voice_clone: undefined }),
    },
    {
      name: 'response must not claim another voice',
      responseVoice: 'Aiden',
      failureAfterInput: true,
    },
    {
      name: 'response voice null is an invalid type',
      responseVoice: null,
      failureAfterInput: true,
    },
    {
      name: 'response voice number is an invalid type',
      responseVoice: 7,
      failureAfterInput: true,
    },
    {
      name: 'missing top-level Andre is not approved',
      patch: (session) => ({ ...session, voice: undefined }),
    },
    {
      name: 'top-level Tina is not approved',
      patch: (session) => ({ ...session, voice: 'Tina' }),
    },
    {
      name: 'another top-level voice is not approved',
      patch: (session) => ({ ...session, voice: 'Aiden' }),
    },
    {
      name: 'another nested voice is not approved',
      patch: (session) => ({
        ...session,
        audio: {
          ...session.audio,
          output: { ...session.audio.output, voice: 'Aiden' },
        },
      }),
    },
    {
      name: 'missing nested voice is not approved',
      patch: (session) => ({
        ...session,
        audio: {
          ...session.audio,
          output: { ...session.audio.output, voice: undefined },
        },
      }),
    },
    {
      name: 'clone true is rejected',
      patch: (session) => ({ ...session, enable_voice_clone: true }),
    },
    {
      name: 'clone null is rejected',
      patch: (session) => ({ ...session, enable_voice_clone: null }),
    },
    {
      name: 'clone string false is rejected',
      patch: (session) => ({ ...session, enable_voice_clone: 'false' }),
    },
    {
      name: 'another model is rejected',
      patch: (session) => ({
        ...session,
        model: 'qwen3.5-livetranslate-flash-realtime',
      }),
    },
    {
      name: 'another target language is rejected',
      patch: (session) => ({ ...session, translation: { language: 'zh' } }),
    },
    {
      name: 'missing target language is rejected',
      patch: (session) => ({ ...session, translation: undefined }),
    },
    {
      name: 'wrong input PCM is rejected',
      patch: (session) => ({
        ...session,
        audio: {
          ...session.audio,
          input: {
            ...session.audio.input,
            format: { type: 'pcm', sample_rate: 24000 },
          },
        },
      }),
    },
    {
      name: 'wrong output PCM is rejected',
      patch: (session) => ({
        ...session,
        audio: {
          ...session.audio,
          output: {
            ...session.audio.output,
            format: { type: 'pcm', sample_rate: 16000 },
          },
        },
      }),
    },
    {
      name: 'missing output PCM is rejected',
      patch: (session) => ({
        ...session,
        audio: {
          ...session.audio,
          output: { ...session.audio.output, format: undefined },
        },
      }),
    },
  ];
  for (const item of cases) {
    const wires: Wire[] = [];
    let now = 0;
    const factory = realFactory(wires, (wire) => {
      const session = wire.session.bind(wire);
      let created = false;
      wire.session = () => {
        if (!created) {
          created = true;
          return session();
        }
        const acknowledged = conflict(session());
        return item.patch ? item.patch(acknowledged) : acknowledged;
      };
      if (item.success || item.failureAfterInput || item.failureAfterOutput)
        wire.onFinish = () => {
          wire.source('synthetic_source', '人工离线样例。');
          wire.response(
            'synthetic_response',
            'synthetic_translation',
            'synthetic_source',
            item.responseVoice,
          );
          if (item.failureAfterInput) return;
          wire.text(
            'synthetic_response',
            'synthetic_translation',
            'Synthetic sample.',
          );
          if (item.failureAfterOutput !== 'no-audio')
            wire.audio('synthetic_response', 'synthetic_translation', 7);
          wire.text(
            'synthetic_response',
            'synthetic_translation',
            'Synthetic sample.',
            true,
          );
          if (item.failureAfterOutput !== 'partial-audio')
            wire.output(
              'response.audio.done',
              'synthetic_response',
              'synthetic_translation',
            );
          wire.done(
            'synthetic_response',
            'synthetic_translation',
            'Synthetic sample.',
            item.responseDoneVoice,
            !item.missingUsage,
          );
          wire.receive({ type: 'session.finished' });
        };
    });
    // eslint-disable-next-line no-await-in-loop -- Each case has one isolated fake protocol session.
    const result = await runLiveTranslateAudition({
      input,
      apiKey: 'offline-fake-not-a-credential',
      now: () => now,
      delay: async (ms) => {
        if (
          !item.success &&
          !item.failureAfterInput &&
          !item.failureAfterOutput
        )
          assert.fail(`No recording frame may be sent: ${item.name}`);
        now += ms;
      },
      clientFactory(options) {
        assert.equal(options.allowAndreTopLevelWithTinaOutput, true, item.name);
        assert.equal(options.allowMissingVoiceCloneEcho, true, item.name);
        return factory(options);
      },
    });
    assert.equal(result.counters.sessions, 1, item.name);
    assert.equal(wires.length, 1, item.name);
    assert.equal(wires[0].closed, 1, item.name);
    const updates = wires[0].sent.filter(
      (event) => event.type === 'session.update',
    );
    assert.equal(updates.length, 1, item.name);
    assert.equal(updates[0].session.voice, 'Andre', item.name);
    assert.equal(updates[0].session.enable_voice_clone, false, item.name);
    assert.equal(result.configuration.voice, 'Andre', item.name);
    if (!item.success && !item.failureAfterInput && !item.failureAfterOutput) {
      assert.equal(result.status, 'failed', item.name);
      assert.equal(
        result.errorCode,
        'LIVETRANSLATE_CONFIGURATION_REJECTED',
        item.name,
      );
      assert.equal(result.counters.inputBytesSent, 0, item.name);
      assert.equal(result.confirmedSessions.length, 0, item.name);
      assert.equal(result.observedSessionConfigurations.length, 1, item.name);
      assert.equal(
        result.observedSessionConfigurations[0].accepted,
        false,
        item.name,
      );
      assert.equal(wires[0].sent.length, 1, item.name);
      // eslint-disable-next-line no-continue -- A rejected configuration has no accepted-session assertions to run.
      continue;
    }
    assert.equal(result.counters.inputBytesSent, sample.length, item.name);
    assert.equal(result.confirmedSessions.length, 1, item.name);
    assert.equal(result.observedSessionConfigurations.length, 1, item.name);
    const confirmed = result.confirmedSessions[0];
    const acknowledged = result.observedSessionConfigurations[0];
    for (const evidence of [confirmed, acknowledged]) {
      assert.equal(evidence.voice, 'Tina', item.name);
      assert.equal(evidence.requestedVoice, 'Andre', item.name);
      assert.equal(evidence.topLevelVoice, 'Andre', item.name);
      assert.equal(
        evidence.voiceConfirmation,
        'approved_top_level_andre_nested_tina',
        item.name,
      );
      assert.equal(
        evidence.voiceCloneEnabled,
        item.missingCloneEcho ? null : false,
        item.name,
      );
      assert.equal(evidence.targetLanguage, 'en', item.name);
    }
    assert.equal(acknowledged.accepted, true, item.name);
    assert.equal(
      confirmed.voiceCloneConfirmation,
      item.missingCloneEcho ? 'missing_echo_warning' : 'explicit_false',
      item.name,
    );
    assert.equal(acknowledged.sessionId, confirmed.sessionId, item.name);
    assert.equal(
      acknowledged.eventId,
      confirmed.configurationAcknowledgement.eventId,
      item.name,
    );
    assert.equal(
      acknowledged.receiveSequence,
      confirmed.configurationAcknowledgement.receiveSequence,
      item.name,
    );
    assert.equal(
      acknowledged.receivedAt,
      confirmed.configurationAcknowledgement.receivedAt,
      item.name,
    );
    const warning = result.protocolDiagnostics.find(
      (event) => event.code === 'LIVETRANSLATE_APPROVED_ANDRE_TINA_CONFLICT',
    );
    assert(warning, item.name);
    assert.equal(warning.fatal, false, item.name);
    assert.equal(warning.eventType, 'session.updated', item.name);
    assert.equal(warning.stage, 'configuring', item.name);
    assert.equal(
      warning.validationPath,
      'session.audio.output.voice',
      item.name,
    );
    assert.equal(warning.expected, 'Andre', item.name);
    assert.equal(warning.actualType, 'string', item.name);
    assert.equal(warning.at, acknowledged.receivedAt, item.name);
    assert.deepEqual(
      warning.acknowledgement,
      {
        sessionId: acknowledged.sessionId,
        eventId: acknowledged.eventId,
        receiveSequence: acknowledged.receiveSequence,
      },
      item.name,
    );
    const cloneWarnings = result.protocolDiagnostics.filter(
      (event) => event.code === 'LIVETRANSLATE_CLONE_CONFIRMATION_MISSING',
    );
    assert.equal(
      cloneWarnings.length,
      item.missingCloneEcho ? 1 : 0,
      item.name,
    );
    if (item.missingCloneEcho) {
      assert.equal(cloneWarnings[0].fatal, false, item.name);
      assert.equal(cloneWarnings[0].at, acknowledged.receivedAt, item.name);
      assert.equal(cloneWarnings[0].actualType, 'missing', item.name);
    }
    const accepted = result.protocolEvents.findIndex(
      (event) => event.stage === 'configuration_accepted',
    );
    const firstAppend = result.protocolEvents.findIndex(
      (event) =>
        event.stage === 'client_event_sent' &&
        event.eventType === 'input_audio_buffer.append',
    );
    assert(accepted >= 0 && firstAppend > accepted, item.name);
    assert.deepEqual(
      Buffer.concat(
        wires[0].sent
          .filter((event) => event.type === 'input_audio_buffer.append')
          .map((event) => Buffer.from(event.audio, 'base64')),
      ),
      sample,
      item.name,
    );
    if (item.failureAfterInput) {
      assert.equal(result.status, 'failed', item.name);
      assert.equal(
        result.errorCode,
        'LIVETRANSLATE_CONFIGURATION_REJECTED',
        item.name,
      );
      const rejection = result.protocolDiagnostics.find((event) => event.fatal);
      assert.equal(rejection?.validationPath, 'response.voice', item.name);
      assert.equal(rejection?.expected, 'Andre_or_Tina_declaration', item.name);
      assert.equal(result.audio.length, 0, item.name);
      // eslint-disable-next-line no-continue -- This intentionally rejected response has no output assertions to run.
      continue;
    }
    const { outcomes } = describeLiveTranslateProtocolEvidence(result);
    assert.equal(outcomes.fullInputSent, true, item.name);
    assert.equal(outcomes.acousticVoice, 'unknown_not_measured', item.name);
    assert.equal(outcomes.maleVoiceAcceptance, 'not_evaluated', item.name);
    assert.equal(outcomes.voiceDriftAcceptance, 'not_evaluated', item.name);
    if (item.failureAfterOutput) {
      assert.equal(result.status, 'failed', item.name);
      assert.equal(
        result.errorCode,
        item.failureAfterOutput === 'no-audio'
          ? 'LIVETRANSLATE_RESPONSE_AUDIO_MISSING'
          : 'LIVETRANSLATE_RESPONSE_INCOMPLETE',
        item.name,
      );
      assert.equal(outcomes.protocol, 'stopped_with_error', item.name);
      assert.equal(
        outcomes.englishAudio,
        item.failureAfterOutput === 'no-audio'
          ? 'no_audio_observed'
          : 'partial_output_preserved',
        item.name,
      );
      assert.equal(
        result.counters.audioBytesSaved,
        item.failureAfterOutput === 'no-audio' ? 0 : pcm(7).length,
        item.name,
      );
      // eslint-disable-next-line no-continue -- Partial-output fixtures must not execute the complete-output assertions.
      continue;
    }
    assert.equal(result.status, 'completed', item.name);
    assert.equal(result.errorCode, undefined, item.name);
    assert.deepEqual(result.audio[0].pcm, pcm(7), item.name);
    assert.equal(confirmed.requestedVoice, 'Andre', item.name);
    assert.equal(confirmed.sessionOutputVoiceEcho?.value, 'Tina', item.name);
    assert.equal(
      confirmed.voicePolicy?.mode,
      'approved_andre_tina_metadata_conflict',
      item.name,
    );
    assert.equal(confirmed.voicePolicy?.requestedVoice, 'Andre', item.name);
    assert.deepEqual(
      confirmed.voicePolicy?.responseVoiceAllowlist,
      ['Andre', 'Tina'],
      item.name,
    );
    assert.equal(
      confirmed.voicePolicy?.acousticVoice,
      'unknown_not_measured',
      item.name,
    );
    assert.deepEqual(
      confirmed.voicePolicy?.acknowledgement,
      {
        sessionId: acknowledged.sessionId,
        eventId: acknowledged.eventId,
        receiveSequence: acknowledged.receiveSequence,
        receivedAt: acknowledged.receivedAt,
        sessionTopLevelEcho: {
          status: 'reported',
          value: 'Andre',
          actualType: 'string',
        },
        sessionNestedEcho: {
          status: 'reported',
          value: 'Tina',
          actualType: 'string',
        },
      },
      item.name,
    );
    const responseEvidence = result.voiceEvidence.filter(
      (event) =>
        event.eventType === 'response.created' ||
        event.eventType === 'response.done',
    );
    assert.deepEqual(
      responseEvidence.map((event) => [event.eventType, event.responseEcho]),
      [
        [
          'response.created',
          item.responseVoice === undefined
            ? { status: 'missing', value: null, actualType: 'missing' }
            : {
                status: 'reported',
                value: item.responseVoice,
                actualType: 'string',
              },
        ],
        [
          'response.done',
          item.responseDoneVoice === undefined
            ? { status: 'missing', value: null, actualType: 'missing' }
            : {
                status: 'reported',
                value: item.responseDoneVoice,
                actualType: 'string',
              },
        ],
      ],
      item.name,
    );
    assert(
      responseEvidence.every(
        (event) =>
          event.requestedVoice === 'Andre' &&
          event.acousticVoice === 'unknown_not_measured',
      ),
      item.name,
    );
    assert.deepEqual(
      result.audio[0].metadata.voiceContext,
      {
        requestedVoice: 'Andre',
        policyMode: 'approved_andre_tina_metadata_conflict',
        acousticVoice: 'unknown_not_measured',
      },
      item.name,
    );
    assert.equal(result.audio[0].actualPlaybackStartedAt, null, item.name);
    assert.equal(outcomes.protocol, 'finished_observed', item.name);
    assert.equal(outcomes.englishAudio, 'complete_output_observed', item.name);
    assert.equal(
      outcomes.usage,
      item.missingUsage ? 'unknown_not_returned' : 'reported_bill_not_verified',
      item.name,
    );
    const costs = calculateLiveTranslateAuditionCost(result.usage);
    assert.equal(costs.actualPlatformBilledCny, null, item.name);
    if (item.missingUsage) {
      assert.equal(result.usage[0].basis, 'unknown', item.name);
      assert.equal(costs.knownSubtotalCny, null, item.name);
      assert.equal(costs.allReportedUsagePriced, false, item.name);
    }
    assert(
      result.sources.some(
        (event) => event.final && event.text === '人工离线样例。',
      ),
      item.name,
    );
    assert(
      result.translations.some(
        (event) => event.final && event.text === 'Synthetic sample.',
      ),
      item.name,
    );
    assert.equal(result.usage.length, 1, item.name);
    assert(
      result.protocolEvents.some(
        (event) => event.eventType === 'response.audio.done',
      ),
      item.name,
    );
    assert(
      result.protocolEvents.some(
        (event) => event.eventType === 'response.done',
      ),
      item.name,
    );
    assert(
      result.protocolEvents.some(
        (event) => event.eventType === 'session.finished',
      ),
      item.name,
    );
  }
});

test('single-local runner rejects forged conflict confirmation without the matching ACK and warning', async () => {
  const sample = Buffer.alloc(3200, 1);
  const input: PreparedLiveTranslateAuditionInput = {
    mode: 'single-local',
    manifestPath: 'synthetic-offline-only.json',
    manifestSha256: 'a'.repeat(64),
    workspaceId: 'offline-workspace',
    spaceHost: HOST,
    totalSeconds: 0.1,
    clips: [
      {
        id: 'local',
        role: 'local',
        pcm: sample,
        durationMs: 100,
        sha256: createHash('sha256').update(sample).digest('hex'),
        wavPath: 'synthetic-local.wav',
      },
    ],
  };
  const cases = [
    'missing warning',
    'other warning session',
    'other warning event',
    'other warning sequence',
    'other warning time',
    'fatal warning',
    'missing ACK request',
    'other ACK top-level voice',
    'missing session marker',
  ];
  for (const name of cases) {
    let creates = 0;
    let appends = 0;
    // eslint-disable-next-line no-await-in-loop -- Every forged receipt has one isolated fake client.
    const result = await runLiveTranslateAudition({
      input,
      apiKey: 'offline-fake-not-a-credential',
      clientFactory(options) {
        creates += 1;
        assert.equal(options.allowAndreTopLevelWithTinaOutput, true, name);
        assert.equal(options.voice, 'Andre', name);
        const session: LiveTranslateSession = {
          role: 'local',
          sessionId: 'synthetic_conflict',
          model: MODEL,
          voice: 'Tina',
          requestedVoice: 'Andre',
          topLevelVoice: 'Andre',
          voiceConfirmation: 'approved_top_level_andre_nested_tina',
          sessionOutputVoiceEcho: {
            status: 'reported',
            value: 'Tina',
            actualType: 'string',
          },
          voicePolicy: {
            mode: 'approved_andre_tina_metadata_conflict',
            requestedVoice: 'Andre',
            responseVoiceAllowlist: ['Andre', 'Tina'],
            acousticVoice: 'unknown_not_measured',
            acknowledgement: {
              sessionId: 'synthetic_conflict',
              eventId: 'synthetic_ack',
              receiveSequence: 2,
              receivedAt: 0,
              sessionTopLevelEcho: {
                status: 'reported',
                value: 'Andre',
                actualType: 'string',
              },
              sessionNestedEcho: {
                status: 'reported',
                value: 'Tina',
                actualType: 'string',
              },
            },
          },
          voiceCloneEnabled: false,
          voiceCloneConfirmation: 'explicit_false',
          targetLanguage: 'en',
          inputSampleRate: 16000,
          outputSampleRate: 24000,
          outputModalities: ['text', 'audio'],
          configurationAcknowledgement: {
            eventId: 'synthetic_ack',
            receiveSequence: 2,
            receivedAt: 0,
            basis: 'provider_session_updated',
          },
        };
        const ack: LiveTranslateSessionConfiguration = {
          role: 'local',
          sessionId: session.sessionId,
          model: MODEL,
          voice: 'Tina',
          requestedVoice: 'Andre',
          topLevelVoice: 'Andre',
          voiceConfirmation: 'approved_top_level_andre_nested_tina',
          sessionOutputVoiceEcho: session.sessionOutputVoiceEcho,
          voicePolicy: session.voicePolicy,
          voiceCloneEnabled: false,
          targetLanguage: 'en',
          accepted: true,
          ...session.configurationAcknowledgement,
        };
        const warning: LiveTranslateProtocolDiagnostic = {
          role: 'local',
          at: 0,
          stage: 'configuring',
          eventType: 'session.updated',
          validationPath: 'session.audio.output.voice',
          expected: 'Andre',
          actualType: 'string',
          fatal: false,
          code: 'LIVETRANSLATE_APPROVED_ANDRE_TINA_CONFLICT',
          acknowledgement: {
            sessionId: session.sessionId,
            eventId: 'synthetic_ack',
            receiveSequence: 2,
          },
        };
        if (name === 'other warning session')
          warning.acknowledgement!.sessionId = 'synthetic_other_session';
        if (name === 'other warning event')
          warning.acknowledgement!.eventId = 'synthetic_other_ack';
        if (name === 'other warning sequence')
          warning.acknowledgement!.receiveSequence = 3;
        if (name === 'other warning time') warning.at = 1;
        if (name === 'fatal warning') warning.fatal = true;
        if (name === 'missing ACK request') delete ack.requestedVoice;
        if (name === 'other ACK top-level voice') ack.topLevelVoice = 'Tina';
        if (name === 'missing session marker') delete session.voiceConfirmation;
        options.onSessionConfiguration?.(ack);
        if (name !== 'missing warning') options.onProtocolDiagnostic?.(warning);
        return {
          ready: Promise.resolve(session),
          append() {
            appends += 1;
          },
          finish: async () => {},
          abort() {},
        };
      },
    });
    assert.equal(result.status, 'failed', name);
    assert.equal(
      result.errorCode,
      'LIVETRANSLATE_AUDITION_SESSION_CONFIG_REJECTED',
      name,
    );
    assert.equal(creates, 1, name);
    assert.equal(appends, 0, name);
    assert.equal(result.counters.inputBytesSent, 0, name);
    assert.equal(result.confirmedSessions.length, 0, name);
  }
});

test('single-local runner rejects a claimed missing-clone warning without a corresponding captured nonfatal diagnostic', async () => {
  const sample = Buffer.alloc(3200, 1);
  const input: PreparedLiveTranslateAuditionInput = {
    mode: 'single-local',
    manifestPath: 'synthetic-offline-only.json',
    manifestSha256: 'a'.repeat(64),
    workspaceId: 'offline-workspace',
    spaceHost: HOST,
    totalSeconds: 0.1,
    clips: [
      {
        id: 'local',
        role: 'local',
        pcm: sample,
        durationMs: 100,
        sha256: createHash('sha256').update(sample).digest('hex'),
        wavPath: 'synthetic-local.wav',
      },
    ],
  };
  let creates = 0;
  let appends = 0;
  const result = await runLiveTranslateAudition({
    input,
    apiKey: 'offline-fake-not-a-credential',
    clientFactory(options) {
      creates += 1;
      assert.equal(options.allowMissingVoiceCloneEcho, true);
      assert.equal(options.voice, 'Andre');
      const session: LiveTranslateSession = {
        role: 'local',
        sessionId: 'synthetic_warningless',
        model: MODEL,
        voice: 'Andre',
        voiceCloneEnabled: null,
        voiceCloneConfirmation: 'missing_echo_warning',
        targetLanguage: 'en',
        inputSampleRate: 16000,
        outputSampleRate: 24000,
        outputModalities: ['text', 'audio'],
        configurationAcknowledgement: {
          eventId: 'synthetic_ack',
          receiveSequence: 2,
          receivedAt: 0,
          basis: 'provider_session_updated',
        },
      };
      options.onSessionConfiguration?.({
        role: 'local',
        sessionId: session.sessionId,
        model: MODEL,
        voice: 'Andre',
        voiceCloneEnabled: null,
        targetLanguage: 'en',
        accepted: true,
        ...session.configurationAcknowledgement,
      });
      return {
        ready: Promise.resolve(session),
        append() {
          appends += 1;
        },
        finish: async () => {},
        abort() {},
      };
    },
  });
  assert.equal(result.status, 'failed');
  assert.equal(
    result.errorCode,
    'LIVETRANSLATE_AUDITION_SESSION_CONFIG_REJECTED',
  );
  assert.equal(creates, 1);
  assert.equal(appends, 0);
  assert.equal(result.counters.inputBytesSent, 0);
  assert.equal(result.confirmedSessions.length, 0);
  assert.equal(result.protocolDiagnostics.length, 0);
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

// Every continuation below is manually constructed. None was captured after the real stop.
const syntheticVoiceStateReports: Record<string, unknown>[] = [];
const syntheticInput = Buffer.alloc(6400, 1);
const syntheticOutput = Buffer.concat([pcm(7), pcm(8)]);
const syntheticTranslation = 'Synthetic complete output.';

function syntheticVoicePeer(extras: Partial<LiveTranslateClientOptions> = {}) {
  const wire = new Wire('local', 'Andre');
  const voices: LiveTranslateVoiceEvidence[] = [];
  const diagnostics: LiveTranslateProtocolDiagnostic[] = [];
  const events: LiveTranslateProtocolEvent[] = [];
  const audio: { pcm: Buffer; metadata: LiveTranslateAudioMetadata }[] = [];
  const usage: LiveTranslateUsage[] = [];
  const timing: LiveTranslateTiming[] = [];
  const errors: string[] = [];
  const configurations: LiveTranslateSessionConfiguration[] = [];
  let constructions = 0;
  let clock = 0;
  let sessionCalls = 0;
  let ackPatch = (session: any) => session;
  const defaultSession = wire.session.bind(wire);
  wire.session = () => {
    const session = defaultSession();
    sessionCalls += 1;
    const nestedTina = {
      ...session,
      audio: {
        ...session.audio,
        output: { ...session.audio.output, voice: 'Tina' },
      },
    };
    return sessionCalls === 1
      ? nestedTina
      : ackPatch({ ...nestedTina, voice: 'Andre' });
  };
  const client = createLiveTranslateClient({
    enabled: true,
    role: 'local',
    voice: 'Andre',
    allowAndreTopLevelWithTinaOutput: true,
    allowMissingVoiceCloneEcho: true,
    workspaceId: 'offline-workspace',
    apiKey: 'SYNTHETIC_UNUSED_CREDENTIAL',
    now: () => {
      clock += 1;
      return clock;
    },
    timeoutMs: 100,
    ...extras,
    createWebSocket(url) {
      constructions += 1;
      assert.equal(url, `wss://${HOST}/api-ws/v1/realtime?model=${MODEL}`);
      return wire as unknown as WebSocket;
    },
    onVoiceEvidence: (event) => voices.push(event),
    onProtocolDiagnostic: (event) => diagnostics.push(event),
    onProtocolEvent: (event) => events.push(event),
    onAudio: (chunk, metadata) =>
      audio.push({ pcm: Buffer.from(chunk), metadata }),
    onUsage: (event) => usage.push(event),
    onTiming: (event) => timing.push(event),
    onError: (code) => errors.push(code),
    onSessionConfiguration: (event) => configurations.push(event),
  });
  return {
    wire,
    client,
    voices,
    diagnostics,
    events,
    audio,
    usage,
    timing,
    errors,
    configurations,
    constructions: () => constructions,
    start(patch = (session: any) => session) {
      ackPatch = patch;
      wire.emit('open');
      wire.receive({ type: 'session.created', session: wire.session() });
      return client.ready;
    },
  };
}

type SyntheticVoicePeer = ReturnType<typeof syntheticVoicePeer>;

function syntheticResponseBody(
  peer: SyntheticVoicePeer,
  omitAudio = false,
  omitAudioDone = false,
) {
  peer.wire.text('synthetic_response', 'synthetic_translation', 'Synthetic ');
  if (!omitAudio) {
    peer.wire.audio('synthetic_response', 'synthetic_translation', 7);
    peer.wire.audio('synthetic_response', 'synthetic_translation', 8);
  }
  peer.wire.text(
    'synthetic_response',
    'synthetic_translation',
    syntheticTranslation,
    true,
  );
  if (!omitAudioDone)
    peer.wire.output(
      'response.audio.done',
      'synthetic_response',
      'synthetic_translation',
    );
}

function recordSyntheticVoiceState(
  id: string,
  peer: SyntheticVoicePeer,
  protocolCompleted: boolean,
  audioComplete: boolean,
) {
  const bytes = Buffer.concat(peer.audio.map((entry) => entry.pcm));
  syntheticVoiceStateReports.push({
    id,
    source: 'manually_constructed_after_unrecorded_real_stop',
    evidenceBasis: 'synthetic_protocol_peer_not_supplier_capture',
    timingBasis: 'fake_clock_not_model_latency',
    constructions: peer.constructions(),
    requestedVoice: 'Andre',
    protocolCompleted,
    fullSyntheticOutputAudioComplete: audioComplete,
    retainedAudioBytes: bytes.length,
    acousticMaleVoice: 'unknown_not_measured',
    actualPlaybackStartedAt: null,
    fatalCode: peer.errors[0] ?? null,
    fatalPath:
      peer.diagnostics.find((event) => event.fatal)?.validationPath ?? null,
    voiceEvidence: peer.voices,
    usageBasis: peer.usage.map((entry) => entry.basis),
    protocolFrameTypes: peer.events
      .filter((event) => event.stage === 'server_frame')
      .map((event) => event.eventType),
  });
  assert.equal(peer.constructions(), 1, id);
  assert(
    peer.voices.every(
      (event) =>
        event.requestedVoice === 'Andre' &&
        event.acousticVoice === 'unknown_not_measured',
    ),
    id,
  );
  if (audioComplete) assert.deepEqual(bytes, syntheticOutput, id);
  const update = peer.wire.sent.find(
    (event) => event.type === 'session.update',
  );
  if (update) {
    assert.equal(update.session.voice, 'Andre', id);
    assert.equal(update.session.enable_voice_clone, false, id);
  }
  assert(
    peer.wire.sent.filter((event) => event.type === 'session.update').length <=
      1,
    id,
  );
  assert(
    peer.wire.sent.filter((event) => event.type === 'session.finish').length <=
      1,
    id,
  );
}

for (const pair of [
  { id: 'created-andre-done-tina', created: 'Andre', done: 'Tina' },
  { id: 'created-tina-done-andre', created: 'Tina', done: 'Andre' },
  {
    id: 'both-optional-response-voices-missing',
    created: undefined,
    done: undefined,
  },
  {
    id: 'complete-audio-without-usage',
    created: 'Andre',
    done: 'Tina',
    omitUsage: true,
  },
]) {
  test(`synthetic voice state full chain: ${pair.id}`, async () => {
    const peer = syntheticVoicePeer();
    peer.wire.receive({
      type: 'synthetic.future.notification',
      private_extension: 'SYNTHETIC_EXTENSION',
    });
    assert.throws(() => peer.client.append(syntheticInput), /NOT_READY/);
    const ready = await peer.start();
    const requestSnapshot = JSON.stringify(peer.wire.sent[0]);
    assert.equal(ready.requestedVoice, 'Andre');
    assert.equal(ready.voice, 'Tina'); // Deprecated session output echo, never an acoustic conclusion.
    assert.deepEqual(ready.sessionOutputVoiceEcho, {
      status: 'reported',
      value: 'Tina',
      actualType: 'string',
    });
    assert.equal(
      ready.voicePolicy?.mode,
      'approved_andre_tina_metadata_conflict',
    );
    assert.deepEqual(ready.voicePolicy?.responseVoiceAllowlist, [
      'Andre',
      'Tina',
    ]);
    const created = peer.voices.find(
      (event) => event.eventType === 'session.created',
    );
    const updated = peer.voices.find(
      (event) => event.eventType === 'session.updated',
    );
    assert.equal(created?.sessionTopLevelEcho.status, 'missing');
    assert.equal(created?.sessionNestedEcho.value, 'Tina');
    assert.equal(updated?.sessionTopLevelEcho.value, 'Andre');
    assert.equal(updated?.sessionNestedEcho.value, 'Tina');
    peer.client.append(syntheticInput);
    const finished = peer.client.finish();
    peer.wire.source('synthetic_source', '人工完整离线样例。');
    peer.wire.response(
      'synthetic_response',
      'synthetic_translation',
      'synthetic_source',
      pair.created,
    );
    syntheticResponseBody(peer);
    peer.wire.done(
      'synthetic_response',
      'synthetic_translation',
      syntheticTranslation,
      pair.done,
      !pair.omitUsage,
    );
    peer.wire.receive({ type: 'session.finished' });
    await finished;
    assert.deepEqual(peer.errors, []);
    assert.equal(JSON.stringify(peer.wire.sent[0]), requestSnapshot);
    assert.equal(ready.requestedVoice, 'Andre');
    assert.equal(ready.voicePolicy?.requestedVoice, 'Andre');
    assert.equal(ready.voicePolicy?.acousticVoice, 'unknown_not_measured');
    const responseEchoes = peer.voices.filter((event) =>
      event.eventType.startsWith('response.'),
    );
    assert.deepEqual(
      responseEchoes.map((event) => event.responseEcho.value),
      [pair.created ?? null, pair.done ?? null],
    );
    assert.deepEqual(
      responseEchoes.map((event) => event.responseEcho.status),
      [
        pair.created === undefined ? 'missing' : 'reported',
        pair.done === undefined ? 'missing' : 'reported',
      ],
    );
    assert(
      peer.audio.every(
        (entry) =>
          entry.metadata.voiceContext?.requestedVoice === 'Andre' &&
          entry.metadata.voiceContext.acousticVoice === 'unknown_not_measured',
      ),
    );
    assert.deepEqual(
      Buffer.concat(
        peer.wire.sent
          .filter((event) => event.type === 'input_audio_buffer.append')
          .map((event) => Buffer.from(event.audio, 'base64')),
      ),
      syntheticInput,
    );
    assert.equal(peer.usage.length, 1);
    assert.equal(
      peer.usage[0].basis,
      pair.omitUsage ? 'unknown' : 'provider_reported',
    );
    if (pair.omitUsage) {
      assert.equal(peer.usage[0].inputTokens, undefined);
      assert.equal(peer.usage[0].outputTokens, undefined);
    }
    assert.equal(
      peer.timing.filter((event) => event.stage === 'response_completed')
        .length,
      1,
    );
    assert.equal((await peer.client.transportClosed!).code, 1000);
    recordSyntheticVoiceState(pair.id, peer, true, true);
  });
}

for (const phase of ['created', 'done'] as const) {
  for (const supplied of [
    {
      id: 'third-known-voice',
      voice: 'Aiden',
      status: 'reported',
      type: 'string',
    },
    {
      id: 'unlisted-voice',
      voice: 'SyntheticUnsupportedVoice',
      status: 'unsupported_value',
      type: 'string',
    },
    { id: 'null', voice: null, status: 'invalid_type', type: 'null' },
    { id: 'number', voice: 7, status: 'invalid_type', type: 'number' },
  ]) {
    test(`synthetic response ${phase} rejects ${supplied.id} without changing request`, async () => {
      const peer = syntheticVoicePeer();
      const ready = await peer.start();
      peer.client.append(syntheticInput);
      const finished = peer.client.finish();
      peer.wire.source('synthetic_source', '人工完整离线样例。');
      peer.wire.response(
        'synthetic_response',
        'synthetic_translation',
        'synthetic_source',
        phase === 'created' ? supplied.voice : 'Andre',
      );
      if (phase === 'done') {
        syntheticResponseBody(peer);
        peer.wire.done(
          'synthetic_response',
          'synthetic_translation',
          syntheticTranslation,
          supplied.voice,
        );
      }
      await assert.rejects(finished, /LIVETRANSLATE_CONFIGURATION_REJECTED/);
      const rejected = peer.voices.find(
        (event) => event.eventType === `response.${phase}`,
      );
      assert.equal(rejected?.responseEcho.status, supplied.status);
      assert.equal(rejected?.responseEcho.actualType, supplied.type);
      assert.equal(rejected?.acceptedByVoicePolicy, false);
      assert.equal(ready.requestedVoice, 'Andre');
      assert.equal(ready.voicePolicy?.requestedVoice, 'Andre');
      assert.equal(
        peer.events.some((event) => event.stage === 'provider_error'),
        false,
      );
      assert.equal(
        peer.diagnostics.find((event) => event.fatal)?.validationPath,
        'response.voice',
      );
      recordSyntheticVoiceState(`${phase}-${supplied.id}`, peer, false, false);
    });
  }
}

test('synthetic duplicate frames are idempotent while later response metadata remains independently checked', async () => {
  const peer = syntheticVoicePeer();
  const ready = await peer.start();
  const acknowledged = peer.wire.received.find(
    (event) => event.type === 'session.updated',
  );
  assert(acknowledged);
  peer.wire.receive(acknowledged);
  assert.equal(peer.configurations.length, 1);
  peer.client.append(syntheticInput);
  const finished = peer.client.finish();
  peer.wire.source('synthetic_source', '人工完整离线样例。');
  const created: any = peer.wire.receive({
    event_id: 'synthetic_created_once',
    type: 'response.created',
    response: {
      id: 'synthetic_response',
      status: 'in_progress',
      output: [],
      voice: 'Andre',
    },
  });
  peer.wire.receive(created);
  peer.wire.receive({
    type: 'conversation.item.created',
    previous_item_id: 'synthetic_source',
    item: { id: 'synthetic_translation', role: 'assistant', content: [] },
  });
  syntheticResponseBody(peer);
  const done: any = peer.wire.done(
    'synthetic_response',
    'synthetic_translation',
    syntheticTranslation,
    'Andre',
  );
  peer.wire.receive(done);
  peer.wire.receive({
    ...done,
    event_id: 'synthetic_done_distinct_metadata',
    response: { ...done.response, voice: 'Tina' },
  });
  assert.equal(
    peer.timing.filter((event) => event.stage === 'response_created').length,
    1,
  );
  assert.equal(
    peer.timing.filter((event) => event.stage === 'response_completed').length,
    1,
  );
  assert.equal(peer.usage.length, 1);
  assert(
    peer.voices.some(
      (event) =>
        event.eventId === 'synthetic_done_distinct_metadata' &&
        event.responseEcho.value === 'Tina' &&
        event.acceptedByVoicePolicy === true,
    ),
  );
  assert.equal(ready.requestedVoice, 'Andre');
  peer.wire.receive({ type: 'session.finished' });
  await finished;
  assert.deepEqual(peer.errors, []);
  recordSyntheticVoiceState(
    'duplicate-idempotency-with-independent-done-echo',
    peer,
    true,
    true,
  );
});

test('synthetic changed duplicate ACK is a conflict and cannot authorize input', async () => {
  const peer = syntheticVoicePeer();
  await peer.start();
  const acknowledged = peer.wire.received.find(
    (event) => event.type === 'session.updated',
  );
  assert(acknowledged);
  const finished = peer.client.finish();
  peer.wire.receive({
    ...acknowledged,
    session: { ...acknowledged.session, voice: 'Aiden' },
  });
  await assert.rejects(finished, /LIVETRANSLATE_EVENT_CONFLICT/);
  assert.equal(peer.configurations.length, 1);
  assert.equal(
    peer.wire.sent.filter((event) => event.type === 'input_audio_buffer.append')
      .length,
    0,
  );
  recordSyntheticVoiceState('changed-duplicate-ack', peer, false, false);
});

test('synthetic conflict opt-in does not relax an exact-Andre ACK into a Tina response policy', async () => {
  const peer = syntheticVoicePeer();
  const ready = await peer.start((session) => ({
    ...session,
    audio: {
      ...session.audio,
      output: { ...session.audio.output, voice: 'Andre' },
    },
  }));
  assert.equal(ready.voicePolicy?.mode, 'strict_requested_voice');
  assert.deepEqual(ready.voicePolicy?.responseVoiceAllowlist, ['Andre']);
  peer.client.append(syntheticInput);
  const finished = peer.client.finish();
  peer.wire.source('synthetic_source', '人工完整离线样例。');
  peer.wire.response(
    'synthetic_response',
    'synthetic_translation',
    'synthetic_source',
    'Tina',
  );
  await assert.rejects(finished, /LIVETRANSLATE_CONFIGURATION_REJECTED/);
  assert.equal(ready.requestedVoice, 'Andre');
  assert.equal(peer.audio.length, 0);
  recordSyntheticVoiceState('exact-ack-stays-strict', peer, false, false);
});

for (const conflictKind of [
  'same-event-id-different-payload',
  'new-event-id-third-voice-after-done',
] as const) {
  test(`synthetic duplicate conflict: ${conflictKind}`, async () => {
    const peer = syntheticVoicePeer();
    await peer.start();
    peer.client.append(syntheticInput);
    const finished = peer.client.finish();
    peer.wire.source('synthetic_source', '人工完整离线样例。');
    peer.wire.response(
      'synthetic_response',
      'synthetic_translation',
      'synthetic_source',
      'Andre',
    );
    syntheticResponseBody(peer);
    const done: any = peer.wire.done(
      'synthetic_response',
      'synthetic_translation',
      syntheticTranslation,
      'Andre',
    );
    peer.wire.receive({
      ...done,
      ...(conflictKind === 'new-event-id-third-voice-after-done'
        ? { event_id: 'synthetic_new_done' }
        : {}),
      response: { ...done.response, voice: 'Aiden' },
    });
    await assert.rejects(
      finished,
      conflictKind === 'same-event-id-different-payload'
        ? /LIVETRANSLATE_EVENT_CONFLICT/
        : /LIVETRANSLATE_CONFIGURATION_REJECTED/,
    );
    assert.equal(peer.usage.length, 1);
    assert.equal(
      peer.timing.filter((event) => event.stage === 'response_completed')
        .length,
      1,
    );
    recordSyntheticVoiceState(conflictKind, peer, false, false);
  });
}

for (const missing of ['top-level-ack-voice', 'nested-ack-voice'] as const) {
  test(`synthetic required ACK voice missing: ${missing}`, async () => {
    const peer = syntheticVoicePeer();
    await assert.rejects(
      peer.start((session) =>
        missing === 'top-level-ack-voice'
          ? { ...session, voice: undefined }
          : {
              ...session,
              audio: {
                ...session.audio,
                output: { ...session.audio.output, voice: undefined },
              },
            },
      ),
      /LIVETRANSLATE_CONFIGURATION_REJECTED/,
    );
    assert.equal(
      peer.wire.sent.filter(
        (event) => event.type === 'input_audio_buffer.append',
      ).length,
      0,
    );
    assert.equal(peer.configurations[0].accepted, false);
    recordSyntheticVoiceState(missing, peer, false, false);
  });
}

for (const ordering of [
  'audio-before-response-created',
  'done-before-response-created',
] as const) {
  test(`synthetic invalid response ordering: ${ordering}`, async () => {
    const peer = syntheticVoicePeer();
    await peer.start();
    peer.client.append(syntheticInput);
    const finished = peer.client.finish();
    peer.wire.source('synthetic_source', '人工完整离线样例。');
    peer.wire.receive({
      type: 'conversation.item.created',
      previous_item_id: 'synthetic_source',
      item: { id: 'synthetic_translation', role: 'assistant', content: [] },
    });
    if (ordering === 'audio-before-response-created')
      peer.wire.audio('synthetic_response', 'synthetic_translation', 7);
    else
      peer.wire.done(
        'synthetic_response',
        'synthetic_translation',
        syntheticTranslation,
        'Andre',
      );
    await assert.rejects(finished, /LIVETRANSLATE_RESPONSE_ORDER_UNKNOWN/);
    assert.equal(peer.audio.length, 0);
    recordSyntheticVoiceState(ordering, peer, false, false);
  });
}

test('synthetic supplier error remains an explicit rejection rather than a voice drift inference', async () => {
  const peer = syntheticVoicePeer();
  peer.wire.receive({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      code: 'invalid_value',
      param: 'session.voice',
      message: 'SYNTHETIC_PRIVATE_ERROR_NOT_RETAINED',
    },
  });
  await assert.rejects(peer.client.ready, /LIVETRANSLATE_PROVIDER_REJECTED/);
  assert.equal(peer.wire.sent.length, 0);
  assert.equal(
    peer.events.find((event) => event.stage === 'provider_error')?.providerError
      ?.parameter,
    'session.voice',
  );
  assert.equal(
    JSON.stringify({
      voices: peer.voices,
      diagnostics: peer.diagnostics,
      events: peer.events,
    }).includes('SYNTHETIC_PRIVATE_ERROR_NOT_RETAINED'),
    false,
  );
  recordSyntheticVoiceState('explicit-supplier-error', peer, false, false);
});

for (const output of ['no-audio', 'partial-audio-no-done'] as const) {
  test(`synthetic metadata acceptance is separate from complete output: ${output}`, async () => {
    const peer = syntheticVoicePeer();
    await peer.start();
    peer.client.append(syntheticInput);
    const finished = peer.client.finish();
    peer.wire.source('synthetic_source', '人工完整离线样例。');
    peer.wire.response(
      'synthetic_response',
      'synthetic_translation',
      'synthetic_source',
      'Andre',
    );
    syntheticResponseBody(
      peer,
      output === 'no-audio',
      output === 'partial-audio-no-done',
    );
    peer.wire.done(
      'synthetic_response',
      'synthetic_translation',
      syntheticTranslation,
      'Tina',
    );
    await assert.rejects(
      finished,
      output === 'no-audio'
        ? /LIVETRANSLATE_RESPONSE_AUDIO_MISSING/
        : /LIVETRANSLATE_RESPONSE_INCOMPLETE/,
    );
    assert(
      peer.voices
        .filter((event) => event.eventType.startsWith('response.'))
        .every((event) => event.acceptedByVoicePolicy === true),
    );
    assert.equal(peer.audio.length, output === 'no-audio' ? 0 : 2);
    recordSyntheticVoiceState(output, peer, false, false);
  });
}

for (const stop of ['tail-timeout', 'cancelled'] as const) {
  test(`synthetic unfinished tail stops without reconnect: ${stop}`, async () => {
    const peer = syntheticVoicePeer({ timeoutMs: 20 });
    await peer.start();
    peer.client.append(syntheticInput);
    const finished = peer.client.finish();
    if (stop === 'cancelled') peer.client.abort();
    await assert.rejects(
      finished,
      stop === 'cancelled'
        ? /LIVETRANSLATE_CANCELLED/
        : /LIVETRANSLATE_FINISH_TIMEOUT/,
    );
    assert.equal(
      peer.events.some(
        (event) =>
          event.stage === 'server_frame' &&
          event.eventType === 'session.finished',
      ),
      false,
    );
    assert.equal(peer.usage.length, 0);
    assert.equal(peer.audio.length, 0);
    recordSyntheticVoiceState(stop, peer, false, false);
  });
}

after(() => {
  const output = process.env.LIVETRANSLATE_VOICE_STATE_SYNTHETIC_REPORT;
  if (output)
    writeFileSync(
      output,
      `${JSON.stringify(
        {
          evidenceBasis: 'synthetic_continuations_not_supplier_captures',
          requestedVoice: 'Andre',
          acousticVoice: 'unknown_not_measured',
          scenarios: syntheticVoiceStateReports,
        },
        null,
        2,
      )}\n`,
    );
});
