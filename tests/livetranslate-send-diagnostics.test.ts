import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createLiveTranslateSendDiagnostics,
  fitLiveTranslateSendDiagnostic,
  projectLiveTranslateSendDiagnostic,
  LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOW_BYTES,
  type LiveTranslateSendDiagnostic,
  type SendDiagnosticState,
} from '../src/experiments/livetranslate-send-diagnostics';
import { createLiveTranslateSendPump } from '../src/experiments/livetranslate-send-pump';

const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));
function fixture(
  options: {
    unavailable?: boolean;
    sink?: (event: LiveTranslateSendDiagnostic) => void;
  } = {},
) {
  let clock = 0;
  let nextTimer = 0;
  const timers = new Map<number, { callback: () => void; due: number }>();
  const windows: LiveTranslateSendDiagnostic[] = [];
  const sent: string[] = [];
  const callbacks: ((error?: Error) => void)[] = [];
  const failures: unknown[] = [];
  const written: string[] = [];
  const socket: any = {
    readyState: 1,
    bufferedAmount: 0,
    ...(options.unavailable
      ? {}
      : {
          _sender: { _bufferedBytes: 0 },
          _socket: { writableLength: 0 },
          extensions: '',
        }),
    send(wire: string, callback: (error?: Error) => void) {
      sent.push(wire);
      callbacks.push(callback);
    },
  };
  const pump = createLiveTranslateSendPump({
    socket,
    now: () => 1792220000000 + clock,
    monotonicNow: () => clock,
    schedule(callback, delay) {
      nextTimer += 1;
      timers.set(nextTimer, { callback, due: clock + delay });
      return nextTimer as any;
    },
    cancelSchedule(timer) {
      timers.delete(timer as any);
    },
    onFailure: (event) => failures.push(event),
    onDiagnostic: options.sink ?? ((event) => windows.push(event)),
  });
  return {
    socket,
    pump,
    windows,
    sent,
    callbacks,
    failures,
    written,
    append(wire = 'sensitive-test-pcm-never-logged') {
      return pump.enqueue(wire, 'input_audio_buffer.append', 640, () =>
        written.push(wire),
      );
    },
    elapse(ms: number) {
      clock += ms;
    },
    expire() {
      clock = 2000;
      for (const [id, timer] of timers)
        if (timer.due <= clock) {
          timers.delete(id);
          timer.callback();
        }
    },
  };
}
const records = (f: ReturnType<typeof fixture>) =>
  f.windows.flatMap((window) => window.records);

test('normal diagnostic end is an explicit snapshot, never a fabricated write receipt', async () => {
  const f = fixture();
  f.append();
  f.pump.finishDiagnostics();
  f.pump.abort();
  await settle();
  const end = f.windows.find((window) => window.trigger === 'normal_end')!;
  assert.equal(end.records.at(-1)!.stage, 'diagnostic_end');
  assert.equal(end.records.at(-1)!.writtenAudioBytes, 0);
  assert.equal(end.records.at(-1)!.contiguousWrittenSequence, 0);
  assert.equal(end.records.at(-1)!.pendingAudioBytes, 640);
  assert.equal(end.summary.rawCallbackCount, 0);
});

test('oldest age follows the original unreleased protection frontier until successful prefix drain', async () => {
  const f = fixture();
  f.append('first');
  f.append('second');
  f.elapse(200);
  f.callbacks[1]();
  f.callbacks[0]();
  f.pump.finishDiagnostics();
  f.pump.abort();
  await settle();
  const headReceipt = records(f).find(
    (record) => record.stage === 'raw_callback' && record.sendSequence === 1,
  )!;
  assert.equal(headReceipt.oldestUnfinishedAgeMs, 200);
  assert.equal(headReceipt.firstUnconfirmedSequence, 1);
  assert.equal(headReceipt.contiguousWrittenSequence, 0);
  assert.equal(headReceipt.pendingAudioBytes, 1280);
  const drained = records(f).find(
    (record) => record.stage === 'send_written' && record.sendSequence === 2,
  )!;
  assert.equal(drained.oldestUnfinishedAgeMs, null);
  assert.equal(drained.firstUnconfirmedSequence, null);
  assert.equal(drained.contiguousWrittenSequence, 2);
});

