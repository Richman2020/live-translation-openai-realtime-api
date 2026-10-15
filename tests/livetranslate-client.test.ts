import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';

import {
  buildLiveTranslateEndpoint,
  createLiveTranslateClient,
  LIVE_TRANSLATE_MODEL,
  LIVE_TRANSLATE_FAILURE_CODES,
  isLiveTranslateFailureCode,
} from '../src/experiments/livetranslate-client';
import type { LiveTranslateClientOptions } from '../src/experiments/livetranslate-types';

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  sent: any[] = [];

  terminated = 0;

  closed = 0;

  send(raw: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(raw));
    callback?.();
  }

  terminate() {
    this.terminated += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1006);
  }

  close() {
    this.closed += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1000);
  }
}
function fixture(
  role: 'local' | 'remote' = 'local',
  extras: Partial<LiveTranslateClientOptions> = {},
) {
  const socket = new Socket();
  const sources: any[] = [];
  const translations: any[] = [];
  const associations: any[] = [];
  const audio: any[] = [];
  const errors: any[] = [];
  const timings: any[] = [];
  const usages: any[] = [];
  const sessionConfigurations: any[] = [];
  const protocolDiagnostics: any[] = [];
  const voiceEvidence: any[] = [];
  const addresses: string[] = [];
  const settings: any[] = [];
  let eventNumber = 0;
  const createdResponses = new Set<string>();
  const client = createLiveTranslateClient({
    enabled: true,
    role,
    workspaceId: 'offline-workspace',
    apiKey: 'OFFLINE_PRIVATE_KEY_CANARY',
    createWebSocket(url, options) {
      addresses.push(url);
      settings.push(options);
      return socket as unknown as WebSocket;
    },
    onSource: (event) => sources.push(event),
    onTranslation: (event) => translations.push(event),
    onAssociation: (event) => associations.push(event),
    onAudio: (pcm, metadata) => audio.push({ pcm, metadata }),
    onError: (code, details) => errors.push({ code, ...details }),
    onTiming: (event) => timings.push(event),
    onUsage: (event) => usages.push(event),
    onSessionConfiguration: (event) => sessionConfigurations.push(event),
    onProtocolDiagnostic: (event) => protocolDiagnostics.push(event),
    onVoiceEvidence: (event) => voiceEvidence.push(event),
    ...extras,
  });
  const receive = (event: any) => {
    if (event.type === 'response.created')
      createdResponses.add(event.response.id);
    eventNumber += 1;
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ event_id: `e_${eventNumber}`, ...event })),
      false,
    );
  };
  const session = () => ({
    id: `s_${role}`,
    model: LIVE_TRANSLATE_MODEL,
    output_modalities: role === 'local' ? ['text', 'audio'] : ['text'],
    enable_voice_clone: false,
    audio: {
      input: {
        format: { type: 'pcm', sample_rate: 16000 },
        turn_detection: { type: 'speaker_detection', threshold: 0.5 },
      },
      output: { format: { type: 'pcm', sample_rate: 24000 }, voice: extras.voice ?? 'Aiden' },
    },
    translation: { language: role === 'local' ? 'en' : 'zh' },
  });
  const start = async (patch: any = {}) => {
    receive({ type: 'session.created', session: session() });
    receive({ type: 'session.updated', session: { ...session(), ...patch } });
    await client.ready;
  };
  const source = (id = 'source_1', text = '原始合成文本。') => {
    receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: id,
      content_index: 0,
      transcript: text,
    });
  };
  const link = (id = 'translation_1', prior = 'source_1') =>
    receive({
      type: 'conversation.item.created',
      previous_item_id: prior,
      item: { id, role: 'assistant', content: [] },
    });
  const created = (responseId = 'response_1') => {
    if (!createdResponses.has(responseId))
      receive({
        type: 'response.created',
        response: { id: responseId, status: 'in_progress' },
      });
  };
  const delta = (
    type: string,
    value: any,
    id = 'translation_1',
    responseId = 'response_1',
    eventId?: string,
  ) => {
    // The fake supplier follows its documented response.created lifecycle.
    created(responseId);
    receive({
      type,
      item_id: id,
      response_id: responseId,
      output_index: 0,
      content_index: 0,
      ...value,
      ...(eventId ? { event_id: eventId } : {}),
    });
  };
  const done = (id = 'response_1', extra: any = {}) => {
    created(id);
    const latest = new Map<string, any>();
    for (const item of translations)
      if (item.responseId === id) latest.set(item.translationId, item);
    const output = [...latest.values()].map((item) => ({
      id: item.translationId,
      content: item.text ? [role === 'local'
        ? { type: 'audio', transcript: item.text }
        : { type: 'text', text: item.text }] : [],
    }));
    receive({
      type: 'response.done',
      response: { id, status: 'completed', output, ...extra },
    });
  };
  return {
    client,
    socket,
    receive,
    session,
    start,
    source,
    link,
    delta,
    done,
    created,
    sources,
    translations,
    associations,
    audio,
    errors,
    timings,
    usages,
    sessionConfigurations,
    protocolDiagnostics,
    voiceEvidence,
    addresses,
    settings,
  };
}

test('disabled construction reads no key and makes no socket; endpoint is one Beijing workspace label only', () => {
  let reads = 0;
  assert.throws(
    () =>
      createLiveTranslateClient({
        enabled: false,
        get apiKey() {
          reads += 1;
          return 'PRIVATE';
        },
      } as any),
    /DISABLED/,
  );
  assert.equal(reads, 0);
  assert.equal(
    buildLiveTranslateEndpoint('workspace-1'),
    `wss://workspace-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=${LIVE_TRANSLATE_MODEL}`,
  );
  for (const invalid of [
    '{WorkspaceId}',
    '../x',
    'evil.example',
    'upperCase',
    'x/other',
    ' x',
    '-x',
    'x-',
  ])
    assert.throws(
      () => buildLiveTranslateEndpoint(invalid),
      /WORKSPACE_INVALID/,
    );
});

