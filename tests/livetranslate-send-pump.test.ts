import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createLiveTranslateSendPump,
  LIVE_TRANSLATE_PENDING_INPUT_BYTES,
  LIVE_TRANSLATE_SEND_WAIT_MS,
  LIVE_TRANSLATE_TRANSPORT_BUFFER_BYTES,
  type SendFailure,
  type SendObservation,
} from '../src/experiments/livetranslate-send-pump';

/** Artificial scheduling fixtures, not a replay of the missing incident send. */
function fixture() {
  let clock = 0;
  let timerSequence = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const sent: string[] = [];
  const callbacks: ((error?: Error) => void)[] = [];
  const observations: SendObservation[] = [];
  const failures: SendFailure[] = [];
  const defer = (callback: () => void, delay: number) => {
    timerSequence += 1;
    const sequence = timerSequence;
    timers.set(sequence, { due: clock + delay, callback });
    return sequence as unknown as ReturnType<typeof setTimeout>;
  };
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(wire: string, callback: (error?: Error) => void) {
      sent.push(wire);
      callbacks.push(callback);
    },
  };
  const pump = createLiveTranslateSendPump({
    socket,
    now: () => 1792110000000 + clock,
    monotonicNow: () => clock,
    schedule: defer,
    cancelSchedule: (timer) => {
      timers.delete(timer as unknown as number);
    },
    onObservation: (event) => observations.push(event),
    onFailure: (event) => failures.push(event),
  });
  const advance = (delta: number) => {
    const until = clock + delta;
    let turns = 0;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.due <= until)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      turns += 1;
      assert.ok(turns < 10000, 'finite scheduler work');
      timers.delete(next[0]);
      clock = next[1].due;
      next[1].callback();
    }
    clock = until;
  };
  const append = (wire = 'synthetic-audio', bytes = 640) =>
    pump.enqueue(wire, 'input_audio_buffer.append', bytes);
  const elapseWithoutDispatch = (delta: number) => {
    clock += delta;
  };
  return {
    socket,
    pump,
    append,
    sent,
    callbacks,
    observations,
    failures,
    advance,
    elapseWithoutDispatch,
    defer,
    timers,
  };
}

test('phone input submits audio once in FIFO order and distinguishes admission from write completion', () => {
  const f = fixture();
  f.append('first');
  f.append('second');
  f.append('third');
  assert.deepEqual(f.sent, ['first', 'second', 'third']);
  assert.equal(f.pump.snapshot().acceptedAudioBytes, 1920);
  assert.equal(f.pump.snapshot().writtenAudioBytes, 0);
  assert.equal(f.pump.snapshot().pendingAudioBytes, 1920);
  f.advance(450);
  f.callbacks[0]();
  assert.deepEqual(f.sent, ['first', 'second', 'third']);
  assert.equal(f.pump.snapshot().writtenAudioBytes, 640);
  f.callbacks[1]();
  f.callbacks[2]();
  assert.deepEqual(f.sent, ['first', 'second', 'third']);
  assert.equal(f.pump.snapshot().writtenAudioBytes, 1920);
  assert.equal(f.pump.snapshot().pendingAudioBytes, 0);
  assert.equal(f.pump.snapshot().pendingWireBytes, 0);
  assert.equal(
    f.observations.find((event) => event.stage === 'send_written')
      ?.callbackDurationMs,
    450,
  );
  assert.equal(f.timers.size, 0);
  f.pump.abort();
});

test('synchronous callbacks and reentrant admission do not recurse or double-send', () => {
  const f = fixture();
  let completed = 0;
  const enqueue = () => {
    f.pump.enqueue(String(completed), 'input_audio_buffer.append', 2, () => {
      completed += 1;
      if (completed < 3000) enqueue();
    });
  };
  f.socket.send = (wire, callback) => {
    f.sent.push(wire);
    callback();
  };
  enqueue();
  assert.equal(completed, 3000);
  assert.equal(new Set(f.sent).size, 3000);
  assert.equal(f.pump.snapshot().writtenAudioBytes, 6000);
  assert.equal(f.pump.snapshot().pendingAudioBytes, 0);
  assert.equal(f.failures.length, 0);
  f.pump.abort();
});

