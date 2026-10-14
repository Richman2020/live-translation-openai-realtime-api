import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import {
  createRealtimePrototypeInput,
  type RealtimePrototypeInput,
  type RealtimePrototypeInputEvent,
  type RealtimePrototypeInputOptions,
} from '../src/solo/realtime-prototype-input';

type Commit = Extract<RealtimePrototypeInputEvent, { type: 'commit' }>;

function pcm(ms: number, amplitude = 2500): Buffer {
  const buffer = Buffer.alloc(ms * 48);
  for (let index = 0; index < buffer.length / 2; index += 1)
    buffer.writeInt16LE(amplitude, index * 2);
  return buffer;
}

function appendBytes(events: RealtimePrototypeInputEvent[]): Buffer {
  return Buffer.concat(
    events.flatMap((event) => (event.type === 'append' ? [event.pcm] : [])),
  );
}

function commits(events: RealtimePrototypeInputEvent[]): Commit[] {
  return events.filter((event): event is Commit => event.type === 'commit');
}

function feed(
  input: RealtimePrototypeInput,
  source: Buffer,
  chunkSizes: number[],
  finish = true,
): RealtimePrototypeInputEvent[] {
  const events: RealtimePrototypeInputEvent[] = [];
  let step = 0;
  for (let offset = 0; offset < source.length; ) {
    const length = chunkSizes[step % chunkSizes.length];
    events.push(...input.append(source.subarray(offset, offset + length)));
    offset += length;
    step += 1;
  }
  if (finish) events.push(...input.flush());
  return events;
}

function assertOrdered(events: RealtimePrototypeInputEvent[]): void {
  let expectedSequence = 1;
  let bytes = 0;
  let startAtMs: number | undefined;
  let endAtMs: number | undefined;
  let epoch: number | undefined;
  for (const event of events) {
    assert.equal(event.sourceSequence, expectedSequence);
    assert.equal(Number.isSafeInteger(event.epoch), true);
    if (epoch === undefined) epoch = event.epoch;
    assert.equal(event.epoch, epoch);
    if (event.type === 'append') {
      assert.equal(event.pcm.length % 2, 0);
      assert.ok(event.pcm.length > 0);
      if (startAtMs === undefined) startAtMs = event.startAtMs;
      else assert.equal(event.startAtMs, endAtMs);
      bytes += event.pcm.length;
      endAtMs = event.endAtMs;
    } else {
      assert.ok(bytes >= (event.reason === 'flush' ? 2 : 4800));
      assert.equal(event.startAtMs, startAtMs);
      assert.equal(event.endAtMs, endAtMs);
      assert.equal(event.inputMs, bytes / 48);
      assert.ok(event.speechMs > 0);
      assert.ok(event.speechMs <= event.inputMs);
      expectedSequence += 1;
      bytes = 0;
      startAtMs = undefined;
      endAtMs = undefined;
    }
  }
  assert.equal(bytes, 0);
}

test('a normal phrase commits after actual input speech and 600ms pause, without wall clocks', () => {
  const input = createRealtimePrototypeInput({ preRollMs: 0 });
  const events = input.append(pcm(600));
  assert.equal(commits(events).length, 0);
  events.push(...input.append(pcm(590, 0)));
  assert.equal(commits(events).length, 0);
  events.push(...input.append(pcm(10, 0)));
  assert.deepEqual(commits(events), [
    {
      type: 'commit',
      epoch: 1,
      sourceSequence: 1,
      startAtMs: 0,
      endAtMs: 1200,
      inputMs: 1200,
      speechMs: 600,
      reason: 'pause',
    },
  ]);
  assert.equal(input.hasPending(), false);
  assertOrdered(events);
});

test('brief pauses and stutter-like energy bursts accumulate without one commit per burst', () => {
  const source = Buffer.concat([
    pcm(150),
    pcm(200, 0),
    pcm(150),
    pcm(250, 0),
    pcm(150),
    pcm(300, 0),
    pcm(150),
    pcm(600, 0),
  ]);
  const events = feed(createRealtimePrototypeInput({ preRollMs: 0 }), source, [
    960,
  ]);
  assert.equal(commits(events).length, 1);
  assert.equal(commits(events)[0].reason, 'pause');
  assert.equal(commits(events)[0].speechMs, 600);
  assert.equal(commits(events)[0].inputMs, 1950);
  assert.deepEqual(appendBytes(events), source);
  assertOrdered(events);
});

