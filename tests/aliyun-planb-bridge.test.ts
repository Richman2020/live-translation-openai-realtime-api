/* eslint-disable no-await-in-loop -- A sequence of real adapter deliveries verifies per-utterance retirement. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import WebSocket from 'ws';

import { createAliyunPlanBBridge } from '../src/solo/aliyun-planb-bridge';
import type {
  AliyunPlanBConfig,
  PlanBAsrOptions,
  PlanBTimingEvent,
  PlanBTranslationOptions,
} from '../src/solo/aliyun-planb-types';
import { ConversationEventAdapter } from '../src/solo/conversation-events';
import { createConversationModel } from '../public/conversation-model.js';
import type { TranscriptEvent } from '../src/solo/translation-bridge';

const config: AliyunPlanBConfig = {
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
class Phone extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  sent: any[] = [];

  autoAck = true;

  constructor(readonly streamSid: string) {
    super();
  }

  send(raw: string, callback?: () => void) {
    const event = JSON.parse(raw);
    this.sent.push(event);
    callback?.();
    if (this.autoAck && event.event === 'mark') this.receive(event);
  }

  receive(event: object) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }

  media(audio: Buffer) {
    this.receive({
      event: 'media',
      streamSid: this.streamSid,
      media: {
        track: 'inbound',
        payload: audio.toString('base64'),
        timestamp: '0',
      },
    });
  }

  acknowledge() {
    for (const event of this.sent.filter((item) => item.event === 'mark'))
      this.receive(event);
  }

  terminate() {
    if (this.readyState !== WebSocket.CLOSED) {
      this.readyState = WebSocket.CLOSED;
      this.emit('close', 1000);
    }
  }

  socket() {
    return this as unknown as WebSocket;
  }
}
function harness(extras: Record<string, unknown> = {}) {
  const local = new Phone('MZlocal');
  const remote = new Phone('MZremote');
  const asr = new Map<string, PlanBAsrOptions>();
  const appended = new Map<string, Buffer[]>();
  const aborted: string[] = [];
  const requests: PlanBTranslationOptions[] = [];
  const spoken: string[] = [];
  const voiceConfigs: AliyunPlanBConfig[] = [];
  const transcripts: TranscriptEvent[] = [];
  const failures: string[] = [];
  const captions: string[] = [];
  const diagnostics: any[] = [];
  const corrections: any[] = [];
  const timings: PlanBTimingEvent[] = [];
  const optionTimings: PlanBTimingEvent[] = [];
  let now = 5000;
  const adapter = new ConversationEventAdapter(
    'live-pairing-offline',
    () => 5000,
  );
  const conversation = createConversationModel({
    sessionId: 'live-pairing-offline',
  });
  const lifecycles: any[] = [];
  const bridge = createAliyunPlanBBridge(
    {
      apiKey: 'unused-openai-key',
      model: 'gpt-realtime-1.5',
      now: () => now,
      remoteCaptions: true,
      outgoingCaptions: false,
      onTranscript: (event) => {
        transcripts.push(event);
        const update = adapter.transcript(event);
        if (update) conversation.apply(update);
        for (const turn of adapter.takeTurnUpdates()) conversation.apply(turn);
      },
      onFailure: (code) => failures.push(code),
      onOutgoingCaptionState: (event) => captions.push(event.state),
      onAudioDiagnostic: (event) => {
        diagnostics.push(event);
        const update = adapter.audio(event);
        if (update) conversation.apply(update);
      },
      onPlanBTiming: (event) => optionTimings.push(event),
      onUtterancePlayback: (event) => {
        lifecycles.push(event);
        const update = adapter.playback(event);
        if (update) conversation.apply(update);
      },
      createWebSocket: () => {
        throw new Error('OpenAI socket must never be created');
      },
    },
    {
      config,
      onCorrection: (event) => corrections.push(event),
      onTiming: (event) => timings.push(event),
      deps: {
        createAsr: (options) => {
          asr.set(options.role, options);
          appended.set(options.role, []);
          assert.equal(options.config.apiKey, 'offline-aliyun-key');
          return {
            ready: Promise.resolve(),
            append(pcm) {
              appended.get(options.role).push(Buffer.from(pcm));
            },
            async finish() {
              /* The fake has no queued provider work. */
            },
            abort() {
              aborted.push(options.role);
            },
          };
        },
        translate: async (options) => {
          requests.push(options);
          return { text: `translated:${options.text}` };
        },
        createTts: (options) => {
          voiceConfigs.push(options.config);
          return {
            async *synthesize(text) {
              spoken.push(text);
              yield Buffer.alloc(4800, 1);
            },
            abort() {},
          };
        },
        ...extras,
      },
    },
  );
  const source = (
    role: 'local' | 'remote',
    sequence: number,
    text: string,
    revision = 1,
  ) =>
    asr.get(role).onSource({
      sequence,
      revision,
      text,
      final: true,
      at: sequence * 100,
      endAt: sequence * 100 + 20,
    });
  bridge.attach('local', local.socket(), local.streamSid);
  bridge.attach('remote', remote.socket(), remote.streamSid);
  return {
    bridge,
    local,
    remote,
    asr,
    appended,
    aborted,
    requests,
    spoken,
    voiceConfigs,
    transcripts,
    failures,
    captions,
    diagnostics,
    corrections,
    timings,
    optionTimings,
    setNow: (value: number) => {
      now = value;
    },
    source,
    conversation,
    lifecycles,
  };
}