test('slow callbacks recover within the same finite deadline in exact input order', () => {
  const f = fixture();
  f.append('before-pause');
  f.advance(900);
  f.append('after-pause');
  f.advance(900);
  assert.equal(f.failures.length, 0);
  f.callbacks[0]();
  f.callbacks[1]();
  assert.deepEqual(f.sent, ['before-pause', 'after-pause']);
  assert.equal(f.pump.snapshot().writtenAudioBytes, 1280);
  f.advance(5000);
  assert.equal(f.failures.length, 0);
  f.pump.abort();
});

test('sustained slow write expires the oldest item rather than resetting on new input', () => {
  const f = fixture();
  f.append('first');
  f.advance(1500);
  f.append('later');
  f.advance(LIVE_TRANSLATE_SEND_WAIT_MS - 1501);
  assert.equal(f.failures.length, 0);
  f.advance(1);
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].sendReason, 'oldest_send_timeout');
  assert.equal(f.failures[0].callbackDurationMs, 2000);
  assert.deepEqual(f.sent, ['first', 'later']);
  f.callbacks[0]();
  f.callbacks[0](new Error('PRIVATE_LATE_CALLBACK'));
  f.advance(5000);
  assert.equal(f.failures.length, 1);
  assert.equal(f.pump.snapshot().writtenAudioBytes, 0);
  assert.deepEqual(f.sent, ['first', 'later']);
  assert.equal(f.timers.size, 0);
});

test('success cannot overtake an already-due deadline whose timer has not dispatched', async (t) => {
  for (const elapsed of [1999, 2000, 3000]) {
    await t.test(`callback after ${elapsed} ms`, () => {
      const f = fixture();
      f.append('first');
      f.append('second');
      f.elapseWithoutDispatch(elapsed);
      f.callbacks[0]();
      if (elapsed < LIVE_TRANSLATE_SEND_WAIT_MS) {
        assert.equal(f.failures.length, 0);
        assert.equal(f.pump.snapshot().writtenAudioBytes, 640);
        assert.deepEqual(f.sent, ['first', 'second']);
        f.pump.abort();
      } else {
        assert.equal(f.failures.length, 1);
        assert.equal(f.failures[0].sendReason, 'oldest_send_timeout');
        assert.equal(f.failures[0].callbackDurationMs, elapsed);
        assert.equal(f.pump.snapshot().writtenAudioBytes, 0);
        assert.deepEqual(f.sent, ['first', 'second']);
        assert.equal(f.timers.size, 0);
        f.callbacks[0]();
        assert.equal(f.failures.length, 1);
        assert.equal(f.pump.snapshot().writtenAudioBytes, 0);
      }
    });
  }
});

test('a late callback error keeps its concrete write error ahead of deadline classification', () => {
  const f = fixture();
  f.append('first');
  f.elapseWithoutDispatch(3000);
  f.callbacks[0](new Error('PRIVATE_LATE_ERROR'));
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].sendReason, 'write_callback_error');
  assert.equal(f.failures[0].callbackDurationMs, 3000);
  assert.equal(f.pump.snapshot().writtenAudioBytes, 0);
  assert.equal(f.timers.size, 0);
});

test('phone PCM capacity includes in-flight bytes, accepting exactly the boundary', () => {
  const f = fixture();
  assert.equal(f.append('first', 32000), true);
  assert.equal(f.append('second', 32000), true);
  assert.equal(
    f.pump.snapshot().pendingAudioBytes,
    LIVE_TRANSLATE_PENDING_INPUT_BYTES,
  );
  assert.equal(f.append('excess', 2), false);
  assert.equal(f.failures[0].sendReason, 'pending_input_limit');
  assert.equal(f.failures[0].pendingAudioBytes, 64000);
  assert.equal(f.failures[0].acceptedAudioBytes, 64000);
  f.callbacks[0]();
  assert.deepEqual(f.sent, ['first', 'second']);
  assert.equal(f.timers.size, 0);
});

test('serialized payload capacity includes in-flight and queued control frames', () => {
  const f = fixture();
  assert.equal(
    f.pump.enqueue(
      'a'.repeat(LIVE_TRANSLATE_TRANSPORT_BUFFER_BYTES),
      'session.update',
      0,
    ),
    true,
  );
  assert.equal(f.pump.enqueue('x', 'session.finish', 0), false);
  assert.equal(f.failures[0].sendReason, 'pending_input_limit');
  assert.equal(
    f.failures[0].pendingWireBytes,
    LIVE_TRANSLATE_TRANSPORT_BUFFER_BYTES,
  );
  f.callbacks[0]();
  assert.equal(f.sent.length, 1);
});

