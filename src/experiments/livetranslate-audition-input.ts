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

export const LIVETRANSLATE_AUDITION_PARENT =
  'ffb3f7a2178c678177cb08641970c3215a310e6f';
export const LIVETRANSLATE_AUDITION_MODEL =
  'qwen3.8-livetranslate-flash-realtime';
export const LIVETRANSLATE_AUDITION_VOICE = 'Aiden';
export const LIVETRANSLATE_SINGLE_LOCAL_VOICE = 'Andre';
export const LIVETRANSLATE_AUDITION_SCOPE =
  'livetranslate-comparison-audition-v1';
export const LIVETRANSLATE_SINGLE_LOCAL_SCOPE =
  'livetranslate-single-local-andre-tina-conflict-audition-v1';
export const LIVETRANSLATE_SINGLE_LOCAL_PARENT =
  '29997d6bf545c6d6c28c3563f95b9a84c1ef3ea0';
export type LiveTranslateAuditionMode = 'dual' | 'single-local';
export const liveTranslateAuditionVoice = (
  mode: LiveTranslateAuditionMode = 'dual',
) => mode === 'single-local'
  ? LIVETRANSLATE_SINGLE_LOCAL_VOICE : LIVETRANSLATE_AUDITION_VOICE;
export const LIVETRANSLATE_AUDITION_LIMITS = Object.freeze({
  sessions: 2,
  sessionsPerRole: 1,
  inputSeconds: 24,
  acceptedResponses: 6,
  savedOutputSeconds: 36,
  totalTimeoutMs: 90000,
  automaticRetries: 0,
  automaticReconnects: 0,
  providerOutputTokenLimit: null,
  providerCancelSupported: false,
});
export const LIVETRANSLATE_SINGLE_LOCAL_LIMITS = Object.freeze({
  ...LIVETRANSLATE_AUDITION_LIMITS,
  sessions: 1,
});
export const liveTranslateAuditionLimits = (
  mode: LiveTranslateAuditionMode = 'dual',
) =>
  mode === 'single-local'
    ? LIVETRANSLATE_SINGLE_LOCAL_LIMITS
    : LIVETRANSLATE_AUDITION_LIMITS;
export type LiveTranslateAuditionClip = {
  id: string;
  role: 'local' | 'remote';
  pcm: Buffer;
  durationMs: number;
  speechEndMs?: number;
  sha256: string;
  wavPath: string;
};
export type PreparedLiveTranslateAuditionInput = {
  /** Omitted only by legacy trusted dual fixtures; parsed manifests always set it. */
  mode?: LiveTranslateAuditionMode;
  manifestPath: string;
  manifestSha256: string;
  workspaceId: string;
  spaceHost: string;
  clips: LiveTranslateAuditionClip[];
  totalSeconds: number;
};
function fail(code: string): never {
  throw new Error(`LIVETRANSLATE_AUDITION_INPUT_${code}`);
}
export const liveTranslateRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const liveTranslateExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));

/** Regular local files only. No credentials, networking, audio capture or conversion. */
export function readLiveTranslateAuditionFile(
  path: string,
  limit: number,
): Buffer {
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
      // eslint-disable-next-line no-bitwise -- Reject symlinks and FIFO-open stalls.
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
      /^LIVETRANSLATE_AUDITION_INPUT_[A-Z_]+$/u.test(error.message)
    )
      throw error;
    return fail('FILE_UNREADABLE');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
