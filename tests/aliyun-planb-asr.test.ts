import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';

import { createAliyunPlanBAsrClient } from '../src/solo/aliyun-planb-asr';
import type { CallContextSnapshot } from '../src/solo/call-context';
import type {
  AliyunPlanBConfig,
  PlanBAsrOptions,
  PlanBAsrDiagnostic,
  PlanBAsrSource,
  PlanBEvidence,
  PlanBUsage,
} from '../src/solo/aliyun-planb-types';

// Fake transports only: protocol fixtures establish neither ASR accuracy nor fees.
class Socket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;

  bufferedAmount = 0;

  sent: (Buffer | any)[] = [];

  terminated = 0;

  sendError = false;

  throwSend = false;

  throwTerminate = false;

  send(raw: string | Buffer, callback?: (error?: Error) => void) {
    if (this.throwSend) throw new Error('provider credential and body');
    this.sent.push(Buffer.isBuffer(raw) ? raw : JSON.parse(raw));
    callback?.(
      this.sendError ? new Error('provider credential and body') : undefined,
    );
  }

  open() {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }

  terminate() {
    this.terminated += 1;
    if (this.throwTerminate) throw new Error('provider credential and body');
    this.readyState = WebSocket.CLOSED;
  }
}

function config(
  region: 'beijing' | 'singapore' = 'beijing',
): AliyunPlanBConfig {
  return {
    region,
    apiKey: 'offline-fixture',
    asrModel: 'fun-asr-realtime',
    textModel: 'qwen-mt-flash',
    ttsModel: 'cosyvoice-v3-flash',
    voice: 'loongandy_v3',
    sampleRate: 24000,
    webSocketUrl: `wss://dashscope${region === 'singapore' ? '-intl' : ''}.aliyuncs.com/api-ws/v1/inference`,
    translationUrl: `https://dashscope${region === 'singapore' ? '-intl' : ''}.aliyuncs.com/compatible-mode/v1/chat/completions`,
  };
}
function fixture(overrides: Partial<PlanBAsrOptions> = {}) {
  const socket = new Socket();
  const errors: string[] = [];
  const diagnostics: PlanBAsrDiagnostic[] = [];
  const sources: PlanBAsrSource[] = [];
  const usages: PlanBUsage[] = [];
  const evidences: PlanBEvidence[] = [];
  const addresses: string[] = [];
  const client = createAliyunPlanBAsrClient({
    config: config(),
    role: 'local',
    now: () => 10000,
    createWebSocket(address) {
      addresses.push(address);
      return socket as unknown as WebSocket;
    },
    onSource: (source) => sources.push(source),
    onSourceDiagnostic: (event) => diagnostics.push(event),
    onError: (code) => errors.push(code),
    onUsage: (usage) => usages.push(usage),
    onEvidence: (evidence) => evidences.push(evidence),
    ...overrides,
  });
  const taskId = () =>
    socket.sent.find((sent) => !Buffer.isBuffer(sent))?.header?.task_id;
  const receive = (event: string, payload: any = {}, id = taskId()) =>
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ header: { event, task_id: id }, payload })),
      false,
    );
  const started = async () => {
    socket.open();
    receive('task-started');
    await client.ready;
  };
  const source = (sentence: any, duration?: number, id = taskId()) =>
    receive(
      'result-generated',
      {
        output: {
          sentence: {
            sentence_id: 1,
            begin_time: 0,
            end_time: 1000,
            sentence_end: false,
            text: '请确认。',
            ...sentence,
          },
        },
        ...(duration === undefined ? {} : { usage: { duration } }),
      },
      id,
    );
  return {
    client,
    socket,
    errors,
    sources,
    diagnostics,
    usages,
    evidences,
    addresses,
    receive,
    started,
    source,
    taskId,
  };
}