test('temporary transport buffering waits without a send and then recovers once', () => {
  const f = fixture();
  f.socket.bufferedAmount = LIVE_TRANSLATE_TRANSPORT_BUFFER_BYTES + 1;
  f.append('first');
  f.append('second');
  f.advance(475);
  assert.deepEqual(f.sent, []);
  assert.equal(f.failures.length, 0);
  f.socket.bufferedAmount = LIVE_TRANSLATE_TRANSPORT_BUFFER_BYTES;
  f.advance(25);
  assert.deepEqual(f.sent, ['first', 'second']);
  f.callbacks[0]();
  f.callbacks[1]();
  assert.deepEqual(f.sent, ['first', 'second']);
  assert.equal(
    f.observations.filter((event) => event.stage === 'send_waiting').length,
    1,
  );
  f.pump.abort();
});

test('sustained transport buffering fails visibly at the finite deadline', () => {
  const f = fixture();
  f.socket.bufferedAmount = LIVE_TRANSLATE_TRANSPORT_BUFFER_BYTES + 10;
  f.append();
  f.advance(1999);
  assert.equal(f.failures.length, 0);
  f.advance(1);
  assert.equal(f.failures[0].sendReason, 'transport_buffer_limit');
  assert.equal(f.failures[0].readyState, 1);
  assert.equal(
    f.failures[0].bufferedBytes,
    LIVE_TRANSLATE_TRANSPORT_BUFFER_BYTES + 10,
  );
  f.socket.bufferedAmount = 0;
  f.advance(5000);
  assert.deepEqual(f.sent, []);
  assert.equal(f.failures.length, 1);
});

test('non-OPEN states fail immediately with the exact safe state and no send', async (t) => {
  for (const state of [0, 2, 3])
    await t.test(String(state), () => {
      const f = fixture();
      f.socket.readyState = state;
      assert.equal(f.append(), false);
      assert.equal(f.failures[0].sendReason, 'transport_not_open');
      assert.equal(f.failures[0].readyState, state);
      assert.deepEqual(f.sent, []);
      assert.equal(f.timers.size, 0);
    });
});

test('callback failure and synchronous throw have different bounded reasons without raw errors', async (t) => {
  for (const mode of ['callback', 'throw'] as const)
    await t.test(mode, () => {
      const f = fixture();
      const privateError = new Error(
        'SECRET_HEADER_NUMBER_AND_TRANSCRIPT_CANARY',
      );
      if (mode === 'throw')
        f.socket.send = () => {
          throw privateError;
        };
      f.append('PRIVATE_AUDIO_CANARY');
      if (mode === 'callback') {
        f.advance(80);
        f.callbacks[0](privateError);
      }
      assert.equal(f.failures[0].code, 'LIVETRANSLATE_SEND_FAILED');
      assert.equal(
        f.failures[0].sendReason,
        mode === 'callback' ? 'write_callback_error' : 'write_throw',
      );
      assert.equal(JSON.stringify(f.observations).includes('CANARY'), false);
      assert.equal(f.append('not-retried'), false);
      assert.equal(f.timers.size, 0);
    });
});

test('close races are observed once in monotonic observation order after failure', () => {
  const f = fixture();
  f.append();
  f.advance(25);
  f.socket.readyState = 2;
  f.callbacks[0](new Error('SYNTHETIC_RACE'));
  f.advance(4);
  f.socket.readyState = 3;
  f.pump.observeClose(1006);
  f.pump.observeClose(1006);
  const failure = f.observations.find(
    (event) => event.stage === 'send_failed',
  )!;
  const close = f.observations.find(
    (event) => event.stage === 'transport_closed',
  )!;
  assert.equal(failure.readyState, 2);
  assert.equal(close.readyState, 3);
  assert.ok(failure.observedSequence < close.observedSequence);
  assert.ok(failure.at < close.at);
  assert.equal(close.closeCode, 1006);
  assert.equal(
    f.observations.filter((event) => event.stage === 'transport_closed').length,
    1,
  );
  assert.equal(f.failures.length, 1);
});

test('close before send callback cannot resume cancelled work or lose close evidence', () => {
  const f = fixture();
  f.append('first');
  f.append('second');
  f.socket.readyState = 3;
  f.pump.observeClose(1000);
  f.pump.abort();
  f.callbacks[0]();
  f.callbacks[0]();
  assert.deepEqual(f.sent, ['first', 'second']);
  assert.equal(f.pump.snapshot().writtenAudioBytes, 0);
  assert.equal(f.failures.length, 0);
  assert.equal(f.observations.at(-1)?.stage, 'send_cancelled');
  assert.equal(f.timers.size, 0);
});

