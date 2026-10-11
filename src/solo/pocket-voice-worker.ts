import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from 'node:child_process';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type PocketVoiceChunk = { pcm: Buffer; sampleRate: 24000 };
export type PocketVoiceMetrics = {
  generationMs: number;
  audioMs: number;
  queueMs: number;
};
export type PocketVoiceAudio = PocketVoiceChunk & {
  id: string;
  metrics: PocketVoiceMetrics;
};
export type PocketVoiceWorker = {
  ready: Promise<void>;
  diagnosticPrefix: 'pocket';
  maxOutputSeconds: 20;
  synthesize(text: string, signal?: AbortSignal): Promise<PocketVoiceAudio>;
  synthesizeStream(
    text: string,
    signal?: AbortSignal,
  ): AsyncIterable<PocketVoiceChunk>;
  close(): void;
  status(): {
    state: 'starting' | 'ready' | 'closed' | 'failed';
    pendingJobs: number;
  };
};
export type PocketVoiceWorkerOptions = {
  repoRoot?: string;
  /** Absolute executable path; defaults to this runtime's platform venv. */
  pythonExecutable?: string;
  /** Absolute directory containing the preprovisioned model/ and venv/. */
  runtimeDir?: string;
  readyTimeoutMs?: number;
  jobTimeoutMs?: number;
  maxQueuedJobs?: number;
  /** Fail closed instead of accumulating unbounded audio behind a slow consumer. */
  maxBufferedPcmBytes?: number;
  spawnWorker?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcessWithoutNullStreams;
  terminateProcessTree?: (pid: number) => void;
};

const MAX_PCM_BYTES = 24000 * 2 * 20;
const MAX_EVENT_BYTES = Math.ceil(MAX_PCM_BYTES / 3) * 4 + 4096;
const TEXT = /^[\x20-\x7e\u00c0-\u024f\u2010-\u2015\u2018-\u201d\u2026]+$/u;
const HASH = /^[a-f0-9]{64}$/;
const CODE = /^POCKETVOICE_[A-Z_]{1,60}$/;

function failure(code: string): Error {
  const error = new Error(code);
  if (code === 'POCKETVOICE_ABORTED') error.name = 'AbortError';
  return error;
}

/** Configuration only: never probes, installs, or downloads a Python/model. */
export function resolvePocketVoiceLaunchConfig(
  options: Pick<
    PocketVoiceWorkerOptions,
    'repoRoot' | 'pythonExecutable' | 'runtimeDir'
  > = {},
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { repoRoot: string; runtimeDir: string; pythonExecutable: string } {
  const repoRoot = path.resolve(
    options.repoRoot ??
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  );
  function configuredPath(value: string | undefined, fallback: string): string {
    if (value === undefined) return fallback;
    if (
      typeof value !== 'string' ||
      value.trim() !== value ||
      [...value].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ) ||
      !path.isAbsolute(value)
    )
      throw failure('POCKETVOICE_INVALID_RUNTIME_PATH');
    return path.resolve(value);
  }
  const runtimeDir = configuredPath(
    options.runtimeDir ?? (environment.POCKET_RUNTIME_DIR || undefined),
    path.join(repoRoot, '.runtime/pocket-tts-lab'),
  );
  const pythonExecutable = configuredPath(
    options.pythonExecutable ??
      (environment.POCKET_PYTHON_EXECUTABLE || undefined),
    path.join(
      runtimeDir,
      platform === 'win32' ? 'venv/Scripts/python.exe' : 'venv/bin/python',
    ),
  );
  return { repoRoot, runtimeDir, pythonExecutable };
}

export function validatePocketVoiceText(value: unknown): string {
  if (typeof value !== 'string') throw failure('POCKETVOICE_INVALID_TEXT');
  const text = value.trim();
  if (
    !text ||
    text.length > 240 ||
    !TEXT.test(text) ||
    /[[\]<>]/u.test(text) ||
    !/[A-Za-z0-9\u00c0-\u024f]/u.test(text)
  )
    throw failure('POCKETVOICE_INVALID_TEXT');
  return text;
}

