/* eslint-disable no-await-in-loop -- Each synthetic supplier session is isolated. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, before, test, type TestContext } from 'node:test';
import WebSocket from 'ws';

import type { LiveTranslateRetentionSnapshot } from '../src/experiments/livetranslate-types';
import { loadFrozenCf62Baseline } from './helpers/livetranslate-cf62-baseline';

let frozen: Awaited<ReturnType<typeof loadFrozenCf62Baseline>>;
before(async () => {
  frozen = await loadFrozenCf62Baseline();
});
after(() => frozen?.dispose());

/** Entirely synthetic protocol scheduling. No frames or audio from a real call.
 * These tests characterize the known capacity failure; they do not fix it or
 * claim that client audio callbacks establish telephone/ear playback. */
class SyntheticWire extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  sent: Record<string, unknown>[] = [];

  closes = 0;

  send(raw: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(raw));
    callback?.();
  }

  terminate() {
    this.closes += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1006);
  }

  close() {
    this.closes += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1000);
  }
}

function fixture(t: TestContext, role: 'local' | 'remote') {
  const wire = new SyntheticWire();
  const errors: string[] = [];
  const audio: { pcm: Buffer; responseId: string; sequence: number }[] = [];
  const translations: { responseId: string; text: string }[] = [];
  const diagnostics: {
    code?: string;
    eventType: string | null;
    beforeCleanup: LiveTranslateRetentionSnapshot;
  }[] = [];
  const frames: Record<string, any>[] = [];
  let frameNumber = 0;
  let connects = 0;
  const voice = role === 'local' ? 'Andre' : 'Tina';
  const client = frozen.module.createLiveTranslateClient({
    enabled: true,
    usage: 'phone',
    role,
    voice,
    allowAndreTopLevelWithTinaOutput: role === 'local',
    workspaceId: 'synthetic-capacity-only',
    apiKey: 'SYNTHETIC_UNUSED_CAPACITY_KEY',
    createWebSocket() {
      connects += 1;
      return wire as unknown as WebSocket;
    },
    onAudio: (pcm, metadata) =>
      audio.push({
        pcm,
        responseId: metadata.responseId,
        sequence: metadata.sequence,
      }),
    onTranslation: (item) => translations.push(item),
    onError: (code) => errors.push(code),
    onProtocolDiagnostic: (item) => {
      if (item.fatal)
        diagnostics.push({
          code: item.code,
          eventType: item.eventType,
          beforeCleanup: client.retentionSnapshot!(),
        });
    },
  });
  t.after(() => client.abort());
  const receive = (frame: Record<string, any>) => {
    frameNumber += 1;
    const event = { event_id: `synthetic_capacity_${frameNumber}`, ...frame };
    frames.push(event);
    wire.emit('message', Buffer.from(JSON.stringify(event)), false);
    return event;
  };
  const start = async (sourceFinal = true) => {
    const session = {
      id: `synthetic_capacity_${role}`,
      model: frozen.module.LIVE_TRANSLATE_MODEL,
      voice,
      output_modalities: role === 'local' ? ['text', 'audio'] : ['text'],
      enable_voice_clone: false,
      audio: {
        input: {
          format: { type: 'pcm', sample_rate: 16000 },
          turn_detection: { type: 'speaker_detection', threshold: 0.5 },
        },
        output: {
          format: { type: 'pcm', sample_rate: 24000 },
          voice: role === 'local' ? 'Tina' : voice,
        },
      },
      translation: { language: role === 'local' ? 'en' : 'zh' },
    };
    receive({ type: 'session.created', session });
    receive({ type: 'session.updated', session });
    await client.ready;
    receive({
      type: 'input_audio_buffer.speech_started',
      item_id: 'synthetic_single_source',
      audio_start_ms: 1000,
    });
    if (sourceFinal)
      receive({
        type: 'input_audio_buffer.speech_stopped',
        item_id: 'synthetic_single_source',
        audio_end_ms: 2000,
      });
    receive({
      type: `conversation.item.input_audio_transcription.${sourceFinal ? 'completed' : 'delta'}`,
      item_id: 'synthetic_single_source',
      content_index: 0,
      ...(sourceFinal
        ? { transcript: 'Synthetic single-source capacity characterization.' }
        : { delta: 'Synthetic continuous source remains open.' }),
    });
  };
  const created = (index: number) =>
    receive({
      type: 'response.created',
      response: {
        id: `synthetic_response_${index}`,
        voice,
        status: 'in_progress',
      },
    });
  const link = (index: number) =>
    receive({
      type: 'conversation.item.created',
      previous_item_id: 'synthetic_single_source',
      item: { id: `synthetic_output_${index}`, role: 'assistant', content: [] },
    });
  const output = (
    index: number,
    type: string,
    patch: Record<string, unknown> = {},
  ) =>
    receive({
      type,
      response_id: `synthetic_response_${index}`,
      item_id: `synthetic_output_${index}`,
      output_index: 0,
      content_index: 0,
      ...patch,
    });
  const text = (index: number) => `Synthetic translation ${index}.`;
  const done = (index: number, status = 'completed') =>
    receive({
      type: 'response.done',
      response: {
        id: `synthetic_response_${index}`,
        voice,
        status,
        output: [
          {
            id: `synthetic_output_${index}`,
            content: [
              role === 'local'
                ? { type: 'audio', transcript: text(index) }
                : { type: 'text', text: text(index) },
            ],
          },
        ],
      },
    });
  const content = (index: number, completeResponse = true) => {
    link(index);
    output(
      index,
      role === 'local'
        ? 'response.audio_transcript.done'
        : 'response.text.done',
      role === 'local' ? { transcript: text(index) } : { text: text(index) },
    );
    if (role === 'local') {
      const pcm = Buffer.alloc(2);
      pcm.writeUInt16LE(index % 65536);
      output(index, 'response.audio.delta', { delta: pcm.toString('base64') });
      output(index, 'response.audio.done');
    }
    if (completeResponse) done(index);
  };
  const complete = (index: number) => {
    created(index);
    content(index);
  };
  return {
    client,
    wire,
    errors,
    audio,
    translations,
    diagnostics,
    frames,
    receive,
    start,
    created,
    link,
    output,
    content,
    complete,
    done,
    connects: () => connects,
  };
}

