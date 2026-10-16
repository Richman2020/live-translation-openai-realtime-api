/* eslint-disable no-await-in-loop -- Synthetic supplier sessions are independent and serial. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';

import {
  createLiveTranslateClient,
  LIVE_TRANSLATE_MODEL,
} from '../src/experiments/livetranslate-client';
import type { LiveTranslateRetentionSnapshot } from '../src/experiments/livetranslate-types';

/** Every supplier event and PCM sample in this file is artificial. This is not
 * a replay of the user's telephone call or proof of ear-end playback. */
class Wire extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  sent: Record<string, any>[] = [];

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

function fixture(
  t: TestContext,
  role: 'local' | 'remote' = 'local',
  translationPadding = 0,
) {
  const wire = new Wire();
  const errors: string[] = [];
  const frames: Record<string, any>[] = [];
  const audio: { pcm: Buffer; responseId: string }[] = [];
  const translations: {
    responseId: string;
    translationId: string;
    text: string;
  }[] = [];
  const sources: { sourceId: string }[] = [];
  const usage: { responseId: string }[] = [];
  const failureSnapshots: LiveTranslateRetentionSnapshot[] = [];
  const diagnostics: Record<string, any>[] = [];
  const checkpoints: {
    completedResponses: number;
    snapshot: LiveTranslateRetentionSnapshot;
  }[] = [];
  let serial = 0;
  let connects = 0;
  const voice = role === 'local' ? 'Andre' : 'Tina';
  const client = createLiveTranslateClient({
    enabled: true,
    usage: 'phone',
    role,
    voice,
    workspaceId: 'synthetic-compaction-only',
    apiKey: 'SYNTHETIC_UNUSED_OFFLINE_KEY',
    createWebSocket() {
      connects += 1;
      return wire as unknown as WebSocket;
    },
    onSource: (item) => sources.push(item),
    onTranslation: (item) => translations.push(item),
    onAudio: (pcm, item) =>
      audio.push({ pcm: Buffer.from(pcm), responseId: item.responseId }),
    onUsage: (item) => usage.push(item),
    onError: (code) => errors.push(code),
    onProtocolDiagnostic: (item) => {
      diagnostics.push(item);
      if (item.fatal) failureSnapshots.push(client.retentionSnapshot!());
    },
  });
  t.after(() => client.abort());
  const receive = (frame: Record<string, any>) => {
    serial += 1;
    const event = {
      event_id: `synthetic_compaction_event_${serial}`,
      ...frame,
    };
    frames.push(event);
    wire.emit('message', Buffer.from(JSON.stringify(event)), false);
    return event;
  };
  const start = async () => {
    const session = {
      id: `synthetic_compaction_${role}`,
      model: LIVE_TRANSLATE_MODEL,
      voice,
      output_modalities: role === 'local' ? ['text', 'audio'] : ['text'],
      enable_voice_clone: false,
      audio: {
        input: {
          format: { type: 'pcm', sample_rate: 16000 },
          turn_detection: { type: 'speaker_detection', threshold: 0.5 },
        },
        output: { format: { type: 'pcm', sample_rate: 24000 }, voice },
      },
      translation: { language: role === 'local' ? 'en' : 'zh' },
    };
    receive({ type: 'session.created', session });
    receive({ type: 'session.updated', session });
    await client.ready;
  };
  const source = (
    id: string,
    offset: number,
    final = true,
    duration = 300,
    text = 'Synthetic source.',
  ) => {
    receive({
      type: 'input_audio_buffer.speech_started',
      item_id: id,
      audio_start_ms: offset,
    });
    receive({
      type: 'input_audio_buffer.speech_stopped',
      item_id: id,
      audio_end_ms: offset + duration,
    });
    receive({
      type: `conversation.item.input_audio_transcription.${final ? 'completed' : 'delta'}`,
      item_id: id,
      content_index: 0,
      ...(final ? { transcript: text } : { delta: text }),
    });
  };
  const created = (index: number) =>
    receive({
      type: 'response.created',
      response: { id: `r_${index}`, voice, status: 'in_progress' },
    });
  const link = (index: number, sourceId: string) =>
    receive({
      type: 'conversation.item.created',
      previous_item_id: sourceId,
      item: { id: `t_${index}`, role: 'assistant', content: [] },
    });
  const output = (
    index: number,
    type: string,
    patch: Record<string, any> = {},
  ) =>
    receive({
      type,
      response_id: `r_${index}`,
      item_id: `t_${index}`,
      output_index: 0,
      content_index: 0,
      ...patch,
    });
  const text = (index: number) =>
    `Synthetic translation ${index}.${'x'.repeat(translationPadding)}`;
  const done = (index: number, patch: Record<string, any> = {}) =>
    receive({
      type: 'response.done',
      response: {
        id: `r_${index}`,
        voice,
        status: 'completed',
        usage: { input_tokens: 1, output_tokens: 2 },
        output: [
          {
            id: `t_${index}`,
            content: [
              role === 'local'
                ? { type: 'audio', transcript: text(index) }
                : { type: 'text', text: text(index) },
            ],
          },
        ],
        ...patch,
      },
    });
  const content = (index: number, sourceId: string, finish = true) => {
    link(index, sourceId);
    output(
      index,
      role === 'local'
        ? 'response.audio_transcript.done'
        : 'response.text.done',
      role === 'local' ? { transcript: text(index) } : { text: text(index) },
    );
    if (role === 'local') {
      const pcm = Buffer.alloc(6);
      pcm.writeUInt16LE(index % 65536);
      output(index, 'response.audio.delta', { delta: pcm.toString('base64') });
      output(index, 'response.audio.done');
    }
    if (finish) done(index);
  };
  const complete = (index: number, sourceId = 's') => {
    created(index);
    content(index, sourceId);
    if ([32, 256, 257, 300, 1024, 1200].includes(index + 1))
      checkpoints.push({
        completedResponses: index + 1,
        snapshot: client.retentionSnapshot!(),
      });
  };
  const fill = (count = 40, final = true) => {
    source('s', 1000, final);
    for (let index = 0; index < count; index += 1) complete(index);
  };
  return {
    client,
    wire,
    errors,
    frames,
    audio,
    translations,
    sources,
    usage,
    failureSnapshots,
    diagnostics,
    checkpoints,
    receive,
    start,
    source,
    created,
    link,
    output,
    done,
    content,
    complete,
    fill,
    connects: () => connects,
  };
}