test('both regions declare ordinary bilingual Fun-ASR PCM24k with distinct zh/en role hints', async () => {
  for (const region of ['beijing', 'singapore'] as const) {
    for (const role of ['local', 'remote'] as const) {
      const f = fixture({ config: config(region), role });
      try {
        assert.throws(() => f.client.append(Buffer.alloc(480)), /NOT_READY/);
        // eslint-disable-next-line no-await-in-loop -- Each fake role owns its task lifecycle.
        await f.started();
        assert.equal(f.addresses.length, 1);
        assert.equal(f.addresses[0], config(region).webSocketUrl);
        const run = f.socket.sent[0];
        assert.match(
          run.header.task_id,
          /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i,
        );
        assert.equal(run.header.action, 'run-task');
        assert.equal(run.header.streaming, 'duplex');
        assert.equal(run.payload.model, 'fun-asr-realtime');
        assert.deepEqual(run.payload.parameters, {
          format: 'pcm',
          sample_rate: 24000,
          language_hints: [role === 'local' ? 'zh' : 'en'],
          heartbeat: true,
        });
        f.client.append(Buffer.alloc(480, 4));
        assert.deepEqual(f.socket.sent[1], Buffer.alloc(480, 4));
      } finally {
        f.client.abort();
      }
    }
  }
});

test('missing credential or wrong model/rate/role is refused before any socket construction', () => {
  for (const alteration of [
    { config: { ...config(), apiKey: '' } },
    { config: { ...config(), asrModel: 'fun-asr-flash-8k-realtime' } },
    { config: { ...config(), sampleRate: 8000 } },
    { role: 'unknown' },
  ]) {
    let connected = 0;
    assert.throws(
      () =>
        createAliyunPlanBAsrClient({
          config: config(),
          role: 'local',
          onSource: () => undefined,
          onError: () => undefined,
          ...alteration,
          createWebSocket() {
            connected += 1;
            throw new Error('must not connect');
          },
        } as PlanBAsrOptions),
      /PLAN_B_/,
    );
    assert.equal(connected, 0);
  }
});

test('same-task ACK is required, wrong and duplicate task events cannot publish or restart', async () => {
  const f = fixture();
  try {
    f.socket.open();
    f.receive('task-started', {}, 'older-task');
    f.source({ text: 'not this task' }, 80, 'older-task');
    assert.equal(f.sources.length, 0);
    assert.throws(() => f.client.append(Buffer.alloc(480)), /NOT_READY/);
    f.receive('task-started');
    await f.client.ready;
    f.receive('task-started');
    f.client.append(Buffer.alloc(480));
    assert.equal(
      f.socket.sent.filter((sent) => sent?.header?.action === 'run-task')
        .length,
      1,
    );
    assert.equal(f.errors.length, 0);
    assert.equal(f.usages.length, 0);
  } finally {
    f.client.abort();
  }
});

test('source updates preserve provider source order and times despite arrival order and short pauses', async () => {
  const f = fixture();
  try {
    await f.started();
    f.source({
      sentence_id: 2,
      begin_time: 2000,
      end_time: 2100,
      text: '稍等',
    });
    f.source({ sentence_id: 1, begin_time: 0, end_time: 500, text: '两点' });
    f.source({
      sentence_id: 1,
      begin_time: 0,
      end_time: 700,
      text: '两点，不，更正为三点',
    });
    f.source({
      sentence_id: 1,
      begin_time: 0,
      end_time: 1000,
      sentence_end: true,
      text: '三点，不是两点。',
    });
    assert.deepEqual(
      f.sources.map((s) => [s.sequence, s.revision, s.at, s.endAt]),
      [
        [3, 1, 12000, undefined],
        [2, 1, 10000, undefined],
        [2, 2, 10000, undefined],
        [2, 3, 10000, 11000],
      ],
    );
    assert.equal(f.sources.at(-1)!.text, '三点，不是两点。');
  } finally {
    f.client.abort();
  }
});

