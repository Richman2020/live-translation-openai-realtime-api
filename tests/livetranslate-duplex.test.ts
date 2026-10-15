import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';

import {
  createConversationModel,
  groupConversationUtterances,
  type ConversationTextEvent,
} from '../public/conversation-model.js';
import {
  createLiveTranslateDuplex,
  type LiveTranslateAudioDelivery,
  type LiveTranslateDuplexFault,
  type LiveTranslateDuplexOptions,
} from '../src/experiments/livetranslate-duplex';
import {
  createLiveTranslateClient,
  LIVE_TRANSLATE_MODEL,
} from '../src/experiments/livetranslate-client';
import type {
  LiveTranslateAudioMetadata,
  LiveTranslateClientOptions,
  LiveTranslateRole,
  LiveTranslateSession,
  LiveTranslateSource,
  LiveTranslateTranslation,
} from '../src/experiments/livetranslate-types';

const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
const pcm = (sample: number) => Buffer.from([sample, 0]);
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(extra: Partial<LiveTranslateDuplexOptions> = {}) {
  const configurations = new Map<
    LiveTranslateRole,
    LiveTranslateClientOptions
  >();
  const inputs: Record<LiveTranslateRole, Buffer[]> = { local: [], remote: [] };
  const aborts: Record<LiveTranslateRole, number> = { local: 0, remote: 0 };
  const finishes: Record<LiveTranslateRole, number> = { local: 0, remote: 0 };
  const originals: Buffer[] = [];
  const english: {
    pcm: Buffer;
    metadata: LiveTranslateAudioMetadata & { signal: AbortSignal };
  }[] = [];
  const faults: LiveTranslateDuplexFault[] = [];
  const evidence: Readonly<LiveTranslateTranslation>[] = [];
  const limitations: string[] = [];
  const deliveries: LiveTranslateAudioDelivery[] = [];
  const conversation: ConversationTextEvent[] = [];
  const model = createConversationModel('offline-duplex');
  const duplex = createLiveTranslateDuplex({
    enabled: true,
    sessionId: 'offline-duplex',
    workspaceId: 'offline-workspace',
    apiKey: 'fake-offline-never-authenticated',
    clientFactory(options) {
      assert.equal(configurations.has(options.role), false);
      configurations.set(options.role, options);
      const { role } = options;
      const session: LiveTranslateSession = {
        role,
        sessionId: `${role}-session`,
        model: 'qwen3.8-livetranslate-flash-realtime',
        voice: 'Aiden',
        voiceCloneEnabled: false,
        targetLanguage: role === 'local' ? 'en' : 'zh',
        configurationAcknowledgement: { eventId: 'fake-ack', receivedAt: 0, basis: 'provider_session_updated' },
        inputSampleRate: 16000,
        outputSampleRate: 24000,
        outputModalities: role === 'local' ? ['text', 'audio'] : ['text'],
      };
      return {
        ready: Promise.resolve(session),
        append(value) {
          inputs[role].push(value);
        },
        async finish() {
          finishes[role] += 1;
        },
        abort() {
          aborts[role] += 1;
        },
      };
    },
    onEnglishAudio(value, metadata) {
      english.push({ pcm: value, metadata });
    },
    onRemoteOriginal(value) {
      originals.push(value);
    },
    onConversationEvent(value) {
      conversation.push(value);
      assert.equal(model.apply(value), true);
    },
    onTranslationEvidence(value) {
      evidence.push(value);
    },
    onCaptionLimitation(value) {
      limitations.push(value.code);
    },
    onFault(value) {
      faults.push(value);
    },
    onAudioDelivery(value) {
      deliveries.push(value);
    },
    ...extra,
  });
  const source = (
    role: LiveTranslateRole,
    id: string,
    text: string,
    changes: Partial<LiveTranslateSource> = {},
  ) => {
    const event: LiveTranslateSource = {
      role,
      sourceId: id,
      sessionId: `${role}-session`,
      revision: 1,
      text,
      final: true,
      at: role === 'local' ? 100 : 200,
      ...changes,
    };
    configurations.get(role)!.onSource?.(event);
    return event;
  };
  const translation = (
    role: LiveTranslateRole,
    id: string,
    text: string,
    changes: Partial<LiveTranslateTranslation> = {},
  ) => {
    const event: LiveTranslateTranslation = {
      role,
      sessionId: `${role}-session`,
      translationId: id,
      responseId: `response-${id}`,
      pairing: 'unpaired',
      revision: 1,
      text,
      final: true,
      at: role === 'local' ? 300 : 400,
      ...changes,
    };
    configurations.get(role)!.onTranslation?.(event);
    return event;
  };
  const audio = (
    sequence: number,
    changes: Partial<LiveTranslateAudioMetadata> = {},
    value = pcm(sequence),
  ) => {
    const metadata: LiveTranslateAudioMetadata = {
      role: 'local',
      sessionId: 'local-session',
      translationId: 'translated-a',
      responseId: 'response-a',
      pairing: 'unpaired',
      eventId: `audio-${sequence}`,
      sequence,
      ...changes,
    };
    configurations.get(changes.role || 'local')!.onAudio?.(value, metadata);
  };
  const blocks = () => groupConversationUtterances(model.snapshot());
  return {
    duplex,
    configurations,
    inputs,
    aborts,
    finishes,
    originals,
    english,
    faults,
    evidence,
    limitations,
    deliveries,
    conversation,
    model,
    source,
    translation,
    audio,
    blocks,
  };
}

