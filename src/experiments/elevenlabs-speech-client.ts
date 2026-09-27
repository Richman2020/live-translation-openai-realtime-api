/**
 * Isolated fixed-voice TTS experiment. Nothing in the phone runtime imports this.
 * Official protocol: https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts
 * A completed response proves audio transport, never voice quality or phone latency.
 */
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

import { muLawToPcm16 } from '../solo/translation-pcm';

export const FIXED_VOICE_MODEL = 'eleven_flash_v2_5';
export const FIXED_VOICE_FORMAT = 'ulaw_8000';
export const FIXED_VOICE_SETTINGS = Object.freeze({
  stability: 0.75,
  similarity_boost: 0.8,
  use_speaker_boost: false,
});
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_EVENTS = 4096;
const MAX_AUDIO_BYTES = 8000 * 60;
const ENERGY_FRAME_BYTES = 160;
const ENERGY_THRESHOLD_RMS = 300;

export type SpeechEvent = {
  type: 'connected' | 'text_submitted' | 'audio' | 'final';
  elapsedMs: number;
  bytes?: number;
};

export type FixedSpeechResult = {
  pcmu: Buffer;
  events: SpeechEvent[];
  metrics: {
    connectionMs: number;
    firstAudioFromTextMs: number;
    firstNonSilentArrivalFromTextMs: number | null;
    completionFromTextMs: number;
    audioDurationMs: number;
    energyThresholdRms: number;
    energyFrameMs: 20;
    boundary: 'client-observed-arrival-not-phone-playback-or-human-hearing';
  };
};

export type FixedSpeechOptions = {
  apiKey: string;
  voiceId: string;
  language: 'en' | 'zh';
  text: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  createWebSocket?: (
    url: string,
    options: WebSocket.ClientOptions,
  ) => WebSocket;
};

export class FixedSpeechError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'FixedSpeechError';
  }
}

export function validFixedVoiceId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{6,128}$/.test(value);
}

function validateOptions(options: FixedSpeechOptions): void {
  if (
    !options.apiKey ||
    options.apiKey.length > 1024 ||
    /\s/.test(options.apiKey)
  )
    throw new FixedSpeechError('INVALID_API_KEY');
  if (!validFixedVoiceId(options.voiceId))
    throw new FixedSpeechError('INVALID_VOICE_ID');
  if (options.language !== 'en' && options.language !== 'zh')
    throw new FixedSpeechError('INVALID_LANGUAGE');
  if (
    typeof options.text !== 'string' ||
    !options.text.trim() ||
    options.text.length > 2000 ||
    // eslint-disable-next-line no-control-regex -- Reject control characters in text submitted to the provider.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(options.text)
  )
    throw new FixedSpeechError('INVALID_TEXT');
  const timeout = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 120_000)
    throw new FixedSpeechError('INVALID_TIMEOUT');
}

/** Decodes only canonical standard base64; Buffer.from alone accepts corruption. */
function decodeAudio(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_MESSAGE_BYTES ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new FixedSpeechError('INVALID_AUDIO_BASE64');
  const buffer = Buffer.from(value, 'base64');
  if (buffer.toString('base64') !== value)
    throw new FixedSpeechError('INVALID_AUDIO_BASE64');
  return buffer;
}

/**
 * Submits one complete, already-verified sentence/passage and streams raw PCMU.
 * It does not translate, select/clone voices, upload microphone audio, or dial.
 */
