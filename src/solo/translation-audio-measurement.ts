import { muLawToPcm16 } from './translation-pcm';

export type PcmuPlaybackDelta = { atMs: number; bytes: number };

export type PcmuPlaybackAnalysis = {
  firstEnergyAtMs: number | null;
  lastEnergyAtMs: number | null;
  activeDurationMs: number;
  totalAudioMs: number;
  scheduledEndMs: number | null;
  thresholdRms: 300;
  frameMs: 20;
};

const BYTES_PER_MS = 8;
const FRAME_MS = 20;
const FRAME_BYTES = FRAME_MS * BYTES_PER_MS;
const THRESHOLD_RMS = 300;

/**
 * Estimate energy timing on an ideal FIFO player: each complete delta becomes
 * available at atMs and plays at 8 kHz after earlier audio finishes. Retains all
 * silence and backlog; it never trims audio to improve the reported timing.
 *
 * Frames use joined audio within each uninterrupted playback interval, not
 * transport boundaries. FIFO underflow ends the current frame: no analysis
 * window may bridge a playback gap and assign later energy an earlier time.
 * Active duration counts frames with RMS >= 300, including shorter interval-end
 * frames; first/last times are approximate scheduled frame boundaries.
 * Energy can be noise or non-speech. This is neither semantic translation lag
 * nor measured Twilio delivery, sound-device playback, or human hearing time.
 */
export function analyzePcmuPlayback(
  pcmu: Buffer,
  deltas: PcmuPlaybackDelta[],
): PcmuPlaybackAnalysis {
  const intervals: {
    byteStart: number;
    byteEnd: number;
    startMs: number;
  }[] = [];
  let byteOffset = 0;
  let previousArrival = -Infinity;
  let scheduledEndMs: number | null = null;
  for (const delta of deltas) {
    if (
      !Number.isFinite(delta.atMs) ||
      delta.atMs < previousArrival ||
      !Number.isSafeInteger(delta.bytes) ||
      delta.bytes <= 0
    ) {
      throw new RangeError(
        'Playback deltas require ordered finite arrivals and positive integer byte counts',
      );
    }
    const startMs = Math.max(delta.atMs, scheduledEndMs ?? delta.atMs);
    const endMs = startMs + delta.bytes / BYTES_PER_MS;
    if (!Number.isFinite(endMs)) {
      throw new RangeError('Playback schedule exceeds finite time range');
    }
    if (scheduledEndMs === null || startMs > scheduledEndMs) {
      intervals.push({
        byteStart: byteOffset,
        byteEnd: byteOffset + delta.bytes,
        startMs,
      });
    } else {
      intervals[intervals.length - 1].byteEnd += delta.bytes;
    }
    byteOffset += delta.bytes;
    previousArrival = delta.atMs;
    scheduledEndMs = endMs;
  }
  if (byteOffset !== pcmu.length) {
    throw new RangeError(
      'Playback delta byte counts must exactly match PCM audio length',
    );
  }

  let firstEnergyAtMs: number | null = null;
  let lastEnergyAtMs: number | null = null;
  let activeBytes = 0;
  for (const interval of intervals) {
    for (
      let offset = interval.byteStart;
      offset < interval.byteEnd;
      offset += FRAME_BYTES
    ) {
      const end = Math.min(offset + FRAME_BYTES, interval.byteEnd);
      let squared = 0;
      for (let sampleOffset = offset; sampleOffset < end; sampleOffset += 1) {
        const sample = muLawToPcm16(pcmu[sampleOffset]);
        squared += sample * sample;
      }
      if (Math.sqrt(squared / (end - offset)) >= THRESHOLD_RMS) {
        firstEnergyAtMs ??=
          interval.startMs + (offset - interval.byteStart) / BYTES_PER_MS;
        lastEnergyAtMs =
          interval.startMs + (end - interval.byteStart) / BYTES_PER_MS;
        activeBytes += end - offset;
      }
    }
  }

  return {
    firstEnergyAtMs,
    lastEnergyAtMs,
    activeDurationMs: activeBytes / BYTES_PER_MS,
    totalAudioMs: pcmu.length / BYTES_PER_MS,
    scheduledEndMs,
    thresholdRms: THRESHOLD_RMS,
    frameMs: FRAME_MS,
  };
}