test('two roles configure exact 3.8 schema, Aiden without clone, strict ACK and no fictitious parameters', async () => {
  for (const role of ['local', 'remote'] as const) {
    const f = fixture(role);
    assert.throws(() => f.client.append(Buffer.alloc(320)), /NOT_READY/);
    // eslint-disable-next-line no-await-in-loop -- Isolated role-specific fake sessions.
    const acknowledged = await f.start();
    assert.equal(acknowledged, undefined);
    const update = f.socket.sent[0];
    assert.equal(update.type, 'session.update');
    assert.deepEqual(
      update.session.output_modalities,
      role === 'local' ? ['text', 'audio'] : ['text'],
    );
    assert.equal(update.session.voice, 'Aiden');
    assert.equal(update.session.enable_voice_clone, false);
    // eslint-disable-next-line no-await-in-loop -- Each fake ACK belongs to its own role.
    const confirmed = await f.client.ready;
    assert.equal(confirmed.voice, 'Aiden');
    assert.equal(confirmed.voiceCloneEnabled, false);
    assert.equal(confirmed.targetLanguage, role === 'local' ? 'en' : 'zh');
    assert.equal(confirmed.configurationAcknowledgement.basis, 'provider_session_updated');
    assert.equal(confirmed.configurationAcknowledgement.eventId, 'e_2');
    assert.equal(f.sessionConfigurations[0].accepted, true);
    for (const unsupported of [
      'modalities',
      'input_audio_transcription',
      'max_output_tokens',
      'instructions',
      'sample_rate',
    ])
      assert.equal(unsupported in update.session, false);
    f.client.append(Buffer.alloc(320));
    assert.equal(f.socket.sent[1].type, 'input_audio_buffer.append');
    assert.equal(Buffer.from(f.socket.sent[1].audio, 'base64').length, 320);
    assert.equal(f.settings[0].rejectUnauthorized, undefined);
    f.client.abort();
  }
});

test('Aiden input remains fenced until a complete server configuration acknowledgement', async () => {
  const f = fixture('local', { now: () => 1234 });
  let ready = false;
  f.client.ready.then(() => { ready = true; });
  f.receive({ type: 'session.created', session: f.session() });
  await Promise.resolve();
  assert.equal(ready, false);
  assert.equal(f.sessionConfigurations.length, 0);
  assert.throws(() => f.client.append(Buffer.alloc(320)), /NOT_READY/);
  assert.deepEqual(f.socket.sent.map((event) => event.type), ['session.update']);
  f.receive({ type: 'session.updated', session: f.session() });
  const confirmed = await f.client.ready;
  assert.equal(confirmed.voice, 'Aiden');
  assert.equal(confirmed.voiceCloneEnabled, false);
  assert.equal(confirmed.targetLanguage, 'en');
  assert.deepEqual(confirmed.configurationAcknowledgement, {
    eventId: 'e_2', receiveSequence: 2, receivedAt: 1234, basis: 'provider_session_updated',
  });
  f.client.append(Buffer.alloc(320));
  assert.deepEqual(f.socket.sent.map((event) => event.type), ['session.update', 'input_audio_buffer.append']);
  f.client.abort();
});

test('trusted Tina selection pins request, nested ACK and optional top-level voice without changing the Aiden default', async () => {
  const selected = fixture('local', { voice: 'Tina' });
  await selected.start({ voice: 'Tina' });
  const session = await selected.client.ready;
  assert.equal(selected.socket.sent[0].session.voice, 'Tina');
  assert.equal(selected.socket.sent[0].session.enable_voice_clone, false);
  assert.equal(session.voice, 'Tina');
  selected.client.append(Buffer.alloc(320));
  assert.equal(selected.socket.sent[1].type, 'input_audio_buffer.append');
  selected.client.abort();

  for (const field of ['nested', 'top-level']) {
    const rejected = fixture('local', { voice: 'Tina' });
    const patch = field === 'nested'
      ? { audio: { ...rejected.session().audio, output: { ...rejected.session().audio.output, voice: 'Aiden' } } }
      : { voice: 'Aiden' };
    // eslint-disable-next-line no-await-in-loop -- Every incompatible voice has one isolated fake socket.
    await assert.rejects(rejected.start(patch), /CONFIGURATION_REJECTED/);
    assert.equal(rejected.protocolDiagnostics[0].expected, 'Tina');
    assert.equal(rejected.socket.sent.filter((event) => event.type === 'input_audio_buffer.append').length, 0);
    assert.equal(rejected.addresses.length, 1);
  }
  const response = fixture('local', { voice: 'Tina' });
  await response.start();
  response.receive({ type: 'response.created', response: { id: 'wrong_response_voice', status: 'in_progress', voice: 'Aiden' } });
  assert.equal(response.errors[0].code, 'LIVETRANSLATE_CONFIGURATION_REJECTED');
  assert.equal(response.protocolDiagnostics[0].validationPath, 'response.voice');
  assert.equal(response.protocolDiagnostics[0].expected, 'Tina');
  assert.equal(response.socket.sent.length, 1);

  const unchanged = fixture();
  await unchanged.start();
  assert.equal(unchanged.socket.sent[0].session.voice, 'Aiden');
  unchanged.client.abort();
  assert.throws(() => fixture('local', { voice: 'unlisted' as any }), /CONFIG_INVALID/);
});

