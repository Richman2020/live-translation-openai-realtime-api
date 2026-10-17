/* eslint-disable no-continue -- Retired event/item snapshots must not be replayed. */
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import createHttpsProxyAgent from 'https-proxy-agent';
import WebSocket from 'ws';

import {
  createLiveTranslateSendPump,
  type LiveTranslateSendReason,
} from './livetranslate-send-pump';
import { validOpenAIProxyUrl } from '../solo/openai-websocket';
import {
  LIVE_TRANSLATE_PROTOCOL_EVENT_TYPES,
  LIVE_TRANSLATE_PROTOCOL_SCHEMA_PATHS,
} from './livetranslate-types';
import type {
  LiveTranslateClient,
  LiveTranslateClientOptions,
  LiveTranslateAudioMetadata,
  LiveTranslateSession,
  LiveTranslateSource,
  LiveTranslateTiming,
  LiveTranslateTranslation,
  LiveTranslateUsage,
  LiveTranslateProtocolEvent,
  LiveTranslateProtocolDiagnostic,
  LiveTranslateProtocolValueType,
  LiveTranslateProtocolEventType,
  LiveTranslateVoiceEcho,
  LiveTranslateVoiceEvidence,
  LiveTranslateVoicePolicy,
} from './livetranslate-types';

export * from './livetranslate-types';
export const LIVE_TRANSLATE_MODEL = 'qwen3.8-livetranslate-flash-realtime';
export const LIVE_TRANSLATE_VOICE = 'Aiden';
const MAX_ITEMS = 256;
const MAX_EVENTS = 4096;
const MAX_TEXT = 32768;
const MAX_BYTES = 1024 * 1024;
const MAX_QUEUED_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_TERMINAL_IDENTIFIERS = 1024;
const COMPLETED_SOURCE_GRACE = 32;
const PHONE_SOURCE_ORDER_WAIT_MS = 5000;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024;
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function sessionValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | 'other' | null {
  if (value === undefined) return null;
  if (typeof value === 'string' && allowed.includes(value as T))
    return value as T;
  return 'other';
}

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
const knownEventTypes = new Set<string>(LIVE_TRANSLATE_PROTOCOL_EVENT_TYPES);
function protocolType(event: any): LiveTranslateProtocolEventType {
  if (typeof event?.type !== 'string') return null;
  return knownEventTypes.has(event.type) ? event.type : 'unknown';
}
function valueType(value: unknown): LiveTranslateProtocolValueType {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
    return 'binary';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'object';
}
function voiceEcho(value: unknown): LiveTranslateVoiceEcho {
  const actualType = valueType(value);
  if (value === undefined)
    return Object.freeze({ status: 'missing', value: null, actualType });
  if (typeof value !== 'string')
    return Object.freeze({ status: 'invalid_type', value: null, actualType });
  if (value === 'Aiden' || value === 'Tina' || value === 'Andre')
    return Object.freeze({ status: 'reported', value, actualType });
  return Object.freeze({
    status: 'unsupported_value',
    value: null,
    actualType,
  });
}
function protocolPath(event: any, path: string): unknown {
  let current = event;
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key))
      return undefined;
    current = current[key];
  }
  return current;
}
function protocolSchema(
  event: any,
): Pick<LiveTranslateProtocolEvent, 'schema' | 'unknownKeyCount'> {
  const schema: LiveTranslateProtocolEvent['schema'] = {};
  const allowed = new Map<string, Set<string>>();
  for (const path of LIVE_TRANSLATE_PROTOCOL_SCHEMA_PATHS) {
    const keys = path.split('.');
    const key = keys.pop()!;
    const parent = keys.join('.');
    if (!allowed.has(parent)) allowed.set(parent, new Set());
    allowed.get(parent)!.add(key);
    const value = protocolPath(event, path);
    if (value !== undefined) schema[path] = valueType(value);
  }
  let unknownKeyCount = 0;
  for (const [path, keys] of allowed) {
    const value = path ? protocolPath(event, path) : event;
    if (value && typeof value === 'object' && !Array.isArray(value))
      unknownKeyCount += Object.keys(value).filter(
        (key) => !keys.has(key),
      ).length;
  }
  return { schema, unknownKeyCount };
}

type Source = LiveTranslateSource;
type ProtocolFailureDetail = {
  validationPath: LiveTranslateProtocolDiagnostic['validationPath'];
  expected: LiveTranslateProtocolDiagnostic['expected'];
  actual: unknown;
  conflictKind?: LiveTranslateProtocolDiagnostic['conflictKind'];
  sendReason?: LiveTranslateSendReason;
  readyState?: number;
  bufferedBytes?: number;
  pendingAudioBytes?: number;
  sendSequence?: number;
  callbackDurationMs?: number;
};
type Translation = LiveTranslateTranslation & {
  textDone: boolean;
  audioDone: boolean;
  audioSeen: boolean;
};
type ResponseState = {
  done: boolean;
  createdSeen: boolean;
  createdSequence: number;
  audioReleased: boolean;
  audio: {
    pcm: Buffer;
    eventId: string;
    eventIdBasis: 'provider_event_id' | 'local_receive_sequence';
    item: Translation;
  }[];
  outputs: Map<number, string>;
};

