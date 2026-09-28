import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import createHttpsProxyAgent from 'https-proxy-agent';
import WebSocket from 'ws';

import {
  checkContinuousRealtime,
  checkRealtime,
  checkTranslationEngine,
  verifyProviders,
} from '../src/solo/provider-checks';
import type { SoloConfig } from '../src/solo/config';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;

  sent: any[] = [];

  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  terminate() {
    this.close();
  }

  open() {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }

  acknowledge() {
    this.emit(
      'message',
      JSON.stringify({
        type: 'session.updated',
        session: this.sent[0].session,
      }),
    );
  }
}
const config = {
  OPENAI_API_KEY: 'secret-for-memory-test',
  OPENAI_REALTIME_MODEL: 'model-for-test',
  OPENAI_TRANSCRIPTION_MODEL: 'gpt-4o-transcribe',
} as SoloConfig;

test('provider verification requires actual session.updated, never submits audio or response.create', async () => {
  const socket = new FakeSocket();
  const result = checkRealtime(config, () => socket as unknown as WebSocket);
  socket.open();
  socket.emit('message', JSON.stringify({ type: 'session.created' }));
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.deepEqual(
    socket.sent.map((value) => value.type),
    ['session.update'],
  );
  socket.acknowledge();
  assert.equal((await result).status, 'passed');
  assert.equal(socket.readyState, WebSocket.CLOSED);
});

test('provider verification uses the configured explicit proxy without losing acknowledgement checks', async () => {
  const socket = new FakeSocket();
  const result = checkRealtime(
    { ...config, OPENAI_PROXY_URL: 'http://127.0.0.1:8080' },
    (_url, options: WebSocket.ClientOptions) => {
      assert.ok(options.agent instanceof createHttpsProxyAgent.HttpsProxyAgent);
      assert.equal(options.handshakeTimeout, 15000);
      return socket as unknown as WebSocket;
    },
  );
  socket.open();
  assert.deepEqual(
    socket.sent.map((event) => event.type),
    ['session.update'],
  );
  socket.acknowledge();
  assert.equal((await result).code, 'SESSION_UPDATED');
});

test('provider verification errors are redacted and a missing acknowledgement times out', async () => {
  const rejected = new FakeSocket();
  const rejection = checkRealtime(
    config,
    () => rejected as unknown as WebSocket,
  );
  rejected.open();
  rejected.emit(
    'message',
    JSON.stringify({
      type: 'error',
      error: { message: 'secret-for-memory-test' },
    }),
  );
  assert.equal((await rejection).code, 'SESSION_REJECTED');
  assert.ok(!JSON.stringify(await rejection).includes(config.OPENAI_API_KEY));
  const stalled = new FakeSocket();
  const timeout = checkRealtime(
    config,
    () => stalled as unknown as WebSocket,
    15,
  );
  assert.equal((await timeout).code, 'SESSION_TIMEOUT');
  assert.equal(stalled.readyState, WebSocket.CLOSED);
});

test('provider probe uses each selected transcription model and verifies its acknowledged value', async () => {
  await Promise.all(
    ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'].map(
      async (model) => {
        const socket = new FakeSocket();
        const result = checkRealtime(
          { ...config, OPENAI_TRANSCRIPTION_MODEL: model },
          () => socket as unknown as WebSocket,
        );
        socket.open();
        assert.equal(
          socket.sent[0].session.audio.input.transcription.model,
          model,
        );
        socket.acknowledge();
        assert.equal((await result).code, 'SESSION_UPDATED');
      },
    ),
  );
  await Promise.all(
    ['whisper-1', undefined].map(async (model) => {
      const socket = new FakeSocket();
      const result = checkRealtime(
        config,
        () => socket as unknown as WebSocket,
      );
      socket.open();
      const session = structuredClone(socket.sent[0].session);
      session.audio.input.transcription.model = model;
      socket.emit(
        'message',
        JSON.stringify({ type: 'session.updated', session }),
      );
      assert.equal((await result).code, 'SESSION_MISMATCH');
      assert.equal(socket.readyState, WebSocket.CLOSED);
    }),
  );
});

test('invalid transcription configuration never opens a provider connection or silently falls back', async () => {
  let opened = false;
  const result = await checkRealtime(
    { ...config, OPENAI_TRANSCRIPTION_MODEL: 'unsupported-model' },
    () => {
      opened = true;
      return new FakeSocket() as unknown as WebSocket;
    },
  );
  assert.equal(opened, false);
  assert.equal(result.code, 'INVALID_OPENAI_TRANSCRIPTION_MODEL');
  assert.equal(result.status, 'failed');
});

