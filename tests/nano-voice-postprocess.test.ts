import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createNanoVoicePostprocessor, NANO_POSTPROCESS_PROFILE as PROFILE, type NanoVoicePostprocessOptions } from '../src/solo/nano-voice-postprocess';

// Portable process fixtures: no private executable, voice models, provider calls or network.
class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  chunks: Buffer[] = [];
  input: Buffer;
  killCount = 0;
  closeOnKill = true;
  stdin = new Writable({ write: (chunk, _encoding, callback) => { this.chunks.push(Buffer.from(chunk)); callback(); } });
  constructor(private readonly onInput: (child: FakeProcess) => void) {
    super();
    this.stdin.on('finish', () => { this.input = Buffer.concat(this.chunks); queueMicrotask(() => onInput(this)); });
  }
  kill() { this.killCount += 1; if (this.closeOnKill) this.emit('close', 1); return true; }
  complete(pcm: Buffer, code = 0) { this.stdout.write(pcm); this.emit('close', code); }
}

function fakeTempo(child: FakeProcess, amplitude = 500) {
  const originalSamples = child.input.length / 2 - 6000;
  const count = Math.ceil(originalSamples / PROFILE.tempo);
  const pcm = Buffer.alloc((count + Math.ceil(6000 / PROFILE.tempo)) * 2);
  for (let i = 0; i < count; i += 1) pcm.writeInt16LE(i % 2 ? -amplitude : amplitude, i * 2);
  return pcm;
}