test('duplex is opt-in, creates exactly two isolated role clients and accepts only their fixed session configuration', async () => {
  let creates = 0;
  assert.throws(
    () =>
      createLiveTranslateDuplex({
        enabled: false,
        sessionId: 'disabled',
        workspaceId: 'unused',
        apiKey: 'unused',
        clientFactory() {
          creates += 1;
          throw new Error('must not create');
        },
        onEnglishAudio() {},
        onRemoteOriginal() {},
      }),
    /LIVETRANSLATE_DISABLED/,
  );
  assert.equal(creates, 0);
  const f = fixture();
  await f.duplex.ready;
  assert.equal(f.duplex.status, 'ready');
  assert.deepEqual([...f.configurations.keys()], ['local', 'remote']);
  assert.ok(
    [...f.configurations.values()].every((options) => options.enabled === true),
  );
  assert.equal(f.duplex.appendLocal(pcm(1)), true);
  assert.equal(f.duplex.appendRemote(pcm(2)), true);
  assert.deepEqual(f.inputs.local, [pcm(1)]);
  assert.deepEqual(f.inputs.remote, [pcm(2)]);
  assert.deepEqual(f.originals, [pcm(2)]);
  f.duplex.end('manual');
  assert.deepEqual(f.aborts, { local: 1, remote: 1 });
});

test('English source audio bypasses a blocked translation sink and remains audible after translation failure', async () => {
  const blocked = deferred();
  let started = 0;
  const f = fixture({
    onEnglishAudio() {
      started += 1;
      return blocked.promise;
    },
  });
  await f.duplex.ready;
  f.audio(1);
  assert.equal(started, 1);
  assert.equal(f.duplex.appendRemote(pcm(4)), true);
  assert.deepEqual(f.originals, [pcm(4)]);
  f.configurations
    .get('local')!
    .onError?.('private vendor error must not escape', {});
  assert.equal(f.duplex.status, 'failed');
  assert.equal(
    f.duplex.appendRemote(pcm(5)),
    false,
    'false means no model upload, not muted original',
  );
  assert.deepEqual(f.originals, [pcm(4), pcm(5)]);
  assert.equal(f.inputs.remote.length, 1);
  assert.deepEqual(
    f.faults.map((value) => value.code),
    ['LIVETRANSLATE_SESSION_FAILED'],
  );
  blocked.resolve();
  await tick();
  f.duplex.end('remote_hangup');
  f.duplex.appendRemote(pcm(6));
  assert.equal(f.originals.length, 2);
});

test('local continued speech and remote interruption never implicitly cancel pending correct English audio', async () => {
  const first = deferred();
  const played: number[] = [];
  let signal: AbortSignal | undefined;
  const f = fixture({
    onEnglishAudio(value, metadata) {
      played.push(value[0]);
      signal = metadata.signal;
      return value[0] === 1 ? first.promise : undefined;
    },
  });
  await f.duplex.ready;
  f.audio(1);
  f.audio(2);
  f.duplex.appendLocal(pcm(7));
  f.duplex.appendRemote(pcm(8));
  assert.deepEqual(played, [1]);
  assert.equal(signal?.aborted, false);
  assert.deepEqual(f.aborts, { local: 0, remote: 0 });
  first.resolve();
  await tick();
  assert.deepEqual(played, [1, 2]);
  assert.deepEqual(f.originals, [pcm(8)]);
  f.duplex.end('manual');
});