function continuousProbe(timeoutMs = 15000) {
  const sockets: FakeSocket[] = [];
  const result = checkContinuousRealtime(
    {
      ...config,
      OPENAI_PROXY_URL: 'http://127.0.0.1:8080',
      OPENAI_REALTIME_MODEL: '',
      OPENAI_TRANSCRIPTION_MODEL: 'unsupported-legacy-model',
    },
    (url, options) => {
      assert.equal(
        url,
        'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate',
      );
      assert.ok(options.agent instanceof createHttpsProxyAgent.HttpsProxyAgent);
      assert.equal(options.handshakeTimeout, timeoutMs);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    timeoutMs,
  );
  return { sockets, result };
}

function acknowledgeContinuous(
  socket: FakeSocket,
  language = socket.sent[0].session.audio.output.language,
  model = 'gpt-realtime-translate',
) {
  socket.emit(
    'message',
    JSON.stringify({
      type: 'session.updated',
      session: { model, audio: { output: { language } } },
    }),
  );
}

test('continuous provider verification requires both target acknowledgements and never sends audio', async () => {
  const { sockets, result } = continuousProbe();
  assert.equal(sockets.length, 2);
  let finished = false;
  const settled = result.then(() => {
    finished = true;
  });
  sockets[0].open();
  sockets[0].emit('message', JSON.stringify({ type: 'session.created' }));
  await Promise.resolve();
  assert.equal(finished, false);
  acknowledgeContinuous(sockets[0]);
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(sockets[1].readyState, WebSocket.CONNECTING);
  sockets[1].open();
  acknowledgeContinuous(sockets[1]);
  assert.deepEqual(await result, {
    name: 'openaiContinuous',
    status: 'passed',
    code: 'SESSION_UPDATED_BOTH_LANGUAGES',
  });
  assert.deepEqual(
    sockets.map((socket) => socket.sent),
    ['en', 'zh'].map((language) => [
      {
        type: 'session.update',
        session: { audio: { output: { language } } },
      },
    ]),
  );
  assert.ok(sockets.every((socket) => socket.readyState === WebSocket.CLOSED));
  await settled;
});

test('continuous provider verification rejects mismatched language or model and aborts both sockets', async () => {
  await Promise.all(
    [
      ['zh', 'gpt-realtime-translate'],
      ['en', 'other-model'],
    ].map(async ([language, model]) => {
      const { sockets, result } = continuousProbe();
      sockets[0].open();
      acknowledgeContinuous(sockets[0], language, model);
      assert.equal((await result).code, 'SESSION_MISMATCH');
      assert.ok(
        sockets.every((socket) => socket.readyState === WebSocket.CLOSED),
      );
      assert.equal(sockets[1].sent.length, 0);
    }),
  );
});

test('continuous provider failure is redacted and terminates an already ready peer', async () => {
  const { sockets, result } = continuousProbe();
  sockets[0].open();
  acknowledgeContinuous(sockets[0]);
  sockets[1].open();
  sockets[1].emit(
    'message',
    JSON.stringify({
      type: 'error',
      error: { message: config.OPENAI_API_KEY },
    }),
  );
  assert.equal((await result).code, 'SESSION_REJECTED');
  assert.ok(!JSON.stringify(await result).includes(config.OPENAI_API_KEY));
  assert.ok(sockets.every((socket) => socket.readyState === WebSocket.CLOSED));
});

test('continuous provider deadline aborts both sessions even when one language is ready', async () => {
  const { sockets, result } = continuousProbe(15);
  sockets[0].open();
  acknowledgeContinuous(sockets[0]);
  assert.equal((await result).code, 'SESSION_TIMEOUT');
  assert.ok(sockets.every((socket) => socket.readyState === WebSocket.CLOSED));
  assert.ok(
    sockets.every((socket) =>
      socket.sent.every((event) => event.type === 'session.update'),
    ),
  );
});

test('continuous provider connection failures cannot reveal thrown credential details', async () => {
  const result = await checkContinuousRealtime(config, () => {
    throw new Error(`Authorization: Bearer ${config.OPENAI_API_KEY}`);
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'CONNECTION_FAILED');
  assert.ok(!JSON.stringify(result).includes(config.OPENAI_API_KEY));
});

test('provider report verifies the selected engine without requiring unrelated legacy model settings', async () => {
  const reportConfig = {
    ...config,
    OPENAI_API_KEY: 'sk-unit-test-project-api-key',
    OPENAI_REALTIME_MODEL: '',
    OPENAI_TRANSCRIPTION_MODEL: 'invalid-legacy-model',
  };
  const sockets: FakeSocket[] = [];
  const report = verifyProviders(
    reportConfig,
    'continuous',
    (settings, engine) =>
      checkTranslationEngine(settings, engine, () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      }),
  );
  assert.equal(sockets.length, 2);
  for (const socket of sockets) {
    socket.open();
    acknowledgeContinuous(socket);
  }
  const resolved = await report;
  assert.equal(resolved.translationEngine, 'continuous');
  assert.equal(resolved.realCallTested, false);
  assert.deepEqual(
    resolved.checks.slice(0, 3),
    ['twilioAccount', 'twilioNumber', 'twilioApplication'].map((name) => ({
      name,
      status: 'missing',
      code: 'CONFIGURATION_REQUIRED',
    })),
  );
  assert.equal(resolved.checks[3].name, 'openaiContinuous');
  assert.equal(resolved.checks[3].status, 'passed');

  const legacy = await verifyProviders(reportConfig);
  assert.equal(legacy.translationEngine, 'legacy');
  assert.deepEqual(legacy.checks[3], {
    name: 'openaiRealtime',
    status: 'missing',
    code: 'CONFIGURATION_REQUIRED',
  });
  const noKey = await verifyProviders(
    { ...reportConfig, OPENAI_API_KEY: '' },
    'continuous',
  );
  assert.deepEqual(noKey.checks[3], {
    name: 'openaiContinuous',
    status: 'missing',
    code: 'CONFIGURATION_REQUIRED',
  });
});

test('engine-specific preflight dispatch preserves legacy and fails closed for unknown engines', async () => {
  const socket = new FakeSocket();
  const result = checkTranslationEngine(config, 'legacy', (url) => {
    assert.ok(!url.includes('/translations'));
    return socket as unknown as WebSocket;
  });
  socket.open();
  socket.acknowledge();
  assert.equal((await result).name, 'openaiRealtime');
  assert.equal((await result).status, 'passed');
  const unknown = await checkTranslationEngine(config, 'typo' as 'legacy');
  assert.equal(unknown.code, 'INVALID_TRANSLATION_ENGINE');
  assert.equal(unknown.status, 'failed');
});

test('continuous captions preflight checks outgoing English and the same return ASR/text chain without any Nano dependency', async () => {
  const sockets: { url: string; socket: FakeSocket }[] = [];
  const forbidNano = async () => {
    throw new Error('NANO_CHECK_MUST_NOT_RUN');
  };
  const result = await checkTranslationEngine(
    { ...config, OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5' },
    'continuous-captions',
    (url) => {
      const socket = new FakeSocket();
      sockets.push({ url, socket });
      queueMicrotask(() => {
        if (socket.readyState === WebSocket.CLOSED) return;
        socket.open();
        if (url.includes('/translations?')) acknowledgeContinuous(socket);
        else socket.acknowledge();
      });
      return socket as unknown as WebSocket;
    },
    1000,
    { voice: forbidNano, captionVoice: forbidNano },
  );
  assert.deepEqual(result, {
    name: 'continuousCaptions',
    status: 'passed',
    code: 'CONTINUOUS_CAPTIONS_READY',
  });
  assert.equal(sockets.length, 3);
  assert.equal(
    sockets.filter(({ url }) => url.includes('/translations?')).length,
    1,
  );
  assert.equal(sockets[0].socket.sent[0].session.audio.output.language, 'en');
  assert.ok(sockets.some(({ url }) => url.endsWith('?intent=transcription')));
  assert.ok(sockets.some(({ url }) => url.endsWith('?model=gpt-realtime-1.5')));
  assert.ok(
    sockets.every(({ socket }) => socket.readyState === WebSocket.CLOSED),
  );
  assert.ok(
    sockets.every(({ socket }) =>
      socket.sent.every((event) => event.type === 'session.update'),
    ),
  );
});

test('continuous captions cannot pass when the return caption handshake fails', async () => {
  const sockets: FakeSocket[] = [];
  const forbidNano = async () => {
    throw new Error('NANO_CHECK_MUST_NOT_RUN');
  };
  const result = await checkTranslationEngine(
    { ...config, OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5' },
    'continuous-captions',
    (url) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => {
        if (socket.readyState === WebSocket.CLOSED) return;
        socket.open();
        if (url.includes('/translations?')) acknowledgeContinuous(socket);
        else if (url.includes('intent=transcription'))
          socket.emit(
            'message',
            JSON.stringify({
              type: 'error',
              error: { message: 'private-caption-error' },
            }),
          );
        else if (socket.readyState === WebSocket.OPEN) socket.acknowledge();
      });
      return socket as unknown as WebSocket;
    },
    1000,
    { voice: forbidNano, captionVoice: forbidNano },
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'CAPTION_SESSIONS_UNAVAILABLE');
  assert.ok(!JSON.stringify(result).includes('private-caption-error'));
  assert.ok(sockets.every((socket) => socket.readyState === WebSocket.CLOSED));
  const missing = await verifyProviders(
    { ...config, OPENAI_API_KEY: '' },
    'continuous-captions',
  );
  assert.deepEqual(missing.checks.at(-1), {
    name: 'continuousCaptions',
    status: 'missing',
    code: 'CONFIGURATION_REQUIRED',
  });
});