test('the explicit Andre/Tina exception retains nested metadata and requires the exact local pair and same-ACK warning', async () => {
  const selected = fixture('local', { voice: 'Andre', allowAndreTopLevelWithTinaOutput: true });
  const actual = selected.session();
  await selected.start({ voice: 'Andre', audio: {
    ...actual.audio, output: { ...actual.audio.output, voice: 'Tina' },
  } });
  const confirmed = await selected.client.ready;
  assert.equal(selected.socket.sent[0].session.voice, 'Andre');
  assert.equal(selected.socket.sent[0].session.enable_voice_clone, false);
  assert.equal(confirmed.voice, 'Tina');
  assert.equal(confirmed.requestedVoice, 'Andre');
  assert.equal(confirmed.topLevelVoice, 'Andre');
  assert.equal(confirmed.voiceConfirmation, 'approved_top_level_andre_nested_tina');
  assert.deepEqual(confirmed.sessionOutputVoiceEcho, { status: 'reported', value: 'Tina', actualType: 'string' });
  assert.equal(confirmed.voicePolicy?.requestedVoice, 'Andre');
  assert.equal(confirmed.voicePolicy?.mode, 'approved_andre_tina_metadata_conflict');
  assert.deepEqual(confirmed.voicePolicy?.responseVoiceAllowlist, ['Andre', 'Tina']);
  assert.equal(confirmed.voicePolicy?.acousticVoice, 'unknown_not_measured');
  assert.equal(selected.sessionConfigurations[0].voice, 'Tina');
  assert.equal(selected.sessionConfigurations[0].requestedVoice, 'Andre');
  assert.equal(selected.sessionConfigurations[0].topLevelVoice, 'Andre');
  const warning = selected.protocolDiagnostics[0];
  assert.equal(warning.code, 'LIVETRANSLATE_APPROVED_ANDRE_TINA_CONFLICT');
  assert.equal(warning.fatal, false);
  assert.equal(warning.validationPath, 'session.audio.output.voice');
  assert.deepEqual(warning.acknowledgement, {
    sessionId: confirmed.sessionId,
    eventId: confirmed.configurationAcknowledgement.eventId,
    receiveSequence: confirmed.configurationAcknowledgement.receiveSequence,
  });
  assert.equal(warning.at, confirmed.configurationAcknowledgement.receivedAt);
  selected.receive({ type: 'response.created', response: {
    id: 'reported_tina_response', status: 'in_progress', voice: 'Tina',
  } });
  assert.equal(selected.errors.length, 0);
  selected.client.append(Buffer.alloc(320));
  assert.equal(selected.socket.sent[1].type, 'input_audio_buffer.append');
  selected.client.abort();

  const strict = fixture('local', { voice: 'Andre' });
  const strictSession = strict.session();
  await assert.rejects(strict.start({ voice: 'Andre', audio: {
    ...strictSession.audio, output: { ...strictSession.audio.output, voice: 'Tina' },
  } }), /CONFIGURATION_REJECTED/);
  assert.equal(strict.socket.sent.length, 1);
  assert.equal(strict.protocolDiagnostics[0].fatal, true);
  const exact = fixture('local', { voice: 'Andre', allowAndreTopLevelWithTinaOutput: true });
  await exact.start({ voice: 'Andre' });
  const exactSession = await exact.client.ready;
  assert.equal(exactSession.voicePolicy?.mode, 'strict_requested_voice');
  assert.deepEqual(exactSession.voicePolicy?.responseVoiceAllowlist, ['Andre']);
  exact.receive({ type: 'response.created', response: { id: 'r1', status: 'in_progress', voice: 'Tina' } });
  assert.equal(exact.errors[0].code, 'LIVETRANSLATE_CONFIGURATION_REJECTED');
  assert.equal(exact.protocolDiagnostics.at(-1).expected, 'Andre');
  assert.throws(() => fixture('remote', { voice: 'Andre', allowAndreTopLevelWithTinaOutput: true }), /CONFIG_INVALID/);
  assert.throws(() => fixture('local', { voice: 'Aiden', allowAndreTopLevelWithTinaOutput: true }), /CONFIG_INVALID/);
  assert.throws(() => fixture('local', { voice: 'Tina', allowAndreTopLevelWithTinaOutput: true }), /CONFIG_INVALID/);
});

test('voice evidence keeps every layer independent and validates repeated response-done declarations without repeating usage', async () => {
  const f = fixture('local', { voice: 'Andre', allowAndreTopLevelWithTinaOutput: true });
  const session = f.session();
  const nested = { ...session.audio, output: { ...session.audio.output, voice: 'Tina' } };
  f.receive({ type: 'session.created', session: { ...session, audio: nested } });
  f.receive({ type: 'session.updated', session: { ...session, voice: 'Andre', audio: nested } });
  const confirmed = await f.client.ready;
  assert.equal(f.voiceEvidence[0].policyMode, 'awaiting_configuration');
  assert.equal(f.voiceEvidence[0].sessionTopLevelEcho.status, 'missing');
  assert.equal(f.voiceEvidence[0].sessionNestedEcho.value, 'Tina');
  assert.equal(f.voiceEvidence[1].sessionTopLevelEcho.value, 'Andre');
  assert.equal(f.voiceEvidence[1].sessionNestedEcho.value, 'Tina');
  assert(Object.isFrozen(confirmed.voicePolicy));
  assert(Object.isFrozen(confirmed.voicePolicy!.responseVoiceAllowlist));
  f.receive({ type: 'response.created', response: {
    id: 'r1', conversation_id: '', status: 'in_progress', voice: 'Andre',
  } });
  f.done('r1', { voice: 'Tina', output: [], usage: { input_tokens: 2, output_tokens: 3 } });
  f.done('r1', { voice: 'Andre', output: [], usage: { input_tokens: 200, output_tokens: 300 } });
  assert.equal(f.errors.length, 0);
  assert.equal(f.usages.length, 1);
  assert.equal(f.usages[0].inputTokens, 2);
  assert.equal(f.timings.filter((event) => event.stage === 'response_completed').length, 1);
  assert.deepEqual(f.voiceEvidence.slice(2).map((event) => event.responseEcho.value), ['Andre', 'Tina', 'Andre']);
  assert(f.voiceEvidence.every((event) => event.requestedVoice === 'Andre' && event.acousticVoice === 'unknown_not_measured'));
  assert.equal(f.socket.sent[0].session.voice, 'Andre');
  assert.equal(confirmed.sessionOutputVoiceEcho?.value, 'Tina');
  f.done('r1', { voice: 'Aiden', output: [] });
  assert.equal(f.errors[0].code, 'LIVETRANSLATE_CONFIGURATION_REJECTED');
  assert.equal(f.protocolDiagnostics.at(-1).validationPath, 'response.voice');
  assert.equal(f.protocolDiagnostics.at(-1).expected, 'Andre_or_Tina_declaration');
  assert.equal(f.voiceEvidence.at(-1).acceptedByVoicePolicy, false);
  assert.equal(f.voiceEvidence.at(-1).responseEcho.value, 'Aiden');
  assert.equal(f.usages.length, 1);
});

test('a missing response declaration stays unknown while unsupported values and invalid types still stop the approved pair', async () => {
  for (const declaration of [undefined, null, 7, true, {}, [], 'SYNTHETIC_PRIVATE_UNLISTED_VOICE']) {
    const f = fixture('local', { voice: 'Andre', allowAndreTopLevelWithTinaOutput: true });
    const session = f.session();
    // eslint-disable-next-line no-await-in-loop -- Each declaration uses a separate fake protocol session.
    await f.start({ voice: 'Andre', audio: { ...session.audio, output: { ...session.audio.output, voice: 'Tina' } } });
    f.receive({ type: 'response.created', response: { id: 'r1', status: 'in_progress', voice: declaration } });
    const echo = f.voiceEvidence.at(-1).responseEcho;
    if (declaration === undefined) {
      assert.equal(f.errors.length, 0);
      assert.deepEqual(echo, { status: 'missing', value: null, actualType: 'missing' });
      assert.equal(f.voiceEvidence.at(-1).acceptedByVoicePolicy, true);
      f.client.abort();
    } else {
      assert.equal(f.errors[0].code, 'LIVETRANSLATE_CONFIGURATION_REJECTED');
      assert.equal(echo.value, null);
      assert.equal(echo.status, typeof declaration === 'string' ? 'unsupported_value' : 'invalid_type');
      assert.equal(f.voiceEvidence.at(-1).acceptedByVoicePolicy, false);
    }
    assert.equal(JSON.stringify(f.voiceEvidence).includes('SYNTHETIC_PRIVATE_UNLISTED_VOICE'), false);
    assert.equal(f.socket.sent.length, 1);
  }
});

