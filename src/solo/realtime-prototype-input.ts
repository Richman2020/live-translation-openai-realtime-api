import { Buffer } from 'node:buffer';

export const REALTIME_PROTOTYPE_INPUT_SAMPLE_RATE = 24000;

export type RealtimePrototypeInputOptions = {
  epoch?: number;
  /** This prototype accepts PCM24k, signed little-endian 16-bit mono only. */
  sampleRate?: number;
  maxWindowMs?: number;
  minSpeechMs?: number;
  pauseMs?: number;
  minBufferMs?: number;
  preRollMs?: number;
  /** RMS in signed PCM16 amplitude units; energy is not semantic speech VAD. */
  energyThreshold?: number;
  /** Per append message bound, never a limit on total call samples. */
  maxAppendBytes?: number;
};

export type RealtimePrototypeInputEvent =
  | {
      type: 'append';
      epoch: number;
      sourceSequence: number;
      pcm: Buffer;
      startAtMs: number;
      endAtMs: number;
    }
  | {
      type: 'commit';
      epoch: number;
      sourceSequence: number;
      startAtMs: number;
      endAtMs: number;
      inputMs: number;
      speechMs: number;
      reason: 'pause' | 'window' | 'flush';
    };

type Frame = { pcm: Buffer; startSample: number; samples: number };
type Segment = {
  startSample: number;
  samples: number;
  speechSamples: number;
  quietSamples: number;
  emittedSamples: number;
  held: Buffer[];
};
type Emission = {
  events: RealtimePrototypeInputEvent[];
  parts: Buffer[];
  startSample?: number;
  endSample?: number;
};

const FRAME_MS = 10;
const FRAME_SAMPLES = 240;
const FRAME_BYTES = FRAME_SAMPLES * 2;
const MAX_APPEND_BYTES = 1024 * 1024;

function samplesToMs(samples: number): number {
  return (samples * 1000) / REALTIME_PROTOTYPE_INPUT_SAMPLE_RATE;
}

function durationSamples(value: number, min: number, max: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max ||
    value % FRAME_MS !== 0
  )
    throw new RangeError('Invalid realtime prototype input duration');
  return (value * REALTIME_PROTOTYPE_INPUT_SAMPLE_RATE) / 1000;
}

/**
 * Pure in-memory, sample-clocked input for manual Realtime commits. This is an
 * energy window, not ASR or word-boundary detection: a four-second continuous
 * window may split a word, and low-energy speech or energetic noise can be
 * misclassified. Actual intelligibility and latency still require real audio.
 *
 * Idle silence retains at most preRollMs locally and never grows the provider
 * buffer. Each retained source sample is appended once, without overlap or
 * padding. This prototype's 100ms ordinary-buffer threshold is an engineering
 * choice, not a documented provider constraint or latency guarantee. Normal
 * flush preserves every complete sample of an active source tail, even below
 * that threshold. An incomplete final PCM byte is a fixed INVALID_PCM_TAIL
 * fault; the owner must terminate the provider session, without padding/replay.
 *
 * append returns ordered events, invoking no callbacks. Consumers must check
 * their active state and epoch before each send. abort makes this epoch inert;
 * the owner must close/clear its provider buffer. reset starts a higher epoch
 * without replay. flush is terminal and idempotent until reset.
 */
export class RealtimePrototypeInput {
  private currentEpoch: number;

  private readonly maxWindowSamples: number;

  private readonly minSpeechSamples: number;

  private readonly pauseSamples: number;

  private readonly minBufferSamples: number;

  private readonly preRollSamples: number;

  private readonly energyThresholdSquared: number;

  private readonly maxAppendBytes: number;

  private readonly frame = Buffer.alloc(FRAME_BYTES);

  private frameBytes = 0;

  private consumedSamples = 0;

  private sourceSequence = 0;

  private idle: Frame[] = [];

  private idleSamples = 0;

  private segment?: Segment;

  private stopped = false;

