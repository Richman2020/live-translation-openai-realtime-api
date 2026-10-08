import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NANO_POSTPROCESS_PROFILE = Object.freeze({
  name: 'b-092-gain3' as const,
  sampleRate: 24000 as const,
  tempo: 0.92 as const,
  requestedGainDb: 3 as const,
  peakCeiling: 0.85 as const,
  paddingMs: 250 as const,
  tailGuardMs: 20 as const,
  maxInputMs: 20000 as const,
  maxOutputMs: 22000 as const,
  ffmpegSha256:
    '2ce797a0f88d7f067180338fb227f7b1928ea727bd9a4d7a1d022f7c52af71a3',
});

export type NanoPostprocessMetrics = {
  profile: typeof NANO_POSTPROCESS_PROFILE.name;
  tempo: 0.92;
  inputAudioMs: number;
  outputAudioMs: number;
  processMs: number;
  retainedSyntheticTailMs: number;
  removedExactZeroSamples: number;
  requestedGainDb: 3;
  gainDbApplied: number;
  inputPeak: number;
  tempoPeak: number;
  outputPeak: number;
  inputClipCount: number;
  tempoClipCount: number;
  clipCount: number;
  inputPcmSha256: string;
  tempoPcmSha256: string;
  outputPcmSha256: string;
};

export type NanoPostprocessAudio = {
  pcm: Buffer;
  metrics: NanoPostprocessMetrics;
};
export type NanoVoicePostprocessor = {
  ready: Promise<void>;
  process(pcm: Buffer, signal?: AbortSignal): Promise<NanoPostprocessAudio>;
  close(): void;
};
export type NanoPostprocessSpawner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;
export type NanoVoicePostprocessOptions = {
  repoRoot?: string;
  /** Test seams, never configured through environment or HTTP input. */
  spawnProcess?: NanoPostprocessSpawner;
  hashBinary?: (absolutePath: string) => Promise<string>;
  requestTimeoutMs?: number;
};

const PROFILE = NANO_POSTPROCESS_PROFILE;
const MAX_INPUT_BYTES = (PROFILE.maxInputMs * PROFILE.sampleRate * 2) / 1000;
// Allow the temporary protective padding, then apply the stricter retained bound.
const MAX_OUTPUT_BYTES = (22500 * PROFILE.sampleRate * 2) / 1000;
const PADDING_SAMPLES = (PROFILE.paddingMs * PROFILE.sampleRate) / 1000;
const TAIL_GUARD_SAMPLES = (PROFILE.tailGuardMs * PROFILE.sampleRate) / 1000;
const MAX_STDERR_BYTES = 16384;

function failure(code: string): Error {
  const error = new Error(`NANO_POSTPROCESS_${code}`);
  if (code === 'ABORTED') error.name = 'AbortError';
  return error;
}

function pcmStats(pcm: Buffer): { peak: number; clipCount: number } {
  let peak = 0;
  let clipCount = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    peak = Math.max(peak, Math.abs(sample));
    if (sample === 32767 || sample === -32768) clipCount += 1;
  }
  return { peak, clipCount };
}

function sha256(pcm: Buffer): string {
  return createHash('sha256').update(pcm).digest('hex');
}

async function hashLocalBinary(absolutePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(absolutePath)) hash.update(bytes);
  return hash.digest('hex');
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']);
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => allowed.has(key.toUpperCase()) && value !== undefined,
    ),
  );
}