test('a short single burst waits past its pause but is eventually bounded by the 4s window', () => {
  const input = createRealtimePrototypeInput({ preRollMs: 0 });
  const source = Buffer.concat([pcm(100), pcm(3900, 0)]);
  const events = input.append(source.subarray(0, 3990 * 48));
  assert.equal(commits(events).length, 0);
  events.push(...input.append(source.subarray(3990 * 48)));
  assert.equal(commits(events).length, 1);
  assert.equal(commits(events)[0].reason, 'window');
  assert.equal(commits(events)[0].inputMs, 4000);
  assert.equal(commits(events)[0].speechMs, 100);
  assert.deepEqual(appendBytes(events), source);
  assertOrdered(events);
});

test('120s continuous speech emits 30 finite windows with each source sample appended exactly once', () => {
  const source = pcm(120000);
  for (let sample = 0; sample < source.length / 2; sample += 1)
    source.writeInt16LE(1000 + (sample % 10000), sample * 2);
  const input = createRealtimePrototypeInput({ preRollMs: 0 });
  const events = feed(input, source, [777, 3211, 1, 960, 5003]);
  const segments = commits(events);
  assert.equal(segments.length, 30);
  assert.ok(segments.every((event) => event.reason === 'window'));
  assert.ok(segments.every((event) => event.inputMs === 4000));
  assert.ok(segments.every((event) => event.speechMs === 4000));
  assert.equal(segments[0].startAtMs, 0);
  assert.equal(segments.at(-1).endAtMs, 120000);
  assert.deepEqual(appendBytes(events), source);
  assert.equal(input.hasPending(), false);
  assertOrdered(events);
});

test('arbitrary odd byte chunks preserve frame decisions, sample ordering and commits', () => {
  const source = Buffer.concat([
    pcm(900),
    pcm(200, 0),
    pcm(700),
    pcm(600, 0),
    pcm(1300),
    pcm(590, 0),
    pcm(1330),
  ]);
  const options = { preRollMs: 0 };
  const regular = feed(createRealtimePrototypeInput(options), source, [48000]);
  const fragmented = feed(
    createRealtimePrototypeInput(options),
    source,
    [1, 3, 17, 481, 5, 2011],
  );
  assert.deepEqual(commits(fragmented), commits(regular));
  assert.deepEqual(appendBytes(fragmented), source);
  assert.deepEqual(appendBytes(regular), source);
  assertOrdered(fragmented);
  assertOrdered(regular);
});

test('pure silence and low energy input do not append or generate unbounded empty commits', () => {
  const input = createRealtimePrototypeInput();
  for (let index = 0; index < 1200; index += 1)
    assert.deepEqual(input.append(pcm(100, index % 2 ? 0 : 100)), []);
  assert.equal(input.hasPending(), false);
  assert.deepEqual(input.flush(), []);
  assert.equal(input.hasPending(), false);
});

test('idle pre-roll is bounded, source-clocked and never overlaps a previous committed sample', () => {
  const input = createRealtimePrototypeInput();
  const events: RealtimePrototypeInputEvent[] = [];
  for (let index = 0; index < 50; index += 1)
    events.push(...input.append(pcm(100, 0)));
  assert.equal(events.length, 0);
  assert.equal(input.hasPending(), false);
  events.push(...input.append(pcm(600)));
  events.push(...input.append(pcm(600, 0)));
  for (let index = 0; index < 50; index += 1)
    events.push(...input.append(pcm(100, 0)));
  events.push(...input.append(pcm(600)));
  events.push(...input.append(pcm(600, 0)));
  assert.equal(commits(events).length, 2);
  assert.deepEqual(
    commits(events).map((event) => [
      event.startAtMs,
      event.endAtMs,
      event.inputMs,
    ]),
    [
      [4900, 6200, 1300],
      [11100, 12400, 1300],
    ],
  );
  assert.deepEqual(
    appendBytes(events),
    Buffer.concat([
      pcm(100, 0),
      pcm(600),
      pcm(600, 0),
      pcm(100, 0),
      pcm(600),
      pcm(600, 0),
    ]),
  );
  assertOrdered(events);
});

test('exactly 100ms and shorter final source tails are committed as actual PCM without padding', () => {
  const input = createRealtimePrototypeInput({ preRollMs: 0 });
  assert.deepEqual(input.append(pcm(90)), []);
  const events = input.append(pcm(10));
  assert.equal(commits(events).length, 0);
  events.push(...input.flush());
  assert.deepEqual(appendBytes(events), pcm(100));
  assert.equal(commits(events)[0].inputMs, 100);
  assert.equal(commits(events)[0].reason, 'flush');
  assertOrdered(events);
  const shorter = createRealtimePrototypeInput({ preRollMs: 0 });
  assert.deepEqual(shorter.append(pcm(99)), []);
  assert.equal(shorter.hasPending(), true);
  const shortEvents = shorter.flush();
  assert.equal(appendBytes(shortEvents).equals(pcm(99)), true);
  assert.equal(commits(shortEvents).length, 1);
  assert.equal(commits(shortEvents)[0].inputMs, 99);
  assert.equal(commits(shortEvents)[0].reason, 'flush');
  assert.equal(shorter.hasPending(), false);
  assertOrdered(shortEvents);
});

