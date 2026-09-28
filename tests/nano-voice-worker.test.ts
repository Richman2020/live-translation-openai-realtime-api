import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';

import { createNanoVoiceWorker, validateNanoVoiceText, type NanoVoiceWorkerOptions } from '../src/solo/nano-voice-worker';

// No voice model, GPU, credentials or telephone providers are used in these IPC fixtures.
class FakeWorker extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  requests: { id: string; text: string }[] = [];
  killCount = 0;
  ended = false;
  stdin = new Writable({ write: (chunk, _encoding, callback) => {
    this.requests.push(JSON.parse(chunk.toString('utf8')));
    callback();
  } });

  constructor() {
    super();
    this.stdin.on('finish', () => { this.ended = true; queueMicrotask(() => this.emit('close', 0)); });
  }

  kill() { this.killCount += 1; this.emit('close', 1); return true; }
  send(value: unknown) { this.stdout.write(`${JSON.stringify(value)}\n`); }
  ready() {
    this.send({ type: 'ready', protocol: 1, sampleRate: 24000, channels: 1,
      encoding: 'pcm_s16le', mode: 'synthesis-cuda', temperature: 0.75, maxTextChars: 240 });
  }
  audio(index = 0, overrides: Record<string, unknown> = {}) {
    const pcm = Buffer.from([1, 0, 8, 0, 30, 0, 2, 0]);
    const event = { type: 'audio', id: this.requests[index].id, sampleRate: 24000,
      pcm: pcm.toString('base64'), metrics: { generationMs: 80, audioMs: pcm.length / 48,
        t3Ms: 30, decoderMs: 40, watermarkMs: 10, tokenCount: 2, tokenSha256: 'a'.repeat(64),
        pcmSha256: createHash('sha256').update(pcm).digest('hex'), temperature: 0.75, seed: 1709,
        privateText: 'must never propagate' }, ...overrides };
    this.send(event);
  }
}

function fixture(options: NanoVoiceWorkerOptions = {}) {
  const child = new FakeWorker();
  let launch: { command: string; args: string[]; options: SpawnOptions };
  const worker = createNanoVoiceWorker({ ...options, spawnWorker(command, args, settings) {
    launch = { command, args, options: settings };
    return child as unknown as ChildProcessWithoutNullStreams;
  } });
  return { worker, child, launch: () => launch };
}

test('Nano starts once with fixed private runtime and no provider env, and sends only after ready', async () => {
  const previous = process.env.NANOVOICE_TEST_SECRET;
  process.env.NANOVOICE_TEST_SECRET = 'private-fixture-secret';
  const f = fixture();
  try {
    const launch = f.launch();
    assert.match(launch.command, /chatterbox-nano-gpu-lab[\\/]venv[\\/]Scripts[\\/]python\.exe$/);
    assert.match(launch.args[1], /scripts[\\/]nano-voice-worker\.py$/);
    assert.equal(launch.options.windowsHide, true);
    assert.equal(launch.options.shell, false);
    assert.equal(launch.options.env.NANOVOICE_TEST_SECRET, undefined);
    for (const key of Object.keys(launch.options.env)) assert.doesNotMatch(key, /OPENAI|TWILIO|TOKEN$|PASSWORD|API_KEY/);
    const pending = f.worker.synthesize('Hello, thank you for calling.');
    assert.equal(f.child.requests.length, 0);
    f.child.stderr.write('private path and model progress');
    f.child.ready();
    await f.worker.ready;
    assert.equal(f.child.requests.length, 1);
    assert.deepEqual(Object.keys(f.child.requests[0]).sort(), ['id', 'text']);
    f.child.audio();
    const result = await pending;
    assert.equal(result.sampleRate, 24000);
    assert.deepEqual(result.pcm, Buffer.from([1, 0, 8, 0, 30, 0, 2, 0]));
    assert.equal((result.metrics as any).privateText, undefined);
    assert.equal(f.worker.status().pendingJobs, 0);
  } finally {
    f.worker.close();
    if (previous === undefined) delete process.env.NANOVOICE_TEST_SECRET;
    else process.env.NANOVOICE_TEST_SECRET = previous;
  }
});

