import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import {
  checkPrefixRealtime,
  checkTranslationEngine,
  verifyProviders,
} from '../src/solo/provider-checks';
import type { SoloConfig } from '../src/solo/config';

class ProbeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
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
  OPENAI_API_KEY: 'sk-private-unit-test-no-live-network',
  OPENAI_PROXY_URL: 'http://127.0.0.1:8080',
  OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
} as SoloConfig;

test('prefix preflight checks Chinese ASR and text-only translation without submitting speech', async () => {
  const probes: { url: string; socket: ProbeSocket }[] = [];
  const result = checkPrefixRealtime(
    config,
    (url) => {
      const socket = new ProbeSocket();
      probes.push({ url, socket });
      return socket as unknown as WebSocket;
    },
    1000,
  );
  assert.equal(probes.length, 2);
  probes[0].socket.open();
  probes[0].socket.acknowledge();
  assert.equal(probes[0].socket.readyState, WebSocket.OPEN);
  probes[1].socket.open();
  probes[1].socket.acknowledge();
  assert.deepEqual(await result, {
    name: 'openaiPrefix',
    status: 'passed',
    code: 'PREFIX_SESSION_READY',
  });
  assert.ok(probes.every(({ url }) => !url.includes('/translations')));
  assert.deepEqual(
    probes[0].socket.sent[0].session.audio.input.transcription.languages,
    ['zh-cn'],
  );
  assert.deepEqual(probes[1].socket.sent[0].session.output_modalities, [
    'text',
  ]);
  assert.ok(
    probes.every(({ socket }) =>
      socket.sent.every((event) => event.type === 'session.update'),
    ),
  );
  assert.ok(
    probes.every(({ socket }) => socket.readyState === WebSocket.CLOSED),
  );
});

test('prefix rejection, missing acknowledgement and constructor errors are sanitized', async () => {
  const probes: ProbeSocket[] = [];
  const rejected = checkPrefixRealtime(
    config,
    () => {
      const socket = new ProbeSocket();
      probes.push(socket);
      return socket as unknown as WebSocket;
    },
    1000,
  );
  probes[0].open();
  probes[0].emit(
    'message',
    JSON.stringify({
      type: 'error',
      error: { message: config.OPENAI_API_KEY },
    }),
  );
  assert.equal((await rejected).code, 'PREFIX_ASR_REJECTED');
  assert.ok(!JSON.stringify(await rejected).includes(config.OPENAI_API_KEY));
  assert.ok(probes.every((socket) => socket.readyState === WebSocket.CLOSED));
  const stalled = await checkPrefixRealtime(
    config,
    () => new ProbeSocket() as unknown as WebSocket,
    15,
  );
  assert.equal(stalled.code, 'PREFIX_READY_TIMEOUT');
  const invalid = await checkPrefixRealtime(
    { ...config, OPENAI_API_KEY: '' },
    () => {
      throw new Error(config.OPENAI_API_KEY);
    },
  );
  assert.equal(invalid.code, 'PREFIX_CONNECTION_FAILED');
});

test('prefix candidate verifies Pocket plus both directions without requiring continuous translation', async () => {
  const probes: { url: string; socket: ProbeSocket }[] = [];
  let pocketChecks = 0;
  const forbiddenNano = async () => {
    throw new Error('NANO_MUST_NOT_RUN');
  };
  const result = await checkTranslationEngine(
    config,
    'pocket-prefix',
    (url) => {
      const socket = new ProbeSocket();
      probes.push({ url, socket });
      queueMicrotask(() => {
        if (socket.readyState !== WebSocket.CLOSED) {
          socket.open();
          socket.acknowledge();
        }
      });
      return socket as unknown as WebSocket;
    },
    1000,
    { voice: forbiddenNano, captionVoice: forbiddenNano },
    async () => {
      pocketChecks += 1;
      return {
        name: 'pocketVoice',
        status: 'passed',
        code: 'POCKETVOICE_READY',
      };
    },
  );
  assert.deepEqual(result, {
    name: 'pocketPrefix',
    status: 'passed',
    code: 'POCKET_PREFIX_READY',
  });
  assert.equal(pocketChecks, 1);
  assert.equal(probes.length, 4);
  assert.ok(probes.every(({ url }) => !url.includes('/translations')));
  assert.ok(
    probes.every(({ socket }) =>
      socket.sent.every((event) => event.type === 'session.update'),
    ),
  );
  assert.ok(
    probes.every(({ socket }) => socket.readyState === WebSocket.CLOSED),
  );
});

test('prefix local voice failure prevents opening any provider socket, and a missing key is explicit', async () => {
  let connected = false;
  const failed = await checkTranslationEngine(
    config,
    'pocket-prefix',
    () => {
      connected = true;
      return new ProbeSocket() as unknown as WebSocket;
    },
    1000,
    undefined,
    async () => ({
      name: 'pocketVoice',
      status: 'failed',
      code: 'POCKETVOICE_NOT_READY',
    }),
  );
  assert.equal(connected, false);
  assert.equal(failed.code, 'POCKETVOICE_NOT_READY');
  const report = await verifyProviders(
    { ...config, OPENAI_API_KEY: '' },
    'pocket-prefix',
  );
  assert.equal(report.realCallTested, false);
  assert.deepEqual(report.checks.at(-1), {
    name: 'pocketPrefix',
    status: 'missing',
    code: 'CONFIGURATION_REQUIRED',
  });
});
