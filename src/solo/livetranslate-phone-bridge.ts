import { createHash } from 'node:crypto';
import type WebSocket from 'ws';

import {
  createLiveTranslateClient,
  isLiveTranslateFailureCode,
  type LiveTranslateAudioMetadata,
  type LiveTranslateClient,
  type LiveTranslateClientOptions,
  type LiveTranslateRole,
  type LiveTranslateSession,
  type LiveTranslateSource,
  type LiveTranslateTranslation,
} from '../experiments/livetranslate-client';
import {
  ContinuousTranslationBridge,
  type ContinuousTranslationBridgeOptions,
} from './continuous-translation-bridge';
import {
  assertLiveTranslatePhoneConfig,
  type LiveTranslatePhoneConfig,
} from './livetranslate-phone-config';
import {
  LIVE_TRANSLATE_PHONE_FAILURE_CODES,
  type LiveTranslatePhoneDiagnostic,
} from './livetranslate-phone-types';
import type {
  TranscriptEvent,
  TranslationAudioDiagnostic,
  TranslationRole,
} from './translation-bridge';
import type { ContinuousTranslationOptions } from './continuous-translation-client';
import {
  projectLiveTranslateProtocolFailure,
  projectLiveTranslateProtocolWarning,
  projectLiveTranslateSendObservation,
} from './livetranslate-phone-diagnostics';

const MAX_PCM_QUEUE_BYTES = 2 * 1024 * 1024;
const PCM_PACKET_BYTES = 9600; // 200 ms at 24 kHz, never hold a full paragraph.
const MAX_PHONE_OUTSTANDING_BYTES = 48000; // Six seconds, below shared 8 s cap.
const MAX_PROJECTIONS = 2048;
const phoneCodes = new Set<string>(LIVE_TRANSLATE_PHONE_FAILURE_CODES);
type Selection = {
  config: LiveTranslatePhoneConfig;
  deps?: { createClient?: typeof createLiveTranslateClient };
  onDiagnostic?: (event: LiveTranslatePhoneDiagnostic) => void;
};
type Output = {
  responseId: string;
  utteranceId?: string;
  sequence: number;
  pending: number;
  marks: Set<string>;
  sealed: boolean;
  sealReported: boolean;
  delivered: boolean;
  audioExpected: boolean;
};
type Packet = { pcm: Buffer; output: Output };
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Explicit third provider, never registered by this module. Phone ownership
 * stays with SessionManager; model failure stops translation but not the
 * remote-original route, and never reconnects, changes supplier or dials. */