test('Nano serializes jobs and bounds queue including an active cancelled job', async () => {
  const f = fixture({ maxQueuedJobs: 2 });
  try {
    f.child.ready(); await f.worker.ready;
    const abort = new AbortController();
    const first = f.worker.synthesize('First sentence.', abort.signal);
    const firstRejected = assert.rejects(first, { name: 'AbortError', message: 'NANOVOICE_ABORTED' });
    const second = f.worker.synthesize('Second sentence.');
    await assert.rejects(f.worker.synthesize('Third sentence.'), /NANOVOICE_QUEUE_FULL/);
    assert.equal(f.child.requests.length, 1);
    abort.abort();
    await firstRejected;
    assert.equal(f.child.requests.length, 1);
    assert.equal(f.worker.status().pendingJobs, 2);
    f.child.audio(0); // Stale first audio must never resolve the second request.
    assert.equal(f.child.requests.length, 2);
    f.child.audio(1);
    assert.equal((await second).id, f.child.requests[1].id);
  } finally { f.worker.close(); }
});

test('Nano queued cancellation never writes its text into worker stdin', async () => {
  const f = fixture();
  try {
    f.child.ready(); await f.worker.ready;
    const first = f.worker.synthesize('First sentence.');
    const abort = new AbortController();
    const cancelled = f.worker.synthesize('Cancelled private sentence.', abort.signal);
    const rejected = assert.rejects(cancelled, /NANOVOICE_ABORTED/);
    abort.abort(); await rejected;
    f.child.audio(0); await first;
    assert.equal(f.child.requests.length, 1);
    assert.equal(f.worker.status().pendingJobs, 0);
  } finally { f.worker.close(); }
});

test('Nano rejects unsafe/unsupported text locally and a pre-aborted signal', async () => {
  for (const text of ['', ' ', 'x'.repeat(241), '中文', 'Hello\nthere.', '[laugh] hello', '<tag>hello', '\u0000', '!!!']) {
    assert.throws(() => validateNanoVoiceText(text), /NANOVOICE_INVALID_TEXT/);
  }
  assert.equal(validateNanoVoiceText('  It’s five.  '), 'It’s five.');
  const f = fixture();
  try {
    const abort = new AbortController(); abort.abort();
    await assert.rejects(f.worker.synthesize('Hello.', abort.signal), { name: 'AbortError' });
    await assert.rejects(f.worker.synthesize('中文'), /NANOVOICE_INVALID_TEXT/);
    assert.equal(f.child.requests.length, 0);
  } finally { f.worker.close(); }
});

test('Nano validates fragmented JSONL and the audio payload binding', async () => {
  const f = fixture();
  try {
    const ready = JSON.stringify({ type: 'ready', protocol: 1, sampleRate: 24000, channels: 1,
      encoding: 'pcm_s16le', mode: 'synthesis-cuda', temperature: 0.75, maxTextChars: 240 });
    f.child.stdout.write(ready.slice(0, 25));
    assert.equal(f.worker.status().state, 'starting');
    f.child.stdout.write(`${ready.slice(25)}\n`);
    await f.worker.ready;
    const job = f.worker.synthesize('Hello.');
    const rejected = assert.rejects(job, /NANOVOICE_PROTOCOL_ERROR/);
    f.child.audio(0, { pcm: 'AAAAAA==' }); // Valid base64, wrong PCM hash/duration.
    await rejected;
    assert.equal(f.worker.status().state, 'failed');
  } finally { f.worker.close(); }
});