test('finish stays behind accepted audio and abort cancels unsent finish', async (t) => {
  await t.test('ordered finish', () => {
    const f = fixture();
    f.append('first');
    f.append('second');
    f.pump.enqueue('finish', 'session.finish', 0);
    assert.deepEqual(f.sent, ['first', 'second']);
    f.callbacks[0]();
    f.callbacks[1]();
    f.callbacks[2]();
    assert.deepEqual(f.sent, ['first', 'second', 'finish']);
    assert.equal(f.pump.snapshot().writtenAudioBytes, 1280);
    f.pump.abort();
  });
  await t.test('abort fence', () => {
    const f = fixture();
    f.append('first');
    f.pump.enqueue('finish', 'session.finish', 0);
    f.pump.abort();
    f.pump.abort();
    f.callbacks[0]();
    f.advance(10000);
    assert.deepEqual(f.sent, ['first']);
    assert.equal(
      f.observations.filter((event) => event.stage === 'send_cancelled').length,
      1,
    );
    assert.equal(f.pump.snapshot().pendingAudioBytes, 0);
  });
});

test('late duplicate success does not release twice or start another pending frame', () => {
  const f = fixture();
  f.append('first');
  f.append('second');
  f.append('third');
  f.callbacks[0]();
  f.callbacks[0]();
  assert.deepEqual(f.sent, ['first', 'second', 'third']);
  assert.equal(f.pump.snapshot().writtenAudioBytes, 640);
  assert.equal(f.pump.snapshot().pendingAudioBytes, 1280);
  f.callbacks[1]();
  f.callbacks[2]();
  assert.deepEqual(f.sent, ['first', 'second', 'third']);
  assert.equal(f.pump.snapshot().writtenAudioBytes, 1920);
  f.pump.abort();
});

test('close with no prior send still has one zero-sequence safe observation', () => {
  const f = fixture();
  f.socket.readyState = 3;
  f.pump.abort();
  f.pump.observeClose(99999);
  assert.equal(f.observations.at(-1)?.stage, 'transport_closed');
  assert.equal(f.observations.at(-1)?.sendSequence, 0);
  assert.equal(f.observations.at(-1)?.closeCode, undefined);
});

test('synthetic real-time input stays bounded when socket progress precedes slow callbacks', async (t) => {
  // This fixture intentionally separates local write receipt latency from
  // actual buffered bytes. It is not a recording or a vendor event replay.
  await Promise.all(
    [25, 536, 630.701].map((callbackLagMs) =>
      t.test(`callback lag ${callbackLagMs} ms`, () => {
        const f = fixture();
        f.socket.send = (wire, callback) => {
          f.sent.push(wire);
          f.callbacks.push(callback);
          f.socket.bufferedAmount += Buffer.byteLength(wire);
          f.defer(() => {
            f.socket.bufferedAmount -= Buffer.byteLength(wire);
          }, 1);
          f.defer(callback, callbackLagMs);
        };
        const count = 3000;
        for (let index = 0; index < count; index += 1) {
          const wire = JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: Buffer.alloc(640, index % 256).toString('base64'),
          });
          assert.equal(f.append(wire), true);
          f.advance(20);
        }
        f.advance(callbackLagMs);
        assert.equal(f.failures.length, 0);
        assert.equal(f.sent.length, count);
        assert.equal(new Set(f.callbacks).size, count);
        assert.equal(f.pump.snapshot().acceptedAudioBytes, count * 640);
        assert.equal(f.pump.snapshot().writtenAudioBytes, count * 640);
        assert.equal(f.pump.snapshot().pendingAudioBytes, 0);
        assert.ok(
          Math.max(...f.observations.map((event) => event.pendingAudioBytes)) <=
            Math.ceil(callbackLagMs / 20) * 640,
        );
        assert.deepEqual(
          f.observations
            .filter((event) => event.stage === 'send_started')
            .map((event) => event.sendSequence),
          Array.from({ length: count }, (_, index) => index + 1),
        );
        f.pump.abort();
        assert.equal(f.timers.size, 0);
      }),
    ),
  );
});

