import WebSocket from 'ws';

import { createCallContext } from './call-context';
import {
  ContinuousTranslationBridge,
  type ContinuousTranslationBridgeOptions,
} from './continuous-translation-bridge';
import type { ContinuousTranslationOptions } from './continuous-translation-client';
import {
  createRemoteCaptionClient,
  type RemoteCaptionClient,
} from './remote-caption-client';
import {
  createRealtimePrototypeClient,
  isRealtimePrototypeVoice,
  type RealtimePrototypeAudioMetadata,
  type RealtimePrototypeClient,
  type RealtimePrototypeEvidence,
  type RealtimePrototypeSourceCorrection,
  type RealtimePrototypeTranscriptEvent,
  type RealtimePrototypeVoice,
} from './realtime-prototype-client';
import type {
  TranslationAudioDiagnostic,
  TranslationRole,
  UtterancePlaybackEvent,
} from './translation-bridge';

export type RealtimePrototypeSelection = {
  /** Trusted offline/DI selection only. No production factory imports this. */
  enabled?: boolean;
  voice?: RealtimePrototypeVoice;
  createClient?: typeof createRealtimePrototypeClient;
  onEvidence?: (event: RealtimePrototypeEvidence) => void;
  /** Raw correction evidence, separate from the frozen paired transcript. */
  onSourceCorrection?: (event: RealtimePrototypeSourceCorrection) => void;
  /** Trusted offline diagnostics, never a public control or transcript sink. */
  onRetention?: (counts: {
    sources: number;
    responses: number;
    pendingSources: number;
    inputEpoch: number;
    retiredSequence: number;
  }) => void;
};

export type RealtimePrototypeBridge = {
  attach(role: TranslationRole, socket: WebSocket, streamSid: string): void;
  close(): void;
};

type Source = {
  inputEpoch: number;
  sourceSequence: number;
  at: number;
  order: number;
  revision: number;
  correctionRevision: number;
  text: string;
  final: boolean;
  sourceEndAt?: number;
  responseKey?: string;
  translatedFinal: boolean;
  withdrawn?: boolean;
};
type ResponsePlayback = RealtimePrototypeAudioMetadata & {
  sealed: boolean;
  acknowledged: boolean;
  cancelled: boolean;
  deliveries: Map<string, boolean>;
};

const MAX_SOURCES = 1024;
const MAX_RESPONSES = 1024;
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_:-]{1,240}$/.test(value);
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const responseKey = (metadata: RealtimePrototypeAudioMetadata) =>
  `${metadata.epoch}:${metadata.responseId}`;

