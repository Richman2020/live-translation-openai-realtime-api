import WebSocket from 'ws';

import {
  createContinuousTranslationClient,
  type ContinuousTranslationClient,
  type ContinuousTranslationOptions,
} from './continuous-translation-client';
import { Pcm24kToPcmu, PcmuToPcm24k } from './translation-pcm';
import { createNanoTextCommitter } from './nano-text-committer';
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
} from './translation-bridge';

export type LocalVoiceSynthesizer = {
  ready: Promise<void>;
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
  /** Remote PCMU goes straight to the headset; ASR/text is an independent branch. */
  remoteCaptions?: boolean;
  createCaptionClient?: (options: RemoteCaptionOptions) => RemoteCaptionClient;
};

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
};
type Delivery = {
  role: TranslationRole;
  recipientRole: TranslationRole;
  streamSid: string;
  name: string;
  generatedBytes: number;
  sentBytes: number;
  pendingWrites: number;
  sentReported: boolean;
  acknowledged: boolean;
  sealed: boolean;
  timer: ReturnType<typeof setTimeout>;
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

  private readonly removeListeners: (() => void)[] = [];

  private sequence = 0;

  private started = false;

  private closed = false;

  private readonly nanoAbort = new AbortController();

  private readonly nanoPlaybackWaiters = new Set<() => void>();

  private readonly nanoQueue: { text: string; at: number }[] = [];

  private nanoBusy = false;

  private nanoActiveChars = 0;

  private readonly nanoCommitter?: ReturnType<typeof createNanoTextCommitter>;

  private captionClient?: RemoteCaptionClient;

  private captionReady = false;

  private captionFailed = false;

  private readonly captionInput = new PcmuToPcm24k();

  private captionPending: Buffer[] = [];

  private captionPendingBytes = 0;

  private directDelivery?: Delivery;

  private directMarkTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: ContinuousTranslationBridgeOptions) {
    const timeout = options.playbackTimeoutMs ?? 20000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120000)
      throw new Error('INVALID_CONTINUOUS_PLAYBACK_TIMEOUT');
    if (options.localVoice) {
      this.nanoCommitter = createNanoTextCommitter({
        boundaryDelayMs: options.sentenceBoundaryDelayMs,
        clauseBoundaries: options.remoteCaptions === true,
        now: options.now,
        onCommitTiming: ({ bufferWaitMs }) => {
          if (!this.options.remoteCaptions) return;
          this.options.onMetric?.({
            role: 'local',
            name: 'nano_boundary_wait_ms',
            scope: 'text_boundary',
            value: bufferWaitMs,
            at: (this.options.now || Date.now)(),
          });
        },
        onCommit: (text) => this.enqueueNano(text),
        onError: () => this.shutdown('nano_text_boundary_failed:local'),
      });
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
    if (this.phones.size === 2 && !this.started) {
      this.started = true;
      for (const source of ROLES) {
        if (this.closed) break;
        if (source === 'remote' && this.options.remoteCaptions)
          this.startCaptions();
        else this.startProvider(source);
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
    const provider: Provider = {
      ready: false,
      input: new PcmuToPcm24k(),
      output: new Pcm24kToPcmu(),
      transcript: '',
      transcriptSequence: 0,
      transcriptAt: 0,
    };
    this.providers.set(role, provider);
    try {
      const client = (
        this.options.createClient || createContinuousTranslationClient
      )({
        apiKey: this.options.apiKey,
        targetLanguage: role === 'local' ? 'en' : 'zh',
        proxyUrl: this.options.proxyUrl,
        timeoutMs: this.options.sessionTimeoutMs,
        createWebSocket: this.options.createWebSocket,
        onAudio: (pcm) => this.onAudio(role, provider, pcm),
        onTranscript: (delta) => this.onTranscript(role, provider, delta),
        ...(role === 'local' && this.nanoCommitter
          ? {
              onTranslatedText: (delta: string) =>
                this.nanoCommitter.append(delta),
            }
          : {}),
        // Never expose provider errors, credentials, audio or transcripts.
        onError: () => this.shutdown(`continuous_provider_failed:${role}`),
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
    try {
      const client = (
        this.options.createCaptionClient || createRemoteCaptionClient
      )({
        apiKey: this.options.apiKey,
        proxyUrl: this.options.proxyUrl,
        textModel: this.options.model,
        timeoutMs: this.options.sessionTimeoutMs,
        createWebSocket: this.options.createWebSocket,
        now: this.options.now,
        onTranscript: (event) => {
          if (!this.closed && !this.captionFailed) {
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
      for (let offset = 0; offset < audio.length; offset += MAX_APPEND_BYTES)
        this.captionClient.append(
          this.captionInput.push(
            audio.subarray(offset, offset + MAX_APPEND_BYTES),
          ),
        );
    } catch {
      this.failCaptions();
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
    if (role === 'remote' && this.options.remoteCaptions) {
      // Forward first: no model handshake, endpointing, ASR or TTS on this path.
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
      return;
    }
    this.append(role, provider, audio);
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
      )
        provider.client.append(
          provider.input.push(
            audio.subarray(offset, offset + MAX_APPEND_BYTES),
          ),
        );
    } catch {
      this.shutdown(`continuous_input_send_failed:${role}`);
    }
  }

  private onAudio(
    role: TranslationRole,
    provider: Provider,
    pcm: Buffer,
  ): void {
    if (this.closed || this.providers.get(role) !== provider) return;
    if (role === 'local' && this.options.localVoice) return;
    // The client can deliver output immediately after resolving ready, before
    // its promise continuation runs; client protocol validation owns readiness.
    this.forward(role, provider.output.push(pcm));
    // Provider chunk gaps are not semantic end-of-speech. Keep the FIR tail
    // and resampling phase across every chunk, including provider silence;
    // never add synthetic padding between chunks. Hangup discards the tail
    // together with all remaining audio rather than speaking after departure.
  }

  private enqueueNano(text: string): void {
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
      this.shutdown('nano_synthesis_queue_full:local');
      return;
    }
    this.nanoQueue.push({ text, at: (this.options.now || Date.now)() });
    this.processNano().catch(() =>
      this.shutdown('nano_synthesis_failed:local'),
    );
  }

  private async processNano(): Promise<void> {
    if (this.nanoBusy || this.closed) return;
    this.nanoBusy = true;
    try {
      while (!this.closed && this.nanoQueue.length) {
        const job = this.nanoQueue.shift();
        this.nanoActiveChars = job.text.length;
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
          this.forward('local', chunk);
        }
      }
    } catch {
      if (!this.closed) this.shutdown('nano_synthesis_failed:local');
    } finally {
      this.nanoBusy = false;
      this.nanoActiveChars = 0;
    }
  }

  private wakeNanoPlayback(): void {
    const waiters = [...this.nanoPlaybackWaiters];
    this.nanoPlaybackWaiters.clear();
    waiters.forEach((resolve) => resolve());
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

  private forward(role: TranslationRole, audio: Buffer): void {
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
        role,
        recipientRole,
        streamSid: phone.streamSid,
        name,
        generatedBytes: chunk.length,
        sentBytes: 0,
        pendingWrites: 2,
        sentReported: false,
        acknowledged: false,
        sealed: true,
        timer: setTimeout(
          () => this.shutdown(`continuous_playback_timeout:${recipientRole}`),
          this.options.playbackTimeoutMs ?? 20000,
        ),
      };
      delivery.timer.unref?.();
      phone.outstandingBytes += chunk.length;
      this.deliveries.set(name, delivery);
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
        ...(this.options.remoteCaptions && delivery.role === 'remote'
          ? { audioKind: 'original' as const }
          : {}),
        role: delivery.role,
        recipientRole: delivery.recipientRole,
        stage,
        generatedBytes: delivery.generatedBytes,
        sentBytes: delivery.sentBytes,
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
  ): void {
    if (this.closed || this.providers.get(role) !== provider) return;
    // The protocol has no final-sentence boundary. Bounded cumulative display
    // segments are diagnostic excerpts, not ASR or model-final utterances.
    for (let offset = 0; offset < delta.length && !this.closed; ) {
      if (!provider.transcript)
        provider.transcriptAt = (this.options.now || Date.now)();
      const length = Math.min(
        MAX_TRANSCRIPT_CHARS - provider.transcript.length,
        delta.length - offset,
      );
      provider.transcript += delta.slice(offset, offset + length);
      offset += length;
      const event: TranscriptEvent = {
        id: `continuous_${role}_${provider.transcriptSequence}`,
        role,
        kind: 'translation',
        text: provider.transcript,
        final: false,
        at: provider.transcriptAt,
      };
      try {
        this.options.onTranscript(event);
      } catch {
        // Display failure must never interrupt spoken translation.
      }
      if (provider.transcript.length === MAX_TRANSCRIPT_CHARS) {
        provider.transcript = '';
        provider.transcriptSequence += 1;
      }
    }
  }

  private shutdown(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.directMarkTimer);
    this.directDelivery = undefined;
    try {
      this.captionClient?.abort();
    } catch {
      /* Continue phone and provider cleanup. */
    }
    this.captionPending = [];
    this.captionPendingBytes = 0;
    this.captionInput.reset();
    this.nanoCommitter?.close();
    this.nanoAbort.abort();
    this.nanoQueue.length = 0;
    this.wakeNanoPlayback();
    this.removeListeners.splice(0).forEach((remove) => remove());
    const phones = [...this.phones.values()];
    if (this.options.localVoice) {
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