test('Plan B reuses telephone PCM adaptation, preserves original English immediately and calls no OpenAI client', async () => {
  const h = harness();
  await tick();
  const original = Buffer.from([0xff, 0x7f, 0x10, 0x80]);
  h.remote.media(original);
  const sent = h.local.sent.find((event) => event.event === 'media');
  assert.equal(sent.media.payload, original.toString('base64'));
  assert.equal(h.appended.get('remote')[0].length, original.length * 6);
  h.local.media(Buffer.alloc(160, 0xff));
  assert.equal(h.appended.get('local')[0].length, 960);
  h.source('local', 2, '预约是下午两点。');
  await tick();
  await tick();
  assert.equal(h.spoken.length, 1);
  assert(h.remote.sent.some((event) => event.event === 'media'));
  assert.deepEqual(h.captions.slice(0, 2), ['connecting', 'ready']);
  assert.equal(h.voiceConfigs[0].voice, 'loongandy_v3');
  assert.equal(h.failures.length, 0);
  h.bridge.close();
});

test('both speaker pipelines keep recent raw context for ASR, send only current source to MT and never create Chinese voice', async () => {
  const h = harness();
  await tick();
  h.source('remote', 1, 'What time is the appointment?');
  await tick();
  h.source('local', 2, '下午两点，不是三点。');
  await tick();
  await tick();
  const localRequest = h.requests.find(
    (request) => request.role === 'local' && request.text.includes('下午两点'),
  );
  assert(
    h.asr
      .get('local')
      .getContext()
      .entries.some(
        (entry) =>
          entry.role === 'remote' &&
          entry.text === 'What time is the appointment?',
      ),
  );
  assert.deepEqual(localRequest.context.entries, []);
  assert(
    !localRequest.context.entries.some((entry) =>
      entry.text.startsWith('translated:'),
    ),
  );
  assert.equal(h.spoken.length, 1);
  h.bridge.close();
});

test('existing adapter groups consecutive same-speaker clauses and separates alternating speakers', async () => {
  const h = harness();
  const adapter = new ConversationEventAdapter('test-call', () => 5000);
  await tick();
  h.source('local', 1, '第一句。');
  h.source('local', 2, '第二句。');
  await tick();
  await tick();
  h.source('remote', 3, 'I understand the appointment.');
  await tick();
  h.source('local', 4, '第三句。');
  await tick();
  await tick();
  const originals = h.transcripts.filter(
    (event) => event.kind === 'original' && event.final,
  );
  const events = originals.map((event) => adapter.transcript(event));
  assert.equal(events[0].speakerTurnId, events[1].speakerTurnId);
  assert.notEqual(events[1].speakerTurnId, events[2].speakerTurnId);
  assert.notEqual(events[0].speakerTurnId, events[3].speakerTurnId);
  assert.equal(h.failures.length, 0);
  h.bridge.close();
});

