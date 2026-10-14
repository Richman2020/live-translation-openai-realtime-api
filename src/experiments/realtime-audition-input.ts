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

import {
  createRealtimePrototypeInput,
  type RealtimePrototypeInputEvent,
} from '../solo/realtime-prototype-input';

const SAMPLE_RATE = 24000;
const MAX_SAMPLES = SAMPLE_RATE * 24;
const MIN_SEGMENT_SAMPLES = SAMPLE_RATE / 10;
const MAX_WAVE_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_COMMITS = 6;

export type PreparedAuditionInput = {
  manifestPath: string;
  wavPath: string;
  wavSha256: string;
  /** Selected, ordered source PCM, excluding unselected gaps and WAV headers. */
  pcm: Buffer;
  sampleRate: 24000;
  segments: { id: string; sourceText: string; pcm: Buffer }[];
  totalSamples: number;
  totalSeconds: number;
  preflightCommits: number;
  /** Exact samples submitted by the same energy slicer used by the runner. */
  preflightSubmittedSamples: number;
  preflightCommitSamples: number[];
  preflightSources: {
    sequence: number;
    startSample: number;
    endSample: number;
    pcmBytes: number;
  }[];
};

function fail(code: string): never {
  throw new Error(`AUDITION_INPUT_${code}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !value.includes('\u0000')
  );
}

/** Reject symlinks even when their current target would stay inside the root. */
function checkPathComponents(path: string): void {
  const { root } = parse(path);
  let current = root;
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) fail('SYMLINK_FORBIDDEN');
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'AUDITION_INPUT_SYMLINK_FORBIDDEN'
      )
        throw error;
      fail('FILE_UNREADABLE');
    }
  }
}

function readRegularFile(path: string, limit: number): Buffer {
  checkPathComponents(path);
  let descriptor: number | undefined;
  try {
    if (!lstatSync(path).isFile()) fail('REGULAR_FILE_REQUIRED');
    descriptor = openSync(
      path,
      // eslint-disable-next-line no-bitwise -- POSIX flags avoid symlink following and FIFO-open stalls.
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(descriptor);
    if (!before.isFile()) fail('REGULAR_FILE_REQUIRED');
    if (before.size < 1 || before.size > limit) fail('FILE_SIZE');
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const current = lstatSync(path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      bytes.length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== current.ino ||
      before.dev !== current.dev
    )
      fail('FILE_CHANGED');
    checkPathComponents(path);
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('AUDITION_INPUT_'))
      throw error;
    return fail('FILE_UNREADABLE');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function wavePcm(bytes: Buffer): Buffer {
  if (
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  )
    fail('INVALID_WAVE');
  let format: Buffer | undefined;
  let pcm: Buffer | undefined;
  let offset = 12;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) fail('INVALID_WAVE_CHUNK');
    const name = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    const next = end + (length % 2);
    if (end > bytes.length || next > bytes.length) fail('INVALID_WAVE_CHUNK');
    if (name === 'fmt ') {
      if (format) fail('DUPLICATE_WAVE_CHUNK');
      format = bytes.subarray(start, end);
    } else if (name === 'data') {
      if (pcm) fail('DUPLICATE_WAVE_CHUNK');
      pcm = bytes.subarray(start, end);
    }
    offset = next;
  }
  if (
    !format ||
    !pcm ||
    ![16, 18].includes(format.length) ||
    (format.length === 18 && format.readUInt16LE(16) !== 0) ||
    format.readUInt16LE(0) !== 1 ||
    format.readUInt16LE(2) !== 1 ||
    format.readUInt32LE(4) !== SAMPLE_RATE ||
    format.readUInt32LE(8) !== SAMPLE_RATE * 2 ||
    format.readUInt16LE(12) !== 2 ||
    format.readUInt16LE(14) !== 16 ||
    pcm.length === 0 ||
    pcm.length % 2 !== 0
  )
    fail('PCM24K_MONO16LE_REQUIRED');
  if (pcm.length / 2 > MAX_SAMPLES) fail('SOURCE_EXCEEDS_24_SECONDS');
  return pcm;
}

/**
 * Read-only local preflight. No credential read, audio capture, network request,
 * transcoding, write, or model call occurs here. Consent fields are attestations
 * to be supplied by the user; they do not manufacture recording permission.
 */
export function prepareAuditionInput(
  suppliedManifestPath: string,
): PreparedAuditionInput {
  if (
    typeof suppliedManifestPath !== 'string' ||
    !suppliedManifestPath.trim() ||
    suppliedManifestPath.includes('\u0000')
  )
    fail('MANIFEST_PATH');
  const manifestPath = resolve(suppliedManifestPath);
  const manifestBytes = readRegularFile(manifestPath, MAX_MANIFEST_BYTES);
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    fail('INVALID_MANIFEST_JSON');
  }
  if (
    !record(manifest) ||
    !exactKeys(manifest, [
      'version',
      'sourceKind',
      'sourceDescription',
      'rightsConfirmed',
      'voiceConsentConfirmed',
      'containsRealCall',
      'file',
      'segments',
    ]) ||
    manifest.version !== 1 ||
    !['self-recorded-test', 'licensed-test'].includes(
      manifest.sourceKind as string,
    ) ||
    !text(manifest.sourceDescription, 2000) ||
    manifest.rightsConfirmed !== true ||
    manifest.voiceConsentConfirmed !== true ||
    manifest.containsRealCall !== false
  )
    fail('MANIFEST_OR_CONSENT');
  if (
    !record(manifest.file) ||
    !exactKeys(manifest.file, ['path', 'sha256']) ||
    !text(manifest.file.path, 1000) ||
    !text(manifest.file.sha256, 64) ||
    !/^[a-f0-9]{64}$/.test(manifest.file.sha256)
  )
    fail('FILE_MANIFEST');
  const relativePath = manifest.file.path;
  if (
    isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.includes(':') ||
    relativePath.split('/').some((part) => ['', '.', '..'].includes(part)) ||
    !relativePath.toLowerCase().endsWith('.wav')
  )
    fail('RELATIVE_WAVE_PATH_REQUIRED');
  const wavPath = resolve(dirname(manifestPath), relativePath);
  const wave = readRegularFile(wavPath, MAX_WAVE_BYTES);
  const wavSha256 = createHash('sha256').update(wave).digest('hex');
  if (wavSha256 !== manifest.file.sha256) fail('SHA256_MISMATCH');
  const source = wavePcm(wave);
  if (
    !Array.isArray(manifest.segments) ||
    manifest.segments.length < 1 ||
    manifest.segments.length > MAX_COMMITS
  )
    fail('SEGMENTS_REQUIRED_MAX_6');
  const ids = new Set<string>();
  let previousEnd = 0;
  const segments = manifest.segments.map((item: unknown) => {
    if (
      !record(item) ||
      !exactKeys(item, ['id', 'startSample', 'endSample', 'sourceText']) ||
      typeof item.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(item.id) ||
      ids.has(item.id) ||
      !Number.isSafeInteger(item.startSample) ||
      !Number.isSafeInteger(item.endSample) ||
      typeof item.startSample !== 'number' ||
      typeof item.endSample !== 'number' ||
      item.startSample < previousEnd ||
      item.endSample > source.length / 2 ||
      item.endSample - item.startSample < MIN_SEGMENT_SAMPLES ||
      !text(item.sourceText, 1000)
    )
      fail('INVALID_OR_UNORDERED_SEGMENT');
    ids.add(item.id);
    previousEnd = item.endSample;
    return {
      id: item.id,
      sourceText: item.sourceText,
      pcm: Buffer.from(
        source.subarray(item.startSample * 2, item.endSample * 2),
      ),
    };
  });
  const pcm = Buffer.concat(segments.map((segment) => segment.pcm));
  const totalSamples = pcm.length / 2;
  if (totalSamples < MIN_SEGMENT_SAMPLES || totalSamples > MAX_SAMPLES)
    fail('SELECTED_DURATION');
  const slicer = createRealtimePrototypeInput();
  const events: RealtimePrototypeInputEvent[] = [];
  for (let offset = 0; offset < pcm.length; offset += 480)
    events.push(...slicer.append(pcm.subarray(offset, offset + 480)));
  events.push(...slicer.flush());
  const preflightSources = events.flatMap((event) =>
    event.type === 'commit'
      ? [
          {
            sequence: event.sourceSequence,
            startSample: Math.round((event.startAtMs * SAMPLE_RATE) / 1000),
            endSample: Math.round((event.endAtMs * SAMPLE_RATE) / 1000),
            pcmBytes: Math.round((event.inputMs * SAMPLE_RATE) / 1000) * 2,
          },
        ]
      : [],
  );
  const preflightCommitSamples = preflightSources.map(
    (event) => event.pcmBytes / 2,
  );
  if (!preflightCommitSamples.length) fail('NO_SUBMITTABLE_AUDIO');
  if (preflightCommitSamples.length > MAX_COMMITS) fail('MORE_THAN_6_COMMITS');
  return {
    manifestPath,
    wavPath,
    wavSha256,
    pcm,
    sampleRate: SAMPLE_RATE,
    segments,
    totalSamples,
    totalSeconds: totalSamples / SAMPLE_RATE,
    preflightCommits: preflightCommitSamples.length,
    preflightSubmittedSamples: preflightCommitSamples.reduce(
      (sum, samples) => sum + samples,
      0,
    ),
    preflightCommitSamples,
    preflightSources,
  };
}