test('queue serializes client-normalized delivery sequence, deduplicates event IDs and preserves identical PCM from genuine distinct events', async () => {
  const f = fixture();
  await f.duplex.ready;
  f.audio(2, {}, pcm(9));
  assert.equal(f.english.length, 0);
  f.audio(1, {}, pcm(9));
  await tick();
  f.audio(1, {}, pcm(9));
  f.audio(3, { eventId: 'audio-2' }, pcm(9));
  assert.deepEqual(
    f.english.map((item) => item.metadata.sequence),
    [1, 2],
  );
  assert.deepEqual(
    f.english.map((item) => item.pcm),
    [pcm(9), pcm(9)],
  );
  assert.equal(
    f.inputs.local.length,
    0,
    'generated audio is never appended to the recognizer',
  );
  assert.ok(f.deliveries.every((item) => item.actualPlaybackStartAt === null));
  f.duplex.end('manual');
});

test('backpressure overflow fails only translation, cancels queued audio and never calls an injected hangup operation', async () => {
  const gate = deferred();
  let hangups = 0;
  let activeSignal: AbortSignal | undefined;
  const f = fixture({
    maxQueuedAudioBytes: 4,
    onEnglishAudio(_value, metadata) {
      activeSignal = metadata.signal;
      return gate.promise;
    },
    ...({
      onHangup() {
        hangups += 1;
      },
    } as Partial<LiveTranslateDuplexOptions>),
  });
  await f.duplex.ready;
  f.audio(1);
  f.audio(2);
  f.audio(3);
  assert.equal(f.duplex.status, 'failed');
  assert.equal(f.faults[0].code, 'LIVETRANSLATE_AUDIO_BACKLOG');
  assert.equal(activeSignal?.aborted, true);
  assert.equal(f.duplex.bufferedAudioBytes, 0);
  assert.equal(hangups, 0);
  f.duplex.appendRemote(pcm(8));
  assert.equal(f.originals.length, 1);
  gate.resolve();
  await tick();
  assert.deepEqual(f.aborts, { local: 1, remote: 1 });
});

test('manual end and owner disconnect close both sessions, stop original delivery and fence late audio or text', async () => {
  for (const reason of [
    'manual',
    'owner_disconnect',
    'remote_hangup',
  ] as const) {
    const gate = deferred();
    let sends = 0;
    const f = fixture({
      onEnglishAudio() {
        sends += 1;
        return gate.promise;
      },
    });
    // eslint-disable-next-line no-await-in-loop -- Each termination reason gets its own complete lifecycle.
    await f.duplex.ready;
    f.audio(1);
    f.audio(2);
    f.duplex.end(reason);
    f.duplex.end(reason);
    f.audio(3);
    f.source('local', 'late', '不应显示');
    f.translation('remote', 'late', '不应显示');
    f.duplex.appendRemote(pcm(4));
    gate.resolve();
    // eslint-disable-next-line no-await-in-loop -- Settle this ended owner's late callback before the next fixture.
    await tick();
    assert.equal(sends, 1);
    assert.equal(f.originals.length, 0);
    assert.equal(f.model.snapshot().length, 0);
    assert.deepEqual(f.aborts, { local: 1, remote: 1 });
    assert.equal(f.duplex.status, 'ended');
  }
});

test('reliable role sources form continuous A-B-A blocks while output pairing uses only explicit item edges', async () => {
  const f = fixture();
  await f.duplex.ready;
  f.source('local', 'a1', '我，我想预约。', { at: 100, final: false });
  f.source('local', 'a1', '我，我想预约。', { at: 150, revision: 2 });
  f.source('local', 'a2', '不是五号，是十五号。', { at: 200 });
  f.translation('local', 't1', 'I would like an appointment.', {
    sourceId: 'a1',
    pairing: 'explicit',
  });
  assert.equal(f.blocks().filter((value) => !value.sourceUnassigned).length, 1);
  f.source('remote', 'b1', '刚开', { at: 300 });
  f.source('local', 'a3', 'Please keep the same price.', { at: 400 });
  f.translation('local', 't3', 'Please keep the same price.', { at: 500 });
  assert.deepEqual(
    f
      .blocks()
      .filter((value) => !value.sourceUnassigned)
      .map((value) => value.role),
    ['local', 'remote', 'local'],
  );
  assert.equal(
    f.model.snapshot().find((item) => item.id.endsWith(':a1'))?.original?.text,
    '我，我想预约。',
  );
  const unknown = f.blocks().filter((value) => value.sourceUnassigned);
  assert.equal(unknown.length, 1);
  assert.equal(
    unknown[0].utterances[0].translation?.text,
    'Please keep the same price.',
  );
  assert.equal(unknown[0].utterances[0].original, null);
  assert.ok(
    f.conversation.every((event) => event.sourceRevision === undefined),
  );
  f.duplex.end('manual');
});

