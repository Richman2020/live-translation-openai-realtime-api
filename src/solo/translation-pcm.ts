/* eslint-disable no-bitwise -- G.711 and PCM16 byte packing require bit operations. */
/* eslint-disable max-classes-per-file -- Keep both stream directions with their private shared filter. */
/**
 * Experimental streaming bridge between Twilio PCMU (8 kHz, mono) and the
 * continuous translation endpoint's PCM16LE (24 kHz, mono).
 *
 * Both resamplers use a causal 193-tap Blackman-windowed sinc low-pass at
 * 3.6 kHz. Its group delay is 96 / 24000 = 4 ms in each direction. The filter
 * suppresses interpolation images / downsampling aliases; upsampling cannot
 * restore frequencies lost on a telephone line. μ-law itself is lossy.
 *
 * Keep one instance per independent audio stream, including between provider
 * chunks. push() neither pads nor flushes: input silence should continue through
 * the normal stream end so the filter tail is retained. For an explicit drain,
 * append at least 8 ms of silence (64 PCMU bytes of 0xff, or 384 zero PCM bytes),
 * which extends the stream by that duration. reset() explicitly discards the
 * tail, any incomplete sample, and resampling phase.
 */

const PCM_RATE = 24000;
const FACTOR = 3;
const FILTER_LENGTH = 193;
const FILTER_CUTOFF_HZ = 3600;
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

export const TRANSLATION_PCM_FILTER_DELAY_MS =
  (((FILTER_LENGTH - 1) / 2) * 1000) / PCM_RATE;

function clampPcm16(sample: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(sample)));
}

/** G.711 μ-law code -> signed linear PCM16 sample (including both zero codes). */
export function muLawToPcm16(code: number): number {
  const inverted = ~code & 0xff;
  const magnitude =
    (((inverted & 0x0f) << 3) + MULAW_BIAS) << ((inverted >> 4) & 0x07);
  return inverted & 0x80 ? MULAW_BIAS - magnitude : magnitude - MULAW_BIAS;
}

/** Signed linear PCM sample -> G.711 μ-law; saturates rather than wrapping. */
export function pcm16ToMuLaw(sample: number): number {
  if (!Number.isFinite(sample))
    throw new RangeError('PCM sample must be finite');
  const bounded = clampPcm16(sample);
  const sign = bounded < 0 ? 0x80 : 0;
  const magnitude = Math.min(Math.abs(bounded), MULAW_CLIP) + MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(magnitude & mask); mask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function createLowPass(): Float64Array {
  const coefficients = new Float64Array(FILTER_LENGTH);
  const center = (FILTER_LENGTH - 1) / 2;
  const cutoff = FILTER_CUTOFF_HZ / PCM_RATE;
  let sum = 0;
  for (let index = 0; index < FILTER_LENGTH; index += 1) {
    const offset = index - center;
    const sinc =
      offset === 0
        ? 2 * cutoff
        : Math.sin(2 * Math.PI * cutoff * offset) / (Math.PI * offset);
    const phase = (2 * Math.PI * index) / (FILTER_LENGTH - 1);
    const window = 0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase);
    coefficients[index] = sinc * window;
    sum += coefficients[index];
  }
  // Exact unity DC gain for decimation. Interpolation applies a gain of three.
  for (let index = 0; index < FILTER_LENGTH; index += 1) {
    coefficients[index] /= sum;
  }
  return coefficients;
}

const LOW_PASS = createLowPass();

class StreamingLowPass {
  private readonly history = new Float64Array(FILTER_LENGTH);

  private cursor = 0;

  append(sample: number): void {
    this.history[this.cursor] = sample;
    this.cursor = (this.cursor + 1) % FILTER_LENGTH;
  }

  value(): number {
    let result = 0;
    let index = this.cursor;
    for (let tap = 0; tap < FILTER_LENGTH; tap += 1) {
      index = index === 0 ? FILTER_LENGTH - 1 : index - 1;
      result += LOW_PASS[tap] * this.history[index];
    }
    return result;
  }

  reset(): void {
    this.history.fill(0);
    this.cursor = 0;
  }
}

export class PcmuToPcm24k {
  private readonly filter = new StreamingLowPass();

  /** Exactly six PCM bytes per incoming μ-law byte; state spans all chunks. */
  push(input: Buffer): Buffer {
    const output = Buffer.allocUnsafe(input.length * FACTOR * 2);
    let offset = 0;
    for (const code of input) {
      for (let phase = 0; phase < FACTOR; phase += 1) {
        this.filter.append(phase === 0 ? muLawToPcm16(code) : 0);
        output.writeInt16LE(clampPcm16(this.filter.value() * FACTOR), offset);
        offset += 2;
      }
    }
    return output;
  }

  reset(): void {
    this.filter.reset();
  }
}

export class Pcm24kToPcmu {
  private readonly filter = new StreamingLowPass();

  private pendingLowByte: number | undefined;

  private phase = 0;

  /**
   * One μ-law byte per three complete PCM16 samples. An odd last byte and any
   * remainder samples stay pending; a transport chunk is not an audio boundary.
   */
  push(input: Buffer): Buffer {
    const completeSamples = Math.floor(
      (input.length + (this.pendingLowByte === undefined ? 0 : 1)) / 2,
    );
    const output = Buffer.allocUnsafe(
      Math.floor((this.phase + completeSamples) / FACTOR),
    );
    let offset = 0;
    let outputOffset = 0;
    const append = (low: number, high: number): void => {
      const unsigned = low | (high << 8);
      this.filter.append(unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned);
      this.phase += 1;
      if (this.phase === FACTOR) {
        output[outputOffset] = pcm16ToMuLaw(this.filter.value());
        outputOffset += 1;
        this.phase = 0;
      }
    };

    if (this.pendingLowByte !== undefined && input.length > 0) {
      append(this.pendingLowByte, input[0]);
      this.pendingLowByte = undefined;
      offset = 1;
    }
    while (offset + 1 < input.length) {
      append(input[offset], input[offset + 1]);
      offset += 2;
    }
    if (offset < input.length) this.pendingLowByte = input[offset];
    return output;
  }

  reset(): void {
    this.filter.reset();
    this.pendingLowByte = undefined;
    this.phase = 0;
  }
}
