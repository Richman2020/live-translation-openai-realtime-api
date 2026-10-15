/* eslint-disable no-await-in-loop, max-classes-per-file -- Fake phone and supplier peers preserve protocol ownership and order. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import WebSocket from 'ws';

import { createAliyunPlanBBridge } from '../src/solo/aliyun-planb-bridge';
import type { AliyunPlanBConfig } from '../src/solo/aliyun-planb-types';
import type { SoloConfig } from '../src/solo/config';
import { SessionManager } from '../src/solo/session-manager';
import { reportCloudCallTermination } from '../src/solo/cloud-service';
import { ALIYUN_PHONE_STREAM_METADATA } from './fixtures/aliyun-phone-stream-metadata';

const phoneConfig = {
  PUBLIC_BASE_URL: 'https://offline.example.com',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_CALLER_NUMBER: '+12125550123',
  OPENAI_API_KEY: '',
  OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
} as SoloConfig;
const aliyun: AliyunPlanBConfig = {
  region: 'beijing',
  apiKey: 'offline-aliyun-key',
  asrModel: 'fun-asr-realtime',
  textModel: 'qwen-mt-flash',
  ttsModel: 'cosyvoice-v3-flash',
  voice: 'loongandy_v3',
  sampleRate: 24000,
  webSocketUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
  translationUrl:
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
};
const localSid = `CA${'1'.repeat(32)}`;
const remoteSid = `CA${'2'.repeat(32)}`;

class Phone extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  sent: any[] = [];

  constructor(readonly streamSid: string) {
    super();
  }

  send(data: string, callback?: (error?: Error) => void) {
    const event = JSON.parse(data);
    this.sent.push(event);
    callback?.();
    if (event.event === 'mark') this.receive(event);
  }

  receive(event: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }

  media(pcmu = Buffer.alloc(160, 0xff)) {
    this.receive({
      event: 'media',
      streamSid: this.streamSid,
      media: {
        track: 'inbound',
        payload: pcmu.toString('base64'),
        timestamp: '20',
      },
    });
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1000);
  }

  terminate() {
    this.close();
  }
}

class Supplier extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;

  task = '';

  taskId = '';

  role = '';

  inputBytes = 0;

  controls: any[] = [];

  constructor(
    readonly spoken: string[],
    readonly ttsCloseCode?: number,
  ) {
    super();
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN;
      this.emit('open');
    });
  }

  event(name: string, payload: object = {}) {
    this.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          header: { task_id: this.taskId, event: name },
          payload,
        }),
      ),
      false,
    );
  }

  send(data: string | Buffer, callback?: (error?: Error) => void) {
    callback?.();
    if (Buffer.isBuffer(data)) {
      this.inputBytes += data.length;
      return;
    }
    const packet = JSON.parse(data);
    this.controls.push(packet);
    const { action } = packet.header;
    if (action === 'run-task') {
      this.taskId = packet.header.task_id;
      this.task = packet.payload.task;
      this.role =
        packet.payload.parameters.language_hints?.[0] === 'zh'
          ? 'local'
          : 'remote';
      queueMicrotask(() => this.event('task-started'));
    }
    if (this.task === 'tts' && action === 'continue-task') {
      this.spoken.push(packet.payload.input.text);
    }
    if (
      this.task === 'tts' &&
      action === 'finish-task' &&
      packet.payload.input.directive !== 'cancel'
    ) {
      queueMicrotask(() => {
        if (this.readyState !== WebSocket.OPEN) return;
        if (this.ttsCloseCode !== undefined) {
          this.close(
            this.ttsCloseCode,
            Buffer.from('private supplier close reason words and key'),
          );
          return;
        }
        this.event('result-generated', {
          output: { type: 'sentence-synthesis', sentence: { index: 0 } },
        });
        this.emit('message', Buffer.alloc(9600, 10), true);
        this.event('task-finished', { usage: { characters: 40 } });
      });
    }
  }

  source(id: number, text: string, final = true, begin = 0, end = 100) {
    this.event('result-generated', {
      output: {
        sentence: {
          sentence_id: id,
          text,
          sentence_end: final,
          begin_time: begin,
          end_time: final ? end : null,
          heartbeat: false,
        },
      },
    });
  }

  close(code = 1000, reason = Buffer.alloc(0)) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, reason);
  }

  terminate() {
    this.close();
  }
}

function sse(text: string): Response {
  return new Response(
    [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 20 } })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

async function flush() {
  for (let i = 0; i < 30; i += 1) await tick();
}

async function harness(
  t: TestContext,
  translate: (
    source: string,
    body: any,
    signal: AbortSignal,
  ) => Promise<Response>,
  supplierBehavior: { ttsCloseCode?: number; throwOnEvidence?: boolean } = {},
) {
  let now = 100000;
  let remoteNonce = '';
  const events: any[] = [];
  const suppliers: Supplier[] = [];
  const spoken: string[] = [];
  const requests: any[] = [];
  const hungup: string[] = [];
  const failures: string[] = [];
  const terminations: any[] = [];
  const terminationLines: string[] = [];
  const local = new Phone(`MZ${'3'.repeat(32)}`);
  const remote = new Phone(`MZ${'4'.repeat(32)}`);
  const manager = new SessionManager({
    maxCallMs: null,
    now: () => now,
    providerFactory: () => ({
      create: async (args) => {
        remoteNonce = new URL(String(args.url)).searchParams.get('nonce')!;
        return { sid: remoteSid };
      },
      hangup: async (sid) => {
        hungup.push(sid);
      },
    }),
    bridgeFactory: (options) =>
      createAliyunPlanBBridge(
        {
          ...options,
          now: () => now,
          onFailure: (code) => {
            failures.push(code);
            options.onFailure(code);
          },
        },
        {
          config: aliyun,
          onEvidence: (e) => {
            if (e.event === 'failed' && e.code) failures.push(e.code);
            if (supplierBehavior.throwOnEvidence)
              throw new Error('private observer failure');
          },
          deps: {
            createWebSocket: (address) => {
              assert.equal(address, aliyun.webSocketUrl);
              const socket = new Supplier(
                spoken,
                supplierBehavior.ttsCloseCode,
              );
              suppliers.push(socket);
              return socket as unknown as WebSocket;
            },
            fetch: async (_url, init) => {
              const body = JSON.parse(String(init?.body));
              requests.push(body);
              assert.equal(body.messages.length, 1);
              assert.equal(body.messages[0].role, 'user');
              assert.equal(body.model, 'qwen-mt-flash');
              assert.equal(body.max_tokens, 2048);
              return translate(body.messages[0].content, body, init!.signal!);
            },
          },
        },
      ),
  });
  t.after(async () => {
    await manager.close();
  });
  manager.on('event', (event) => events.push(event));
  manager.on('diagnostic', (event) => {
    terminations.push(event);
    reportCloudCallTermination(event, (line) => terminationLines.push(line));
  });
  manager.setPresence(true);
  const call = manager.createOutbound(
    phoneConfig,
    '+14155550123',
    'continuous-captions',
  );
  manager.connectBrowser({
    ...call.connectionParams,
    From: 'client:ai-phone',
    CallSid: localSid,
  });
  const attach = (role: 'local' | 'remote', socket: Phone) =>
    manager.attachMedia(socket as unknown as WebSocket, {
      customParameters: {
        ...call.connectionParams,
        role,
        nonce: role === 'local' ? call.connectionParams.nonce : remoteNonce,
      },
      accountSid: phoneConfig.TWILIO_ACCOUNT_SID,
      callSid: role === 'local' ? localSid : remoteSid,
      streamSid: socket.streamSid,
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    });
  assert.equal(attach('local', local), true);
  await flush();
  manager.connectLeg(call.id, 'remote', remoteNonce, remoteSid);
  assert.equal(attach('remote', remote), true);
  await flush();
  const asr = (role: string) =>
    suppliers.find((socket) => socket.task === 'asr' && socket.role === role)!;
  assert.ok(asr('local'));
  assert.ok(asr('remote'));
  return {
    manager,
    call,
    local,
    remote,
    events,
    spoken,
    suppliers,
    requests,
    hungup,
    failures,
    terminations,
    terminationLines,
    asr,
    advance(ms: number) {
      now += ms;
    },
  };
}

test('real phone manager and Alibaba protocols pair both directions without OpenAI or Chinese TTS', async (t) => {
  const translations: Record<string, string> = {
    '费用二十五元，不是二百五十元。':
      'It costs twenty-five yuan, not two hundred and fifty.',
    '更正，日期是十六日。': 'Correction: the date is the sixteenth.',
    'Do not cancel the corrected date.': '不要取消更正后的日期。',
  };
  const h = await harness(t, async (source) => sse(translations[source]));
  h.local.media(Buffer.alloc(8000, 0xff));
  const original = Buffer.alloc(160, 0x91);
  h.remote.media(original);
  await flush();
  assert.ok(
    h.local.sent.some(
      (event) =>
        event.event === 'media' &&
        event.media.payload === original.toString('base64'),
    ),
  );
  assert.ok(h.asr('local').inputBytes > 0 && h.asr('remote').inputBytes > 0);
  h.advance(1000);
  h.asr('local').source(1, '费用二十五', false, 20);
  h.asr('local').source(1, '费用二十五元', false, 40);
  h.asr('local').source(1, '费用二十五元，不是二百五十元。', true, 20, 900);
  await flush();
  assert.deepEqual(
    h.spoken,
    [translations['费用二十五元，不是二百五十元。']],
    JSON.stringify({ failures: h.failures, requests: h.requests.length }),
  );
  h.advance(1000);
  h.asr('local').source(2, '更正，日期是十六日。', true, 1000, 1800);
  await flush();
  assert.equal(h.requests[1].messages[0].content, '更正，日期是十六日。');
  assert.deepEqual(h.requests[1].translation_options.tm_list, [
    {
      source: '费用二十五元，不是二百五十元。',
      target: translations['费用二十五元，不是二百五十元。'],
    },
  ]);
  h.asr('remote').source(1, 'Do not cancel the corrected date.', true, 0, 100);
  await flush();
  assert.equal(h.spoken.length, 2);
  assert.equal(h.requests.at(-1).translation_options.source_lang, 'English');
  assert.equal(h.requests.at(-1).translation_options.target_lang, 'Chinese');
  assert.ok(!h.requests.at(-1).translation_options.tm_list?.length);
  const tts = h.suppliers.filter((socket) => socket.task === 'tts');
  assert.equal(tts.length, 2);
  assert.ok(
    tts.every(
      (socket) =>
        socket.controls[0].payload.parameters.voice === 'loongandy_v3',
    ),
  );
  const translated = h.events.filter(
    (event) =>
      event.event === 'transcript' && event.data.kind === 'translation',
  );
  assert.ok(
    translated.some((event) => event.data.text === '不要取消更正后的日期。'),
  );
  const timing = h.events
    .filter((event) => event.event === 'translation-timing')
    .map((event) => event.data);
  for (const stage of [
    'provider_endpoint_estimate',
    'asr_final',
    'translation_complete',
    'audio_first_sample',
    'playback_queued',
    'playback_drained',
  ])
    assert.ok(
      timing.some((event) => event.stage === stage),
      stage,
    );
  assert.ok(timing.every((event) => event.actualPlaybackStartAt === null));
  assert.ok(!JSON.stringify(timing).includes('二十五'));
  assert.ok(!JSON.stringify(timing).includes(aliyun.apiKey));
  await h.manager.end(h.call.id);
  assert.deepEqual(new Set(h.hungup), new Set([localSid, remoteSid]));
});

test('JSON model output fails before TTS and clears both fake phone legs', async (t) => {
  const h = await harness(t, async () =>
    sse('{"CURRENT_SOURCE":"Hello","history":"old text"}'),
  );
  h.advance(1000);
  h.asr('local').source(1, '你好。');
  await flush();
  assert.equal(h.spoken.length, 0);
  assert.ok(h.failures.some((code) => code.includes('TRANSLATION_BODY')));
  assert.equal(h.suppliers.filter((socket) => socket.task === 'tts').length, 0);
  assert.deepEqual(new Set(h.hungup), new Set([localSid, remoteSid]));
  assert.ok(
    !h.events.some(
      (event) =>
        event.event === 'transcript' &&
        event.data.kind === 'translation' &&
        event.data.text.includes('CURRENT_SOURCE'),
    ),
  );
});

test('duplicate ASR identity is ignored but genuinely repeated words under new identities are spoken', async (t) => {
  const h = await harness(t, async () => sse('Please wait.'));
  h.advance(1000);
  h.asr('local').source(1, '请等一下。', true, 0, 100);
  await flush();
  h.asr('local').source(1, '请等一下。', true, 0, 100);
  h.asr('local').source(2, '请等一下。', true, 200, 300);
  await flush();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.spoken, ['Please wait.', 'Please wait.']);
});

test('earlier provisional ASR blocks later final and preserves full tail and original order', async (t) => {
  const h = await harness(t, async (source) =>
    sse(source.includes('第一') ? 'First, do not pay.' : 'Second, wait.'),
  );
  h.advance(2000);
  h.asr('local').source(1, '第一', false, 0);
  h.asr('local').source(2, '第二，等待。', true, 400, 600);
  await flush();
  assert.equal(h.spoken.length, 0);
  h.asr('local').source(1, '第一，不要付款。', true, 0, 300);
  await flush();
  assert.deepEqual(h.spoken, ['First, do not pay.', 'Second, wait.']);
  assert.deepEqual(
    h.requests.map((body) => body.messages[0].content),
    ['第一，不要付款。', '第二，等待。'],
  );
});

test('manual hangup while MT is pending prevents late TTS or any new supplier request', async (t) => {
  let resolve!: (value: Response) => void;
  const h = await harness(
    t,
    async () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  h.advance(1000);
  h.asr('local').source(1, '请等待。');
  await flush();
  assert.equal(h.requests.length, 1);
  await h.manager.end(h.call.id);
  resolve(sse('Please wait.'));
  h.asr('local').source(2, '再说一句。', true, 200, 300);
  h.remote.media();
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.spoken.length, 0);
  assert.ok(
    h.suppliers.every((socket) => socket.readyState === WebSocket.CLOSED),
  );
});

test('healthy simulated call beyond three minutes can still translate without audition caps', async (t) => {
  const h = await harness(t, async () => sse('Continue the call.'));
  h.advance(240000);
  h.local.media();
  h.remote.media();
  h.asr('local').source(1, '继续通话。', true, 239000, 239500);
  await flush();
  assert.deepEqual(h.spoken, ['Continue the call.']);
  assert.equal(h.hungup.length, 0);
});

test('explanation text is rejected rather than stripped and spoken', async (t) => {
  const h = await harness(t, async () =>
    sse('Here is the translation: Hello.'),
  );
  h.advance(1000);
  h.asr('local').source(1, '你好。');
  await flush();
  assert.ok(h.failures.some((code) => code.includes('BODY_META_PREFIX')));
  assert.equal(h.spoken.length, 0);
  assert.deepEqual(new Set(h.hungup), new Set([localSid, remoteSid]));
});

test('full known historical prefix cannot be spoken as the next current correction', async (t) => {
  const h = await harness(t, async (source) =>
    sse(
      source.includes('更正')
        ? 'The date is the fifteenth. Correction: the date is the sixteenth.'
        : 'The date is the fifteenth.',
    ),
  );
  h.advance(2000);
  h.asr('local').source(1, '日期是十五日。', true, 0, 100);
  await flush();
  h.asr('local').source(2, '更正，是十六日。', true, 200, 300);
  await flush();
  assert.deepEqual(h.spoken, ['The date is the fifteenth.']);
  assert.ok(h.failures.some((code) => code.includes('HISTORY_REPLAY_SUSPECT')));
  assert.deepEqual(new Set(h.hungup), new Set([localSid, remoteSid]));
});

test('captured ASR metadata order and revisions integrate using explicitly synthetic words', async (t) => {
  const first = '这是一段合成说明，费用不是二百五十元。';
  const correction = '更正，费用是二十五元。';
  const h = await harness(t, async (source) =>
    sse(
      source === first
        ? 'The synthetic fee is not two hundred and fifty yuan.'
        : 'Correction: the fee is twenty-five yuan.',
    ),
  );
  // Offered silence satisfies the recorded provider timestamp/sample bounds.
  // This is not real audio or a latency/recognition-quality measurement.
  for (let i = 0; i < 22; i += 1) h.local.media(Buffer.alloc(8000, 0xff));
  let previousAt = 0;
  for (const recorded of ALIYUN_PHONE_STREAM_METADATA.events) {
    h.advance(recorded.receivedAt - previousAt);
    previousAt = recorded.receivedAt;
    const descriptor = recorded.sentence;
    const id = descriptor.providerSentenceId;
    let text = '';
    if (descriptor.textState !== 'empty') {
      if (descriptor.final) text = id === 2 ? first : correction;
      else text = `合成临时文本${recorded.arrivalSequence}`;
    }
    h.asr('local').event('result-generated', {
      output: {
        sentence: {
          sentence_id: id,
          begin_time: descriptor.beginMs,
          end_time: descriptor.endMs,
          sentence_end: descriptor.final,
          text,
        },
      },
    });
    await flush();
  }
  assert.equal(ALIYUN_PHONE_STREAM_METADATA.rawProviderFrames, false);
  assert.equal(ALIYUN_PHONE_STREAM_METADATA.events.length, 44);
  assert.deepEqual(
    h.requests.map((body) => body.messages[0].content),
    [first, correction],
  );
  assert.deepEqual(h.spoken, [
    'The synthetic fee is not two hundred and fifty yuan.',
    'Correction: the fee is twenty-five yuan.',
  ]);
  assert.equal(h.failures.length, 0);
});

for (const [role, code] of [
  ['local', 1006],
  ['remote', 1011],
] as const) {
  test(`actual ${role} ASR close code ${code} reaches the first call termination without its private close reason`, async (t) => {
    const h = await harness(t, async () => sse('Hello.'), {
      throwOnEvidence: true,
    });
    h.asr(role).close(
      code,
      Buffer.from('private supplier words token and phone'),
    );
    await flush();
    assert.equal(h.terminations.length, 1);
    assert.deepEqual(h.terminations[0], {
      event: 'CLOUD_CALL_TERMINATION',
      reason: 'PLAN_B_ASR_DISCONNECTED',
      component: 'asr',
      layer: 'provider',
      role,
      callId: h.call.id,
      wsCloseCode: code,
      observedAtMs: 100000,
      elapsedMs: 0,
    });
    assert.deepEqual(JSON.parse(h.terminationLines[0]), h.terminations[0]);
    assert.doesNotMatch(h.terminationLines[0], /private|token|phone/);
    assert.deepEqual(new Set(h.hungup), new Set([localSid, remoteSid]));
    h.asr(role).emit('close', 1000, Buffer.from('private late cleanup'));
    assert.equal(h.terminations.length, 1);
  });
}

test('actual TTS close code reaches first termination before pipeline cleanup can replace it with a generic reason', async (t) => {
  const h = await harness(t, async () => sse('Do not cancel the booking.'), {
    ttsCloseCode: 1011,
  });
  h.advance(1000);
  h.local.media(Buffer.alloc(8000, 0xff));
  h.asr('local').source(1, '不要取消预约。');
  await flush();
  assert.equal(h.terminations.length, 1);
  assert.equal(h.terminations[0].reason, 'PLANB_TTS_CONNECTION_CLOSED');
  assert.equal(h.terminations[0].component, 'tts');
  assert.equal(h.terminations[0].role, 'local');
  assert.equal(h.terminations[0].wsCloseCode, 1011);
  assert.equal(h.terminations[0].callId, h.call.id);
  assert.equal(h.manager.isCleanupConfirmed(h.call.id), true);
  assert.doesNotMatch(h.terminationLines[0], /private|supplier|words|key/);
  assert.deepEqual(new Set(h.hungup), new Set([localSid, remoteSid]));
});

test('manual hangup fences provider close metadata and cannot manufacture a provider fault', async (t) => {
  const h = await harness(t, async () => sse('Hello.'));
  await h.manager.end(h.call.id);
  for (const supplier of h.suppliers)
    supplier.emit('close', 1011, Buffer.from('private late supplier reason'));
  await flush();
  assert.equal(h.terminations.length, 1);
  assert.equal(h.terminations[0].reason, 'CALL_END_REQUESTED');
  assert.equal(h.terminations[0].component, undefined);
  assert.equal(h.terminations[0].wsCloseCode, undefined);
  assert.equal(h.terminations[0].callId, h.call.id);
  assert.doesNotMatch(h.terminationLines[0], /private|supplier/);
});