export async function synthesizeFixedSpeech(
  options: FixedSpeechOptions,
): Promise<FixedSpeechResult> {
  validateOptions(options);
  if (options.signal?.aborted) throw new FixedSpeechError('ABORTED');
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const events: SpeechEvent[] = [];
    const chunks: Buffer[] = [];
    let socket: WebSocket | undefined;
    let finished = false;
    let totalBytes = 0;
    let receivedMessages = 0;
    let connectionMs = 0;
    let textAt: number | undefined;
    let firstAudioAt: number | undefined;
    let firstEnergyAt: number | null = null;
    let energySquared = 0;
    let energySamples = 0;
    let lastAudioAt = 0;
    const elapsed = () => performance.now() - started;
    const timer = setTimeout(
      // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Hoisted failure handler shares cleanup with the timer.
      () => fail('TIMEOUT'),
      options.timeoutMs ?? 60_000,
    );
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Hoisted failure handler shares abort-listener cleanup.
    const onAbort = () => fail('ABORTED');

    // Never include upstream messages, close reasons, URLs or request headers in errors.
    function cleanup(): void {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (!socket) return;
      socket.removeAllListeners();
      // ws can emit an asynchronous error after terminate during CONNECTING.
      socket.on('error', () => undefined);
      try {
        socket.terminate();
      } catch {
        /* Already closed by the provider. */
      }
    }

    function fail(code: string): void {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new FixedSpeechError(code));
    }

    function send(value: object): void {
      if (finished || !socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(JSON.stringify(value), (error?: Error) => {
          if (error) fail('SEND_FAILED');
        });
      } catch {
        fail('SEND_FAILED');
      }
    }

    function recordAudio(pcmu: Buffer, at: number): void {
      if (totalBytes + pcmu.length > MAX_AUDIO_BYTES)
        throw new FixedSpeechError('AUDIO_LIMIT');
      if (
        totalBytes === 0 &&
        /^(RIFF|OggS|ID3)/.test(pcmu.toString('ascii', 0, 4))
      )
        throw new FixedSpeechError('UNEXPECTED_AUDIO_CONTAINER');
      totalBytes += pcmu.length;
      firstAudioAt ??= at;
      lastAudioAt = at;
      chunks.push(pcmu);
      events.push({ type: 'audio', elapsedMs: at, bytes: pcmu.length });
      // Windows span provider chunks. Arrival is when all samples needed to
      // classify that window exist, not when a future phone listener hears it.
      for (const code of pcmu) {
        const sample = muLawToPcm16(code);
        energySquared += sample * sample;
        energySamples += 1;
        if (energySamples === ENERGY_FRAME_BYTES) {
          if (Math.sqrt(energySquared / energySamples) >= ENERGY_THRESHOLD_RMS)
            firstEnergyAt ??= at;
          energySquared = 0;
          energySamples = 0;
        }
      }
    }

    function complete(): void {
      if (
        textAt === undefined ||
        firstAudioAt === undefined ||
        totalBytes === 0
      ) {
        fail('EMPTY_AUDIO');
        return;
      }
      if (
        energySamples > 0 &&
        Math.sqrt(energySquared / energySamples) >= ENERGY_THRESHOLD_RMS
      )
        firstEnergyAt ??= lastAudioAt;
      const at = elapsed();
      events.push({ type: 'final', elapsedMs: at });
      finished = true;
      cleanup();
      resolve({
        pcmu: Buffer.concat(chunks, totalBytes),
        events,
        metrics: {
          connectionMs,
          firstAudioFromTextMs: firstAudioAt - textAt,
          firstNonSilentArrivalFromTextMs:
            firstEnergyAt === null ? null : firstEnergyAt - textAt,
          completionFromTextMs: at - textAt,
          audioDurationMs: totalBytes / 8,
          energyThresholdRms: ENERGY_THRESHOLD_RMS,
          energyFrameMs: 20,
          boundary:
            'client-observed-arrival-not-phone-playback-or-human-hearing',
        },
      });
    }

    options.signal?.addEventListener('abort', onAbort, { once: true });
    const query = new URLSearchParams({
      model_id: FIXED_VOICE_MODEL,
      output_format: FIXED_VOICE_FORMAT,
      language_code: options.language,
    });
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${options.voiceId}/stream-input?${query}`;
    try {
      socket = (
        options.createWebSocket ??
        ((endpoint, config) => new WebSocket(endpoint, config))
      )(url, {
        headers: { 'xi-api-key': options.apiKey },
        handshakeTimeout: Math.min(options.timeoutMs ?? 60_000, 15_000),
        maxPayload: MAX_MESSAGE_BYTES,
        perMessageDeflate: false,
        followRedirects: false,
      });
      socket.on('open', () => {
        if (finished) return;
        connectionMs = elapsed();
        events.push({ type: 'connected', elapsedMs: connectionMs });
        send({ text: ' ', voice_settings: FIXED_VOICE_SETTINGS });
        if (finished) return;
        textAt = elapsed();
        events.push({ type: 'text_submitted', elapsedMs: textAt });
        send({ text: `${options.text.trim()} `, flush: true });
        send({ text: '' });
      });
      socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        if (finished) return;
        receivedMessages += 1;
        if (receivedMessages > MAX_EVENTS) {
          fail('EVENT_LIMIT');
          return;
        }
        try {
          if (isBinary) throw new FixedSpeechError('UNEXPECTED_BINARY_MESSAGE');
          const raw = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
          if (raw.length > MAX_MESSAGE_BYTES)
            throw new FixedSpeechError('MESSAGE_LIMIT');
          const event = JSON.parse(raw.toString('utf8'));
          if (!event || typeof event !== 'object' || Array.isArray(event))
            throw new FixedSpeechError('INVALID_EVENT');
          if (event.error !== undefined || event.detail !== undefined)
            throw new FixedSpeechError('PROVIDER_REJECTED');
          if (
            (event.isFinal !== undefined &&
              typeof event.isFinal !== 'boolean') ||
            (event.is_final !== undefined &&
              typeof event.is_final !== 'boolean')
          )
            throw new FixedSpeechError('INVALID_FINAL_FLAG');
          if (
            event.isFinal !== undefined &&
            event.is_final !== undefined &&
            event.isFinal !== event.is_final
          )
            throw new FixedSpeechError('INVALID_FINAL_FLAG');
          const isFinal = event.isFinal === true || event.is_final === true;
          if (event.audio !== undefined && event.audio !== null) {
            if (textAt === undefined)
              throw new FixedSpeechError('AUDIO_BEFORE_TEXT');
            recordAudio(decodeAudio(event.audio), elapsed());
          } else if (!isFinal) {
            throw new FixedSpeechError('INVALID_EVENT');
          }
          if (isFinal) complete();
        } catch (error) {
          fail(
            error instanceof FixedSpeechError ? error.code : 'INVALID_MESSAGE',
          );
        }
      });
      socket.on('unexpected-response', (_request, response) => {
        response.destroy();
        fail('HANDSHAKE_REJECTED');
      });
      socket.on('error', () => fail('CONNECTION_FAILED'));
      socket.on('close', () => fail('CLOSED_BEFORE_FINAL'));
    } catch {
      fail('CONNECTION_FAILED');
    }
    if (options.signal?.aborted) fail('ABORTED');
  });
}

/** Local listening copy: decode PCMU without interpolation or silence trimming. */
export function fixedSpeechWave(pcmu: Buffer): Buffer {
  if (pcmu.length === 0 || pcmu.length > MAX_AUDIO_BYTES)
    throw new FixedSpeechError('INVALID_AUDIO_SIZE');
  const output = Buffer.alloc(44 + pcmu.length * 2);
  output.write('RIFF', 0);
  output.writeUInt32LE(output.length - 8, 4);
  output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(8000, 24);
  output.writeUInt32LE(16000, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36);
  output.writeUInt32LE(pcmu.length * 2, 40);
  pcmu.forEach((code, index) =>
    output.writeInt16LE(muLawToPcm16(code), 44 + index * 2),
  );
  return output;
}