test('small PCM high-pending diagnostic counters remain bounded without changing acceptance or order', async () => {
  const f = fixture();
  for (let i = 0; i < 1000; i += 1) {
    assert.equal(
      f.pump.enqueue(String(i), 'input_audio_buffer.append', 2, () =>
        f.written.push(String(i)),
      ),
      true,
    );
  }
  assert.equal(f.pump.snapshot().pendingAudioBytes, 2000);
  for (let i = 999; i > 0; i -= 1) f.callbacks[i]();
  f.callbacks[500]();
  assert.equal(
    f.pump.diagnosticSnapshot()!.successfulCallbacksAwaitingPrefix,
    999,
  );
  assert.equal(f.pump.snapshot().writtenAudioBytes, 0);
  f.callbacks[0]();
  assert.equal(
    f.pump.diagnosticSnapshot()!.successfulCallbacksAwaitingPrefix,
    0,
  );
  assert.deepEqual(
    f.sent,
    Array.from({ length: 1000 }, (_, i) => String(i)),
  );
  assert.deepEqual(f.written, f.sent);
  assert.equal(f.pump.snapshot().pendingAudioBytes, 0);
  assert.equal(f.pump.snapshot().writtenAudioBytes, 2000);
  f.pump.finishDiagnostics();
  f.pump.abort();
  await settle();
  assert.equal(f.failures.length, 0);
  assert.equal(f.windows.at(-1)!.summary.rawCallbackCount, 1001);
  assert.equal(f.pump.diagnosticSnapshot()!.retainedRecords, 0);
});

test('failed callback, timeout and cancellation never retain successful callback counter state', async () => {
  for (const stop of ['error', 'timeout', 'cancel'] as const) {
    const f = fixture();
    f.append('gap');
    f.append('success');
    f.append('failure');
    f.callbacks[1]();
    f.callbacks[1]();
    assert.equal(
      f.pump.diagnosticSnapshot()!.successfulCallbacksAwaitingPrefix,
      1,
    );
    if (stop === 'error') f.callbacks[2](new Error('synthetic error'));
    if (stop === 'timeout') f.expire();
    if (stop === 'cancel') f.pump.abort();
    assert.equal(
      f.pump.diagnosticSnapshot()!.successfulCallbacksAwaitingPrefix,
      0,
    );
    f.callbacks[2]();
    assert.equal(
      f.pump.diagnosticSnapshot()!.successfulCallbacksAwaitingPrefix,
      0,
    );
    await settle();
    const terminal = f.windows.find(
      (window) =>
        window.trigger === (stop === 'cancel' ? 'cancelled' : 'send_failure'),
    )!;
    assert.equal(terminal.records.at(-1)!.completedBehindGapFrames, 1);
    assert.equal(terminal.records.at(-1)!.writtenAudioBytes, 0);
  }
});

test('local metadata separates raw receipt, successful contiguous prefix and a missing callback', async () => {
  const f = fixture();
  f.append('first');
  f.append('second');
  f.append('third');
  f.elapse(400);
  f.callbacks[1]();
  f.callbacks[1]();
  f.callbacks[2]();
  assert.deepEqual(f.written, []);
  f.expire();
  await settle();
  const second = records(f).find(
    (r) =>
      r.stage === 'raw_callback' &&
      r.sendSequence === 2 &&
      r.callbackDisposition === 'first',
  )!;
  assert.equal(second.contiguousWrittenSequence, 0);
  assert.equal(second.prefixGapSequence, 1);
  assert.equal(second.completedBehindGapFrames, 1);
  assert.equal(second.callbackDurationMs, 400);
  assert.equal(second.callbackAt, 1792220000400);
  assert.equal(second.callbackMonotonicAtMs, 400);
  const last = records(f).at(-1)!;
  assert.equal(last.oldestUnfinishedAgeMs, 2000);
  assert.equal(last.completedBehindGapFrames, 2);
  assert.equal(last.pendingAudioBytes, 1920);
  assert.equal(f.windows.at(-1)!.summary.duplicateCallbackCount, 1);
  assert.equal((f.failures[0] as any).sendReason, 'oldest_send_timeout');
  assert.equal(f.pump.diagnosticSnapshot()!.retainedRecords, 0);
  assert.equal(f.pump.diagnosticSnapshot()!.monitorStopped, true);
});