for (const role of ['local', 'remote'] as const) {
  test(`cf62 historical synthetic ${role}: single finalized source retains 256 done outputs and response.created 257 first exhausts response Map`, async (t) => {
    const f = fixture(t, role);
    await f.start();
    for (let index = 0; index < 256; index += 1) f.complete(index);
    const before = f.client.retentionSnapshot!();
    assert.deepEqual(f.errors, []);
    assert.equal(before.activeSources, 1);
    assert.equal(before.activeResponses, 256);
    assert.equal(before.activeTranslations, 256);
    assert.equal(f.audio.length, role === 'local' ? 256 : 0);
    assert.equal(
      new Set(f.audio.map((item) => item.responseId)).size,
      f.audio.length,
    );
    assert.equal(
      new Set(f.translations.map((item) => item.responseId)).size,
      256,
    );
    f.created(256);
    assert.deepEqual(f.errors, ['LIVETRANSLATE_ITEM_CAPACITY']);
    assert.equal(f.diagnostics[0].eventType, 'response.created');
    assert.equal(f.diagnostics[0].beforeCleanup.activeResponses, 256);
    assert.equal(f.diagnostics[0].beforeCleanup.activeTranslations, 256);
    const counts = [f.audio.length, f.translations.length, f.wire.sent.length];
    f.content(256);
    for (const frame of f.frames.slice(5, 12)) f.receive(frame);
    assert.deepEqual(
      [f.audio.length, f.translations.length, f.wire.sent.length],
      counts,
    );
    assert.equal(f.connects(), 1);
    assert.equal(f.wire.closes, 1);
    assert.throws(() => f.client.append(Buffer.alloc(640)), /ITEM_CAPACITY/u);
  });

  test(`cf62 historical synthetic ${role}: one still-speaking source also retains 256 completed responses`, async (t) => {
    const f = fixture(t, role);
    await f.start(false);
    for (let index = 0; index < 256; index += 1) f.complete(index);
    assert.deepEqual(f.errors, []);
    assert.equal(f.client.retentionSnapshot!().activeSources, 1);
    assert.equal(f.client.retentionSnapshot!().activeResponses, 256);
    f.created(256);
    assert.deepEqual(f.errors, ['LIVETRANSLATE_ITEM_CAPACITY']);
    assert.equal(f.diagnostics[0].eventType, 'response.created');
    assert.equal(f.connects(), 1);
  });

  test(`cf62 historical synthetic ${role}: unfinished first response protects later queued output instead of evicting it for item 257`, async (t) => {
    const f = fixture(t, role);
    await f.start();
    for (let index = 0; index < 256; index += 1) {
      f.created(index);
      f.content(index, false);
    }
    assert.deepEqual(f.errors, []);
    assert.equal(f.client.retentionSnapshot!().activeResponses, 256);
    assert.equal(f.audio.length, role === 'local' ? 1 : 0);
    assert.equal(
      new Set(f.translations.map((item) => item.responseId)).size,
      1,
    );
    f.created(256);
    assert.deepEqual(f.errors, ['LIVETRANSLATE_ITEM_CAPACITY']);
    assert.equal(f.diagnostics[0].beforeCleanup.activeResponses, 256);
    const count = f.audio.length;
    for (let index = 255; index >= 0; index -= 1) f.done(index);
    assert.equal(f.audio.length, count);
    assert.equal(f.connects(), 1);
  });

  test(`cf62 historical synthetic ${role}: reverse completion of 256 same-source responses drains once in created order but does not restore capacity`, async (t) => {
    const f = fixture(t, role);
    await f.start();
    for (let index = 0; index < 256; index += 1) f.created(index);
    for (let index = 255; index >= 0; index -= 1) f.content(index);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(
      [...new Set(f.translations.map((item) => item.responseId))],
      Array.from({ length: 256 }, (_, index) => `synthetic_response_${index}`),
    );
    assert.deepEqual(
      f.audio.map((item) => item.responseId),
      role === 'local'
        ? Array.from(
            { length: 256 },
            (_, index) => `synthetic_response_${index}`,
          )
        : [],
    );
    assert.equal(f.client.retentionSnapshot!().activeResponses, 256);
    f.created(256);
    assert.deepEqual(f.errors, ['LIVETRANSLATE_ITEM_CAPACITY']);
    assert.equal(f.connects(), 1);
  });

  test(`cf62 historical synthetic ${role}: duplicate and late completed frames neither replay nor free the single-source capacity`, async (t) => {
    const f = fixture(t, role);
    await f.start();
    f.complete(0);
    const firstFrames = f.frames.filter(
      (frame) =>
        frame.response_id === 'synthetic_response_0' ||
        frame.response?.id === 'synthetic_response_0',
    );
    for (let index = 1; index < 256; index += 1) f.complete(index);
    const counts = [f.audio.length, f.translations.length];
    for (const frame of [...firstFrames].reverse()) f.receive(frame);
    for (const frame of firstFrames)
      f.receive({ ...frame, event_id: `synthetic_late_${frame.event_id}` });
    assert.deepEqual(f.errors, []);
    assert.deepEqual([f.audio.length, f.translations.length], counts);
    assert.equal(f.client.retentionSnapshot!().activeResponses, 256);
    f.created(256);
    assert.deepEqual(f.errors, ['LIVETRANSLATE_ITEM_CAPACITY']);
    assert.equal(f.connects(), 1);
  });

  test(`cf62 historical synthetic ${role}: clear ACK and unknown deletion are not safe retirement or output withdrawal`, async (t) => {
    const f = fixture(t, role);
    await f.start();
    for (let index = 0; index < 256; index += 1) f.complete(index);
    const counts = [f.audio.length, f.translations.length, f.wire.sent.length];
    f.receive({ type: 'input_audio_buffer.cleared' });
    // This unknown extension is not an implemented provider retraction event.
    // Do not infer successful withdrawal or safe retirement from its name.
    f.receive({
      type: 'conversation.item.deleted',
      item_id: 'synthetic_output_0',
    });
    assert.deepEqual(f.errors, []);
    assert.equal(f.client.retentionSnapshot!().activeResponses, 256);
    assert.deepEqual(
      [f.audio.length, f.translations.length, f.wire.sent.length],
      counts,
    );
    f.created(256);
    assert.deepEqual(f.errors, ['LIVETRANSLATE_ITEM_CAPACITY']);
  });

  test(`cf62 historical synthetic ${role}: unconfirmed created/link metadata first exhausts its own Map before any response`, async (t) => {
    const f = fixture(t, role);
    await f.start();
    for (let index = 0; index < 256; index += 1) f.link(index);
    assert.deepEqual(f.errors, []);
    assert.equal(f.client.retentionSnapshot!().activeResponses, 0);
    assert.equal(f.client.retentionSnapshot!().activeTranslations, 0);
    f.link(256);
    assert.deepEqual(f.errors, ['LIVETRANSLATE_ITEM_CAPACITY']);
    assert.equal(f.diagnostics[0].eventType, 'conversation.item.created');
    assert.equal(f.diagnostics[0].beforeCleanup.activeResponses, 0);
    assert.equal(f.diagnostics[0].beforeCleanup.activeTranslations, 0);
    assert.equal(f.audio.length, 0);
    assert.equal(f.connects(), 1);
  });

  test(`cf62 historical synthetic ${role}: abort fences queued output, late completion and clear acknowledgements without reconnect`, async (t) => {
    const f = fixture(t, role);
    await f.start();
    for (let index = 0; index < 256; index += 1) {
      f.created(index);
      f.content(index, false);
    }
    const counts = [f.audio.length, f.translations.length, f.wire.sent.length];
    f.client.abort();
    for (let index = 255; index >= 0; index -= 1) f.done(index);
    f.receive({ type: 'input_audio_buffer.cleared' });
    f.complete(256);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(
      [f.audio.length, f.translations.length, f.wire.sent.length],
      counts,
    );
    assert.equal(f.client.retentionSnapshot!().activeResponses, 0);
    assert.equal(f.connects(), 1);
    assert.equal(f.wire.closes, 1);
  });
}

test('cf62 historical synthetic unsupported noncompleted response stays fail-closed rather than pretending to withdraw played output', async (t) => {
  const f = fixture(t, 'local');
  await f.start();
  f.created(0);
  f.content(0, false);
  assert.equal(f.audio.length, 1);
  f.done(0, 'cancelled');
  assert.deepEqual(f.errors, ['LIVETRANSLATE_RESPONSE_INCOMPLETE']);
  f.done(0);
  assert.equal(f.audio.length, 1);
  assert.equal(f.connects(), 1);
});