test('duplicate events, older endpoint revisions and late finals do not regress final source', async () => {
  const f = fixture();
  try {
    await f.started();
    f.source({ end_time: 500, text: '不是二百五十元' });
    f.source({ end_time: 500, text: '不是二百五十元' });
    f.source({ end_time: 300, text: '二百五十元' });
    f.source({
      end_time: 1000,
      sentence_end: true,
      text: '是二十五元，不是二百五十元。',
    });
    f.source({
      end_time: 1000,
      sentence_end: true,
      text: '是二十五元，不是二百五十元。',
    });
    f.source({ end_time: 800, text: '二百五十元' });
    f.source({ end_time: 1000, sentence_end: true, text: '二百五十元。' });
    assert.equal(f.sources.length, 2);
    assert.equal(f.sources.at(-1)!.text, '是二十五元，不是二百五十元。');
    assert.equal(f.errors.length, 0);
    assert.equal(
      f.evidences.filter((entry) => entry.event === 'correction').length,
      2,
    );
    assert.ok(
      f.evidences.every(
        (entry) => !JSON.stringify(entry).includes('二百五十元'),
      ),
    );
  } finally {
    f.client.abort();
  }
});

test('explicit heartbeat is ignored but defensive non-heartbeat ID zero is not discarded', async () => {
  const f = fixture();
  try {
    await f.started();
    f.source({ sentence_id: 0, heartbeat: true, text: '' });
    f.source({
      sentence_id: 0,
      heartbeat: false,
      text: '真实首句',
      sentence_end: true,
    });
    assert.equal(f.sources.length, 1);
    assert.equal(f.sources[0].sequence, 1);
    assert.equal(f.sources[0].text, '真实首句');
  } finally {
    f.client.abort();
  }
});

test('formal context is role-specific raw completed text, whole-source bounded and refreshes same task', async () => {
  let snapshot: CallContextSnapshot = {
    version: 1,
    entries: Array.from({ length: 7 }, (_, index) => ({
      role: 'local',
      sourceId: `source_${index}`,
      sourceKind: 'asr',
      at: index,
      order: index,
      revision: 1,
      observedAt: index,
      text: `原文 ${index}，不是25.00美元。`,
      provisional: false,
      generated: false,
    })),
  };
  snapshot.entries = [
    ...snapshot.entries,
    {
      ...snapshot.entries[0],
      text: '不要以英文译文伪装原文',
      sourceKind: 'native_output',
      generated: true,
    },
    { ...snapshot.entries[0], text: '未知未定稿', provisional: true },
    { ...snapshot.entries[0], text: 'opposite side', role: 'remote' },
    { ...snapshot.entries[0], text: `${'数'.repeat(400)}25.00`, at: 20 },
  ];
  const f = fixture({ getContext: () => snapshot });
  try {
    await f.started();
    const { context } = f.socket.sent[0].payload.input;
    assert.equal(context.length, 5);
    assert.deepEqual(context[0], {
      role: 'user',
      content: [{ type: 'input_text', text: '原文 2，不是25.00美元。' }],
    });
    assert.ok(
      context.every((entry: any) => entry.content[0].text.length <= 400),
    );
    f.client.append(Buffer.alloc(480));
    assert.equal(
      f.socket.sent.filter((s) => s?.header?.action === 'continue-task').length,
      0,
    );
    snapshot = {
      version: 2,
      entries: [{ ...snapshot.entries[0], text: '抱歉，更正为15日。' }],
    };
    f.client.append(Buffer.alloc(480));
    const update = f.socket.sent.find(
      (s) => s?.header?.action === 'continue-task',
    );
    assert.equal(update.header.task_id, f.taskId());
    assert.deepEqual(update.payload.input.context, [
      {
        role: 'user',
        content: [{ type: 'input_text', text: '抱歉，更正为15日。' }],
      },
    ]);
    assert.equal(f.addresses.length, 1);
  } finally {
    f.client.abort();
  }
});