test('late direct item association replaces the auxiliary projection without audio replay or guessed original text', async () => {
  const f = fixture();
  await f.duplex.ready;
  f.source('local', 's1', '不是十五元，是五十元。');
  const output = f.translation('local', 't1', 'Not fifteen; fifty.');
  f.audio(1);
  await tick();
  assert.equal(f.blocks().filter((value) => value.sourceUnassigned).length, 1);
  f.translation('local', 't1', output.text, {
    revision: 2,
    sourceId: 's1',
    pairing: 'explicit',
  });
  assert.equal(f.blocks().length, 1);
  assert.equal(f.blocks()[0].utterances[0].translation?.text, output.text);
  assert.equal(
    f.blocks()[0].utterances[0].original?.text,
    '不是十五元，是五十元。',
  );
  assert.equal(f.english.length, 1);
  f.translation('local', 't1', 'stale', {
    revision: 1,
    sourceId: 's1',
    pairing: 'explicit',
  });
  assert.equal(f.blocks()[0].utterances[0].translation?.text, output.text);
  assert.deepEqual(
    f.evidence.map((event) => event.revision),
    [1, 2],
  );
  f.duplex.end('manual');
});

test('one source with multiple translation items retains all versions separately instead of overwriting, appending a possible retranslation or repeating raw', async () => {
  const f = fixture();
  await f.duplex.ready;
  f.source('local', 'source-a', '不是十五美元，是五十美元。');
  f.translation(
    'local',
    'first-output',
    'Not fifteen dollars; fifty dollars.',
    { sourceId: 'source-a', pairing: 'explicit' },
  );
  f.translation(
    'local',
    'different-output',
    'It is fifty dollars, not fifteen.',
    { sourceId: 'source-a', pairing: 'explicit' },
  );
  const rows = f.model.snapshot();
  assert.equal(rows.filter((row) => row.original).length, 1);
  assert.equal(rows.find((row) => row.original)?.translation?.text, '');
  assert.deepEqual(
    rows
      .filter((row) => row.pairing === 'unpaired')
      .map((row) => row.translation?.text),
    [
      'Not fifteen dollars; fifty dollars.',
      'It is fifty dollars, not fifteen.',
    ],
  );
  assert.deepEqual(f.limitations, ['LIVETRANSLATE_MULTIPLE_ITEMS_FOR_SOURCE']);
  assert.ok(
    f.evidence.every(
      (item) => item.sourceId === 'source-a' && item.pairing === 'explicit',
    ),
  );
  f.translation('local', 'first-output', 'Not fifteen dollars; it is fifty.', {
    sourceId: 'source-a',
    pairing: 'explicit',
    revision: 2,
  });
  assert.equal(
    f.model.snapshot().find((row) => row.id.endsWith(':first-output'))
      ?.translation?.text,
    'Not fifteen dollars; it is fifty.',
  );
  assert.equal(f.faults.length, 0);
  f.duplex.end('manual');
});

test('remote translation is captions-only and unexpected remote synthesized audio stops translation without muting English original', async () => {
  const f = fixture();
  await f.duplex.ready;
  f.source('remote', 'r1', 'Do not change the amount.');
  f.translation('remote', 'rt1', '不要更改金额。', {
    sourceId: 'r1',
    pairing: 'explicit',
  });
  assert.equal(f.blocks()[0].utterances[0].translation?.text, '不要更改金额。');
  assert.equal(f.english.length, 0);
  f.audio(1, { role: 'remote', sessionId: 'remote-session' });
  assert.equal(f.faults[0].code, 'LIVETRANSLATE_REMOTE_AUDIO_FORBIDDEN');
  f.duplex.appendRemote(pcm(2));
  assert.deepEqual(f.originals, [pcm(2)]);
  assert.equal(f.english.length, 0);
  f.duplex.end('manual');
});

test('wrong-role and stale-session supplier events cannot change captions, start playback or seize another source', async () => {
  const f = fixture();
  await f.duplex.ready;
  f.source('local', 'x', 'wrong-role', { role: 'remote' });
  f.source('remote', 'y', 'wrong-session', { sessionId: 'retired-session' });
  f.translation('local', 'z', 'stale', { sessionId: 'retired-session' });
  f.audio(1, { sessionId: 'retired-session' });
  assert.equal(f.model.snapshot().length, 0);
  assert.equal(f.english.length, 0);
  assert.equal(f.faults.length, 0);
  f.duplex.end('manual');
});

