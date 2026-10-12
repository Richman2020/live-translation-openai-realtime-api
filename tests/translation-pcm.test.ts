import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  muLawToPcm16,
  pcm16ToMuLaw,
  Pcm24kToPcmu,
  PcmuToPcm24k,
  TRANSLATION_PCM_FILTER_DELAY_MS,
} from '../src/solo/translation-pcm';

// Synthetic codec tests only: not translation accuracy or audible phone tests.
function pcm(samples: number[]): Buffer {
  const output = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => output.writeInt16LE(sample, index * 2));
  return output;
}

function signal(frequency: number, rate = 24000, seconds = 0.15): number[] {
  return Array.from({ length: Math.round(rate * seconds) }, (_, index) =>
    Math.round(12000 * Math.sin((2 * Math.PI * frequency * index) / rate)),
  );
}

function rms(samples: number[]): number {
  return Math.sqrt(
    samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length,
  );
}

function chunks(input: Buffer, sizes: number[]): Buffer[] {
  const result: Buffer[] = [];
  let offset = 0;
  let index = 0;
  while (offset < input.length) {
    const size = sizes[index % sizes.length];
    result.push(input.subarray(offset, offset + size));
    // Empty chunks exercise the real transport's harmless no-op behavior.
    result.push(Buffer.alloc(0));
    offset += size;
    index += 1;
  }
  return result;
}

test('G.711 known vectors, zero codes, saturation and every code roundtrip', () => {
  const vectors: [number, number][] = [
    [0xff, 0],
    [0x7f, 0],
    [0xfe, 8],
    [0x7e, -8],
    [0xef, 132],
    [0x6f, -132],
    [0x90, 15996],
    [0x10, -15996],
    [0x80, 32124],
    [0x00, -32124],
  ];
  for (const [code, value] of vectors) assert.equal(muLawToPcm16(code), value);
  for (let code = 0; code < 256; code += 1) {
    assert.equal(pcm16ToMuLaw(muLawToPcm16(code)), code === 0x7f ? 0xff : code);
  }
  assert.equal(pcm16ToMuLaw(32767), 0x80);
  assert.equal(pcm16ToMuLaw(-32768), 0x00);
  assert.equal(pcm16ToMuLaw(1e9), 0x80);
  assert.equal(pcm16ToMuLaw(-1e9), 0x00);
  assert.throws(() => pcm16ToMuLaw(NaN), RangeError);
});

test('PCMU upsampling is byte-identical across arbitrary chunk boundaries', () => {
  const input = Buffer.from(
    Array.from({ length: 977 }, (_, index) => (index * 37) % 256),
  );
  const expected = new PcmuToPcm24k().push(input);
  const converter = new PcmuToPcm24k();
  const actual = Buffer.concat(
    chunks(input, [1, 7, 160, 2, 31]).map((chunk) => converter.push(chunk)),
  );
  assert.deepEqual(actual, expected);
  assert.equal(actual.length, input.length * 6);
});

test('PCM downsampling retains split bytes and modulo-three sample boundaries', () => {
  const input = pcm(signal(973)).subarray(0, 7151);
  const expectedConverter = new Pcm24kToPcmu();
  const expected = expectedConverter.push(input);
  const converter = new Pcm24kToPcmu();
  const actual = Buffer.concat(
    chunks(input, [1, 1, 3, 2, 7, 160, 5]).map((chunk) =>
      converter.push(chunk),
    ),
  );
  assert.deepEqual(actual, expected);
  assert.equal(actual.length, Math.floor(input.length / 6));
  const continuation = Buffer.from([1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(
    converter.push(continuation),
    expectedConverter.push(continuation),
  );
});

test('silence and duration are preserved without per-chunk padding', () => {
  const up = new PcmuToPcm24k();
  const silence = up.push(Buffer.alloc(8000, 0xff));
  assert.equal(silence.length, 48000);
  assert.ok(silence.every((byte) => byte === 0));
  const down = new Pcm24kToPcmu();
  const phoneSilence = Buffer.concat(
    chunks(silence, [1, 11, 29, 333]).map((chunk) => down.push(chunk)),
  );
  assert.equal(phoneSilence.length, 8000);
  assert.ok(phoneSilence.every((byte) => byte === 0xff));
  assert.equal(new Pcm24kToPcmu().push(Buffer.alloc(5)).length, 0);
});

test('reset removes filter history, partial samples and resampling phase', () => {
  const up = new PcmuToPcm24k();
  up.push(Buffer.alloc(123, 0x80));
  up.reset();
  assert.deepEqual(
    up.push(Buffer.alloc(83, 0xff)),
    new PcmuToPcm24k().push(Buffer.alloc(83, 0xff)),
  );
  const down = new Pcm24kToPcmu();
  down.push(Buffer.alloc(107, 0x7f));
  down.reset();
  const input = pcm(signal(1273)).subarray(0, 229);
  assert.deepEqual(down.push(input), new Pcm24kToPcmu().push(input));
});

test('downsampling suppresses out-of-band aliases and preserves telephone passband', () => {
  const level = (frequency: number) => {
    const encoded = new Pcm24kToPcmu().push(pcm(signal(frequency)));
    return rms(
      Array.from(encoded.subarray(100), (sample) => muLawToPcm16(sample)),
    );
  };
  const passband = level(1000);
  assert.ok(passband > 8000 && passband < 9000, `1 kHz RMS = ${passband}`);
  const telephoneEdge = level(3300);
  assert.ok(telephoneEdge > passband * 0.95, `3.3 kHz RMS = ${telephoneEdge}`);
  for (const frequency of [4100, 5000, 7000, 11000]) {
    const alias = level(frequency);
    assert.ok(alias < passband * 0.005, `${frequency} Hz alias RMS = ${alias}`);
  }
});

test('upsampling preserves passband gain and suppresses sample repetition images', () => {
  const input = Buffer.from(
    signal(1000, 8000).map((sample) => pcm16ToMuLaw(sample)),
  );
  const converted = new PcmuToPcm24k().push(input);
  const samples = Array.from({ length: converted.length / 2 }, (_, index) =>
    converted.readInt16LE(index * 2),
  );
  const settled = samples.slice(240);
  const amplitude = (frequency: number) => {
    let real = 0;
    let imaginary = 0;
    settled.forEach((sample, index) => {
      const phase = (2 * Math.PI * frequency * index) / 24000;
      real += sample * Math.cos(phase);
      imaginary += sample * Math.sin(phase);
    });
    return (2 * Math.hypot(real, imaginary)) / settled.length;
  };
  assert.ok(amplitude(1000) > 11500 && amplitude(1000) < 12500);
  assert.ok(amplitude(7000) < amplitude(1000) * 0.005);
  assert.ok(amplitude(9000) < amplitude(1000) * 0.005);
  assert.equal(TRANSLATION_PCM_FILTER_DELAY_MS, 4);
});

test('full-scale transitions saturate PCM output instead of wrapping its sign', () => {
  const input = Buffer.concat([
    Buffer.alloc(160, 0xff),
    Buffer.alloc(320, 0x80),
  ]);
  const output = new PcmuToPcm24k().push(input);
  const settled = Array.from({ length: 120 }, (_, index) =>
    output.readInt16LE(output.length - 240 + index * 2),
  );
  assert.ok(settled.every((value) => value > 30000 && value <= 32767));
  // FIR overshoot is clipped, not converted via a wrapping Int16 assignment.
  const samples = Array.from({ length: output.length / 2 }, (_, index) =>
    output.readInt16LE(index * 2),
  );
  assert.ok(samples.includes(32767));
});