test('cumulative duration takes only the maximum across duplicates, out-of-order results and final usage', async () => {
  const f = fixture();
  await f.started();
  f.source({ heartbeat: true, sentence_id: 0 }, 5);
  f.source({ heartbeat: true, sentence_id: 0 }, 5);
  f.source({ heartbeat: true, sentence_id: 0 }, 3);
  f.source({ heartbeat: true, sentence_id: 0 }, 7.5);
  const finished = f.client.finish();
  f.receive('task-finished', { usage: { duration: 7.5 } });
  await finished;
  assert.deepEqual(
    f.usages.map((usage) => usage.durationSeconds),
    [5, 7.5],
  );
  assert.equal(f.usages.at(-1)!.basis, 'provider_reported');
  assert.equal(f.socket.terminated, 1);
});

test('normal finish is idempotent, drains final source, closes resources and reports absent usage as unknown', async () => {
  const f = fixture();
  await f.started();
  const first = f.client.finish();
  assert.equal(f.client.finish(), first);
  assert.equal(
    f.socket.sent.filter((s) => s?.header?.action === 'finish-task').length,
    1,
  );
  assert.throws(() => f.client.append(Buffer.alloc(480)), /NOT_READY/);
  f.source({ sentence_end: true, text: '最后一句。' });
  f.receive('task-finished');
  await first;
  assert.equal(f.sources.length, 1);
  assert.equal(f.usages.at(-1)!.basis, 'unknown');
  assert.equal(f.socket.listenerCount('message'), 0);
  assert.equal(f.socket.listenerCount('open'), 0);
  assert.equal(f.socket.terminated, 1);
  f.client.abort();
  f.socket.emit('error', new Error('late sensitive provider error'));
  assert.equal(f.errors.length, 0);
});

test('finish requested while connecting sends once only after same-task started gate', async () => {
  const f = fixture();
  const finished = f.client.finish();
  assert.equal(f.socket.sent.length, 0);
  await f.started();
  assert.equal(f.socket.sent.length, 2);
  assert.equal(f.socket.sent[1].header.action, 'finish-task');
  f.receive('task-finished', { usage: { duration: 0 } });
  await finished;
});

test('abort synchronously fences late events, pending ready/finish, sending and duplicate cancellation', async () => {
  const f = fixture();
  f.socket.open();
  const finished = f.client.finish();
  const sent = f.socket.sent.length;
  f.client.abort();
  f.receive('task-started');
  f.source({ text: 'late source' }, 10);
  assert.throws(() => f.client.append(Buffer.alloc(480)), /CANCELLED/);
  await assert.rejects(f.client.ready, /CANCELLED/);
  await assert.rejects(finished, /CANCELLED/);
  f.client.abort();
  assert.equal(f.socket.sent.length, sent);
  assert.equal(f.socket.terminated, 1);
  assert.equal(f.sources.length, 0);
  assert.equal(f.usages.length, 0);
});

test('start timeout cannot reconnect or accept a late ACK', async () => {
  const f = fixture({ timeoutMs: 10 });
  f.socket.open();
  await assert.rejects(f.client.ready, /START_TIMEOUT/);
  f.receive('task-started');
  f.source({ text: 'late' });
  assert.equal(f.addresses.length, 1);
  assert.equal(f.errors.length, 1);
  assert.equal(f.sources.length, 0);
});

test('active streaming outlives connection timeout without fixed-duration termination', async () => {
  const f = fixture({ timeoutMs: 10 });
  try {
    await f.started();
    await delay(30);
    f.client.append(Buffer.alloc(480));
    f.source({ sentence_end: true, text: '继续通话' });
    assert.equal(f.errors.length, 0);
    assert.equal(f.socket.terminated, 0);
    assert.equal(f.sources.length, 1);
  } finally {
    f.client.abort();
  }
});

