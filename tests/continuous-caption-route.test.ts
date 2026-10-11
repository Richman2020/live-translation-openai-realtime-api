import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';

import {
  createSessionBridge,
  type BridgeOptions,
} from '../src/solo/session-manager';
import { ContinuousTranslationBridge } from '../src/solo/continuous-translation-bridge';
import { Pcm24kToPcmu, PcmuToPcm24k } from '../src/solo/translation-pcm';
import {
  isTranslationEngine,
  usesNanoVoice,
  usesPocketVoice,
  usesRemoteCaptions,
} from '../src/solo/translation-engine';

// Actual production route/clients with deterministic sockets; no external APIs,
// GPU, phone dialing, human hearing or measured provider latency is implied.
class Socket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: any[] = [];
  open() {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }
  send(raw: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(raw));
    callback?.();
  }
  receive(event: unknown) {
    this.emit('message', JSON.stringify(event));
  }
  terminate() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  socket() {
    return this as unknown as WebSocket;
  }
}

function bytes(phone: Socket) {
  return Buffer.concat(
    phone.sent
      .filter((event) => event.event === 'media')
      .map((event) => Buffer.from(event.media.payload, 'base64')),
  );
}

function fixture(
  t: any,
  engine:
    | 'continuous-captions'
    | 'pocket-captions'
    | 'pocket-prefix' = 'continuous-captions',
  settings: Partial<BridgeOptions> = {},
) {
  const local = new Socket(),
    remote = new Socket();
  local.open();
  remote.open();
  const providers: { url: string; socket: Socket }[] = [];
  const transcripts: any[] = [],
    failures: string[] = [],
    states: string[] = [];
  const outgoingStates: string[] = [],
    conversations: any[] = [];
  let nanoCalls = 0;
  let pocketCalls = 0;
  const pocketTexts: string[] = [];
  const pocketPcm = Buffer.alloc(960, 0x22);
  const forbidNano = () => {
    nanoCalls += 1;
    throw new Error('NANO_MUST_NOT_START');
  };
  const bridge = createSessionBridge(
    {
      translationEngine: engine,
      apiKey: 'fake',
      model: 'gpt-realtime-1.5',
      createWebSocket(url) {
        const socket = new Socket();
        providers.push({ url, socket });
        return socket.socket();
      },
      onTranscript: (event) => transcripts.push(event),
      onFailure: (reason) => failures.push(reason),
      onCaptionState: (event) => states.push(event.state),
      onOutgoingCaptionState: (event) => outgoingStates.push(event.state),
      onConversationTranscript: (event) => conversations.push(event),
      ...settings,
    },
    {
      nano: forbidNano,
      nanoCaption: forbidNano,
      pocket: () => {
        pocketCalls += 1;
        return {
          ready: Promise.resolve(),
          diagnosticPrefix: 'pocket',
          async synthesize() {
            throw new Error('MUST_STREAM');
          },
          async *synthesizeStream(text) {
            pocketTexts.push(text);
            yield { pcm: pocketPcm, sampleRate: 24000 };
          },
        };
      },
    },
  );
  bridge.attach('local', local.socket(), 'MZ_local');
  bridge.attach('remote', remote.socket(), 'MZ_remote');
  const outgoing =
    engine === 'pocket-prefix'
      ? providers.slice(0, 2)
      : providers.filter((item) => item.url.includes('/translations?'));
  const captions = providers.slice(-2);
  const sourceCaptionSockets =
    engine === 'continuous-captions' && settings.outgoingCaptions
      ? providers.slice(1, 3).map((item) => item.socket)
      : [];
  const voice = outgoing.at(-1)!.socket;
  const asr = captions.find((item) =>
    item.url.endsWith('?intent=transcription'),
  )!.socket;
  const text = captions.find((item) =>
    item.url.endsWith('?model=gpt-realtime-1.5'),
  )!.socket;
  const media = (role: 'local' | 'remote', data: Buffer) =>
    (role === 'local' ? local : remote).receive({
      event: 'media',
      streamSid: `MZ_${role}`,
      media: { track: 'inbound', payload: data.toString('base64') },
    });
  const readyVoice = async () => {
    for (const { socket } of outgoing) {
      socket.open();
      socket.receive({
        type: 'session.updated',
        session:
          engine === 'pocket-prefix'
            ? socket.sent[0].session
            : {
                model: 'gpt-realtime-translate',
                audio: { output: { language: 'en' } },
              },
      });
    }
    await tick();
  };
  const readyCaptions = async () => {
    for (const socket of [asr, text]) {
      socket.open();
      socket.receive({
        type: 'session.updated',
        session: socket.sent[0].session,
      });
    }
    await tick();
  };
  const readyOutgoingCaptions = async () => {
    for (const socket of sourceCaptionSockets) {
      socket.open();
      socket.receive({
        type: 'session.updated',
        session: socket.sent[0].session,
      });
    }
    await tick();
  };
  t.after(() => bridge.close());
  return {
    bridge,
    local,
    remote,
    providers,
    voice,
    asr,
    text,
    transcripts,
    failures,
    states,
    outgoingStates,
    conversations,
    sourceAsr: sourceCaptionSockets[0],
    sourceText: sourceCaptionSockets[1],
    media,
    readyVoice,
    readyCaptions,
    readyOutgoingCaptions,
    nanoCalls: () => nanoCalls,
    pocketCalls: () => pocketCalls,
    pocketTexts,
    pocketPcm,
  };
}

