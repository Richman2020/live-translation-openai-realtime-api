import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

import type { AliyunPlanBRegion } from '../solo/aliyun-planb-types';

export const ALIYUN_AUDITION_LIMITS = Object.freeze({
  clips: 4,
  inputSeconds: 24,
  asrTasks: 4,
  translationRequests: 8,
  ttsTasks: 4,
  ttsCharacters: 2000,
  outputSeconds: 36,
  translationMaxTokens: 2048,
  totalTimeoutMs: 90000,
});

export type AliyunAuditionClip = {
  id: string;
  role: 'local' | 'remote';
  pcm: Buffer;
  durationMs: number;
  /** Manually marked final speech endpoint, not a claim derived from silence. */
  speechEndMs?: number;
  sha256: string;
  wavPath: string;
};

export type PreparedAliyunAuditionInput = {
  manifestPath: string;
  region: AliyunPlanBRegion;
  clips: AliyunAuditionClip[];
  totalSeconds: number;
  manifestSha256: string;
};

function fail(code: string): never {
  throw new Error(`ALIYUN_AUDITION_INPUT_${code}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Shared by the CLI for regular approval files; never follows symlinks/FIFOs. */
export function readAliyunAuditionFile(path: string, limit: number): Buffer {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  let current = root;
  let descriptor: number | undefined;
  try {
    for (const component of absolute
      .slice(root.length)
      .split(sep)
      .filter(Boolean)) {
      current = join(current, component);
      if (lstatSync(current).isSymbolicLink()) fail('SYMLINK_FORBIDDEN');
    }
    if (!lstatSync(absolute).isFile()) fail('REGULAR_FILE_REQUIRED');
    descriptor = openSync(
      absolute,
      // eslint-disable-next-line no-bitwise -- Reject symlinks and avoid FIFO-open stalls.
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(descriptor);
    if (!before.isFile()) fail('REGULAR_FILE_REQUIRED');
    if (before.size < 1 || before.size > limit) fail('FILE_SIZE_INVALID');
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      bytes.length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      fail('FILE_CHANGED');
    return bytes;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('ALIYUN_AUDITION_INPUT_')
    )
      throw error;
    return fail('FILE_UNREADABLE');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Local PCM parser only. No ASR, resampling, microphone or provider access. */
export function parseAliyunAuditionWave(wav: Buffer): Buffer {
  if (
    wav.length < 44 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE' ||
    wav.readUInt32LE(4) + 8 !== wav.length
  )
    fail('WAV_INVALID');
  let offset = 12;
  let formatFound = false;
  let pcm: Buffer | undefined;
  while (offset < wav.length) {
    if (offset + 8 > wav.length) fail('WAV_INVALID');
    const id = wav.toString('ascii', offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > wav.length) fail('WAV_INVALID');
    if (id === 'fmt ') {
      if (formatFound || length < 16) fail('WAV_INVALID');
      if (
        wav.readUInt16LE(start) !== 1 ||
        wav.readUInt16LE(start + 2) !== 1 ||
        wav.readUInt32LE(start + 4) !== 24000 ||
        wav.readUInt32LE(start + 8) !== 48000 ||
        wav.readUInt16LE(start + 12) !== 2 ||
        wav.readUInt16LE(start + 14) !== 16
      )
        fail('WAV_REQUIRES_PCM16_MONO_24K');
      formatFound = true;
    } else if (id === 'data') {
      if (pcm || !length || length % 2) fail('WAV_INVALID');
      pcm = Buffer.from(wav.subarray(start, end));
    }
    offset = end + (length % 2);
    if (offset > wav.length) fail('WAV_INVALID');
  }
  if (!formatFound || !pcm || offset !== wav.length) fail('WAV_INVALID');
  return pcm;
}

export function prepareAliyunAuditionInput(
  manifestPath: string,
): PreparedAliyunAuditionInput {
  const absolute = resolve(manifestPath);
  const bytes = readAliyunAuditionFile(absolute, 32 * 1024);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('MANIFEST_INVALID');
  }
  if (
    !record(value) ||
    Object.keys(value).sort().join(',') !== 'clips,region,version' ||
    value.version !== 1 ||
    !['beijing', 'singapore'].includes(value.region as string) ||
    !Array.isArray(value.clips) ||
    value.clips.length < 2 ||
    value.clips.length > ALIYUN_AUDITION_LIMITS.clips
  )
    fail('MANIFEST_INVALID');
  const root = dirname(absolute);
  const ids = new Set<string>();
  const samples = new Set<string>();
  const clips: AliyunAuditionClip[] = [];
  let totalSamples = 0;
  for (const clip of value.clips) {
    if (
      !record(clip) ||
      Object.keys(clip).some(
        (key) => !['id', 'role', 'wav', 'sha256', 'speechEndMs'].includes(key),
      ) ||
      typeof clip.id !== 'string' ||
      !/^[a-z][a-z0-9-]{0,47}$/u.test(clip.id) ||
      ids.has(clip.id) ||
      !['local', 'remote'].includes(clip.role as string) ||
      typeof clip.wav !== 'string' ||
      !clip.wav ||
      isAbsolute(clip.wav) ||
      typeof clip.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(clip.sha256)
    )
      fail('CLIP_INVALID');
    const wavPath = resolve(root, clip.wav);
    if (!wavPath.startsWith(root + sep)) fail('PATH_OUTSIDE_MANIFEST');
    const wav = readAliyunAuditionFile(wavPath, 2 * 1024 * 1024);
    const sha256 = createHash('sha256').update(wav).digest('hex');
    if (sha256 !== clip.sha256) fail('HASH_MISMATCH');
    if (samples.has(sha256)) fail('DUPLICATE_SAMPLE');
    const pcm = parseAliyunAuditionWave(wav);
    const durationMs = (pcm.length / 48000) * 1000;
    if (durationMs < 100) fail('SAMPLE_TOO_SHORT');
    totalSamples += pcm.length / 2;
    if (totalSamples > ALIYUN_AUDITION_LIMITS.inputSeconds * 24000)
      fail('INPUT_LIMIT_EXCEEDED');
    if (
      clip.speechEndMs !== undefined &&
      (typeof clip.speechEndMs !== 'number' ||
        !Number.isFinite(clip.speechEndMs) ||
        clip.speechEndMs < 0 ||
        clip.speechEndMs > durationMs)
    )
      fail('SPEECH_ENDPOINT_INVALID');
    ids.add(clip.id);
    samples.add(sha256);
    clips.push({
      id: clip.id,
      role: clip.role as 'local' | 'remote',
      pcm,
      durationMs,
      ...(clip.speechEndMs === undefined
        ? {}
        : { speechEndMs: clip.speechEndMs as number }),
      sha256,
      wavPath,
    });
  }
  if (!clips.some((clip) => clip.role === 'local'))
    fail('CHINESE_SAMPLE_MISSING');
  if (!clips.some((clip) => clip.role === 'remote'))
    fail('ENGLISH_SAMPLE_MISSING');
  return {
    manifestPath: absolute,
    region: value.region as AliyunPlanBRegion,
    clips,
    totalSeconds: totalSamples / 24000,
    manifestSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