test('finish timeout stops once and old final events do not produce more requests or usage', async () => {
  const f = fixture({ timeoutMs: 10 });
  await f.started();
  const ended = f.client.finish();
  await assert.rejects(ended, /FINISH_TIMEOUT/);
  const sent = f.socket.sent.length;
  f.receive('task-finished', { usage: { duration: 50 } });
  f.source({ text: 'late final', sentence_end: true }, 50);
  assert.equal(f.socket.sent.length, sent);
  assert.equal(f.addresses.length, 1);
  assert.equal(f.usages.length, 0);
});

test('provider failure is a fixed code, closes once and never leaks message, credentials or retries', async () => {
  const f = fixture();
  f.socket.open();
  f.receive('task-failed', { secret: 'not to be logged' });
  await assert.rejects(f.client.ready, /PLAN_B_ASR_PROVIDER_FAILED/);
  assert.deepEqual(f.errors, ['PLAN_B_ASR_PROVIDER_FAILED']);
  assert.equal(f.addresses.length, 1);
  assert.equal(f.socket.terminated, 1);
  assert.ok(!JSON.stringify(f.evidences).includes('not to be logged'));
});

test('source ID changing its begin time fails rather than mixing source identity', async () => {
  const f = fixture();
  await f.started();
  f.source({ begin_time: 1, text: '原来源' });
  f.source({ begin_time: 2, text: '冲突来源' });
  assert.deepEqual(f.errors, ['PLAN_B_ASR_SOURCE_ID_CONFLICT']);
  assert.equal(f.sources.length, 1);
  await assert.rejects(f.client.finish(), /SOURCE_ID_CONFLICT/);
});

test('malformed source events and unexpected binary fail safely without raw exception data', async () => {
  for (const invalid of [
    { sentence_id: -1 },
    { begin_time: -1 },
    { end_time: -1 },
    { sentence_end: true, end_time: null },
    { text: 'x'.repeat(4097) },
  ]) {
    const f = fixture();
    // eslint-disable-next-line no-await-in-loop -- Isolate each malformed protocol case.
    await f.started();
    f.source(invalid);
    assert.deepEqual(f.errors, ['PLAN_B_ASR_SOURCE_INVALID']);
    assert.equal(f.socket.terminated, 1);
  }
  const f = fixture();
  await f.started();
  f.socket.emit('message', Buffer.alloc(480), true);
  assert.deepEqual(f.errors, ['PLAN_B_ASR_UNEXPECTED_BINARY']);
});

test('PCM alignment, backlog, send callback and synchronous send errors all fence subsequent sends', async () => {
  for (const mode of ['odd', 'backlog', 'callback', 'throw'] as const) {
    const f = fixture();
    // eslint-disable-next-line no-await-in-loop -- Each mode has independent teardown assertions.
    await f.started();
    if (mode === 'backlog') f.socket.bufferedAmount = 1024 * 1024 + 1;
    if (mode === 'callback') f.socket.sendError = true;
    if (mode === 'throw') f.socket.throwSend = true;
    if (mode === 'odd')
      assert.throws(() => f.client.append(Buffer.alloc(3)), /PCM_INVALID/);
    else f.client.append(Buffer.alloc(480));
    const count = f.socket.sent.length;
    assert.throws(() => f.client.append(Buffer.alloc(480)), /PLAN_B_ASR_/);
    assert.equal(f.socket.sent.length, count);
    assert.equal(f.errors.length, 1);
    assert.equal(f.addresses.length, 1);
  }
});

test('disconnection and callback exceptions preserve fixed errors and release listeners', async () => {
  const f = fixture();
  await f.started();
  f.socket.emit('close');
  assert.deepEqual(f.errors, ['PLAN_B_ASR_DISCONNECTED']);
  assert.equal(f.socket.listenerCount('message'), 0);
  const g = fixture({
    onSource() {
      throw new Error('private transcript and token');
    },
  });
  await g.started();
  g.source({ text: 'private transcript' });
  assert.deepEqual(g.errors, ['PLAN_B_ASR_CALLBACK_FAILED']);
  assert.ok(!JSON.stringify(g.evidences).includes('private transcript'));
});