for (const mechanism of ['callback-only', 'sender', 'writable'] as const) {
  test(`synthetic metadata distinguishes ${mechanism} buffering without claiming supplier receipt`, async () => {
    const f = fixture();
    f.socket._sender._bufferedBytes = mechanism === 'sender' ? 90300 : 0;
    f.socket._socket.writableLength = mechanism === 'writable' ? 91100 : 0;
    f.socket.bufferedAmount =
      f.socket._sender._bufferedBytes + f.socket._socket.writableLength;
    f.socket.extensions = mechanism === 'sender' ? 'permessage-deflate' : '';
    f.append();
    f.elapse(600);
    f.pump.abort();
    await settle();
    const last = records(f).at(-1)!;
    assert.equal(last.senderBufferedBytes, mechanism === 'sender' ? 90300 : 0);
    assert.equal(
      last.writableBufferedBytes,
      mechanism === 'writable' ? 91100 : 0,
    );
    assert.equal(last.perMessageDeflate, mechanism === 'sender');
    assert.equal(last.pendingAudioBytes, 640);
    assert.equal(last.oldestUnfinishedAgeMs, 600);
    assert.equal(
      JSON.stringify(f.windows).includes('sensitive-test-pcm'),
      false,
    );
  });
}

test('unknown observational fields remain null, including unsampled loop delay', async () => {
  const f = fixture({ unavailable: true });
  f.append();
  f.pump.abort();
  await settle();
  const r = records(f).at(-1)!;
  assert.equal(r.senderBufferedBytes, null);
  assert.equal(r.writableBufferedBytes, null);
  assert.equal(r.perMessageDeflate, null);
  assert.equal(r.eventLoopSampleCount, 0);
  assert.equal(r.eventLoopMeanMs, null);
  assert.equal(r.eventLoopMaxMs, null);
});

test('ring, warning emission count and encoded window bytes have hard bounds', async () => {
  const f = fixture();
  for (let i = 0; i < 2000; i += 1) {
    f.append(String(i));
    f.callbacks[i]();
  }
  assert.equal(f.pump.diagnosticSnapshot()!.retainedRecords, 256);
  assert.equal(f.pump.diagnosticSnapshot()!.emittedWindows, 0);
  for (let i = 0; i < 25; i += 1) f.append(`pending-${i}`);
  f.expire();
  f.callbacks[2000]();
  f.callbacks[2000]();
  f.pump.abort();
  f.pump.observeClose(1006);
  await settle();
  assert.ok(f.windows.length <= 6);
  for (const window of f.windows) {
    assert.ok(window.records.length <= 24);
    assert.ok(
      Buffer.byteLength(JSON.stringify(window)) <=
        LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOW_BYTES,
    );
  }
  assert.equal(f.pump.diagnosticSnapshot()!.retainedRecords, 0);
  assert.equal(f.pump.diagnosticSnapshot()!.monitorStopped, true);
});

test('post-cancel duplicate receipt is classified as both duplicate and after-stop, once', async () => {
  const f = fixture();
  f.append();
  f.callbacks[0]();
  f.callbacks[0]();
  f.pump.abort();
  f.callbacks[0]();
  f.callbacks[0]();
  f.pump.abort();
  f.pump.observeClose(1000);
  await settle();
  const late = f.windows.find((w) => w.trigger === 'late_callback')!;
  assert.equal(late.records.length, 1);
  assert.equal(late.records[0].callbackDisposition, 'duplicate');
  assert.equal(late.records[0].callbackAfterStop, true);
  assert.equal(late.records[0].callbackDuplicate, true);
  assert.equal(late.summary.lateCallbackCount, 2);
  assert.equal(late.summary.duplicateCallbackCount, 3);
  assert.ok(late.summary.suppressedRecords >= 1);
  assert.deepEqual(f.written, ['sensitive-test-pcm-never-logged']);
});

test('callback error uses a fixed code whitelist and never exception messages', async () => {
  const f = fixture();
  f.append();
  f.callbacks[0](
    Object.assign(new Error('SECRET-transcript-number-auth-header'), {
      code: 'PRIVATE-secret-code',
    }),
  );
  await settle();
  const r = records(f).find((entry) => entry.stage === 'raw_callback')!;
  assert.equal(r.callbackError, true);
  assert.equal(r.callbackErrorCode, 'other');
  assert.equal(JSON.stringify(f.windows).includes('SECRET'), false);
  assert.equal(JSON.stringify(f.windows).includes('PRIVATE'), false);
  assert.equal((f.failures[0] as any).sendReason, 'write_callback_error');
});

test('throwing private getters and sink are isolated from sends and cleanup', async () => {
  let observed = 0;
  const f = fixture({
    sink() {
      observed += 1;
      throw new Error('sink must not propagate');
    },
  });
  Object.defineProperty(f.socket, '_sender', {
    get() {
      throw new Error('private getter');
    },
  });
  Object.defineProperty(f.socket, '_socket', {
    get() {
      throw new Error('private getter');
    },
  });
  Object.defineProperty(f.socket, 'extensions', {
    get() {
      throw new Error('private getter');
    },
  });
  f.append();
  f.callbacks[0]();
  f.pump.finishDiagnostics();
  f.pump.abort();
  await settle();
  assert.equal(observed, 1);
  assert.equal(f.failures.length, 0);
  assert.equal(f.written.length, 1);
  assert.equal(f.pump.diagnosticSnapshot()!.monitorStopped, true);
});