test('flush preserves a real 38ms source tail after a four-second window without overlap or padding', () => {
  const source = Buffer.concat([pcm(4000, 2500), pcm(38, -3000)]);
  const events = feed(
    createRealtimePrototypeInput({ preRollMs: 0 }),
    source,
    [7999, 1, 301],
  );
  assert.equal(appendBytes(events).equals(source), true);
  assert.deepEqual(
    commits(events).map((event) => [event.reason, event.inputMs]),
    [
      ['window', 4000],
      ['flush', 38],
    ],
  );
  const tailBytes = Buffer.concat(
    events.flatMap((event) =>
      event.type === 'append' && event.sourceSequence === 2 ? [event.pcm] : [],
    ),
  );
  assert.deepEqual(tailBytes, pcm(38, -3000));
  assertOrdered(events);
});

test('a final single complete active PCM sample is preserved while an incomplete byte is not invented', () => {
  const source = Buffer.alloc(2);
  source.writeInt16LE(-2800);
  const input = createRealtimePrototypeInput({ preRollMs: 0 });
  assert.deepEqual(input.append(source.subarray(0, 1)), []);
  assert.deepEqual(input.append(source.subarray(1)), []);
  const events = input.flush();
  assert.deepEqual(appendBytes(events), source);
  assert.equal(commits(events).length, 1);
  assert.equal(commits(events)[0].inputMs, 1 / 24);
  assertOrdered(events);
  const incomplete = createRealtimePrototypeInput();
  assert.deepEqual(incomplete.append(Buffer.from([0x80])), []);
  assert.throws(() => incomplete.flush(), new Error('INVALID_PCM_TAIL'));
});

test('a configured short pause cannot silently discard a buffer below the engineering minimum', () => {
  const input = createRealtimePrototypeInput({
    maxWindowMs: 100,
    minSpeechMs: 10,
    pauseMs: 10,
    preRollMs: 0,
  });
  const source = Buffer.concat([pcm(10), pcm(90, 0)]);
  const events = feed(input, source, [48]);
  assert.deepEqual(appendBytes(events), source);
  assert.equal(commits(events).length, 1);
  assert.equal(commits(events)[0].inputMs, 100);
  assertOrdered(events);
});

test('flush drains a partial final PCM frame and is terminal/idempotent', () => {
  const source = pcm(104);
  const input = createRealtimePrototypeInput({ preRollMs: 0 });
  const events = feed(input, source, [33, 477, 121]);
  assert.deepEqual(appendBytes(events), source);
  assert.equal(commits(events).length, 1);
  assert.equal(commits(events)[0].inputMs, 104);
  assert.equal(input.hasPending(), false);
  assert.deepEqual(input.flush(), []);
  assert.deepEqual(input.append(pcm(1000)), []);
  assertOrdered(events);
});

test('malformed odd-byte final input reports a fixed fault and becomes inert without inventing a sample', () => {
  const input = createRealtimePrototypeInput({ preRollMs: 0 });
  const validSamples = pcm(104);
  const events = input.append(
    Buffer.concat([validSamples, Buffer.from([0xff])]),
  );
  assert.deepEqual(appendBytes(events), pcm(100));
  assert.equal(commits(events).length, 0);
  assert.throws(() => input.flush(), new Error('INVALID_PCM_TAIL'));
  assert.equal(input.hasPending(), false);
  assert.deepEqual(input.flush(), []);
  assert.deepEqual(input.append(pcm(100)), []);
  assert.equal(input.reset(), 2);
  const newEvents = feed(input, pcm(10), [1, 3]);
  assert.deepEqual(appendBytes(newEvents), pcm(10));
  assert.equal(commits(newEvents)[0].epoch, 2);
});

test('flush after a window boundary does not repeat or create a silent final source', () => {
  const source = Buffer.concat([pcm(4000), pcm(900, 0)]);
  const events = feed(createRealtimePrototypeInput(), source, [4800]);
  assert.equal(commits(events).length, 1);
  assert.equal(commits(events)[0].reason, 'window');
  assert.deepEqual(appendBytes(events), pcm(4000));
  assertOrdered(events);
});