test('native caption engine capabilities do not imply a Nano voice or change legacy modes', () => {
  assert.equal(isTranslationEngine('continuous-captions'), true);
  assert.equal(usesRemoteCaptions('continuous-captions'), true);
  assert.equal(usesNanoVoice('continuous-captions'), false);
  assert.equal(usesRemoteCaptions('nano-captions'), true);
  assert.equal(usesNanoVoice('nano-captions'), true);
  assert.equal(usesRemoteCaptions('continuous'), false);
  assert.equal(usesNanoVoice('legacy'), false);
  assert.equal(isTranslationEngine('caption-typo'), false);
  assert.equal(isTranslationEngine('pocket-captions'), true);
  assert.equal(usesRemoteCaptions('pocket-captions'), true);
  assert.equal(usesNanoVoice('pocket-captions'), false);
  assert.equal(usesPocketVoice('pocket-captions'), true);
  assert.equal(usesPocketVoice('continuous-captions'), false);
});

test('production Pocket route selects only the public preset stream and preserves immediate return original', async (t) => {
  const f = fixture(t, 'pocket-captions');
  assert.equal(f.nanoCalls(), 0);
  assert.equal(f.pocketCalls(), 1);
  assert.equal(f.providers.length, 3);
  const original = Buffer.alloc(160, 0x55);
  f.media('remote', original);
  assert.deepEqual(bytes(f.local), original);
  await f.readyVoice();
  f.voice.receive({
    type: 'session.output_audio.delta',
    delta: Buffer.alloc(960, 0x33).toString('base64'),
  });
  assert.equal(
    bytes(f.remote).length,
    0,
    'provider voice cannot bypass selected Pocket voice',
  );
  f.voice.receive({
    type: 'session.output_transcript.delta',
    delta: 'Hello tomorrow. The next',
  });
  await tick();
  assert.deepEqual(f.pocketTexts, ['Hello tomorrow.']);
  const converter = new Pcm24kToPcmu();
  assert.deepEqual(
    bytes(f.remote),
    Buffer.concat([
      converter.push(f.pocketPcm),
      converter.push(Buffer.alloc(384)),
    ]),
  );
  assert.deepEqual(f.failures, []);
});

test('production prefix route selects Pocket and keeps return English independent of Chinese text', async (t) => {
  const f = fixture(t, 'pocket-prefix');
  assert.equal(f.pocketCalls(), 1);
  assert.equal(f.nanoCalls(), 0);
  assert.equal(f.providers.length, 4);
  assert.ok(
    f.providers.every(({ url }) => !url.includes('/translations?')),
    'prefix speech uses text and the selected Pocket voice',
  );
  const original = Buffer.from(Array.from({ length: 800 }, (_, i) => i % 256));
  f.media('remote', original);
  assert.deepEqual(
    bytes(f.local),
    original,
    'return original does not wait for recognition, translation or Pocket',
  );
  await f.readyVoice();
  await f.readyCaptions();
  assert.deepEqual(f.text.sent[0].session.output_modalities, ['text']);
  f.asr.receive({ type: 'input_audio_buffer.committed', item_id: 'turn_1' });
  f.asr.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'turn_1',
    content_index: 0,
    transcript: 'Tomorrow, not today.',
  });
  const request = f.text.sent.find((event) => event.type === 'response.create');
  assert.ok(request);
  assert.deepEqual(request.response.output_modalities, ['text']);
  f.text.receive({
    type: 'response.created',
    response: { id: 'response_1', metadata: request.response.metadata },
  });
  f.text.receive({
    type: 'response.done',
    response: {
      id: 'response_1',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '明天，不是今天。' }],
        },
      ],
    },
  });
  assert.ok(
    f.transcripts.some(
      (event) =>
        event.role === 'remote' &&
        event.kind === 'translation' &&
        event.text === '明天，不是今天。',
    ),
  );
  assert.deepEqual(
    bytes(f.local),
    original,
    'Chinese text adds no return audio',
  );
  assert.deepEqual(f.pocketTexts, [], 'return captions never enter Pocket TTS');
  assert.equal(bytes(f.remote).length, 0);
  assert.deepEqual(f.failures, []);
});