test('a slow deferred sink cannot change the preexisting success deadline decision', async () => {
  let clock = 1999;
  const callbacks: (() => void)[] = [];
  const written: number[] = [];
  const failures: unknown[] = [];
  const pump = createLiveTranslateSendPump({
    socket: {
      readyState: 1,
      bufferedAmount: 0,
      send(_wire, callback) {
        callbacks.push(callback);
      },
    },
    now: () => clock,
    monotonicNow: () => clock,
    onDiagnostic() {
      clock += 1000;
    },
    onFailure: (event) => failures.push(event),
  });
  clock = 0;
  pump.enqueue('wire', 'input_audio_buffer.append', 640, () =>
    written.push(clock),
  );
  clock = 1999;
  callbacks[0]();
  pump.finishDiagnostics();
  assert.deepEqual(written, [1999]);
  assert.equal(failures.length, 0);
  await settle();
  pump.abort();
});

function bareState(): SendDiagnosticState {
  return {
    stage: 'send_started',
    eventType: 'input_audio_buffer.append',
    sendSequence: 1,
    callbackDisposition: null,
    callbackDuplicate: null,
    callbackAfterStop: null,
    callbackError: null,
    callbackErrorCode: null,
    callbackDurationMs: null,
    callbackAt: null,
    callbackMonotonicAtMs: null,
    contiguousWrittenSequence: 0,
    firstUnconfirmedSequence: 1,
    prefixGapSequence: null,
    completedBehindGapFrames: 0,
    oldestUnfinishedAgeMs: 0,
    queuedFrames: 0,
    inFlightFrames: 1,
    acceptedAudioBytes: 640,
    writtenAudioBytes: 0,
    pendingAudioBytes: 640,
    pendingWireBytes: 900,
    sendReason: null,
    closeCode: null,
  };
}

test('monitor initialization, no samples, sampled interval, normal termination and late receipts release resources', async () => {
  let enabled = 0;
  let disabled = 0;
  const windows: LiveTranslateSendDiagnostic[] = [];
  const monitor = {
    count: 0,
    mean: 21000000,
    max: 23000000,
    enable() {
      enabled += 1;
    },
    disable() {
      disabled += 1;
    },
  };
  const diagnostic = createLiveTranslateSendDiagnostics({
    socket: {},
    onDiagnostic: (w) => windows.push(w),
    createMonitor: () => monitor,
  });
  diagnostic.record(bareState());
  monitor.count = 2;
  diagnostic.finish(bareState());
  diagnostic.finish(bareState());
  diagnostic.dispose();
  diagnostic.record({
    ...bareState(),
    stage: 'raw_callback',
    callbackAfterStop: true,
  });
  await settle();
  assert.equal(enabled, 1);
  assert.equal(disabled, 1);
  assert.equal(windows[0].trigger, 'normal_end');
  assert.equal(windows[0].records[0].eventLoopMeanMs, null);
  assert.equal(windows[0].records[1].eventLoopMeanMs, 21);
  assert.equal(windows[0].records[1].eventLoopMaxMs, 23);
  assert.equal(windows[1].records[0].eventLoopSampleCount, null);
  assert.equal(diagnostic.snapshot().retainedRecords, 0);
});

test('failed monitor enable or disable cannot escape or leak the monitor reference', async () => {
  let attempts = 0;
  const d = createLiveTranslateSendDiagnostics({
    socket: {},
    onDiagnostic() {},
    createMonitor: () => ({
      mean: NaN,
      max: NaN,
      enable() {
        throw new Error('enable');
      },
      disable() {
        attempts += 1;
        throw new Error('disable');
      },
    }),
  });
  d.finish(bareState());
  d.dispose();
  await settle();
  assert.equal(attempts, 1);
  assert.equal(d.snapshot().monitorStopped, null);
});

test('extension metadata is unknown before OPEN and retains the last observed negotiated result after close', async () => {
  const socket = { readyState: 0, extensions: '' };
  const windows: LiveTranslateSendDiagnostic[] = [];
  const d = createLiveTranslateSendDiagnostics({
    socket,
    onDiagnostic: (w) => windows.push(w),
  });
  d.record(bareState());
  socket.readyState = 1;
  socket.extensions = 'permessage-deflate';
  d.record(bareState());
  socket.readyState = 3;
  d.finish(bareState());
  await settle();
  assert.equal(windows[0].records[0].perMessageDeflate, null);
  assert.equal(windows[0].records[1].perMessageDeflate, true);
  assert.equal(windows[0].records[2].perMessageDeflate, true);
});