export function liveTranslateSpaceHost(workspaceId: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(workspaceId))
    fail('WORKSPACE_INVALID');
  return `${workspaceId}.cn-beijing.maas.aliyuncs.com`;
}
/** Accept only the officially configured PCM16 mono 16k; never resample silently. */
export function parseLiveTranslateAuditionWave(wav: Buffer): Buffer {
  if (
    wav.length < 44 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE' ||
    wav.readUInt32LE(4) + 8 !== wav.length
  )
    fail('WAV_INVALID');
  let offset = 12;
  let format = false;
  let pcm: Buffer | undefined;
  while (offset < wav.length) {
    if (offset + 8 > wav.length) fail('WAV_INVALID');
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > wav.length) fail('WAV_INVALID');
    if (id === 'fmt ') {
      if (format || size < 16) fail('WAV_INVALID');
      if (
        wav.readUInt16LE(start) !== 1 ||
        wav.readUInt16LE(start + 2) !== 1 ||
        wav.readUInt32LE(start + 4) !== 16000 ||
        wav.readUInt32LE(start + 8) !== 32000 ||
        wav.readUInt16LE(start + 12) !== 2 ||
        wav.readUInt16LE(start + 14) !== 16
      )
        fail('WAV_REQUIRES_PCM16_MONO_16K');
      format = true;
    } else if (id === 'data') {
      if (pcm || !size || size % 2) fail('WAV_INVALID');
      pcm = Buffer.from(wav.subarray(start, end));
    }
    offset = end + (size % 2);
    if (offset > wav.length) fail('WAV_INVALID');
  }
  if (!format || !pcm || offset !== wav.length) fail('WAV_INVALID');
  return pcm;
}
export function prepareLiveTranslateAuditionInput(
  path: string,
): PreparedLiveTranslateAuditionInput {
  const manifestPath = resolve(path);
  const bytes = readLiveTranslateAuditionFile(manifestPath, 32768);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('MANIFEST_INVALID');
  }
  if (
    !liveTranslateRecord(value) ||
    !(
      (value.version === 1 &&
        liveTranslateExactKeys(value, ['version', 'workspaceId', 'clips'])) ||
      (value.version === 2 &&
        value.mode === 'single-local' &&
        liveTranslateExactKeys(value, [
          'version',
          'mode',
          'workspaceId',
          'clips',
        ]))
    ) ||
    typeof value.workspaceId !== 'string' ||
    !Array.isArray(value.clips) ||
    value.clips.length !== (value.version === 2 ? 1 : 2)
  )
    fail('MANIFEST_INVALID');
  const spaceHost = liveTranslateSpaceHost(value.workspaceId);
  const directory = dirname(manifestPath);
  const ids = new Set<string>();
  const roles = new Set<string>();
  const hashes = new Set<string>();
  const clips: LiveTranslateAuditionClip[] = [];
  let totalSamples = 0;
  for (const clip of value.clips) {
    if (
      !liveTranslateRecord(clip) ||
      Object.keys(clip).some(
        (key) => !['id', 'role', 'wav', 'sha256', 'speechEndMs'].includes(key),
      ) ||
      typeof clip.id !== 'string' ||
      !/^[a-z][a-z0-9-]{0,47}$/u.test(clip.id) ||
      ids.has(clip.id) ||
      !['local', 'remote'].includes(clip.role as string) ||
      (value.version === 2 && clip.role !== 'local') ||
      roles.has(clip.role as string) ||
      typeof clip.wav !== 'string' ||
      !clip.wav ||
      isAbsolute(clip.wav) ||
      typeof clip.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(clip.sha256)
    )
      fail('CLIP_INVALID');
    const wavPath = resolve(directory, clip.wav);
    if (!wavPath.startsWith(directory + sep)) fail('PATH_OUTSIDE_MANIFEST');
    const wav = readLiveTranslateAuditionFile(wavPath, 800000);
    const sha256 = createHash('sha256').update(wav).digest('hex');
    if (sha256 !== clip.sha256) fail('HASH_MISMATCH');
    if (hashes.has(sha256)) fail('DUPLICATE_SAMPLE');
    const pcm = parseLiveTranslateAuditionWave(wav);
    const durationMs = pcm.length / 32;
    if (durationMs < 100) fail('SAMPLE_TOO_SHORT');
    totalSamples += pcm.length / 2;
    if (totalSamples > 24 * 16000) fail('INPUT_LIMIT_EXCEEDED');
    if (
      clip.speechEndMs !== undefined &&
      (typeof clip.speechEndMs !== 'number' ||
        !Number.isFinite(clip.speechEndMs) ||
        clip.speechEndMs < 0 ||
        clip.speechEndMs > durationMs)
    )
      fail('SPEECH_ENDPOINT_INVALID');
    clips.push({
      id: clip.id,
      role: clip.role as 'local' | 'remote',
      pcm,
      durationMs,
      sha256,
      wavPath,
      ...(clip.speechEndMs === undefined
        ? {}
        : { speechEndMs: clip.speechEndMs as number }),
    });
    ids.add(clip.id);
    roles.add(clip.role as string);
    hashes.add(sha256);
  }
  return {
    mode: value.version === 2 ? 'single-local' : 'dual',
    manifestPath,
    manifestSha256: createHash('sha256').update(bytes).digest('hex'),
    workspaceId: value.workspaceId,
    spaceHost,
    clips,
    totalSeconds: totalSamples / 16000,
  };
}