test('Tina, absent voice, clone uncertainty and wrong language stop with safe evidence and zero input', async () => {
  const patches = [
    (session: any) => ({ audio: { ...session.audio, output: { ...session.audio.output, voice: 'Tina' } } }),
    (session: any) => ({ audio: { ...session.audio, output: { ...session.audio.output, voice: undefined } } }),
    () => ({ enable_voice_clone: undefined }),
    () => ({ enable_voice_clone: true }),
    () => ({ translation: { language: 'zh' } }),
  ];
  for (const patch of patches) {
    const f = fixture();
    const sessionPatch = patch(f.session());
    const expected = Object.hasOwn(sessionPatch, 'enable_voice_clone') && sessionPatch.enable_voice_clone === undefined
      ? /CLONE_CONFIRMATION_MISSING/ : /CONFIGURATION_REJECTED/;
    // eslint-disable-next-line no-await-in-loop -- Each rejected configuration gets one isolated fake socket.
    await assert.rejects(f.start(sessionPatch), expected);
    assert.throws(() => f.client.append(Buffer.alloc(320)), expected);
    assert.equal(f.socket.sent.filter((event) => event.type === 'input_audio_buffer.append').length, 0);
    assert.equal(f.addresses.length, 1);
    assert.equal(f.sessionConfigurations.length, 1);
    assert.equal(f.sessionConfigurations[0].accepted, false);
  }
});

test('a rejected WSS upgrade records only the bounded HTTP status and never sends input', async () => {
  const f = fixture();
  let destroyed = 0;
  f.socket.emit('unexpected-response', {}, {
    statusCode: 403,
    destroy() { destroyed += 1; },
  });
  await assert.rejects(f.client.ready, /CONNECTION_FAILED/);
  assert.deepEqual(f.errors, [{ code: 'LIVETRANSLATE_CONNECTION_FAILED', httpStatusCode: 403 }]);
  assert.equal(destroyed, 1);
  assert.equal(f.socket.sent.length, 0);
  assert.equal(f.addresses.length, 1);
});

test('changed model, voice, clone, format or target is rejected before audio input', async () => {
  for (const patch of [
    { model: 'qwen3.5-livetranslate-flash-realtime' },
    { enable_voice_clone: true },
    { enable_voice_clone: undefined },
    {
      audio: {
        input: { format: { type: 'pcm', sample_rate: 24000 } },
        output: { voice: 'loongandy_v3' },
      },
    },
    { translation: { language: 'zh' } },
  ]) {
    const f = fixture();
    const expected = Object.hasOwn(patch, 'enable_voice_clone') && patch.enable_voice_clone === undefined
      ? /CLONE_CONFIRMATION_MISSING/ : /CONFIGURATION_REJECTED/;
    // eslint-disable-next-line no-await-in-loop -- Each rejected ACK has a separate fake transport.
    await assert.rejects(f.start(patch), expected);
    assert.equal(f.socket.terminated, 1);
    assert.equal(f.addresses.length, 1);
    assert.equal(f.audio.length, 0);
  }
});

test('3.8 append deltas preserve true repetition, completed raw source and direct source-to-translation association', async () => {
  const f = fixture();
  await f.start();
  f.receive({
    type: 'input_audio_buffer.speech_started',
    item_id: 'source_1',
    speaker_id: 2,
    audio_start_ms: 500,
  });
  f.receive({
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: 'source_1',
    content_index: 0,
    delta: '不，',
  });
  f.receive({
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: 'source_1',
    content_index: 0,
    delta: '不要重复收费。',
  });
  f.source('source_1', '不，不要重复收费。');
  f.link();
  f.delta(
    'response.audio_transcript.delta',
    { delta: 'Do not ' },
    undefined,
    undefined,
    'same',
  );
  f.delta(
    'response.audio_transcript.delta',
    { delta: 'Do not ' },
    undefined,
    undefined,
    'same',
  );
  f.delta('response.audio_transcript.delta', { delta: 'charge twice.' });
  f.delta(
    'response.audio.delta',
    { delta: Buffer.alloc(480).toString('base64') },
    undefined,
    undefined,
    'audio1',
  );
  f.delta(
    'response.audio.delta',
    { delta: Buffer.alloc(480).toString('base64') },
    undefined,
    undefined,
    'audio1',
  );
  f.delta('response.audio.delta', {
    delta: Buffer.alloc(480).toString('base64'),
  });
  f.delta('response.audio_transcript.done', { transcript: 'Do not charge twice.' });
  f.delta('response.audio.done', {});
  f.done();
  assert.equal(f.sources.at(-1).text, '不，不要重复收费。');
  assert.equal(f.translations.at(-1).text, 'Do not charge twice.');
  assert.equal(f.translations.at(-1).final, true);
  assert.equal(f.translations.at(-1).sourceId, 'source_1');
  assert.deepEqual(
    f.audio.map((chunk) => chunk.metadata.sequence),
    [1, 2],
  );
  assert.equal(
    f.timings.filter((event) => event.stage === 'audio_first_sample').length,
    1,
  );
  assert.equal(f.usages[0].basis, 'unknown');
  f.client.abort();
});

test('unpaired output stays unpaired until a known current-session source edge arrives; no assistant-chain guessing or audio replay', async () => {
  const f = fixture();
  await f.start();
  f.delta('response.audio_transcript.delta', {
    delta: 'Synthetic current output.',
  });
  f.delta('response.audio.delta', {
    delta: Buffer.alloc(480).toString('base64'),
  });
  f.link('translation_1', 'source_1');
  assert.equal(f.associations.length, 0);
  assert.equal(f.translations.at(-1).pairing, 'unpaired');
  f.source();
  assert.equal(f.associations.length, 1);
  assert.equal(f.translations.at(-1).pairing, 'explicit');
  assert.equal(f.audio.length, 1);
  f.link('translation_2', 'translation_1');
  f.delta(
    'response.audio_transcript.delta',
    { delta: 'Another output.' },
    'translation_2',
    'response_2',
  );
  assert.equal(f.translations.at(-1).pairing, 'unpaired');
  assert.equal(f.associations.length, 1);
  f.client.abort();
});

