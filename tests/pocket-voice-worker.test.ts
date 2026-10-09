import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from 'node:child_process';
import {
  createPocketVoiceWorker,
  resolvePocketVoiceLaunchConfig,
  validatePocketVoiceText,
  type PocketVoiceWorkerOptions,
} from '../src/solo/pocket-voice-worker';
import {
  pocketVoiceStatus,
  closePocketVoiceWorker,
} from '../src/solo/pocket-runtime';

const readyEvent = {
  type: 'ready',
  protocol: 1,
  sampleRate: 24000,
  channels: 1,
  encoding: 'pcm_s16le',
  mode: 'synthesis-cpu-native-stream',
  voice: 'michael',
  version: '3.3.0',
  maxTextChars: 240,
  maxOutputSeconds: 20,
};
const hash = (pcm: Buffer) => createHash('sha256').update(pcm).digest('hex');
class FakeWorker extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  requests: { id: string; text: string }[] = [];
  chunks = new Map<number, Buffer[]>();
  killCount = 0;
  stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.requests.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
  constructor() {
    super();
    this.stdin.on('finish', () => queueMicrotask(() => this.emit('close', 0)));
  }
  kill() {
    this.killCount += 1;
    this.emit('close', 1);
    return true;
  }
  send(value: unknown) {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
  ready() {
    this.send(readyEvent);
  }
  chunk(
    index = 0,
    pcm = Buffer.from([1, 0, 2, 0]),
    overrides: Record<string, unknown> = {},
  ) {
    const chunks = this.chunks.get(index) ?? [];
    this.chunks.set(index, chunks);
    const sequence = chunks.length;
    chunks.push(pcm);
    this.send({
      type: 'chunk',
      id: this.requests[index].id,
      sequence,
      sampleRate: 24000,
      pcm: pcm.toString('base64'),
      sha256: hash(pcm),
      ...overrides,
    });
  }
  done(index = 0, overrides: Record<string, unknown> = {}) {
    const chunks = this.chunks.get(index) ?? [];
    const pcm = Buffer.concat(chunks);
    this.send({
      type: 'done',
      id: this.requests[index].id,
      chunks: chunks.length,
      bytes: pcm.length,
      sha256: hash(pcm),
      generationMs: 100,
      audioMs: pcm.length / 48,
      ...overrides,
    });
  }
}
function fixture(options: PocketVoiceWorkerOptions = {}) {
  const child = new FakeWorker();
  let launch: { command: string; args: string[]; options: SpawnOptions };
  const worker = createPocketVoiceWorker({
    ...options,
    spawnWorker(command, args, settings) {
      launch = { command, args, options: settings };
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
  return { worker, child, launch: () => launch };
}

test('Pocket uses isolated public preset runtime, no credentials, and waits for warmed ready', async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'private-test-not-a-key';
  const f = fixture();
  try {
    assert.match(
      f.launch().command,
      process.platform === 'win32'
        ? /pocket-tts-lab[\\/]venv[\\/]Scripts[\\/]python.exe$/
        : /pocket-tts-lab\/venv\/bin\/python$/,
    );
    assert.equal(f.launch().options.env.OPENAI_API_KEY, undefined);
    assert.equal(f.launch().options.env.HTTPS_PROXY, undefined);
    assert.equal(f.launch().options.env.HF_HUB_OFFLINE, '1');
    assert.equal(
      f.launch().options.env.POCKET_RUNTIME_DIR,
      path.resolve('.runtime/pocket-tts-lab'),
    );
    assert.equal(f.launch().options.detached, process.platform !== 'win32');
    assert.equal(f.launch().options.windowsHide, true);
    assert.equal(f.launch().options.shell, false);
    const pending = f.worker.synthesize('Hello, thank you for calling.');
    assert.equal(f.child.requests.length, 0);
    f.child.ready();
    await f.worker.ready;
    assert.equal(f.child.requests.length, 1);
    f.child.chunk();
    f.child.done();
    const result = await pending;
    assert.deepEqual(result.pcm, Buffer.from([1, 0, 2, 0]));
    assert.equal(result.metrics.audioMs, 4 / 48);
    assert.equal(result.metrics.generationMs, 100);
    assert.equal(f.worker.diagnosticPrefix, 'pocket');
  } finally {
    f.worker.close();
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('Pocket selects platform venvs and explicit preprovisioned paths without probing or shell arguments', () => {
  const repoRoot = path.resolve('offline-repo');
  const runtimeDir = path.resolve('offline-models');
  const pythonExecutable = path.join(runtimeDir, 'Python runtime', 'python');
  for (const platform of ['win32', 'linux'] as const) {
    assert.deepEqual(
      resolvePocketVoiceLaunchConfig({ repoRoot }, {}, platform),
      {
        repoRoot,
        runtimeDir: path.join(repoRoot, '.runtime/pocket-tts-lab'),
        pythonExecutable: path.join(
          repoRoot,
          '.runtime/pocket-tts-lab',
          platform === 'win32' ? 'venv/Scripts/python.exe' : 'venv/bin/python',
        ),
      },
    );
  }
  const environment = {
    POCKET_RUNTIME_DIR: runtimeDir,
    POCKET_PYTHON_EXECUTABLE: pythonExecutable,
  };
  assert.deepEqual(resolvePocketVoiceLaunchConfig({ repoRoot }, environment), {
    repoRoot,
    runtimeDir,
    pythonExecutable,
  });
  const f = fixture({ repoRoot, runtimeDir, pythonExecutable });
  try {
    assert.equal(f.launch().command, pythonExecutable);
    assert.deepEqual(f.launch().args, [
      '-u',
      path.join(repoRoot, 'scripts/pocket-voice-worker.py'),
    ]);
    assert.equal(f.launch().options.env.POCKET_RUNTIME_DIR, runtimeDir);
    assert.equal(f.launch().options.env.POCKET_PYTHON_EXECUTABLE, undefined);
    assert.equal(f.launch().options.shell, false);
  } finally {
    f.worker.close();
  }
});

test('Pocket rejects relative, URL and control-containing runtime paths before spawning', () => {
  for (const value of [
    'python3',
    'https://model.invalid/',
    '/tmp/model\nsecret',
    '/tmp/\0model',
    ' /tmp/model',
  ]) {
    for (const field of ['runtimeDir', 'pythonExecutable'] as const) {
      assert.throws(
        () =>
          createPocketVoiceWorker({
            [field]: value,
            spawnWorker() {
              assert.fail('Invalid path must not launch a worker');
            },
          }),
        { message: 'POCKETVOICE_INVALID_RUNTIME_PATH' },
      );
    }
  }
  const options = { runtimeDir: path.resolve('operator-models') };
  const config = resolvePocketVoiceLaunchConfig(options, {
    POCKET_RUNTIME_DIR: 'invalid-inherited-path',
    POCKET_PYTHON_EXECUTABLE: '',
  });
  assert.equal(config.runtimeDir, options.runtimeDir);
});

test('Pocket yields each native chunk before done and preserves exact order', async () => {
  const f = fixture();
  try {
    f.child.ready();
    await f.worker.ready;
    const stream = f.worker
      .synthesizeStream('First sentence.')
      [Symbol.asyncIterator]();
    const first = stream.next();
    f.child.chunk();
    assert.deepEqual((await first).value.pcm, Buffer.from([1, 0, 2, 0]));
    assert.equal(f.worker.status().pendingJobs, 1);
    const next = stream.next();
    f.child.chunk(0, Buffer.from([3, 0]));
    assert.deepEqual((await next).value.pcm, Buffer.from([3, 0]));
    const done = stream.next();
    f.child.done();
    assert.equal((await done).done, true);
    assert.equal(f.worker.status().pendingJobs, 0);
  } finally {
    f.worker.close();
  }
});

test('Pocket cancellation retains active slot and discards late chunks, then serves queued job', async () => {
  const f = fixture({ maxQueuedJobs: 2 });
  try {
    f.child.ready();
    await f.worker.ready;
    const abort = new AbortController();
    const stream = f.worker
      .synthesizeStream('Cancelled.', abort.signal)
      [Symbol.asyncIterator]();
    const pending = assert.rejects(stream.next(), {
      name: 'AbortError',
      message: 'POCKETVOICE_ABORTED',
    });
    const second = f.worker.synthesize('Second.');
    await assert.rejects(f.worker.synthesize('Third.'), /QUEUE_FULL/);
    abort.abort();
    await pending;
    assert.equal(f.worker.status().pendingJobs, 2);
    f.child.chunk();
    assert.equal(f.child.requests.length, 1);
    f.child.done();
    assert.equal(f.child.requests.length, 2);
    f.child.chunk(1);
    f.child.done(1);
    assert.equal((await second).id, f.child.requests[1].id);
  } finally {
    f.worker.close();
  }
});

test('Pocket iterator return and queued cancellation remove retained text and audio', async () => {
  const f = fixture();
  try {
    f.child.ready();
    await f.worker.ready;
    const stream = f.worker.synthesizeStream('Active.')[Symbol.asyncIterator]();
    const abort = new AbortController();
    const queued = f.worker.synthesize('Never sent.', abort.signal);
    const rejected = assert.rejects(queued, /ABORTED/);
    abort.abort();
    await rejected;
    await stream.return!();
    f.child.chunk();
    f.child.done();
    assert.equal(f.child.requests.length, 1);
    assert.equal(f.worker.status().pendingJobs, 0);
  } finally {
    f.worker.close();
  }
});

test('Pocket discards already-buffered completed audio on hangup or close', async () => {
  for (const mode of ['abort', 'close']) {
    const f = fixture();
    try {
      f.child.ready();
      await f.worker.ready;
      const abort = new AbortController();
      const stream = f.worker
        .synthesizeStream('Buffered.', abort.signal)
        [Symbol.asyncIterator]();
      f.child.chunk();
      f.child.done();
      if (mode === 'abort') abort.abort();
      else f.worker.close();
      await assert.rejects(
        stream.next(),
        mode === 'abort' ? /ABORTED/ : /CLOSED/,
      );
    } finally {
      f.worker.close();
    }
  }
});

test('Pocket rejects missing/reordered chunks and corrupt total checksums fail closed', async () => {
  for (const bad of ['sequence', 'hash', 'done', 'id', 'duration']) {
    const f = fixture();
    try {
      f.child.ready();
      await f.worker.ready;
      const rejected = assert.rejects(
        f.worker.synthesize('Validate me.'),
        /PROTOCOL_ERROR/,
      );
      if (bad === 'sequence') f.child.chunk(0, undefined, { sequence: 1 });
      else if (bad === 'hash')
        f.child.chunk(0, undefined, { sha256: 'a'.repeat(64) });
      else if (bad === 'id') f.child.chunk(0, undefined, { id: 'wrong' });
      else {
        f.child.chunk();
        f.child.done(
          0,
          bad === 'duration' ? { audioMs: 99 } : { sha256: 'a'.repeat(64) },
        );
      }
      await rejected;
      assert.equal(f.worker.status().state, 'failed');
      assert.equal(f.child.killCount, 1);
    } finally {
      f.worker.close();
    }
  }
});

test('Pocket bounds slow-consumer PCM and total generated duration', async () => {
  for (const tooLong of [false, true]) {
    const f = fixture({ maxBufferedPcmBytes: 4 });
    try {
      f.child.ready();
      await f.worker.ready;
      const stream = f.worker
        .synthesizeStream('Slow consumer.')
        [Symbol.asyncIterator]();
      if (tooLong) f.child.chunk(0, Buffer.alloc(24000 * 2 * 20 + 2));
      else {
        f.child.chunk();
        f.child.chunk();
      }
      await assert.rejects(
        stream.next(),
        tooLong ? /PROTOCOL_ERROR/ : /CONSUMER_TOO_SLOW/,
      );
      assert.equal(f.worker.status().state, 'failed');
    } finally {
      f.worker.close();
    }
  }
});

test('Pocket does not permit unlimited completed unread streams', async () => {
  const f = fixture({ maxQueuedJobs: 1 });
  try {
    f.child.ready();
    await f.worker.ready;
    const stream = f.worker.synthesizeStream('Unread.')[Symbol.asyncIterator]();
    f.child.chunk();
    f.child.done();
    await assert.rejects(f.worker.synthesize('Another.'), /QUEUE_FULL/);
    await stream.return!();
    const next = f.worker.synthesize('Now available.');
    f.child.chunk(1);
    f.child.done(1);
    await next;
  } finally {
    f.worker.close();
  }
});

test('Pocket handles fragmented JSONL and rejects unknown voice, oversized and malformed frames', async () => {
  const f = fixture();
  try {
    const data = JSON.stringify(readyEvent);
    f.child.stdout.write(data.slice(0, 15));
    assert.equal(f.worker.status().state, 'starting');
    f.child.stdout.write(`${data.slice(15)}\n`);
    await f.worker.ready;
  } finally {
    f.worker.close();
  }
  for (const value of [
    JSON.stringify({ ...readyEvent, voice: 'private' }) + '\n',
    'raw private log\n',
    'x'.repeat(1300000),
  ]) {
    const bad = fixture();
    const rejected = assert.rejects(bad.worker.ready, /PROTOCOL_ERROR/);
    bad.child.stdout.write(value);
    await rejected;
    bad.worker.close();
  }
});

test('Pocket deadlines and failures terminate owned workers without exposing paths or secrets', async () => {
  const startup = fixture({ readyTimeoutMs: 10 });
  await assert.rejects(startup.worker.ready, /READY_TIMEOUT/);
  startup.worker.close();
  const f = fixture({ jobTimeoutMs: 10 });
  try {
    f.child.ready();
    await f.worker.ready;
    await assert.rejects(f.worker.synthesize('Timeout.'), /JOB_TIMEOUT/);
  } finally {
    f.worker.close();
  }
  const fatal = fixture();
  const rejected = assert.rejects(fatal.worker.ready, {
    message: 'POCKETVOICE_WORKER_FAILED',
  });
  fatal.child.send({ type: 'fatal', code: 'secret key private file' });
  await rejected;
  fatal.worker.close();
  const killed: number[] = [];
  const close = fixture({ terminateProcessTree: (pid) => killed.push(pid) });
  Object.assign(close.child, { pid: 912345 });
  close.worker.close();
  assert.deepEqual(killed, [912345]);
});

test('Pocket local validation and runtime status do not launch a model', async () => {
  for (const text of [
    '',
    ' ',
    'x'.repeat(241),
    '中文',
    'hello\nworld',
    '[laugh] hi',
    '<tag>',
    '!!!',
  ])
    assert.throws(() => validatePocketVoiceText(text), /INVALID_TEXT/);
  assert.equal(validatePocketVoiceText('  It’s fine.  '), 'It’s fine.');
  const f = fixture();
  try {
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(f.worker.synthesize('Hello.', abort.signal), {
      name: 'AbortError',
    });
    assert.equal(f.child.requests.length, 0);
  } finally {
    f.worker.close();
  }
  closePocketVoiceWorker();
  assert.deepEqual(pocketVoiceStatus(), {
    state: 'not_started',
    pendingJobs: 0,
  });
});

test('Pocket retains parent-exit cleanup during EOF grace and removes it after process close', async () => {
  const listenersBefore = process.listenerCount('exit');
  const f = fixture();
  f.child.ready();
  await f.worker.ready;
  assert.equal(process.listenerCount('exit'), listenersBefore + 1);
  f.worker.close();
  assert.equal(process.listenerCount('exit'), listenersBefore + 1);
  await delay(0); // Fake EOF closes asynchronously, as a real subprocess does.
  assert.equal(process.listenerCount('exit'), listenersBefore);
});

test('Pocket real subprocess fixture streams before done, stays resident and exits on EOF', async () => {
  const source = `
    const {createInterface} = require('node:readline');
    const {createHash} = require('node:crypto');
    const send = (x) => process.stdout.write(JSON.stringify(x)+'\\n');
    const reader = createInterface({input:process.stdin});
    reader.on('line',(line)=>{const {id}=JSON.parse(line);const pcm=Buffer.from([1,0,2,0]);const hash=createHash('sha256').update(pcm).digest('hex');
      send({type:'chunk',id,sequence:0,sampleRate:24000,pcm:pcm.toString('base64'),sha256:hash});
      setTimeout(()=>send({type:'done',id,chunks:1,bytes:pcm.length,sha256:hash,generationMs:40,audioMs:pcm.length/48}),40);
    }); reader.on('close',()=>process.exit(0)); send(${JSON.stringify(readyEvent)});
  `;
  let launches = 0;
  let child: ChildProcessWithoutNullStreams;
  let exited: Promise<void>;
  const worker = createPocketVoiceWorker({
    readyTimeoutMs: 3000,
    spawnWorker(_command, _args, options) {
      launches += 1;
      child = spawn(process.execPath, ['--input-type=commonjs', '-e', source], {
        ...options,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      exited = new Promise((resolve) => child.once('close', () => resolve()));
      return child;
    },
  });
  try {
    await worker.ready;
    const stream = worker.synthesizeStream('One.')[Symbol.asyncIterator]();
    assert.equal((await stream.next()).done, false);
    assert.equal(worker.status().pendingJobs, 1);
    assert.equal((await stream.next()).done, true);
    await worker.synthesize('Two.');
    assert.equal(launches, 1);
    worker.close();
    await Promise.race([
      exited,
      delay(2000).then(() => {
        throw new Error('EOF ignored');
      }),
    ]);
    assert.equal(child.exitCode, 0);
  } finally {
    worker.close();
    if (child.exitCode === null) child.kill();
  }
});

test(
  'Pocket EOF cleans its Linux process group while preserving an unrelated process',
  {
    skip: process.platform !== 'linux',
  },
  async () => {
    const unrelated = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        stdio: 'ignore',
      },
    );
    const source = `
    const {spawn} = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
    process.stdout.write(JSON.stringify({...${JSON.stringify(readyEvent)}, descendantPid:descendant.pid})+'\\n');
  `;
    let child: ChildProcessWithoutNullStreams;
    let descendantPid: number;
    let exited: Promise<void>;
    const worker = createPocketVoiceWorker({
      readyTimeoutMs: 3000,
      spawnWorker(_command, _args, options) {
        child = spawn(process.execPath, ['-e', source], {
          ...options,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stdout.once('data', (data) => {
          descendantPid = JSON.parse(data.toString()).descendantPid;
        });
        exited = new Promise((resolve) => child.once('close', () => resolve()));
        return child;
      },
    });
    async function running(pid: number): Promise<boolean> {
      try {
        // An orphan can remain a zombie until the container init reaps it;
        // a zombie cannot run or retain resources and is already terminated.
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        return (
          stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !==
          'Z'
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    }
    try {
      await worker.ready;
      assert.equal(await running(descendantPid), true);
      assert.equal(await running(unrelated.pid), true);
      worker.close();
      await Promise.race([
        exited,
        delay(2000).then(() => {
          throw new Error('EOF ignored');
        }),
      ]);
      for (
        let attempt = 0;
        attempt < 20 && (await running(descendantPid));
        attempt += 1
      )
        await delay(10);
      assert.equal(
        await running(descendantPid),
        false,
        'Owned descendant remained alive',
      );
      assert.equal(
        await running(unrelated.pid),
        true,
        'Unrelated process must be preserved',
      );
    } finally {
      worker.close();
      unrelated.kill('SIGKILL');
      if (child?.exitCode === null) child.kill('SIGKILL');
      if (descendantPid && (await running(descendantPid)))
        process.kill(descendantPid, 'SIGKILL');
    }
  },
);
