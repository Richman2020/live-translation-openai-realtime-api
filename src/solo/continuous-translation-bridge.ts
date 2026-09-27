import WebSocket from 'ws';

import {
  createContinuousTranslationClient,
  type ContinuousTranslationClient,
  type ContinuousTranslationOptions,
} from './continuous-translation-client';
import { Pcm24kToPcmu, PcmuToPcm24k } from './translation-pcm';
import type {
  TranscriptEvent,
  TranslationAudioDiagnostic,
  TranslationBridgeOptions,
  TranslationRole,
} from './translation-bridge';

export type ContinuousTranslationBridgeOptions = TranslationBridgeOptions & {
  createClient?: (
    options: ContinuousTranslationOptions,
  ) => ContinuousTranslationClient;
  playbackTimeoutMs?: number;
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
 * speaker has independent codec/session state; text never controls audio.
 */
export class ContinuousTranslationBridge {
  private readonly phones = new Map<TranslationRole, Phone>();

  private readonly providers = new Map<TranslationRole, Provider>();

  private readonly deliveries = new Map<string, Delivery>();

  private readonly removeListeners: (() => void)[] = [];

  private sequence = 0;

  private started = false;

  private closed = false;

  constructor(private readonly options: ContinuousTranslationBridgeOptions) {
    const timeout = options.playbackTimeoutMs ?? 20000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120000)
      throw new Error('INVALID_CONTINUOUS_PLAYBACK_TIMEOUT');
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
        this.startProvider(source);
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
        // Never expose provider errors, credentials, audio or transcripts.
        onError: () => this.shutdown(`continuous_provider_failed:${role}`),
      });
      provider.client = client;
      if (this.closed) {
        client.abort();
        return;
      }
      client.ready
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
    // The client can deliver output immediately after resolving ready, before
    // its promise continuation runs; client protocol validation owns readiness.
    this.forward(role, provider.output.push(pcm));
    // Provider chunk gaps are not semantic end-of-speech. Keep the FIR tail
    // and resampling phase across every chunk, including provider silence;
    // never add synthetic padding between chunks. Hangup discards the tail
    // together with all remaining audio rather than speaking after departure.
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
    this.removeListeners.splice(0).forEach((remove) => remove());
    const phones = [...this.phones.values()];
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
