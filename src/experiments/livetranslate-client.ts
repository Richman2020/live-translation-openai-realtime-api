/* eslint-disable no-continue -- Retired event/item snapshots must not be replayed. */
import { createHash } from 'node:crypto';
import createHttpsProxyAgent from 'https-proxy-agent';
import WebSocket from 'ws';

import { validOpenAIProxyUrl } from '../solo/openai-websocket';
import type {
  LiveTranslateClient,
  LiveTranslateClientOptions,
  LiveTranslateAudioMetadata,
  LiveTranslateSession,
  LiveTranslateSource,
  LiveTranslateTiming,
  LiveTranslateTranslation,
  LiveTranslateUsage,
} from './livetranslate-types';

export * from './livetranslate-types';
export const LIVE_TRANSLATE_MODEL = 'qwen3.8-livetranslate-flash-realtime';
export const LIVE_TRANSLATE_VOICE = 'Tina';
const MAX_ITEMS = 256;
const MAX_EVENTS = 4096;
const MAX_TEXT = 32768;
const MAX_BYTES = 1024 * 1024;
const MAX_QUEUED_AUDIO_BYTES = 2 * 1024 * 1024;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_:-]{1,200}$/u.test(value);
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Pure endpoint construction; this does not discover credentials or connect. */
export function buildLiveTranslateEndpoint(workspaceId: string): string {
  if (
    typeof workspaceId !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(workspaceId)
  )
    throw new Error('LIVETRANSLATE_WORKSPACE_INVALID');
  return `wss://${workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=${LIVE_TRANSLATE_MODEL}`;
}

function canonicalEvent(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalEvent).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalEvent(value[key])}`)
    .join(',')}}`;
}

type Source = LiveTranslateSource;
type Translation = LiveTranslateTranslation & {
  textDone: boolean;
  audioDone: boolean;
  audioSeen: boolean;
};
type ResponseState = {
  done: boolean;
  createdSeen: boolean;
  audioReleased: boolean;
  audio: { pcm: Buffer; eventId: string; item: Translation }[];
  outputs: Map<number, string>;
};