function assertBounded(snapshot: LiveTranslateRetentionSnapshot) {
  assert.ok(snapshot.activeSources <= 256);
  assert.ok(snapshot.activeResponses <= 256);
  assert.ok(snapshot.activeTranslations <= 256);
  assert.ok(snapshot.retainedEventIds <= 4096);
  assert.ok(snapshot.terminalBudgetUsed! <= 1024);
  assert.equal(
    snapshot.terminalBudgetUsed,
    snapshot.terminalIdentifiers! +
      snapshot.closedResponseIdentities! +
      snapshot.closedOutputIdentities!,
  );
  assert.equal(
    snapshot.terminalBudgetUsed,
    snapshot.pinnedTerminalIdentifiers! +
      snapshot.reclaimableTerminalIdentifiers!,
  );
}

for (const role of ['local', 'remote'] as const) {
  for (const final of [false, true]) {
    test(`synthetic ${role}: one ${final ? 'final' : 'still speaking'} source crosses 256 to 300 without replay or heavy-object growth`, async (t) => {
      const f = fixture(t, role);
      await f.start();
      f.fill(300, final);
      const snapshot = f.client.retentionSnapshot!();
      assert.deepEqual(f.errors, []);
      assert.equal(snapshot.activeSources, 1);
      assert.equal(snapshot.activeResponses, 32);
      assert.equal(snapshot.activeTranslations, 32);
      assert.equal(snapshot.closedResponseIdentities, 268);
      assert.equal(snapshot.closedOutputIdentities, 268);
      assert.equal(snapshot.terminalBudgetUsed, 536);
      assert.equal(snapshot.pinnedTerminalIdentifiers, 536);
      assert.equal(snapshot.sourceCompletionSummaries, 1);
      assertBounded(snapshot);
      assert.equal(f.audio.length, role === 'local' ? 300 : 0);
      assert.deepEqual(
        [...new Set(f.translations.map((item) => item.responseId))],
        Array.from({ length: 300 }, (_, index) => `r_${index}`),
      );
      assert.equal(f.usage.length, 300);
      assert.equal(f.connects(), 1);
      assert.equal(f.wire.closes, 0);
      t.diagnostic(
        JSON.stringify({
          synthetic: true,
          role,
          final,
          responseCount: 300,
          snapshot,
          checkpoints: f.checkpoints,
        }),
      );
    });
  }

  test(`synthetic ${role}: 1200 completed responses across retiring sources keep all state bounded`, async (t) => {
    const f = fixture(t, role);
    await f.start();
    let peakBudget = 0;
    let peakEvents = 0;
    for (let sourceIndex = 0; sourceIndex < 400; sourceIndex += 1) {
      f.source(`s_${sourceIndex}`, sourceIndex * 1000);
      for (let part = 0; part < 3; part += 1)
        f.complete(sourceIndex * 3 + part, `s_${sourceIndex}`);
      const snapshot = f.client.retentionSnapshot!();
      assertBounded(snapshot);
      assert.ok(snapshot.activeResponses <= 32);
      assert.ok(snapshot.activeTranslations <= 32);
      assert.ok(snapshot.sourceCompletionSummaries! <= snapshot.activeSources);
      peakBudget = Math.max(peakBudget, snapshot.terminalBudgetUsed!);
      peakEvents = Math.max(peakEvents, snapshot.retainedEventIds);
    }
    const snapshot = f.client.retentionSnapshot!();
    assert.deepEqual(f.errors, []);
    assert.equal(snapshot.activeSources, 32);
    assert.ok(snapshot.sourceOffsetFloorMs > 300000);
    assert.equal(f.audio.length, role === 'local' ? 1200 : 0);
    assert.equal(
      new Set(f.translations.map((item) => item.responseId)).size,
      1200,
    );
    assert.equal(f.usage.length, 1200);
    assert.ok(snapshot.retiredResponsesTotal! > 1000);
    assert.equal(f.connects(), 1);
    t.diagnostic(
      JSON.stringify({
        synthetic: true,
        role,
        responseCount: 1200,
        peakBudget,
        peakEvents,
        snapshot,
        checkpoints: f.checkpoints,
      }),
    );
  });
}

