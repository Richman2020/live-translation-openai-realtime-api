import { ConversationEventAdapter } from '../solo/conversation-events';
import type { ConversationTextEvent } from '../../public/conversation-model.js';
import { createLiveTranslateClient } from './livetranslate-client';
import { isLiveTranslateFailureCode } from './livetranslate-types';
import type {
  LiveTranslateAudioMetadata,
  LiveTranslateClient,
  LiveTranslateClientOptions,
  LiveTranslateRole,
  LiveTranslateSession,
  LiveTranslateSource,
  LiveTranslateTiming,
  LiveTranslateTranslation,
  LiveTranslateUsage,
} from './livetranslate-types';

export type LiveTranslateDuplexState =
  | 'starting'
  | 'ready'
  | 'finishing'
  | 'finished'
  | 'failed'
  | 'ended';
export type LiveTranslateDuplexFault = {
  code:
    | 'LIVETRANSLATE_SESSION_FAILED'
    | 'LIVETRANSLATE_INPUT_FAILED'
    | 'LIVETRANSLATE_AUDIO_BACKLOG'
    | 'LIVETRANSLATE_AUDIO_ORDER_INVALID'
    | 'LIVETRANSLATE_AUDIO_DRAIN_TIMEOUT'
    | 'LIVETRANSLATE_AUDIO_SINK_FAILED'
    | 'LIVETRANSLATE_CAPTION_SINK_FAILED'
    | 'LIVETRANSLATE_ORIGINAL_SINK_FAILED'
    | 'LIVETRANSLATE_REMOTE_AUDIO_FORBIDDEN';
  role?: LiveTranslateRole;
  providerCode?: string;
  closeCode?: number;
  at: number;
};
export type LiveTranslateAudioDelivery = {
  stage: 'queued' | 'sink_started' | 'sink_resolved';
  metadata: Readonly<LiveTranslateAudioMetadata>;
  at: number;
  /** Resolving a local sink is not receiver playback or mouth-to-ear latency. */
  actualPlaybackStartAt: null;
};
export type LiveTranslateDuplexOptions = {
  enabled?: boolean;
  sessionId: string;
  workspaceId: string;
  apiKey: string;
  proxyUrl?: string;
  timeoutMs?: number;
  now?: () => number;
  maxQueuedAudioBytes?: number;
  audioDrainTimeoutMs?: number;
  clientFactory?: (options: LiveTranslateClientOptions) => LiveTranslateClient;
  /** Must honor signal when ending; already delivered PCM cannot be unsent. */
  onEnglishAudio: (
    pcm24k: Buffer,
    metadata: LiveTranslateAudioMetadata & { signal: AbortSignal },
  ) => void | Promise<void>;
  /** Independent input-only path; never waits for translated audio or captions. */
  onRemoteOriginal: (pcm16k: Buffer) => void;
  onConversationEvent?: (event: ConversationTextEvent) => void;
  /** Exact provider item identity/version, separate from the display projection. */
  onTranslationEvidence?: (event: Readonly<LiveTranslateTranslation>) => void;
  onCaptionLimitation?: (event: {
    code: 'LIVETRANSLATE_MULTIPLE_ITEMS_FOR_SOURCE';
    role: LiveTranslateRole;
    sourceId: string;
  }) => void;
  onTiming?: (event: LiveTranslateTiming) => void;
  onUsage?: (event: LiveTranslateUsage) => void;
  onAudioDelivery?: (event: LiveTranslateAudioDelivery) => void;
  onFault?: (event: LiveTranslateDuplexFault) => void;
};

type AudioPacket = {
  pcm: Buffer;
  metadata: LiveTranslateAudioMetadata;
};

const MAX_RECEIPTS = 8192;
const roles: readonly LiveTranslateRole[] = ['local', 'remote'];
const validPcm = (pcm: Buffer) =>
  Buffer.isBuffer(pcm) && pcm.length > 0 && pcm.length % 2 === 0;

/** Offline opt-in prototype. It owns translation resources, never a phone call.
 * It deliberately has no hangup callback, provider fallback, reconnect, expiry
 * timer or production registration. Genuine disconnect/end remains caller-owned.
 */