test('strict projection ignores malicious extra data, accessors and toJSON without evaluating them', async () => {
  const f = fixture();
  f.append();
  f.pump.abort();
  await settle();
  const w: any = f.windows[0];
  let reads = 0;
  Object.defineProperty(w, 'secret', {
    get() {
      reads += 1;
      throw new Error('secret');
    },
  });
  Object.defineProperty(w.records[0], 'toJSON', {
    get() {
      reads += 1;
      throw new Error('toJSON');
    },
  });
  const projected = projectLiveTranslateSendDiagnostic(w)!;
  assert.ok(projected);
  assert.equal(reads, 0);
  assert.equal('secret' in projected, false);
  const invalid: any = structuredClone(projected);
  Object.defineProperty(invalid.records[0], 'senderBufferedBytes', {
    get() {
      reads += 1;
      return 0;
    },
  });
  assert.equal(projectLiveTranslateSendDiagnostic(invalid), undefined);
  assert.equal(reads, 0);
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error('proxy');
      },
    },
  );
  assert.equal(projectLiveTranslateSendDiagnostic(proxy), undefined);
});

test('strict projection rejects missing/negative/NaN/nonfinite values and oversized windows', async () => {
  const f = fixture();
  f.append();
  f.pump.abort();
  await settle();
  for (const value of [-1, NaN, Infinity, undefined, '0']) {
    const invalid: any = structuredClone(f.windows[0]);
    invalid.records[0].senderBufferedBytes = value;
    assert.equal(projectLiveTranslateSendDiagnostic(invalid), undefined);
  }
  const oversized = structuredClone(f.windows[0]);
  oversized.records = new Array(25).fill(oversized.records[0]);
  assert.equal(projectLiveTranslateSendDiagnostic(oversized), undefined);
  const accessor = structuredClone(f.windows[0]);
  Object.defineProperty(accessor.records, '0', {
    get() {
      throw new Error('array getter never called');
    },
  });
  assert.equal(projectLiveTranslateSendDiagnostic(accessor), undefined);
});

test('three warning slots reserve the actual pump failure, cleanup and late-callback slots', async () => {
  const f = fixture();
  let completed = 0;
  for (let cycle = 0; cycle < 5; cycle += 1) {
    f.elapse(1000);
    for (let i = 0; i < 25; i += 1) f.append(`synthetic-${cycle}-${i}`);
    for (let i = 0; i < 25; i += 1) f.callbacks[completed++]();
  }
  f.elapse(1000);
  f.socket._sender._bufferedBytes = 87000;
  f.socket._socket.writableLength = 91100;
  f.socket.bufferedAmount = 178100;
  f.socket.extensions = 'permessage-deflate';
  f.append('unconfirmed-prefix');
  f.append('completed-behind-prefix');
  f.elapse(10);
  f.callbacks[completed + 1]();
  f.elapse(40);
  for (let i = 0; i < 101; i += 1) f.append(`failure-${i}`);
  assert.equal((f.failures[0] as any).sendReason, 'pending_input_limit');
  assert.equal(f.pump.snapshot().stopped, true);
  f.pump.observeClose(1006);
  f.callbacks[completed](
    Object.assign(new Error('late synthetic error'), { code: 'ECONNRESET' }),
  );
  f.callbacks[completed]();
  f.pump.observeClose(1006);
  f.pump.abort();
  await settle();
  assert.deepEqual(
    f.windows.map((window) => window.trigger),
    [
      'backlog_warning',
      'backlog_warning',
      'backlog_warning',
      'send_failure',
      'transport_closed',
      'late_callback',
    ],
  );
  const failure = f.windows[3];
  assert.equal(failure.records.at(-1)!.stage, 'send_failed');
  assert.equal(failure.firstFailure!.failure.pendingAudioBytes, 64000);
  assert.equal(failure.firstFailure!.failure.sendReason, 'pending_input_limit');
  assert.equal(failure.firstFailure!.precedingRawCallback!.sendSequence, 127);
  assert.notEqual(
    failure.firstFailure!.failure.sendSequence,
    127,
    'previous receipt is context, not the failed frame',
  );
  const retainedFault = failure.firstFailure!.failure;
  assert.equal(retainedFault.senderBufferedBytes, 87000);
  assert.equal(retainedFault.writableBufferedBytes, 91100);
  assert.equal(retainedFault.webSocketBufferedBytes, 178100);
  assert.equal(retainedFault.perMessageDeflate, true);
  assert.equal(retainedFault.contiguousWrittenSequence, 125);
  assert.equal(retainedFault.firstUnconfirmedSequence, 126);
  assert.equal(retainedFault.prefixGapSequence, 126);
  assert.equal(retainedFault.completedBehindGapFrames, 1);
  assert.equal(retainedFault.oldestUnfinishedAgeMs, 50);
  const terminal = f.windows[4];
  assert.equal(terminal.records.at(-1)!.closeCode, 1006);
  assert.deepEqual(terminal.firstFailure, failure.firstFailure);
  assert.equal(f.windows[5].records[0].callbackAfterStop, true);
  assert.equal(f.windows[5].records[0].callbackError, true);
  assert.ok(f.windows[5].summary.suppressedWindows >= 2);
  assert.ok(f.windows[5].summary.suppressedRecords >= 1);
  assert.equal(f.windows[5].summary.futureSuppressedRecords, null);
  assert.equal(f.windows[5].summary.captureEnded, true);
  assert.equal(
    f.windows[5].summary.observedThroughRecordSequence,
    f.pump.diagnosticSnapshot()!.observedThroughRecordSequence,
  );
  assert.equal(f.pump.diagnosticSnapshot()!.retainedRecords, 0);
  assert.equal(f.pump.diagnosticSnapshot()!.monitorStopped, true);
});

