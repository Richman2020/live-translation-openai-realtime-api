import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type NanoVoiceMetrics = {
  generationMs: number;
  audioMs: number;
  t3Ms: number;
  decoderMs: number;
  watermarkMs: number;
  tokenCount: number;
  tokenSha256: string;
  pcmSha256: string;
  temperature: 0.75;
  seed: 1709;
  queueMs: number;
};

export type NanoVoiceAudio = {
  id: string;
  pcm: Buffer;
  sampleRate: 24000;
  metrics: NanoVoiceMetrics;
};

export type NanoVoiceWorker = {
  ready: Promise<void>;
  synthesize(text: string, signal?: AbortSignal): Promise<NanoVoiceAudio>;
  close(): void;
  status(): {
    state: 'starting' | 'ready' | 'closed' | 'failed';
    pendingJobs: number;
  };
};

export type NanoWorkerSpawner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export type NanoVoiceWorkerOptions = {
  repoRoot?: string;
  readyTimeoutMs?: number;
  jobTimeoutMs?: number;
  /** Includes the one in-flight job, even after its caller cancels. */
  maxQueuedJobs?: number;
  /** Test seam only. Production uses the fixed local Python entrypoint. */
  spawnWorker?: NanoWorkerSpawner;
  /** Test seam: production terminates only the owned Windows worker PID tree. */
  terminateProcessTree?: (pid: number) => void;
};

const MAX_PCM_BYTES = 24000 * 2 * 20;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const TEXT = /^[\x20-\x7e\u00c0-\u024f\u2010-\u2015\u2018-\u201d\u2026]+$/u;
const HASH = /^[a-f0-9]{64}$/;
const ERROR_CODE = /^NANOVOICE_[A-Z_]{1,60}$/;

function failure(code: string): Error {
  const error = new Error(code);
  if (code === 'NANOVOICE_ABORTED') error.name = 'AbortError';
  return error;
}

export function validateNanoVoiceText(value: unknown): string {
  if (typeof value !== 'string') throw failure('NANOVOICE_INVALID_TEXT');
  const text = value.trim();
  if (
    !text ||
    text.length > 240 ||
    !TEXT.test(text) ||
    /[[\]<>]/u.test(text) ||
    !/[A-Za-z0-9\u00c0-\u024f]/u.test(text)
  )
    throw failure('NANOVOICE_INVALID_TEXT');
  return text;
}

/** Only operational OS paths are inherited; provider credentials never enter Python. */
function workerEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set([
    'SYSTEMROOT',
    'WINDIR',
    'PATH',
    'PATHEXT',
    'TEMP',
    'TMP',
    'LOCALAPPDATA',
    'APPDATA',
    'USERPROFILE',
    'PROGRAMDATA',
    'CUDA_PATH',
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toUpperCase()) && value !== undefined) env[key] = value;
  }
  return {
    ...env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    TOKENIZERS_PARALLELISM: 'false',
  };
}

function terminateWindowsTree(pid: number): void {
  // Python's Windows venv executable is a launcher with a real Python child.
  // Killing just the launcher can orphan imports before the EOF reader starts.
  const executable = path.join(
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows',
    'System32',
    'taskkill.exe',
  );
  spawnSync(executable, ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
    timeout: 5000,
    env: workerEnvironment(),
  });
}

function parseAudio(
  event: Record<string, any>,
  queueMs: number,
): NanoVoiceAudio {
  if (
    event.sampleRate !== 24000 ||
    typeof event.pcm !== 'string' ||
    !event.pcm.length ||
    event.pcm.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(event.pcm)
  )
    throw failure('NANOVOICE_INVALID_AUDIO');
  const pcm = Buffer.from(event.pcm, 'base64');
  if (
    !pcm.length ||
    pcm.length > MAX_PCM_BYTES ||
    pcm.length % 2 ||
    pcm.toString('base64') !== event.pcm
  )
    throw failure('NANOVOICE_INVALID_AUDIO');
  const m = event.metrics;
  if (
    !m ||
    typeof m !== 'object' ||
    Array.isArray(m) ||
    ['generationMs', 'audioMs', 't3Ms', 'decoderMs', 'watermarkMs'].some(
      (key) => !Number.isFinite(m[key]) || m[key] < 0 || m[key] > 120000,
    ) ||
    m.audioMs <= 0 ||
    Math.abs(m.audioMs - pcm.length / 48) > 1e-6 ||
    !Number.isInteger(m.tokenCount) ||
    m.tokenCount < 1 ||
    m.tokenCount >= 1000 ||
    typeof m.tokenSha256 !== 'string' ||
    !HASH.test(m.tokenSha256) ||
    typeof m.pcmSha256 !== 'string' ||
    !HASH.test(m.pcmSha256) ||
    createHash('sha256').update(pcm).digest('hex') !== m.pcmSha256 ||
    m.temperature !== 0.75 ||
    m.seed !== 1709
  )
    throw failure('NANOVOICE_INVALID_AUDIO');
  // Whitelist telemetry: a child cannot smuggle transcripts/paths into logs.
  return {
    id: event.id,
    pcm,
    sampleRate: 24000,
    metrics: {
      generationMs: m.generationMs,
      audioMs: m.audioMs,
      t3Ms: m.t3Ms,
      decoderMs: m.decoderMs,
      watermarkMs: m.watermarkMs,
      tokenCount: m.tokenCount,
      tokenSha256: m.tokenSha256,
      pcmSha256: m.pcmSha256,
      temperature: 0.75,
      seed: 1709,
      queueMs,
    },
  };
}

