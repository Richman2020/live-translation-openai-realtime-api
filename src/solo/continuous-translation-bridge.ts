import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

import {
  createContinuousTranslationClient,
  type ContinuousTranslationAudioMetadata,
  type ContinuousTranslationClient,
  type ContinuousTranslationOptions,
  type ContinuousTranslationTransportUsage,
} from './continuous-translation-client';
import { muLawToPcm16, Pcm24kToPcmu, PcmuToPcm24k } from './translation-pcm';
import { createNanoTextCommitter } from './nano-text-committer';
import {
  createOutgoingPrefixClient,
  type OutgoingPrefixClient,
  type OutgoingPrefixOptions,
} from './outgoing-prefix-client';
import {
  createRemoteCaptionClient,
  type RemoteCaptionClient,
  type RemoteCaptionOptions,
} from './remote-caption-client';
import type {
  TranscriptEvent,
  TranslationAudioDiagnostic,
  TranslationBridgeOptions,
  TranslationRole,
  UtterancePlaybackEvent,
} from './translation-bridge';

export type LocalVoiceSynthesizer = {
  ready: Promise<void>;
  diagnosticPrefix?: 'nano' | 'pocket';
  /** Native PCM chunks, available before synthesis of the complete text ends. */
  synthesizeStream?(
    text: string,
    signal?: AbortSignal,
  ): AsyncIterable<{ pcm: Buffer; sampleRate: 24000 }>;
  /** The B tempo preset can expand a 20-second generated waveform to <22s. */
  maxOutputSeconds?: 20 | 22;
  synthesize(
    text: string,
    signal?: AbortSignal,
  ): Promise<{
    pcm: Buffer;
    sampleRate: 24000;
    metrics: { generationMs: number; audioMs: number };
  }>;
};
export type ContinuousTranslationBridgeOptions = TranslationBridgeOptions & {
  createClient?: (
    options: ContinuousTranslationOptions,
  ) => ContinuousTranslationClient;
  playbackTimeoutMs?: number;
  /** Explicit one-way candidate. The local provider audio is never forwarded. */
  localVoice?: LocalVoiceSynthesizer;
  sentenceBoundaryDelayMs?: number;
  /** Chinese ASR/text prefix candidate; never gate on continuous translated audio. */
  outgoingPrefixes?: boolean;
  createPrefixClient?: typeof createOutgoingPrefixClient;
  /** Remote PCMU goes straight to the headset; ASR/text is an independent branch. */
  remoteCaptions?: boolean;
  createCaptionClient?: (options: RemoteCaptionOptions) => RemoteCaptionClient;
  /** Independent paired text captions; never gate or replace native speech. */
  outgoingCaptions?: boolean;
  onOutgoingCaptionState?: (event: {
    role: 'local';
    state: 'connecting' | 'ready' | 'failed';
    translationSource: 'independent_text';
  }) => void;
  admitAudio?: (event: ContinuousBridgeAudioAdmission) => boolean;
  onNativeTransportUsage?: (
    event: ContinuousTranslationTransportUsage & { role: TranslationRole },
  ) => void;
};

export type ContinuousBridgeAudioAdmission = {
  role: TranslationRole;
  path:
    | 'native_translation'
    | 'outgoing_captions'
    | 'remote_captions'
    | 'return_original';
  stage: 'connect' | 'input' | 'output';
  /** PCM16 at 24 kHz, except return_original which is PCMU at 8 kHz. */
  bytes: number;
  audioMs: number;
};

/** Text translation of a source section, not a transcript of native speech. */
export type IndependentOutgoingCaption = TranscriptEvent & {
  captionSource: 'independent_text';
  audioCorrespondence: 'none';
};

/** Unpaired append-only native text, never a final semantic sentence. */
export type NativeContinuousCaption = TranscriptEvent &
  (
    | { captionSource: 'native_output'; audioCorrespondence: 'generated_only' }
    | { captionSource: 'native_input'; audioCorrespondence: 'none' }
  );

type Phone = {
  socket: WebSocket;
  streamSid: string;
  pending: Buffer[];
  pendingBytes: number;
  outstandingBytes: number;
};
type Provider = {
  client?: ContinuousTranslationClient;
  ready: boolean;
  input: PcmuToPcm24k;
  output: Pcm24kToPcmu;
  transcript: string;
  transcriptSequence: number;
  transcriptAt: number;
  sourceTranscript: string;
  sourceTranscriptSequence: number;
  sourceTranscriptAt: number;
};
type Delivery = {
  utteranceId?: string;
  role: TranslationRole;
  recipientRole: TranslationRole;
  streamSid: string;
  name: string;
  generatedBytes: number;
  sentBytes: number;
  pendingWrites: number;
  sentReported: boolean;
  acknowledged: boolean;
  createdAtMs: number;
  sentAtMs?: number;
  acknowledgedAtMs?: number;
  energySquares: number;
  energySamples: number;
  peak: number;
  providerElapsedMs?: number;
  prefixSequence?: number;
  sealed: boolean;
  timer: ReturnType<typeof setTimeout>;
};

type InputEnergyWindow = {
  startedAtMs: number;
  endedAtMs: number;
  samples: number;
  squares: number;
  peak: number;
  mediaTimestampMs?: number;
};

const ROLES: TranslationRole[] = ['local', 'remote'];
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 16000; // Two seconds of 8 kHz PCMU, never truncated.
const MAX_APPEND_BYTES = 8000; // The continuous client accepts at most 1 s.
const DELIVERY_BYTES = 1600; // At most 200 ms between playback markers.
const MAX_OUTSTANDING_BYTES = 64000; // Eight seconds per destination.
const MAX_PENDING_MARKS = 256;
const MAX_TRANSPORT_BYTES = 128 * 1024;
const MAX_TRANSCRIPT_CHARS = 1000;
const opposite = (role: TranslationRole): TranslationRole =>
  role === 'local' ? 'remote' : 'local';
const ignoreSocketError = () => {};

function parseEvent(raw: unknown): Record<string, any> {
  let buffer: Buffer;
  if (Buffer.isBuffer(raw)) buffer = raw;
  else if (typeof raw === 'string') buffer = Buffer.from(raw);
  else if (raw instanceof ArrayBuffer) buffer = Buffer.from(raw);
  else if (Array.isArray(raw) && raw.every(Buffer.isBuffer)) {
    if (raw.reduce((sum, part) => sum + part.length, 0) > MAX_EVENT_BYTES)
      throw new Error('INVALID_EVENT');
    buffer = Buffer.concat(raw);
  } else throw new Error('INVALID_EVENT');
  if (buffer.length > MAX_EVENT_BYTES) throw new Error('INVALID_EVENT');
  const event = JSON.parse(buffer.toString('utf8'));
  if (!event || typeof event !== 'object' || Array.isArray(event))
    throw new Error('INVALID_EVENT');
  return event;
}