test('distinct response IDs remain isolated across interleaving, repeated words and late old completion events', async () => {
  const f = fixture('remote');
  await f.start();
  f.source('s1', 'First raw.');
  f.source('s2', 'Second raw.');
  f.link('t1', 's1');
  f.link('t2', 's2');
  f.delta('response.text.delta', { delta: '不要' }, 't1', 'r1');
  f.delta('response.text.delta', { delta: '五十' }, 't2', 'r2');
  f.delta('response.text.delta', { delta: '取消' }, 't1', 'r1');
  f.delta('response.text.delta', { delta: '五十' }, 't2', 'r2');
  f.done('r1');
  f.delta('response.text.delta', { delta: '迟到旧字' }, 't1', 'r1');
  f.done('r2');
  assert.equal(
    f.translations.filter((event) => event.translationId === 't1').at(-1).text,
    '不要取消',
  );
  assert.equal(
    f.translations.filter((event) => event.translationId === 't2').at(-1).text,
    '五十五十',
  );
  assert(!f.translations.some((event) => event.text.includes('迟到旧字')));
  assert.equal(f.audio.length, 0);
  f.client.abort();
});

test('response.done confirms consistent full text, usage is consumed once and text.done alone does not imply successful completion', async () => {
  const f = fixture('remote');
  await f.start();
  f.source();
  f.link();
  f.delta('response.text.delta', { delta: '十五' });
  f.delta('response.text.done', { text: '五十元，不是十五元。' });
  assert.equal(f.translations.at(-1).final, false);
  f.done('response_1', {
    output: [
      {
        id: 'translation_1',
        content: [{ type: 'text', text: '五十元，不是十五元。' }],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      total_tokens: 13,
      input_tokens_details: { audio_tokens: 10, text_tokens: 0 },
      output_tokens_details: { text_tokens: 3, audio_tokens: 0 },
    },
  });
  f.done();
  assert.equal(f.translations.at(-1).text, '五十元，不是十五元。');
  assert.equal(f.translations.at(-1).final, true);
  assert.equal(f.usages.length, 1);
  assert.equal(f.usages[0].inputAudioTokens, 10);
  f.client.abort();
});

test('normal finish drains late tail without response.create/cancel then closes after session.finished', async () => {
  const f = fixture();
  await f.start();
  const done = f.client.finish();
  assert.equal(f.client.finish(), done);
  f.source();
  f.link();
  f.delta('response.audio_transcript.delta', { delta: 'Final tail.' });
  f.delta('response.audio.delta', {
    delta: Buffer.alloc(480).toString('base64'),
  });
  f.delta('response.audio_transcript.done', { transcript: 'Final tail.' });
  f.delta('response.audio.done', {});
  f.done();
  f.receive({ type: 'session.finished' });
  await done;
  assert.equal(f.audio.length, 1);
  assert.equal(f.socket.closed, 1);
  assert.equal(f.socket.terminated, 0);
  assert.deepEqual(
    f.socket.sent.map((event) => event.type),
    ['session.update', 'session.finish'],
  );
});

test('remote audio, nonzero indices, conflicting duplicate IDs and mixed 3.5 events fail closed', async () => {
  for (const kind of ['remoteAudio', 'index', 'duplicate', 'oldModel']) {
    const f = fixture(kind === 'remoteAudio' ? 'remote' : 'local');
    // eslint-disable-next-line no-await-in-loop -- Independent invalid-event fake sessions.
    await f.start();
    if (kind === 'remoteAudio')
      f.delta('response.audio.delta', {
        delta: Buffer.alloc(480).toString('base64'),
      });
    if (kind === 'index')
      f.delta('response.audio_transcript.delta', {
        delta: 'Text',
        content_index: 1,
      });
    if (kind === 'duplicate') {
      f.delta(
        'response.audio_transcript.delta',
        { delta: 'First' },
        undefined,
        undefined,
        'conflict',
      );
      f.delta(
        'response.audio_transcript.delta',
        { delta: 'PRIVATE changed body' },
        undefined,
        undefined,
        'conflict',
      );
    }
    if (kind === 'oldModel')
      f.delta('response.audio_transcript.text', {
        text: 'old',
        stash: 'PRIVATE',
      });
    assert.equal(f.errors.length, 1);
    assert.equal(f.socket.terminated, 1);
    assert(!JSON.stringify(f.errors).includes('PRIVATE'));
    assert.equal(f.audio.length, 0);
  }
});

test('abort, callback failures and transport close fence all late work and preserve private error/close text', async () => {
  const aborted = fixture();
  await aborted.start();
  aborted.client.abort();
  aborted.source();
  aborted.delta('response.audio.delta', {
    delta: Buffer.alloc(480).toString('base64'),
  });
  assert.equal(aborted.audio.length, 0);
  assert.equal(aborted.sources.length, 0);
  assert.equal(aborted.addresses.length, 1);
  const f = fixture('remote', {
    onTranslation() {
      throw new Error('PRIVATE callback token');
    },
  });
  await f.start();
  f.delta('response.text.delta', { delta: '合成句段' });
  assert.equal(f.errors[0].code, 'LIVETRANSLATE_CALLBACK_FAILED');
  assert.equal(f.socket.terminated, 1);
  const closed = fixture();
  await closed.start();
  closed.socket.emit('close', 1006, Buffer.from('PRIVATE close reason'));
  assert.deepEqual(closed.errors, [
    { code: 'LIVETRANSLATE_CONNECTION_CLOSED', closeCode: 1006 },
  ]);
  assert(!JSON.stringify([...f.errors, ...closed.errors]).includes('PRIVATE'));
});

test('startup/drain timeouts never reconnect and provider rejection never falls back to another model', async () => {
  const f = fixture('local', { timeoutMs: 5 });
  await delay(12);
  await assert.rejects(f.client.ready, /READY_TIMEOUT/);
  assert.equal(f.protocolDiagnostics[0].validationPath, 'transport.ready_timeout');
  assert.equal(f.protocolDiagnostics[0].actualType, 'string');
  assert.equal(f.protocolDiagnostics[0].eventType, null);
  assert.equal(f.addresses.length, 1);
  const drain = fixture('local', { timeoutMs: 5 });
  await drain.start();
  const finish = drain.client.finish();
  await delay(12);
  await assert.rejects(finish, /FINISH_TIMEOUT/);
  assert.equal(drain.protocolDiagnostics[0].validationPath, 'transport.finish_timeout');
  assert.equal(drain.protocolDiagnostics[0].actualType, 'string');
  assert.equal(drain.protocolDiagnostics[0].eventType, null);
  const rejected = fixture();
  rejected.receive({
    type: 'error',
    error: { message: 'PRIVATE provider key', code: 'whatever' },
  });
  assert.equal(rejected.errors[0].code, 'LIVETRANSLATE_PROVIDER_REJECTED');
  assert.equal(rejected.addresses.length, 1);
});

test('response-created observes every unique response before output and full-translation arrival has its own earlier timestamp', async () => {
  let clock = 1000;
  const f = fixture('remote', { now: () => clock });
  await f.start();
  f.receive({
    type: 'response.created',
    response: { id: 'response_1', status: 'in_progress' },
  });
  f.receive({
    type: 'response.created',
    response: { id: 'response_1', status: 'in_progress' },
  });
  assert.equal(
    f.timings.filter((event) => event.stage === 'response_created').length,
    1,
  );
  assert.equal(f.translations.length, 0);
  clock = 1200;
  f.delta('response.text.delta', { delta: '五十' });
  clock = 1500;
  f.delta('response.text.done', { text: '五十元，不是十五元。' });
  clock = 1900;
  f.done();
  assert.equal(
    f.timings.find((event) => event.stage === 'translation_completed').at,
    1500,
  );
  assert.equal(
    f.timings.find((event) => event.stage === 'response_completed').at,
    1900,
  );
  f.client.abort();
});

test('fixed diagnosis whitelist retains concrete causes and refuses arbitrary prefixed secrets', () => {
  assert(LIVE_TRANSLATE_FAILURE_CODES.length > 20);
  for (const code of LIVE_TRANSLATE_FAILURE_CODES) {
    assert.equal(isLiveTranslateFailureCode(code), true);
    assert.equal(isLiveTranslateFailureCode(`${code}: PRIVATE body`), false);
  }
  for (const unknown of [
    'LIVETRANSLATE_SECRET_KEY_BODY',
    'LIVETRANSLATE_WHATEVER',
    new Error('private'),
    undefined,
    1006,
  ])
    assert.equal(isLiveTranslateFailureCode(unknown), false);
});

test('JSON field order does not create a false duplicate conflict, while identical PCM in later responses remains distinct', async () => {
  const f = fixture();
  await f.start();
  const first = {
    event_id: 'field_order',
    type: 'response.audio_transcript.delta',
    response_id: 'r1',
    item_id: 't1',
    output_index: 0,
    content_index: 0,
    delta: 'Repeat.',
  };
  f.receive(first);
  f.receive(Object.fromEntries(Object.entries(first).reverse()));
  assert.equal(f.translations.length, 1);
  const pcm = Buffer.alloc(480).toString('base64');
  f.delta('response.audio.delta', { delta: pcm }, 't1', 'r1');
  f.delta('response.audio_transcript.done', { transcript: 'Repeat.' }, 't1', 'r1');
  f.delta('response.audio.done', {}, 't1', 'r1');
  f.done('r1');
  f.delta('response.audio.delta', { delta: pcm }, 't1', 'r1');
  f.delta('response.audio.delta', { delta: pcm }, 't2', 'r2');
  assert.deepEqual(
    f.audio.map((chunk) => chunk.metadata.sequence),
    [1, 2],
  );
  assert.deepEqual(
    f.audio.map((chunk) => chunk.metadata.responseId),
    ['r1', 'r2'],
  );
  assert.deepEqual(f.errors, []);
  f.client.abort();
});

test('session-finished cannot silently drop an unfinished raw-source tail or an unfinished response', async () => {
  for (const kind of ['source', 'response']) {
    const f = fixture();
    // eslint-disable-next-line no-await-in-loop -- Each incomplete tail uses an isolated fake session.
    await f.start();
    if (kind === 'source')
      f.receive({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'source_1',
        content_index: 0,
        delta: '尚未定稿的尾句',
      });
    else
      f.receive({
        type: 'response.created',
        response: { id: 'r1', status: 'in_progress' },
      });
    const finished = f.client.finish();
    f.receive({ type: 'session.finished' });
    // eslint-disable-next-line no-await-in-loop -- Verify each pending finish rejects its own missing tail.
    await assert.rejects(finished, /FINISH_INCOMPLETE/);
    assert.equal(f.socket.terminated, 1);
  }
});

test('failed or incomplete response done cannot finalize captions and still reports supplied generated usage', async () => {
  for (const status of ['failed', 'incomplete', 'cancelled']) {
    const f = fixture('remote');
    // eslint-disable-next-line no-await-in-loop -- Separate fake supplier terminal states.
    await f.start();
    f.delta('response.text.delta', { delta: '临时译文' });
    f.delta('response.text.done', { text: '仍未证明成功的完整文本' });
    f.done('response_1', {
      status,
      usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
    });
    assert.equal(f.errors[0].code, 'LIVETRANSLATE_RESPONSE_INCOMPLETE');
    assert(!f.translations.some((event) => event.final));
    assert.equal(f.usages.length, 1);
    assert.equal(f.usages[0].outputTokens, 4);
    assert.equal(f.socket.terminated, 1);
  }
});

test('a translation output cannot reuse a known source item identity in either arrival direction', async () => {
  const positive = fixture('remote');
  await positive.start();
  positive.source('shared', 'Synthetic source.');
  positive.delta('response.text.delta', { delta: '合成译文' }, 'shared', 'r1');
  assert.equal(positive.errors[0].code, 'LIVETRANSLATE_ITEM_CONFLICT');
  assert.equal(positive.protocolDiagnostics[0].validationPath, 'item_id');
  assert.equal(positive.protocolDiagnostics[0].expected, 'consistent_item_binding');
  assert.equal(positive.translations.length, 0);
  const linked = fixture('remote');
  await linked.start();
  linked.source('shared', 'Synthetic source.');
  linked.link('shared', 'source_other');
  assert.equal(linked.errors[0].code, 'LIVETRANSLATE_ITEM_CONFLICT');
  const reverse = fixture('remote');
  await reverse.start();
  reverse.delta('response.text.delta', { delta: '合成译文' }, 'shared', 'r1');
  reverse.source('shared', 'Synthetic source.');
  assert.equal(reverse.errors[0].code, 'LIVETRANSLATE_ITEM_CONFLICT');
});

test('response-created FIFO streams the head immediately and buffers interleaved later audio until explicit head audio completion', async () => {
  const f = fixture();
  await f.start();
  f.created('r1');
  f.created('r2');
  f.delta(
    'response.audio.delta',
    { delta: Buffer.alloc(4, 1).toString('base64') },
    't1',
    'r1',
  );
  assert.deepEqual(
    f.audio.map((chunk) => chunk.pcm[0]),
    [1],
  );
  f.delta(
    'response.audio.delta',
    { delta: Buffer.alloc(4, 2).toString('base64') },
    't2',
    'r2',
  );
  f.delta(
    'response.audio.delta',
    { delta: Buffer.alloc(4, 3).toString('base64') },
    't1',
    'r1',
  );
  assert.deepEqual(
    f.audio.map((chunk) => chunk.pcm[0]),
    [1, 3],
  );
  f.delta('response.audio.done', {}, 't2', 'r2');
  assert.deepEqual(
    f.audio.map((chunk) => chunk.pcm[0]),
    [1, 3],
  );
  f.delta('response.audio.done', {}, 't1', 'r1');
  assert.deepEqual(
    f.audio.map((chunk) => chunk.pcm[0]),
    [1, 3, 2],
  );
  assert.deepEqual(
    f.audio.map((chunk) => chunk.metadata.sequence),
    [1, 2, 3],
  );
  assert.deepEqual(
    f.audio.map((chunk) => chunk.metadata.responseId),
    ['r1', 'r1', 'r2'],
  );
  f.delta(
    'response.audio.delta',
    { delta: Buffer.alloc(4, 9).toString('base64') },
    't1',
    'r1',
  );
  assert.equal(f.audio.length, 3);
  assert.equal(
    f.timings.filter((event) => event.stage === 'audio_first_sample').length,
    2,
  );
  f.client.abort();
});

test('audio without official response.created order is rejected instead of inventing playback order', async () => {
  const f = fixture();
  await f.start();
  f.receive({
    type: 'response.audio.delta',
    item_id: 't1',
    response_id: 'r1',
    output_index: 0,
    content_index: 0,
    delta: Buffer.alloc(4).toString('base64'),
  });
  assert.equal(f.errors[0].code, 'LIVETRANSLATE_RESPONSE_ORDER_UNKNOWN');
  assert.equal(f.protocolDiagnostics[0].validationPath, 'response.id');
  assert.equal(f.protocolDiagnostics[0].expected, 'response_created_before_output');
  assert.equal(f.audio.length, 0);
  assert.equal(f.socket.terminated, 1);
});

test('observed speech with no ASR final is an incomplete tail even with empty text; explicit empty final can represent no effective speech', async () => {
  const missing = fixture('remote');
  await missing.start();
  missing.receive({
    type: 'input_audio_buffer.speech_started',
    item_id: 's1',
    speaker_id: 1,
    audio_start_ms: 10,
  });
  missing.receive({
    type: 'input_audio_buffer.speech_stopped',
    item_id: 's1',
    audio_end_ms: 200,
  });
  const pending = missing.client.finish();
  missing.receive({ type: 'session.finished' });
  await assert.rejects(pending, /FINISH_INCOMPLETE/);
  const empty = fixture('remote');
  await empty.start();
  empty.receive({
    type: 'input_audio_buffer.speech_started',
    item_id: 's1',
    speaker_id: 1,
    audio_start_ms: 10,
  });
  empty.source('s1', '');
  const finish = empty.client.finish();
  empty.receive({ type: 'session.finished' });
  await finish;
  assert.equal(empty.socket.closed, 1);
});

test('a silent nonempty local translation response cannot hide behind audio from another response', async () => {
  const f = fixture();
  await f.start();
  f.delta(
    'response.audio_transcript.delta',
    { delta: 'First valid sentence.' },
    't1',
    'r1',
  );
  f.delta(
    'response.audio.delta',
    { delta: Buffer.alloc(4, 1).toString('base64') },
    't1',
    'r1',
  );
  f.delta('response.audio_transcript.done', { transcript: 'First valid sentence.' }, 't1', 'r1');
  f.delta('response.audio.done', {}, 't1', 'r1');
  f.done('r1');
  assert.equal(f.audio.length, 1);
  f.delta(
    'response.audio_transcript.delta',
    { delta: 'Second sentence lacks all audio.' },
    't2',
    'r2',
  );
  f.delta('response.audio_transcript.done', { transcript: 'Second sentence lacks all audio.' }, 't2', 'r2');
  f.done('r2');
  assert.equal(f.errors[0].code, 'LIVETRANSLATE_RESPONSE_AUDIO_MISSING');
  assert.equal(f.protocolDiagnostics[0].validationPath, 'response.audio.done');
  assert(
    !f.translations.some(
      (event) => event.translationId === 't2' && event.final,
    ),
  );
  assert.equal(f.socket.terminated, 1);
});

test('queued future-response audio is bounded and abort clears every queued and late chunk', async () => {
  const f = fixture();
  await f.start();
  f.created('head');
  f.created('future');
  f.delta(
    'response.audio.delta',
    { delta: Buffer.alloc(4, 2).toString('base64') },
    'futureItem',
    'future',
  );
  assert.equal(f.audio.length, 0);
  f.client.abort();
  f.delta('response.audio.done', {}, 'headItem', 'head');
  assert.equal(f.audio.length, 0);
  const bounded = fixture();
  await bounded.start();
  bounded.created('head');
  bounded.created('future');
  const pcm = Buffer.alloc(256 * 1024).toString('base64');
  for (let i = 0; i < 9; i += 1)
    bounded.delta(
      'response.audio.delta',
      { delta: pcm },
      'futureItem',
      'future',
    );
  assert.equal(bounded.errors[0].code, 'LIVETRANSLATE_AUDIO_QUEUE_LIMIT');
  assert.equal(bounded.audio.length, 0);
  assert.equal(bounded.socket.terminated, 1);
});

test('a directly bound nonempty final source cannot complete with empty translation output in either direction', async () => {
  for (const role of ['local', 'remote'] as const) {
    const f = fixture(role);
    // eslint-disable-next-line no-await-in-loop -- Each direction has a separate fake supplier session.
    await f.start();
    f.source('source_1', 'Synthetic nonempty raw source.');
    f.link();
    f.done('response_1', {
      output: [{ id: 'translation_1', role: 'assistant', content: [] }],
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
    });
    assert.equal(f.errors[0]?.code, 'LIVETRANSLATE_RESPONSE_INCOMPLETE');
    assert.equal(f.audio.length, 0);
    assert(!f.translations.some((event) => event.final));
    assert.equal(f.usages[0].outputTokens, 1);
    assert.equal(f.socket.terminated, 1);
  }
});

test('late final ASR or a missing response output cannot bypass explicit-source consistency at session finish', async () => {
  for (const role of ['local', 'remote'] as const) {
    for (const shape of ['lateFinal', 'noOutputItem']) {
      const f = fixture(role);
      // eslint-disable-next-line no-await-in-loop -- Isolated direction and missing-output ordering cases.
      await f.start();
      if (shape === 'noOutputItem')
        f.source('source_1', 'Synthetic nonempty raw source.');
      f.link();
      f.done('response_1', {
        output:
          shape === 'lateFinal'
            ? [{ id: 'translation_1', role: 'assistant', content: [] }]
            : [],
      });
      if (shape === 'lateFinal')
        f.source('source_1', 'Synthetic late final raw source.');
      const finished = f.client.finish();
      f.receive({ type: 'session.finished' });
      // eslint-disable-next-line no-await-in-loop -- Each finish must reject its own explicitly missing translation.
      await assert.rejects(finished, /FINISH_INCOMPLETE/);
      assert.equal(f.errors[0].code, 'LIVETRANSLATE_FINISH_INCOMPLETE');
      assert.equal(f.socket.terminated, 1);
      assert.equal(f.audio.length, 0);
    }
  }
});

test('audio from a directly bound nonempty source does not excuse its empty translated text', async () => {
  const f = fixture();
  await f.start();
  f.source();
  f.link();
  f.delta('response.audio.delta', {
    delta: Buffer.alloc(4, 1).toString('base64'),
  });
  f.done('response_1', {
    output: [{ id: 'translation_1', content: [] }],
  });
  assert.equal(f.errors[0]?.code, 'LIVETRANSLATE_RESPONSE_INCOMPLETE');
  assert.equal(f.audio.length, 1);
  assert(!f.translations.some((event) => event.final));
  assert.equal(f.socket.terminated, 1);
});

test('explicit empty final noise can have no output, while a nonempty source with unknown edges cannot finish successfully', async () => {
  for (const role of ['local', 'remote'] as const) {
    for (const kind of ['emptyNoise', 'unknownEdge']) {
      const f = fixture(role);
      // eslint-disable-next-line no-await-in-loop -- Separate known-noise and unknown-association fake sessions.
      await f.start();
      f.source('source_1', kind === 'emptyNoise' ? '' : 'Known raw source.');
      f.link('translation_1', kind === 'emptyNoise' ? 'source_1' : 'unknown');
      f.done('response_1', {
        output: [{ id: 'translation_1', content: [] }],
      });
      const finished = f.client.finish();
      f.receive({ type: 'session.finished' });
      if (kind === 'unknownEdge') {
        // eslint-disable-next-line no-await-in-loop -- Missing bindings fail independently in each synthetic role.
        await assert.rejects(finished, /FINISH_INCOMPLETE/);
        assert.equal(f.errors[0].code, 'LIVETRANSLATE_FINISH_INCOMPLETE');
      } else {
        // eslint-disable-next-line no-await-in-loop -- Explicit empty noise is allowed to finish without translation.
        await finished;
        assert.deepEqual(f.errors, []);
      }
      assert.equal(f.audio.length, 0);
      assert.equal(f.socket.closed, kind === 'unknownEdge' ? 0 : 1);
      if (kind === 'unknownEdge') {
        assert.equal(f.associations.length, 0);
        assert.equal(f.translations.at(-1).pairing, 'unpaired');
      }
    }
  }
});

test('speech ordering, source conflicts and send failures retain concrete safe validation paths', async () => {
  const speech = fixture();
  await speech.start();
  speech.receive({ type: 'input_audio_buffer.speech_started', item_id: 's1', audio_start_ms: 100 });
  speech.receive({ type: 'input_audio_buffer.speech_stopped', item_id: 's1', audio_end_ms: 50 });
  assert.equal(speech.errors[0].code, 'LIVETRANSLATE_EVENT_INVALID');
  assert.equal(speech.protocolDiagnostics[0].validationPath, 'audio_end_ms');
  assert.equal(speech.protocolDiagnostics[0].expected, 'nondecreasing_offset');
  assert.equal(speech.protocolDiagnostics[0].actualType, 'number');

  const binding = fixture('remote');
  await binding.start();
  binding.source('s1', 'Synthetic first source.');
  binding.source('s2', 'Synthetic second source.');
  binding.link('t1', 's1');
  binding.link('t1', 's2');
  assert.equal(binding.errors[0].code, 'LIVETRANSLATE_SOURCE_CONFLICT');
  assert.equal(binding.protocolDiagnostics[0].validationPath, 'source.binding');
  assert.equal(binding.protocolDiagnostics[0].actualType, 'string');

  const send = fixture();
  await send.start();
  send.socket.send = (_raw, callback) => callback?.(new Error('SYNTHETIC_PRIVATE_SEND_CANARY'));
  send.client.append(Buffer.alloc(320));
  assert.equal(send.errors[0].code, 'LIVETRANSLATE_SEND_FAILED');
  assert.equal(send.protocolDiagnostics[0].validationPath, 'transport.send');
  assert.equal(send.protocolDiagnostics[0].actualType, 'number');
  assert.equal(send.protocolDiagnostics[0].eventType, null);
  assert.equal(JSON.stringify(send.protocolDiagnostics).includes('SYNTHETIC_PRIVATE_SEND_CANARY'), false);

  const unavailable = fixture();
  await unavailable.start();
  unavailable.socket.readyState = WebSocket.CLOSED;
  unavailable.client.append(Buffer.alloc(320));
  assert.equal(unavailable.errors[0].code, 'LIVETRANSLATE_SEND_UNAVAILABLE');
  assert.equal(unavailable.protocolDiagnostics[0].validationPath, 'transport.send');
});