test('teardown exceptions do not un-fence a cancelled task or trigger another connection', async () => {
  const f = fixture();
  await f.started();
  f.socket.throwTerminate = true;
  f.client.abort();
  f.source({ text: 'late' });
  assert.equal(f.sources.length, 0);
  assert.throws(() => f.client.append(Buffer.alloc(480)), /CANCELLED/);
  assert.equal(f.addresses.length, 1);
  assert.equal(f.socket.listenerCount('message'), 0);
});

test('result before started, unsolicited finished, malformed JSON and oversized events fail closed', async () => {
  const f = fixture();
  f.socket.open();
  f.source({ text: 'early' });
  await assert.rejects(f.client.ready, /TASK_NOT_STARTED/);
  const g = fixture();
  await g.started();
  g.receive('task-finished');
  assert.deepEqual(g.errors, ['PLAN_B_ASR_UNEXPECTED_FINISH']);
  const h = fixture();
  await h.started();
  h.socket.emit('message', Buffer.from('{bad json'), false);
  assert.deepEqual(h.errors, ['PLAN_B_ASR_EVENT_INVALID']);
  const i = fixture();
  await i.started();
  i.socket.emit('message', Buffer.alloc(1024 * 1024 + 1), false);
  assert.deepEqual(i.errors, ['PLAN_B_ASR_EVENT_TOO_LARGE']);
});

test('source retention remains bounded while late retired sources cannot be resurrected', async () => {
  const f = fixture();
  try {
    await f.started();
    for (let index = 1; index <= 140; index += 1) {
      f.source({
        sentence_id: index,
        begin_time: index * 1000,
        end_time: index * 1000 + 900,
        sentence_end: true,
        text: `来源 ${index}`,
      });
    }
    f.source({
      sentence_id: 1,
      begin_time: 1000,
      end_time: 1900,
      sentence_end: true,
      text: '迟到旧来源',
    });
    assert.equal(f.sources.length, 140);
    assert.equal(f.errors.length, 0);
  } finally {
    f.client.abort();
  }
});

// Minimal scalar shapes from the verified short-audio source revisions; text is
// synthetic. The original audio/body is not required for this offline fixture.
test('captured null-end start refinement and retained alias revision keep one ASR identity', async () => {
  const f = fixture();
  await f.started();
  f.client.append(Buffer.alloc(24000 * 2 * 5));
  f.source({ begin_time: 1720, end_time: null, text: '合成初稿' });
  f.source({ begin_time: 2280, end_time: null, text: '合成修订' });
  f.source({ begin_time: 1720, end_time: null, text: '合成初稿' });
  f.source({ begin_time: 1720, end_time: null, text: '合成后续修订' });
  f.source({
    begin_time: 2280,
    end_time: 4000,
    sentence_end: true,
    text: '合成最终句。',
  });
  f.source({
    begin_time: 1720,
    end_time: 4000,
    sentence_end: true,
    text: '合成最终句。',
  });
  assert.deepEqual(
    f.sources.map((item) => item.revision),
    [1, 2, 3, 4],
  );
  assert.equal(new Set(f.sources.map((item) => item.sequence)).size, 1);
  assert.equal(new Set(f.sources.map((item) => item.at)).size, 1);
  assert.equal(f.sources.at(-1).endAt, 14000);
  assert.deepEqual(
    f.diagnostics.map((item) => item.decision),
    [
      'accepted',
      'partial_begin_refined',
      'partial_begin_replay_ignored',
      'partial_begin_alias_revised',
      'final_begin_alias_accepted',
      'final_duplicate_ignored',
    ],
  );
  assert.deepEqual(f.errors, []);
  f.client.abort();
});