function decodeAudio(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > Math.ceil(MAX_PENDING_BYTES / 3) * 4 ||
    value.length % 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw new Error('INVALID_AUDIO');
  const audio = Buffer.from(value, 'base64');
  if (
    !audio.length ||
    audio.length > MAX_PENDING_BYTES ||
    audio.toString('base64') !== value
  )
    throw new Error('INVALID_AUDIO');
  return audio;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

/**
 * Optional phone adapter for the dedicated continuous translation protocol.
 * attach() receives only phone legs authenticated by SessionManager. Each
 * speaker has independent codec/session state. By default text is diagnostic;
 * explicit localVoice uses append-only translated sentences for one-way TTS.
 */
export class ContinuousTranslationBridge {
  private readonly phones = new Map<TranslationRole, Phone>();

  private readonly providers = new Map<TranslationRole, Provider>();

  private readonly deliveries = new Map<string, Delivery>();

  private readonly pipelineId = randomUUID();

  private diagnosticClockOrigin = 0;

  private diagnosticClockLast = 0;

  private readonly inputEnergyWindows = new Map<
    TranslationRole,
    InputEnergyWindow
  >();

  private readonly removeListeners: (() => void)[] = [];

  private sequence = 0;

  private started = false;

  private closed = false;

  private readonly nanoAbort = new AbortController();

  private readonly nanoPlaybackWaiters = new Set<() => void>();

  private readonly nanoQueue: {
    text: string;
    at: number;
    prefixSequence?: number;
    utteranceId?: string;
    finalPart?: boolean;
  }[] = [];

  private readonly pendingUtterances = new Set<string>();

  private readonly utteranceDeliveryCounts = new Map<string, number>();

  private prefixSequence = 0;

  private nanoBusy = false;

  private nanoActiveChars = 0;

  private readonly nanoCommitter?: ReturnType<typeof createNanoTextCommitter>;

  private captionClient?: RemoteCaptionClient;

  private captionReady = false;

  private captionFailed = false;

  private readonly captionInput = new PcmuToPcm24k();

  private captionPending: Buffer[] = [];

  private captionPendingBytes = 0;

  private readonly captionUtterances = new Set<string>();

  private outgoingCaptionClient?: OutgoingPrefixClient;

  private outgoingCaptionReady = false;

  private outgoingCaptionFailed = false;

  private readonly outgoingCaptionInput = new PcmuToPcm24k();

  private outgoingCaptionPending: Buffer[] = [];

  private outgoingCaptionPendingBytes = 0;

  private directDelivery?: Delivery;

  private directMarkTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: ContinuousTranslationBridgeOptions) {
    const timeout = options.playbackTimeoutMs ?? 20000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120000)
      throw new Error('INVALID_CONTINUOUS_PLAYBACK_TIMEOUT');
    try {
      const origin = (options.monotonicNow || (() => performance.now()))();
      if (Number.isFinite(origin)) this.diagnosticClockOrigin = origin;
    } catch {
      // A diagnostic clock is never an audio dependency.
    }
    if (
      options.outgoingPrefixes &&
      (!options.localVoice || !options.remoteCaptions)
    )
      throw new Error('INVALID_PREFIX_BRIDGE_OPTIONS');
    if (
      options.outgoingCaptions &&
      (options.localVoice || options.outgoingPrefixes)
    )
      throw new Error('INVALID_OUTGOING_CAPTION_BRIDGE_OPTIONS');
    if (
      options.admitAudio !== undefined &&
      typeof options.admitAudio !== 'function'
    )
      throw new Error('INVALID_CONTINUOUS_ADMISSION_OPTIONS');
    if (options.localVoice && !options.outgoingPrefixes) {
      this.nanoCommitter = createNanoTextCommitter({
        boundaryDelayMs: options.sentenceBoundaryDelayMs,
        clauseBoundaries: options.remoteCaptions === true,
        now: options.now,
        onCommitTiming: ({ bufferWaitMs }) => {
          if (!this.options.remoteCaptions) return;
          this.options.onMetric?.({
            role: 'local',
            name:
              this.voicePrefix === 'pocket'
                ? 'pocket_boundary_wait_ms'
                : 'nano_boundary_wait_ms',
            scope: 'text_boundary',
            value: bufferWaitMs,
            at: (this.options.now || Date.now)(),
          });
        },
        onCommit: (text) => this.enqueueNano(text),
        onError: () =>
          this.shutdown(`${this.voicePrefix}_text_boundary_failed:local`),
      });
    }
  }

  private diagnosticTime(): number {
    try {
      const value =
        (this.options.monotonicNow || (() => performance.now()))() -
        this.diagnosticClockOrigin;
      if (
        Number.isFinite(value) &&
        value >= 0 &&
        value <= Number.MAX_SAFE_INTEGER
      )
        this.diagnosticClockLast = Math.max(this.diagnosticClockLast, value);
    } catch {
      // Preserve the last valid timestamp if an optional test clock fails.
    }
    return Math.round(this.diagnosticClockLast * 1000) / 1000;
  }

  private energy(delivery: Delivery, audio: Buffer): void {
    for (const code of audio) {
      const sample = muLawToPcm16(code);
      delivery.energySquares += sample * sample;
      delivery.energySamples += 1;
      delivery.peak = Math.max(delivery.peak, Math.abs(sample));
    }
  }

  private inputEnergy(
    role: TranslationRole,
    audio: Buffer,
    timestamp: unknown,
  ): void {
    if (!this.options.onInputDiagnostic) return;
    const observed = this.diagnosticTime();
    const parsed =
      typeof timestamp === 'string' && /^\d{1,9}$/.test(timestamp)
        ? Number(timestamp)
        : timestamp;
    const mediaTimestamp =
      typeof parsed === 'number' &&
      Number.isSafeInteger(parsed) &&
      parsed >= 0 &&
      parsed <= 7 * 24 * 60 * 60 * 1000
        ? parsed
        : undefined;
    let offset = 0;
    while (offset < audio.length && !this.closed) {
      let window = this.inputEnergyWindows.get(role);
      if (!window) {
        window = {
          startedAtMs: observed,
          endedAtMs: observed,
          samples: 0,
          squares: 0,
          peak: 0,
          ...(mediaTimestamp === undefined
            ? {}
            : { mediaTimestampMs: mediaTimestamp + offset / 8 }),
        };
        this.inputEnergyWindows.set(role, window);
      }
      const end = Math.min(
        audio.length,
        offset + DELIVERY_BYTES - window.samples,
      );
      for (; offset < end; offset += 1) {
        const sample = muLawToPcm16(audio[offset]);
        window.samples += 1;
        window.squares += sample * sample;
        window.peak = Math.max(window.peak, Math.abs(sample));
      }
      window.endedAtMs = observed;
      if (window.samples === DELIVERY_BYTES) this.flushInputEnergy(role);
    }
  }

  private flushInputEnergy(role: TranslationRole): void {
    const window = this.inputEnergyWindows.get(role);
    this.inputEnergyWindows.delete(role);
    if (!window?.samples) return;
    try {
      this.options.onInputDiagnostic?.({
        pipelineId: this.pipelineId,
        role,
        clock: 'bridge_monotonic',
        observedAtMs: this.diagnosticTime(),
        windowStartedAtMs: window.startedAtMs,
        windowEndedAtMs: window.endedAtMs,
        audioDurationMs: window.samples / 8,
        rms: Math.round(Math.sqrt(window.squares / window.samples)),
        peak: window.peak,
        ...(window.mediaTimestampMs === undefined
          ? {}
          : { mediaTimestampMs: window.mediaTimestampMs }),
      });
    } catch {
      // Input telemetry is never a reason to stop forwarding speech.
    }
  }

  public attach(
    role: TranslationRole,
    socket: WebSocket,
    streamSid: string,
  ): void {
    if (this.closed) {
      this.closeSocket(socket);
      return;
    }
    const previous = this.phones.get(role);
    if (previous?.socket === socket && previous.streamSid === streamSid) return;
    if (
      !ROLES.includes(role) ||
      !isId(streamSid) ||
      previous ||
      socket.readyState !== WebSocket.OPEN ||
      [...this.phones.values()].some(
        (leg) => leg.socket === socket || leg.streamSid === streamSid,
      )
    ) {
      this.shutdown('continuous_invalid_phone_stream');
      this.closeSocket(socket);
      return;
    }
    this.phones.set(role, {
      socket,
      streamSid,
      pending: [],
      pendingBytes: 0,
      outstandingBytes: 0,
    });
    this.listen(socket, 'message', (raw) => {
      if (this.closed) return;
      try {
        this.onPhoneEvent(role, parseEvent(raw));
      } catch {
        this.shutdown(`continuous_invalid_phone_event:${role}`);
      }
    });
    this.listen(socket, 'close', () =>
      this.shutdown(`continuous_phone_closed:${role}`),
    );
    this.listen(socket, 'error', () =>
      this.shutdown(`continuous_phone_error:${role}`),
    );
    // The controlled browser flow waits for local provider readiness before
    // dialing. Prepare its native/text pipeline while the destination rings.
    // Microphone packets remain ignored until both authenticated legs attach.
    if (
      role === 'local' &&
      (this.options.outgoingPrefixes ||
        (this.options.remoteCaptions && !this.options.localVoice)) &&
      !this.providers.has('local')
    )
      this.startProvider('local');
    if (this.phones.size === 2 && !this.started) {
      this.started = true;
      for (const source of ROLES) {
        if (this.closed) break;
        if (!this.providers.has(source)) {
          if (source === 'remote' && this.options.remoteCaptions)
            this.startCaptions();
          else this.startProvider(source);
        }
        if (source === 'local' && this.options.outgoingCaptions && !this.closed)
          this.startOutgoingCaptions();
      }
    }
  }

  public close(): void {
    this.shutdown();
  }

  private listen(
    socket: WebSocket,
    name: string,
    callback: (...args: any[]) => void,
  ): void {
    socket.on(name, callback);
    this.removeListeners.push(() => socket.off(name, callback));
  }

  private connection(role: TranslationRole, state: 'ready' | 'disconnected') {
    try {
      this.options.onConnection?.({ role, state });
    } catch {
      // Optional diagnostics cannot interrupt audio or cleanup.
    }
  }

  private startProvider(role: TranslationRole): void {
    if (!this.admit(role, 'native_translation', 'connect', 0, 0)) return;
    const provider: Provider = {
      ready: false,
      input: new PcmuToPcm24k(),
      output: new Pcm24kToPcmu(),
      transcript: '',
      transcriptSequence: 0,
      transcriptAt: 0,
      sourceTranscript: '',
      sourceTranscriptSequence: 0,
      sourceTranscriptAt: 0,
    };
    this.providers.set(role, provider);
    try {
      const client =
        role === 'local' && this.options.outgoingPrefixes
          ? this.startPrefixClient(provider)
          : (this.options.createClient || createContinuousTranslationClient)({
              apiKey: this.options.apiKey,
              targetLanguage: role === 'local' ? 'en' : 'zh',
              proxyUrl: this.options.proxyUrl,
              timeoutMs: this.options.sessionTimeoutMs,
              createWebSocket: this.guardedSocketFactory(
                role,
                'native_translation',
              ),
              onAudio: (pcm, metadata) =>
                this.onAudio(role, provider, pcm, metadata),
              onSessionMetadata: (metadata) => {
                if (this.closed) return;
                try {
                  this.options.onProviderDiagnostic?.({
                    pipelineId: this.pipelineId,
                    role,
                    ...metadata,
                    observedAtMs: this.diagnosticTime(),
                  });
                } catch {
                  // Metadata reporting must never interrupt audio or readiness.
                }
              },
              onTranscript: (delta) => this.onTranscript(role, provider, delta),
              onInputTranscript: (delta) =>
                this.onTranscript(role, provider, delta, 'original'),
              onTransportUsage: (event) => {
                if (this.closed || this.providers.get(role) !== provider)
                  return;
                try {
                  this.options.onNativeTransportUsage?.({ ...event, role });
                } catch {
                  // Transport observations never bypass the synchronous gate.
                }
              },
              ...(role === 'local' && this.nanoCommitter
                ? {
                    onTranslatedText: (delta: string) =>
                      this.nanoCommitter.append(delta),
                  }
                : {}),
              // Never expose provider errors, credentials, audio or transcripts.
              onError: () =>
                this.shutdown(`continuous_provider_failed:${role}`),
            });
      provider.client = client;
      if (this.closed) {
        client.abort();
        return;
      }
      const readiness =
        role === 'local' && this.options.localVoice
          ? Promise.all([client.ready, this.options.localVoice.ready])
          : client.ready;
      readiness
        .then(() => {
          if (this.closed || this.providers.get(role) !== provider) return;
          provider.ready = true;
          this.connection(role, 'ready');
          const phone = this.phones.get(role);
          if (this.closed || !phone) return;
          const { pending } = phone;
          phone.pending = [];
          phone.pendingBytes = 0;
          for (const chunk of pending) {
            if (this.closed) break;
            this.append(role, provider, chunk);
          }
        })
        .catch(() => this.shutdown(`continuous_provider_failed:${role}`));
    } catch {
      this.shutdown(`continuous_provider_failed:${role}`);
    }
  }

  private startPrefixClient(provider: Provider): ContinuousTranslationClient {
    const prefixOptions: OutgoingPrefixOptions = {
      apiKey: this.options.apiKey,
      proxyUrl: this.options.proxyUrl,
      textModel: this.options.model,
      timeoutMs: this.options.sessionTimeoutMs,
      createWebSocket: this.options.createWebSocket,
      now: this.options.now,
      onTranscript: (event) => {
        if (this.closed || this.providers.get('local') !== provider) return;
        try {
          this.options.onTranscript(event);
        } catch {
          /* UI only. */
        }
      },
      onConversationTranscript: (event) => {
        if (this.closed || this.providers.get('local') !== provider) return;
        try {
          this.options.onConversationTranscript?.(event);
        } catch {
          /* Captions cannot interrupt speech. */
        }
      },
      onCommit: (segment) => {
        if (this.closed || this.providers.get('local') !== provider) return;
        this.prefixSequence += 1;
        this.enqueueNano(
          segment.text,
          this.prefixSequence,
          segment.utteranceId,
          segment.finalPart,
        );
        try {
          const at = (this.options.now || Date.now)();
          this.options.onMetric?.({
            role: 'local',
            name: 'prefix_source_to_submit_ms',
            scope: 'text_boundary',
            at,
            pipelineId: this.pipelineId,
            prefixSequence: this.prefixSequence,
            value: Math.max(0, at - segment.firstDeltaAt),
          });
        } catch {
          /* Diagnostics cannot delay voice. */
        }
      },
      onTiming: ({ name, value }) => {
        if (this.closed) return;
        try {
          this.options.onMetric?.({
            role: 'local',
            name,
            value,
            scope:
              name === 'prefix_translation_ms'
                ? 'provider_generation'
                : 'text_boundary',
            at: (this.options.now || Date.now)(),
            pipelineId: this.pipelineId,
          });
        } catch {
          /* Diagnostics only. */
        }
      },
      onError: () => this.shutdown('prefix_provider_failed:local'),
    };
    return (this.options.createPrefixClient || createOutgoingPrefixClient)(
      prefixOptions,
    );
  }

  private captionState(state: 'connecting' | 'ready' | 'failed'): void {
    try {
      this.options.onCaptionState?.({ state });
    } catch {
      // Display failure must not affect original audio.
    }
  }

  private failCaptions(): void {
    if (this.closed || this.captionFailed) return;
    this.captionFailed = true;
    this.captionReady = false;
    this.captionPending = [];
    this.captionPendingBytes = 0;
    this.captionInput.reset();
    try {
      this.captionClient?.abort();
    } catch {
      /* Caption teardown cannot interrupt original audio. */
    }
    this.captionState('failed');
  }

  private startCaptions(): void {
    this.captionState('connecting');
    if (!this.admit('remote', 'remote_captions', 'connect', 0, 0)) return;
    try {
      const client = (
        this.options.createCaptionClient || createRemoteCaptionClient
      )({
        apiKey: this.options.apiKey,
        proxyUrl: this.options.proxyUrl,
        textModel: this.options.model,
        timeoutMs: this.options.sessionTimeoutMs,
        createWebSocket: this.guardedSocketFactory('remote', 'remote_captions'),
        now: this.options.now,
        onTranscript: (event) => {
          if (!this.closed && !this.captionFailed) {
            this.separateNativeDisplay(event);
            if (this.captionFailed) return;
            try {
              this.options.onTranscript(event);
            } catch {
              /* UI only. */
            }
          }
        },
        onError: () => this.failCaptions(),
        onInputDiagnostic: (event) => {
          if (!this.closed && !this.captionFailed)
            this.options.onCaptionInputDiagnostic?.(event);
        },
      });
      this.captionClient = client;
      if (this.closed || this.captionFailed) {
        client.abort();
        return;
      }
      client.ready
        .then(() => {
          if (this.closed || this.captionFailed) return;
          this.captionReady = true;
          this.captionState('ready');
          const pending = this.captionPending;
          this.captionPending = [];
          this.captionPendingBytes = 0;
          for (const audio of pending) this.appendCaption(audio);
        })
        .catch(() => this.failCaptions());
    } catch {
      this.failCaptions();
    }
  }

  private appendCaption(audio: Buffer): void {
    if (this.closed || this.captionFailed) return;
    if (!this.captionReady) {
      if (this.captionPendingBytes + audio.length > MAX_PENDING_BYTES) {
        this.failCaptions();
        return;
      }
      this.captionPending.push(Buffer.from(audio));
      this.captionPendingBytes += audio.length;
      return;
    }
    try {
      for (let offset = 0; offset < audio.length; offset += MAX_APPEND_BYTES) {
        const pcm = this.captionInput.push(
          audio.subarray(offset, offset + MAX_APPEND_BYTES),
        );
        if (
          !this.admit(
            'remote',
            'remote_captions',
            'input',
            pcm.length,
            pcm.length / 48,
          )
        )
          return;
        this.captionClient.append(pcm);
      }
    } catch {
      this.failCaptions();
    }
  }

  private admit(
    role: TranslationRole,
    path: ContinuousBridgeAudioAdmission['path'],
    stage: ContinuousBridgeAudioAdmission['stage'],
    bytes: number,
    audioMs: number,
  ): boolean {
    if (this.closed) return false;
    try {
      if (
        !this.options.admitAudio ||
        this.options.admitAudio({ role, path, stage, bytes, audioMs }) === true
      )
        return !this.closed;
    } catch {
      // Never expose admission exceptions or permit an asynchronous result.
    }
    if (path === 'outgoing_captions') this.failOutgoingCaptions();
    else if (path === 'remote_captions') this.failCaptions();
    else this.shutdown(`continuous_audio_admission_denied:${role}`);
    return false;
  }

  private guardedSocketFactory(
    role: TranslationRole,
    path: 'native_translation' | 'outgoing_captions' | 'remote_captions',
  ): NonNullable<RemoteCaptionOptions['createWebSocket']> {
    const active = () =>
      !this.closed &&
      (path === 'native_translation' ||
        !(path === 'outgoing_captions'
          ? this.outgoingCaptionFailed
          : this.captionFailed));
    return (url, settings) => {
      // Recheck each native/ASR/text creation after branch-level preflight.
      if (!active() || !this.admit(role, path, 'connect', 0, 0))
        throw new Error('CONTINUOUS_ADMISSION_DENIED');
      const socket = this.options.createWebSocket
        ? this.options.createWebSocket(
            url,
            settings as Parameters<
              NonNullable<TranslationBridgeOptions['createWebSocket']>
            >[1],
          )
        : new WebSocket(url, settings);
      const send = socket.send.bind(socket);
      socket.send = ((...args: Parameters<WebSocket['send']>) => {
        // Delayed session.update, ASR results and timers can submit requests
        // without another audio append. Recheck every send. Zero
        // bytes here is a guard, not a second audio charge or token estimate.
        if (!active() || !this.admit(role, path, 'input', 0, 0)) {
          const callback = args.at(-1);
          if (typeof callback === 'function')
            callback(new Error('CONTINUOUS_ADMISSION_DENIED'));
          return;
        }
        send(...args);
      }) as WebSocket['send'];
      return socket;
    };
  }

  private outgoingCaptionState(state: 'connecting' | 'ready' | 'failed'): void {
    try {
      this.options.onOutgoingCaptionState?.({
        role: 'local',
        state,
        translationSource: 'independent_text',
      });
    } catch {
      // Presentation cannot change audio delivery.
    }
  }

  private failOutgoingCaptions(): void {
    if (this.closed || this.outgoingCaptionFailed) return;
    this.outgoingCaptionFailed = true;
    this.outgoingCaptionReady = false;
    this.outgoingCaptionPending = [];
    this.outgoingCaptionPendingBytes = 0;
    this.outgoingCaptionInput.reset();
    try {
      this.outgoingCaptionClient?.abort();
    } catch {
      /* Independent teardown. */
    }
    this.outgoingCaptionState('failed');
  }

  private startOutgoingCaptions(): void {
    this.outgoingCaptionState('connecting');
    if (!this.admit('local', 'outgoing_captions', 'connect', 0, 0)) return;
    try {
      const client = (
        this.options.createPrefixClient || createOutgoingPrefixClient
      )({
        apiKey: this.options.apiKey,
        proxyUrl: this.options.proxyUrl,
        textModel: this.options.model,
        timeoutMs: this.options.sessionTimeoutMs,
        createWebSocket: this.guardedSocketFactory(
          'local',
          'outgoing_captions',
        ),
        now: this.options.now,
        // Prefix diagnostic turns have different IDs. Only its explicit semantic
        // source/translation callback is safe to show as a paired conversation.
        onTranscript: () => {},
        onConversationTranscript: (event) => {
          if (this.closed || this.outgoingCaptionFailed) return;
          const caption: IndependentOutgoingCaption = {
            ...event,
            captionSource: 'independent_text',
            audioCorrespondence: 'none',
          };
          try {
            this.options.onConversationTranscript?.(caption);
          } catch {
            /* UI only. */
          }
        },
        // The independent translation never synthesizes or queues speech and
        // never receives a native audio delivery/played association.
        onCommit: () => {},
        onError: () => this.failOutgoingCaptions(),
      });
      this.outgoingCaptionClient = client;
      if (this.closed || this.outgoingCaptionFailed) {
        client.abort();
        return;
      }
      client.ready
        .then(() => {
          if (this.closed || this.outgoingCaptionFailed) return;
          this.outgoingCaptionReady = true;
          this.outgoingCaptionState('ready');
          const pending = this.outgoingCaptionPending;
          this.outgoingCaptionPending = [];
          this.outgoingCaptionPendingBytes = 0;
          for (const audio of pending) this.appendOutgoingCaption(audio);
        })
        .catch(() => this.failOutgoingCaptions());
    } catch {
      this.failOutgoingCaptions();
    }
  }

  private appendOutgoingCaption(audio: Buffer): void {
    if (this.closed || this.outgoingCaptionFailed) return;
    if (!this.outgoingCaptionReady) {
      if (this.outgoingCaptionPendingBytes + audio.length > MAX_PENDING_BYTES) {
        this.failOutgoingCaptions();
        return;
      }
      this.outgoingCaptionPending.push(Buffer.from(audio));
      this.outgoingCaptionPendingBytes += audio.length;
      return;
    }
    try {
      for (let offset = 0; offset < audio.length; offset += MAX_APPEND_BYTES) {
        const pcm = this.outgoingCaptionInput.push(
          audio.subarray(offset, offset + MAX_APPEND_BYTES),
        );
        if (
          !this.admit(
            'local',
            'outgoing_captions',
            'input',
            pcm.length,
            pcm.length / 48,
          )
        )
          return;
        this.outgoingCaptionClient.append(pcm);
      }
    } catch {
      this.failOutgoingCaptions();
    }
  }

  private onPhoneEvent(
    role: TranslationRole,
    event: Record<string, any>,
  ): void {
    const phone = this.phones.get(role);
    if (event.streamSid !== phone.streamSid) {
      this.shutdown(`continuous_phone_stream_mismatch:${role}`);
      return;
    }
    if (event.event === 'stop') {
      this.shutdown(`continuous_phone_stopped:${role}`);
      return;
    }
    if (event.event === 'mark') {
      if (!isId(event.mark?.name)) throw new Error('INVALID_MARK');
      const delivery = this.deliveries.get(event.mark.name);
      if (!delivery) return; // Duplicate or already settled acknowledgements.
      if (
        delivery.recipientRole !== role ||
        delivery.streamSid !== event.streamSid
      )
        throw new Error('INVALID_MARK_STREAM');
      delivery.acknowledged = true;
      delivery.acknowledgedAtMs ??= this.diagnosticTime();
      this.progress(delivery);
      return;
    }
    if (event.event === 'dtmf') {
      if (
        event.dtmf?.track !== 'inbound_track' ||
        !/^[0-9*#ABCD]$/.test(event.dtmf?.digit)
      )
        throw new Error('INVALID_DTMF');
      return;
    }
    if (event.event !== 'media' || event.media?.track !== 'inbound')
      throw new Error('INVALID_PHONE_EVENT');
    const audio = decodeAudio(event.media.payload);
    // The browser leg exists while the destination is still ringing. Its
    // microphone stream is not a connected conversation and must not fill a
    // queue or be replayed once the other party eventually answers.
    if (!this.started) return;
    this.inputEnergy(role, audio, event.media.timestamp);
    if (this.closed) return;
    if (role === 'remote' && this.options.remoteCaptions) {
      // Forward first: no model handshake, endpointing, ASR or TTS on this path.
      if (
        !this.admit(
          'remote',
          'return_original',
          'output',
          audio.length,
          audio.length / 8,
        )
      )
        return;
      this.forwardOriginal(audio);
      this.appendCaption(audio);
      return;
    }
    const provider = this.providers.get(role);
    if (!provider?.ready) {
      if (phone.pendingBytes + audio.length > MAX_PENDING_BYTES) {
        this.shutdown(`continuous_input_before_ready_overflow:${role}`);
        return;
      }
      phone.pending.push(audio);
      phone.pendingBytes += audio.length;
      if (role === 'local' && this.options.outgoingCaptions)
        this.appendOutgoingCaption(audio);
      return;
    }
    this.append(role, provider, audio);
    if (role === 'local' && this.options.outgoingCaptions)
      this.appendOutgoingCaption(audio);
  }

  private append(
    role: TranslationRole,
    provider: Provider,
    audio: Buffer,
  ): void {
    try {
      for (
        let offset = 0;
        offset < audio.length && !this.closed;
        offset += MAX_APPEND_BYTES
      ) {
        const pcm = provider.input.push(
          audio.subarray(offset, offset + MAX_APPEND_BYTES),
        );
        if (
          !this.admit(
            role,
            'native_translation',
            'input',
            pcm.length,
            pcm.length / 48,
          )
        )
          return;
        provider.client.append(pcm);
      }
    } catch {
      this.shutdown(`continuous_input_send_failed:${role}`);
    }
  }

  private onAudio(
    role: TranslationRole,
    provider: Provider,
    pcm: Buffer,
    metadata?: ContinuousTranslationAudioMetadata,
  ): void {
    if (this.closed || this.providers.get(role) !== provider) return;
    if (role === 'local' && this.options.localVoice) return;
    if (
      !this.admit(
        role,
        'native_translation',
        'output',
        pcm.length,
        pcm.length / 48,
      )
    )
      return;
    // The client can deliver output immediately after resolving ready, before
    // its promise continuation runs; client protocol validation owns readiness.
    this.forward(role, provider.output.push(pcm), metadata);
    // Provider chunk gaps are not semantic end-of-speech. Keep the FIR tail
    // and resampling phase across every chunk, including provider silence;
    // never add synthetic padding between chunks. Hangup discards the tail
    // together with all remaining audio rather than speaking after departure.
  }

  private enqueueNano(
    text: string,
    prefixSequence?: number,
    utteranceId?: string,
    finalPart?: boolean,
  ): void {
    if (this.closed) return;
    // Old mode keeps four whole-sentence jobs. Finer live clauses use the same
    // maximum text allowance (4 * 240 chars) with a separate bounded job count;
    // one paragraph must not overflow solely because it has more clause cuts.
    const jobLimit = this.options.remoteCaptions ? 12 : 4;
    const textChars = this.nanoQueue.reduce(
      (sum, job) => sum + job.text.length,
      this.nanoActiveChars,
    );
    if (
      this.nanoQueue.length + Number(this.nanoBusy) >= jobLimit ||
      textChars + text.length > 960
    ) {
      if (utteranceId) this.utterancePlayback(utteranceId, 'cancelled');
      this.shutdown(`${this.voicePrefix}_synthesis_queue_full:local`);
      return;
    }
    this.nanoQueue.push({
      text,
      at: (this.options.now || Date.now)(),
      ...(prefixSequence === undefined ? {} : { prefixSequence }),
      ...(utteranceId ? { utteranceId, finalPart } : {}),
    });
    if (utteranceId && !this.pendingUtterances.has(utteranceId)) {
      this.pendingUtterances.add(utteranceId);
      this.utterancePlayback(utteranceId, 'queued');
    }
    this.processNano().catch(() =>
      this.shutdown(`${this.voicePrefix}_synthesis_failed:local`),
    );
  }

  private async processNano(): Promise<void> {
    if (this.nanoBusy || this.closed) return;
    this.nanoBusy = true;
    try {
      while (!this.closed && this.nanoQueue.length) {
        const job = this.nanoQueue.shift();
        this.nanoActiveChars = job.text.length;
        if (this.options.localVoice.synthesizeStream) {
          // Consume actual native chunks. Never wait for a whole sentence WAV.
          // eslint-disable-next-line no-await-in-loop -- Preserve clause order.
          await this.streamLocalVoice(job);
          // eslint-disable-next-line no-continue -- Keep the existing complete-wave Nano path unchanged.
          continue;
        }
        // eslint-disable-next-line no-await-in-loop -- One FIFO synthesis at a time preserves spoken order.
        const generated = await this.options.localVoice.synthesize(
          job.text,
          this.nanoAbort.signal,
        );
        if (this.closed) return;
        if (
          generated.sampleRate !== 24000 ||
          !Buffer.isBuffer(generated.pcm) ||
          !generated.pcm.length ||
          generated.pcm.length % 2 ||
          generated.pcm.length >
            48000 * (this.options.localVoice.maxOutputSeconds ?? 20)
        )
          throw new Error('NANO_INVALID_AUDIO');
        try {
          this.options.onMetric?.({
            role: 'local',
            name: 'nano_text_to_audio_ms',
            scope: 'local_synthesis',
            value: Math.max(0, (this.options.now || Date.now)() - job.at),
            generationMs: generated.metrics.generationMs,
            at: (this.options.now || Date.now)(),
          });
        } catch {
          /* Optional diagnostic only. */
        }
        // Each generated sentence is a complete waveform. Drain its FIR tail
        // explicitly; do not reset a resampler between arbitrary provider chunks.
        const converter = new Pcm24kToPcmu();
        const audio = Buffer.concat([
          converter.push(generated.pcm),
          converter.push(Buffer.alloc(384)),
        ]);
        for (
          let offset = 0;
          offset < audio.length && !this.closed;
          offset += DELIVERY_BYTES
        ) {
          const chunk = audio.subarray(offset, offset + DELIVERY_BYTES);
          // Keep at most four seconds queued at Twilio. Playback marks release
          // capacity; hangup/error wakes waiters and discards all late audio.
          while (
            !this.closed &&
            (this.phones.get('remote')?.outstandingBytes ?? 0) + chunk.length >
              32000
          ) {
            // eslint-disable-next-line no-await-in-loop -- Playback acknowledgments release bounded capacity.
            await new Promise<void>((resolve) => {
              this.nanoPlaybackWaiters.add(resolve);
            });
          }
          if (this.closed) return;
          this.forward(
            'local',
            chunk,
            undefined,
            job.prefixSequence,
            job.utteranceId,
          );
        }
        if (!this.closed && job.utteranceId && job.finalPart) {
          this.pendingUtterances.delete(job.utteranceId);
          this.utterancePlayback(job.utteranceId, 'sent', true);
        }
      }
    } catch {
      if (!this.closed)
        this.shutdown(`${this.voicePrefix}_synthesis_failed:local`);
    } finally {
      this.nanoBusy = false;
      this.nanoActiveChars = 0;
    }
  }

  private get voicePrefix(): 'nano' | 'pocket' {
    return this.options.localVoice?.diagnosticPrefix === 'pocket'
      ? 'pocket'
      : 'nano';
  }

  private async streamLocalVoice(job: {
    text: string;
    at: number;
    prefixSequence?: number;
    utteranceId?: string;
    finalPart?: boolean;
  }): Promise<void> {
    const voice = this.options.localVoice;
    const converter = new Pcm24kToPcmu();
    const startedAt = (this.options.now || Date.now)();
    let totalBytes = 0;
    let firstChunk = true;
    let voiced = false;
    let frameSamples = 0;
    let frameSquares = 0;
    let voicedFrames = 0;
    const metric = (
      name:
        | 'pocket_text_to_first_chunk_ms'
        | 'pocket_text_to_first_voiced_ms'
        | 'pocket_synthesis_complete_ms',
    ) => {
      if (this.voicePrefix !== 'pocket') return;
      const at = (this.options.now || Date.now)();
      try {
        this.options.onMetric?.({
          role: 'local',
          name,
          scope: 'local_synthesis',
          value: Math.max(0, at - job.at),
          queueMs: Math.max(0, startedAt - job.at),
          generationMs: Math.max(0, at - startedAt),
          pipelineId: this.pipelineId,
          ...(job.prefixSequence === undefined
            ? {}
            : { prefixSequence: job.prefixSequence }),
          at,
        });
      } catch {
        /* Diagnostics cannot interrupt speech. */
      }
    };
    // The converter and energy frame carry persist across native chunks.
    for await (const generated of voice.synthesizeStream(
      job.text,
      this.nanoAbort.signal,
    )) {
      if (this.closed) return;
      if (
        generated.sampleRate !== 24000 ||
        !Buffer.isBuffer(generated.pcm) ||
        !generated.pcm.length ||
        generated.pcm.length % 2 ||
        generated.pcm.length > 96000 ||
        totalBytes + generated.pcm.length >
          48000 * (voice.maxOutputSeconds ?? 20)
      )
        throw new Error('LOCAL_VOICE_INVALID_STREAM');
      totalBytes += generated.pcm.length;
      if (firstChunk) {
        firstChunk = false;
        metric('pocket_text_to_first_chunk_ms');
      }
      // Match the offline comparison: two consecutive 10ms RMS >= 0.01 frames.
      // This identifies audio energy, not a semantic word or sound at the ear.
      if (!voiced) {
        for (let offset = 0; offset < generated.pcm.length; offset += 2) {
          const sample = generated.pcm.readInt16LE(offset);
          frameSquares += sample * sample;
          frameSamples += 1;
          if (frameSamples === 240) {
            voicedFrames =
              frameSquares / 240 >= (32768 * 0.01) ** 2 ? voicedFrames + 1 : 0;
            frameSamples = 0;
            frameSquares = 0;
            if (voicedFrames >= 2) {
              voiced = true;
              metric('pocket_text_to_first_voiced_ms');
              break;
            }
          }
        }
      }
      // Waiting on phone marks also stops pulling new native chunks. The worker
      // separately bounds pending output; overload fails instead of losing words.
      // eslint-disable-next-line no-await-in-loop -- Stream FIFO backpressure.
      await this.forwardLocalVoice(
        converter.push(generated.pcm),
        job.prefixSequence,
        job.utteranceId,
      );
    }
    if (this.closed) return;
    if (!totalBytes) throw new Error('LOCAL_VOICE_EMPTY_STREAM');
    // Flush once, only on a clean end. No padding between native chunks.
    await this.forwardLocalVoice(
      converter.push(Buffer.alloc(384)),
      job.prefixSequence,
      job.utteranceId,
    );
    if (!this.closed && job.utteranceId && job.finalPart) {
      this.pendingUtterances.delete(job.utteranceId);
      this.utterancePlayback(job.utteranceId, 'sent', true);
    }
    // Completion is bridge consumption, including queue/phone backpressure; it
    // is not an isolated measure of Python computation or actual phone hearing.
    if (!this.closed) metric('pocket_synthesis_complete_ms');
  }

  private async forwardLocalVoice(
    audio: Buffer,
    prefixSequence?: number,
    utteranceId?: string,
  ): Promise<void> {
    for (
      let offset = 0;
      offset < audio.length && !this.closed;
      offset += DELIVERY_BYTES
    ) {
      const chunk = audio.subarray(offset, offset + DELIVERY_BYTES);
      while (
        !this.closed &&
        (this.phones.get('remote')?.outstandingBytes ?? 0) + chunk.length >
          32000
      ) {
        // eslint-disable-next-line no-await-in-loop -- Playback marks release capacity.
        await new Promise<void>((resolve) => {
          this.nanoPlaybackWaiters.add(resolve);
        });
      }
      if (this.closed) return;
      this.forward('local', chunk, undefined, prefixSequence, utteranceId);
    }
  }

  private wakeNanoPlayback(): void {
    const waiters = [...this.nanoPlaybackWaiters];
    this.nanoPlaybackWaiters.clear();
    waiters.forEach((resolve) => resolve());
  }

  private utterancePlayback(
    utteranceId: string,
    status: UtterancePlaybackEvent['status'],
    sealed = false,
  ): void {
    try {
      this.options.onUtterancePlayback?.({
        utteranceId,
        role: 'local',
        status,
        at: (this.options.now || Date.now)(),
        ...(sealed
          ? {
              sealed: true,
              expectedDeliveryCount:
                this.utteranceDeliveryCounts.get(utteranceId) || 0,
            }
          : {}),
      });
    } catch {
      // Queue presentation must never interrupt audio or cleanup.
    }
    if (sealed || status === 'cancelled')
      this.utteranceDeliveryCounts.delete(utteranceId);
  }

  private forwardOriginal(audio: Buffer): void {
    if (this.closed || !audio.length) return;
    const phone = this.phones.get('local');
    if (
      !phone ||
      phone.outstandingBytes + audio.length > MAX_OUTSTANDING_BYTES
    ) {
      this.shutdown('continuous_playback_overflow:local');
      return;
    }
    if (!this.directDelivery) {
      if (this.deliveries.size >= MAX_PENDING_MARKS) {
        this.shutdown('continuous_playback_overflow:local');
        return;
      }
      this.sequence += 1;
      const name = `original_${this.sequence}`;
      const delivery: Delivery = {
        role: 'remote',
        recipientRole: 'local',
        streamSid: phone.streamSid,
        name,
        generatedBytes: 0,
        sentBytes: 0,
        pendingWrites: 1,
        sentReported: false,
        acknowledged: false,
        createdAtMs: this.diagnosticTime(),
        energySquares: 0,
        energySamples: 0,
        peak: 0,
        sealed: false,
        timer: setTimeout(
          () => this.shutdown('continuous_playback_timeout:local'),
          this.options.playbackTimeoutMs ?? 20000,
        ),
      };
      delivery.timer.unref?.();
      this.deliveries.set(name, delivery);
      this.directDelivery = delivery;
      // Batch only playback markers, never hold or re-encode original audio.
      this.directMarkTimer = setTimeout(() => this.flushOriginalMark(), 200);
      this.directMarkTimer.unref?.();
    }
    const delivery = this.directDelivery;
    delivery.generatedBytes += audio.length;
    this.energy(delivery, audio);
    delivery.pendingWrites += 1;
    phone.outstandingBytes += audio.length;
    this.send(
      phone,
      {
        event: 'media',
        streamSid: phone.streamSid,
        media: { payload: audio.toString('base64') },
      },
      'local',
      () => {
        delivery.sentBytes += audio.length;
        delivery.pendingWrites -= 1;
        this.progress(delivery);
      },
    );
    if (delivery.generatedBytes >= DELIVERY_BYTES) this.flushOriginalMark();
  }

  private flushOriginalMark(): void {
    clearTimeout(this.directMarkTimer);
    this.directMarkTimer = undefined;
    const delivery = this.directDelivery;
    this.directDelivery = undefined;
    if (this.closed || !delivery) return;
    delivery.sealed = true;
    this.diagnostic(delivery, 'generated');
    const phone = this.phones.get('local');
    this.send(
      phone,
      {
        event: 'mark',
        streamSid: phone.streamSid,
        mark: { name: delivery.name },
      },
      'local',
      () => {
        delivery.pendingWrites -= 1;
        this.progress(delivery);
      },
    );
  }

  private forward(
    role: TranslationRole,
    audio: Buffer,
    metadata?: ContinuousTranslationAudioMetadata,
    prefixSequence?: number,
    utteranceId?: string,
  ): void {
    if (this.closed || !audio.length) return;
    const recipientRole = opposite(role);
    const phone = this.phones.get(recipientRole);
    if (
      !phone ||
      phone.outstandingBytes + audio.length > MAX_OUTSTANDING_BYTES
    ) {
      this.shutdown(`continuous_playback_overflow:${recipientRole}`);
      return;
    }
    for (
      let offset = 0;
      offset < audio.length && !this.closed;
      offset += DELIVERY_BYTES
    ) {
      if (this.deliveries.size >= MAX_PENDING_MARKS) {
        this.shutdown(`continuous_playback_overflow:${recipientRole}`);
        break;
      }
      const chunk = audio.subarray(offset, offset + DELIVERY_BYTES);
      this.sequence += 1;
      const name = `continuous_${this.sequence}`;
      const delivery: Delivery = {
        ...(utteranceId ? { utteranceId } : {}),
        role,
        recipientRole,
        streamSid: phone.streamSid,
        name,
        generatedBytes: chunk.length,
        sentBytes: 0,
        pendingWrites: 2,
        sentReported: false,
        acknowledged: false,
        createdAtMs: this.diagnosticTime(),
        energySquares: 0,
        energySamples: 0,
        peak: 0,
        ...(prefixSequence === undefined ? {} : { prefixSequence }),
        ...(Number.isSafeInteger(metadata?.providerElapsedMs) &&
        metadata.providerElapsedMs >= 0 &&
        metadata.providerElapsedMs <= 7 * 24 * 60 * 60 * 1000
          ? { providerElapsedMs: metadata.providerElapsedMs }
          : {}),
        sealed: true,
        timer: setTimeout(
          () => this.shutdown(`continuous_playback_timeout:${recipientRole}`),
          this.options.playbackTimeoutMs ?? 20000,
        ),
      };
      delivery.timer.unref?.();
      phone.outstandingBytes += chunk.length;
      this.deliveries.set(name, delivery);
      if (utteranceId)
        this.utteranceDeliveryCounts.set(
          utteranceId,
          (this.utteranceDeliveryCounts.get(utteranceId) || 0) + 1,
        );
      this.energy(delivery, chunk);
      this.diagnostic(delivery, 'generated');
      this.send(
        phone,
        {
          event: 'media',
          streamSid: phone.streamSid,
          media: { payload: chunk.toString('base64') },
        },
        recipientRole,
        () => {
          delivery.sentBytes = chunk.length;
          delivery.pendingWrites -= 1;
          this.progress(delivery);
        },
      );
      this.send(
        phone,
        {
          event: 'mark',
          streamSid: phone.streamSid,
          mark: { name },
        },
        recipientRole,
        () => {
          delivery.pendingWrites -= 1;
          this.progress(delivery);
        },
      );
    }
  }

  private send(
    phone: Phone,
    event: object,
    role: TranslationRole,
    sent: () => void,
  ): void {
    if (this.closed) return;
    const payload = JSON.stringify(event);
    if (
      phone.socket.readyState !== WebSocket.OPEN ||
      phone.socket.bufferedAmount + Buffer.byteLength(payload) >
        MAX_TRANSPORT_BYTES
    ) {
      this.shutdown(`continuous_phone_backpressure:${role}`);
      return;
    }
    try {
      phone.socket.send(payload, (error?: Error) => {
        if (this.closed) return;
        if (error) this.shutdown(`continuous_phone_send_failed:${role}`);
        else sent();
      });
    } catch {
      this.shutdown(`continuous_phone_send_failed:${role}`);
    }
  }

  private diagnostic(
    delivery: Delivery,
    stage: TranslationAudioDiagnostic['stage'],
  ): void {
    try {
      this.options.onAudioDiagnostic?.({
        ...(delivery.utteranceId ? { utteranceId: delivery.utteranceId } : {}),
        ...(this.options.remoteCaptions && delivery.role === 'remote'
          ? { audioKind: 'original' as const }
          : {}),
        role: delivery.role,
        recipientRole: delivery.recipientRole,
        stage,
        generatedBytes: delivery.generatedBytes,
        sentBytes: delivery.sentBytes,
        pipelineId: this.pipelineId,
        deliveryId: delivery.name,
        ...(delivery.prefixSequence === undefined
          ? {}
          : { prefixSequence: delivery.prefixSequence }),
        clock: 'bridge_monotonic',
        observedAtMs: this.diagnosticTime(),
        createdAtMs: delivery.createdAtMs,
        ...(delivery.sentAtMs === undefined
          ? {}
          : { sentAtMs: delivery.sentAtMs }),
        ...(delivery.acknowledgedAtMs === undefined
          ? {}
          : { acknowledgedAtMs: delivery.acknowledgedAtMs }),
        ...(delivery.sentAtMs !== undefined &&
        delivery.acknowledgedAtMs !== undefined &&
        delivery.acknowledgedAtMs >= delivery.sentAtMs
          ? { sentToMarkMs: delivery.acknowledgedAtMs - delivery.sentAtMs }
          : {}),
        outstandingAudioMs:
          (this.phones.get(delivery.recipientRole)?.outstandingBytes ?? 0) / 8,
        audioDurationMs: delivery.generatedBytes / 8,
        rms: delivery.energySamples
          ? Math.round(
              Math.sqrt(delivery.energySquares / delivery.energySamples),
            )
          : 0,
        peak: delivery.peak,
        ...(delivery.providerElapsedMs === undefined
          ? {}
          : { providerElapsedMs: delivery.providerElapsedMs }),
      });
    } catch {
      // Aggregate diagnostics only, never an audio dependency.
    }
  }

  private progress(delivery: Delivery): void {
    if (
      this.closed ||
      !this.deliveries.has(delivery.name) ||
      !delivery.sealed ||
      delivery.pendingWrites
    )
      return;
    if (!delivery.sentReported) {
      delivery.sentReported = true;
      delivery.sentAtMs = this.diagnosticTime();
      this.diagnostic(delivery, 'sent');
    }
    if (this.closed || !delivery.acknowledged) return;
    clearTimeout(delivery.timer);
    this.deliveries.delete(delivery.name);
    this.phones.get(delivery.recipientRole).outstandingBytes -=
      delivery.generatedBytes;
    this.wakeNanoPlayback();
    // A Twilio mark proves queue drainage, never human audibility.
    this.diagnostic(delivery, 'playback_confirmed');
  }

  private onTranscript(
    role: TranslationRole,
    provider: Provider,
    delta: string,
    kind: TranscriptEvent['kind'] = 'translation',
  ): void {
    if (this.closed || this.providers.get(role) !== provider) return;
    // The protocol has no final-sentence boundary. Bounded cumulative display
    // segments are visual excerpts, not ASR-final or paired utterances. Source
    // and target are separate namespaces even when elapsed alignment matches.
    const source = kind === 'original';
    for (let offset = 0; offset < delta.length && !this.closed; ) {
      let text = source ? provider.sourceTranscript : provider.transcript;
      if (!text) {
        const at = (this.options.now || Date.now)();
        if (source) provider.sourceTranscriptAt = at;
        else provider.transcriptAt = at;
      }
      const length = Math.min(
        MAX_TRANSCRIPT_CHARS - text.length,
        delta.length - offset,
      );
      text += delta.slice(offset, offset + length);
      if (source) provider.sourceTranscript = text;
      else provider.transcript = text;
      offset += length;
      const event: NativeContinuousCaption = {
        id: source
          ? `continuous_input_${role}_${provider.sourceTranscriptSequence}`
          : `continuous_${role}_${provider.transcriptSequence}`,
        pairing: 'unpaired',
        boundary: 'diagnostic',
        role,
        kind,
        text,
        final: false,
        at: source ? provider.sourceTranscriptAt : provider.transcriptAt,
        ...(source
          ? {
              captionSource: 'native_input' as const,
              audioCorrespondence: 'none' as const,
            }
          : {
              captionSource: 'native_output' as const,
              audioCorrespondence: 'generated_only' as const,
            }),
      };
      try {
        this.options.onTranscript(event);
      } catch {
        // Display failure must never interrupt spoken translation.
      }
      if (text.length === MAX_TRANSCRIPT_CHARS) {
        if (source) {
          provider.sourceTranscript = '';
          provider.sourceTranscriptSequence += 1;
        } else {
          provider.transcript = '';
          provider.transcriptSequence += 1;
        }
      }
    }
  }

  private separateNativeDisplay(event: TranscriptEvent): void {
    if (
      this.options.localVoice ||
      this.options.outgoingPrefixes ||
      event.role !== 'remote' ||
      !event.utteranceId ||
      !event.text.trim() ||
      this.captionUtterances.has(event.utteranceId)
    )
      return;
    // Remember the whole session so a late translation or revision of an old
    // remote turn cannot split the currently displayed local stream again.
    if (this.captionUtterances.size >= 32768) {
      this.failCaptions();
      return;
    }
    this.captionUtterances.add(event.utteranceId);
    const provider = this.providers.get('local');
    if (!provider) return;
    // A speaker change is only a display boundary. Never manufacture a final
    // sentence, pair native streams, or change audio flow and playback evidence.
    if (provider.transcript) {
      provider.transcript = '';
      provider.transcriptSequence += 1;
    }
    if (provider.sourceTranscript) {
      provider.sourceTranscript = '';
      provider.sourceTranscriptSequence += 1;
    }
  }

  private shutdown(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.pendingUtterances)
      this.utterancePlayback(id, 'cancelled');
    this.pendingUtterances.clear();
    for (const role of ROLES) this.flushInputEnergy(role);
    clearTimeout(this.directMarkTimer);
    this.directDelivery = undefined;
    try {
      this.captionClient?.abort();
    } catch {
      /* Continue phone and provider cleanup. */
    }
    this.captionPending = [];
    this.captionPendingBytes = 0;
    this.captionUtterances.clear();
    this.captionInput.reset();
    try {
      this.outgoingCaptionClient?.abort();
    } catch {
      /* Continue audio cleanup. */
    }
    this.outgoingCaptionPending = [];
    this.outgoingCaptionPendingBytes = 0;
    this.outgoingCaptionInput.reset();
    this.nanoCommitter?.close();
    this.nanoAbort.abort();
    this.nanoQueue.length = 0;
    this.wakeNanoPlayback();
    this.removeListeners.splice(0).forEach((remove) => remove());
    const phones = [...this.phones.values()];
    for (const phone of phones) {
      try {
        if (
          phone.socket.readyState === WebSocket.OPEN &&
          phone.socket.bufferedAmount < MAX_TRANSPORT_BYTES
        )
          phone.socket.send(
            JSON.stringify({ event: 'clear', streamSid: phone.streamSid }),
            () => {},
          );
      } catch {
        /* Best effort; the session manager also ends both calls. */
      }
    }
    for (const [role, provider] of this.providers) {
      try {
        provider.client?.abort();
      } catch {
        /* Already closing. */
      }
      provider.input.reset();
      provider.output.reset();
      this.connection(role, 'disconnected');
    }
    for (const delivery of this.deliveries.values()) {
      clearTimeout(delivery.timer);
      this.diagnostic(delivery, 'unconfirmed');
    }
    this.deliveries.clear();
    this.providers.clear();
    this.phones.clear();
    if (reason) {
      try {
        this.options.onFailure(reason);
      } catch {
        /* Still close transports. */
      }
    }
    phones.forEach((phone) => this.closeSocket(phone.socket));
  }

  private closeSocket(socket: WebSocket): void {
    socket.on('error', ignoreSocketError);
    try {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    } catch {
      // No drain on hangup: never play queued translations after user departure.
    }
  }
}