  constructor(options: RealtimePrototypeInputOptions = {}) {
    const epoch = options.epoch ?? 1;
    if (!Number.isSafeInteger(epoch) || epoch < 1)
      throw new RangeError('Invalid realtime prototype input epoch');
    if (
      options.sampleRate !== undefined &&
      options.sampleRate !== REALTIME_PROTOTYPE_INPUT_SAMPLE_RATE
    )
      throw new RangeError('Realtime prototype input requires PCM24k mono');
    this.currentEpoch = epoch;
    const maxWindowMs = options.maxWindowMs ?? 4000;
    this.maxWindowSamples = durationSamples(maxWindowMs, 100, 4000);
    this.minBufferSamples = durationSamples(
      options.minBufferMs ?? 100,
      100,
      maxWindowMs,
    );
    this.minSpeechSamples = durationSamples(
      options.minSpeechMs ?? Math.min(600, maxWindowMs),
      10,
      maxWindowMs,
    );
    this.pauseSamples = durationSamples(
      options.pauseMs ?? Math.min(600, maxWindowMs),
      10,
      maxWindowMs,
    );
    this.preRollSamples = durationSamples(
      options.preRollMs ?? Math.min(100, maxWindowMs - 10),
      0,
      Math.min(200, maxWindowMs - 10),
    );
    const energyThreshold = options.energyThreshold ?? 500;
    if (
      !Number.isFinite(energyThreshold) ||
      energyThreshold <= 0 ||
      energyThreshold > 32768
    )
      throw new RangeError('Invalid realtime prototype input energy threshold');
    this.energyThresholdSquared = energyThreshold * energyThreshold;
    const maxAppendBytes = options.maxAppendBytes ?? MAX_APPEND_BYTES;
    if (
      !Number.isSafeInteger(maxAppendBytes) ||
      maxAppendBytes < 2 ||
      maxAppendBytes > MAX_APPEND_BYTES
    )
      throw new RangeError('Invalid realtime prototype input message bound');
    this.maxAppendBytes = maxAppendBytes;
  }

  get epoch(): number {
    return this.currentEpoch;
  }

  append(pcm: Buffer): RealtimePrototypeInputEvent[] {
    if (this.stopped) return [];
    if (!Buffer.isBuffer(pcm))
      throw new TypeError('Realtime prototype input requires PCM bytes');
    if (pcm.length > this.maxAppendBytes)
      throw new RangeError('Realtime prototype input message too large');
    const output: Emission = { events: [], parts: [] };
    for (let offset = 0; offset < pcm.length; ) {
      const length = Math.min(
        FRAME_BYTES - this.frameBytes,
        pcm.length - offset,
      );
      pcm.copy(this.frame, this.frameBytes, offset, offset + length);
      this.frameBytes += length;
      offset += length;
      if (this.frameBytes === FRAME_BYTES) {
        this.consumeFrame(this.frame, output);
        this.frameBytes = 0;
      }
    }
    this.emitAppend(output);
    return output.events;
  }

  flush(): RealtimePrototypeInputEvent[] {
    if (this.stopped) return [];
    if (this.frameBytes % 2 !== 0) {
      this.abort();
      throw new Error('INVALID_PCM_TAIL');
    }
    const output: Emission = { events: [], parts: [] };
    if (this.frameBytes)
      this.consumeFrame(this.frame.subarray(0, this.frameBytes), output);
    this.frameBytes = 0;
    this.frame.fill(0);
    if (this.segment) this.commit('flush', output);
    this.emitAppend(output);
    this.idle = [];
    this.idleSamples = 0;
    this.stopped = true;
    return output.events;
  }

  /** Does not count the bounded, never-appended idle pre-roll as dirty. */
  hasPending(): boolean {
    return !!this.segment || this.frameBytes > 0;
  }

  abort(): void {
    this.segment = undefined;
    this.idle = [];
    this.idleSamples = 0;
    this.frameBytes = 0;
    this.frame.fill(0);
    this.stopped = true;
  }

  reset(epoch = this.currentEpoch + 1): number {
    if (!Number.isSafeInteger(epoch) || epoch <= this.currentEpoch)
      throw new RangeError('Realtime prototype input epoch must increase');
    this.abort();
    this.currentEpoch = epoch;
    this.consumedSamples = 0;
    this.sourceSequence = 0;
    this.stopped = false;
    return this.currentEpoch;
  }