test('synthetic joint budget: a dense pinned source has an honest finite stop, never evicts closed evidence or exceeds 1024 keys', async (t) => {
  const f = fixture(t);
  await f.start();
  f.source('s', 0, false);
  let completed = 0;
  let beforeFailure = f.client.retentionSnapshot!();
  while (!f.errors.length && completed < 700) {
    beforeFailure = f.client.retentionSnapshot!();
    f.complete(completed);
    completed += 1;
    if (!f.errors.length) assertBounded(f.client.retentionSnapshot!());
  }
  assert.deepEqual(f.errors, ['LIVETRANSLATE_TERMINAL_CAPACITY']);
  // This fixture has no other terminal keys: 32 cached mature responses plus
  // 512 two-key compact identities are healthy; the next compaction cannot fit.
  assert.equal(completed, 545);
  const atFailure = f.failureSnapshots[0];
  assertBounded(atFailure);
  assert.equal(atFailure.terminalBudgetUsed, 1024);
  assert.equal(atFailure.pinnedTerminalIdentifiers, 1024);
  assert.equal(atFailure.reclaimableTerminalIdentifiers, 0);
  assert.equal(atFailure.closedResponseIdentities, 512);
  assert.equal(atFailure.closedOutputIdentities, 512);
  assert.equal(beforeFailure.activeResponses, 32);
  assert.equal(atFailure.activeResponses, 33);
  assert.equal(
    f.diagnostics.find((item) => item.fatal)?.eventType,
    'response.done',
  );
  assert.equal(f.audio.length, 545);
  assert.equal(
    new Set(f.translations.map((item) => item.responseId)).size,
    545,
  );
  assert.equal(f.usage.length, 545);
  assert.equal(f.connects(), 1);
  assert.equal(f.wire.closes, 1);
  const counts = [
    f.audio.length,
    f.translations.length,
    f.usage.length,
    f.wire.sent.length,
  ];
  f.complete(10000);
  assert.deepEqual(
    [f.audio.length, f.translations.length, f.usage.length, f.wire.sent.length],
    counts,
  );
  t.diagnostic(
    JSON.stringify({
      synthetic: true,
      attemptedResponses: completed,
      healthyResponsesBeforeFailure: completed - 1,
      generatedAudioCallbacksAtFailure: f.audio.length,
      uniqueTranslationResponsesAtFailure: new Set(
        f.translations.map((item) => item.responseId),
      ).size,
      usageCallbacksAtFailure: f.usage.length,
      failureEventType: f.diagnostics.find((item) => item.fatal)?.eventType,
      beforeFailure,
      atFailure,
      checkpoints: f.checkpoints,
    }),
  );
});