test('final endpoint can return to known pre-refinement start, but cannot authorize a third start', async () => {
  for (const finalBegin of [1600, 1680, 1640]) {
    const f = fixture();
    // eslint-disable-next-line no-await-in-loop -- Isolated fake tasks per candidate boundary.
    await f.started();
    f.client.append(Buffer.alloc(24000 * 2 * 4));
    f.source({ begin_time: 1600, end_time: null, text: '初稿' });
    f.source({ begin_time: 1680, end_time: null, text: '新稿' });
    f.source({
      begin_time: finalBegin,
      end_time: 2400,
      sentence_end: true,
      text: '完成。',
    });
    if (finalBegin === 1640) {
      assert.deepEqual(f.errors, ['PLAN_B_ASR_SOURCE_ID_CONFLICT']);
      assert.equal(f.sources.length, 2);
    } else {
      assert.equal(f.sources.length, 3);
      assert.equal(f.sources.at(-1).final, true);
      assert.deepEqual(f.errors, []);
    }
    f.client.abort();
  }
});

test('changed ASR start remains bounded by queued audio, neighboring source and explicit-null partial shape', async () => {
  const cases = [
    { begin_time: 4001, end_time: null },
    { begin_time: 1800, end_time: undefined },
    { begin_time: 1800, end_time: 2200 },
    { begin_time: 1800, end_time: null, sentence_begin: true },
  ];
  for (const incoming of cases) {
    const f = fixture();
    // eslint-disable-next-line no-await-in-loop -- Isolated invalid fake source frames.
    await f.started();
    f.client.append(Buffer.alloc(24000 * 2 * 4));
    f.source({ begin_time: 1600, end_time: null, text: '初稿' });
    f.source({ ...incoming, text: '修订' });
    assert.deepEqual(f.errors, ['PLAN_B_ASR_SOURCE_ID_CONFLICT']);
    f.client.abort();
  }
  const f = fixture();
  await f.started();
  f.client.append(Buffer.alloc(24000 * 2 * 4));
  f.source({ sentence_id: 2, begin_time: 2000, end_time: null, text: '后句' });
  f.source({ sentence_id: 1, begin_time: 1600, end_time: null, text: '前句' });
  f.source({
    sentence_id: 1,
    begin_time: 2000,
    end_time: null,
    text: '跨界稿',
  });
  assert.deepEqual(f.errors, ['PLAN_B_ASR_SOURCE_ID_CONFLICT']);
  f.client.abort();
});

test('refined empty final withdraws once and old partial cannot revive an ended source', async () => {
  const f = fixture();
  await f.started();
  f.client.append(Buffer.alloc(24000 * 2 * 4));
  f.source({ begin_time: 1600, end_time: null, text: '初稿' });
  f.source({ begin_time: 1680, end_time: null, text: '新稿' });
  f.source({ begin_time: 1600, end_time: 2400, sentence_end: true, text: '' });
  f.source({ begin_time: 1680, end_time: null, text: '不得复活' });
  assert.equal(f.sources.length, 3);
  assert.equal(f.sources.at(-1).text, '');
  assert.equal(f.sources.at(-1).final, true);
  assert.deepEqual(f.errors, []);
  assert.equal(f.diagnostics.at(-1).decision, 'final_revision_ignored');
  f.client.abort();
});

test('ASR diagnostic whitelist never exports text or raw task data, and observer mutation cannot alter source decisions', async () => {
  const snapshots: PlanBAsrDiagnostic[] = [];
  const f = fixture({
    onSourceDiagnostic(event) {
      snapshots.push(JSON.parse(JSON.stringify(event)));
      event.incoming.beginMs = 999999;
      if (event.previousAccepted)
        event.previousAccepted.providerSentenceId = 999;
    },
  });
  await f.started();
  f.source({ text: 'synthetic-private-source-body' });
  f.source({ text: 'synthetic-final', sentence_end: true });
  assert.equal(f.sources.length, 2);
  assert.equal(f.sources[0].at, 10000);
  assert.equal(snapshots[1].previousAccepted.providerSentenceId, 1);
  const encoded = JSON.stringify(snapshots);
  for (const secret of [
    'synthetic-private-source-body',
    'synthetic-final',
    'offline-fixture',
    f.taskId(),
    'Authorization',
  ])
    assert(!encoded.includes(secret));
  assert.deepEqual(f.errors, []);
  f.client.abort();
});