test('abort drops unsent tails and makes the old epoch inert until an explicit reset', () => {
  const input = createRealtimePrototypeInput({ epoch: 7, preRollMs: 0 });
  assert.deepEqual(input.append(pcm(90)), []);
  assert.equal(input.hasPending(), true);
  input.abort();
  assert.equal(input.hasPending(), false);
  assert.deepEqual(input.append(pcm(500)), []);
  assert.deepEqual(input.flush(), []);
  assert.equal(input.reset(), 8);
  const newEvents = feed(input, pcm(100), [19]);
  assert.ok(newEvents.every((event) => event.epoch === 8));
  assert.equal(commits(newEvents)[0].sourceSequence, 1);
  assert.equal(commits(newEvents)[0].startAtMs, 0);
  assert.deepEqual(appendBytes(newEvents), pcm(100));
  assertOrdered(newEvents);
});

test('reset after appended but uncommitted audio never replays old source or timing', () => {
  const input = createRealtimePrototypeInput({ preRollMs: 0 });
  const oldEvents = input.append(pcm(1000, 2000));
  assert.equal(commits(oldEvents).length, 0);
  assert.equal(input.hasPending(), true);
  input.abort();
  assert.equal(input.reset(42), 42);
  const newEvents = feed(input, pcm(200, 3000), [57, 101]);
  assert.deepEqual(appendBytes(oldEvents), pcm(1000, 2000));
  assert.deepEqual(appendBytes(newEvents), pcm(200, 3000));
  assert.ok(oldEvents.every((event) => event.epoch === 1));
  assert.ok(newEvents.every((event) => event.epoch === 42));
  assert.equal(commits(newEvents)[0].sourceSequence, 1);
  assert.equal(commits(newEvents)[0].startAtMs, 0);
  assertOrdered(newEvents);
});

test('buffer mutation by caller cannot alter held PCM or previously returned events', () => {
  const input = createRealtimePrototypeInput({ preRollMs: 0 });
  const first = pcm(50, 1000);
  assert.deepEqual(input.append(first), []);
  first.fill(0);
  const second = pcm(50, 2000);
  const events = input.append(second);
  second.fill(0);
  assert.deepEqual(
    appendBytes(events),
    Buffer.concat([pcm(50, 1000), pcm(50, 2000)]),
  );
  events.push(...input.flush());
  assertOrdered(events);
});

test('per-message bytes are bounded without imposing any cumulative call duration cap', () => {
  const input = createRealtimePrototypeInput({
    maxAppendBytes: 4800,
    preRollMs: 0,
  });
  assert.throws(() => input.append(Buffer.alloc(4801)), RangeError);
  const events: RealtimePrototypeInputEvent[] = [];
  for (let index = 0; index < 60; index += 1)
    events.push(...input.append(pcm(100)));
  events.push(...input.flush());
  assert.equal(commits(events).at(-1).endAtMs, 6000);
  assert.deepEqual(appendBytes(events), pcm(6000));
  assertOrdered(events);
});

test('invalid finite bounds, PCM format and non-increasing epochs fail before processing audio', () => {
  const invalid: RealtimePrototypeInputOptions[] = [
    { epoch: 0 },
    { epoch: NaN },
    { epoch: 1.5 },
    { sampleRate: 16000 },
    { sampleRate: Infinity },
    { maxWindowMs: 4010 },
    { maxWindowMs: 90 },
    { maxWindowMs: 100.5 },
    { minBufferMs: 90 },
    { minBufferMs: 4010 },
    { minSpeechMs: 0 },
    { minSpeechMs: 4100 },
    { pauseMs: 0 },
    { pauseMs: 1 },
    { pauseMs: Infinity },
    { preRollMs: -10 },
    { preRollMs: 210 },
    { energyThreshold: 0 },
    { energyThreshold: NaN },
    { energyThreshold: 32769 },
    { maxAppendBytes: 1 },
    { maxAppendBytes: 2 ** 20 + 1 },
  ];
  for (const options of invalid)
    assert.throws(() => createRealtimePrototypeInput(options), RangeError);
  const input = createRealtimePrototypeInput();
  for (const epoch of [0, 1, 1.5, NaN, Infinity])
    assert.throws(() => input.reset(epoch), RangeError);
  assert.equal(input.epoch, 1);
  assert.throws(() => input.append('not PCM' as unknown as Buffer), TypeError);
  assert.equal(input.hasPending(), false);
  assert.deepEqual(input.append(Buffer.alloc(0)), []);
});