test('synthetic logical memory: 300 long translations retain only the 32 mature bodies and no delivered PCM', async (t) => {
  const f = fixture(t, 'local', 2048);
  await f.start();
  f.fill(300);
  const snapshot = f.client.retentionSnapshot!();
  assert.deepEqual(f.errors, []);
  assert.equal(snapshot.activeResponses, 32);
  assert.equal(snapshot.activeTranslations, 32);
  assert.equal(snapshot.closedOutputIdentities, 268);
  assert.equal(snapshot.queuedAudioBytes, 0);
  const expectedRetainedText =
    'Synthetic source.'.length +
    Array.from({ length: 32 }, (_, index) => 268 + index).reduce(
      (sum, index) => sum + `Synthetic translation ${index}.`.length + 2048,
      0,
    );
  assert.equal(snapshot.retainedTextCharacters, expectedRetainedText);
  assert.ok(snapshot.retainedTextCharacters! < 70000);
  t.diagnostic(
    JSON.stringify({
      synthetic: true,
      logicalMemoryOnly: true,
      inputTranslationCharacters: Array.from(
        { length: 300 },
        (_, index) => index,
      ).reduce(
        (sum, index) => sum + `Synthetic translation ${index}.`.length + 2048,
        0,
      ),
      snapshot,
      checkpoints: f.checkpoints,
    }),
  );
});

test('synthetic: 256 genuinely unfinished responses are not compacted to admit item 257', async (t) => {
  const f = fixture(t);
  await f.start();
  f.source('s', 0);
  for (let index = 0; index < 256; index += 1) {
    f.created(index);
    f.content(index, 's', false);
  }
  const snapshot = f.client.retentionSnapshot!();
  assert.equal(snapshot.activeResponses, 256);
  assert.equal(snapshot.closedResponseIdentities, 0);
  assert.equal(f.audio.length, 1);
  f.created(256);
  assert.deepEqual(f.errors, ['LIVETRANSLATE_ITEM_CAPACITY']);
  assert.equal(f.failureSnapshots[0].activeResponses, 256);
});

test('synthetic: reverse completion retains queued PCM until original created order has delivered it', async (t) => {
  const f = fixture(t);
  await f.start();
  f.source('s', 0);
  for (let index = 0; index < 128; index += 1) f.created(index);
  for (let index = 127; index >= 1; index -= 1) f.content(index, 's');
  assert.equal(f.audio.length, 0);
  assert.equal(f.client.retentionSnapshot!().activeResponses, 128);
  assert.equal(f.client.retentionSnapshot!().closedResponseIdentities, 0);
  f.content(0, 's');
  assert.deepEqual(f.errors, []);
  assert.deepEqual(
    f.audio.map((item) => item.responseId),
    Array.from({ length: 128 }, (_, index) => `r_${index}`),
  );
  assert.equal(f.client.retentionSnapshot!().activeResponses, 32);
  assert.equal(f.client.retentionSnapshot!().closedResponseIdentities, 96);
});

test('synthetic: new assistant input_audio can reference a compacted output as conversation predecessor', async (t) => {
  const f = fixture(t);
  await f.start();
  f.fill();
  assert.ok(f.client.retentionSnapshot!().closedOutputIdentities! > 0);
  f.receive({
    type: 'conversation.item.created',
    previous_item_id: 't_0',
    item: {
      id: 'new_source',
      role: 'assistant',
      content: [{ type: 'input_audio' }],
    },
  });
  f.source('new_source', 3000);
  f.complete(40, 'new_source');
  assert.deepEqual(f.errors, []);
  assert.equal(f.audio.at(-1)?.responseId, 'r_40');
  assert.ok(f.sources.some((item) => item.sourceId === 'new_source'));
});