test('out-of-order callback receipts publish only the contiguous successful prefix', () => {
  const f = fixture();
  const receipts: number[] = [];
  for (let index = 1; index <= 3; index += 1)
    f.pump.enqueue(String(index), 'input_audio_buffer.append', 640, () => {
      receipts.push(index);
    });
  f.advance(10);
  f.callbacks[2]();
  f.callbacks[2]();
  assert.equal(f.pump.snapshot().writtenAudioBytes, 0);
  assert.equal(f.pump.snapshot().pendingAudioBytes, 1920);
  assert.deepEqual(receipts, []);
  f.advance(10);
  f.callbacks[0]();
  assert.equal(f.pump.snapshot().writtenAudioBytes, 640);
  assert.deepEqual(receipts, [1]);
  f.advance(10);
  f.callbacks[1]();
  assert.equal(f.pump.snapshot().writtenAudioBytes, 1920);
  assert.equal(f.pump.snapshot().pendingAudioBytes, 0);
  assert.deepEqual(receipts, [1, 2, 3]);
  assert.deepEqual(
    f.observations
      .filter((event) => event.stage === 'send_written')
      .map((event) => [event.sendSequence, event.callbackDurationMs]),
    [
      [1, 20],
      [2, 30],
      [3, 10],
    ],
  );
  f.pump.abort();
});

test('configuration and finish remain callback barriers around pipelined audio', () => {
  const f = fixture();
  f.pump.enqueue('configure', 'session.update', 0);
  f.append('first');
  f.append('second');
  f.pump.enqueue('finish', 'session.finish', 0);
  f.append('after-finish');
  assert.deepEqual(f.sent, ['configure']);
  f.callbacks[0]();
  assert.deepEqual(f.sent, ['configure', 'first', 'second']);
  f.callbacks[2]();
  assert.deepEqual(f.sent, ['configure', 'first', 'second']);
  f.callbacks[1]();
  assert.deepEqual(f.sent, ['configure', 'first', 'second', 'finish']);
  f.callbacks[3]();
  assert.deepEqual(f.sent, [
    'configure',
    'first',
    'second',
    'finish',
    'after-finish',
  ]);
  f.callbacks[4]();
  assert.equal(f.pump.snapshot().writtenAudioBytes, 1920);
  assert.equal(f.failures.length, 0);
  f.pump.abort();
});

test('pipelined callback error stops all remaining writes without ignoring a real error', () => {
  const f = fixture();
  f.append('first');
  f.append('second');
  f.append('third');
  f.callbacks[2]();
  f.callbacks[1](new Error('PRIVATE_SYNTHETIC_CALLBACK_ERROR'));
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].sendReason, 'write_callback_error');
  assert.equal(f.failures[0].sendSequence, 2);
  f.callbacks[0]();
  f.callbacks[1]();
  assert.equal(f.pump.snapshot().writtenAudioBytes, 0);
  assert.equal(f.append('later'), false);
  assert.equal(f.sent.length, 3);
  assert.equal(JSON.stringify(f.observations).includes('PRIVATE_'), false);
  assert.equal(f.timers.size, 0);
});

test('real-time input with stalled receipts still fails at the original two-second boundary', () => {
  const f = fixture();
  for (let index = 0; index < 100; index += 1) {
    assert.equal(f.append(String(index)), true);
    f.advance(20);
  }
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].at, 1792110002000);
  assert.equal(f.failures[0].sendReason, 'oldest_send_timeout');
  assert.equal(f.failures[0].pendingAudioBytes, 64000);
  assert.equal(f.sent.length, 100);
  assert.equal(f.append('not-retried'), false);
  for (const callback of f.callbacks) callback();
  assert.equal(f.pump.snapshot().writtenAudioBytes, 0);
  assert.equal(f.failures.length, 1);
});

test('local slow callbacks cannot prevent the remote input pump from making independent progress', () => {
  const local = fixture();
  const remote = fixture();
  local.socket.send = (wire, callback) => {
    local.sent.push(wire);
    local.defer(callback, 630.701);
  };
  remote.socket.send = (wire, callback) => {
    remote.sent.push(wire);
    remote.defer(callback, 1);
  };
  for (let index = 0; index < 600; index += 1) {
    assert.equal(local.append(`local-${index}`), true);
    assert.equal(remote.append(`remote-${index}`), true);
    local.advance(20);
    remote.advance(20);
  }
  local.advance(631);
  remote.advance(631);
  assert.equal(local.failures.length, 0);
  assert.equal(remote.failures.length, 0);
  assert.equal(local.pump.snapshot().writtenAudioBytes, 600 * 640);
  assert.equal(remote.pump.snapshot().writtenAudioBytes, 600 * 640);
  local.pump.abort();
  remote.pump.abort();
});
