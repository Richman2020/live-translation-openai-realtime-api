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