test('synthetic typed source: a compacted output cannot become another translated output source', async (t) => {
  const f = fixture(t);
  await f.start();
  f.fill();
  const before = [f.audio.length, f.translations.length, f.usage.length];
  f.created(40);
  f.link(40, 't_0');
  f.output(40, 'response.audio_transcript.done', {
    transcript: 'Synthetic translation 40.',
  });
  assert.deepEqual(f.errors, ['LIVETRANSLATE_SOURCE_CONFLICT']);
  assert.deepEqual(
    [f.audio.length, f.translations.length, f.usage.length],
    before,
  );
});

for (const eventType of ['response.created', 'response.done'] as const) {
  test(`synthetic compact response: duplicate ${eventType} still validates voice configuration`, async (t) => {
    const f = fixture(t);
    await f.start();
    f.fill();
    const before = [f.audio.length, f.translations.length, f.usage.length];
    f.receive({
      type: eventType,
      response: {
        id: 'r_0',
        voice: 'Tina',
        status: eventType === 'response.created' ? 'in_progress' : 'completed',
        output: [],
      },
    });
    assert.deepEqual(f.errors, ['LIVETRANSLATE_CONFIGURATION_REJECTED']);
    assert.deepEqual(
      [f.audio.length, f.translations.length, f.usage.length],
      before,
    );
  });
}

test('synthetic compact response: duplicate created still enforces in-progress status before closed lookup', async (t) => {
  const f = fixture(t);
  await f.start();
  f.fill();
  f.receive({
    type: 'response.created',
    response: { id: 'r_0', voice: 'Andre', status: 'completed' },
  });
  assert.deepEqual(f.errors, ['LIVETRANSLATE_RESPONSE_INCOMPLETE']);
});

for (const kind of ['input', 'vad', 'source', 'response', 'slot'] as const) {
  test(`synthetic typed closed output: ${kind} identity rebinding is still rejected`, async (t) => {
    const f = fixture(t);
    await f.start();
    f.fill();
    assert.ok(f.client.retentionSnapshot!().closedOutputIdentities! > 0);
    const before = [f.audio.length, f.translations.length, f.usage.length];
    if (kind === 'input')
      f.receive({
        type: 'conversation.item.created',
        item: {
          id: 't_0',
          role: 'assistant',
          content: [{ type: 'input_audio' }],
        },
      });
    if (kind === 'vad')
      f.receive({
        type: 'input_audio_buffer.speech_started',
        item_id: 't_0',
        audio_start_ms: 5000,
      });
    if (kind === 'source') f.link(0, 'other_source');
    if (kind === 'response') {
      f.created(1000);
      f.output(0, 'response.audio.delta', {
        response_id: 'r_1000',
        delta: 'AQACAAQA',
      });
    }
    if (kind === 'slot')
      f.output(0, 'response.audio.delta', {
        output_index: 1,
        delta: 'AQACAAQA',
      });
    assert.equal(f.errors.length, 1);
    const expectedErrors = {
      slot: 'LIVETRANSLATE_UNSUPPORTED_SCHEMA',
      source: 'LIVETRANSLATE_SOURCE_CONFLICT',
      input: 'LIVETRANSLATE_ITEM_CONFLICT',
      vad: 'LIVETRANSLATE_ITEM_CONFLICT',
      response: 'LIVETRANSLATE_ITEM_CONFLICT',
    };
    assert.equal(f.errors[0], expectedErrors[kind]);
    assert.deepEqual(
      [f.audio.length, f.translations.length, f.usage.length],
      before,
    );
    assert.equal(f.connects(), 1);
  });
}