/** Only exact-zero padding is removed. Quiet speech, watermark and nonzero tails are retained. */
function finishPcm(
  input: Buffer,
  tempoPcm: Buffer,
  startedAt: number,
): NanoPostprocessAudio {
  const minimumSamples = Math.ceil(input.length / 2 / PROFILE.tempo);
  const outputSamples = tempoPcm.length / 2;
  if (!tempoPcm.length || tempoPcm.length % 2 || outputSamples < minimumSamples)
    throw failure('OUTPUT_INVALID');
  let lastNonzero = outputSamples - 1;
  while (lastNonzero >= 0 && tempoPcm.readInt16LE(lastNonzero * 2) === 0)
    lastNonzero -= 1;
  const maximumTrim = Math.ceil(PADDING_SAMPLES / PROFILE.tempo);
  const retainedSamples = Math.min(
    outputSamples,
    Math.max(
      minimumSamples,
      outputSamples - maximumTrim,
      lastNonzero + 1 + TAIL_GUARD_SAMPLES,
    ),
  );
  const retained = tempoPcm.subarray(0, retainedSamples * 2);
  if (retained.length / 48 > PROFILE.maxOutputMs)
    throw failure('OUTPUT_INVALID');
  const inputStats = pcmStats(input);
  const tempoStats = pcmStats(retained);
  const ceiling = Math.floor(PROFILE.peakCeiling * 32768);
  const gain = Math.min(
    10 ** (PROFILE.requestedGainDb / 20),
    tempoStats.peak ? ceiling / tempoStats.peak : Number.POSITIVE_INFINITY,
  );
  const output = Buffer.allocUnsafe(retained.length);
  for (let offset = 0; offset < retained.length; offset += 2)
    output.writeInt16LE(
      Math.round(retained.readInt16LE(offset) * gain),
      offset,
    );
  const outputStats = pcmStats(output);
  return {
    pcm: output,
    metrics: {
      profile: PROFILE.name,
      tempo: PROFILE.tempo,
      inputAudioMs: input.length / 48,
      outputAudioMs: output.length / 48,
      processMs: performance.now() - startedAt,
      // This is the retained duration beyond the expected tempo-adjusted original,
      // not an assertion that every retained sample is synthetic silence.
      retainedSyntheticTailMs:
        (1000 * Math.max(0, retainedSamples - minimumSamples)) /
        PROFILE.sampleRate,
      removedExactZeroSamples: outputSamples - retainedSamples,
      requestedGainDb: PROFILE.requestedGainDb,
      gainDbApplied: 20 * Math.log10(gain),
      inputPeak: inputStats.peak / 32768,
      tempoPeak: tempoStats.peak / 32768,
      outputPeak: outputStats.peak / 32768,
      inputClipCount: inputStats.clipCount,
      tempoClipCount: tempoStats.clipCount,
      clipCount: outputStats.clipCount,
      inputPcmSha256: sha256(input),
      tempoPcmSha256: sha256(tempoPcm),
      outputPcmSha256: sha256(output),
    },
  };
}