test('remote interruption keeps original audio responsive and preserves active local translation queue', async () => {
  let release: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let token: AbortSignal;
  const h = harness({
    createTts: () => ({
      async *synthesize(_text: string, _sequence: number, signal: AbortSignal) {
        token = signal;
        await wait;
        yield Buffer.alloc(4800);
      },
      abort() {
        release();
      },
    }),
  });
  await tick();
  h.source('local', 1, '请保留这句翻译。');
  await tick();
  h.remote.media(Buffer.alloc(160, 0x10));
  h.source('remote', 2, 'Please let me interrupt.');
  assert(h.local.sent.some((event) => event.event === 'media'));
  assert.equal(token.aborted, false);
  release();
  await tick();
  await tick();
  assert(h.remote.sent.some((event) => event.event === 'media'));
  assert.equal(h.failures.length, 0);
  h.bridge.close();
});

test('fast long TTS uses Twilio mark backpressure without dropping or mixing playback', async () => {
  const h = harness({
    createTts: () => ({
      async *synthesize() {
        yield Buffer.alloc(12 * 48000);
      },
      abort() {},
    }),
  });
  h.remote.autoAck = false;
  await tick();
  h.source('local', 1, '一段较长的翻译。');
  await tick();
  await tick();
  const firstBytes = h.remote.sent
    .filter((event) => event.event === 'media')
    .reduce(
      (total, event) =>
        total + Buffer.from(event.media.payload, 'base64').length,
      0,
    );
  assert(firstBytes <= 48000);
  assert(firstBytes > 0);
  h.remote.acknowledge();
  await tick();
  await tick();
  h.remote.acknowledge();
  await tick();
  await tick();
  h.remote.acknowledge();
  const total = h.remote.sent
    .filter((event) => event.event === 'media')
    .reduce(
      (sum, event) => sum + Buffer.from(event.media.payload, 'base64').length,
      0,
    );
  assert.equal(total, 12 * 8000);
  assert.equal(h.failures.length, 0);
  assert(h.diagnostics.some((event) => event.stage === 'playback_confirmed'));
  h.bridge.close();
});

test('manual hangup clears both phone buffers, aborts both ASR tasks and fences late events', async () => {
  const h = harness();
  await tick();
  h.source('local', 1, '你好。');
  await tick();
  const count = h.requests.length;
  h.bridge.close();
  h.source('local', 2, '迟到。');
  h.source('remote', 2, 'Late source.');
  await tick();
  assert.equal(h.requests.length, count);
  assert.deepEqual(new Set(h.aborted), new Set(['local', 'remote']));
  assert(h.local.sent.some((event) => event.event === 'clear'));
  assert(h.remote.sent.some((event) => event.event === 'clear'));
  assert.equal(h.local.readyState, WebSocket.CLOSED);
  assert.equal(h.remote.readyState, WebSocket.CLOSED);
});

test('real phone disconnect and required caption failure retain cleanup and never fall back', async () => {
  const h = harness();
  await tick();
  h.asr.get('remote').onError('PLANB_ASR_CONNECTION_CLOSED');
  await tick();
  assert.equal(h.failures.length, 1);
  assert.equal(h.local.readyState, WebSocket.CLOSED);
  assert.equal(h.remote.readyState, WebSocket.CLOSED);
  const disconnected = harness();
  await tick();
  disconnected.remote.terminate();
  assert.equal(disconnected.failures.length, 1);
  assert.equal(disconnected.local.readyState, WebSocket.CLOSED);
});

test('selected config snapshot is immutable and late exposed-source correction does not replay', async () => {
  const h = harness();
  await tick();
  h.source('local', 1, '金额是二十五元。');
  await tick();
  await tick();
  const count = h.requests.length;
  h.source('local', 1, '金额是五十元。', 2);
  await tick();
  assert.equal(h.requests.length, count);
  assert.equal(h.spoken.length, 1);
  assert.equal(h.corrections.length, 1);
  assert.equal(Object.isFrozen(h.voiceConfigs[0]), true);
  h.bridge.close();
});