export function createLiveTranslatePhoneBridge(
  options: ContinuousTranslationBridgeOptions,
  selection: Selection,
): {
  attach(role: TranslationRole, socket: WebSocket, streamSid: string): void;
  close(): void;
} {
  assertLiveTranslatePhoneConfig(selection.config);
  if (
    options.localVoice ||
    options.outgoingPrefixes ||
    options.remoteCaptions === false
  )
    throw new Error('LIVETRANSLATE_PHONE_CONFIGURATION_INVALID');
  const config = Object.freeze({ ...selection.config });
  const factory = selection.deps?.createClient ?? createLiveTranslateClient;
  const now = options.now ?? Date.now;
  const clients: Partial<Record<LiveTranslateRole, LiveTranslateClient>> = {};
  const sessions: Partial<Record<LiveTranslateRole, LiveTranslateSession>> = {};
  const acceptedSessionIds: Partial<Record<LiveTranslateRole, string>> = {};
  const aborted = new Set<LiveTranslateClient>();
  const outputs = new Map<string, Output>();
  const utterances = new Map<string, Output>();
  const deliveries = new Map<string, { bytes: number; output: Output }>();
  const packets: Packet[] = [];
  const audioReceipts = new Map<number, string>();
  const sourceTimes = new Map<string, number>();
  const sourceOutputs = new Map<string, Set<string>>();
  const sourceNumbers = new Map<string, number>();
  const responseNumbers = new Map<string, number>();
  const responseSources = new Map<string, number>();
  const knownLinks = new Map<string, number>();
  const translations = new Map<
    string,
    { id: string; event: LiveTranslateTranslation }
  >();
  let inner: ContinuousTranslationBridge;
  let localSink: ContinuousTranslationOptions['onAudio'];
  let stopped = false;
  let closed = false;
  let pumping = false;
  let queuedBytes = 0;
  let outstandingBytes = 0;
  let receivedSequence = 0;
  let outputSequence = 0;
  let sourceSequence = 0;
  let responseSequence = 0;
  let protocolFailureReported = false;

  const notify = <T>(callback: ((event: T) => void) | undefined, event: T) => {
    try {
      callback?.(event);
    } catch {
      /* Metadata observers cannot own a phone. */
    }
  };
  const diagnostic = (event: Omit<LiveTranslatePhoneDiagnostic, 'clock'>) => {
    const snapshot: LiveTranslatePhoneDiagnostic = {
      ...event,
      clock: 'application_epoch_ms',
      actualPlaybackStartAt: null,
      ...(event.providerAudioMs === undefined
        ? {}
        : { providerEndpointBasis: 'provider_stream_estimate' }),
    };
    notify(selection.onDiagnostic, snapshot);
    notify(options.onLiveTranslateDiagnostic, snapshot);
  };
  const abortClients = () => {
    for (const client of Object.values(clients)) {
      if (!aborted.has(client)) {
        aborted.add(client);
        try {
          client.abort();
        } catch {
          /* Continue independent session cleanup. */
        }
      }
    }
  };
  const clearRecords = () => {
    packets.length = 0;
    queuedBytes = 0;
    outstandingBytes = 0;
    outputs.clear();
    utterances.clear();
    deliveries.clear();
    audioReceipts.clear();
    sourceTimes.clear();
    sourceOutputs.clear();
    translations.clear();
    sourceNumbers.clear();
    responseNumbers.clear();
    responseSources.clear();
    knownLinks.clear();
  };
  const stop = (
    role: LiveTranslateRole,
    rawCode: unknown,
    details: { closeCode?: unknown; httpStatusCode?: unknown } = {},
  ) => {
    if (stopped || closed) return;
    stopped = true;
    const code =
      isLiveTranslateFailureCode(rawCode) ||
      (typeof rawCode === 'string' && phoneCodes.has(rawCode))
        ? rawCode
        : 'LIVETRANSLATE_PHONE_SESSION_FAILED';
    clearRecords();
    abortClients();
    inner?.stopTranslation();
    notify(options.onOutgoingCaptionState, {
      role: 'local',
      state: 'failed',
      translationSource: 'independent_text',
    });
    notify(options.onCaptionState, {
      state: 'failed',
      code,
      translationStopped: true,
    });
    diagnostic({
      role,
      stage: 'failed',
      at: now(),
      code,
      ...(integer(details.closeCode) &&
      details.closeCode >= 1000 &&
      details.closeCode <= 4999
        ? { closeCode: details.closeCode }
        : {}),
      ...(integer(details.httpStatusCode) &&
      details.httpStatusCode >= 100 &&
      details.httpStatusCode <= 599
        ? { httpStatusCode: details.httpStatusCode }
        : {}),
    });
  };
  const active = (
    role: LiveTranslateRole,
    event: { role: LiveTranslateRole; sessionId: string },
  ) =>
    !stopped &&
    !closed &&
    event.role === role &&
    event.sessionId === (sessions[role]?.sessionId ?? acceptedSessionIds[role]);
  const transcript = (event: TranscriptEvent) => {
    if (stopped || closed) return;
    try {
      options.onTranscript(event);
    } catch {
      stop(event.role, 'LIVETRANSLATE_PHONE_CALLBACK_FAILED');
    }
  };
  const sourceKey = (event: {
    role: LiveTranslateRole;
    sessionId: string;
    sourceId: string;
  }) =>
    `livetranslate:${event.role}:source:${event.sessionId}:${event.sourceId}`;
  const outputKey = (event: {
    role: LiveTranslateRole;
    sessionId: string;
    translationId: string;
  }) =>
    `livetranslate:${event.role}:output:${event.sessionId}:${event.translationId}`;
  const boundedSet = <T>(
    map: Map<string, T>,
    key: string,
    value: T,
    onRetire?: (key: string) => void,
  ) => {
    map.set(key, value);
    if (map.size > MAX_PROJECTIONS) {
      const retired = map.keys().next().value!;
      map.delete(retired);
      onRetire?.(retired);
    }
  };
  const onSource = (role: LiveTranslateRole, event: LiveTranslateSource) => {
    if (!active(role, event)) return;
    const id = sourceKey(event);
    if (!sourceNumbers.has(id)) {
      sourceSequence += 1;
      boundedSet(sourceNumbers, id, sourceSequence);
    }
    if (!sourceTimes.has(id)) boundedSet(sourceTimes, id, event.at);
    transcript({
      id: `${id}:original`,
      utteranceId: id,
      role,
      kind: 'original',
      text: event.text,
      final: event.final,
      revision: event.revision,
      at: sourceTimes.get(id)!,
      pairing: 'explicit',
      boundary: 'semantic',
    });
  };
  const responseKey = (
    role: LiveTranslateRole,
    sessionId: string,
    responseId: string,
  ) => `${role}:${sessionId}:${responseId}`;
  const responseNumber = (
    role: LiveTranslateRole,
    sessionId: string,
    responseId: string,
  ) => {
    const key = responseKey(role, sessionId, responseId);
    if (!responseNumbers.has(key)) {
      responseSequence += 1;
      boundedSet(responseNumbers, key, responseSequence);
    }
    return responseNumbers.get(key)!;
  };
  const observeLink = (
    event: LiveTranslateTranslation | LiveTranslateAudioMetadata,
  ) => {
    if (event.pairing !== 'explicit' || !event.sourceId) return;
    const source = sourceNumbers.get(
      sourceKey({ ...event, sourceId: event.sourceId }),
    );
    if (source === undefined) return; // No late/nearest-source guess.
    const key = outputKey(event);
    if (knownLinks.get(key) === source) return;
    boundedSet(knownLinks, key, source);
    boundedSet(
      responseSources,
      responseKey(event.role, event.sessionId, event.responseId),
      source,
    );
    diagnostic({
      role: event.role,
      stage: 'association',
      at: now(),
      sourceSequence: source,
      responseSequence: responseNumber(
        event.role,
        event.sessionId,
        event.responseId,
      ),
    });
  };
  const onTranslation = (
    role: LiveTranslateRole,
    event: LiveTranslateTranslation,
  ) => {
    if (!active(role, event)) return;
    const key = outputKey(event);
    const previous = translations.get(key);
    if (previous && event.revision <= previous.event.revision) return;
    observeLink(event);
    const linked =
      event.pairing === 'explicit' && event.sourceId
        ? sourceKey({ ...event, sourceId: event.sourceId })
        : undefined;
    let multiple = false;
    if (linked) {
      const items = sourceOutputs.get(linked) ?? new Set<string>();
      const ambiguity = items.size === 1 && !items.has(key);
      items.add(key);
      boundedSet(sourceOutputs, linked, items);
      multiple = items.size > 1;
      if (ambiguity) {
        diagnostic({
          role,
          at: now(),
          stage: 'warning',
          code: 'LIVETRANSLATE_MULTIPLE_ITEMS_FOR_SOURCE',
        });
        for (const itemKey of items) {
          const old = translations.get(itemKey);
          if (itemKey !== key && old?.id === linked) {
            transcript({
              id: `${linked}:translation`,
              utteranceId: linked,
              role,
              kind: 'translation',
              text: '',
              final: true,
              at: old.event.at,
              pairing: 'explicit',
              boundary: 'semantic',
            });
            old.id = outputKey(old.event);
            transcript({
              id: `${old.id}:translation`,
              utteranceId: old.id,
              role,
              kind: 'translation',
              text: old.event.text,
              final: old.event.final,
              at: old.event.at,
              pairing: 'unpaired',
              boundary: 'diagnostic',
            });
          }
        }
      }
    }
    const id = linked && !multiple ? linked : key;
    if (previous && previous.id !== id)
      transcript({
        id: `${previous.id}:translation`,
        utteranceId: previous.id,
        role,
        kind: 'translation',
        text: '',
        final: true,
        at: event.at,
        pairing: 'unpaired',
        boundary: 'diagnostic',
      });
    boundedSet(translations, key, { id, event: { ...event } }, (retired) => {
      for (const [source, items] of sourceOutputs) {
        items.delete(retired);
        if (!items.size) sourceOutputs.delete(source);
      }
    });
    transcript({
      id: `${id}:translation`,
      utteranceId: id,
      role,
      kind: 'translation',
      text: event.text,
      final: event.final,
      at: linked && !multiple ? (sourceTimes.get(id) ?? event.at) : event.at,
      pairing: linked && !multiple ? 'explicit' : 'unpaired',
      boundary: linked && !multiple ? 'semantic' : 'diagnostic',
    });
  };
  const output = (responseId: string) => {
    let record = outputs.get(responseId);
    if (!record) {
      if (outputs.size >= 256) {
        stop('local', 'LIVETRANSLATE_PHONE_AUDIO_BACKLOG');
        return undefined;
      }
      outputSequence += 1;
      record = {
        responseId,
        sequence: outputSequence,
        pending: 0,
        marks: new Set(),
        sealed: false,
        sealReported: false,
        delivered: false,
        audioExpected: false,
      };
      outputs.set(responseId, record);
    }
    return record;
  };
  const settle = (record: Output) => {
    if (
      stopped ||
      closed ||
      outputs.get(record.responseId) !== record ||
      !record.sealed ||
      record.pending
    )
      return;
    // A later response can be complete at the supplier while its PCM still
    // waits in the client's response FIFO. Do not retire or fabricate a tail.
    if (record.audioExpected && !record.delivered) return;
    if (record.delivered && !record.sealReported) {
      record.sealReported = true;
      // The shared bridge uses the exact number of media deliveries. This is
      // producer completion, not proof the receiver has begun to play.
      inner.completeOutgoingUtterance(record.utteranceId!);
    }
    if (!record.marks.size) {
      if (record.delivered)
        diagnostic({
          role: 'local',
          stage: 'playback_drained',
          at: now(),
          sequence: record.sequence,
          responseSequence: responseNumbers.get(
            responseKey('local', sessions.local!.sessionId, record.responseId),
          ),
          sourceSequence: responseSources.get(
            responseKey('local', sessions.local!.sessionId, record.responseId),
          ),
          actualPlaybackStartAt: null,
        });
      outputs.delete(record.responseId);
      if (record.utteranceId) utterances.delete(record.utteranceId);
    }
  };
  const pump = () => {
    if (pumping || stopped || closed || !sessions.local) return;
    pumping = true;
    try {
      while (!stopped && !closed && packets.length) {
        const packet = packets[0];
        if (
          deliveries.size >= 200 ||
          outstandingBytes + Math.ceil(packet.pcm.length / 6) >
            MAX_PHONE_OUTSTANDING_BYTES
        )
          break;
        packets.shift();
        queuedBytes -= packet.pcm.length;
        packet.output.pending -= 1;
        localSink!(packet.pcm, { utteranceId: packet.output.utteranceId });
        queueMicrotask(() => settle(packet.output));
      }
    } catch {
      stop('local', 'LIVETRANSLATE_PHONE_SESSION_FAILED');
    } finally {
      pumping = false;
    }
  };
  const audioDiagnostic = (event: TranslationAudioDiagnostic) => {
    if (
      !closed &&
      !stopped &&
      event.role === 'local' &&
      event.utteranceId &&
      event.deliveryId
    ) {
      const record = utterances.get(event.utteranceId);
      if (
        record &&
        event.stage === 'generated' &&
        !deliveries.has(event.deliveryId)
      ) {
        deliveries.set(event.deliveryId, {
          bytes: event.generatedBytes,
          output: record,
        });
        record.marks.add(event.deliveryId);
        outstandingBytes += event.generatedBytes;
        record.delivered = true;
        diagnostic({
          role: 'local',
          stage: 'playback_queued',
          at: now(),
          sequence: record.sequence,
          responseSequence: responseNumbers.get(
            responseKey('local', sessions.local!.sessionId, record.responseId),
          ),
          sourceSequence: responseSources.get(
            responseKey('local', sessions.local!.sessionId, record.responseId),
          ),
          bytes: event.generatedBytes,
          queuedBytes,
          outstandingAudioMs: outstandingBytes / 8,
          actualPlaybackStartAt: null,
        });
      } else if (event.stage === 'playback_confirmed') {
        const receipt = deliveries.get(event.deliveryId);
        if (receipt) {
          deliveries.delete(event.deliveryId);
          receipt.output.marks.delete(event.deliveryId);
          outstandingBytes = Math.max(0, outstandingBytes - receipt.bytes);
          queueMicrotask(() => settle(receipt.output));
          pump();
        }
      }
    }
    notify(options.onAudioDiagnostic, event);
  };
  const onAudio = (
    role: LiveTranslateRole,
    pcm: Buffer,
    metadata: LiveTranslateAudioMetadata,
  ) => {
    if (!active(role, metadata)) return;
    if (role === 'remote') {
      stop(role, 'LIVETRANSLATE_PHONE_REMOTE_AUDIO_FORBIDDEN');
      return;
    }
    if (
      !Buffer.isBuffer(pcm) ||
      !pcm.length ||
      pcm.length % 2 ||
      !integer(metadata.sequence) ||
      metadata.sequence < 1
    ) {
      stop(role, 'LIVETRANSLATE_PHONE_AUDIO_INVALID');
      return;
    }
    const digest = createHash('sha256')
      .update(pcm)
      .update(
        JSON.stringify([
          metadata.responseId,
          metadata.translationId,
          metadata.eventId,
          metadata.sourceId ?? null,
          metadata.pairing,
        ]),
      )
      .digest('hex');
    const prior = audioReceipts.get(metadata.sequence);
    if (prior === digest) return;
    if (prior || metadata.sequence !== receivedSequence + 1) {
      stop(role, 'LIVETRANSLATE_PHONE_AUDIO_ORDER_INVALID');
      return;
    }
    observeLink(metadata);
    receivedSequence = metadata.sequence;
    audioReceipts.set(receivedSequence, digest);
    if (audioReceipts.size > 256)
      audioReceipts.delete(audioReceipts.keys().next().value!);
    if (queuedBytes + pcm.length > MAX_PCM_QUEUE_BYTES) {
      stop(role, 'LIVETRANSLATE_PHONE_AUDIO_BACKLOG');
      return;
    }
    const record = output(metadata.responseId);
    if (!record) return;
    const id = outputKey(metadata);
    if (record.utteranceId && record.utteranceId !== id) {
      stop(role, 'LIVETRANSLATE_PHONE_AUDIO_ORDER_INVALID');
      return;
    }
    record.utteranceId = id;
    utterances.set(id, record);
    for (let offset = 0; offset < pcm.length; offset += PCM_PACKET_BYTES) {
      const part = Buffer.from(pcm.subarray(offset, offset + PCM_PACKET_BYTES));
      packets.push({ pcm: part, output: record });
      record.pending += 1;
      queuedBytes += part.length;
    }
    pump();
  };
  const validReady = (
    role: LiveTranslateRole,
    session: LiveTranslateSession,
  ) => {
    const wanted = role === 'local' ? 'Andre' : 'Tina';
    const expected = role === 'local' ? ['text', 'audio'] : ['text'];
    const policy = session.voicePolicy;
    const ack = session.configurationAcknowledgement;
    const conflict =
      role === 'local' &&
      policy?.mode === 'approved_andre_tina_metadata_conflict' &&
      session.topLevelVoice === 'Andre' &&
      session.sessionOutputVoiceEcho?.value === 'Tina' &&
      policy.responseVoiceAllowlist.length === 2 &&
      policy.responseVoiceAllowlist.includes('Andre') &&
      policy.responseVoiceAllowlist.includes('Tina');
    const exact =
      policy?.mode === 'strict_requested_voice' &&
      session.sessionOutputVoiceEcho?.value === wanted &&
      (session.topLevelVoice === null ||
        session.topLevelVoice === undefined ||
        session.topLevelVoice === wanted) &&
      policy.responseVoiceAllowlist.length === 1 &&
      policy.responseVoiceAllowlist[0] === wanted;
    return (
      session.role === role &&
      session.model === config.model &&
      session.requestedVoice === wanted &&
      session.targetLanguage === (role === 'local' ? 'en' : 'zh') &&
      session.inputSampleRate === 16000 &&
      session.outputSampleRate === 24000 &&
      expected.length === session.outputModalities.length &&
      expected.every((item) =>
        session.outputModalities.includes(item as 'text' | 'audio'),
      ) &&
      policy?.requestedVoice === wanted &&
      policy.acknowledgement.sessionId === session.sessionId &&
      policy.acknowledgement.eventId === ack?.eventId &&
      policy.acknowledgement.receivedAt === ack.receivedAt &&
      policy.acknowledgement.sessionTopLevelEcho.value ===
        (session.topLevelVoice ?? null) &&
      policy.acknowledgement.sessionNestedEcho.value ===
        session.sessionOutputVoiceEcho?.value &&
      ack.basis === 'provider_session_updated' &&
      (exact || conflict) &&
      (session.voiceCloneEnabled === false ||
        (role === 'local' &&
          session.voiceCloneEnabled === null &&
          session.voiceCloneConfirmation === 'missing_echo_warning'))
    );
  };
  const adapter = (
    role: LiveTranslateRole,
    settings: {
      createWebSocket?: LiveTranslateClientOptions['createWebSocket'];
      onAudio?: (pcm: Buffer, metadata?: { utteranceId?: string }) => void;
    },
  ) => {
    if (role === 'local') localSink = settings.onAudio;
    const lastSendReports = new Map<string, number>();
    let inputBytes = 0;
    let writtenInputBytes: number | undefined;
    let client: LiveTranslateClient;
    try {
      client = factory({
        enabled: true,
        usage: 'phone',
        role,
        voice: role === 'local' ? 'Andre' : 'Tina',
        workspaceId: config.workspaceId,
        apiKey: config.apiKey,
        proxyUrl: config.proxyUrl,
        allowMissingVoiceCloneEcho: role === 'local',
        allowAndreTopLevelWithTinaOutput: role === 'local',
        timeoutMs: options.sessionTimeoutMs,
        now,
        createWebSocket: settings.createWebSocket,
        onSessionConfiguration: (event) => {
          if (
            !stopped &&
            !closed &&
            event.accepted &&
            event.role === role &&
            event.sessionId
          )
            acceptedSessionIds[role] = event.sessionId;
        },
        onSource: (event) => onSource(role, event),
        onTranslation: (event) => onTranslation(role, event),
        onAudio: (pcm, metadata) => onAudio(role, pcm, metadata),
        onSendObservation: (event) => {
          const safe = projectLiveTranslateSendObservation(event, role);
          if (!safe) return;
          if (
            safe.stage === 'send_written' &&
            safe.sendEventType === 'input_audio_buffer.append' &&
            integer(safe.writtenAudioBytes)
          )
            writtenInputBytes = safe.writtenAudioBytes;
          if (
            (stopped || closed) &&
            !['transport_closed', 'send_cancelled'].includes(safe.stage)
          )
            return;
          const immediate = [
            'send_failed',
            'send_cancelled',
            'transport_closed',
          ].includes(safe.stage);
          const period =
            safe.stage === 'send_written' || safe.stage === 'send_waiting'
              ? 200
              : 1000;
          if (
            !immediate &&
            safe.at - (lastSendReports.get(safe.stage) ?? -Infinity) < period
          )
            return;
          lastSendReports.set(safe.stage, safe.at);
          diagnostic(safe);
        },
        onProtocolDiagnostic: (event) => {
          if (stopped || closed) return;
          const failure = projectLiveTranslateProtocolFailure(event);
          if (failure) {
            if (!protocolFailureReported) {
              protocolFailureReported = true;
              diagnostic({ ...failure, role });
            }
            return;
          }
          const warning = projectLiveTranslateProtocolWarning(event);
          if (warning) diagnostic({ ...warning, role });
        },
        onVoiceEvidence: (event) => {
          if (stopped || closed) return;
          diagnostic({
            role,
            stage: 'voice_evidence',
            at: event.receivedAt,
            voiceEvent: event.eventType,
            requestedVoice: role === 'local' ? 'Andre' : 'Tina',
            topLevelVoice: event.sessionTopLevelEcho.value,
            topLevelVoiceStatus: event.sessionTopLevelEcho.status,
            nestedVoice: event.sessionNestedEcho.value,
            nestedVoiceStatus: event.sessionNestedEcho.status,
            responseVoice: event.responseEcho.value,
            responseVoiceStatus: event.responseEcho.status,
            ...(event.policyMode === 'awaiting_configuration'
              ? {}
              : { voicePolicy: event.policyMode }),
          });
        },
        onTiming: (event) => {
          if (!active(role, event)) return;
          let source: number | undefined;
          if (event.sourceId) {
            const key = sourceKey({ ...event, sourceId: event.sourceId });
            if (!sourceNumbers.has(key)) {
              sourceSequence += 1;
              boundedSet(sourceNumbers, key, sourceSequence);
            }
            source = sourceNumbers.get(key);
          }
          const response = event.responseId
            ? responseNumber(role, event.sessionId, event.responseId)
            : undefined;
          if (source === undefined && event.responseId)
            source = responseSources.get(
              responseKey(role, event.sessionId, event.responseId),
            );
          if (event.stage !== 'translation_first_delta')
            diagnostic({
              role,
              stage: event.stage,
              at: event.at,
              ...(source === undefined ? {} : { sourceSequence: source }),
              ...(response === undefined ? {} : { responseSequence: response }),
              ...(integer(event.providerAudioMs)
                ? { providerAudioMs: event.providerAudioMs }
                : {}),
              ...(integer(event.outputItemCount)
                ? { outputItemCount: event.outputItemCount }
                : {}),
              ...(integer(event.outputTextCharacters)
                ? { outputTextCharacters: event.outputTextCharacters }
                : {}),
              ...(typeof event.outputAudioSeen === 'boolean'
                ? { outputAudioSeen: event.outputAudioSeen }
                : {}),
              ...(event.stage === 'source_started' ||
              event.stage === 'source_stopped'
                ? {
                    inputAcceptedAudioMs: inputBytes / 32,
                    ...(writtenInputBytes === undefined
                      ? {}
                      : { inputWrittenAudioMs: writtenInputBytes / 32 }),
                  }
                : {}),
            });
          if (
            role === 'local' &&
            event.stage === 'response_created' &&
            event.responseId
          )
            output(event.responseId);
          if (
            role === 'local' &&
            event.stage === 'audio_first_sample' &&
            event.responseId
          ) {
            const record = output(event.responseId);
            if (record) record.audioExpected = true;
          }
          if (
            role === 'local' &&
            event.stage === 'response_completed' &&
            event.responseId
          ) {
            const record = outputs.get(event.responseId);
            // response.done emits this before draining its final buffered PCM.
            // A microtask seals after those synchronous audio callbacks finish.
            if (record)
              queueMicrotask(() => {
                if (!stopped && !closed) {
                  record.sealed = true;
                  settle(record);
                }
              });
          }
        },
        onUsage: (usage) => {
          if (!active(role, usage)) return;
          const counts: Partial<LiveTranslatePhoneDiagnostic> = {};
          for (const name of [
            'inputTokens',
            'outputTokens',
            'totalTokens',
            'inputAudioTokens',
            'inputTextTokens',
            'outputAudioTokens',
            'outputTextTokens',
          ] as const)
            if (integer(usage[name])) counts[name] = usage[name];
          diagnostic({
            role,
            stage: 'usage',
            responseSequence: responseNumber(
              role,
              usage.sessionId,
              usage.responseId,
            ),
            at: now(),
            usageBasis:
              usage.basis === 'provider_reported'
                ? 'provider_reported'
                : 'unknown',
            ...counts,
          });
        },
        onError: (code, details) => stop(role, code, details),
      });
      clients[role] = client;
      if (stopped || closed) abortClients();
    } catch (error) {
      stop(role, error instanceof Error ? error.message : undefined);
      const ready = Promise.reject(
        new Error('LIVETRANSLATE_PHONE_SESSION_FAILED'),
      );
      ready.catch(() => {});
      return {
        ready,
        append() {},
        async finish() {
          /* Failed creation owns no supplier session. */
        },
        abort() {},
      };
    }
    const ready = client.ready
      .then((session) => {
        if (stopped || closed)
          throw new Error('LIVETRANSLATE_PHONE_SESSION_FAILED');
        if (!validReady(role, session)) {
          stop(role, 'LIVETRANSLATE_PHONE_CONFIGURATION_INVALID');
          throw new Error('LIVETRANSLATE_PHONE_CONFIGURATION_INVALID');
        }
        sessions[role] = session;
        diagnostic({
          role,
          stage: 'configuration',
          at: now(),
          model: config.model,
          requestedVoice: role === 'local' ? 'Andre' : 'Tina',
          topLevelVoice: session.topLevelVoice ?? null,
          nestedVoice: session.sessionOutputVoiceEcho!.value,
          voicePolicy: session.voicePolicy!.mode,
          voiceCloneEnabled: session.voiceCloneEnabled,
          inputSampleRate: 16000,
          outputSampleRate: 24000,
          targetLanguage: session.targetLanguage,
        });
        if (role === 'local') {
          notify(options.onOutgoingCaptionState, {
            role,
            state: 'ready',
            translationSource: 'independent_text',
          });
          pump();
        }
      })
      .catch((error) => {
        stop(role, error instanceof Error ? error.message : undefined);
        throw error;
      });
    ready.catch(() => {});
    let nextInputReport = 0;
    return {
      ready,
      append(pcm: Buffer) {
        if (!stopped && !closed) {
          try {
            client.append(pcm);
            if (!stopped && !closed) {
              inputBytes += pcm.length;
              if (inputBytes >= nextInputReport) {
                diagnostic({
                  role,
                  at: now(),
                  stage: 'input_received',
                  bytes: inputBytes,
                  inputAudioMs: inputBytes / 32,
                  basis: 'client_accepted_not_written',
                });
                nextInputReport = inputBytes + 6400;
              }
            }
          } catch (error) {
            stop(role, error instanceof Error ? error.message : undefined);
          }
        }
      },
      async finish() {
        if (!stopped && !closed) await client.finish();
      },
      abort() {
        if (!aborted.has(client)) {
          aborted.add(client);
          try {
            client.abort();
          } catch {
            /* Continue cleanup. */
          }
        }
      },
    };
  };
  inner = new ContinuousTranslationBridge({
    ...options,
    inputSampleRate: 16000,
    remoteCaptions: true,
    outgoingCaptions: false,
    captionFailureEndsCall: false,
    onAudioDiagnostic: audioDiagnostic,
    onTranslationFailure: (role) =>
      stop(role, 'LIVETRANSLATE_PHONE_SESSION_FAILED'),
    createClient: (settings) => {
      notify(options.onOutgoingCaptionState, {
        role: 'local',
        state: 'connecting',
        translationSource: 'independent_text',
      });
      return adapter('local', settings);
    },
    createCaptionClient: (settings) => adapter('remote', settings),
    onFailure: (reason) => {
      closed = true;
      abortClients();
      clearRecords();
      notify(options.onFailure, reason);
    },
  });
  return {
    attach: (role, socket, streamSid) => inner.attach(role, socket, streamSid),
    close() {
      if (closed) return;
      closed = true;
      clearRecords();
      abortClients();
      inner.close();
    },
  };
}