test('normal finish drains outstanding correct audio once, closes only translation input and preserves original passthrough until real end', async () => {
  const gate = deferred();
  const played: number[] = [];
  const f = fixture({
    onEnglishAudio(value) {
      played.push(value[0]);
      return value[0] === 1 ? gate.promise : undefined;
    },
  });
  await f.duplex.ready;
  f.audio(1);
  f.audio(2);
  const finished = f.duplex.finish();
  await tick();
  assert.equal(f.duplex.status, 'finishing');
  assert.equal(f.duplex.finish(), finished);
  assert.equal(f.duplex.appendLocal(pcm(8)), false);
  f.duplex.appendRemote(pcm(9));
  assert.deepEqual(f.originals, [pcm(9)]);
  gate.resolve();
  await finished;
  assert.equal(f.duplex.status, 'finished');
  assert.deepEqual(played, [1, 2]);
  assert.deepEqual(f.finishes, { local: 1, remote: 1 });
  assert.deepEqual(f.inputs, { local: [], remote: [] });
  f.duplex.end('manual');
});

test('finish reports an unrecoverable local sequence gap and drain timeout rather than replaying, reconnecting or hanging up', async () => {
  const missing = fixture();
  await missing.duplex.ready;
  missing.audio(2);
  await missing.duplex.finish();
  assert.equal(missing.faults[0].code, 'LIVETRANSLATE_AUDIO_ORDER_INVALID');
  assert.equal(missing.english.length, 0);
  assert.equal(missing.configurations.size, 2);
  const timeout = fixture({
    audioDrainTimeoutMs: 5,
    onEnglishAudio() {
      return new Promise(() => {});
    },
  });
  await timeout.duplex.ready;
  timeout.audio(1);
  await timeout.duplex.finish();
  assert.equal(timeout.faults[0].code, 'LIVETRANSLATE_AUDIO_DRAIN_TIMEOUT');
  assert.equal(timeout.duplex.status, 'failed');
  assert.equal(timeout.configurations.size, 2);
  timeout.duplex.appendRemote(pcm(3));
  assert.equal(timeout.originals.length, 1);
  missing.duplex.end('manual');
  timeout.duplex.end('manual');
});

test('translation setup failure and unsupported session voice never silently select a replacement model or end a phone call', async () => {
  let creates = 0;
  let aborts = 0;
  const f = fixture({
    clientFactory(options) {
      creates += 1;
      return {
        ready: Promise.resolve({
          role: options.role,
          sessionId: options.role,
          model: 'qwen3.8-livetranslate-flash-realtime',
          voice: 'another-voice',
          inputSampleRate: 16000,
          outputSampleRate: 24000,
          outputModalities:
            options.role === 'local' ? ['text', 'audio'] : ['text'],
        } as unknown as LiveTranslateSession),
        append() {
          throw new Error('must not append');
        },
        finish: async () => {},
        abort() {
          aborts += 1;
        },
      };
    },
  });
  await assert.rejects(f.duplex.ready, /LIVETRANSLATE_SESSION_FAILED/);
  assert.equal(creates, 2);
  assert.equal(aborts, 2);
  assert.equal(f.duplex.status, 'failed');
  f.duplex.appendRemote(pcm(3));
  assert.equal(f.originals.length, 1);
  assert.equal(f.duplex.appendLocal(pcm(4)), false);
  f.duplex.end('manual');
  assert.equal(aborts, 2);
});

test('a synchronous factory fault aborts the returned resource once and never opens the second session', async () => {
  let creates = 0;
  let aborts = 0;
  const f = fixture({
    clientFactory(options) {
      creates += 1;
      options.onError?.('LIVETRANSLATE_CONNECTION_FAILED', { closeCode: 1006 });
      return {
        ready: Promise.resolve({
          role: options.role,
          sessionId: 'returned-after-fault',
          model: 'qwen3.8-livetranslate-flash-realtime',
          voice: 'Aiden',
          voiceCloneEnabled: false,
          targetLanguage: options.role === 'local' ? 'en' : 'zh',
          configurationAcknowledgement: { eventId: 'fake-ack', receivedAt: 0, basis: 'provider_session_updated' },
          inputSampleRate: 16000,
          outputSampleRate: 24000,
          outputModalities: ['text', 'audio'],
        }),
        append() {
          throw new Error('must not send');
        },
        finish: async () => {},
        abort() {
          aborts += 1;
        },
      };
    },
  });
  await assert.rejects(f.duplex.ready, /LIVETRANSLATE_SESSION_FAILED/);
  assert.equal(creates, 1);
  assert.equal(aborts, 1);
  assert.deepEqual(f.duplex.firstFault, {
    code: 'LIVETRANSLATE_SESSION_FAILED',
    role: 'local',
    providerCode: 'LIVETRANSLATE_CONNECTION_FAILED',
    closeCode: 1006,
    at: f.duplex.firstFault!.at,
  });
  f.duplex.appendRemote(pcm(4));
  assert.deepEqual(f.originals, [pcm(4)]);
  f.duplex.end('manual');
  assert.equal(aborts, 1);
});