test('configured heartbeat keeps a long silent fake task open but real transport close still cleans up without reconnect', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ timeoutMs: 10 });
  await f.started();
  assert.equal(f.socket.sent[0].payload.parameters.heartbeat, true);
  assert.equal(
    'semantic_punctuation_enabled' in f.socket.sent[0].payload.parameters,
    false,
  );
  assert.equal(
    'max_sentence_silence' in f.socket.sent[0].payload.parameters,
    false,
  );
  assert.equal(
    'multi_threshold_mode_enabled' in f.socket.sent[0].payload.parameters,
    false,
  );
  const silentSecond = Buffer.alloc(24000 * 2);
  for (let second = 0; second < 600; second += 1) {
    f.client.append(silentSecond);
    context.mock.timers.tick(1000);
    if (second % 60 === 0)
      f.source({ sentence_id: 0, heartbeat: true, text: '' });
  }
  // A fake supplier cannot prove real idle behavior. This verifies the formal
  // parameter, no application call timer, heartbeat filtering and cleanup.
  assert.equal(f.socket.sent.filter(Buffer.isBuffer).length, 600);
  assert.equal(f.sources.length, 0);
  assert.deepEqual(f.errors, []);
  assert.equal(f.socket.terminated, 0);
  assert.equal(f.addresses.length, 1);
  f.socket.emit('close', 1006, Buffer.from('private provider close reason'));
  assert.deepEqual(f.errors, ['PLAN_B_ASR_DISCONNECTED']);
  assert.equal(f.socket.terminated, 1);
  const sent = f.socket.sent.length;
  assert.throws(() => f.client.append(silentSecond), /PLAN_B_ASR_DISCONNECTED/);
  f.source({ sentence_id: 0, heartbeat: true, text: '' });
  context.mock.timers.tick(600000);
  assert.equal(f.socket.sent.length, sent);
  assert.equal(f.addresses.length, 1);
  assert.equal(f.sources.length, 0);
  assert(!JSON.stringify(f.errors).includes('private'));
  f.client.abort();
});

test('actual ASR close codes are bounded scalar metadata and raw close reasons or abort-induced late closes never escape', async () => {
  for (const closeCode of [
    1000,
    1006,
    1011,
    4999,
    999,
    5000,
    '1006',
    Number.NaN,
  ]) {
    const f = fixture();
    // eslint-disable-next-line no-await-in-loop -- Each fake socket has an isolated close lifecycle.
    await f.started();
    f.socket.emit(
      'close',
      closeCode,
      Buffer.from('PRIVATE raw provider close message and body'),
    );
    const failure = f.evidences.find((event) => event.event === 'failed');
    assert.equal(failure.code, 'PLAN_B_ASR_DISCONNECTED');
    const valid =
      typeof closeCode === 'number' &&
      Number.isInteger(closeCode) &&
      closeCode >= 1000 &&
      closeCode <= 4999;
    if (valid) assert.equal(failure.closeCode, closeCode);
    else assert.equal('closeCode' in failure, false);
    assert.equal(
      f.evidences.filter((event) => event.event === 'failed').length,
      1,
    );
    assert(!JSON.stringify(f.evidences).includes('PRIVATE'));
    assert.equal(f.socket.listenerCount('close'), 0);
    f.client.abort();
  }
  const f = fixture();
  await f.started();
  f.client.abort();
  f.socket.emit(
    'close',
    1006,
    Buffer.from('PRIVATE cancellation close reason'),
  );
  assert.deepEqual(f.errors, []);
  assert.equal(
    f.evidences.filter((event) => event.event === 'failed').length,
    0,
  );
});