test('synthetic: compacted IDs suppress exact and new-event late frames without replaying text, PCM or usage', async (t) => {
  const f = fixture(t);
  await f.start();
  f.fill();
  const old = f.frames.filter(
    (event) => event.response_id === 'r_0' || event.response?.id === 'r_0',
  );
  const before = [f.audio.length, f.translations.length, f.usage.length];
  for (const frame of [...old].reverse()) f.receive(frame);
  for (const frame of old)
    f.receive({ ...frame, event_id: `late_${frame.event_id}` });
  assert.deepEqual(f.errors, []);
  assert.deepEqual(
    [f.audio.length, f.translations.length, f.usage.length],
    before,
  );
  assert.equal(f.connects(), 1);
});

test('synthetic: an unfinished source retains event-ID conflict evidence after response compaction', async (t) => {
  const f = fixture(t);
  await f.start();
  f.fill(40, false);
  const firstAudio = f.frames.find(
    (event) =>
      event.type === 'response.audio.delta' && event.response_id === 'r_0',
  )!;
  const count = f.audio.length;
  f.receive(firstAudio);
  assert.deepEqual(f.errors, []);
  f.receive({ ...firstAudio, delta: 'AgADAAUA' });
  assert.deepEqual(f.errors, ['LIVETRANSLATE_EVENT_CONFLICT']);
  assert.equal(f.audio.length, count);
});

test('synthetic: the original 4096 active-event guard is not replaced by response compaction', async (t) => {
  const f = fixture(t);
  await f.start();
  f.source('s', 0, false);
  f.created(0);
  f.link(0, 's');
  for (let index = 0; index < 4100; index += 1)
    f.output(0, 'response.audio.delta', { delta: 'AQACAAQA' });
  assert.deepEqual(f.errors, ['LIVETRANSLATE_EVENT_CAPACITY']);
  assert.equal(f.failureSnapshots[0].retainedEventIds, 4096);
  assert.equal(f.failureSnapshots[0].closedResponseIdentities, 0);
});

test('synthetic: a fragment-heavy unfinished source can reach the 4096 event guard before its compact-identity budget', async (t) => {
  const f = fixture(t);
  await f.start();
  f.source('s', 0, false);
  let attemptedResponses = 0;
  while (!f.errors.length && attemptedResponses < 400) {
    const index = attemptedResponses;
    f.created(index);
    f.link(index, 's');
    // Empty incremental fragments are valid synthetic supplier deltas. Their
    // event IDs are still conflict evidence while the source remains open.
    for (let fragment = 0; fragment < 8; fragment += 1)
      f.output(index, 'response.audio_transcript.delta', { delta: '' });
    f.content(index, 's');
    attemptedResponses += 1;
  }
  assert.deepEqual(f.errors, ['LIVETRANSLATE_EVENT_CAPACITY']);
  const atFailure = f.failureSnapshots[0];
  assert.equal(atFailure.retainedEventIds, 4096);
  assert.ok(atFailure.terminalBudgetUsed! < 1024);
  assert.ok(attemptedResponses > 256 && attemptedResponses < 300);
  assertBounded(atFailure);
  t.diagnostic(
    JSON.stringify({
      synthetic: true,
      fragmentHeavyActiveSource: true,
      attemptedResponses,
      generatedAudioCallbacksAtFailure: f.audio.length,
      failureEventType: f.diagnostics.find((item) => item.fatal)?.eventType,
      atFailure,
    }),
  );
});

test('synthetic: clear ACK and unknown deletion do not withdraw compacted speech or release pinned evidence', async (t) => {
  const f = fixture(t);
  await f.start();
  f.fill();
  const snapshot = f.client.retentionSnapshot!();
  const before = [f.audio.length, f.translations.length, f.usage.length];
  f.receive({ type: 'input_audio_buffer.cleared' });
  f.receive({ type: 'conversation.item.deleted', item_id: 't_0' });
  assert.deepEqual(f.errors, []);
  assert.equal(
    f.client.retentionSnapshot!().pinnedTerminalIdentifiers,
    snapshot.pinnedTerminalIdentifiers,
  );
  assert.equal(
    f.client.retentionSnapshot!().closedResponseIdentities,
    snapshot.closedResponseIdentities,
  );
  assert.deepEqual(
    [f.audio.length, f.translations.length, f.usage.length],
    before,
  );
  f.complete(40);
  assert.equal(f.audio.length, before[0] + 1);
});