/** Independent prototype only. No production registration, retries or fallback. */
export function createLiveTranslateClient(
  options: LiveTranslateClientOptions,
): LiveTranslateClient {
  if (options.enabled !== true) throw new Error('LIVETRANSLATE_DISABLED');
  const endpoint = buildLiveTranslateEndpoint(options.workspaceId);
  const { role } = options;
  const phone = options.usage === 'phone';
  const voice =
    options.voice === undefined ? LIVE_TRANSLATE_VOICE : options.voice;
  let voicePolicy: LiveTranslateVoicePolicy | undefined;
  if (
    !['local', 'remote'].includes(role) ||
    (options.usage !== undefined &&
      !['audition', 'phone'].includes(options.usage)) ||
    !['Aiden', 'Tina', 'Andre'].includes(voice) ||
    (options.allowAndreTopLevelWithTinaOutput !== undefined &&
      typeof options.allowAndreTopLevelWithTinaOutput !== 'boolean') ||
    (options.allowAndreTopLevelWithTinaOutput === true &&
      (role !== 'local' || voice !== 'Andre')) ||
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
  // A source item can also have role=assistant. Its predecessor is conversation
  // bookkeeping, not a translation edge. Only a response output proves that an
  // otherwise ambiguous created item is a translation result.
  const unclassifiedCreated = new Map<
    string,
    { predecessor: string; ambiguous: boolean }
  >();
  const responses = new Map<string, ResponseState>();
  const seen = new Map<string, string>();
  const eventOwners = new Map<string, readonly string[]>();
  const terminalIdentifiers = new Map<string, true>();
  const sourcePublishedRevision = new Map<string, number>();
  const translationPublishedRevision = new Map<string, number>();
  const associationPublished = new Set<string>();
  const pendingUsage = new Map<string, LiveTranslateUsage>();
  const anchorWaits = new Map<string, ReturnType<typeof setTimeout>>();
  let sourceOffsetFloorMs = 0;
  const speechSeen = new Set<string>();
  const responseOrder: string[] = [];
  const phoneSourceOrdinals = new WeakMap<Source, number>();
  let phoneSourceOrdinal = 0;
  let responseCreatedSequence = 0;
  let phoneSourceFrontier: Source | undefined;
  const phoneOrderWaits = new Map<string, ReturnType<typeof setTimeout>>();
  let drainingPhoneOutput = false;
  let queuedAudioBytes = 0;
  let drainingAudio = false;
  let state: 'connecting' | 'configuring' | 'ready' | 'finishing' | 'closed' =
    'connecting';
  let sessionId = '';
  let finishRequested = false;
  let audioSequence = 0;
  let failure = '';
  let receiveSequence = 0;
  let currentEvent: any;
  let transportCloseObserved = false;
  let resolveTransportClosed: (event: {
    observed: true;
    code?: number;
    at: number;
  }) => void;
  const transportClosed = new Promise<{
    observed: true;
    code?: number;
    at: number;
  }>((resolve) => {
    resolveTransportClosed = resolve;
  });
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
  let sendPump: ReturnType<typeof createLiveTranslateSendPump> | undefined;
  const closed = () => state === 'closed';
  const protocolEvent = (
    stage: LiveTranslateProtocolEvent['stage'],
    event?: any,
    metadata: Partial<
      Pick<
        LiveTranslateProtocolEvent,
        | 'at'
        | 'frameBytes'
        | 'frameBinary'
        | 'httpStatusCode'
        | 'closeCode'
        | 'providerError'
      >
    > = {},
  ) => {
    try {
      options.onProtocolEvent?.({
        role,
        at: now(),
        stage,
        eventType: protocolType(event),
        eventIdPresent: event?.event_id !== undefined,
        ...protocolSchema(event),
        ...metadata,
      });
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Error reporting and teardown call this observer recursively; all initialize before listeners are attached.
      if (!closed()) fail('LIVETRANSLATE_CALLBACK_FAILED');
    }
  };
  const cleanup = (graceful = false) => {
    clearTimeout(timer);
    timer = undefined;
    if (graceful) sendPump?.finishDiagnostics();
    sendPump?.abort();
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Hoisted cleanup closes the mutually recursive ordering/drain lifecycle.
    clearPhoneSourceOrder();
    socket.removeAllListeners('message');
    socket.removeAllListeners('open');
    socket.removeAllListeners('unexpected-response');
    socket.removeAllListeners('error');
    socket.on('error', () => {});
    try {
      if (socket.readyState !== WebSocket.CLOSED)
        protocolEvent(
          'transport_close_requested',
          undefined,
          graceful ? { closeCode: 1000 } : {},
        );
      if (graceful && socket.readyState === WebSocket.OPEN) socket.close(1000);
      else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    } catch {
      /* Local fences remain effective even if teardown fails. */
    }
    sources.clear();
    translations.clear();
    associations.clear();
    pendingAssociations.clear();
    unclassifiedCreated.clear();
    responses.clear();
    seen.clear();
    eventOwners.clear();
    terminalIdentifiers.clear();
    sourcePublishedRevision.clear();
    translationPublishedRevision.clear();
    associationPublished.clear();
    pendingUsage.clear();
    for (const wait of anchorWaits.values()) clearTimeout(wait);
    anchorWaits.clear();
    speechSeen.clear();
    responseOrder.length = 0;
    queuedAudioBytes = 0;
  };
  function fail(
    code: string,
    closeCode?: unknown,
    httpStatusCode?: unknown,
    detail?: ProtocolFailureDetail,
  ) {
    if (closed()) return;
    const defaults: Partial<Record<string, ProtocolFailureDetail>> = {
      LIVETRANSLATE_ITEM_CONFLICT: {
        validationPath: 'item_id',
        expected: 'consistent_item_binding',
        actual: currentEvent?.item_id ?? currentEvent?.item?.id,
      },
      LIVETRANSLATE_SOURCE_CONFLICT: {
        validationPath: 'source.binding',
        expected: 'consistent_source_binding',
        actual: currentEvent?.previous_item_id,
      },
      LIVETRANSLATE_RESPONSE_ORDER_UNKNOWN: {
        validationPath: 'response.id',
        expected: 'response_created_before_output',
        actual: currentEvent?.response_id ?? currentEvent?.response?.id,
      },
      LIVETRANSLATE_RESPONSE_INCOMPLETE: {
        validationPath: 'response.output',
        expected: 'pending_output_complete',
        actual: currentEvent?.response?.output,
      },
      LIVETRANSLATE_RESPONSE_AUDIO_MISSING: {
        validationPath: 'response.audio.done',
        expected: 'pending_output_complete',
        actual: undefined,
      },
      LIVETRANSLATE_SEND_UNAVAILABLE: {
        validationPath: 'transport.send',
        expected: 'send_available',
        actual: socket.readyState,
      },
      LIVETRANSLATE_SEND_FAILED: {
        validationPath: 'transport.send',
        expected: 'send_available',
        actual: socket.readyState,
      },
      LIVETRANSLATE_READY_TIMEOUT: {
        validationPath: 'transport.ready_timeout',
        expected: 'valid_protocol_transition',
        actual: state,
      },
      LIVETRANSLATE_FINISH_TIMEOUT: {
        validationPath: 'transport.finish_timeout',
        expected: 'pending_output_complete',
        actual: state,
      },
      LIVETRANSLATE_CALLBACK_FAILED: {
        validationPath: 'internal.handler',
        expected: 'valid_callback',
        actual: undefined,
      },
      LIVETRANSLATE_AUDIO_QUEUE_LIMIT: {
        validationPath: 'delta',
        expected: 'bounded_capacity',
        actual: queuedAudioBytes,
      },
      LIVETRANSLATE_ITEM_CAPACITY: {
        validationPath: 'item_id',
        expected: 'bounded_capacity',
        actual: currentEvent?.item_id ?? currentEvent?.item?.id,
      },
      LIVETRANSLATE_UNEXPECTED_AUDIO: {
        validationPath: 'type',
        expected: 'output_modality',
        actual: currentEvent?.type,
      },
      LIVETRANSLATE_MODALITY_MISMATCH: {
        validationPath: 'type',
        expected: 'output_modality',
        actual: currentEvent?.type,
      },
      LIVETRANSLATE_CONNECTION_FAILED: {
        validationPath: 'frame',
        expected: 'error_free_transport',
        actual: httpStatusCode,
      },
    };
    const diagnostic: ProtocolFailureDetail = detail ??
      defaults[code] ?? {
        validationPath: 'state',
        expected: 'valid_protocol_transition',
        actual: state,
      };
    try {
      options.onProtocolDiagnostic?.({
        role,
        at: now(),
        stage: state,
        eventType:
          diagnostic.validationPath.startsWith('transport.') ||
          code === 'LIVETRANSLATE_INPUT_INVALID'
            ? null
            : protocolType(currentEvent),
        validationPath: diagnostic.validationPath,
        expected: diagnostic.expected,
        actualType: valueType(diagnostic.actual),
        ...(diagnostic.conflictKind
          ? { conflictKind: diagnostic.conflictKind }
          : {}),
        ...(diagnostic.sendReason ? { sendReason: diagnostic.sendReason } : {}),
        ...(diagnostic.readyState === undefined
          ? {}
          : { readyState: diagnostic.readyState }),
        ...(diagnostic.bufferedBytes === undefined
          ? {}
          : { bufferedBytes: diagnostic.bufferedBytes }),
        ...(diagnostic.pendingAudioBytes === undefined
          ? {}
          : { pendingAudioBytes: diagnostic.pendingAudioBytes }),
        ...(diagnostic.sendSequence === undefined
          ? {}
          : { sendSequence: diagnostic.sendSequence }),
        ...(diagnostic.callbackDurationMs === undefined
          ? {}
          : { callbackDurationMs: diagnostic.callbackDurationMs }),
        receiveSequence,
        fatal: true,
        code,
      });
    } catch {
      /* A diagnostic sink cannot replace the original failure or prevent cleanup. */
    }
    state = 'closed';
    failure = code;
    cleanup();
    readyReject(new Error(code));
    finishReject(new Error(code));
    try {
      options.onError?.(code, {
        ...(integer(closeCode) && closeCode >= 1000 && closeCode <= 4999
          ? { closeCode }
          : {}),
        ...(integer(httpStatusCode) &&
        httpStatusCode >= 100 &&
        httpStatusCode <= 599
          ? { httpStatusCode }
          : {}),
      });
    } catch {
      /* The original failure and cleanup cannot be overridden. */
    }
  }
  const requireValue = (
    accepted: boolean,
    validationPath: LiveTranslateProtocolDiagnostic['validationPath'],
    expected: LiveTranslateProtocolDiagnostic['expected'],
    actual: unknown,
    code = 'LIVETRANSLATE_EVENT_INVALID',
  ) => {
    if (!accepted)
      fail(code, undefined, undefined, { validationPath, expected, actual });
    return accepted && !closed();
  };
  const responseVoiceAllowed = (raw: any) =>
    raw?.voice === undefined ||
    (typeof raw.voice === 'string' &&
      (voicePolicy?.responseVoiceAllowlist ?? [voice]).includes(raw.voice));
  const responseConfiguration = (raw: any) =>
    requireValue(
      responseVoiceAllowed(raw),
      'response.voice',
      voicePolicy?.mode === 'approved_andre_tina_metadata_conflict'
        ? 'Andre_or_Tina_declaration'
        : voice,
      raw?.voice,
      'LIVETRANSLATE_CONFIGURATION_REJECTED',
    ) &&
    requireValue(
      raw?.modalities === undefined ||
        (Array.isArray(raw.modalities) &&
          raw.modalities.length === modalities.length &&
          modalities.every((value) => raw.modalities.includes(value)) &&
          new Set(raw.modalities).size === modalities.length),
      'response.modalities',
      'exact_output_modalities',
      raw?.modalities,
      'LIVETRANSLATE_CONFIGURATION_REJECTED',
    ) &&
    requireValue(
      raw?.output_audio_format === undefined ||
        ['pcm', 'pcm16'].includes(raw.output_audio_format),
      'response.output_audio_format',
      'pcm',
      raw?.output_audio_format,
      'LIVETRANSLATE_CONFIGURATION_REJECTED',
    );
  const emit = <T>(callback: ((event: T) => void) | undefined, event: T) => {
    if (closed()) return;
    try {
      callback?.(event);
    } catch {
      fail('LIVETRANSLATE_CALLBACK_FAILED');
    }
  };
  function phoneSourceAdmitted(id: string | undefined) {
    return Boolean(id && sources.get(id)?.startMs !== undefined);
  }
  function waitForPhoneAnchor(key: string) {
    if (!phone || closed() || anchorWaits.has(key)) return;
    anchorWaits.set(
      key,
      setTimeout(
        () =>
          fail('LIVETRANSLATE_SOURCE_ANCHOR_MISSING', undefined, undefined, {
            validationPath: 'source.binding',
            expected: 'consistent_source_binding',
            actual: undefined,
          }),
        options.timeoutMs ?? 20000,
      ),
    );
  }
  function showAssociation(translationId: string, sourceId: string) {
    if (
      phone &&
      (!phoneSourceAdmitted(sourceId) ||
        associationPublished.has(translationId))
    )
      return;
    if (phone) associationPublished.add(translationId);
    emit(options.onAssociation, { role, sessionId, translationId, sourceId });
  }
  function publishPhoneUsage() {
    if (!phone) return;
    for (const [id, usage] of pendingUsage) {
      const parent = responses.get(id);
      if (
        !parent ||
        ![...parent.outputs.values()].some((itemId) =>
          phoneSourceAdmitted(translations.get(itemId)?.sourceId),
        )
      )
        continue;
      pendingUsage.delete(id);
      emit(options.onUsage, usage);
    }
  }
  const observeVoice = (
    event: any,
    acceptedByVoicePolicy: boolean | null,
    receivedAt = now(),
  ) =>
    emit<LiveTranslateVoiceEvidence>(options.onVoiceEvidence, {
      role,
      sessionId: identifier(event.session?.id)
        ? event.session.id
        : sessionId || null,
      responseId: identifier(event.response?.id) ? event.response.id : null,
      eventId: event.event_id ?? null,
      receiveSequence,
      receivedAt,
      eventType: event.type,
      requestedVoice: voice,
      sessionTopLevelEcho: voiceEcho(event.session?.voice),
      sessionNestedEcho: voiceEcho(event.session?.audio?.output?.voice),
      responseEcho: voiceEcho(event.response?.voice),
      policyMode: voicePolicy?.mode ?? 'awaiting_configuration',
      acceptedByVoicePolicy,
      acousticVoice: 'unknown_not_measured',
    });
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
  if (phone)
    sendPump = createLiveTranslateSendPump({
      socket,
      now,
      onDiagnostic: options.onSendDiagnostic
        ? (event) => {
            try {
              options.onSendDiagnostic?.({ ...event, role });
            } catch {
              /* Diagnostic sinks cannot change transport behavior. */
            }
          }
        : undefined,
      onObservation: (event) => {
        try {
          options.onSendObservation?.({ role, ...event });
        } catch {
          // Diagnostics cannot replace the first transport failure, stop a
          // healthy writer or change telephone lifecycle decisions.
        }
      },
      onFailure: (event) =>
        fail(event.code, undefined, undefined, {
          validationPath: 'transport.send',
          expected: 'send_available',
          actual: event.readyState,
          sendReason: event.sendReason,
          readyState: event.readyState,
          bufferedBytes: event.bufferedBytes,
          pendingAudioBytes: event.pendingAudioBytes,
          sendSequence: event.sendSequence,
          ...(event.callbackDurationMs === undefined
            ? {}
            : { callbackDurationMs: event.callbackDurationMs }),
        }),
    });
  const send = (event: unknown) => {
    if (closed()) return;
    if (sendPump) {
      const value = event as { type?: unknown; audio?: unknown };
      const eventType =
        value?.type === 'session.update' ||
        value?.type === 'input_audio_buffer.append' ||
        value?.type === 'session.finish'
          ? value.type
          : 'unknown';
      const audioBytes =
        eventType === 'input_audio_buffer.append' &&
        typeof value.audio === 'string'
          ? Buffer.byteLength(value.audio, 'base64')
          : 0;
      sendPump.enqueue(JSON.stringify(event), eventType, audioBytes, () =>
        protocolEvent('client_event_sent', event),
      );
      return;
    }
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
        else protocolEvent('client_event_sent', event);
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
  const publishTranslation = (item: Translation) => {
    if (phone && item.text.trim() && !phoneSourceAdmitted(item.sourceId))
      waitForPhoneAnchor(`response:${item.responseId}`);
    if (
      phone &&
      (!phoneSourceAdmitted(item.sourceId) ||
        translationPublishedRevision.get(item.translationId) === item.revision)
    )
      return;
    if (phone)
      translationPublishedRevision.set(item.translationId, item.revision);
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
  const showTranslation = (item: Translation) => {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- The hoisted drain shares publication and source admission guards.
    if (phone) drainPhoneOutput();
    else publishTranslation(item);
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
    showAssociation(translationId, sourceId);
    const item = translations.get(translationId);
    if (item && item.sourceId !== sourceId) {
      item.sourceId = sourceId;
      item.pairing = 'explicit';
      item.revision += 1;
      showTranslation(item);
    }
  };
  const bindOutputSource = (translationId: string, sourceId: string) => {
    const prior =
      associations.get(translationId) ?? pendingAssociations.get(translationId);
    if (prior !== undefined && prior !== sourceId) {
      fail('LIVETRANSLATE_SOURCE_CONFLICT');
      return;
    }
    if (associations.size >= MAX_ITEMS && !associations.has(translationId)) {
      fail('LIVETRANSLATE_ITEM_CAPACITY');
      return;
    }
    associate(translationId, sourceId);
  };
  const ensureSource = (id: string) => {
    if (phone && terminalIdentifiers.has(`item:${id}`)) return undefined;
    if (
      translations.has(id) ||
      associations.has(id) ||
      pendingAssociations.has(id)
    ) {
      fail('LIVETRANSLATE_ITEM_CONFLICT', undefined, undefined, {
        validationPath: 'item_id',
        expected: 'consistent_item_binding',
        actual: id,
        conflictKind: 'source_after_output',
      });
      return undefined;
    }
    // VAD, ASR or input_audio is positive input identity; a previously received
    // empty assistant item must never turn its predecessor into a source edge.
    unclassifiedCreated.delete(id);
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
    if (phone && terminalIdentifiers.has(`response:${id}`)) return undefined;
    let item = responses.get(id);
    if (!item) {
      if (responses.size >= MAX_ITEMS) {
        fail('LIVETRANSLATE_ITEM_CAPACITY');
        return undefined;
      }
      item = {
        done: false,
        createdSeen: false,
        createdSequence: 0,
        audioReleased: false,
        audio: [],
        outputs: new Map(),
      };
      responses.set(id, item);
    }
    return item;
  };
  const drainAudio = () => {
    if (phone) {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Source ordering and publication deliberately share one hoisted drain.
      drainPhoneOutput();
      return;
    }
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
          if (phone && !phoneSourceAdmitted(parent.audio[0].item.sourceId)) {
            waitForPhoneAnchor(`response:${parent.audio[0].item.responseId}`);
            break;
          }
          // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Both audition and phone drains share the hoisted PCM publisher.
          publishAudio(parent.audio.shift()!);
        }
        if (!closed() && parent.audioReleased && !parent.audio.length)
          responseOrder.shift();
        else break;
      }
    } finally {
      drainingAudio = false;
    }
  };
  function publishAudio(chunk: ResponseState['audio'][number]) {
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
      eventIdBasis: chunk.eventIdBasis,
      sequence: audioSequence,
      ...(voicePolicy
        ? {
            voiceContext: {
              requestedVoice: voice,
              policyMode: voicePolicy.mode,
              acousticVoice: 'unknown_not_measured' as const,
            },
          }
        : {}),
    };
    try {
      options.onAudio?.(chunk.pcm, metadata);
    } catch {
      fail('LIVETRANSLATE_CALLBACK_FAILED');
    }
  }
  function clearPhoneSourceOrder() {
    for (const wait of phoneOrderWaits.values()) clearTimeout(wait);
    phoneOrderWaits.clear();
    phoneSourceFrontier = undefined;
  }
  function sourceOrdinal(source: Source) {
    let ordinal = phoneSourceOrdinals.get(source);
    if (ordinal === undefined) {
      phoneSourceOrdinal += 1;
      ordinal = phoneSourceOrdinal;
      phoneSourceOrdinals.set(source, ordinal);
    }
    return ordinal;
  }
  function comparePhoneSources(left: Source, right: Source) {
    return (
      left.startMs! - right.startMs! ||
      sourceOrdinal(left) - sourceOrdinal(right)
    );
  }
  function sourceResponses(sourceId: string) {
    return [...responses.entries()]
      .filter(([, parent]) =>
        [...parent.outputs.values()].some(
          (id) => translations.get(id)?.sourceId === sourceId,
        ),
      )
      .sort(
        ([, left], [, right]) => left.createdSequence - right.createdSequence,
      );
  }
  function responseSourceUnknown(parent: ResponseState) {
    if (!parent.outputs.size) return !parent.done;
    return [...parent.outputs.values()].some((id) => {
      const item = translations.get(id);
      return (
        !item?.sourceId &&
        (!parent.done || Boolean(item?.text.trim()) || Boolean(item?.audioSeen))
      );
    });
  }
  function phoneSourceComplete(source: Source) {
    if (!source.final || source.endMs === undefined) return false;
    const parents = sourceResponses(source.sourceId);
    if (!parents.length) return !source.text.trim();
    return parents.every(([, parent]) => parent.done && !parent.audio.length);
  }
  function hasPendingPhoneOutput(item: Translation) {
    return (
      (Boolean(item.text.trim()) &&
        translationPublishedRevision.get(item.translationId) !==
          item.revision) ||
      Boolean(
        responses
          .get(item.responseId)
          ?.audio.some(
            (chunk) => chunk.item.translationId === item.translationId,
          ),
      )
    );
  }
  function drainPhoneOutput() {
    if (!phone || drainingPhoneOutput || closed()) return;
    drainingPhoneOutput = true;
    try {
      const ordered = [...sources.values()]
        .filter((source) => source.startMs !== undefined)
        .sort(comparePhoneSources);
      // A genuinely new old-source output must not play after a newer source.
      // Completed/duplicate responses are already fenced before reaching here.
      if (
        phoneSourceFrontier &&
        [...translations.values()].some((item) => {
          const source = item.sourceId ? sources.get(item.sourceId) : undefined;
          return (
            source?.startMs !== undefined &&
            comparePhoneSources(source, phoneSourceFrontier!) < 0 &&
            hasPendingPhoneOutput(item)
          );
        })
      ) {
        fail('LIVETRANSLATE_SOURCE_ORDER_STALE', undefined, undefined, {
          validationPath: 'source.binding',
          expected: 'consistent_source_binding',
          actual: undefined,
        });
        return;
      }
      for (const source of ordered) {
        if (
          phoneSourceFrontier &&
          comparePhoneSources(source, phoneSourceFrontier) < 0
        )
          continue;
        let sourceBlocked = false;
        for (const [id, parent] of sourceResponses(source.sourceId)) {
          if (
            !parent.createdSeen ||
            [...responses.values()].some(
              (prior) =>
                prior.createdSeen &&
                prior.createdSequence < parent.createdSequence &&
                responseSourceUnknown(prior),
            )
          ) {
            sourceBlocked = true;
            break;
          }
          const items = [...parent.outputs.values()].map(
            (itemId) => translations.get(itemId)!,
          );
          for (const item of items) {
            if (hasPendingPhoneOutput(item)) phoneSourceFrontier = source;
            publishTranslation(item);
            if (closed()) return;
          }
          while (!closed() && parent.audio.length) {
            phoneSourceFrontier = source;
            publishAudio(parent.audio.shift()!);
          }
          if (closed()) return;
          if (parent.done && !parent.audio.length) {
            const index = responseOrder.indexOf(id);
            if (index !== -1) responseOrder.splice(index, 1);
          } else {
            sourceBlocked = true;
            break;
          }
        }
        if (sourceBlocked || !phoneSourceComplete(source)) break;
      }
      for (const id of [...responseOrder]) {
        const parent = responses.get(id);
        if (
          parent?.done &&
          !parent.audio.length &&
          !responseSourceUnknown(parent) &&
          [...parent.outputs.values()].every((itemId) => {
            const item = translations.get(itemId);
            return !item?.sourceId && !item?.text.trim() && !item?.audioSeen;
          })
        ) {
          responseOrder.splice(responseOrder.indexOf(id), 1);
        }
      }
      // Only already-arrived output that is held for ordering starts this clock.
      // Quiet calls and an active first source do not acquire a call timer.
      const blocked = new Set(
        [...translations.values()]
          .filter(
            (item) =>
              phoneSourceAdmitted(item.sourceId) && hasPendingPhoneOutput(item),
          )
          .map((item) => item.translationId),
      );
      for (const [id, wait] of phoneOrderWaits) {
        if (!blocked.has(id)) {
          clearTimeout(wait);
          phoneOrderWaits.delete(id);
        }
      }
      for (const id of blocked) {
        if (phoneOrderWaits.has(id)) continue;
        phoneOrderWaits.set(
          id,
          setTimeout(() => {
            phoneOrderWaits.delete(id);
            if (!closed())
              fail('LIVETRANSLATE_SOURCE_ORDER_TIMEOUT', undefined, undefined, {
                validationPath: 'source.binding',
                expected: 'consistent_source_binding',
                actual: undefined,
              });
          }, PHONE_SOURCE_ORDER_WAIT_MS),
        );
      }
    } finally {
      drainingPhoneOutput = false;
    }
  }
  const translation = (event: any) => {
    if (
      !requireValue(
        identifier(event.response_id),
        'response_id',
        'nonempty_identifier_string',
        event.response_id,
      ) ||
      !requireValue(
        identifier(event.item_id),
        'item_id',
        'nonempty_identifier_string',
        event.item_id,
      ) ||
      !requireValue(
        integer(event.output_index),
        'output_index',
        'nonnegative_integer',
        event.output_index,
      ) ||
      !requireValue(
        event.output_index === 0,
        'output_index',
        'zero_index',
        event.output_index,
        'LIVETRANSLATE_UNSUPPORTED_SCHEMA',
      ) ||
      !requireValue(
        integer(event.content_index),
        'content_index',
        'nonnegative_integer',
        event.content_index,
      ) ||
      !requireValue(
        event.content_index === 0,
        'content_index',
        'zero_index',
        event.content_index,
        'LIVETRANSLATE_UNSUPPORTED_SCHEMA',
      )
    )
      return undefined;
    if (
      phone &&
      (terminalIdentifiers.has(`item:${event.item_id}`) ||
        terminalIdentifiers.has(`response:${event.response_id}`))
    )
      return undefined;
    if (sources.has(event.item_id)) {
      fail('LIVETRANSLATE_ITEM_CONFLICT', undefined, undefined, {
        validationPath: 'item_id',
        expected: 'consistent_item_binding',
        actual: event.item_id,
        conflictKind: 'output_after_source',
      });
      return undefined;
    }
    const parent = response(event.response_id);
    if (!parent || parent.done) return undefined;
    const priorId = parent.outputs.get(event.output_index);
    if (priorId && priorId !== event.item_id) {
      fail('LIVETRANSLATE_ITEM_CONFLICT', undefined, undefined, {
        validationPath: 'item_id',
        expected: 'consistent_item_binding',
        actual: event.item_id,
        conflictKind: 'response_slot_rebound',
      });
      return undefined;
    }
    parent.outputs.set(event.output_index, event.item_id);
    let item = translations.get(event.item_id);
    if (item && item.responseId !== event.response_id) {
      fail('LIVETRANSLATE_ITEM_CONFLICT', undefined, undefined, {
        validationPath: 'item_id',
        expected: 'consistent_item_binding',
        actual: event.item_id,
        conflictKind: 'output_response_rebound',
      });
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
    const created = unclassifiedCreated.get(event.item_id);
    if (created) {
      unclassifiedCreated.delete(event.item_id);
      if (created.ambiguous) {
        fail('LIVETRANSLATE_SOURCE_CONFLICT', undefined, undefined, {
          validationPath: 'source.binding',
          expected: 'consistent_source_binding',
          actual: created.predecessor,
        });
        return undefined;
      }
      bindOutputSource(event.item_id, created.predecessor);
      if (closed()) return undefined;
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
    if (phone) {
      pendingUsage.set(responseId, usage);
      publishPhoneUsage();
    } else emit(options.onUsage, usage);
  };
  const requiresTranslation = (translationId: string) => {
    const sourceId = associations.get(translationId);
    const source = sourceId ? sources.get(sourceId) : undefined;
    return Boolean(source?.final && source.text.trim());
  };
  const incompleteBoundOutput = () =>
    [...sources.values()].some(
      (source) =>
        source.final &&
        source.text.trim() &&
        ![...associations.values()].includes(source.sourceId),
    ) ||
    [...translations.values()].some(
      (item) =>
        (item.text.trim() || item.audioSeen) &&
        (!item.sourceId || !sources.has(item.sourceId)),
    ) ||
    [...associations.keys()].some((translationId) => {
      if (!requiresTranslation(translationId)) return false;
      const item = translations.get(translationId);
      return (
        !item ||
        !item.text.trim() ||
        !responses.get(item.responseId)?.done ||
        !item.textDone ||
        (role === 'local' && (!item.audioSeen || !item.audioDone))
      );
    });
  // UUIDs are not ordered. After bounded tombstones expire, a new source must
  // prove its place in this stream using VAD offsets before any text or audio
  // is exposed. Receive time and the language of its text are never substitutes.

  const releasePhoneAnchorWaits = () => {
    for (const [key, wait] of anchorWaits) {
      const admitted = key.startsWith('item:')
        ? phoneSourceAdmitted(key.slice(5))
        : [...(responses.get(key.slice(9))?.outputs.values() ?? [])].some(
            (id) => phoneSourceAdmitted(translations.get(id)?.sourceId),
          );
      if (admitted) {
        clearTimeout(wait);
        anchorWaits.delete(key);
      }
    }
  };

  const showSource = (source: Source) => {
    if (phone && source.text.trim() && !phoneSourceAdmitted(source.sourceId))
      waitForPhoneAnchor(`item:${source.sourceId}`);
    if (
      phone &&
      (!phoneSourceAdmitted(source.sourceId) ||
        sourcePublishedRevision.get(source.sourceId) === source.revision)
    )
      return;
    if (phone) sourcePublishedRevision.set(source.sourceId, source.revision);
    emit(options.onSource, { ...source });
  };

  function forgetCompletedEventDigests(keys: readonly string[]) {
    const keysSet = new Set(keys);
    for (const [eventId, owners] of eventOwners)
      if (owners.some((key) => keysSet.has(key))) {
        eventOwners.delete(eventId);
        seen.delete(eventId);
      }
  }
  const rememberTerminal = (keys: readonly string[]) => {
    for (const key of keys) {
      if (key.startsWith('item:')) unclassifiedCreated.delete(key.slice(5));
      terminalIdentifiers.set(key, true);
      const wait = anchorWaits.get(key);
      if (wait) clearTimeout(wait);
      anchorWaits.delete(key);
    }
    while (terminalIdentifiers.size > MAX_TERMINAL_IDENTIFIERS)
      terminalIdentifiers.delete(terminalIdentifiers.keys().next().value!);
    forgetCompletedEventDigests(keys);
  };

  const discardUnadmittedSource = (sourceId: string) => {
    const source = sources.get(sourceId);
    if (source?.startMs !== undefined) return;
    const itemIds = new Set(
      [...associations, ...pendingAssociations]
        .filter(([, id]) => id === sourceId)
        .map(([id]) => id),
    );
    const responseIds = new Set(
      [...translations.values()]
        .filter((item) => itemIds.has(item.translationId))
        .map((item) => item.responseId),
    );
    const keys = [
      `item:${sourceId}`,
      ...[...itemIds].map((id) => `item:${id}`),
      ...[...responseIds].map((id) => `response:${id}`),
    ];
    sources.delete(sourceId);
    sourcePublishedRevision.delete(sourceId);
    speechSeen.delete(sourceId);
    for (const id of itemIds) {
      translations.delete(id);
      associations.delete(id);
      pendingAssociations.delete(id);
      translationPublishedRevision.delete(id);
      associationPublished.delete(id);
    }
    for (const id of responseIds) {
      const parent = responses.get(id);
      if (parent)
        queuedAudioBytes -= parent.audio.reduce(
          (sum, chunk) => sum + chunk.pcm.length,
          0,
        );
      responses.delete(id);
      pendingUsage.delete(id);
      const index = responseOrder.indexOf(id);
      if (index !== -1) responseOrder.splice(index, 1);
    }
    rememberTerminal(keys);
    drainAudio();
  };
  const retirePhoneState = () => {
    if (!phone || closed()) return;
    releasePhoneAnchorWaits();
    publishPhoneUsage();
    // Completed empty noise has no future sound, text or source edge to retain.
    for (const [id, parent] of responses) {
      const outputIds = [...parent.outputs.values()];
      if (
        !parent.done ||
        parent.audio.length ||
        responseOrder.includes(id) ||
        !outputIds.every((itemId) => {
          const item = translations.get(itemId);
          return (
            item?.final &&
            !item.text.trim() &&
            !item.audioSeen &&
            !item.sourceId &&
            !associations.has(itemId) &&
            !pendingAssociations.has(itemId)
          );
        })
      )
        continue;
      responses.delete(id);
      pendingUsage.delete(id);
      for (const itemId of outputIds) {
        translations.delete(itemId);
        translationPublishedRevision.delete(itemId);
      }
      rememberTerminal([
        `response:${id}`,
        ...outputIds.map((itemId) => `item:${itemId}`),
      ]);
    }
    // Unresolved edges/ordering are active protection, never evicted for room.
    if (
      pendingAssociations.size ||
      [...sources.values()].some((source) => source.startMs === undefined) ||
      [...responses.values()].some(
        (parent) => !parent.done && parent.outputs.size === 0,
      ) ||
      [...translations.values()].some((item) => !item.sourceId)
    )
      return;
    const ordered = [...sources.values()].sort(
      (a, b) => a.startMs! - b.startMs!,
    );
    const completedGroup = (source: Source) => {
      if (
        !source.final ||
        source.startMs === undefined ||
        source.endMs === undefined
      )
        return undefined;
      const itemIds = [...associations]
        .filter(([, id]) => id === source.sourceId)
        .map(([id]) => id);
      if (source.text.trim() && itemIds.length === 0) return undefined;
      const items = itemIds.map((id) => translations.get(id));
      if (
        items.some(
          (item) =>
            !item ||
            !item.final ||
            !item.textDone ||
            (source.text.trim() && !item.text.trim()) ||
            (role === 'local' &&
              item.text.trim() &&
              (!item.audioDone || !item.audioSeen)),
        )
      )
        return undefined;
      const responseIds = [...new Set(items.map((item) => item!.responseId))];
      if (
        responseIds.some((id) => {
          const parent = responses.get(id);
          return (
            !parent?.done ||
            parent.audio.length > 0 ||
            responseOrder.includes(id) ||
            [...parent.outputs.values()].some(
              (outputId) => !itemIds.includes(outputId),
            )
          );
        })
      )
        return undefined;
      return { itemIds, responseIds };
    };
    const completed = new Map(
      ordered.flatMap((source) => {
        const group = completedGroup(source);
        return group ? [[source.sourceId, group] as const] : [];
      }),
    );
    // A done response/final source still fences duplicate semantic output. Its
    // frame digests no longer consume the active-event window during grace.
    for (const [id, group] of completed)
      forgetCompletedEventDigests([
        `item:${id}`,
        ...group.itemIds.map((itemId) => `item:${itemId}`),
        ...group.responseIds.map((responseId) => `response:${responseId}`),
      ]);
    for (const source of ordered) {
      if (completed.size <= COMPLETED_SOURCE_GRACE) break;
      const group = completed.get(source.sourceId);
      if (
        !group ||
        !ordered.some(
          (next) => next !== source && next.startMs! >= source.endMs!,
        )
      )
        break;
      const { itemIds, responseIds } = group;
      completed.delete(source.sourceId);
      sources.delete(source.sourceId);
      speechSeen.delete(source.sourceId);
      sourcePublishedRevision.delete(source.sourceId);
      for (const id of itemIds) {
        translations.delete(id);
        associations.delete(id);
        translationPublishedRevision.delete(id);
        associationPublished.delete(id);
      }
      for (const id of responseIds) {
        responses.delete(id);
        pendingUsage.delete(id);
      }
      sourceOffsetFloorMs = Math.max(sourceOffsetFloorMs, source.endMs!);
      rememberTerminal([
        `item:${source.sourceId}`,
        ...itemIds.map((id) => `item:${id}`),
        ...responseIds.map((id) => `response:${id}`),
      ]);
    }
    // Empty completed responses carry no source reference or sound to protect.
    for (const [id, parent] of responses)
      if (
        parent.done &&
        parent.outputs.size === 0 &&
        !parent.audio.length &&
        !responseOrder.includes(id)
      ) {
        responses.delete(id);
        pendingUsage.delete(id);
        rememberTerminal([`response:${id}`]);
      }
  };
  const handle = (event: any) => {
    if (
      !requireValue(
        event !== null && typeof event === 'object' && !Array.isArray(event),
        'json',
        'json_object',
        event,
      )
    )
      return;
    // The official quick start also recognizes a top-level gateway code.
    // Classify errors before optional event metadata; never retain provider text.
    if (
      event.type === 'error' ||
      (typeof event.code === 'string' && event.code.length > 0) ||
      typeof event.code === 'number'
    ) {
      const nested = event.type === 'error';
      const rawCode = nested ? event.error?.code : event.code;
      protocolEvent('provider_error', event, {
        providerError: {
          shape: nested ? 'nested_error' : 'gateway_code',
          code: sessionValue(rawCode, ['invalid_value']),
          type: sessionValue(event.error?.type, ['invalid_request_error']),
          parameter: sessionValue(event.error?.param, [
            'session.modalities',
            'session.voice',
            'session.output_modalities',
            'session.enable_voice_clone',
            'session.translation.language',
            'session.audio.input.format',
            'session.audio.output.format',
          ]),
        },
      });
      fail('LIVETRANSLATE_PROVIDER_REJECTED', undefined, undefined, {
        validationPath: event.type === 'error' ? 'error' : 'code',
        expected: 'no_provider_error',
        actual: event.type === 'error' ? event.error : event.code,
      });
      return;
    }
    if (
      !requireValue(
        identifier(event.type),
        'type',
        'event_type_string',
        event.type,
      )
    )
      return;
    // Extension notifications cannot mutate readiness, sources, usage or completion.
    if (!knownEventTypes.has(event.type)) return;
    if (
      !requireValue(
        event.event_id === undefined || identifier(event.event_id),
        'event_id',
        'optional_identifier_string',
        event.event_id,
      )
    )
      return;
    if (
      event.session_id !== undefined &&
      event.session_id !==
        (event.type === 'session.created' ? event.session?.id : sessionId)
    ) {
      fail('LIVETRANSLATE_SESSION_MISMATCH', undefined, undefined, {
        validationPath: 'session_id',
        expected: 'matching_session_id',
        actual: event.session_id,
      });
      return;
    }
    const owners = [
      ...(identifier(event.item_id) ? [`item:${event.item_id}`] : []),
      ...(identifier(event.item?.id) ? [`item:${event.item.id}`] : []),
      ...(identifier(event.previous_item_id)
        ? [`item:${event.previous_item_id}`]
        : []),
      ...(identifier(event.response_id)
        ? [`response:${event.response_id}`]
        : []),
      ...(identifier(event.response?.id)
        ? [`response:${event.response.id}`]
        : []),
      ...(Array.isArray(event.response?.output)
        ? event.response.output
            .filter((item: any) => identifier(item?.id))
            .map((item: any) => `item:${item.id}`)
        : []),
    ];
    if (
      phone &&
      event.type === 'conversation.item.created' &&
      event.item?.role === 'assistant' &&
      terminalIdentifiers.has(`item:${event.previous_item_id}`) &&
      identifier(event.item?.id) &&
      !terminalIdentifiers.has(`item:${event.item.id}`)
    ) {
      fail('LIVETRANSLATE_SOURCE_RETIRED', undefined, undefined, {
        validationPath: 'source.binding',
        expected: 'consistent_source_binding',
        actual: undefined,
      });
      return;
    }
    if (phone && owners.some((key) => terminalIdentifiers.has(key))) return;
    if (
      phone &&
      [
        'response.output_item.added',
        'response.output_item.done',
        'response.content_part.added',
        'response.content_part.done',
        'input_audio_buffer.committed',
        'input_audio_buffer.cleared',
      ].includes(event.type)
    )
      return;
    if (event.event_id !== undefined) {
      const digest = createHash('sha256')
        .update(canonicalEvent(event))
        .digest('hex');
      const old = seen.get(event.event_id);
      if (old) {
        if (old !== digest)
          fail('LIVETRANSLATE_EVENT_CONFLICT', undefined, undefined, {
            validationPath: 'event_id',
            expected: 'consistent_item_binding',
            actual: event.event_id,
          });
        return;
      }
      if (phone && seen.size >= MAX_EVENTS) {
        fail('LIVETRANSLATE_EVENT_CAPACITY', undefined, undefined, {
          validationPath: 'event_id',
          expected: 'bounded_capacity',
          actual: seen.size,
        });
        return;
      }
      seen.set(event.event_id, digest);
      if (phone) eventOwners.set(event.event_id, owners);
    }
    if (
      [
        'response.output_item.added',
        'response.output_item.done',
        'response.content_part.added',
        'response.content_part.done',
        'input_audio_buffer.committed',
        'input_audio_buffer.cleared',
      ].includes(event.type)
    )
      return;
    if (event.type === 'session.created') {
      observeVoice(event, null);
      if (closed()) return;
      if (
        !requireValue(
          state === 'connecting',
          'state',
          'valid_protocol_transition',
          state,
          'LIVETRANSLATE_SESSION_MISMATCH',
        ) ||
        !requireValue(
          identifier(event.session?.id),
          'session.id',
          'nonempty_identifier_string',
          event.session?.id,
          'LIVETRANSLATE_SESSION_MISMATCH',
        ) ||
        !requireValue(
          event.session?.model === LIVE_TRANSLATE_MODEL,
          'session.model',
          'exact_model',
          event.session?.model,
          'LIVETRANSLATE_SESSION_MISMATCH',
        )
      )
        return;
      sessionId = event.session.id;
      state = 'configuring';
      send({
        type: 'session.update',
        session: {
          output_modalities: [...modalities],
          voice,
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
      const missingCloneEcho =
        !!s && typeof s === 'object' && !Object.hasOwn(s, 'enable_voice_clone');
      const allowMissingCloneEcho =
        options.allowMissingVoiceCloneEcho === true &&
        role === 'local' &&
        missingCloneEcho;
      const approvedVoiceConflict =
        options.allowAndreTopLevelWithTinaOutput === true &&
        role === 'local' &&
        voice === 'Andre' &&
        s?.voice === 'Andre' &&
        s?.audio?.output?.voice === 'Tina';
      const checks: [
        boolean,
        LiveTranslateProtocolDiagnostic['validationPath'],
        LiveTranslateProtocolDiagnostic['expected'],
        unknown,
      ][] = [
        [state === 'configuring', 'state', 'valid_protocol_transition', state],
        [s?.id === sessionId, 'session.id', 'matching_session_id', s?.id],
        [
          s?.model === LIVE_TRANSLATE_MODEL,
          'session.model',
          'exact_model',
          s?.model,
        ],
        [
          s?.input_modalities === undefined ||
            (Array.isArray(s.input_modalities) &&
              s.input_modalities.includes('audio')),
          'session.input_modalities',
          'audio_input_enabled',
          s?.input_modalities,
        ],
        [
          Array.isArray(s?.output_modalities) &&
            s.output_modalities.length === modalities.length &&
            modalities.every((value) => s.output_modalities.includes(value)) &&
            new Set(s.output_modalities).size === modalities.length,
          'session.output_modalities',
          'exact_output_modalities',
          s?.output_modalities,
        ],
        [
          s?.audio?.input?.format?.type === 'pcm',
          'session.audio.input.format.type',
          'pcm',
          s?.audio?.input?.format?.type,
        ],
        [
          s?.audio?.input?.format?.sample_rate === 16000,
          'session.audio.input.format.sample_rate',
          '16000',
          s?.audio?.input?.format?.sample_rate,
        ],
        [
          s?.audio?.output?.format?.type === 'pcm',
          'session.audio.output.format.type',
          'pcm',
          s?.audio?.output?.format?.type,
        ],
        [
          s?.audio?.output?.format?.sample_rate === 24000,
          'session.audio.output.format.sample_rate',
          '24000',
          s?.audio?.output?.format?.sample_rate,
        ],
        [
          s?.audio?.output?.voice === voice || approvedVoiceConflict,
          'session.audio.output.voice',
          voice,
          s?.audio?.output?.voice,
        ],
        [
          s?.voice === undefined || s.voice === voice,
          'session.voice',
          voice,
          s?.voice,
        ],
        [
          s?.enable_voice_clone === false || allowMissingCloneEcho,
          'session.enable_voice_clone',
          'false',
          s?.enable_voice_clone,
        ],
        [
          s?.audio?.input?.turn_detection?.type === 'speaker_detection',
          'session.audio.input.turn_detection.type',
          'speaker_detection',
          s?.audio?.input?.turn_detection?.type,
        ],
        [
          s?.audio?.input?.turn_detection?.threshold === 0.5,
          'session.audio.input.turn_detection.threshold',
          '0.5',
          s?.audio?.input?.turn_detection?.threshold,
        ],
        [
          s?.translation?.language === target,
          'session.translation.language',
          'target_language',
          s?.translation?.language,
        ],
      ];
      const rejected = checks.find(([accepted]) => !accepted);
      const receivedAt = now();
      const sessionOutputVoiceEcho = voiceEcho(s?.audio?.output?.voice);
      if (!rejected)
        voicePolicy = Object.freeze({
          mode: approvedVoiceConflict
            ? 'approved_andre_tina_metadata_conflict'
            : 'strict_requested_voice',
          requestedVoice: voice,
          responseVoiceAllowlist: Object.freeze(
            approvedVoiceConflict ? (['Andre', 'Tina'] as const) : [voice],
          ),
          acknowledgement: Object.freeze({
            sessionId,
            eventId: event.event_id ?? null,
            receiveSequence,
            receivedAt,
            sessionTopLevelEcho: voiceEcho(s?.voice),
            sessionNestedEcho: sessionOutputVoiceEcho,
          }),
          acousticVoice: 'unknown_not_measured',
        });
      observeVoice(event, !rejected, receivedAt);
      emit(options.onSessionConfiguration, {
        role,
        sessionId: identifier(s?.id) ? s.id : null,
        eventId: event.event_id ?? null,
        receiveSequence,
        receivedAt,
        basis: 'provider_session_updated',
        model: sessionValue(s?.model, [LIVE_TRANSLATE_MODEL]),
        voice: sessionValue(s?.audio?.output?.voice, [
          'Aiden',
          'Tina',
          'Andre',
        ]),
        sessionOutputVoiceEcho,
        ...(!rejected ? { voicePolicy } : {}),
        requestedVoice: voice,
        topLevelVoice: sessionValue(s?.voice, ['Aiden', 'Tina', 'Andre']),
        ...(!rejected
          ? {
              voiceConfirmation: approvedVoiceConflict
                ? ('approved_top_level_andre_nested_tina' as const)
                : ('exact_match' as const),
            }
          : {}),
        voiceCloneEnabled:
          typeof s?.enable_voice_clone === 'boolean'
            ? s.enable_voice_clone
            : null,
        targetLanguage: sessionValue(s?.translation?.language, ['en', 'zh']),
        accepted: !rejected,
      });
      if (closed()) return;
      if (rejected) {
        const [, validationPath, expected, actual] = rejected;
        // An absent echo supplies no evidence about whether cloning is enabled.
        // Preserve the strict gate, but distinguish missing confirmation from
        // an explicit contradictory ACK or a provider error event.
        const code =
          validationPath === 'session.enable_voice_clone' &&
          actual === undefined
            ? 'LIVETRANSLATE_CLONE_CONFIRMATION_MISSING'
            : 'LIVETRANSLATE_CONFIGURATION_REJECTED';
        fail(code, undefined, undefined, { validationPath, expected, actual });
        return;
      }
      if (allowMissingCloneEcho) {
        emit(options.onProtocolDiagnostic, {
          role,
          at: receivedAt,
          stage: 'configuring',
          eventType: 'session.updated',
          validationPath: 'session.enable_voice_clone',
          expected: 'false',
          actualType: 'missing',
          fatal: false,
          code: 'LIVETRANSLATE_CLONE_CONFIRMATION_MISSING',
        });
        if (closed()) return;
      }
      if (approvedVoiceConflict) {
        emit(options.onProtocolDiagnostic, {
          role,
          at: receivedAt,
          stage: 'configuring',
          eventType: 'session.updated',
          validationPath: 'session.audio.output.voice',
          expected: 'Andre',
          actualType: 'string',
          fatal: false,
          code: 'LIVETRANSLATE_APPROVED_ANDRE_TINA_CONFLICT',
          acknowledgement: {
            sessionId,
            eventId: event.event_id ?? null,
            receiveSequence,
          },
        });
        if (closed()) return;
      }
      clearTimeout(timer);
      timer = undefined;
      state = 'ready';
      protocolEvent('configuration_accepted', event);
      readyResolve({
        sessionId,
        role,
        model: s.model,
        voice: s.audio.output.voice,
        sessionOutputVoiceEcho,
        voicePolicy,
        requestedVoice: voice,
        topLevelVoice: s.voice ?? null,
        voiceConfirmation: approvedVoiceConflict
          ? 'approved_top_level_andre_nested_tina'
          : 'exact_match',
        voiceCloneEnabled: missingCloneEcho ? null : s.enable_voice_clone,
        voiceCloneConfirmation: missingCloneEcho
          ? 'missing_echo_warning'
          : 'explicit_false',
        targetLanguage: s.translation.language,
        configurationAcknowledgement: {
          eventId: event.event_id ?? null,
          receiveSequence,
          receivedAt,
          basis: 'provider_session_updated',
        },
        inputSampleRate: s.audio.input.format.sample_rate,
        outputSampleRate: s.audio.output.format.sample_rate,
        outputModalities: Object.freeze([...s.output_modalities]) as (
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
      if (phone && anchorWaits.size) {
        fail('LIVETRANSLATE_SOURCE_ANCHOR_MISSING', undefined, undefined, {
          validationPath: 'source.binding',
          expected: 'consistent_source_binding',
          actual: undefined,
        });
        return;
      }
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
        const unboundSource = [...sources.values()].some(
          (source) =>
            source.final &&
            source.text.trim() &&
            ![...associations.values()].includes(source.sourceId),
        );
        const unboundOutput = [...translations.values()].some(
          (item) =>
            (item.text.trim() || item.audioSeen) &&
            (!item.sourceId || !sources.has(item.sourceId)),
        );
        const pendingResponse = [...responses.values()].some(
          (value) => !value.done,
        );
        const pendingSource = [...sources.values()].some(
          (source) =>
            (source.text || speechSeen.has(source.sourceId)) && !source.final,
        );
        let validationPath: LiveTranslateProtocolDiagnostic['validationPath'] =
          'source.translation';
        if (unboundSource) validationPath = 'source.translation';
        else if (unboundOutput) validationPath = 'source.binding';
        else if (pendingResponse) validationPath = 'response.status';
        else if (pendingSource) validationPath = 'transcript';
        fail('LIVETRANSLATE_FINISH_INCOMPLETE', undefined, undefined, {
          validationPath,
          expected:
            unboundSource || unboundOutput
              ? 'consistent_source_binding'
              : 'pending_output_complete',
          actual: undefined,
        });
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
      if (
        !requireValue(
          identifier(event.item_id),
          'item_id',
          'nonempty_identifier_string',
          event.item_id,
        )
      )
        return;
      const started = event.type.endsWith('started');
      const offset = started ? event.audio_start_ms : event.audio_end_ms;
      if (
        !requireValue(
          integer(offset),
          started ? 'audio_start_ms' : 'audio_end_ms',
          'nonnegative_integer',
          offset,
        ) ||
        !requireValue(
          event.speaker_id === undefined || integer(event.speaker_id),
          'speaker_id',
          'nonnegative_integer',
          event.speaker_id,
        )
      )
        return;
      if (
        phone &&
        (translations.has(event.item_id) ||
          associations.has(event.item_id) ||
          pendingAssociations.has(event.item_id))
      ) {
        fail('LIVETRANSLATE_ITEM_CONFLICT', undefined, undefined, {
          validationPath: 'item_id',
          expected: 'consistent_item_binding',
          actual: event.item_id,
          conflictKind: 'vad_after_output',
        });
        return;
      }
      if (
        phone &&
        sources.get(event.item_id)?.startMs === undefined &&
        offset < sourceOffsetFloorMs
      ) {
        discardUnadmittedSource(event.item_id);
        return;
      }
      const source = ensureSource(event.item_id);
      if (!source || (!phone && source.final)) return;
      speechSeen.add(source.sourceId);
      if (started) {
        if (
          phone &&
          source.startMs !== undefined &&
          source.startMs !== offset
        ) {
          fail('LIVETRANSLATE_SOURCE_CONFLICT');
          return;
        }
        source.startMs = offset;
        if (phone) sourceOrdinal(source);
        if (source.endMs !== undefined && source.endMs < offset) {
          fail('LIVETRANSLATE_EVENT_INVALID', undefined, undefined, {
            validationPath: 'audio_start_ms',
            expected: 'nondecreasing_offset',
            actual: offset,
          });
          return;
        }
        if (event.speaker_id !== undefined) source.speakerId = event.speaker_id;
      } else {
        if (phone && source.endMs !== undefined && source.endMs !== offset) {
          fail('LIVETRANSLATE_SOURCE_CONFLICT');
          return;
        }
        if (source.startMs !== undefined && offset < source.startMs) {
          fail('LIVETRANSLATE_EVENT_INVALID', undefined, undefined, {
            validationPath: 'audio_end_ms',
            expected: 'nondecreasing_offset',
            actual: offset,
          });
          return;
        }
        source.endMs = offset;
      }
      timing(started ? 'source_started' : 'source_stopped', {
        sourceId: source.sourceId,
        providerAudioMs: offset,
      });
      if (phone && phoneSourceAdmitted(source.sourceId)) {
        if (source.revision > 0) showSource(source);
        for (const [id, boundSource] of associations)
          if (boundSource === source.sourceId) {
            showAssociation(id, source.sourceId);
            const item = translations.get(id);
            if (item) showTranslation(item);
          }
        publishPhoneUsage();
        drainAudio();
      }
      return;
    }
    if (event.type.startsWith('conversation.item.input_audio_transcription.')) {
      if (
        !requireValue(
          identifier(event.item_id),
          'item_id',
          'nonempty_identifier_string',
          event.item_id,
        ) ||
        !requireValue(
          integer(event.content_index),
          'content_index',
          'nonnegative_integer',
          event.content_index,
        ) ||
        !requireValue(
          event.content_index === 0,
          'content_index',
          'zero_index',
          event.content_index,
          'LIVETRANSLATE_UNSUPPORTED_SCHEMA',
        )
      )
        return;
      if (event.type.endsWith('.failed')) {
        fail('LIVETRANSLATE_ASR_FAILED', undefined, undefined, {
          validationPath: 'error',
          expected: 'no_provider_error',
          actual: event.error,
        });
        return;
      }
      const source = ensureSource(event.item_id);
      if (!source || source.final) return;
      const final = event.type.endsWith('.completed');
      if (!final && !event.type.endsWith('.delta')) {
        fail('LIVETRANSLATE_MODEL_EVENT_MISMATCH', undefined, undefined, {
          validationPath: 'type',
          expected: 'known_3_8_event',
          actual: event.type,
        });
        return;
      }
      const text = final ? event.transcript : event.delta;
      if (
        !textValue(text) ||
        (!final && source.text.length + text.length > MAX_TEXT)
      ) {
        fail('LIVETRANSLATE_TRANSCRIPT_INVALID', undefined, undefined, {
          validationPath: final ? 'transcript' : 'delta',
          expected: 'text_within_limit',
          actual: text,
        });
        return;
      }
      source.text = final ? text : source.text + text;
      source.final = final;
      source.revision += 1;
      showSource(source);
      if (final) timing('source_final', { sourceId: source.sourceId });
      return;
    }
    if (event.type === 'conversation.item.created') {
      if (
        !requireValue(
          identifier(event.item?.id),
          'item.id',
          'nonempty_identifier_string',
          event.item?.id,
        )
      )
        return;
      if (phone && terminalIdentifiers.has(`item:${event.item.id}`)) return;
      if (
        Array.isArray(event.item.content) &&
        event.item.content.some((part: any) => part?.type === 'input_audio')
      ) {
        if (
          translations.has(event.item.id) ||
          associations.has(event.item.id) ||
          pendingAssociations.has(event.item.id)
        ) {
          fail('LIVETRANSLATE_ITEM_CONFLICT', undefined, undefined, {
            validationPath: 'item.id',
            expected: 'consistent_item_binding',
            actual: event.item.id,
            conflictKind: 'created_input_after_output',
          });
          return;
        }
        ensureSource(event.item.id);
        return;
      }
      if (event.item.role !== 'assistant') return;
      if (
        !identifier(event.previous_item_id) ||
        event.previous_item_id === event.item.id
      )
        return;
      if (sources.has(event.item.id)) return;
      if (!translations.has(event.item.id)) {
        const prior = unclassifiedCreated.get(event.item.id);
        if (prior) {
          // Do not guess whether this is a source or output. If later proved
          // output, inconsistent predecessor evidence still fails closed.
          prior.ambiguous ||= prior.predecessor !== event.previous_item_id;
        } else {
          if (unclassifiedCreated.size >= MAX_ITEMS) {
            fail('LIVETRANSLATE_ITEM_CAPACITY');
            return;
          }
          unclassifiedCreated.set(event.item.id, {
            predecessor: event.previous_item_id,
            ambiguous: false,
          });
        }
        return;
      }
      bindOutputSource(event.item.id, event.previous_item_id);
      if (closed()) return;
      if (phone) {
        publishPhoneUsage();
        drainAudio();
      }
      return;
    }
    if (event.type === 'response.created') {
      observeVoice(event, responseVoiceAllowed(event.response));
      if (closed()) return;
      if (
        !requireValue(
          identifier(event.response?.id),
          'response.id',
          'nonempty_identifier_string',
          event.response?.id,
        )
      )
        return;
      if (!responseConfiguration(event.response)) return;
      if (event.response.status !== 'in_progress') {
        fail('LIVETRANSLATE_RESPONSE_INCOMPLETE', undefined, undefined, {
          validationPath: 'response.status',
          expected: 'in_progress',
          actual: event.response.status,
        });
        return;
      }
      const item = response(event.response.id);
      if (item && !item.createdSeen && !item.done) {
        item.createdSeen = true;
        responseCreatedSequence += 1;
        item.createdSequence = responseCreatedSequence;
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
      fail('LIVETRANSLATE_MODEL_EVENT_MISMATCH', undefined, undefined, {
        validationPath: 'type',
        expected: 'known_3_8_event',
        actual: event.type,
      });
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
          fail('LIVETRANSLATE_AUDIO_INVALID', undefined, undefined, {
            validationPath: 'delta',
            expected: 'base64_pcm16',
            actual: event.delta,
          });
          return;
        }
        const pcm = Buffer.from(event.delta, 'base64');
        if (!pcm.length || pcm.length % 2 || pcm.length > 256 * 1024) {
          fail('LIVETRANSLATE_AUDIO_INVALID', undefined, undefined, {
            validationPath: 'delta',
            expected: 'base64_pcm16',
            actual: event.delta,
          });
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
        parent.audio.push({
          pcm,
          item,
          eventId: event.event_id ?? `local_receive_${receiveSequence}`,
          eventIdBasis:
            event.event_id === undefined
              ? 'local_receive_sequence'
              : 'provider_event_id',
        });
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
        let text = event.delta;
        let textPath: LiveTranslateProtocolDiagnostic['validationPath'] =
          'delta';
        if (final) {
          text =
            event.type === 'response.text.done' ? event.text : event.transcript;
          textPath =
            event.type === 'response.text.done' ? 'text' : 'transcript';
        }
        if (
          !textValue(text) ||
          (!final && item.text.length + text.length > MAX_TEXT)
        ) {
          fail('LIVETRANSLATE_TRANSCRIPT_INVALID', undefined, undefined, {
            validationPath: textPath,
            expected: 'text_within_limit',
            actual: text,
          });
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
      observeVoice(event, responseVoiceAllowed(event.response));
      if (closed()) return;
      if (
        !requireValue(
          identifier(event.response?.id),
          'response.id',
          'nonempty_identifier_string',
          event.response?.id,
        )
      )
        return;
      const parent = response(event.response.id);
      if (!parent) return;
      if (!parent.done) reportUsage(event.response.id, event.response.usage);
      if (closed()) return;
      if (!responseConfiguration(event.response)) return;
      if (parent.done) return;
      if (!parent.createdSeen) {
        fail('LIVETRANSLATE_RESPONSE_ORDER_UNKNOWN');
        return;
      }
      if (event.response.status !== 'completed') {
        fail('LIVETRANSLATE_RESPONSE_INCOMPLETE', undefined, undefined, {
          validationPath: 'response.status',
          expected: 'completed',
          actual: event.response.status,
        });
        return;
      }
      if (
        !requireValue(
          Array.isArray(event.response.output),
          'response.output',
          'array',
          event.response.output,
        ) ||
        !requireValue(
          event.response.output.length <= 1,
          'response.output',
          'single_output_item',
          event.response.output,
          'LIVETRANSLATE_UNSUPPORTED_SCHEMA',
        )
      )
        return;
      if (event.response.output.length === 0 && parent.outputs.size > 0) {
        fail('LIVETRANSLATE_ITEM_CONFLICT', undefined, undefined, {
          validationPath: 'response.output',
          expected: 'consistent_item_binding',
          actual: event.response.output,
          conflictKind: 'completed_output_missing',
        });
        return;
      }
      for (const [index, output] of event.response.output.entries()) {
        if (
          index !== 0 ||
          !identifier(output?.id) ||
          !Array.isArray(output.content) ||
          output.content.length > 1
        ) {
          fail(
            index !== 0 || output?.content?.length > 1
              ? 'LIVETRANSLATE_UNSUPPORTED_SCHEMA'
              : 'LIVETRANSLATE_EVENT_INVALID',
            undefined,
            undefined,
            {
              validationPath: 'response.output',
              expected:
                index !== 0 ? 'single_output_item' : 'single_content_part',
              actual: event.response.output,
            },
          );
          return;
        }
        const item = translation({
          response_id: event.response.id,
          item_id: output.id,
          output_index: index,
          content_index: 0,
        });
        if (!item) return;
        if (
          !requireValue(
            output.role === undefined || output.role === 'assistant',
            'response.output.0.role',
            'output_modality',
            output.role,
          ) ||
          !requireValue(
            output.type === undefined || output.type === 'message',
            'response.output.0.type',
            'output_modality',
            output.type,
          ) ||
          !requireValue(
            output.status === undefined || output.status === 'completed',
            'response.output.0.status',
            'completed',
            output.status,
          )
        )
          return;
        const content = output.content[0];
        if (
          content !== undefined &&
          !requireValue(
            content?.type === (role === 'local' ? 'audio' : 'text'),
            'response.output.0.content.0.type',
            'output_modality',
            content?.type,
          )
        )
          return;
        const text = role === 'local' ? content?.transcript : content?.text;
        if (content !== undefined) {
          if (!textValue(text)) {
            fail('LIVETRANSLATE_TRANSCRIPT_INVALID', undefined, undefined, {
              validationPath:
                role === 'local'
                  ? 'response.output.0.content.0.transcript'
                  : 'response.output.0.content.0.text',
              expected: 'text_within_limit',
              actual: text,
            });
            return;
          }
          if (item.textDone && item.text !== text) {
            fail('LIVETRANSLATE_TRANSCRIPT_INVALID', undefined, undefined, {
              validationPath:
                role === 'local'
                  ? 'response.output.0.content.0.transcript'
                  : 'response.output.0.content.0.text',
              expected: 'consistent_item_binding',
              actual: text,
            });
            return;
          }
          item.text = text;
          if (!item.textDone)
            timing('translation_completed', {
              translationId: item.translationId,
              responseId: item.responseId,
              ...(item.sourceId ? { sourceId: item.sourceId } : {}),
            });
        }
      }
      const unfinished = [...translations.values()].find(
        (item) =>
          item.responseId === event.response.id &&
          ((!item.textDone && (item.text.trim() || item.audioSeen)) ||
            (role === 'local' && item.audioSeen && !item.audioDone)),
      );
      if (unfinished) {
        fail('LIVETRANSLATE_RESPONSE_INCOMPLETE', undefined, undefined, {
          validationPath: !unfinished.textDone
            ? 'response.text.done'
            : 'response.audio.done',
          expected: 'pending_output_complete',
          actual: undefined,
        });
        return;
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
        item.revision += 1;
        showTranslation(item);
      }
      const completedItems = [...translations.values()].filter(
        (item) => item.responseId === event.response.id,
      );
      timing('response_completed', {
        responseId: event.response.id,
        outputItemCount: event.response.output.length,
        outputTextCharacters: completedItems.reduce(
          (sum, item) => sum + item.text.length,
          0,
        ),
        outputAudioSeen: completedItems.some((item) => item.audioSeen),
      });
      parent.audioReleased = true;
      drainAudio();
    }
    // Other documented bookkeeping events do not synthesize source bindings.
  };
  socket.on('message', (raw: WebSocket.RawData, isBinary?: boolean) => {
    if (closed()) return;
    const frameReceivedAt = now();
    receiveSequence += 1;
    currentEvent = undefined;
    let bytes: Buffer;
    try {
      bytes = Buffer.isBuffer(raw)
        ? raw
        : Buffer.concat(Array.isArray(raw) ? raw : [Buffer.from(raw)]);
    } catch {
      protocolEvent('server_frame', undefined, { at: frameReceivedAt });
      fail('LIVETRANSLATE_EVENT_INVALID', undefined, undefined, {
        validationPath: 'frame',
        expected: 'text_json_frame',
        actual: raw,
      });
      return;
    }
    if (isBinary) {
      protocolEvent('server_frame', undefined, {
        at: frameReceivedAt,
        frameBytes: bytes.length,
        frameBinary: true,
      });
      fail('LIVETRANSLATE_EVENT_INVALID', undefined, undefined, {
        validationPath: 'frame.binary',
        expected: 'false',
        actual: true,
      });
      return;
    }
    if (bytes.length > MAX_BYTES) {
      protocolEvent('server_frame', undefined, {
        at: frameReceivedAt,
        frameBytes: bytes.length,
        frameBinary: false,
      });
      fail('LIVETRANSLATE_EVENT_INVALID', undefined, undefined, {
        validationPath: 'frame.bytes',
        expected: 'bounded_capacity',
        actual: bytes.length,
      });
      return;
    }
    let jsonText: string;
    try {
      jsonText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      protocolEvent('server_frame', undefined, {
        at: frameReceivedAt,
        frameBytes: bytes.length,
        frameBinary: false,
      });
      fail('LIVETRANSLATE_EVENT_INVALID', undefined, undefined, {
        validationPath: 'frame.utf8',
        expected: 'valid_utf8',
        actual: bytes,
      });
      return;
    }
    try {
      currentEvent = JSON.parse(jsonText);
    } catch {
      protocolEvent('server_frame', undefined, {
        at: frameReceivedAt,
        frameBytes: bytes.length,
        frameBinary: false,
      });
      fail('LIVETRANSLATE_EVENT_INVALID', undefined, undefined, {
        validationPath: 'json',
        expected: 'valid_json',
        actual: jsonText,
      });
      return;
    }
    protocolEvent('server_frame', currentEvent, {
      at: frameReceivedAt,
      frameBytes: bytes.length,
      frameBinary: false,
    });
    if (closed()) return;
    if (!phone && receiveSequence > MAX_EVENTS) {
      fail('LIVETRANSLATE_EVENT_CAPACITY', undefined, undefined, {
        validationPath: 'frame',
        expected: 'bounded_capacity',
        actual: receiveSequence,
      });
      return;
    }
    try {
      handle(currentEvent);
      if (phone) drainPhoneOutput();
      retirePhoneState();
    } catch {
      fail('LIVETRANSLATE_HANDLER_FAILED', undefined, undefined, {
        validationPath: 'internal.handler',
        expected: 'handler_completed',
        actual: undefined,
      });
    }
  });
  socket.on('open', () => protocolEvent('transport_open'));
  socket.on('error', () => {
    currentEvent = undefined;
    protocolEvent('transport_error');
    fail('LIVETRANSLATE_CONNECTION_FAILED', undefined, undefined, {
      validationPath: 'frame',
      expected: 'error_free_transport',
      actual: undefined,
    });
  });
  socket.on('unexpected-response', (_request, httpResponse) => {
    protocolEvent(
      'transport_error',
      undefined,
      integer(httpResponse.statusCode) &&
        httpResponse.statusCode >= 100 &&
        httpResponse.statusCode <= 599
        ? { httpStatusCode: httpResponse.statusCode }
        : {},
    );
    fail('LIVETRANSLATE_CONNECTION_FAILED', undefined, httpResponse.statusCode);
    httpResponse.destroy();
  });
  socket.on('close', (code) => {
    if (transportCloseObserved) return;
    transportCloseObserved = true;
    sendPump?.observeClose(code);
    const metadata =
      integer(code) && code >= 1000 && code <= 4999 ? { code } : {};
    const at = now();
    protocolEvent(
      'transport_close',
      undefined,
      metadata.code ? { closeCode: metadata.code } : {},
    );
    resolveTransportClosed({ observed: true, at, ...metadata });
    if (!closed()) {
      currentEvent = undefined;
      fail('LIVETRANSLATE_CONNECTION_CLOSED', code, undefined, {
        validationPath: 'frame',
        expected: 'error_free_transport',
        actual: code,
      });
    }
  });
  arm('LIVETRANSLATE_READY_TIMEOUT');
  return {
    ready,
    transportClosed,
    retentionSnapshot: () => ({
      usage: phone ? 'phone' : 'audition',
      activeSources: sources.size,
      activeTranslations: translations.size,
      activeResponses: responses.size,
      pendingAssociations: pendingAssociations.size,
      retainedEventIds: seen.size,
      terminalIdentifiers: terminalIdentifiers.size,
      sourceOffsetFloorMs,
    }),
    append(pcm) {
      if (closed() || finishRequested || state !== 'ready')
        throw new Error(failure || 'LIVETRANSLATE_NOT_READY');
      if (
        !Buffer.isBuffer(pcm) ||
        !pcm.length ||
        pcm.length % 2 ||
        pcm.length > 256 * 1024
      ) {
        fail('LIVETRANSLATE_INPUT_INVALID', undefined, undefined, {
          validationPath: 'audio',
          expected: 'pcm16_bytes',
          actual: pcm,
        });
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