type Job = {
  id: string;
  text: string;
  enqueuedAt: number;
  queueMs: number;
  settled: boolean;
  signal?: AbortSignal;
  onAbort: () => void;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (audio: NanoVoiceAudio) => void;
  reject: (error: Error) => void;
};

/**
 * One resident, offline worker, one in-flight synthesis and a bounded FIFO.
 * Aborting an active job rejects immediately but retains its slot until Python
 * returns; late audio is discarded. A hung job fails/closes this worker.
 * Whole-file PCM is returned here; telephone pacing belongs to the bridge.
 */
export function createNanoVoiceWorker(
  options: NanoVoiceWorkerOptions = {},
): NanoVoiceWorker {
  const readyTimeout = options.readyTimeoutMs ?? 120000;
  const jobTimeout = options.jobTimeoutMs ?? 15000;
  const capacity = options.maxQueuedJobs ?? 4;
  if (
    ![readyTimeout, jobTimeout].every(
      (ms) => Number.isFinite(ms) && ms >= 1 && ms <= 120000,
    ) ||
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > 16
  )
    throw failure('NANOVOICE_INVALID_OPTIONS');
  const repoRoot = path.resolve(
    options.repoRoot ??
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  );
  let state: 'starting' | 'ready' | 'closed' | 'failed' = 'starting';
  let child: ChildProcessWithoutNullStreams;
  let active: Job | undefined;
  const queue: Job[] = [];
  let received = Buffer.alloc(0);
  let processEnded = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let startTimer: ReturnType<typeof setTimeout>;
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});
  const stopped = () => state === 'closed' || state === 'failed';

  function settle(job: Job, error?: Error, audio?: NanoVoiceAudio) {
    if (job.settled) return;
    job.settled = true;
    job.signal?.removeEventListener('abort', job.onAbort);
    if (error) job.reject(error);
    else job.resolve(audio!);
  }
  function killWorkerTree() {
    if (!child || processEnded) return;
    if (
      process.platform === 'win32' &&
      Number.isInteger(child.pid) &&
      child.pid > 0
    ) {
      try {
        (options.terminateProcessTree ?? terminateWindowsTree)(child.pid);
      } catch {
        /* Still attempt the owned direct process below. */
      }
    }
    try {
      child.kill();
    } catch {
      /* Already exited. */
    }
  }
  function parentExit(): void {
    // These lifecycle callbacks refer to each other and run only after setup.
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    stopProcess(true);
  }
  function stopProcess(immediate: boolean) {
    process.removeListener('exit', parentExit);
    if (!child || processEnded) return;
    try {
      child.stdin.end();
    } catch {
      /* Already closed pipe. */
    }
    if (immediate) {
      killWorkerTree();
      return;
    }
    closeTimer = setTimeout(killWorkerTree, 5000);
    closeTimer.unref();
  }
  function fail(code: string) {
    if (stopped()) return;
    state = 'failed';
    clearTimeout(startTimer);
    const error = failure(code);
    rejectReady(error);
    if (active) {
      clearTimeout(active.timer);
      settle(active, error);
      active = undefined;
    }
    for (const job of queue.splice(0)) settle(job, error);
    received = Buffer.alloc(0);
    stopProcess(true);
  }
  function pump() {
    if (state !== 'ready' || active || !queue.length) return;
    const job = queue.shift()!;
    active = job;
    job.queueMs = performance.now() - job.enqueuedAt;
    job.timer = setTimeout(() => fail('NANOVOICE_JOB_TIMEOUT'), jobTimeout);
    try {
      child.stdin.write(
        `${JSON.stringify({ id: job.id, text: job.text })}\n`,
        (error) => {
          if (error) fail('NANOVOICE_PIPE_FAILED');
        },
      );
    } catch {
      fail('NANOVOICE_PIPE_FAILED');
    }
    // Only the bounded queued jobs retain text. In-flight text is no longer
    // needed in Node once it has crossed the private pipe.
    job.text = '';
  }
  function onEvent(event: Record<string, any>) {
    if (!event || typeof event !== 'object' || Array.isArray(event))
      throw failure('NANOVOICE_PROTOCOL_ERROR');
    if (event.type === 'fatal') {
      fail(
        typeof event.code === 'string' && ERROR_CODE.test(event.code)
          ? event.code
          : 'NANOVOICE_WORKER_FAILED',
      );
      return;
    }
    if (event.type === 'ready') {
      if (
        state !== 'starting' ||
        event.protocol !== 1 ||
        event.sampleRate !== 24000 ||
        event.channels !== 1 ||
        event.encoding !== 'pcm_s16le' ||
        event.mode !== 'synthesis-cuda' ||
        event.temperature !== 0.75 ||
        event.maxTextChars !== 240
      )
        throw failure('NANOVOICE_PROTOCOL_ERROR');
      state = 'ready';
      clearTimeout(startTimer);
      resolveReady();
      pump();
      return;
    }
    if (
      state !== 'ready' ||
      !active ||
      event.id !== active.id ||
      !['audio', 'error'].includes(event.type)
    )
      throw failure('NANOVOICE_PROTOCOL_ERROR');
    const job = active;
    if (event.type === 'error') {
      fail(
        typeof event.code === 'string' && ERROR_CODE.test(event.code)
          ? event.code
          : 'NANOVOICE_SYNTHESIS_FAILED',
      );
      return;
    }
    const audio = parseAudio(event, job.queueMs);
    clearTimeout(job.timer);
    active = undefined;
    if (!job.settled) settle(job, undefined, audio);
    pump();
  }
  function onData(chunk: Buffer) {
    if (stopped()) return;
    try {
      if (chunk.length > MAX_EVENT_BYTES + 1)
        throw failure('NANOVOICE_PROTOCOL_ERROR');
      received = Buffer.concat([received, chunk]);
      let newline = received.indexOf(10);
      while (newline >= 0) {
        if (newline > MAX_EVENT_BYTES)
          throw failure('NANOVOICE_PROTOCOL_ERROR');
        const line = received.subarray(0, newline);
        received = received.subarray(newline + 1);
        onEvent(JSON.parse(line.toString('utf8')));
        if (stopped()) return;
        newline = received.indexOf(10);
      }
      if (received.length > MAX_EVENT_BYTES)
        throw failure('NANOVOICE_PROTOCOL_ERROR');
    } catch {
      fail('NANOVOICE_PROTOCOL_ERROR');
    }
  }
  startTimer = setTimeout(() => fail('NANOVOICE_READY_TIMEOUT'), readyTimeout);
  try {
    const spawnWorker =
      options.spawnWorker ??
      ((command, args, settings) =>
        spawn(command, args, {
          ...settings,
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as ChildProcessWithoutNullStreams);
    child = spawnWorker(
      path.join(
        repoRoot,
        '.runtime/chatterbox-nano-gpu-lab/venv/Scripts/python.exe',
      ),
      ['-u', path.join(repoRoot, 'scripts/nano-voice-worker.py')],
      {
        cwd: repoRoot,
        windowsHide: true,
        shell: false,
        env: workerEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    child.stdout.on('data', onData);
    child.stderr.resume(); // Drain model progress; never publish raw stderr or keep private paths/text.
    child.on('error', () => fail('NANOVOICE_START_FAILED'));
    child.stdin.on('error', () => fail('NANOVOICE_PIPE_FAILED'));
    child.stdout.on('error', () => fail('NANOVOICE_PIPE_FAILED'));
    child.stderr.on('error', () => fail('NANOVOICE_PIPE_FAILED'));
    child.stdout.on('end', () => fail('NANOVOICE_WORKER_EXITED'));
    child.on('close', () => {
      processEnded = true;
      if (closeTimer) clearTimeout(closeTimer);
      process.removeListener('exit', parentExit);
      fail('NANOVOICE_WORKER_EXITED');
    });
    process.once('exit', parentExit);
  } catch {
    fail('NANOVOICE_START_FAILED');
  }

  return {
    ready,
    status: () => ({ state, pendingJobs: queue.length + (active ? 1 : 0) }),
    synthesize(value, signal) {
      let text: string;
      try {
        text = validateNanoVoiceText(value);
      } catch (error) {
        return Promise.reject(error);
      }
      if (signal?.aborted) return Promise.reject(failure('NANOVOICE_ABORTED'));
      if (state === 'closed' || state === 'failed')
        return Promise.reject(failure('NANOVOICE_NOT_READY'));
      if (queue.length + (active ? 1 : 0) >= capacity)
        return Promise.reject(failure('NANOVOICE_QUEUE_FULL'));
      return new Promise<NanoVoiceAudio>((resolve, reject) => {
        const job: Job = {
          id: randomUUID(),
          text,
          enqueuedAt: performance.now(),
          queueMs: 0,
          settled: false,
          signal,
          resolve,
          reject,
          onAbort() {
            settle(job, failure('NANOVOICE_ABORTED'));
            const index = queue.indexOf(job);
            if (index >= 0) {
              queue.splice(index, 1);
              job.text = '';
            }
            // Active inference retains the slot and deadline. Its eventual
            // result cannot resolve this now-aborted promise.
          },
        };
        signal?.addEventListener('abort', job.onAbort, { once: true });
        queue.push(job);
        pump();
      });
    },
    close() {
      if (state === 'closed') return;
      const stillLoading = state === 'starting';
      state = 'closed';
      clearTimeout(startTimer);
      rejectReady(failure('NANOVOICE_CLOSED'));
      if (active) {
        clearTimeout(active.timer);
        settle(active, failure('NANOVOICE_CLOSED'));
        active = undefined;
      }
      for (const job of queue.splice(0))
        settle(job, failure('NANOVOICE_CLOSED'));
      received = Buffer.alloc(0);
      stopProcess(stillLoading);
    },
  };
}
