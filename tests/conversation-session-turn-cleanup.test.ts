import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import type WebSocket from 'ws';

import {
  SessionManager,
  type BridgeOptions,
} from '../src/solo/session-manager';
import type { SoloConfig } from '../src/solo/config';

class Socket extends EventEmitter {
  readyState = 1;

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  send() {}
}

test('a hangup during speaker-binding publication stops all subsequent text updates and cleans both legs', async (t) => {
  const config = {
    PUBLIC_BASE_URL: 'https://offline.example.com',
    TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
    TWILIO_CALLER_NUMBER: '+12125550123',
    OPENAI_API_KEY: 'offline-fake',
    OPENAI_REALTIME_MODEL: 'offline',
  } as SoloConfig;
  const browserSid = `CA${'1'.repeat(32)}`;
  const remoteSid = `CA${'2'.repeat(32)}`;
  const hungUp: string[] = [];
  const events: any[] = [];
  let settings!: BridgeOptions;
  const manager = new SessionManager({
    providerFactory: () => ({
      create: async () => ({ sid: remoteSid }),
      hangup: async (sid) => {
        hungUp.push(sid);
      },
    }),
    bridgeFactory: (options) => {
      settings = options;
      return { attach() {}, close() {} };
    },
  });
  t.after(() => manager.close());
  manager.on('event', (event) => events.push(event));
  manager.setPresence(true);
  const call = manager.createOutbound(
    config,
    '+14155550123',
    'continuous-captions',
  );
  manager.connectBrowser({
    ...call.connectionParams,
    From: 'client:ai-phone',
    CallSid: browserSid,
  });
  assert.equal(
    manager.attachMedia(new Socket() as unknown as WebSocket, {
      customParameters: { ...call.connectionParams, role: 'local' },
      accountSid: config.TWILIO_ACCOUNT_SID,
      callSid: browserSid,
      streamSid: `MZ${'3'.repeat(32)}`,
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    }),
    true,
  );
  await tick();
  const original = (
    id: string,
    role: 'local' | 'remote',
    at: number,
    text: string,
  ) =>
    settings.onTranscript({
      id: `${role}:original:${id}:0`,
      utteranceId: `${role}:${id}:0`,
      role,
      kind: 'original',
      text,
      final: true,
      at,
      sourceRevision: 1,
    });
  original('a1', 'local', 100, '我要继续说。');
  original('a2', 'local', 300, '这是下一段。');
  let ending: Promise<void> | undefined;
  manager.on('event', (event) => {
    if (
      event.event === 'conversation' &&
      event.data.utteranceId === 'remote:b:0'
    )
      ending = manager.end(call.id);
  });
  const start = events.length;
  original('b', 'remote', 200, 'An earlier interruption.');
  assert.ok(ending);
  await ending;
  const conversation = events
    .slice(start)
    .filter((event) => event.event === 'conversation');
  assert.deepEqual(
    conversation.map((event) => event.data.utteranceId),
    ['remote:b:0'],
  );
  assert.ok(hungUp.includes(browserSid));
  assert.ok(hungUp.includes(remoteSid));
  const ended = events.length;
  original('a3', 'local', 400, '迟到文字不能重开已结束通话。');
  assert.equal(events.length, ended);
});