test('close first, normal hangup and late errors retain their classification without fabricating fatal failures', async () => {
  for (const ending of ['close', 'hangup'] as const) {
    const f = fixture();
    f.append();
    if (ending === 'close') f.pump.observeClose(1006);
    f.pump.abort();
    f.callbacks[0](Object.assign(new Error('late only'), { code: 'EPIPE' }));
    f.pump.observeClose(1006);
    f.pump.abort();
    await settle();
    assert.deepEqual(
      f.windows.map((window) => window.trigger),
      [ending === 'close' ? 'transport_closed' : 'cancelled', 'late_callback'],
    );
    assert.equal(f.windows[1].firstFailure, null);
    assert.equal(f.windows[1].records[0].callbackAfterStop, true);
    assert.equal(f.windows[1].records[0].callbackErrorCode, 'EPIPE');
    assert.equal(f.pump.diagnosticSnapshot()!.retainedRecords, 0);
    assert.equal(f.pump.diagnosticSnapshot()!.monitorStopped, true);
  }
});

test('oversized trusted windows compact oldest context while preserving newest fatal and raw-callback anchors', async () => {
  const f = fixture();
  f.append('gap');
  f.append('later');
  f.callbacks[1]();
  f.expire();
  await settle();
  const source = structuredClone(
    f.windows.find((window) => window.trigger === 'send_failure')!,
  );
  const longNumber = 123456789.12345679;
  const inflate = (record: any) => {
    for (const key of Object.keys(record))
      if (typeof record[key] === 'number' || record[key] === null) {
        if (
          key !== 'callbackDisposition' &&
          key !== 'callbackErrorCode' &&
          key !== 'sendReason' &&
          key !== 'perMessageDeflate' &&
          key !== 'callbackError' &&
          key !== 'callbackDuplicate' &&
          key !== 'callbackAfterStop'
        )
          record[key] = longNumber;
      }
    return record;
  };
  const record = inflate(structuredClone(source.records.at(-1)!));
  record.stage = 'send_failed';
  record.sendReason = 'oldest_send_timeout';
  source.records = Array.from({ length: 24 }, () => structuredClone(record));
  source.firstFailure = {
    failure: structuredClone(record),
    precedingRawCallback: inflate(
      structuredClone(source.firstFailure!.precedingRawCallback!),
    ),
  };
  source.firstFailure.precedingRawCallback!.stage = 'raw_callback';
  source.firstFailure.precedingRawCallback!.sendReason = null;
  assert.ok(
    Buffer.byteLength(JSON.stringify(source)) >
      LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOW_BYTES,
  );
  assert.equal(
    projectLiveTranslateSendDiagnostic(source),
    undefined,
    'untrusted projection never relaxes its size cap',
  );
  const fitted = fitLiveTranslateSendDiagnostic(source)!;
  assert.ok(fitted);
  assert.ok(fitted.records.length < 24);
  assert.deepEqual(fitted.records.at(-1), source.records.at(-1));
  assert.deepEqual(fitted.firstFailure, source.firstFailure);
  assert.equal(
    fitted.summary.windowTruncatedRecords,
    24 - fitted.records.length,
  );
  assert.equal(
    fitted.summary.truncatedRecords,
    source.summary.truncatedRecords,
    'generic fit does not invent producer-global totals',
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(fitted)) <=
      LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOW_BYTES,
  );
  const tighter = fitLiveTranslateSendDiagnostic(fitted, 5500)!;
  assert.ok(tighter);
  assert.deepEqual(tighter.firstFailure, source.firstFailure);
  assert.equal(
    tighter.summary.windowTruncatedRecords,
    24 - tighter.records.length,
  );
  assert.equal(
    tighter.summary.truncatedRecords,
    source.summary.truncatedRecords,
  );
  assert.equal(
    fitLiveTranslateSendDiagnostic(source, 100),
    undefined,
    'cannot fit critical anchors: reject rather than erase them',
  );
  assert.equal(
    fitLiveTranslateSendDiagnostic(
      source,
      LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOW_BYTES + 1,
    ),
    undefined,
  );
  const overflow = structuredClone(source);
  overflow.summary.windowTruncatedRecords = Number.MAX_SAFE_INTEGER;
  assert.equal(
    fitLiveTranslateSendDiagnostic(overflow, 5500),
    undefined,
    'counter overflow cannot escape the scalar boundary',
  );
});