/** Sentence B output: pitch-preserving tempo + uniform bounded gain, without denoising. */
export function createNanoVoicePostprocessor(
  options: NanoVoicePostprocessOptions = {},
): NanoVoicePostprocessor {
  const repoRoot =
    options.repoRoot ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const executable = path.resolve(
    repoRoot,
    '.runtime/voice-clarity-tools/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe',
  );
  const spawnProcess = options.spawnProcess ?? spawn;
  const timeoutMs = options.requestTimeoutMs ?? 5000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    throw failure('TIMEOUT_CONFIG_INVALID');
  let closed = false;
  let reserved = false;
  let cancelActive: (() => void) | undefined;
  let cancelWaiting: (() => void) | undefined;
  let ownedChild: ChildProcessWithoutNullStreams | undefined;

  function run(
    input: Buffer,
    signal?: AbortSignal,
  ): Promise<NanoPostprocessAudio> {
    if (closed || signal?.aborted) return Promise.reject(failure('ABORTED'));
    if (ownedChild) return Promise.reject(failure('BUSY'));
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      let settled = false;
      let received = 0;
      let stderrBytes = 0;
      const chunks: Buffer[] = [];
      let timer: NodeJS.Timeout;
      let onAbort: () => void;
      const finish = (error?: Error, pcm?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        cancelActive = undefined;
        if (error) {
          // This instance owns only this exact child. Do not kill by executable name.
          try {
            child?.kill();
          } catch {
            /* Process may already have exited. */
          }
          chunks.length = 0;
          reject(error);
        } else {
          try {
            resolve(finishPcm(input, pcm, startedAt));
          } catch {
            reject(failure('OUTPUT_INVALID'));
          }
        }
      };
      onAbort = () => finish(failure('ABORTED'));
      try {
        child = spawnProcess(
          executable,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-threads',
            '1',
            '-f',
            's16le',
            '-ar',
            '24000',
            '-ac',
            '1',
            '-i',
            'pipe:0',
            '-af',
            'atempo=0.92',
            '-ar',
            '24000',
            '-ac',
            '1',
            '-f',
            's16le',
            '-c:a',
            'pcm_s16le',
            'pipe:1',
          ],
          {
            windowsHide: true,
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: safeEnvironment(),
          },
        );
      } catch {
        finish(failure('SPAWN_FAILED'));
        return;
      }
      ownedChild = child;
      cancelActive = onAbort;
      timer = setTimeout(() => finish(failure('TIMEOUT')), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      child.once('error', () => finish(failure('PROCESS_FAILED')));
      child.stdin.on('error', () => finish(failure('INPUT_FAILED')));
      child.stdout.on('data', (bytes: Buffer) => {
        if (settled) return;
        received += bytes.length;
        if (received > MAX_OUTPUT_BYTES) {
          finish(failure('OUTPUT_LIMIT'));
          return;
        }
        chunks.push(Buffer.from(bytes));
      });
      child.stdout.on('error', () => finish(failure('OUTPUT_FAILED')));
      child.stderr.on('data', (bytes: Buffer) => {
        if (settled) return;
        stderrBytes += bytes.length;
        if (stderrBytes > MAX_STDERR_BYTES) finish(failure('STDERR_LIMIT'));
      });
      child.stderr.on('error', () => finish(failure('PROCESS_FAILED')));
      child.once('close', (code) => {
        if (ownedChild === child) ownedChild = undefined;
        if (settled) return;
        if (code !== 0) finish(failure('PROCESS_FAILED'));
        else finish(undefined, Buffer.concat(chunks, received));
      });
      if (closed || signal?.aborted) {
        onAbort();
        return;
      }
      try {
        child.stdin.end(
          Buffer.concat([input, Buffer.alloc(PADDING_SAMPLES * 2)]),
        );
      } catch {
        finish(failure('INPUT_FAILED'));
      }
    });
  }

  const ready = (async () => {
    let hash: string;
    try {
      hash = await (options.hashBinary ?? hashLocalBinary)(executable);
    } catch {
      throw failure('BINARY_UNAVAILABLE');
    }
    if (closed) throw failure('ABORTED');
    if (hash.toLowerCase() !== PROFILE.ffmpegSha256)
      throw failure('BINARY_HASH_MISMATCH');
    const synthetic = Buffer.alloc(12000);
    for (let offset = 0; offset < synthetic.length / 2; offset += 1)
      synthetic.writeInt16LE(
        Math.round(
          1000 * Math.sin((2 * Math.PI * 440 * offset) / PROFILE.sampleRate),
        ),
        offset * 2,
      );
    const check = await run(synthetic);
    if (check.metrics.outputPeak === 0) throw failure('PREWARM_INVALID');
  })();
  // Keep abandoned/closed construction from producing an unhandled rejection;
  // consumers still receive the rejection through ready and process.
  ready.catch(() => {});

  return {
    ready,
    async process(pcm, signal) {
      if (
        !Buffer.isBuffer(pcm) ||
        !pcm.length ||
        pcm.length % 2 ||
        pcm.length > MAX_INPUT_BYTES
      )
        throw failure('INPUT_INVALID');
      if (closed || signal?.aborted) throw failure('ABORTED');
      if (reserved) throw failure('BUSY');
      reserved = true;
      const input = Buffer.from(pcm);
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancelWaiting = () => reject(failure('ABORTED'));
      });
      const onAbort = () => cancelWaiting?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await Promise.race([ready, cancelled]);
        if (closed || signal?.aborted) throw failure('ABORTED');
        cancelWaiting = undefined;
        return await run(input, signal);
      } finally {
        signal?.removeEventListener('abort', onAbort);
        cancelWaiting = undefined;
        reserved = false;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      cancelWaiting?.();
      cancelActive?.();
    },
  };
}