  private consumeFrame(pcm: Buffer, output: Emission): void {
    const samples = pcm.length / 2;
    const startSample = this.consumedSamples;
    this.consumedSamples += samples;
    let sumSquares = 0;
    for (let index = 0; index < samples; index += 1) {
      const value = pcm.readInt16LE(index * 2);
      sumSquares += value * value;
    }
    const voiced = sumSquares >= this.energyThresholdSquared * samples;
    const copy = Buffer.from(pcm);
    if (!this.segment) {
      if (!voiced) {
        this.rememberIdle({ pcm: copy, startSample, samples });
        return;
      }
      this.segment = {
        startSample: this.idle[0]?.startSample ?? startSample,
        samples: this.idleSamples + samples,
        speechSamples: samples,
        quietSamples: 0,
        emittedSamples: 0,
        held: [...this.idle.map((frame) => frame.pcm), copy],
      };
      this.idle = [];
      this.idleSamples = 0;
    } else {
      this.segment.samples += samples;
      this.segment.speechSamples += voiced ? samples : 0;
      this.segment.quietSamples = voiced
        ? 0
        : this.segment.quietSamples + samples;
      this.segment.held.push(copy);
    }
    const { segment } = this;
    if (segment.samples >= this.minBufferSamples)
      this.emitHeld(segment, output);
    if (segment.samples >= this.maxWindowSamples) this.commit('window', output);
    else if (
      segment.samples >= this.minBufferSamples &&
      segment.quietSamples >= this.pauseSamples &&
      segment.speechSamples >= this.minSpeechSamples
    )
      this.commit('pause', output);
  }

  private rememberIdle(frame: Frame): void {
    if (!this.preRollSamples) return;
    this.idle.push(frame);
    this.idleSamples += frame.samples;
    while (this.idleSamples > this.preRollSamples) {
      const oldest = this.idle[0];
      const remove = Math.min(
        oldest.samples,
        this.idleSamples - this.preRollSamples,
      );
      this.idleSamples -= remove;
      if (remove === oldest.samples) this.idle.shift();
      else {
        oldest.pcm = oldest.pcm.subarray(remove * 2);
        oldest.samples -= remove;
        oldest.startSample += remove;
      }
    }
  }

  private emitAppend(output: Emission): void {
    if (!output.parts.length) return;
    output.events.push({
      type: 'append',
      epoch: this.currentEpoch,
      sourceSequence: this.sourceSequence + 1,
      pcm: Buffer.concat(output.parts),
      startAtMs: samplesToMs(output.startSample),
      endAtMs: samplesToMs(output.endSample),
    });
    output.parts = [];
    output.startSample = undefined;
    output.endSample = undefined;
  }

  private emitHeld(segment: Segment, output: Emission): void {
    if (!segment.held.length) return;
    const appended = segment.samples - segment.emittedSamples;
    if (output.startSample === undefined)
      output.startSample = segment.startSample + segment.emittedSamples;
    output.endSample = segment.startSample + segment.samples;
    output.parts.push(...segment.held);
    segment.held = [];
    segment.emittedSamples += appended;
  }

  private commit(reason: 'pause' | 'window' | 'flush', output: Emission): void {
    const { segment } = this;
    if (!segment) return;
    if (reason === 'flush') this.emitHeld(segment, output);
    this.emitAppend(output);
    if (
      (segment.samples >= this.minBufferSamples || reason === 'flush') &&
      segment.speechSamples > 0
    ) {
      this.sourceSequence += 1;
      output.events.push({
        type: 'commit',
        epoch: this.currentEpoch,
        sourceSequence: this.sourceSequence,
        startAtMs: samplesToMs(segment.startSample),
        endAtMs: samplesToMs(segment.startSample + segment.samples),
        inputMs: samplesToMs(segment.samples),
        speechMs: samplesToMs(segment.speechSamples),
        reason,
      });
    }
    this.segment = undefined;
  }
}

export function createRealtimePrototypeInput(
  options: RealtimePrototypeInputOptions = {},
): RealtimePrototypeInput {
  return new RealtimePrototypeInput(options);
}