test('producer sink errors, projection rejection and post-budget suppression have known counters and an explicit future cutoff', async () => {
  const received: LiveTranslateSendDiagnostic[] = [];
  let clock = 1000;
  let throwSink = false;
  const d = createLiveTranslateSendDiagnostics({
    socket: {},
    now: () => clock,
    monotonicNow: () => 0,
    onDiagnostic(event) {
      if (throwSink) throw new Error('synthetic sink');
      received.push(event);
    },
  });
  d.record({
    ...bareState(),
    pendingAudioBytes: 16000,
    callbackDurationMs: Infinity,
  });
  await settle();
  assert.equal(d.snapshot().projectionRejectedWindows, 1);
  assert.equal(received.length, 0);
  // Artificial impossible producer metadata exercises rejection. Once the
  // bounded ring replaces that invalid context, later legal windows report it.
  for (let i = 0; i < 256; i += 1) d.record(bareState());
  clock = 2000;
  throwSink = true;
  d.record({
    ...bareState(),
    stage: 'send_failed',
    sendReason: 'oldest_send_timeout',
  });
  await settle();
  assert.equal(d.snapshot().sinkErrorWindows, 1);
  throwSink = false;
  d.record({ ...bareState(), stage: 'transport_closed', closeCode: 1006 });
  await settle();
  const terminal = received[0];
  assert.equal(terminal.summary.projectionRejectedWindows, 1);
  assert.equal(terminal.summary.sinkErrorWindows, 1);
  assert.equal(terminal.records.at(-1)!.closeCode, 1006);
  assert.ok(terminal.firstFailure);
  d.record({ ...bareState(), stage: 'raw_callback', callbackAfterStop: true });
  await settle();
  const finalCutoff = received.at(-1)!.summary.observedThroughRecordSequence;
  for (let i = 0; i < 100; i += 1)
    d.record({
      ...bareState(),
      stage: 'raw_callback',
      callbackAfterStop: true,
      callbackError: true,
    });
  assert.equal(
    received.at(-1)!.summary.observedThroughRecordSequence,
    finalCutoff,
  );
  assert.equal(received.at(-1)!.summary.futureSuppressedRecords, null);
  assert.equal(d.snapshot().observedThroughRecordSequence, finalCutoff + 100);
  assert.equal(d.snapshot().suppressedRecords, 100);
  assert.equal(d.snapshot().retainedRecords, 0);
});

test('invalid diagnostic clocks never poison the ring or manufacture a fatal timestamp', async () => {
  for (const stage of ['send_started', 'send_failed'] as const) {
    let clock = NaN;
    const windows: LiveTranslateSendDiagnostic[] = [];
    const d = createLiveTranslateSendDiagnostics({
      socket: {},
      now: () => clock,
      monotonicNow: () => 0,
      onDiagnostic: (event) => windows.push(event),
    });
    d.record({
      ...bareState(),
      stage,
      pendingAudioBytes: 16000,
      sendReason: stage === 'send_failed' ? 'oldest_send_timeout' : null,
    });
    assert.equal(d.snapshot().retainedRecords, 0);
    assert.equal(d.snapshot().suppressedRecords, 1);
    if (stage === 'send_failed') d.dispose();
    clock = 1000;
    d.record({ ...bareState(), stage: 'transport_closed', closeCode: 1006 });
    await settle();
    assert.equal(windows.length, 1);
    assert.equal(windows[0].trigger, 'transport_closed');
    assert.equal(
      windows[0].firstFailure,
      null,
      'unobservable failure time stays missing',
    );
    assert.equal(windows[0].summary.suppressedRecords, 1);
    assert.equal(windows[0].records[0].at, 1000);
    assert.equal(windows[0].summary.futureSuppressedRecords, null);
    assert.equal(d.snapshot().monitorStopped, true);
  }
});