test('first concrete allowlisted reason and close code survive later errors, reporting exceptions and manual cleanup', async () => {
  const f = fixture({
    onFault() {
      throw new Error('private reporting failure');
    },
  });
  await f.duplex.ready;
  f.configurations
    .get('remote')!
    .onError?.('LIVETRANSLATE_PROVIDER_REJECTED', { closeCode: 1008 });
  const first = f.duplex.firstFault!;
  assert.equal(first.providerCode, 'LIVETRANSLATE_PROVIDER_REJECTED');
  assert.equal(first.closeCode, 1008);
  first.providerCode = 'mutated external snapshot';
  f.configurations
    .get('local')!
    .onError?.('LIVETRANSLATE_CONNECTION_FAILED', { closeCode: 1006 });
  f.duplex.end('manual');
  assert.equal(
    f.duplex.firstFault!.providerCode,
    'LIVETRANSLATE_PROVIDER_REJECTED',
  );
  assert.equal(f.duplex.firstFault!.closeCode, 1008);
  assert.deepEqual(f.aborts, { local: 1, remote: 1 });
});

test('unknown prefixed error payloads and malformed close codes are never retained as diagnostic metadata', async () => {
  const f = fixture();
  await f.duplex.ready;
  f.configurations
    .get('local')!
    .onError?.('LIVETRANSLATE_CONNECTION_FAILED:secret-transcript-5550000000', {
      closeCode: 9999,
    });
  assert.equal(f.duplex.firstFault!.providerCode, undefined);
  assert.equal(f.duplex.firstFault!.closeCode, undefined);
  assert.equal(JSON.stringify(f.faults).includes('secret-transcript'), false);
  f.duplex.end('manual');
});

test('ending while setup is pending closes both owned clients and late ready or errors cannot revive translation', async () => {
  const pending = {
    local: deferred<LiveTranslateSession>(),
    remote: deferred<LiveTranslateSession>(),
  };
  const captured: LiveTranslateClientOptions[] = [];
  let aborts = 0;
  const f = fixture({
    clientFactory(options) {
      captured.push(options);
      return {
        ready: pending[options.role].promise,
        append() {},
        finish: async () => {},
        abort() {
          aborts += 1;
        },
      };
    },
  });
  f.duplex.end('owner_disconnect');
  for (const options of captured) {
    options.onError?.('LIVETRANSLATE_CONNECTION_FAILED', { closeCode: 1006 });
    pending[options.role].resolve({
      role: options.role,
      sessionId: options.role,
      model: 'qwen3.8-livetranslate-flash-realtime',
      voice: 'Aiden',
      voiceCloneEnabled: false,
      targetLanguage: options.role === 'local' ? 'en' : 'zh',
      configurationAcknowledgement: { eventId: 'fake-ack', receivedAt: 0, basis: 'provider_session_updated' },
      inputSampleRate: 16000,
      outputSampleRate: 24000,
      outputModalities: options.role === 'local' ? ['text', 'audio'] : ['text'],
    });
  }
  await assert.rejects(f.duplex.ready, /LIVETRANSLATE_SESSION_FAILED/);
  assert.equal(aborts, 2);
  assert.equal(captured.length, 2);
  assert.equal(f.duplex.status, 'ended');
  assert.equal(f.duplex.firstFault, undefined);
  assert.equal(f.duplex.appendRemote(pcm(4)), false);
  assert.equal(f.originals.length, 0);
  assert.equal(f.faults.length, 0);
});

test('caption finalization and same-speaker display merging cannot delay English audio entering the independent sink', async () => {
  const f = fixture();
  await f.duplex.ready;
  f.source('local', 'still-speaking', '我想，我想预约', { final: false });
  f.audio(1);
  assert.equal(
    f.english.length,
    1,
    'sink is invoked before any final source or translated text',
  );
  assert.equal(f.model.snapshot()[0].original?.final, false);
  f.source('local', 'next-fragment', '明天下午三点。', {
    final: false,
    at: 300,
  });
  f.audio(2);
  await tick();
  assert.equal(f.english.length, 2);
  assert.equal(f.blocks().length, 1);
  f.duplex.end('manual');
});