/** Do not inherit API keys, proxy credentials, Python paths or HF tokens. */
function workerEnvironment(runtimeDir?: string): NodeJS.ProcessEnv {
  const allowed = new Set([
    'SYSTEMROOT',
    'WINDIR',
    'PATH',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LOCALAPPDATA',
    'APPDATA',
    'USERPROFILE',
    'PROGRAMDATA',
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (allowed.has(key.toUpperCase()) && value !== undefined) env[key] = value;
  return {
    ...env,
    ...(runtimeDir ? { POCKET_RUNTIME_DIR: runtimeDir } : {}),
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

function terminateOwnedProcessTree(pid: number): void {
  if (process.platform === 'win32') terminateWindowsTree(pid);
  else process.kill(-pid, 'SIGKILL'); // The child owns a detached POSIX group.
}

type Job = {
  id: string;
  text: string;
  enqueuedAt: number;
  queueMs: number;
  sequence: number;
  totalBytes: number;
  digest: Hash;
  buffered: PocketVoiceChunk[];
  bufferedBytes: number;
  ended: boolean;
  error?: Error;
  metrics?: PocketVoiceMetrics;
  signal?: AbortSignal;
  onAbort: () => void;
  timer?: ReturnType<typeof setTimeout>;
  waiting?: {
    resolve: (result: IteratorResult<PocketVoiceChunk>) => void;
    reject: (error: Error) => void;
  };
};

/** One warmed CPU model, serial inference, bounded pending jobs and PCM.
 * Aborting a consumer rejects immediately. The active slot is retained until
 * verified done, discarding late chunks; a timeout kills the owned process tree.
 */
export function createPocketVoiceWorker(
  options: PocketVoiceWorkerOptions = {},
): PocketVoiceWorker {
  const readyTimeout = options.readyTimeoutMs ?? 120000;
  const jobTimeout = options.jobTimeoutMs ?? 30000;
  const capacity = options.maxQueuedJobs ?? 4;
  const bufferLimit = options.maxBufferedPcmBytes ?? 24000 * 2 * 8;
  if (
    ![readyTimeout, jobTimeout].every(
      (ms) => Number.isFinite(ms) && ms >= 1 && ms <= 120000,
    ) ||
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > 16 ||
    !Number.isInteger(bufferLimit) ||
    bufferLimit < 2 ||
    bufferLimit > MAX_PCM_BYTES
  )
    throw failure('POCKETVOICE_INVALID_OPTIONS');
  const { repoRoot, runtimeDir, pythonExecutable } =
    resolvePocketVoiceLaunchConfig(options);
  let state: 'starting' | 'ready' | 'closed' | 'failed' = 'starting';
  let child: ChildProcessWithoutNullStreams;
  let active: Job | undefined;
  const queue: Job[] = [];
  const consumers = new Set<Job>();
  let received = Buffer.alloc(0);
  let processEnded = false;
  let terminating = false;
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

  function endJob(job: Job, error?: Error): void {
    job.ended = true;
    if (error) {
      job.text = '';
      job.signal?.removeEventListener('abort', job.onAbort);
      consumers.delete(job);
      job.error = error;
      job.buffered = [];
      job.bufferedBytes = 0;
    }
    if (job.waiting) {
      if (job.error) job.waiting.reject(job.error);
      else job.waiting.resolve({ done: true, value: undefined });
      job.waiting = undefined;
      job.signal?.removeEventListener('abort', job.onAbort);
      consumers.delete(job);
    }
  }
  function killWorkerTree(): void {
    if (!child || processEnded || terminating) return;
    terminating = true;
    if (Number.isInteger(child.pid) && child.pid > 0) {
      try {
        (options.terminateProcessTree ?? terminateOwnedProcessTree)(child.pid);
      } catch {
        /* Direct process fallback. */
      }
    }
    try {
      child.kill('SIGKILL');
    } catch {
      /* Already closed. */
    }
    terminating = false;
  }
  function parentExit(): void {
    killWorkerTree();
  }
  function stopProcess(immediate: boolean): void {
    // Keep the exit hook until the child actually closes, including EOF grace.
    if (!child || processEnded) return;
    try {
      child.stdin.end();
    } catch {
      /* Closed pipe. */
    }
    if (immediate) killWorkerTree();
    else {
      closeTimer = setTimeout(killWorkerTree, 5000);
      closeTimer.unref();
    }
  }
  function fail(code: string): void {
    if (stopped()) return;
    state = 'failed';
    clearTimeout(startTimer);
    const error = failure(code);
    rejectReady(error);
    if (active) {
      clearTimeout(active.timer);
      endJob(active, error);
      active = undefined;
    }
    for (const job of queue.splice(0)) endJob(job, error);
    for (const job of consumers) endJob(job, error);
    received = Buffer.alloc(0);
    stopProcess(true);
  }
  function pump(): void {
    if (state !== 'ready' || active || !queue.length) return;
    const job = queue.shift()!;
    active = job;
    job.queueMs = performance.now() - job.enqueuedAt;
    job.timer = setTimeout(() => fail('POCKETVOICE_JOB_TIMEOUT'), jobTimeout);
    try {
      child.stdin.write(
        `${JSON.stringify({ id: job.id, text: job.text })}\n`,
        (error) => {
          if (error) fail('POCKETVOICE_PIPE_FAILED');
        },
      );
    } catch {
      fail('POCKETVOICE_PIPE_FAILED');
    }
    job.text = '';
  }
  function onEvent(event: Record<string, any>): void {
    if (!event || typeof event !== 'object' || Array.isArray(event))
      throw failure('POCKETVOICE_PROTOCOL_ERROR');
    if (event.type === 'fatal') {
      fail(
        typeof event.code === 'string' && CODE.test(event.code)
          ? event.code
          : 'POCKETVOICE_WORKER_FAILED',
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
        event.mode !== 'synthesis-cpu-native-stream' ||
        event.voice !== 'michael' ||
        event.version !== '3.3.0' ||
        event.maxTextChars !== 240 ||
        event.maxOutputSeconds !== 20
      )
        throw failure('POCKETVOICE_PROTOCOL_ERROR');
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
      !['chunk', 'done', 'error'].includes(event.type)
    )
      throw failure('POCKETVOICE_PROTOCOL_ERROR');
    const job = active;
    if (event.type === 'error') {
      fail(
        typeof event.code === 'string' && CODE.test(event.code)
          ? event.code
          : 'POCKETVOICE_SYNTHESIS_FAILED',
      );
      return;
    }
    if (event.type === 'chunk') {
      if (
        event.sequence !== job.sequence ||
        event.sampleRate !== 24000 ||
        typeof event.pcm !== 'string' ||
        !event.pcm.length ||
        event.pcm.length % 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(event.pcm) ||
        typeof event.sha256 !== 'string' ||
        !HASH.test(event.sha256)
      )
        throw failure('POCKETVOICE_PROTOCOL_ERROR');
      const pcm = Buffer.from(event.pcm, 'base64');
      if (
        !pcm.length ||
        pcm.length % 2 ||
        pcm.toString('base64') !== event.pcm ||
        job.totalBytes + pcm.length > MAX_PCM_BYTES ||
        createHash('sha256').update(pcm).digest('hex') !== event.sha256
      )
        throw failure('POCKETVOICE_PROTOCOL_ERROR');
      job.sequence += 1;
      job.totalBytes += pcm.length;
      job.digest.update(pcm);
      if (job.ended) return; // Cancelled inference retains its slot, never emits late audio.
      const chunk: PocketVoiceChunk = { pcm, sampleRate: 24000 };
      if (job.waiting) {
        job.waiting.resolve({ done: false, value: chunk });
        job.waiting = undefined;
      } else {
        if (job.bufferedBytes + pcm.length > bufferLimit) {
          fail('POCKETVOICE_CONSUMER_TOO_SLOW');
          return;
        }
        job.buffered.push(chunk);
        job.bufferedBytes += pcm.length;
      }
      return;
    }
    if (
      !job.sequence ||
      event.chunks !== job.sequence ||
      event.bytes !== job.totalBytes ||
      typeof event.sha256 !== 'string' ||
      !HASH.test(event.sha256) ||
      event.sha256 !== job.digest.digest('hex') ||
      !Number.isFinite(event.generationMs) ||
      event.generationMs < 0 ||
      event.generationMs > 120000 ||
      !Number.isFinite(event.audioMs) ||
      event.audioMs !== job.totalBytes / 48
    )
      throw failure('POCKETVOICE_PROTOCOL_ERROR');
    job.metrics = {
      generationMs: event.generationMs,
      audioMs: event.audioMs,
      queueMs: job.queueMs,
    };
    clearTimeout(job.timer);
    active = undefined;
    endJob(job);
    pump();
  }
  function onData(chunk: Buffer): void {
    if (stopped()) return;
    try {
      if (chunk.length > MAX_EVENT_BYTES + 1)
        throw failure('POCKETVOICE_PROTOCOL_ERROR');
      received = Buffer.concat([received, chunk]);
      let newline = received.indexOf(10);
      while (newline >= 0) {
        if (newline > MAX_EVENT_BYTES)
          throw failure('POCKETVOICE_PROTOCOL_ERROR');
        const line = received.subarray(0, newline);
        received = received.subarray(newline + 1);
        onEvent(JSON.parse(line.toString('utf8')));
        if (stopped()) return;
        newline = received.indexOf(10);
      }
      if (received.length > MAX_EVENT_BYTES)
        throw failure('POCKETVOICE_PROTOCOL_ERROR');
    } catch {
      fail('POCKETVOICE_PROTOCOL_ERROR');
    }
  }
  startTimer = setTimeout(
    () => fail('POCKETVOICE_READY_TIMEOUT'),
    readyTimeout,
  );
  try {
    const spawnWorker =
      options.spawnWorker ??
      ((command, args, settings) =>
        spawn(command, args, {
          ...settings,
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as ChildProcessWithoutNullStreams);
    child = spawnWorker(
      pythonExecutable,
      ['-u', path.join(repoRoot, 'scripts/pocket-voice-worker.py')],
      {
        cwd: repoRoot,
        windowsHide: true,
        detached: process.platform !== 'win32',
        shell: false,
        env: workerEnvironment(runtimeDir),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    child.stdout.on('data', onData);
    child.stderr.resume();
    child.on('error', () => fail('POCKETVOICE_START_FAILED'));
    for (const stream of [child.stdin, child.stdout, child.stderr])
      stream.on('error', () => fail('POCKETVOICE_PIPE_FAILED'));
    child.stdout.on('end', () => fail('POCKETVOICE_WORKER_EXITED'));
    child.on('close', () => {
      // Clean lingering descendants even if the worker itself honored EOF.
      if (process.platform !== 'win32') killWorkerTree();
      processEnded = true;
      clearTimeout(closeTimer);
      process.removeListener('exit', parentExit);
      fail('POCKETVOICE_WORKER_EXITED');
    });
    process.once('exit', parentExit);
  } catch {
    fail('POCKETVOICE_START_FAILED');
  }

  function enqueue(
    value: string,
    signal?: AbortSignal,
  ): { job: Job; iterator: AsyncIterableIterator<PocketVoiceChunk> } {
    const text = validatePocketVoiceText(value);
    if (signal?.aborted) throw failure('POCKETVOICE_ABORTED');
    if (stopped()) throw failure('POCKETVOICE_NOT_READY');
    if (consumers.size + (active && !consumers.has(active) ? 1 : 0) >= capacity)
      throw failure('POCKETVOICE_QUEUE_FULL');
    const job: Job = {
      id: randomUUID(),
      text,
      enqueuedAt: performance.now(),
      queueMs: 0,
      sequence: 0,
      totalBytes: 0,
      digest: createHash('sha256'),
      buffered: [],
      bufferedBytes: 0,
      ended: false,
      signal,
      onAbort() {
        endJob(job, failure('POCKETVOICE_ABORTED'));
        const index = queue.indexOf(job);
        if (index >= 0) {
          queue.splice(index, 1);
          job.text = '';
        }
      },
    };
    const iterator: AsyncIterableIterator<PocketVoiceChunk> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        if (job.error) return Promise.reject(job.error);
        const chunk = job.buffered.shift();
        if (chunk) {
          job.bufferedBytes -= chunk.pcm.length;
          return Promise.resolve({ done: false as const, value: chunk });
        }
        if (job.ended) {
          job.signal?.removeEventListener('abort', job.onAbort);
          consumers.delete(job);
          return Promise.resolve({ done: true as const, value: undefined });
        }
        if (job.waiting)
          return Promise.reject(failure('POCKETVOICE_CONCURRENT_READ'));
        return new Promise((resolve, reject) => {
          job.waiting = { resolve, reject };
        });
      },
      return() {
        job.onAbort();
        return Promise.resolve({ done: true as const, value: undefined });
      },
      throw(error) {
        job.onAbort();
        return Promise.reject(error);
      },
    };
    signal?.addEventListener('abort', job.onAbort, { once: true });
    consumers.add(job);
    queue.push(job);
    pump();
    return { job, iterator };
  }
  return {
    ready,
    diagnosticPrefix: 'pocket',
    maxOutputSeconds: 20,
    status: () => ({ state, pendingJobs: queue.length + (active ? 1 : 0) }),
    synthesizeStream: (text, signal) => enqueue(text, signal).iterator,
    async synthesize(text, signal) {
      const { job, iterator } = enqueue(text, signal);
      const chunks: Buffer[] = [];
      for await (const chunk of iterator) chunks.push(chunk.pcm);
      return {
        id: job.id,
        pcm: Buffer.concat(chunks),
        sampleRate: 24000,
        metrics: job.metrics!,
      };
    },
    close() {
      if (state === 'closed') return;
      const immediate = state === 'starting' || !!active;
      state = 'closed';
      clearTimeout(startTimer);
      const error = failure('POCKETVOICE_CLOSED');
      rejectReady(error);
      if (active) {
        clearTimeout(active.timer);
        endJob(active, error);
        active = undefined;
      }
      for (const job of queue.splice(0)) endJob(job, error);
      for (const job of consumers) endJob(job, error);
      received = Buffer.alloc(0);
      stopProcess(immediate);
    },
  };
}