test('synthetic: a cancelled response remains a strict failure rather than being treated as safe compaction or withdrawal', async (t) => {
  const f = fixture(t);
  await f.start();
  f.fill();
  f.created(40);
  f.content(40, 's', false);
  f.done(40, { status: 'cancelled' });
  assert.deepEqual(f.errors, ['LIVETRANSLATE_RESPONSE_INCOMPLETE']);
  assert.equal(f.failureSnapshots[0].activeResponses, 33);
  const count = f.audio.length;
  f.done(40);
  assert.equal(f.audio.length, count);
});

test('synthetic: abort clears active, compact and pending state and fences all delayed supplier events', async (t) => {
  const f = fixture(t);
  await f.start();
  f.fill();
  f.created(40);
  f.content(40, 's', false);
  const before = [
    f.audio.length,
    f.translations.length,
    f.usage.length,
    f.wire.sent.length,
  ];
  f.client.abort();
  f.done(40);
  for (const frame of f.frames.slice(2, 20)) f.receive(frame);
  const snapshot = f.client.retentionSnapshot!();
  for (const field of [
    'activeSources',
    'activeResponses',
    'activeTranslations',
    'closedResponseIdentities',
    'closedOutputIdentities',
    'sourceCompletionSummaries',
    'terminalBudgetUsed',
    'pinnedTerminalIdentifiers',
    'pendingAssociations',
    'retainedEventIds',
  ] as const)
    assert.equal(snapshot[field], 0, field);
  assert.deepEqual(
    [f.audio.length, f.translations.length, f.usage.length, f.wire.sent.length],
    before,
  );
  assert.deepEqual(f.errors, []);
  assert.equal(f.connects(), 1);
  assert.equal(f.wire.closes, 1);
});

test('synthetic: source summaries preserve successful finish and do not duplicate provider usage', async (t) => {
  const f = fixture(t);
  await f.start();
  f.fill();
  f.done(0, { usage: { input_tokens: 9999, output_tokens: 9999 } });
  assert.equal(f.usage.length, 40);
  const finished = f.client.finish();
  f.receive({ type: 'session.finished' });
  await finished;
  assert.deepEqual(f.errors, []);
  assert.equal(f.client.retentionSnapshot!().terminalBudgetUsed, 0);
  assert.equal(f.audio.length, 40);
});

test('synthetic compact usage: first unknown usage remains unknown when duplicate done arrives with later counters', async (t) => {
  const f = fixture(t);
  await f.start();
  f.source('s', 1000);
  f.created(0);
  f.content(0, 's', false);
  f.done(0, { usage: undefined });
  for (let index = 1; index < 40; index += 1) f.complete(index);
  assert.equal(f.client.retentionSnapshot!().closedResponseIdentities, 8);
  const firstUsage = f.usage[0];
  assert.equal(Reflect.get(firstUsage, 'basis'), 'unknown');
  assert.equal(Reflect.get(firstUsage, 'inputTokens'), undefined);
  f.done(0, { usage: { input_tokens: 99, output_tokens: 99 } });
  assert.deepEqual(f.errors, []);
  assert.equal(f.usage.length, 40);
  assert.equal(f.usage[0], firstUsage);
  assert.equal(Reflect.get(f.usage[0], 'inputTokens'), undefined);
});

test('synthetic: bound empty outputs cannot mask a later nonempty source in finish validation', async (t) => {
  const f = fixture(t);
  await f.start();
  f.source('s', 0, false, 300, '');
  for (let index = 0; index < 40; index += 1) {
    f.created(index);
    f.link(index, 's');
    f.output(index, 'response.audio_transcript.done', { transcript: '' });
    f.done(index, { output: [{ id: `t_${index}`, content: [] }] });
  }
  assert.deepEqual(f.errors, []);
  assert.ok(f.client.retentionSnapshot!().closedOutputIdentities! > 0);
  f.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 's',
    content_index: 0,
    transcript: 'This source actually contains speech.',
  });
  const finished = f.client.finish();
  f.receive({ type: 'session.finished' });
  await assert.rejects(finished, /LIVETRANSLATE_FINISH_INCOMPLETE/u);
  assert.deepEqual(f.errors, ['LIVETRANSLATE_FINISH_INCOMPLETE']);
  assert.equal(f.audio.length, 0);
});