/** Independent prototype only. No production registration, retries or fallback. */
export function createLiveTranslateClient(
  options: LiveTranslateClientOptions,
): LiveTranslateClient {
  if (options.enabled !== true) throw new Error('LIVETRANSLATE_DISABLED');
  const endpoint = buildLiveTranslateEndpoint(options.workspaceId);
  const { role } = options;
  if (
    !['local', 'remote'].includes(role) ||
    typeof options.apiKey !== 'string' ||
    !options.apiKey.trim() ||
    (options.timeoutMs !== undefined &&
      (!integer(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        options.timeoutMs > 120000))
  )
    throw new Error('LIVETRANSLATE_CONFIG_INVALID');
  const now = options.now ?? Date.now;
  const modalities = role === 'local' ? ['text', 'audio'] : ['text'];
  const target = role === 'local' ? 'en' : 'zh';
  const proxy =
    options.proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxy && !validOpenAIProxyUrl(proxy))
    throw new Error('LIVETRANSLATE_PROXY_INVALID');
  let socket: WebSocket;
  try {
    socket = (
      options.createWebSocket ??
      ((url, settings) => new WebSocket(url, settings))
    )(endpoint, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      handshakeTimeout: options.timeoutMs ?? 20000,
      maxPayload: MAX_BYTES,
      ...(proxy ? { agent: createHttpsProxyAgent(proxy) } : {}),
    });
  } catch {
    throw new Error('LIVETRANSLATE_CONNECTION_FAILED');
  }
  const sources = new Map<string, Source>();
  const translations = new Map<string, Translation>();
  const associations = new Map<string, string>();
  const pendingAssociations = new Map<string, string>();
  const responses = new Map<string, ResponseState>();
  const seen = new Map<string, string>();
  const speechSeen = new Set<string>();
  const responseOrder: string[] = [];
  let queuedAudioBytes = 0;
  let drainingAudio = false;
  let state: 'connecting' | 'configuring' | 'ready' | 'finishing' | 'closed' =
    'connecting';
  let sessionId = '';
  let finishRequested = false;
  let audioSequence = 0;
  let failure = '';
  let readyResolve: (session: LiveTranslateSession) => void;
  let readyReject: (error: Error) => void;
  let finishResolve: () => void;
  let finishReject: (error: Error) => void;
  const ready = new Promise<LiveTranslateSession>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const finished = new Promise<void>((resolve, reject) => {
    finishResolve = resolve;
    finishReject = reject;
  });
  ready.catch(() => {});
  finished.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = () => state === 'closed';
  const cleanup = (graceful = false) => {
    clearTimeout(timer);
    timer = undefined;
    socket.removeAllListeners();
    socket.on('error', () => {});
    try {
      if (graceful && socket.readyState === WebSocket.OPEN) socket.close(1000);
      else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    } catch {
      /* Local fences remain effective even if teardown fails. */
    }
    sources.clear();
    translations.clear();
    associations.clear();
    pendingAssociations.clear();
    responses.clear();
    seen.clear();
    speechSeen.clear();
    responseOrder.length = 0;
    queuedAudioBytes = 0;
  };
  const fail = (code: string, closeCode?: unknown) => {
    if (closed()) return;
    state = 'closed';
    failure = code;
    cleanup();
    readyReject(new Error(code));
    finishReject(new Error(code));
    try {
      options.onError?.(
        code,
        integer(closeCode) && closeCode >= 1000 && closeCode <= 4999
          ? { closeCode }
          : {},
      );
    } catch {
      /* The original failure and cleanup cannot be overridden. */
    }
  };
  const emit = <T>(callback: ((event: T) => void) | undefined, event: T) => {
    if (closed()) return;
    try {
      callback?.(event);
    } catch {
      fail('LIVETRANSLATE_CALLBACK_FAILED');
    }
  };
  const timing = (
    stage: LiveTranslateTiming['stage'],
    metadata: Omit<
      LiveTranslateTiming,
      'stage' | 'at' | 'role' | 'sessionId'
    > = {},
  ) =>
    emit(options.onTiming, { role, sessionId, stage, at: now(), ...metadata });
  const arm = (code: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => fail(code), options.timeoutMs ?? 20000);
  };
  const send = (event: unknown) => {
    if (closed()) return;
    if (
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount > MAX_BYTES
    ) {
      fail('LIVETRANSLATE_SEND_UNAVAILABLE');
      return;
    }
    try {
      socket.send(JSON.stringify(event), (error) => {
        if (error) fail('LIVETRANSLATE_SEND_FAILED');
      });
    } catch {
      fail('LIVETRANSLATE_SEND_FAILED');
    }
  };
  const sendFinish = () => {
    if (closed() || state === 'finishing') return;
    state = 'finishing';
    arm('LIVETRANSLATE_FINISH_TIMEOUT');
    send({ type: 'session.finish' });
  };
  const showTranslation = (item: Translation) => {
    emit(options.onTranslation, {
      role: item.role,
      sessionId: item.sessionId,
      translationId: item.translationId,
      responseId: item.responseId,
      ...(item.sourceId ? { sourceId: item.sourceId } : {}),
      pairing: item.pairing,
      revision: item.revision,
      text: item.text,
      final: item.final,
      at: item.at,
    });
  };
  const associate = (translationId: string, sourceId: string) => {
    if (!sources.has(sourceId)) {
      if (pendingAssociations.size >= MAX_ITEMS) {
        fail('LIVETRANSLATE_ITEM_CAPACITY');
        return;
      }
      pendingAssociations.set(translationId, sourceId);
      return;
    }
    associations.set(translationId, sourceId);
    emit(options.onAssociation, { role, sessionId, translationId, sourceId });
    const item = translations.get(translationId);
    if (item && item.sourceId !== sourceId) {
      item.sourceId = sourceId;
      item.pairing = 'explicit';
      item.revision += 1;
      showTranslation(item);
    }
  };
  const ensureSource = (id: string) => {
    if (
      translations.has(id) ||
      associations.has(id) ||
      pendingAssociations.has(id)
    ) {
      fail('LIVETRANSLATE_ITEM_CONFLICT');
      return undefined;
    }
    let source = sources.get(id);
    if (!source) {
      if (sources.size >= MAX_ITEMS) {
        fail('LIVETRANSLATE_ITEM_CAPACITY');
        return undefined;
      }
      source = {
        role,
        sessionId,
        sourceId: id,
        revision: 0,
        text: '',
        final: false,
        at: now(),
      };
      sources.set(id, source);
      for (const [translationId, sourceId] of pendingAssociations)
        if (sourceId === id) {
          pendingAssociations.delete(translationId);
          associate(translationId, sourceId);
        }
    }
    return source;
  };
  const response = (id: string) => {
    let item = responses.get(id);
    if (!item) {
      if (responses.size >= MAX_ITEMS) {
        fail('LIVETRANSLATE_ITEM_CAPACITY');
        return undefined;
      }
      item = {
        done: false,
        createdSeen: false,
        audioReleased: false,
        audio: [],
        outputs: new Map(),
      };
      responses.set(id, item);
    }
    return item;
  };
  const drainAudio = () => {
    if (drainingAudio || closed()) return;
    drainingAudio = true;
    try {
      while (!closed() && responseOrder.length) {
        const parent = responses.get(responseOrder[0]);
        if (!parent) {
          fail('LIVETRANSLATE_RESPONSE_ORDER_UNKNOWN');
          break;
        }
        while (!closed() && parent.audio.length) {
          const chunk = parent.audio.shift()!;
          queuedAudioBytes -= chunk.pcm.length;
          audioSequence += 1;
          const metadata: LiveTranslateAudioMetadata = {
            role,
            sessionId,
            translationId: chunk.item.translationId,
            responseId: chunk.item.responseId,
            ...(chunk.item.sourceId ? { sourceId: chunk.item.sourceId } : {}),
            pairing: chunk.item.pairing,
            eventId: chunk.eventId,
            sequence: audioSequence,
          };
          try {
            options.onAudio?.(chunk.pcm, metadata);
          } catch {
            fail('LIVETRANSLATE_CALLBACK_FAILED');
          }
        }
        if (!closed() && parent.audioReleased) responseOrder.shift();
        else break;
      }
    } finally {
      drainingAudio = false;
    }
  };
  const translation = (event: any) => {
    if (
      !identifier(event.response_id) ||
      !identifier(event.item_id) ||
      !integer(event.output_index) ||
      event.output_index !== 0 ||
      !integer(event.content_index) ||
      event.content_index !== 0
    ) {
      fail('LIVETRANSLATE_EVENT_INVALID');
      return undefined;
    }
    if (sources.has(event.item_id)) {
      fail('LIVETRANSLATE_ITEM_CONFLICT');
      return undefined;
    }
    const parent = response(event.response_id);
    if (!parent || parent.done) return undefined;
    const priorId = parent.outputs.get(event.output_index);
    if (priorId && priorId !== event.item_id) {
      fail('LIVETRANSLATE_ITEM_CONFLICT');
      return undefined;
    }
    parent.outputs.set(event.output_index, event.item_id);
    let item = translations.get(event.item_id);
    if (item && item.responseId !== event.response_id) {
      fail('LIVETRANSLATE_ITEM_CONFLICT');
      return undefined;
    }
    if (!item) {
      if (translations.size >= MAX_ITEMS) {
        fail('LIVETRANSLATE_ITEM_CAPACITY');
        return undefined;
      }
      const sourceId = associations.get(event.item_id);
      item = {
        role,
        sessionId,
        translationId: event.item_id,
        responseId: event.response_id,
        ...(sourceId ? { sourceId } : {}),
        pairing: sourceId ? 'explicit' : 'unpaired',
        revision: 0,
        text: '',
        final: false,
        at: now(),
        textDone: false,
        audioDone: false,
        audioSeen: false,
      };
      translations.set(event.item_id, item);
    }
    return item;
  };
  const textValue = (value: unknown): value is string =>
    typeof value === 'string' && value.length <= MAX_TEXT;
  const reportUsage = (responseId: string, raw: any) => {
    const usage: LiveTranslateUsage = {
      role,
      sessionId,
      responseId,
      basis:
        raw && integer(raw.input_tokens) && integer(raw.output_tokens)
          ? 'provider_reported'
          : 'unknown',
    };
    const fields = {
      inputTokens: raw?.input_tokens,
      outputTokens: raw?.output_tokens,
      totalTokens: raw?.total_tokens,
      inputAudioTokens: raw?.input_tokens_details?.audio_tokens,
      inputTextTokens: raw?.input_tokens_details?.text_tokens,
      outputAudioTokens: raw?.output_tokens_details?.audio_tokens,
      outputTextTokens: raw?.output_tokens_details?.text_tokens,
    };
    for (const [key, value] of Object.entries(fields))
      if (integer(value)) Object.assign(usage, { [key]: value });
    emit(options.onUsage, usage);
  };
  const requiresTranslation = (translationId: string) => {
    const sourceId = associations.get(translationId);
    const source = sourceId ? sources.get(sourceId) : undefined;
    return Boolean(source?.final && source.text.trim());
  };
  const incompleteBoundOutput = () =>
    [...associations.keys()].some((translationId) => {
      if (!requiresTranslation(translationId)) return false;
      const item = translations.get(translationId);
      return (
        !item ||
        !item.text.trim() ||
        !responses.get(item.responseId)?.done ||
        (role === 'local' && !item.audioSeen)
      );
    });
  const handle = (event: any) => {
    if (
      !event ||
      !identifier(event.event_id) ||
      typeof event.type !== 'string'
    ) {
      fail('LIVETRANSLATE_EVENT_INVALID');
      return;
    }
    const digest = createHash('sha256')
      .update(canonicalEvent(event))
      .digest('hex');
    const old = seen.get(event.event_id);
    if (old) {
      if (old !== digest) fail('LIVETRANSLATE_EVENT_CONFLICT');
      return;
    }
    if (seen.size >= MAX_EVENTS) {
      fail('LIVETRANSLATE_EVENT_CAPACITY');
      return;
    }
    seen.set(event.event_id, digest);
    if (event.session_id !== undefined && event.session_id !== sessionId) {
      fail('LIVETRANSLATE_SESSION_MISMATCH');
      return;
    }
    if (event.type === 'error') {
      fail('LIVETRANSLATE_PROVIDER_REJECTED');
      return;
    }
    if (event.type === 'session.created') {
      if (
        state !== 'connecting' ||
        !identifier(event.session?.id) ||
        event.session?.model !== LIVE_TRANSLATE_MODEL
      ) {
        fail('LIVETRANSLATE_SESSION_MISMATCH');
        return;
      }
      sessionId = event.session.id;
      state = 'configuring';
      send({
        type: 'session.update',
        session: {
          output_modalities: [...modalities],
          voice: LIVE_TRANSLATE_VOICE,
          enable_voice_clone: false,
          audio: {
            input: {
              turn_detection: { type: 'speaker_detection', threshold: 0.5 },
            },
          },
          translation: { language: target },
        },
      });
      return;
    }
    if (event.type === 'session.updated') {
      const s = event.session;
      if (
        state !== 'configuring' ||
        s?.id !== sessionId ||
        s?.model !== LIVE_TRANSLATE_MODEL ||
        !Array.isArray(s?.output_modalities) ||
        s.output_modalities.length !== modalities.length ||
        !modalities.every((value) => s.output_modalities.includes(value)) ||
        new Set(s.output_modalities).size !== modalities.length ||
        s.audio?.input?.format?.type !== 'pcm' ||
        s.audio.input.format.sample_rate !== 16000 ||
        s.audio?.output?.format?.type !== 'pcm' ||
        s.audio.output.format.sample_rate !== 24000 ||
        s.audio.output.voice !== LIVE_TRANSLATE_VOICE ||
        s.enable_voice_clone !== false ||
        s.audio.input.turn_detection?.type !== 'speaker_detection' ||
        s.audio.input.turn_detection.threshold !== 0.5 ||
        s.translation?.language !== target
      ) {
        fail('LIVETRANSLATE_CONFIGURATION_REJECTED');
        return;
      }
      clearTimeout(timer);
      timer = undefined;
      state = 'ready';
      readyResolve({
        sessionId,
        role,
        model: LIVE_TRANSLATE_MODEL,
        voice: LIVE_TRANSLATE_VOICE,
        inputSampleRate: 16000,
        outputSampleRate: 24000,
        outputModalities: Object.freeze([...modalities]) as (
          | 'text'
          | 'audio'
        )[],
      });
      if (finishRequested) sendFinish();
      return;
    }
    if (state !== 'ready' && state !== 'finishing') {
      fail('LIVETRANSLATE_OUTPUT_BEFORE_READY');
      return;
    }
    if (event.type === 'session.finished') {
      if (state !== 'finishing') {
        fail('LIVETRANSLATE_UNEXPECTED_FINISH');
        return;
      }
      if (
        [...responses.values()].some((value) => !value.done) ||
        [...sources.values()].some(
          (source) =>
            (source.text || speechSeen.has(source.sourceId)) && !source.final,
        ) ||
        incompleteBoundOutput()
      ) {
        fail('LIVETRANSLATE_FINISH_INCOMPLETE');
        return;
      }
      state = 'closed';
      cleanup(true);
      finishResolve();
      return;
    }
    if (
      event.type === 'input_audio_buffer.speech_started' ||
      event.type === 'input_audio_buffer.speech_stopped'
    ) {
      if (!identifier(event.item_id)) {
        fail('LIVETRANSLATE_EVENT_INVALID');
        return;
      }
      const source = ensureSource(event.item_id);
      if (!source || source.final) return;
      speechSeen.add(source.sourceId);
      const started = event.type.endsWith('started');
      const offset = started ? event.audio_start_ms : event.audio_end_ms;
      if (
        !integer(offset) ||
        (event.speaker_id !== undefined && !integer(event.speaker_id))
      ) {
        fail('LIVETRANSLATE_EVENT_INVALID');
        return;
      }
      if (started) {
        source.startMs = offset;
        if (event.speaker_id !== undefined) source.speakerId = event.speaker_id;
      } else {
        if (source.startMs !== undefined && offset < source.startMs) {
          fail('LIVETRANSLATE_EVENT_INVALID');
          return;
        }
        source.endMs = offset;
      }
      timing(started ? 'source_started' : 'source_stopped', {
        sourceId: source.sourceId,
        providerAudioMs: offset,
      });
      return;
    }
    if (event.type.startsWith('conversation.item.input_audio_transcription.')) {
      if (!identifier(event.item_id) || event.content_index !== 0) {
        fail('LIVETRANSLATE_EVENT_INVALID');
        return;
      }
      if (event.type.endsWith('.failed')) {
        fail('LIVETRANSLATE_ASR_FAILED');
        return;
      }
      const source = ensureSource(event.item_id);
      if (!source || source.final) return;
      const final = event.type.endsWith('.completed');
      if (!final && !event.type.endsWith('.delta')) {
        fail('LIVETRANSLATE_MODEL_EVENT_MISMATCH');
        return;
      }
      const text = final ? event.transcript : event.delta;
      if (
        !textValue(text) ||
        (!final && source.text.length + text.length > MAX_TEXT)
      ) {
        fail('LIVETRANSLATE_TRANSCRIPT_INVALID');
        return;
      }
      source.text = final ? text : source.text + text;
      source.final = final;
      source.revision += 1;
      emit(options.onSource, { ...source });
      if (final) timing('source_final', { sourceId: source.sourceId });
      return;
    }
    if (event.type === 'conversation.item.created') {
      if (!identifier(event.item?.id)) {
        fail('LIVETRANSLATE_EVENT_INVALID');
        return;
      }
      if (event.item.role !== 'assistant') return;
      if (
        !identifier(event.previous_item_id) ||
        event.previous_item_id === event.item.id
      )
        return;
      if (sources.has(event.item.id)) {
        fail('LIVETRANSLATE_ITEM_CONFLICT');
        return;
      }
      if (
        (associations.has(event.item.id) &&
          associations.get(event.item.id) !== event.previous_item_id) ||
        (pendingAssociations.has(event.item.id) &&
          pendingAssociations.get(event.item.id) !== event.previous_item_id)
      ) {
        fail('LIVETRANSLATE_SOURCE_CONFLICT');
        return;
      }
      if (associations.size >= MAX_ITEMS && !associations.has(event.item.id)) {
        fail('LIVETRANSLATE_ITEM_CAPACITY');
        return;
      }
      associate(event.item.id, event.previous_item_id);
      return;
    }
    if (event.type === 'response.created') {
      if (!identifier(event.response?.id)) {
        fail('LIVETRANSLATE_EVENT_INVALID');
        return;
      }
      const item = response(event.response.id);
      if (item && !item.createdSeen && !item.done) {
        item.createdSeen = true;
        responseOrder.push(event.response.id);
        timing('response_created', { responseId: event.response.id });
      }
      return;
    }
    if (
      ['response.text.text', 'response.audio_transcript.text'].includes(
        event.type,
      )
    ) {
      fail('LIVETRANSLATE_MODEL_EVENT_MISMATCH');
      return;
    }
    if (
      [
        'response.text.delta',
        'response.audio_transcript.delta',
        'response.text.done',
        'response.audio_transcript.done',
        'response.audio.delta',
        'response.audio.done',
      ].includes(event.type)
    ) {
      const item = translation(event);
      if (!item) return;
      if (event.type.startsWith('response.audio.') && role === 'remote') {
        fail('LIVETRANSLATE_UNEXPECTED_AUDIO');
        return;
      }
      if (
        (role === 'local' && event.type.startsWith('response.text.')) ||
        (role === 'remote' &&
          event.type.startsWith('response.audio_transcript.'))
      ) {
        fail('LIVETRANSLATE_MODALITY_MISMATCH');
        return;
      }
      if (event.type === 'response.audio.delta') {
        if (item.audioDone) return;
        if (
          typeof event.delta !== 'string' ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
            event.delta,
          )
        ) {
          fail('LIVETRANSLATE_AUDIO_INVALID');
          return;
        }
        const pcm = Buffer.from(event.delta, 'base64');
        if (!pcm.length || pcm.length % 2 || pcm.length > 256 * 1024) {
          fail('LIVETRANSLATE_AUDIO_INVALID');
          return;
        }
        const parent = responses.get(item.responseId)!;
        if (!parent.createdSeen) {
          fail('LIVETRANSLATE_RESPONSE_ORDER_UNKNOWN');
          return;
        }
        if (queuedAudioBytes + pcm.length > MAX_QUEUED_AUDIO_BYTES) {
          fail('LIVETRANSLATE_AUDIO_QUEUE_LIMIT');
          return;
        }
        if (!item.audioSeen) {
          item.audioSeen = true;
          timing('audio_first_sample', {
            translationId: item.translationId,
            responseId: item.responseId,
            ...(item.sourceId ? { sourceId: item.sourceId } : {}),
          });
        }
        if (closed()) return;
        parent.audio.push({ pcm, eventId: event.event_id, item });
        queuedAudioBytes += pcm.length;
        drainAudio();
      } else if (event.type === 'response.audio.done') {
        item.audioDone = true;
        if (item.audioSeen) {
          responses.get(item.responseId)!.audioReleased = true;
          drainAudio();
        }
      } else {
        if (item.textDone) return;
        const final = event.type.endsWith('.done');
        const text = final ? (event.text ?? event.transcript) : event.delta;
        if (
          !textValue(text) ||
          (!final && item.text.length + text.length > MAX_TEXT)
        ) {
          fail('LIVETRANSLATE_TRANSCRIPT_INVALID');
          return;
        }
        if (!item.text && text)
          timing('translation_first_delta', {
            translationId: item.translationId,
            responseId: item.responseId,
          });
        item.text = final ? text : item.text + text;
        if (final)
          timing('translation_completed', {
            translationId: item.translationId,
            responseId: item.responseId,
            ...(item.sourceId ? { sourceId: item.sourceId } : {}),
          });
        item.textDone = final;
        item.revision += 1;
        showTranslation(item);
      }
      return;
    }
    if (event.type === 'response.done') {
      if (!identifier(event.response?.id)) {
        fail('LIVETRANSLATE_EVENT_INVALID');
        return;
      }
      const parent = response(event.response.id);
      if (!parent || parent.done) return;
      reportUsage(event.response.id, event.response.usage);
      if (closed()) return;
      if (!parent.createdSeen) {
        fail('LIVETRANSLATE_RESPONSE_ORDER_UNKNOWN');
        return;
      }
      if (event.response.status !== 'completed') {
        fail('LIVETRANSLATE_RESPONSE_INCOMPLETE');
        return;
      }
      if (Array.isArray(event.response.output)) {
        for (const [index, output] of event.response.output.entries()) {
          if (
            index !== 0 ||
            !identifier(output?.id) ||
            !Array.isArray(output.content) ||
            output.content.length > 1
          ) {
            fail('LIVETRANSLATE_EVENT_INVALID');
            return;
          }
          const item = translation({
            response_id: event.response.id,
            item_id: output.id,
            output_index: index,
            content_index: 0,
          });
          if (!item) return;
          const content = output.content[0];
          const text =
            role === 'local'
              ? (content?.transcript ?? content?.text)
              : content?.text;
          if (text !== undefined) {
            if (!textValue(text)) {
              fail('LIVETRANSLATE_TRANSCRIPT_INVALID');
              return;
            }
            item.text = text;
            if (!item.textDone)
              timing('translation_completed', {
                translationId: item.translationId,
                responseId: item.responseId,
                ...(item.sourceId ? { sourceId: item.sourceId } : {}),
              });
            item.textDone = true;
          }
        }
      }
      if (
        [...translations.values()].some(
          (item) =>
            item.responseId === event.response.id &&
            requiresTranslation(item.translationId) &&
            !item.text.trim(),
        )
      ) {
        fail('LIVETRANSLATE_RESPONSE_INCOMPLETE');
        return;
      }
      if (
        role === 'local' &&
        [...translations.values()].some(
          (item) =>
            item.responseId === event.response.id &&
            item.text.trim() &&
            !item.audioSeen,
        )
      ) {
        fail('LIVETRANSLATE_RESPONSE_AUDIO_MISSING');
        return;
      }
      parent.done = true;
      for (const item of translations.values()) {
        if (item.responseId !== event.response.id) continue;
        item.final = true;
        item.textDone = true;
        item.audioDone = true;
        item.revision += 1;
        showTranslation(item);
      }
      timing('response_completed', { responseId: event.response.id });
      parent.audioReleased = true;
      drainAudio();
    }
    // Other documented bookkeeping events do not synthesize source bindings.
  };
  socket.on('message', (raw: WebSocket.RawData, isBinary?: boolean) => {
    if (closed()) return;
    try {
      const bytes = Buffer.isBuffer(raw)
        ? raw
        : Buffer.concat(Array.isArray(raw) ? raw : [Buffer.from(raw)]);
      if (isBinary || bytes.length > MAX_BYTES) {
        fail('LIVETRANSLATE_EVENT_INVALID');
        return;
      }
      handle(JSON.parse(bytes.toString('utf8')));
    } catch {
      fail('LIVETRANSLATE_EVENT_INVALID');
    }
  });
  socket.on('error', () => fail('LIVETRANSLATE_CONNECTION_FAILED'));
  socket.on('close', (code) => fail('LIVETRANSLATE_CONNECTION_CLOSED', code));
  arm('LIVETRANSLATE_READY_TIMEOUT');
  return {
    ready,
    append(pcm) {
      if (closed() || finishRequested || state !== 'ready')
        throw new Error(failure || 'LIVETRANSLATE_NOT_READY');
      if (
        !Buffer.isBuffer(pcm) ||
        !pcm.length ||
        pcm.length % 2 ||
        pcm.length > 256 * 1024
      ) {
        fail('LIVETRANSLATE_INPUT_INVALID');
        return;
      }
      send({
        type: 'input_audio_buffer.append',
        audio: pcm.toString('base64'),
      });
    },
    finish() {
      finishRequested = true;
      if (state === 'ready') sendFinish();
      return finished;
    },
    abort() {
      if (closed()) return;
      state = 'closed';
      failure = 'LIVETRANSLATE_CANCELLED';
      cleanup();
      readyReject(new Error(failure));
      finishReject(new Error(failure));
    },
  };
}