test('all marks plus the sealed exact delivery count produce played in the existing conversation model', async () => {
  const h = harness();
  h.remote.autoAck = false;
  await tick();
  h.source('local', 1, '请确认播放完整。');
  await tick();
  await tick();
  const original = h.transcripts.find(
    (event) => event.kind === 'original' && event.final,
  );
  const before = h.conversation.getUtterance(original.utteranceId);
  assert.equal(before.playback.sealed, true);
  assert.equal(before.playback.status, 'sent');
  const sealed = h.lifecycles.find((event) => event.sealed);
  assert.equal(
    sealed.expectedDeliveryCount,
    h.remote.sent.filter((event) => event.event === 'mark').length,
  );
  h.remote.acknowledge();
  await tick();
  assert.equal(
    h.conversation.getUtterance(original.utteranceId).playback.status,
    'played',
  );
  h.bridge.close();
});

test('successive utterances seal their own exact counts without carrying previous delivery counts', async () => {
  const h = harness();
  await tick();
  for (let index = 1; index <= 40; index += 1) {
    h.source('local', index, `第${index}句。`);
    await tick();
    await tick();
  }
  assert.equal(h.lifecycles.filter((event) => event.sealed).length, 40);
  assert(h.lifecycles.every((event) => event.expectedDeliveryCount === 1));
  assert(
    h.conversation.snapshot().every((row) => row.playback.status === 'played'),
  );
  assert.equal(h.failures.length, 0);
  h.bridge.close();
});

test('telephone timing separates provider endpoint, ASR, translation, first sample, real queue and final mark drainage', async () => {
  let releaseTranslation: () => void;
  let releaseAudio: () => void;
  const translated = new Promise<void>((resolve) => {
    releaseTranslation = resolve;
  });
  const audio = new Promise<void>((resolve) => {
    releaseAudio = resolve;
  });
  const h = harness({
    translate: async () => {
      await translated;
      return {
        text: 'The appointment is on the sixteenth, not the fifteenth.',
      };
    },
    createTts: () => ({
      async *synthesize() {
        await audio;
        yield Buffer.alloc(4800, 1);
      },
      abort() {},
    }),
  });
  h.remote.autoAck = false;
  await tick();
  h.source('local', 1, '是十六日，不是十五日。');
  h.setNow(5200);
  releaseTranslation();
  await tick();
  assert(!h.timings.some((event) => event.stage === 'audio_first_sample'));
  h.setNow(5600);
  releaseAudio();
  await tick();
  await tick();
  const stages = h.timings.map((event) => event.stage);
  assert.deepEqual(stages, [
    'provider_endpoint_estimate',
    'asr_final',
    'section_ready',
    'translation_start',
    'translation_complete',
    'synthesis_start',
    'audio_first_sample',
    'playback_queued',
    'playback_start_unavailable',
  ]);
  const endpoint = h.timings[0];
  assert.equal(endpoint.basis, 'provider_stream_estimate');
  assert.equal(endpoint.at, 120);
  assert.equal(h.timings[1].at, 5000);
  assert.equal(h.timings[2].at, 5000);
  assert.equal(h.timings[3].at, 5000);
  assert.equal(h.timings[4].at, 5200);
  assert.equal(h.timings[5].at, 5200);
  assert.equal(h.timings[6].at, 5600);
  assert.equal(h.timings[7].basis, 'transport_enqueue_observed');
  assert.equal(h.timings[8].basis, 'unavailable');
  assert.equal(h.timings[8].actualPlaybackStartAt, null);
  // Queue/boundary time is independent from the actual MT and TTS spans.
  assert.equal(h.timings[2].at - h.timings[1].at, 0);
  assert.equal(h.timings[3].at - h.timings[2].at, 0);
  assert.equal(h.timings[4].at - h.timings[3].at, 200);
  assert.equal(h.timings[6].at - h.timings[5].at, 400);
  assert(
    h.timings.every((event) => event.utteranceId === endpoint.utteranceId),
  );
  assert(
    h.timings.every(
      (event) => event.sourceRevision === endpoint.sourceRevision,
    ),
  );
  assert(h.timings.every((event) => event.sessionEpoch === 1));
  assert(h.timings.every((event) => event.sequence === endpoint.sequence));
  assert(h.timings.every((event) => JSON.stringify(event.sourceIds) === '[1]'));
  assert(!h.timings.some((event) => event.stage === 'playback_drained'));
  h.setNow(5900);
  h.remote.acknowledge();
  await tick();
  const drained = h.timings.at(-1);
  assert.equal(drained.stage, 'playback_drained');
  assert.equal(drained.at, 5900);
  assert.equal(drained.basis, 'transport_mark_observed');
  assert.equal(drained.actualPlaybackStartAt, null);
  assert.deepEqual(h.timings, h.optionTimings);
  assert(!JSON.stringify(h.timings).includes('sixteenth'));
  assert(!JSON.stringify(h.timings).includes('十六'));
  h.bridge.close();
});