function fixture(options: NanoVoicePostprocessOptions = {}, action: (child: FakeProcess) => void = child => child.complete(fakeTempo(child))) {
  const children: FakeProcess[] = [];
  const launches: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const hashes: string[] = [];
  const processor = createNanoVoicePostprocessor({
    hashBinary: async path => { hashes.push(path); return PROFILE.ffmpegSha256; },
    ...options,
    spawnProcess(command, args, settings) {
      const index = children.length;
      const child = new FakeProcess(current => {
        if (index === 0) current.complete(fakeTempo(current));
        else action(current);
      });
      children.push(child);
      launches.push({ command, args, options: settings });
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
  return { processor, children, launches, hashes };
}

function input(samples = 2400, amplitude = 1000) {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(i % 2 ? -amplitude : amplitude, i * 2);
  return pcm;
}

test('fixed hash and synthetic prewarm precede sentence jobs; pitch preserving atempo only, no secrets', async () => {
  process.env.NANO_TEST_PRIVATE_SECRET = 'not-in-child';
  const f = fixture();
  try {
    await f.processor.ready;
    assert.equal(f.hashes.length, 1);
    assert.equal(f.children.length, 1);
    const source = input();
    const result = await f.processor.process(source);
    assert.equal(f.children.length, 2);
    const launch = f.launches[1];
    assert.equal(launch.command, f.hashes[0]);
    assert.match(launch.command, /ffmpeg-win-x86_64-v7\.1\.exe$/);
    assert.equal(launch.args[launch.args.indexOf('-af') + 1], 'atempo=0.92');
    assert.equal(launch.options.windowsHide, true);
    assert.equal(launch.options.shell, false);
    assert.equal(launch.options.env.NANO_TEST_PRIVATE_SECRET, undefined);
    for (const name of Object.keys(launch.options.env)) assert.match(name.toUpperCase(), /^(SYSTEMROOT|WINDIR|TEMP|TMP)$/);
    assert.deepEqual(f.children[1].input.subarray(0, source.length), source);
    assert.deepEqual(f.children[1].input.subarray(source.length), Buffer.alloc(12000));
    assert.equal(result.metrics.tempo, .92);
    assert.equal(result.metrics.profile, 'b-092-gain3');
    assert.ok(result.metrics.outputAudioMs >= result.metrics.inputAudioMs / .92);
    assert.equal(result.metrics.retainedSyntheticTailMs, 20);
    assert.ok(Math.abs(result.metrics.gainDbApplied - 3) < 1e-12);
    assert.equal(result.metrics.clipCount, 0);
    assert.equal(result.metrics.inputPcmSha256, createHash('sha256').update(source).digest('hex'));
    assert.equal(result.metrics.outputPcmSha256, createHash('sha256').update(result.pcm).digest('hex'));
    assert.ok(result.metrics.processMs >= 0);
  } finally { f.processor.close(); delete process.env.NANO_TEST_PRIVATE_SECRET; }
});

test('uniform gain raises quiet samples without compressor, limits peaks and preserves polarity', async () => {
  let raw: Buffer;
  const f = fixture({}, child => {
    raw = fakeTempo(child, 32767);
    raw.writeInt16LE(-32768, 0);
    raw.writeInt16LE(10000, 2);
    child.complete(raw);
  });
  try {
    await f.processor.ready;
    const result = await f.processor.process(input());
    const ceiling = Math.floor(.85 * 32768);
    assert.equal(result.pcm.readInt16LE(0), -ceiling);
    assert.equal(result.pcm.readInt16LE(2), Math.round(10000 * ceiling / 32768));
    assert.ok(result.metrics.outputPeak <= .85);
    assert.ok(result.metrics.gainDbApplied < 0);
    assert.ok(result.metrics.tempoClipCount > 0);
    assert.equal(result.metrics.clipCount, 0);
    assert.equal(result.metrics.tempoPcmSha256, createHash('sha256').update(raw).digest('hex'));
  } finally { f.processor.close(); }
});

test('exact-zero trimming never cuts a nonzero tail or reduces below tempo adjusted source duration', async () => {
  let raw: Buffer;
  const f = fixture({}, child => {
    raw = fakeTempo(child, 10);
    raw.writeInt16LE(1, raw.length - 2);
    child.complete(raw);
  });
  try {
    await f.processor.ready;
    const result = await f.processor.process(input());
    assert.equal(result.pcm.length, raw.length);
    assert.equal(result.pcm.readInt16LE(result.pcm.length - 2), 1);
    assert.equal(result.metrics.removedExactZeroSamples, 0);
  } finally { f.processor.close(); }
  const silent = fixture({}, child => child.complete(Buffer.alloc(fakeTempo(child).length)));
  try {
    await silent.processor.ready;
    const source = input(24000);
    const result = await silent.processor.process(source);
    assert.equal(result.pcm.length / 2, Math.ceil(24000 / .92));
    assert.equal(result.metrics.retainedSyntheticTailMs, 0);
    assert.ok(result.metrics.removedExactZeroSamples <= Math.ceil(6000 / .92));
  } finally { silent.processor.close(); }
});

test('malformed, empty, nonbuffer and over20 second PCM fail without spawning work', async () => {
  const f = fixture();
  try {
    await f.processor.ready;
    for (const bad of [Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(960002), {}])
      await assert.rejects(f.processor.process(bad as Buffer), /INPUT_INVALID/);
    assert.equal(f.children.length, 1);
  } finally { f.processor.close(); }
});

test('one in flight job only, abort kills owned child and discards late output', async () => {
  const f = fixture({}, () => {});
  await f.processor.ready;
  const controller = new AbortController();
  const pending = f.processor.process(input(), controller.signal);
  await delay(1);
  await assert.rejects(f.processor.process(input()), /BUSY/);
  const child = f.children[1];
  child.closeOnKill = false;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(child.killCount, 1);
  await assert.rejects(f.processor.process(input()), /BUSY/);
  child.complete(fakeTempo(child));
  assert.equal(f.children[0].killCount, 0);
  f.processor.close();
  await assert.rejects(f.processor.process(input()), /ABORTED/);
});

test('timeout terminates only active child and rejects sanitized code', async () => {
  const f = fixture({ requestTimeoutMs: 15 }, () => {});
  try {
    await f.processor.ready;
    await assert.rejects(f.processor.process(input()), /NANO_POSTPROCESS_TIMEOUT/);
    assert.equal(f.children[1].killCount, 1);
    assert.equal(f.children[0].killCount, 0);
  } finally { f.processor.close(); }
});

test('hash mismatch or unavailable private binary never spawns', async () => {
  for (const hashBinary of [async () => '0'.repeat(64), async () => { throw new Error('secret path'); }]) {
    const f = fixture({ hashBinary });
    await assert.rejects(f.processor.ready, /NANO_POSTPROCESS_BINARY_(HASH_MISMATCH|UNAVAILABLE)/);
    await assert.rejects(f.processor.process(input()), /NANO_POSTPROCESS_BINARY_/);
    assert.equal(f.children.length, 0);
    f.processor.close();
  }
});

test('close or caller abort while awaiting readiness rejects immediately without starting a job', async () => {
  let release: (hash: string) => void;
  const f = fixture({ hashBinary: () => new Promise(resolve => { release = resolve; }) });
  const controller = new AbortController();
  const pending = f.processor.process(input(), controller.signal);
  controller.abort();
  await assert.rejects(pending, /ABORTED/);
  const waiting = f.processor.process(input());
  f.processor.close();
  await assert.rejects(waiting, /ABORTED/);
  release(PROFILE.ffmpegSha256);
  await assert.rejects(f.processor.ready, /ABORTED/);
  assert.equal(f.children.length, 0);
});

test('oversized stdout and stderr fail closed with bounded storage and owned termination', async () => {
  for (const [stream, bytes, code] of [['stdout', 1080002, 'OUTPUT_LIMIT'], ['stderr', 16385, 'STDERR_LIMIT']] as const) {
    const f = fixture({}, child => { child[stream].write(Buffer.alloc(bytes)); });
    try {
      await f.processor.ready;
      await assert.rejects(f.processor.process(input()), new RegExp(code));
      assert.equal(f.children[1].killCount, 1);
    } finally { f.processor.close(); }
  }
});

test('odd, empty, truncated and over22 second retained output rejected; process messages sanitized', async () => {
  for (const action of [
    (child: FakeProcess) => child.complete(Buffer.alloc(1)),
    (child: FakeProcess) => child.complete(Buffer.alloc(0)),
    (child: FakeProcess) => child.complete(Buffer.alloc(4)),
    (child: FakeProcess) => { const output = Buffer.alloc(22 * 48000 + 2); output.writeInt16LE(1, output.length - 2); child.complete(output); },
    (child: FakeProcess) => { child.stderr.write('sensitive private environment'); child.emit('error', new Error('private detail')); },
  ]) {
    const f = fixture({}, action);
    try {
      await f.processor.ready;
      await assert.rejects(f.processor.process(input()), error => {
        assert.match((error as Error).message, /^NANO_POSTPROCESS_(OUTPUT_INVALID|PROCESS_FAILED)$/);
        return true;
      });
    } finally { f.processor.close(); }
  }
});

test('input is snapshotted, preaborted jobs do not spawn, close aborts active work', async () => {
  let release: (hash: string) => void;
  const f = fixture({ hashBinary: () => new Promise(resolve => { release = resolve; }) });
  const source = input();
  const hash = createHash('sha256').update(source).digest('hex');
  const pending = f.processor.process(source);
  source.fill(0);
  release(PROFILE.ffmpegSha256);
  assert.equal((await pending).metrics.inputPcmSha256, hash);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.processor.process(input(), controller.signal), /ABORTED/);
  assert.equal(f.children.length, 2);
  f.processor.close();
  const active = fixture({}, () => {});
  await active.processor.ready;
  const unfinished = active.processor.process(input());
  await delay(1);
  active.processor.close();
  await assert.rejects(unfinished, /ABORTED/);
  assert.equal(active.children[1].killCount, 1);
});