test('production native-caption route sends translated English before any text/final and keeps input live', async (t) => {
  const f = fixture(t);
  assert.equal(f.nanoCalls(), 0);
  assert.equal(
    f.providers.length,
    3,
    'one outgoing translation plus two independent return caption sockets by default',
  );
  const original = Buffer.alloc(160, 0x44);
  f.media('remote', original);
  assert.deepEqual(
    bytes(f.local),
    original,
    'return original does not await either AI branch',
  );
  await f.readyVoice();
  const pcm = Buffer.alloc(960);
  for (let i = 0; i < pcm.length; i += 2)
    pcm.writeInt16LE(Math.round(7000 * Math.sin(i / 12)), i);
  f.voice.receive({
    type: 'session.output_audio.delta',
    delta: pcm.toString('base64'),
  });
  const converter = new Pcm24kToPcmu();
  const first = converter.push(pcm);
  assert.deepEqual(
    bytes(f.remote),
    first,
    'no transcript, punctuation or end-of-turn has arrived',
  );
  assert.deepEqual(f.transcripts, []);
  assert.equal(
    f.asr.readyState,
    WebSocket.CONNECTING,
    'slow subtitles cannot gate English audio',
  );
  f.voice.receive({
    type: 'session.output_transcript.delta',
    delta: 'This unfinished sentence',
  });
  f.voice.receive({
    type: 'session.output_audio.delta',
    delta: pcm.toString('base64'),
  });
  assert.deepEqual(
    bytes(f.remote),
    Buffer.concat([first, converter.push(pcm)]),
  );
  assert.equal(f.transcripts.at(-1).final, false);
  const input = Buffer.alloc(160, 0x55);
  f.media('local', input);
  assert.deepEqual(
    Buffer.from(f.voice.sent.at(-1).audio, 'base64'),
    new PcmuToPcm24k().push(input),
  );
  assert.equal(f.nanoCalls(), 0);
  assert.deepEqual(f.failures, []);
});

for (const engine of ['continuous-captions', 'pocket-captions'] as const)
  test(`${engine} route retains return English recognition and Chinese text, with isolated caption failure`, async (t) => {
    const f = fixture(t, engine);
    await f.readyVoice();
    await f.readyCaptions();
    const original = Buffer.alloc(800, 0x41);
    f.media('remote', original);
    assert.deepEqual(bytes(f.local), original);
    const forwarded = Buffer.concat(
      f.asr.sent
        .filter((event) => event.type === 'input_audio_buffer.append')
        .map((event) => Buffer.from(event.audio, 'base64')),
    );
    assert.deepEqual(forwarded, new PcmuToPcm24k().push(original));
    f.asr.receive({ type: 'input_audio_buffer.committed', item_id: 'turn_1' });
    f.asr.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'turn_1',
      content_index: 0,
      transcript: 'Tomorrow, not today.',
    });
    const request = f.text.sent.find(
      (event) => event.type === 'response.create',
    );
    assert.ok(
      request,
      'final English drives the existing text-only Chinese translator',
    );
    f.text.receive({
      type: 'response.created',
      response: { id: 'response_1', metadata: request.response.metadata },
    });
    f.text.receive({
      type: 'response.output_text.delta',
      response_id: 'response_1',
      item_id: 'output_item',
      output_index: 0,
      content_index: 0,
      delta: '明天，不是今天。',
    });
    f.text.receive({
      type: 'response.done',
      response: {
        id: 'response_1',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '明天，不是今天。' }],
          },
        ],
      },
    });
    assert.ok(
      f.transcripts.some(
        (event) =>
          event.role === 'remote' &&
          event.kind === 'original' &&
          event.text === 'Tomorrow, not today.',
      ),
    );
    assert.ok(
      f.transcripts.some(
        (event) =>
          event.role === 'remote' &&
          event.kind === 'translation' &&
          event.text === '明天，不是今天。',
      ),
    );
    assert.equal(
      f.local.sent.filter((event) => event.event === 'media').length,
      1,
      'Chinese captions never synthesize return audio',
    );
    f.asr.receive({ type: 'error', error: { message: 'private-error' } });
    f.media('remote', original);
    assert.deepEqual(bytes(f.local), Buffer.concat([original, original]));
    f.voice.receive({
      type: 'session.output_audio.delta',
      delta: Buffer.alloc(960, 1).toString('base64'),
    });
    if (engine === 'pocket-captions') {
      assert.equal(
        bytes(f.remote).length,
        0,
        'caption failure cannot change selected voice',
      );
      f.voice.receive({
        type: 'session.output_transcript.delta',
        delta: 'The next sentence. Another',
      });
      await tick();
    }
    assert.ok(bytes(f.remote).length > 0);
    assert.deepEqual(f.states, ['connecting', 'ready', 'failed']);
    assert.deepEqual(f.failures, []);
    assert.equal(f.nanoCalls(), 0);
  });