/** Explicit default-off bridge. Importing or constructing it never reads keys. */
export function createRealtimePrototypeBridge(
  options: ContinuousTranslationBridgeOptions,
  selection: RealtimePrototypeSelection = {},
): RealtimePrototypeBridge {
  if (selection.enabled === undefined || selection.enabled === false)
    return new ContinuousTranslationBridge(options);
  if (
    selection.enabled !== true ||
    !isRealtimePrototypeVoice(selection.voice) ||
    typeof options.createWebSocket !== 'function' ||
    options.localVoice ||
    options.outgoingPrefixes ||
    options.outgoingCaptions ||
    options.remoteCaptions === false
  )
    throw new Error('INVALID_REALTIME_PROTOTYPE_SELECTION');

  const context = createCallContext();
  const now = options.now || Date.now;
  const sources = new Map<string, Source>();
  const responses = new Map<string, ResponsePlayback>();
  const sourceIds = new Map<number, string>();
  // Commits precede ASR callbacks. Keep earlier outstanding ASR reservations
  // when a later empty/completed source raises the retired sequence watermark.
  const pendingSources = new Set<number>();
  let inputEpoch = 0;
  let retiredSequence = 0;
  let order = 0;
  let outputEpoch = 0;
  let closed = false;
  let inner: ContinuousTranslationBridge;
  let local: RealtimePrototypeClient;
  let nativeOptions: ContinuousTranslationOptions;
  let captions: RemoteCaptionClient;

  const notify = <T>(callback: ((event: T) => void) | undefined, event: T) => {
    try {
      callback?.(event);
    } catch {
      // Subscribers never suppress teardown or change audio admission.
    }
  };
  const fence = () => {
    closed = true;
    context.close();
  };
  const playback = (
    record: ResponsePlayback,
    status: UtterancePlaybackEvent['status'],
    sealed = false,
  ) => {
    notify(options.onUtterancePlayback, {
      utteranceId: record.utteranceId,
      role: 'local',
      at: now(),
      status,
      ...(sealed
        ? { sealed: true, expectedDeliveryCount: record.deliveries.size }
        : {}),
    });
  };
  const cancelOutstanding = () => {
    for (const record of responses.values()) {
      if (!record.acknowledged && !record.cancelled) {
        record.cancelled = true;
        playback(record, 'cancelled');
      }
    }
    responses.clear();
    sources.clear();
    sourceIds.clear();
    pendingSources.clear();
  };
  const fail = (code: string) => {
    if (closed) return;
    fence();
    // Use the existing local provider failure -> both-leg cleanup path.
    if (nativeOptions?.onError) nativeOptions.onError(code);
    else inner?.close();
    cancelOutstanding();
  };
  const retention = () => {
    if (!closed)
      notify(selection.onRetention, {
        sources: sources.size,
        responses: responses.size,
        pendingSources: pendingSources.size,
        inputEpoch,
        retiredSequence,
      });
  };
  const enterEpoch = (epoch: number) => {
    if (epoch < inputEpoch) return false;
    if (epoch > inputEpoch) {
      if ([...responses.values()].some((record) => !record.acknowledged)) {
        fail('PROTOTYPE_EPOCH_WITH_PENDING_DELIVERY');
        return false;
      }
      // Clean reconnect is explicit at the client. This retires local evidence,
      // not the bounded confirmed raw context of the ongoing physical call.
      sources.clear();
      sourceIds.clear();
      responses.clear();
      pendingSources.clear();
      inputEpoch = epoch;
      retiredSequence = 0;
    }
    return !closed;
  };
  const retired = (epoch: number, sequence: number, id: string) =>
    epoch < inputEpoch ||
    (epoch === inputEpoch &&
      sequence <= retiredSequence &&
      !sources.has(id) &&
      !pendingSources.has(sequence));
  const retireSource = (id: string, source: Source) => {
    const record = source.responseKey && responses.get(source.responseKey);
    if (record && (!record.sealed || !record.acknowledged)) return false;
    if (
      !record &&
      !source.withdrawn &&
      (!source.final || /[\p{L}\p{N}]/u.test(source.text))
    )
      return false;
    if (source.responseKey) responses.delete(source.responseKey);
    sources.delete(id);
    sourceIds.delete(source.sourceSequence);
    retiredSequence = Math.max(retiredSequence, source.sourceSequence);
    return true;
  };
  const makeRoom = (forSource: boolean) => {
    for (const [id, source] of sources) {
      if (
        forSource ? sources.size < MAX_SOURCES : responses.size < MAX_RESPONSES
      )
        break;
      retireSource(id, source);
    }
    retention();
    return !closed;
  };
  const observeLocal = (
    id: string,
    source: Source,
    text = source.text,
    revision = source.revision,
  ) => {
    context.observe({
      role: 'local',
      sourceId: id,
      sourceKind: 'asr',
      at: source.at,
      order: source.order,
      revision,
      observedAt: now(),
      text,
      final: source.final,
      ...(source.sourceEndAt === undefined ||
      !Number.isSafeInteger(source.sourceEndAt)
        ? {}
        : { sourceEndAt: source.sourceEndAt }),
    });
  };
  const transcript = (event: RealtimePrototypeTranscriptEvent) => {
    if (closed) return;
    const id = event.utteranceId;
    if (
      !positive(event.inputEpoch) ||
      !positive(event.sourceSequence) ||
      event.role !== 'local' ||
      !validId(id) ||
      event.pairing !== 'explicit' ||
      !positive(event.sourceRevision) ||
      typeof event.text !== 'string' ||
      event.text.length > 32000 ||
      typeof event.final !== 'boolean' ||
      !Number.isSafeInteger(event.at) ||
      event.at < 0
    ) {
      fail('PROTOTYPE_INVALID_SOURCE_BINDING');
      return;
    }
    if (retired(event.inputEpoch, event.sourceSequence, id)) return;
    if (!enterEpoch(event.inputEpoch)) return;
    let source = sources.get(id);
    if (
      (source &&
        (source.inputEpoch !== event.inputEpoch ||
          source.sourceSequence !== event.sourceSequence)) ||
      (sourceIds.has(event.sourceSequence) &&
        sourceIds.get(event.sourceSequence) !== id)
    ) {
      fail('PROTOTYPE_SOURCE_IDENTITY_CHANGED');
      return;
    }
    const newSource = !source;
    if (event.kind === 'original') {
      if (
        source &&
        (event.at !== source.at ||
          event.sourceRevision < source.revision ||
          (event.sourceRevision === source.revision &&
            event.text !== source.text) ||
          (source.responseKey &&
            (event.text !== source.text ||
              event.sourceRevision !== source.revision)))
      ) {
        fail('PROTOTYPE_SOURCE_SNAPSHOT_CHANGED');
        return;
      }
      if (!source) {
        if (!makeRoom(true)) return;
        if (sources.size >= MAX_SOURCES) {
          fail('PROTOTYPE_SOURCE_CAPACITY');
          return;
        }
        order += 1;
        source = {
          inputEpoch: event.inputEpoch,
          sourceSequence: event.sourceSequence,
          at: event.at,
          order,
          revision: event.sourceRevision,
          correctionRevision: event.sourceRevision,
          text: event.text,
          final: event.final,
          translatedFinal: false,
        };
        sources.set(id, source);
        sourceIds.set(event.sourceSequence, id);
        pendingSources.delete(event.sourceSequence);
      }
      if (event.sourceRevision > source.revision)
        source.translatedFinal = false;
      source.revision = event.sourceRevision;
      source.correctionRevision = Math.max(
        source.correctionRevision,
        event.sourceRevision,
      );
      source.text = event.text;
      source.final = event.final;
      source.sourceEndAt = event.sourceEndAt;
      observeLocal(id, source);
      if (newSource && /[\p{L}\p{N}]/u.test(source.text)) {
        try {
          captions?.breakSection?.();
        } catch {
          fail('PROTOTYPE_CAPTION_BOUNDARY_FAILED');
          return;
        }
      }
    } else if (
      event.kind !== 'translation' ||
      !source ||
      event.sourceRevision !== source.revision
    ) {
      fail('PROTOTYPE_UNBOUND_TRANSLATION');
      return;
    } else source.translatedFinal = event.final;
    // Prototype-only coordinates never become public transcript fields.
    const publicEvent = { ...event };
    Reflect.deleteProperty(publicEvent, 'inputEpoch');
    Reflect.deleteProperty(publicEvent, 'sourceSequence');
    if (!closed) notify(options.onConversationTranscript, publicEvent);
    // Recent terminal/no-audio sources remain bounded evidence so a typed
    // late raw correction can update future context without reopening audio.
    retention();
    // The regular client checks its own closed epoch after this synchronous sink.
  };
  const correction = (event: RealtimePrototypeSourceCorrection) => {
    if (closed) return;
    if (
      positive(event.epoch) &&
      positive(event.sourceSequence) &&
      retired(event.epoch, event.sourceSequence, event.utteranceId)
    )
      return;
    const source = sources.get(event.utteranceId);
    if (
      !source ||
      !positive(event.epoch) ||
      event.epoch !== source.inputEpoch ||
      event.sourceSequence !== source.sourceSequence ||
      event.at !== source.at ||
      event.sourceRevision !== source.revision ||
      !positive(event.correctionRevision) ||
      event.correctionRevision <= source.correctionRevision ||
      typeof event.rawText !== 'string' ||
      event.rawText.length > 32000
    ) {
      fail('PROTOTYPE_INVALID_CORRECTION');
      return;
    }
    source.correctionRevision = event.correctionRevision;
    observeLocal(
      event.utteranceId,
      source,
      event.rawText,
      event.correctionRevision,
    );
    // Never replace the original raw or translated snapshot attached to audio.
    notify(selection.onSourceCorrection, event);
  };
  const settle = (record: ResponsePlayback) => {
    if (
      closed ||
      !record.sealed ||
      record.acknowledged ||
      !record.deliveries.size ||
      [...record.deliveries.values()].some((acknowledged) => !acknowledged)
    )
      return;
    if (!local?.acknowledgeAudio(record.epoch, record.responseId)) {
      fail('PROTOTYPE_DELIVERY_ACK_REJECTED');
      return;
    }
    record.acknowledged = true;
    retention();
  };
  const diagnostic = (event: TranslationAudioDiagnostic) => {
    if (closed) {
      if (event.stage === 'unconfirmed')
        notify(options.onAudioDiagnostic, event);
      return;
    }
    const source = event.utteranceId && sources.get(event.utteranceId);
    const record = source?.responseKey && responses.get(source.responseKey);
    if (record && event.deliveryId) {
      if (event.stage === 'generated')
        record.deliveries.set(event.deliveryId, false);
      else if (event.stage === 'playback_confirmed') {
        if (!record.deliveries.has(event.deliveryId)) {
          fail('PROTOTYPE_UNBOUND_DELIVERY');
          return;
        }
        record.deliveries.set(event.deliveryId, true);
      }
    }
    notify(options.onAudioDiagnostic, event);
    if (!closed && record) settle(record);
  };
  const recordFor = (metadata: RealtimePrototypeAudioMetadata) => {
    if (
      !metadata ||
      !validId(metadata.utteranceId) ||
      !validId(metadata.responseId) ||
      !positive(metadata.epoch) ||
      !positive(metadata.sourceSequence)
    ) {
      fail('PROTOTYPE_INVALID_AUDIO_BINDING');
      return undefined;
    }
    if (retired(metadata.epoch, metadata.sourceSequence, metadata.utteranceId))
      return undefined;
    if (metadata.epoch < outputEpoch) return undefined;
    if (metadata.epoch > outputEpoch) {
      if ([...responses.values()].some((record) => !record.acknowledged)) {
        fail('PROTOTYPE_EPOCH_WITH_PENDING_DELIVERY');
        return undefined;
      }
      outputEpoch = metadata.epoch;
    }
    const source = sources.get(metadata.utteranceId);
    // Retained withdrawal evidence never admits late producer callbacks.
    if (source?.withdrawn) return undefined;
    const key = responseKey(metadata);
    if (
      !source?.final ||
      source.inputEpoch !== metadata.epoch ||
      source.sourceSequence !== metadata.sourceSequence ||
      !/[\p{L}\p{N}]/u.test(source.text) ||
      (source.responseKey && source.responseKey !== key)
    ) {
      fail('PROTOTYPE_UNBOUND_AUDIO');
      return undefined;
    }
    let record = responses.get(key);
    if (record && record.utteranceId !== metadata.utteranceId) {
      fail('PROTOTYPE_RESPONSE_SOURCE_MISMATCH');
      return undefined;
    }
    if (!record) {
      if (!makeRoom(false)) return undefined;
      if (responses.size >= MAX_RESPONSES) {
        fail('PROTOTYPE_RESPONSE_CAPACITY');
        return undefined;
      }
      record = {
        ...metadata,
        sealed: false,
        acknowledged: false,
        cancelled: false,
        deliveries: new Map(),
      };
      source.responseKey = key;
      responses.set(key, record);
      playback(record, 'queued');
    }
    return closed ? undefined : record;
  };

  inner = new ContinuousTranslationBridge({
    ...options,
    callContext: context,
    remoteCaptions: true,
    captionFailureEndsCall: true,
    onAudioDiagnostic: diagnostic,
    onFailure: (reason) => {
      fence();
      cancelOutstanding();
      notify(options.onFailure, reason);
    },
    createCaptionClient: (settings) => {
      captions = (options.createCaptionClient || createRemoteCaptionClient)(
        settings,
      );
      return captions;
    },
    createClient: (settings) => {
      nativeOptions = settings;
      local = (selection.createClient || createRealtimePrototypeClient)({
        apiKey: settings.apiKey,
        proxyUrl: settings.proxyUrl,
        voice: selection.voice!,
        now,
        timeoutMs: settings.timeoutMs,
        createWebSocket: settings.createWebSocket,
        getContext: (query) =>
          context.snapshot({
            beforeAt: query.at,
            ...(query.observedBeforeAt === undefined
              ? {}
              : { observedBeforeAt: query.observedBeforeAt }),
            allowLateFinal: true,
          }),
        onConversationTranscript: transcript,
        onSourceCorrection: correction,
        onEvidence: (event) => {
          if (closed) return;
          if (event.type === 'source_committed') {
            if (!positive(event.epoch) || !positive(event.sourceSequence)) {
              fail('PROTOTYPE_INVALID_SOURCE_COMMIT');
              return;
            }
            if (!enterEpoch(event.epoch)) return;
            if (
              event.sourceSequence > retiredSequence &&
              !sourceIds.has(event.sourceSequence)
            ) {
              if (pendingSources.size >= MAX_SOURCES) {
                fail('PROTOTYPE_SOURCE_CAPACITY');
                return;
              }
              pendingSources.add(event.sourceSequence);
            }
          } else if (
            event.type === 'withdrawn' &&
            event.epoch === inputEpoch &&
            positive(event.sourceSequence)
          ) {
            // No future output is valid for an explicitly withdrawn source.
            // Keep an exposed/unacknowledged response until cleanup/ACK.
            const id = sourceIds.get(event.sourceSequence);
            const source = id && sources.get(id);
            if (source && id) {
              source.withdrawn = true;
            } else {
              pendingSources.delete(event.sourceSequence);
              retiredSequence = Math.max(retiredSequence, event.sourceSequence);
            }
          }
          retention();
          if (!closed) notify(selection.onEvidence, event);
        },
        onAudio: (pcm, metadata) => {
          if (closed) return;
          if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2) {
            fail('PROTOTYPE_INVALID_AUDIO');
            return;
          }
          const record = recordFor(metadata);
          if (!record || record.sealed || record.acknowledged) return;
          settings.onAudio(pcm, {
            utteranceId: record.utteranceId,
            sessionEpoch: record.epoch,
          });
        },
        onAudioComplete: (metadata) => {
          if (closed) return;
          const record = recordFor(metadata);
          if (!record || record.sealed) return;
          if (
            !sources.get(record.utteranceId)?.translatedFinal ||
            !record.deliveries.size
          ) {
            fail('PROTOTYPE_INCOMPLETE_AUDIO');
            return;
          }
          record.sealed = true;
          playback(record, 'sent', true);
          if (!closed) settle(record);
        },
        onError: fail,
      });
      if (closed) local.abort();
      return {
        get ready() {
          return local.ready;
        },
        append: (pcm) => {
          if (!closed) local.append(pcm);
        },
        finish: () => local.finish(),
        abort: () => {
          fence();
          local.abort();
        },
      };
    },
  });
  return {
    attach: (role, socket, streamSid) => inner.attach(role, socket, streamSid),
    close: () => {
      fence();
      inner.close();
      cancelOutstanding();
    },
  };
}