test('streamed audio is queued before a slow later chunk and drainage waits for every exact mark', async () => {
  let nextChunk: () => void;
  const waiting = new Promise<void>((resolve) => {
    nextChunk = resolve;
  });
  const h = harness({
    createTts: () => ({
      async *synthesize() {
        yield Buffer.alloc(4800, 1);
        await waiting;
        yield Buffer.alloc(4800, 2);
      },
      abort() {
        nextChunk();
      },
    }),
  });
  h.remote.autoAck = false;
  await tick();
  h.source('local', 1, '连续播放前半句和后半句。');
  await tick();
  assert.equal(
    h.remote.sent.filter((event) => event.event === 'media').length,
    1,
  );
  assert.equal(
    h.timings.filter((event) => event.stage === 'playback_queued').length,
    1,
  );
  h.remote.acknowledge();
  assert(!h.timings.some((event) => event.stage === 'playback_drained'));
  h.setNow(5500);
  nextChunk();
  await tick();
  await tick();
  assert.equal(
    h.remote.sent.filter((event) => event.event === 'media').length,
    2,
  );
  assert(!h.timings.some((event) => event.stage === 'playback_drained'));
  h.setNow(5700);
  h.remote.acknowledge();
  await tick();
  assert.equal(
    h.timings.filter((event) => event.stage === 'playback_drained').length,
    1,
  );
  assert.equal(h.timings.at(-1).at, 5700);
  h.remote.acknowledge();
  assert.equal(
    h.timings.filter((event) => event.stage === 'playback_drained').length,
    1,
  );
  h.bridge.close();
});

test('hangup fences delayed audio, old marks and source revisions without inventing a playback start', async () => {
  let release: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({
    createTts: () => ({
      async *synthesize() {
        yield Buffer.alloc(4800, 1);
        await waiting;
        yield Buffer.alloc(4800, 2);
      },
      abort() {
        release();
      },
    }),
  });
  h.remote.autoAck = false;
  await tick();
  h.source('local', 1, '挂断后不能继续发声。');
  await tick();
  const count = h.timings.length;
  const mediaCount = h.remote.sent.filter(
    (event) => event.event === 'media',
  ).length;
  h.bridge.close();
  h.remote.acknowledge();
  h.source('local', 1, '迟到修订。', 2);
  release();
  await tick();
  await tick();
  assert.equal(h.timings.length, count);
  assert.equal(
    h.remote.sent.filter((event) => event.event === 'media').length,
    mediaCount,
  );
  assert(!h.timings.some((event) => event.stage === 'playback_drained'));
  assert(
    h.timings
      .filter((event) => event.stage === 'playback_start_unavailable')
      .every((event) => event.actualPlaybackStartAt === null),
  );
});

test('remote English creates caption timing only and cannot claim translated Chinese playback', async () => {
  const h = harness();
  await tick();
  h.source('remote', 1, 'Do not charge twice.');
  await tick();
  const original = Buffer.from([0xff, 0x7f, 0x10, 0x80]);
  h.remote.media(original);
  const media = h.local.sent.find((event) => event.event === 'media');
  assert.equal(media.media.payload, original.toString('base64'));
  assert.deepEqual(
    h.timings.map((event) => event.stage),
    [
      'provider_endpoint_estimate',
      'asr_final',
      'section_ready',
      'translation_start',
      'translation_complete',
    ],
  );
  assert(h.timings.every((event) => event.role === 'remote'));
  assert.equal(h.spoken.length, 0);
  h.bridge.close();
});