test('native-caption hangup discards late outgoing audio, captions and input', async (t) => {
  const f = fixture(t, 'continuous-captions', { outgoingCaptions: true });
  await f.readyVoice();
  await f.readyCaptions();
  f.bridge.close();
  const localCount = f.local.sent.length,
    remoteCount = f.remote.sent.length;
  f.voice.receive({
    type: 'session.output_audio.delta',
    delta: Buffer.alloc(960, 1).toString('base64'),
  });
  f.asr.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'late',
    content_index: 0,
    transcript: 'late text',
  });
  f.media('remote', Buffer.alloc(160));
  assert.equal(f.local.sent.length, localCount);
  assert.equal(f.remote.sent.length, remoteCount);
  assert.deepEqual(f.transcripts, []);
  assert.equal(f.nanoCalls(), 0);
});

test('native route produces stable paired source subtitles in an independent text branch', async (t) => {
  const f = fixture(t, 'continuous-captions', { outgoingCaptions: true });
  await f.readyVoice();
  const pcm = Buffer.alloc(960, 0x33);
  f.voice.receive({
    type: 'session.output_audio.delta',
    delta: pcm.toString('base64'),
  });
  const beforeText = bytes(f.remote);
  assert.ok(beforeText.length > 0);
  assert.deepEqual(f.conversations, []);
  await f.readyOutgoingCaptions();
  assert.deepEqual(
    f.sourceAsr.sent[0].session.audio.input.transcription.languages,
    ['zh-cn'],
  );
  assert.deepEqual(f.sourceText.sent[0].session.output_modalities, ['text']);
  const input = Buffer.alloc(160, 0x55);
  f.media('local', input);
  assert.deepEqual(
    Buffer.concat(
      f.sourceAsr.sent
        .filter((event) => event.type === 'input_audio_buffer.append')
        .map((event) => Buffer.from(event.audio, 'base64')),
    ),
    new PcmuToPcm24k().push(input),
  );
  f.sourceAsr.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'source_one',
    content_index: 0,
    transcript: '明天，不是今天。',
  });
  const sections = [
    { source: '明天，', translation: 'Tomorrow,' },
    { source: '不是今天。', translation: 'not today.' },
  ];
  sections.forEach((section, index) => {
    const request = f.sourceText.sent.filter(
      (event) => event.type === 'response.create',
    )[index];
    assert.ok(request);
    assert.equal(
      JSON.parse(request.response.input[0].content[0].text)
        .current_chinese_prefix,
      section.source,
    );
    const id = `source_translation_${index}`;
    f.sourceText.receive({
      type: 'response.created',
      response: { id, metadata: request.response.metadata },
    });
    f.sourceText.receive({
      type: 'response.output_text.delta',
      response_id: id,
      output_index: 0,
      content_index: 0,
      delta: section.translation,
    });
    f.sourceText.receive({
      type: 'response.done',
      response: {
        id,
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: section.translation }],
          },
        ],
      },
    });
  });
  const pair = f.conversations.filter((event) => event.final);
  assert.equal(pair.length, 4);
  assert.deepEqual(
    pair.map((event) => event.kind),
    ['original', 'translation', 'original', 'translation'],
  );
  assert.equal(pair[0].utteranceId, pair[1].utteranceId);
  assert.equal(pair[2].utteranceId, pair[3].utteranceId);
  assert.notEqual(pair[0].utteranceId, pair[2].utteranceId);
  assert.equal(
    pair
      .filter((event) => event.kind === 'original')
      .map((event) => event.text)
      .join(''),
    '明天，不是今天。',
  );
  assert.equal(
    pair
      .filter((event) => event.kind === 'translation')
      .map((event) => event.text)
      .join(' '),
    'Tomorrow, not today.',
  );
  assert.ok(
    pair.every(
      (event) =>
        event.captionSource === 'independent_text' &&
        event.audioCorrespondence === 'none' &&
        event.boundary === 'semantic',
    ),
  );
  assert.deepEqual(
    bytes(f.remote),
    beforeText,
    'the text branch never synthesizes or queues audio',
  );
  f.sourceAsr.receive({
    type: 'error',
    error: { message: 'PRIVATE_CAPTION_ERROR' },
  });
  f.voice.receive({
    type: 'session.output_audio.delta',
    delta: pcm.toString('base64'),
  });
  assert.ok(bytes(f.remote).length > beforeText.length);
  assert.deepEqual(f.failures, []);
  assert.deepEqual(f.outgoingStates, ['connecting', 'ready', 'failed']);
  f.bridge.close();
  const count = f.conversations.length;
  f.sourceAsr.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'late',
    content_index: 0,
    transcript: '迟到。',
  });
  assert.equal(f.conversations.length, count);
});

