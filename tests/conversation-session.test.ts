import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import type WebSocket from 'ws';
import { createConversationModel } from '../public/conversation-model.js';
import { SessionManager, type BridgeOptions } from '../src/solo/session-manager';
import type { SoloConfig } from '../src/solo/config';

class Socket extends EventEmitter {
  readyState = 1;
  close() { if (this.readyState !== 3) { this.readyState = 3; this.emit('close'); } }
  send() {}
}
const config = {
  PUBLIC_BASE_URL: 'https://offline.example.com', TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_CALLER_NUMBER: '+12125550123', OPENAI_API_KEY: 'offline-fake',
  OPENAI_REALTIME_MODEL: 'offline',
} as SoloConfig;
const sid = `CA${'1'.repeat(32)}`;

test('session prefix raw ASR is saved as diagnostic without creating a duplicate semantic card', async t => {
  let bridge!: BridgeOptions;
  const events: any[] = [];
  const manager = new SessionManager({
    providerFactory: () => ({ create: async () => ({ sid: `CA${'2'.repeat(32)}` }), hangup: async () => {} }),
    bridgeFactory: options => { bridge = options; return { attach() {}, close() {} }; },
  });
  t.after(() => manager.close());
  manager.on('event', event => events.push(event));
  manager.setPresence(true);
  const call = manager.createOutbound(config, '+14155550123', 'pocket-prefix');
  manager.connectBrowser({ ...call.connectionParams, From: 'client:ai-phone', CallSid: sid });
  const socket = new Socket();
  assert.equal(manager.attachMedia(socket as unknown as WebSocket, {
    customParameters: { ...call.connectionParams, role: 'local' }, accountSid: config.TWILIO_ACCOUNT_SID,
    callSid: sid, streamSid: `MZ${'3'.repeat(32)}`,
    mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
  }), true);
  await tick();
  const start = events.length;
  bridge.onTranscript({ id: 'local:original:whole_turn:0', role: 'local', kind: 'original', text: '你好，我想预约明天下午。', final: false, at: 100 });
  assert.equal(events.at(-1).event, 'transcript');
  assert.equal(events.at(-1).data.conversationVisible, false);
  bridge.onConversationTranscript?.({
    id: 'local:original:prefix_1:0', utteranceId: 'local:prefix_1:0', role: 'local',
    kind: 'original', text: '你好', final: false, at: 100, pairing: 'explicit', boundary: 'semantic',
  });
  const model = createConversationModel(call.id);
  for (const event of events.slice(start)) {
    if (event.event === 'transcript') model.applyTranscript(event.data);
    if (event.event === 'conversation') model.apply(event.data);
  }
  assert.equal(model.snapshot().length, 1);
  assert.equal(model.snapshot()[0].id, 'local:prefix_1:0');
  assert.equal(model.snapshot()[0].original?.text, '你好');
  await manager.end(call.id);
  const ended = events.length;
  bridge.onConversationTranscript?.({ id: 'local:original:late:0', role: 'local', kind: 'original', text: 'late', final: true, at: 500 });
  bridge.onUtterancePlayback?.({ utteranceId: 'local:late:0', role: 'local', status: 'queued', at: 500 });
  assert.equal(events.length, ended, 'late text and new queued work cannot revive an ended call');
});