test('Nano rejects unexpected ids, unsolicited output and malformed/oversized frames', async () => {
  for (const raw of ['private-text model log\n', `${JSON.stringify({ type: 'audio', id: 'wrong' })}\n`, 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    const f = fixture();
    try {
      const rejected = assert.rejects(f.worker.ready, /NANOVOICE_PROTOCOL_ERROR/);
      f.child.stdout.write(raw);
      await rejected;
      assert.equal(f.child.killCount, 1);
    } finally { f.worker.close(); }
  }
});

test('Nano startup, deadline and worker failures reject safely without leaking details', async () => {
  const start = fixture({ readyTimeoutMs: 10 });
  try { await assert.rejects(start.worker.ready, /NANOVOICE_READY_TIMEOUT/); }
  finally { start.worker.close(); }

  const job = fixture({ jobTimeoutMs: 10 });
  try {
    job.child.ready(); await job.worker.ready;
    await assert.rejects(job.worker.synthesize('Hello.'), /NANOVOICE_JOB_TIMEOUT/);
    assert.equal(job.child.killCount, 1);
  } finally { job.worker.close(); }

  const exited = fixture();
  try {
    const rejected = assert.rejects(exited.worker.ready, { message: 'NANOVOICE_START_FAILED' });
    exited.child.emit('error', new Error('secret-token private-path'));
    await rejected;
  } finally { exited.worker.close(); }

  const fatal = fixture();
  try {
    const rejected = assert.rejects(fatal.worker.ready, { message: 'NANOVOICE_WORKER_FAILED' });
    fatal.child.send({ type: 'fatal', code: 'private-path secret' });
    await rejected;
  } finally { fatal.worker.close(); }
});

test('Nano close rejects active/queued jobs and late output cannot revive it', async () => {
  const f = fixture();
  f.child.ready(); await f.worker.ready;
  const first = assert.rejects(f.worker.synthesize('Hello.'), /NANOVOICE_CLOSED/);
  const second = assert.rejects(f.worker.synthesize('Goodbye.'), /NANOVOICE_CLOSED/);
  f.worker.close(); f.worker.close();
  f.child.audio();
  await Promise.all([first, second]);
  await delay(1);
  assert.equal(f.child.ended, true);
  assert.equal(f.worker.status().state, 'closed');
  await assert.rejects(f.worker.synthesize('Another call.'), /NANOVOICE_NOT_READY/);
});

test('Nano refuses audio beyond the 20 second telephone candidate boundary', async () => {
  const f = fixture();
  try {
    f.child.ready(); await f.worker.ready;
    const rejected = assert.rejects(f.worker.synthesize('Hello.'), /NANOVOICE_PROTOCOL_ERROR/);
    const pcm = Buffer.alloc(24000 * 2 * 20 + 2);
    f.child.audio(0, { pcm: pcm.toString('base64'), metrics: {
      generationMs: 80, audioMs: pcm.length / 48, t3Ms: 30, decoderMs: 40, watermarkMs: 10,
      tokenCount: 500, tokenSha256: 'a'.repeat(64), pcmSha256: createHash('sha256').update(pcm).digest('hex'),
      temperature: 0.75, seed: 1709,
    } });
    await rejected;
  } finally { f.worker.close(); }
});

test('Nano startup close and timeout terminate only the owned Windows launcher tree', async () => {
  for (const timeout of [false, true]) {
    const killedPids: number[] = [];
    const f = fixture({ readyTimeoutMs: timeout ? 10 : 1000,
      terminateProcessTree: (pid) => killedPids.push(pid) });
    Object.assign(f.child, { pid: 912345 }); // Only the injected terminator sees this fixture pid.
    const rejected = assert.rejects(f.worker.ready,
      timeout ? /NANOVOICE_READY_TIMEOUT/ : /NANOVOICE_CLOSED/);
    if (!timeout) f.worker.close();
    await rejected;
    if (process.platform === 'win32') assert.deepEqual(killedPids, [912345]);
    else assert.deepEqual(killedPids, []);
    assert.equal(f.child.killCount, 1);
    f.worker.close();
  }
});

test('Nano manager works over real subprocess pipes, stays resident and closes on stdin EOF', async () => {
  const fakeProgram = `
    const { createInterface } = require('node:readline');
    const { createHash } = require('node:crypto');
    const send = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
    const reader = createInterface({ input: process.stdin });
    reader.on('line', (line) => {
      const job = JSON.parse(line);
      const pcm = Buffer.from([1, 0, 2, 0]);
      setTimeout(() => send({type:'audio', id:job.id, sampleRate:24000, pcm:pcm.toString('base64'),
        metrics:{generationMs:5,audioMs:pcm.length/48,t3Ms:2,decoderMs:2,watermarkMs:1,
          tokenCount:2,tokenSha256:'a'.repeat(64),pcmSha256:createHash('sha256').update(pcm).digest('hex'),
          temperature:0.75,seed:1709}}), 5);
    });
    reader.on('close', () => process.exit(0));
    process.stderr.write('fake model diagnostic, never part of stdout protocol\\n');
    send({type:'ready',protocol:1,sampleRate:24000,channels:1,encoding:'pcm_s16le',
      mode:'synthesis-cuda',temperature:0.75,maxTextChars:240});
  `;
  let count = 0;
  let child: ChildProcessWithoutNullStreams;
  let exited: Promise<void>;
  const worker = createNanoVoiceWorker({ readyTimeoutMs: 3000,
    spawnWorker(_command, _args, settings) {
      count += 1;
      child = spawn(process.execPath, ['--input-type=commonjs', '-e', fakeProgram],
        { ...settings, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
      exited = new Promise((resolve) => child.once('close', () => resolve()));
      return child;
    },
  });
  try {
    await worker.ready;
    const a = await worker.synthesize('First sentence.');
    const b = await worker.synthesize('Second sentence.');
    assert.notEqual(a.id, b.id);
    assert.deepEqual(a.pcm, b.pcm);
    assert.equal(count, 1);
    worker.close();
    await Promise.race([exited, delay(2000).then(() => { throw new Error('Fake worker ignored EOF'); })]);
    assert.equal(child.exitCode, 0);
  } finally { worker.close(); if (child.exitCode === null) child.kill(); }
});