test('two role labels cannot disguise one shared supplier session ID', async () => {
  let creates = 0;
  let aborts = 0;
  const f = fixture({
    clientFactory(options) {
      creates += 1;
      return {
        ready: Promise.resolve({
          role: options.role,
          sessionId: 'incorrect-shared-session',
          model: 'qwen3.8-livetranslate-flash-realtime',
          voice: 'Aiden',
          voiceCloneEnabled: false,
          targetLanguage: options.role === 'local' ? 'en' : 'zh',
          configurationAcknowledgement: { eventId: 'fake-ack', receivedAt: 0, basis: 'provider_session_updated' },
          inputSampleRate: 16000,
          outputSampleRate: 24000,
          outputModalities:
            options.role === 'local' ? ['text', 'audio'] : ['text'],
        }),
        append() {
          throw new Error('must not append');
        },
        finish: async () => {},
        abort() {
          aborts += 1;
        },
      };
    },
  });
  await assert.rejects(f.duplex.ready, /LIVETRANSLATE_SESSION_FAILED/);
  assert.equal(creates, 2);
  assert.equal(aborts, 2);
  assert.equal(f.duplex.status, 'failed');
  assert.equal(f.duplex.appendLocal(pcm(1)), false);
  f.duplex.appendRemote(pcm(2));
  assert.equal(f.originals.length, 1);
  f.duplex.end('manual');
  assert.equal(aborts, 2);
});

test('reentrant owner end from translation evidence or queue diagnostics cannot send a late caption or audio frame', async () => {
  let captionOwner: ReturnType<typeof createLiveTranslateDuplex> | undefined;
  const caption = fixture({
    onTranslationEvidence() {
      captionOwner!.end('manual');
    },
  });
  captionOwner = caption.duplex;
  await caption.duplex.ready;
  caption.translation('local', 'stopped-during-callback', 'must not appear');
  assert.equal(caption.conversation.length, 0);
  let audioOwner: ReturnType<typeof createLiveTranslateDuplex> | undefined;
  const audio = fixture({
    onAudioDelivery(event) {
      if (event.stage === 'sink_started') audioOwner!.end('owner_disconnect');
    },
  });
  audioOwner = audio.duplex;
  await audio.duplex.ready;
  audio.audio(1);
  await tick();
  assert.equal(audio.english.length, 0);
  assert.equal(audio.duplex.status, 'ended');
  assert.equal(audio.duplex.firstFault, undefined);
});

test('a healthy duplex has no call-duration, money or test-deadline termination and creates no replacement sessions', async () => {
  let observedAt = 1000;
  const f = fixture({ now: () => observedAt });
  await f.duplex.ready;
  observedAt += 20 * 60 * 1000;
  assert.equal(f.duplex.appendLocal(pcm(2)), true);
  f.audio(1);
  await tick();
  assert.equal(f.duplex.status, 'ready');
  assert.equal(f.english.length, 1);
  assert.equal(f.configurations.size, 2);
  assert.equal(f.faults.length, 0);
  assert.deepEqual(f.aborts, { local: 0, remote: 0 });
  f.duplex.end('manual');
});

test('client-normalized response FIFO keeps each English response tail ahead of the next response under sink backpressure', async () => {
  const gate = deferred();
  const sent: string[] = [];
  const f = fixture({
    onEnglishAudio(_value, metadata) {
      sent.push(`${metadata.responseId}:${metadata.sequence}`);
      return metadata.sequence === 1 ? gate.promise : undefined;
    },
  });
  await f.duplex.ready;
  f.audio(1, { responseId: 'r1', translationId: 't1' });
  f.audio(2, { responseId: 'r1', translationId: 't1' });
  f.audio(3, { responseId: 'r2', translationId: 't2' });
  f.audio(4, { responseId: 'r2', translationId: 't2' });
  f.duplex.appendRemote(pcm(8));
  assert.deepEqual(sent, ['r1:1']);
  assert.equal(f.originals.length, 1);
  gate.resolve();
  await tick();
  assert.deepEqual(sent, ['r1:1', 'r1:2', 'r2:3', 'r2:4']);
  await f.duplex.finish();
  assert.equal(f.duplex.bufferedAudioBytes, 0);
  assert.equal(f.faults.length, 0);
  f.duplex.end('manual');
});