export function createLiveTranslateDuplex(options: LiveTranslateDuplexOptions) {
  if (options.enabled !== true) throw new Error('LIVETRANSLATE_DISABLED');
  if (!options.sessionId || options.sessionId.length > 256)
    throw new Error('LIVETRANSLATE_SESSION_ID_INVALID');
  const capacity = options.maxQueuedAudioBytes ?? 480000;
  const drainTimeoutMs = options.audioDrainTimeoutMs ?? 15000;
  if (
    !Number.isSafeInteger(capacity) ||
    capacity < 2 ||
    capacity > 4800000 ||
    !Number.isSafeInteger(drainTimeoutMs) ||
    drainTimeoutMs < 1 ||
    drainTimeoutMs > 60000
  )
    throw new Error('LIVETRANSLATE_QUEUE_CONFIG_INVALID');
  const now = options.now || Date.now;
  const adapter = new ConversationEventAdapter(options.sessionId, now);
  const clients: Partial<Record<LiveTranslateRole, LiveTranslateClient>> = {};
  const sessions: Partial<Record<LiveTranslateRole, LiveTranslateSession>> = {};
  const aborted = new Set<LiveTranslateClient>();
  const outputAbort = new AbortController();
  const pending = new Map<number, AudioPacket>();
  const received = new Set<string>();
  const translationRows = new Map<
    string,
    { id: string; event: LiveTranslateTranslation }
  >();
  const sourceOutputs = new Map<string, Set<string>>();
  const sourceTimes = new Map<string, number>();
  const drainWaiters = new Set<() => void>();
  let state: LiveTranslateDuplexState = 'starting';
  let queuedBytes = 0;
  let nextSequence = 1;
  let pumping = false;
  let finishPromise: Promise<void> | undefined;
  let firstFault: LiveTranslateDuplexFault | undefined;
  const getState = () => state;

  const translationActive = () => state === 'ready' || state === 'finishing';
  function abortClients() {
    for (const client of Object.values(clients)) {
      // eslint-disable-next-line no-continue -- Only newly owned resources need cleanup.
      if (aborted.has(client)) continue;
      aborted.add(client);
      try {
        client.abort();
      } catch {
        // A failed cleanup adapter must not turn a translation error into call
        // ownership or obscure cleanup of the other independent session.
      }
    }
  }
  function notifyDrain() {
    if (pending.size || pumping) return;
    for (const done of drainWaiters) done();
    drainWaiters.clear();
  }
  function stopTranslation() {
    outputAbort.abort();
    pending.clear();
    queuedBytes = 0;
    abortClients();
    for (const done of drainWaiters) done();
    drainWaiters.clear();
  }
  function fail(
    code: LiveTranslateDuplexFault['code'],
    role?: LiveTranslateRole,
    diagnostic: { providerCode?: unknown; closeCode?: unknown } = {},
  ) {
    if (['failed', 'ended', 'finished'].includes(state)) return;
    state = 'failed';
    stopTranslation();
    firstFault = {
      code,
      ...(role ? { role } : {}),
      at: now(),
      ...(isLiveTranslateFailureCode(diagnostic.providerCode)
        ? { providerCode: diagnostic.providerCode }
        : {}),
      ...(typeof diagnostic.closeCode === 'number' &&
      Number.isInteger(diagnostic.closeCode) &&
      diagnostic.closeCode >= 1000 &&
      diagnostic.closeCode <= 4999
        ? { closeCode: diagnostic.closeCode }
        : {}),
    };
    try {
      options.onFault?.({ ...firstFault });
    } catch {
      // Fault reporting is not a telephone lifecycle operation.
    }
  }
  function current(
    role: LiveTranslateRole,
    event: { role: LiveTranslateRole; sessionId: string },
  ) {
    return (
      translationActive() &&
      event.role === role &&
      sessions[role]?.sessionId === event.sessionId
    );
  }
  function emitTranscript(
    transcript: Parameters<ConversationEventAdapter['transcript']>[0],
  ) {
    if (!translationActive()) return;
    const event = adapter.transcript(transcript);
    if (!event) return;
    try {
      options.onConversationEvent?.(event);
      for (const update of adapter.takeTurnUpdates()) {
        if (!translationActive()) return;
        options.onConversationEvent?.(update);
      }
    } catch {
      fail('LIVETRANSLATE_CAPTION_SINK_FAILED', transcript.role);
    }
  }
  const sourceId = (role: LiveTranslateRole, id: string) =>
    `${role}:source:${sessions[role]?.sessionId}:${id}`;
  function source(role: LiveTranslateRole, event: LiveTranslateSource) {
    if (!current(role, event)) return;
    const id = sourceId(role, event.sourceId);
    if (!sourceTimes.has(id)) sourceTimes.set(id, event.at);
    if (sourceTimes.size > MAX_RECEIPTS)
      sourceTimes.delete(sourceTimes.keys().next().value!);
    emitTranscript({
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
      // ASR revision is not evidence of which input version generated output.
      // Do not invent sourceRevision shared with the translated response.
    });
  }
  function translation(
    role: LiveTranslateRole,
    event: LiveTranslateTranslation,
  ) {
    if (!current(role, event)) return;
    const key = `${role}:${event.sessionId}:${event.translationId}`;
    const previous = translationRows.get(key);
    if (previous && event.revision <= previous.event.revision) return;
    const explicit = event.pairing === 'explicit' && !!event.sourceId;
    const auxiliaryId = (item: LiveTranslateTranslation) =>
      `${role}:unpaired:${item.sessionId}:${item.translationId}`;
    const linkedId = explicit ? sourceId(role, event.sourceId!) : undefined;
    let multiple = false;
    if (linkedId) {
      const items = sourceOutputs.get(linkedId) || new Set<string>();
      const firstAmbiguity = items.size === 1 && !items.has(key);
      items.add(key);
      sourceOutputs.set(linkedId, items);
      multiple = items.size > 1;
      if (firstAmbiguity) {
        try {
          options.onCaptionLimitation?.({
            code: 'LIVETRANSLATE_MULTIPLE_ITEMS_FOR_SOURCE',
            role,
            sourceId: event.sourceId!,
          });
        } catch {
          // A diagnostic callback cannot choose a phone lifecycle action.
        }
        // A source edge is genuine, but does not prove that multiple outputs
        // are append-only continuations rather than retranslations. Preserve
        // every item separately; do not duplicate the original or overwrite it.
        for (const itemKey of items) {
          // eslint-disable-next-line no-continue -- The current item is projected below.
          if (itemKey === key) continue;
          const item = translationRows.get(itemKey);
          // eslint-disable-next-line no-continue -- Already independent items stay untouched.
          if (item?.id !== linkedId) continue;
          emitTranscript({
            id: `${item.id}:translation`,
            utteranceId: item.id,
            role,
            kind: 'translation',
            text: '',
            final: true,
            at: item.event.at,
            pairing: 'explicit',
            boundary: 'semantic',
          });
          item.id = auxiliaryId(item.event);
          emitTranscript({
            id: `${item.id}:translation`,
            utteranceId: item.id,
            role,
            kind: 'translation',
            text: item.event.text,
            final: item.event.final,
            at: item.event.at,
            pairing: 'unpaired',
            boundary: 'diagnostic',
          });
        }
      }
    }
    const id = linkedId && !multiple ? linkedId : auxiliaryId(event);
    if (previous && previous.id !== id) {
      // A late documented item edge replaces only the display projection;
      // nothing here requests generation, replays audio, or changes its order.
      emitTranscript({
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
    }
    translationRows.set(key, { id, event: { ...event } });
    if (translationRows.size > MAX_RECEIPTS) {
      const retired = translationRows.keys().next().value!;
      translationRows.delete(retired);
      for (const [linked, items] of sourceOutputs) {
        items.delete(retired);
        if (!items.size) sourceOutputs.delete(linked);
      }
    }
    try {
      options.onTranslationEvidence?.(Object.freeze({ ...event }));
    } catch {
      fail('LIVETRANSLATE_CAPTION_SINK_FAILED', role);
      return;
    }
    emitTranscript({
      id: `${id}:translation`,
      utteranceId: id,
      role,
      kind: 'translation',
      text: event.text,
      final: event.final,
      at: linkedId && !multiple ? (sourceTimes.get(id) ?? event.at) : event.at,
      pairing: linkedId && !multiple ? 'explicit' : 'unpaired',
      boundary: linkedId && !multiple ? 'semantic' : 'diagnostic',
    });
  }
  function delivery(
    stage: LiveTranslateAudioDelivery['stage'],
    packet: AudioPacket,
  ) {
    try {
      options.onAudioDelivery?.({
        stage,
        metadata: Object.freeze({ ...packet.metadata }),
        at: now(),
        actualPlaybackStartAt: null,
      });
    } catch {
      // Observability is separate from correct audio delivery.
    }
  }
  async function pump() {
    if (pumping || !translationActive()) return;
    pumping = true;
    try {
      while (translationActive()) {
        const packet = pending.get(nextSequence);
        if (!packet) break;
        pending.delete(nextSequence);
        nextSequence += 1;
        delivery('sink_started', packet);
        if (!translationActive()) break;
        try {
          // eslint-disable-next-line no-await-in-loop -- A single FIFO sink must never overlap audio.
          await options.onEnglishAudio(packet.pcm, {
            ...packet.metadata,
            signal: outputAbort.signal,
          });
        } catch {
          if (translationActive())
            fail('LIVETRANSLATE_AUDIO_SINK_FAILED', 'local');
        }
        if (!translationActive()) break;
        queuedBytes -= packet.pcm.length;
        delivery('sink_resolved', packet);
      }
    } finally {
      pumping = false;
      notifyDrain();
    }
  }
  function audio(
    role: LiveTranslateRole,
    pcm: Buffer,
    metadata: LiveTranslateAudioMetadata,
  ) {
    // Client sequence is the response-FIFO-normalized delivery order. It is
    // neither an acoustic chunk index nor a guess at supplier receive order.
    if (!current(role, metadata)) return;
    if (role === 'remote') {
      fail('LIVETRANSLATE_REMOTE_AUDIO_FORBIDDEN', role);
      return;
    }
    if (
      !validPcm(pcm) ||
      !metadata.eventId ||
      !Number.isSafeInteger(metadata.sequence) ||
      metadata.sequence < 1
    ) {
      fail('LIVETRANSLATE_AUDIO_ORDER_INVALID', role);
      return;
    }
    if (received.has(metadata.eventId) || metadata.sequence < nextSequence)
      return;
    if (pending.has(metadata.sequence)) {
      fail('LIVETRANSLATE_AUDIO_ORDER_INVALID', role);
      return;
    }
    if (queuedBytes + pcm.length > capacity) {
      fail('LIVETRANSLATE_AUDIO_BACKLOG', role);
      return;
    }
    received.add(metadata.eventId);
    if (received.size > MAX_RECEIPTS)
      received.delete(received.values().next().value!);
    const packet = { pcm: Buffer.from(pcm), metadata: { ...metadata } };
    pending.set(metadata.sequence, packet);
    queuedBytes += pcm.length;
    delivery('queued', packet);
    pump().catch(() => fail('LIVETRANSLATE_AUDIO_SINK_FAILED', 'local'));
  }
  const factory = options.clientFactory || createLiveTranslateClient;
  let setupError = false;
  try {
    for (const role of roles) {
      if (getState() === 'failed') break;
      clients[role] = factory({
        enabled: true,
        role,
        workspaceId: options.workspaceId,
        apiKey: options.apiKey,
        proxyUrl: options.proxyUrl,
        timeoutMs: options.timeoutMs,
        now,
        onSource: (event) => source(role, event),
        onTranslation: (event) => translation(role, event),
        onAudio: (pcm, metadata) => audio(role, pcm, metadata),
        onTiming: (event) => {
          if (current(role, event)) {
            try {
              options.onTiming?.(event);
            } catch {
              /* Timing is not call lifecycle. */
            }
          }
        },
        onUsage: (event) => {
          if (current(role, event)) {
            try {
              options.onUsage?.(event);
            } catch {
              /* Usage reporting cannot drop audio. */
            }
          }
        },
        onError: (providerCode, diagnostic) =>
          fail('LIVETRANSLATE_SESSION_FAILED', role, {
            providerCode,
            closeCode: diagnostic.closeCode,
          }),
      });
      // A factory can synchronously report an error before returning its owned
      // resource. That resource did not exist during fail()'s first cleanup.
      if (getState() !== 'starting') abortClients();
    }
  } catch (error) {
    setupError = true;
    fail('LIVETRANSLATE_SESSION_FAILED', undefined, {
      providerCode: error instanceof Error ? error.message : undefined,
    });
  }
  const ready = (async () => {
    if (setupError || roles.some((role) => !clients[role]))
      throw new Error('LIVETRANSLATE_SESSION_FAILED');
    try {
      await Promise.all(
        roles.map(async (role) => {
          const session = await clients[role]!.ready;
          const expected = role === 'local' ? ['text', 'audio'] : ['text'];
          if (
            session.role !== role ||
            !session.sessionId ||
            session.model !== 'qwen3.8-livetranslate-flash-realtime' ||
            session.voice !== 'Tina' ||
            session.inputSampleRate !== 16000 ||
            session.outputSampleRate !== 24000 ||
            session.outputModalities.length !== expected.length ||
            expected.some(
              (modality) =>
                !session.outputModalities.includes(
                  modality as 'text' | 'audio',
                ),
            )
          )
            throw new Error('LIVETRANSLATE_SESSION_FAILED');
          sessions[role] = session;
        }),
      );
      if (
        state !== 'starting' ||
        sessions.local!.sessionId === sessions.remote!.sessionId
      )
        throw new Error('LIVETRANSLATE_SESSION_FAILED');
      state = 'ready';
    } catch (error) {
      fail('LIVETRANSLATE_SESSION_FAILED', undefined, {
        providerCode: error instanceof Error ? error.message : undefined,
      });
      throw new Error('LIVETRANSLATE_SESSION_FAILED');
    }
  })();
  // Consumers still receive the rejected promise, without an unobserved global
  // rejection if an owner ends the prototype while setup is pending.
  ready.catch(() => {});

  function append(role: LiveTranslateRole, pcm: Buffer): boolean {
    if (state === 'ended') return false;
    if (!validPcm(pcm)) {
      fail('LIVETRANSLATE_INPUT_FAILED', role);
      return false;
    }
    if (role === 'remote') {
      try {
        options.onRemoteOriginal(Buffer.from(pcm));
      } catch {
        fail('LIVETRANSLATE_ORIGINAL_SINK_FAILED', role);
        return false;
      }
    }
    if (state !== 'ready') return false;
    try {
      clients[role]!.append(Buffer.from(pcm));
      return getState() === 'ready';
    } catch (error) {
      fail('LIVETRANSLATE_INPUT_FAILED', role, {
        providerCode: error instanceof Error ? error.message : undefined,
      });
      return false;
    }
  }
  function finish(): Promise<void> {
    if (finishPromise) return finishPromise;
    finishPromise = (async () => {
      await ready;
      if (state !== 'ready') return;
      state = 'finishing';
      try {
        await Promise.all(roles.map((role) => clients[role]!.finish()));
      } catch (error) {
        fail('LIVETRANSLATE_SESSION_FAILED', undefined, {
          providerCode: error instanceof Error ? error.message : undefined,
        });
      }
      if (!translationActive()) return;
      if (!pumping && pending.size && !pending.has(nextSequence)) {
        fail('LIVETRANSLATE_AUDIO_ORDER_INVALID', 'local');
        return;
      }
      if (pumping || pending.size)
        await new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          const done = () => {
            clearTimeout(timer);
            drainWaiters.delete(done);
            resolve();
          };
          timer = setTimeout(() => {
            fail('LIVETRANSLATE_AUDIO_DRAIN_TIMEOUT', 'local');
            done();
          }, drainTimeoutMs);
          drainWaiters.add(done);
          notifyDrain();
        });
      if (state === 'finishing') state = 'finished';
    })();
    return finishPromise;
  }
  return {
    ready,
    appendLocal: (pcm16k: Buffer) => append('local', pcm16k),
    appendRemote: (pcm16k: Buffer) => append('remote', pcm16k),
    finish,
    end(reason: 'manual' | 'owner_disconnect' | 'remote_hangup') {
      if (!['manual', 'owner_disconnect', 'remote_hangup'].includes(reason))
        throw new Error('LIVETRANSLATE_END_REASON_INVALID');
      if (state === 'ended') return;
      state = 'ended';
      stopTranslation();
    },
    get status() {
      return state;
    },
    get firstFault() {
      return firstFault && { ...firstFault };
    },
    get bufferedAudioBytes() {
      return queuedBytes;
    },
  };
}