test('caption socket admission rechecks each connection and denies the text socket after the ASR socket', (t) => {
  const sockets: Socket[] = [];
  const failures: string[] = [],
    states: string[] = [];
  let checks = 0;
  const bridge = new ContinuousTranslationBridge({
    apiKey: 'fake',
    model: 'gpt-realtime-1.5',
    outgoingCaptions: true,
    remoteCaptions: true,
    admitAudio: (event) =>
      event.path !== 'outgoing_captions' ||
      event.stage !== 'connect' ||
      ++checks < 3,
    createWebSocket: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket.socket();
    },
    onTranscript: () => {},
    onFailure: (reason) => failures.push(reason),
    onOutgoingCaptionState: (event) => states.push(event.state),
  });
  t.after(() => bridge.close());
  const local = new Socket(),
    remote = new Socket();
  local.open();
  remote.open();
  bridge.attach('local', local.socket(), 'MZ_local');
  bridge.attach('remote', remote.socket(), 'MZ_remote');
  assert.equal(
    checks,
    3,
    'preflight, ASR, then text each check current admission',
  );
  assert.equal(
    sockets.length,
    4,
    'native plus stopped source ASR plus the two independent return sockets',
  );
  assert.equal(sockets[1].readyState, WebSocket.CLOSED);
  assert.deepEqual(states, ['connecting', 'failed']);
  assert.deepEqual(failures, []);
});

test('late caption translation requests recheck admission before supplier send', async (t) => {
  let allowed = true;
  const f = fixture(t, 'continuous-captions', {
    outgoingCaptions: true,
    admitAudio: (event) => event.path !== 'outgoing_captions' || allowed,
  });
  await f.readyVoice();
  await f.readyOutgoingCaptions();
  allowed = false;
  f.sourceAsr.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'expired',
    content_index: 0,
    transcript: '明天，不是今天。',
  });
  assert.equal(
    f.sourceText.sent.filter((event) => event.type === 'response.create')
      .length,
    0,
  );
  assert.equal(f.outgoingStates.at(-1), 'failed');
  f.voice.receive({
    type: 'session.output_audio.delta',
    delta: Buffer.alloc(960, 0x33).toString('base64'),
  });
  assert.ok(bytes(f.remote).length > 0);
  assert.deepEqual(f.failures, []);
});

test('delayed native socket opening rechecks revoked admission before session configuration', async (t) => {
  let allowed = true;
  const f = fixture(t, 'continuous-captions', { admitAudio: () => allowed });
  assert.equal(f.providers.length, 3);
  allowed = false;
  await f.readyVoice();
  assert.deepEqual(
    f.voice.sent,
    [],
    'revoked identity cannot submit the delayed session.update',
  );
  assert.equal(f.local.readyState, WebSocket.CLOSED);
  assert.equal(f.remote.readyState, WebSocket.CLOSED);
  assert.deepEqual(f.failures, ['continuous_audio_admission_denied:local']);
  assert.ok(
    f.providers.every(({ socket }) => socket.readyState === WebSocket.CLOSED),
  );
  assert.equal(
    f.local.sent.filter((event) => event.event === 'clear').length,
    1,
  );
  assert.equal(
    f.remote.sent.filter((event) => event.event === 'clear').length,
    1,
  );
});