test('clearing the ring and post-failure teardown never inflate actual ring overwrite counts', async () => {
  const windows: LiveTranslateSendDiagnostic[] = [];
  const d = createLiveTranslateSendDiagnostics({
    socket: {},
    onDiagnostic: (window) => windows.push(window),
  });
  for (let i = 0; i < 260; i += 1) d.record(bareState());
  d.record({
    ...bareState(),
    stage: 'send_failed',
    sendReason: 'oldest_send_timeout',
  });
  d.dispose();
  d.record({ ...bareState(), stage: 'transport_closed', closeCode: 1006 });
  d.record({ ...bareState(), stage: 'raw_callback', callbackAfterStop: true });
  await settle();
  assert.equal(
    windows.find((window) => window.trigger === 'send_failure')!.summary
      .overwrittenRecords,
    5,
  );
  assert.equal(
    windows.find((window) => window.trigger === 'transport_closed')!.summary
      .overwrittenRecords,
    5,
  );
  assert.equal(
    windows.find((window) => window.trigger === 'late_callback')!.summary
      .overwrittenRecords,
    5,
  );
  assert.equal(d.snapshot().retainedRecords, 0);
});

test('producer final byte bound includes updated totals and separately counts ring selection versus byte compaction', async () => {
  const windows: LiveTranslateSendDiagnostic[] = [];
  const longNumber = 0.0000012345678912345678;
  const d = createLiveTranslateSendDiagnostics({
    socket: {
      readyState: 1,
      bufferedAmount: longNumber,
      _sender: { _bufferedBytes: longNumber },
      _socket: { writableLength: longNumber },
      extensions: 'permessage-deflate',
    },
    now: () => longNumber,
    monotonicNow: () => longNumber,
    createMonitor: () => ({
      count: longNumber,
      mean: longNumber * 1e6,
      max: longNumber * 1e6,
      enable() {},
      disable() {},
    }),
    onDiagnostic: (event) => windows.push(event),
  });
  const state: any = bareState();
  for (const key of Object.keys(state)) {
    if (typeof state[key] === 'number') state[key] = longNumber;
    if (
      [
        'callbackDurationMs',
        'callbackAt',
        'callbackMonotonicAtMs',
        'firstUnconfirmedSequence',
        'prefixGapSequence',
        'oldestUnfinishedAgeMs',
        'closeCode',
      ].includes(key)
    )
      state[key] = longNumber;
  }
  for (let i = 0; i < 24; i += 1) d.record(state);
  d.record({
    ...state,
    stage: 'raw_callback',
    callbackError: false,
    callbackDuplicate: false,
    callbackAfterStop: false,
    callbackDisposition: 'first',
  });
  d.record({
    ...state,
    stage: 'send_failed',
    sendReason: 'pending_input_limit',
  });
  d.dispose();
  d.record({ ...bareState(), stage: 'transport_closed', closeCode: 1006 });
  await settle();
  const failure = windows.find((window) => window.trigger === 'send_failure')!;
  assert.ok(failure);
  assert.ok(failure.summary.windowTruncatedRecords > 0);
  assert.equal(failure.summary.windowContextOmittedRecords, 2);
  assert.equal(failure.records.at(-1)!.stage, 'send_failed');
  assert.equal(
    failure.firstFailure!.precedingRawCallback!.stage,
    'raw_callback',
  );
  assert.equal(failure.summary.overwrittenRecords, 0);
  assert.ok(
    windows.find((window) => window.trigger === 'transport_closed')!.summary
      .truncatedRecords >= failure.summary.windowTruncatedRecords,
  );
  for (const event of windows) {
    assert.ok(projectLiveTranslateSendDiagnostic(event));
    assert.ok(
      Buffer.byteLength(JSON.stringify(event)) <=
        LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOW_BYTES,
    );
    assert.ok(event.records.length <= 24);
  }
});