test('synthetic: nonempty local output without audio still fails instead of earning a completion summary', async (t) => {
  const f = fixture(t);
  await f.start();
  f.fill();
  f.created(40);
  f.link(40, 's');
  f.output(40, 'response.audio_transcript.done', {
    transcript: 'Synthetic translation 40.',
  });
  f.done(40);
  assert.deepEqual(f.errors, ['LIVETRANSLATE_RESPONSE_AUDIO_MISSING']);
  assert.equal(f.failureSnapshots[0].activeResponses, 33);
  assert.equal(f.failureSnapshots[0].closedResponseIdentities, 8);
});

test('synthetic: retired zero-duration same-offset sources remain pinned until floor strictly passes their start', async (t) => {
  const f = fixture(t);
  await f.start();
  for (let index = 0; index < 70; index += 1) {
    f.source(`s_${index}`, 0, true, 0);
    f.complete(index, `s_${index}`);
  }
  const equal = f.client.retentionSnapshot!();
  assert.deepEqual(f.errors, []);
  assert.equal(equal.sourceOffsetFloorMs, 0);
  assert.ok(equal.pinnedTerminalIdentifiers! > 0);
  assert.equal(equal.reclaimableTerminalIdentifiers, 0);
  assertBounded(equal);
  for (let index = 70; index < 110; index += 1) {
    f.source(`s_${index}`, (index - 69) * 1000, true, 0);
    f.complete(index, `s_${index}`);
  }
  const passed = f.client.retentionSnapshot!();
  assert.deepEqual(f.errors, []);
  assert.ok(passed.sourceOffsetFloorMs > 0);
  assert.ok(passed.reclaimableTerminalIdentifiers! > 0);
  assertBounded(passed);
  const before = [f.audio.length, f.translations.length, f.usage.length];
  f.receive({
    type: 'input_audio_buffer.speech_started',
    item_id: 's_0',
    audio_start_ms: 0,
  });
  assert.deepEqual(f.errors, []);
  assert.deepEqual(
    [f.audio.length, f.translations.length, f.usage.length],
    before,
  );
});

test('synthetic shared-budget retirement: replacing a closed pair plus a source fence never evicts and reinserts past 1024', async (t) => {
  const f = fixture(t);
  await f.start();
  for (let index = 0; index < 32; index += 1) {
    f.source(`s_${index}`, index * 1000);
    f.complete(index, `s_${index}`);
  }
  for (let index = 32; index < 544; index += 1) f.complete(index, 's_31');
  const beforeRetirement = f.client.retentionSnapshot!();
  assert.deepEqual(f.errors, []);
  assert.equal(beforeRetirement.activeResponses, 32);
  assert.equal(beforeRetirement.terminalBudgetUsed, 1024);
  assert.equal(beforeRetirement.pinnedTerminalIdentifiers, 1024);
  assert.equal(beforeRetirement.reclaimableTerminalIdentifiers, 0);

  // An empty final source advances completed-source grace without allocating
  // a new response first. The oldest source's own retired keys become the
  // only safe eviction candidates while all later closed pairs remain pinned.
  f.source('s_32', 32000, true, 300, '');
  const afterRetirement = f.client.retentionSnapshot!();
  assert.deepEqual(f.errors, []);
  assertBounded(afterRetirement);
  assert.equal(afterRetirement.terminalBudgetUsed, 1024);
  assert.equal(afterRetirement.sourceOffsetFloorMs, 300);
  assert.equal(afterRetirement.pinnedTerminalIdentifiers, 1022);
  assert.equal(afterRetirement.reclaimableTerminalIdentifiers, 2);
  const beforeReplay = [f.audio.length, f.translations.length, f.usage.length];
  for (const frame of f.frames.slice(2, 11)) f.receive(frame);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(
    [f.audio.length, f.translations.length, f.usage.length],
    beforeReplay,
  );
  t.diagnostic(
    JSON.stringify({
      synthetic: true,
      jointBudgetRetirement: true,
      beforeRetirement,
      afterRetirement,
    }),
  );
});