test('real client and duplex together serialize interleaved responses, preserve direct source edges and fence aborted late supplier PCM', async () => {
  class OfflineSocket extends EventEmitter {
    readyState: number = WebSocket.OPEN;

    bufferedAmount = 0;

    sent: Record<string, unknown>[] = [];

    closed = 0;

    send(raw: string, callback?: (error?: Error) => void) {
      this.sent.push(JSON.parse(raw));
      callback?.();
    }

    close() {
      this.closed += 1;
      this.readyState = WebSocket.CLOSED;
    }

    terminate() {
      this.closed += 1;
      this.readyState = WebSocket.CLOSED;
    }
  }
  const sockets = new Map<LiveTranslateRole, OfflineSocket>();
  const delivered: number[] = [];
  const originals: Buffer[] = [];
  const faults: LiveTranslateDuplexFault[] = [];
  const model = createConversationModel('joint-offline');
  const duplex = createLiveTranslateDuplex({
    enabled: true,
    sessionId: 'joint-offline',
    workspaceId: 'offline-workspace',
    apiKey: 'OFFLINE_FAKE_KEY',
    clientFactory(options) {
      const socket = new OfflineSocket();
      sockets.set(options.role, socket);
      return createLiveTranslateClient({
        ...options,
        createWebSocket() {
          return socket as unknown as WebSocket;
        },
      });
    },
    onEnglishAudio(value) {
      delivered.push(value[0]);
    },
    onRemoteOriginal(value) {
      originals.push(value);
    },
    onFault(value) {
      faults.push(value);
    },
    onConversationEvent(value) {
      assert.equal(model.apply(value), true);
    },
  });
  let eventSequence = 0;
  const receive = (role: LiveTranslateRole, event: Record<string, unknown>) => {
    eventSequence += 1;
    sockets
      .get(role)!
      .emit(
        'message',
        Buffer.from(
          JSON.stringify({ event_id: `joint_${eventSequence}`, ...event }),
        ),
        false,
      );
  };
  for (const role of ['local', 'remote'] as const) {
    const session = {
      id: `joint-${role}`,
      model: LIVE_TRANSLATE_MODEL,
      output_modalities: role === 'local' ? ['text', 'audio'] : ['text'],
      enable_voice_clone: false,
      audio: {
        input: {
          format: { type: 'pcm', sample_rate: 16000 },
          turn_detection: { type: 'speaker_detection', threshold: 0.5 },
        },
        output: { format: { type: 'pcm', sample_rate: 24000 }, voice: 'Aiden' },
      },
      translation: { language: role === 'local' ? 'en' : 'zh' },
    };
    receive(role, { type: 'session.created', session });
    receive(role, { type: 'session.updated', session });
  }
  await duplex.ready;
  try {
    receive('local', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 's1',
      content_index: 0,
      transcript: '不是五号，是十五号。',
    });
    receive('local', {
      type: 'conversation.item.created',
      previous_item_id: 's1',
      item: { id: 't1', role: 'assistant', content: [] },
    });
    receive('local', {
      type: 'response.created',
      response: { id: 'r1', status: 'in_progress' },
    });
    receive('local', {
      type: 'response.created',
      response: { id: 'r2', status: 'in_progress' },
    });
    const audio = (id: string, response: string, value: number) =>
      receive('local', {
        type: 'response.audio.delta',
        item_id: id,
        response_id: response,
        output_index: 0,
        content_index: 0,
        delta: pcm(value).toString('base64'),
      });
    audio('t1', 'r1', 1);
    audio('t2', 'r2', 2);
    audio('t1', 'r1', 3);
    receive('local', {
      type: 'response.audio_transcript.delta',
      item_id: 't1',
      response_id: 'r1',
      output_index: 0,
      content_index: 0,
      delta: 'Not the fifth; the fifteenth.',
    });
    assert.equal(duplex.appendRemote(pcm(9)), true);
    assert.deepEqual(originals, [pcm(9)]);
    await tick();
    assert.deepEqual(
      delivered,
      [1, 3],
      'second response must wait for the first response tail',
    );
    receive('local', {
      type: 'response.audio.done',
      item_id: 't1',
      response_id: 'r1',
      output_index: 0,
      content_index: 0,
    });
    await tick();
    assert.deepEqual(delivered, [1, 3, 2]);
    assert.equal(
      model.snapshot().find((row) => row.original)?.original?.text,
      '不是五号，是十五号。',
    );
    assert.equal(
      model.snapshot().find((row) => row.original)?.translation?.text,
      'Not the fifth; the fifteenth.',
    );
    duplex.end('owner_disconnect');
    audio('t2', 'r2', 4);
    await tick();
    assert.deepEqual(delivered, [1, 3, 2]);
    assert.equal(sockets.size, 2);
    assert.deepEqual(faults, []);
    assert.ok([...sockets.values()].every((socket) => socket.closed === 1));
    assert.ok(
      [...sockets.values()].every((socket) =>
        socket.sent.every((event) => event.type !== 'response.cancel'),
      ),
    );
  } finally {
    duplex.end('owner_disconnect');
  }
});
