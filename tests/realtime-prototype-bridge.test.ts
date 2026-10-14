/* eslint-disable max-classes-per-file -- Two small transports describe the offline bridge boundary. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import WebSocket from 'ws';

import {
  ContinuousTranslationBridge,
  type ContinuousTranslationBridgeOptions,
} from '../src/solo/continuous-translation-bridge';
import {
  createRealtimePrototypeBridge,
  type RealtimePrototypeSelection,
} from '../src/solo/realtime-prototype';
import type {
  RealtimePrototypeClient,
  RealtimePrototypeClientOptions,
  RealtimePrototypeAudioMetadata,
  RealtimePrototypeSourceCorrection,
  RealtimePrototypeTranscriptEvent,
} from '../src/solo/realtime-prototype-client';
import type { RemoteCaptionOptions } from '../src/solo/remote-caption-client';
import { Pcm24kToPcmu } from '../src/solo/translation-pcm';
import type {
  TranscriptEvent,
  TranslationAudioDiagnostic,
  UtterancePlaybackEvent,
} from '../src/solo/translation-bridge';

class Phone extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  sent: any[] = [];

  writes: Array<() => void> = [];

  deferWrites = false;

  send(raw: string, callback: () => void) {
    this.sent.push(JSON.parse(raw));
    if (this.deferWrites) this.writes.push(callback);
    else callback?.();
  }

  receive(event: object) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }

  terminate() {
    if (this.readyState !== WebSocket.CLOSED) {
      this.readyState = WebSocket.CLOSED;
      this.emit('close');
    }
  }

  socket() {
    return this as unknown as WebSocket;
  }

  media() {
    return this.sent.filter((event) => event.event === 'media');
  }

  acknowledge() {
    for (const event of this.sent.filter((item) => item.event === 'mark'))
      this.receive(event);
  }

  flush() {
    this.writes.splice(0).forEach((write) => write());
  }
}
class Client implements RealtimePrototypeClient {
  ready = Promise.resolve();

  appended: Buffer[] = [];

  acknowledgements: Array<[number, string]> = [];

  aborted = 0;

  epoch = 1;

  onAbort?: () => void;

  nextSequence = 0;

  identities = new Map<
    string,
    { epoch: number; sequence: number; at: number }
  >();

  commit(id: string, at = 1000) {
    this.nextSequence += 1;
    this.identities.set(id, {
      epoch: this.epoch,
      sequence: this.nextSequence,
      at,
    });
    this.options.onEvidence?.({
      type: 'source_committed',
      epoch: this.epoch,
      sourceSequence: this.nextSequence,
    });
    return this.nextSequence;
  }

  constructor(readonly options: RealtimePrototypeClientOptions) {}

  append(pcm: Buffer) {
    this.appended.push(Buffer.from(pcm));
  }

  async finish() {
    // This offline stub has no asynchronous work to drain.
  }

  abort() {
    this.aborted += 1;
    this.onAbort?.();
  }

  async reconnect() {
    this.epoch += 1;
    this.nextSequence = 0;
  }

  acknowledgeAudio(epoch: number, id: string) {
    this.acknowledgements.push([epoch, id]);
    return true;
  }

  withdraw() {
    return false;
  }

  source(id = 'source', text = '不是十五，是五十。', at = 1000, revision = 1) {
    if (!this.identities.has(id)) this.commit(id, at);
    const identity = this.identities.get(id)!;
    const event: RealtimePrototypeTranscriptEvent = {
      inputEpoch: identity.epoch,
      sourceSequence: identity.sequence,
      id: `${id}:original`,
      utteranceId: id,
      role: 'local',
      kind: 'original',
      text,
      final: true,
      at,
      sourceEndAt: at + 100,
      sourceRevision: revision,
      pairing: 'explicit',
      boundary: 'utterance',
    };
    this.options.onConversationTranscript(event);
    return event;
  }

  translation(id = 'source', final = true, sourceRevision = 1) {
    this.options.onConversationTranscript({
      id: `${id}:translation`,
      utteranceId: id,
      role: 'local',
      kind: 'translation',
      inputEpoch: this.identities.get(id)?.epoch ?? this.epoch,
      sourceSequence: this.identities.get(id)?.sequence ?? 1,
      text: 'Not fifteen, fifty.',
      final,
      at: this.identities.get(id)?.at ?? 1000,
      sourceRevision,
      pairing: 'explicit',
      boundary: 'utterance',
    });
  }

  metadata(id = 'source'): RealtimePrototypeAudioMetadata {
    return {
      utteranceId: id,
      responseId: `response_${id}`,
      epoch: this.epoch,
      sourceSequence: this.identities.get(id)?.sequence ?? 1,
    };
  }

  audio(id = 'source', pcm = Buffer.alloc(960), metadata = this.metadata(id)) {
    this.options.onAudio(pcm, metadata);
  }

  complete(id = 'source') {
    this.options.onAudioComplete?.(this.metadata(id));
  }
}
function fixture(
  t: TestContext,
  overrides: Partial<ContinuousTranslationBridgeOptions> = {},
  selection: RealtimePrototypeSelection = { enabled: true, voice: 'echo' },
) {
  const phones = { local: new Phone(), remote: new Phone() };
  const clients: Client[] = [];
  const transcripts: TranscriptEvent[] = [];
  const legacy: TranscriptEvent[] = [];
  const audio: TranslationAudioDiagnostic[] = [];
  const playback: UtterancePlaybackEvent[] = [];
  const failures: string[] = [];
  let captions!: RemoteCaptionOptions;
  let captionBreaks = 0;
  let nativeCreates = 0;
  let sockets = 0;
  const captionAudio: Buffer[] = [];
  const options: ContinuousTranslationBridgeOptions = {
    apiKey: 'offline-fake',
    model: 'gpt-realtime-1.5',
    remoteCaptions: true,
    now: () => 10000,
    onTranscript: (event) => legacy.push(event),
    onConversationTranscript: (event) => transcripts.push(event),
    onFailure: (reason) => failures.push(reason),
    onAudioDiagnostic: (event) => audio.push(event),
    onUtterancePlayback: (event) => playback.push(event),
    createWebSocket() {
      sockets += 1;
      return new Phone().socket();
    },
    createClient() {
      nativeCreates += 1;
      return {
        ready: Promise.resolve(),
        append() {},
        async finish() {
          // This offline stub has no asynchronous work to drain.
        },
        abort() {},
      };
    },
    createCaptionClient(settings) {
      captions = settings;
      return {
        ready: Promise.resolve(),
        append(pcm) {
          captionAudio.push(Buffer.from(pcm));
        },
        async finish() {
          // This offline stub has no asynchronous work to drain.
        },
        abort() {},
        breakSection() {
          captionBreaks += 1;
        },
      };
    },
    ...overrides,
  };
  const bridge = createRealtimePrototypeBridge(options, {
    createClient: (settings) => {
      const client = new Client(settings);
      clients.push(client);
      return client;
    },
    ...selection,
  });
  t.after(() => bridge.close());
  const attach = async () => {
    bridge.attach('local', phones.local.socket(), 'MZ_local');
    bridge.attach('remote', phones.remote.socket(), 'MZ_remote');
    await tick();
  };
  const media = (role: 'local' | 'remote', pcm = Buffer.alloc(160, 0xff)) =>
    phones[role].receive({
      event: 'media',
      streamSid: `MZ_${role}`,
      media: { track: 'inbound', payload: pcm.toString('base64') },
    });
  return {
    bridge,
    phones,
    clients,
    transcripts,
    legacy,
    audio,
    playback,
    failures,
    captionAudio,
    options,
    attach,
    media,
    get captions() {
      return captions;
    },
    get breaks() {
      return captionBreaks;
    },
    counts: () => ({ nativeCreates, sockets, regular: clients.length }),
  };
}

test('default and explicit disabled selections retain the original native bridge without constructing a regular client', async (t) => {
  const f = fixture(t, {}, {});
  assert.ok(f.bridge instanceof ContinuousTranslationBridge);
  assert.deepEqual(f.counts(), { nativeCreates: 0, sockets: 0, regular: 0 });
  await f.attach();
  assert.deepEqual(f.counts(), { nativeCreates: 1, sockets: 0, regular: 0 });
  const disabled = fixture(t, {}, { enabled: false });
  await disabled.attach();
  assert.equal(disabled.counts().regular, 0);
  assert.equal(disabled.counts().nativeCreates, 1);
});
test('enabled selection rejects missing voice, unsupported voice, absent explicit sockets and conflicting speech routes before construction', (t) => {
  for (const selection of [
    { enabled: true },
    { enabled: true, voice: 'not-a-built-in' },
    { enabled: 'true', voice: 'echo' },
  ])
    assert.throws(
      () => fixture(t, {}, selection as RealtimePrototypeSelection),
      /INVALID_REALTIME_PROTOTYPE_SELECTION/,
    );
  for (const overrides of [
    { createWebSocket: undefined },
    { outgoingCaptions: true },
    { outgoingPrefixes: true },
    { remoteCaptions: false },
  ])
    assert.throws(
      () => fixture(t, overrides, { enabled: true, voice: 'echo' }),
      /INVALID_REALTIME_PROTOTYPE_SELECTION/,
    );
});
test('only the local regular client is built and remote original bypasses its output queue', async (t) => {
  const f = fixture(t);
  await f.attach();
  const client = f.clients[0];
  assert.equal(client.options.voice, 'echo');
  assert.equal(f.counts().nativeCreates, 0);
  client.source();
  client.translation();
  client.audio('source', Buffer.alloc(192000));
  const original = Buffer.from(Array.from({ length: 160 }, (_, i) => i));
  f.media('remote', original);
  assert.equal(
    f.phones.local.media().at(-1).media.payload,
    original.toString('base64'),
  );
  f.media('local');
  f.media('local');
  assert.equal(client.appended.length, 2);
  assert.equal(client.aborted, 0);
  assert.equal(f.breaks, 1);
  assert.ok(f.captionAudio.length > 0);
  assert.equal(
    f.phones.remote.sent.some((event) => event.event === 'clear'),
    false,
  );
});
test('the same raw-only per-call context feeds the regular client and remote captions, then clears on close and across calls', async (t) => {
  const f = fixture(t);
  await f.attach();
  const client = f.clients[0];
  client.source();
  client.translation();
  assert.equal(
    f.captions.getContext!({ role: 'remote', at: 11000 }).entries[0].text,
    '不是十五，是五十。',
  );
  f.captions.onTranscript({
    id: 'remote:original:prior:0',
    utteranceId: 'remote:prior:0',
    role: 'remote',
    kind: 'original',
    text: 'Please keep the date.',
    final: true,
    at: 2000,
    sourceEndAt: 2500,
    sourceRevision: 1,
  });
  assert.deepEqual(
    client.options.getContext!({ at: 11000 }).entries.map((entry) => [
      entry.role,
      entry.text,
      entry.generated,
    ]),
    [
      ['local', '不是十五，是五十。', false],
      ['remote', 'Please keep the date.', false],
    ],
  );
  f.bridge.close();
  assert.deepEqual(client.options.getContext!({ at: 12000 }).entries, []);
  assert.deepEqual(
    f.captions.getContext!({ role: 'remote', at: 12000 }).entries,
    [],
  );
  const next = fixture(t);
  await next.attach();
  assert.deepEqual(
    next.clients[0].options.getContext!({ at: 12000 }).entries,
    [],
  );
});
test('regular text keeps exact source pairing while normal marks require producer seal and all transport writes', async (t) => {
  const f = fixture(t);
  await f.attach();
  const client = f.clients[0];
  client.source();
  client.translation('source', false);
  f.phones.remote.deferWrites = true;
  client.audio();
  f.phones.remote.acknowledge();
  client.translation();
  client.complete();
  assert.equal(client.acknowledgements.length, 0);
  assert.equal(f.playback.at(-1)?.sealed, true);
  assert.equal(
    f.playback.at(-1)?.expectedDeliveryCount,
    f.audio.filter((event) => event.stage === 'generated').length,
  );
  f.phones.remote.flush();
  assert.deepEqual(client.acknowledgements, [[1, 'response_source']]);
  f.phones.remote.acknowledge();
  assert.equal(client.acknowledgements.length, 1);
  assert.equal(f.legacy.length, 0);
  assert.equal(f.transcripts.length, 3);
  assert.ok(f.audio.every((event) => event.utteranceId === 'source'));
});
test('normal marks before response completion do not acknowledge an unfinished response', async (t) => {
  const f = fixture(t);
  await f.attach();
  const client = f.clients[0];
  client.source();
  client.audio();
  f.phones.remote.acknowledge();
  assert.equal(client.acknowledgements.length, 0);
  client.translation();
  client.complete();
  assert.equal(client.acknowledgements.length, 1);
});
test('unknown audio source fails both legs without native fallback or translated media', async (t) => {
  const f = fixture(t);
  await f.attach();
  f.clients[0].audio();
  assert.deepEqual(f.failures, ['continuous_provider_failed:local']);
  assert.equal(f.phones.remote.media().length, 0);
  assert.equal(f.phones.local.readyState, WebSocket.CLOSED);
  assert.equal(f.phones.remote.readyState, WebSocket.CLOSED);
  assert.equal(f.counts().nativeCreates, 0);
});
test('a translated source revision mismatch is rejected instead of pairing by role or text', async (t) => {
  const f = fixture(t);
  await f.attach();
  f.clients[0].source();
  f.clients[0].translation('source', true, 2);
  assert.equal(f.failures.length, 1);
  assert.equal(f.transcripts.length, 1);
  assert.equal(f.phones.remote.media().length, 0);
});
test('source correction retains the paired snapshot and updates bounded raw context through the dedicated callback', async (t) => {
  const corrections: RealtimePrototypeSourceCorrection[] = [];
  const f = fixture(
    t,
    {},
    {
      enabled: true,
      voice: 'echo',
      onSourceCorrection: (event) => corrections.push(event),
    },
  );
  await f.attach();
  const client = f.clients[0];
  client.source();
  client.translation();
  client.audio();
  const corrected = {
    utteranceId: 'source',
    epoch: 1,
    sourceSequence: 1,
    sourceRevision: 1,
    correctionRevision: 2,
    rawText: '不是五十，是十五。',
    at: 1000,
    reason: 'revised' as const,
    audioExposed: true,
  };
  client.options.onSourceCorrection!(corrected);
  assert.equal(f.transcripts[0].text, '不是十五，是五十。');
  assert.equal(f.transcripts[1].text, 'Not fifteen, fifty.');
  assert.deepEqual(corrections, [corrected]);
  assert.equal(
    f.captions.getContext!({ role: 'remote', at: 11000 }).entries[0].text,
    corrected.rawText,
  );
});
test('a synchronous transcript subscriber hangup fences abort callbacks and every later audio/text result', async (t) => {
  let close = () => {};
  const received: TranscriptEvent[] = [];
  const f = fixture(t, {
    onConversationTranscript: (event) => {
      received.push(event);
      close();
    },
  });
  close = () => f.bridge.close();
  await f.attach();
  const client = f.clients[0];
  client.onAbort = () => client.source('late');
  client.source();
  client.audio();
  client.translation();
  assert.equal(received.length, 1);
  assert.equal(f.phones.remote.media().length, 0);
  assert.equal(client.aborted, 1);
});
test('a queued playback subscriber may synchronously close without allowing a single translated byte', async (t) => {
  let close = () => {};
  const f = fixture(t, {
    onUtterancePlayback: (event) => {
      if (event.status === 'queued') close();
    },
  });
  close = () => f.bridge.close();
  await f.attach();
  f.clients[0].source();
  f.clients[0].audio();
  assert.equal(f.phones.remote.media().length, 0);
  assert.equal(f.clients[0].acknowledgements.length, 0);
});
test('a generated diagnostic subscriber may synchronously close before media or mark is sent', async (t) => {
  let close = () => {};
  const f = fixture(t, {
    onAudioDiagnostic: (event) => {
      if (event.stage === 'generated') close();
    },
  });
  close = () => f.bridge.close();
  await f.attach();
  f.clients[0].source();
  f.clients[0].audio();
  assert.equal(f.phones.remote.media().length, 0);
  assert.equal(f.clients[0].acknowledgements.length, 0);
});
test('synchronous output admission revocation closes both legs before translated media, while old mark callbacks remain unconfirmed', async (t) => {
  let close = () => {};
  const f = fixture(t, {
    admitAudio: (event) => {
      if (event.stage === 'output' && event.role === 'local') close();
      return true;
    },
  });
  close = () => f.bridge.close();
  await f.attach();
  f.clients[0].source();
  f.clients[0].audio();
  assert.equal(f.phones.remote.media().length, 0);
  assert.equal(f.clients[0].acknowledgements.length, 0);
});
test('hangup clear and late pending marks never become playback acknowledgements or revive a closed response', async (t) => {
  const f = fixture(t);
  await f.attach();
  const client = f.clients[0];
  client.source();
  client.translation();
  client.audio();
  client.complete();
  f.bridge.close();
  assert.ok(f.audio.some((event) => event.stage === 'unconfirmed'));
  assert.ok(f.phones.remote.sent.some((event) => event.event === 'clear'));
  f.phones.remote.acknowledge();
  client.audio();
  client.complete();
  assert.equal(client.acknowledgements.length, 0);
  assert.equal(f.phones.remote.media().length, 1);
});
test('a new regular session epoch resets real output FIR history without altering native continuous resampling', async (t) => {
  const impulse = Buffer.alloc(240);
  impulse.writeInt16LE(30000, 238);
  const zero = Buffer.alloc(480);
  const unreset = new Pcm24kToPcmu();
  unreset.push(impulse);
  assert.ok(
    [...unreset.push(zero)].some((byte) => byte !== 0xff),
    'this actual filter carries a prior impulse without reset',
  );
  const f = fixture(t);
  await f.attach();
  const client = f.clients[0];
  client.source('one');
  client.translation('one');
  client.audio('one', impulse);
  client.complete('one');
  f.phones.remote.acknowledge();
  assert.equal(client.acknowledgements.length, 1);
  await client.reconnect();
  client.source('two', '新的原文。', 2000);
  const before = f.phones.remote.media().length;
  client.audio('two', zero);
  const fresh = f.phones.remote
    .media()
    .slice(before)
    .map((event) => Buffer.from(event.media.payload, 'base64'));
  assert.deepEqual(Buffer.concat(fresh), new Pcm24kToPcmu().push(zero));
  const after = f.phones.remote.media().length;
  client.options.onAudio(impulse, {
    utteranceId: 'one',
    responseId: 'response_one',
    epoch: 1,
    sourceSequence: 1,
  });
  assert.equal(
    f.phones.remote.media().length,
    after,
    'old epoch never resets or contaminates the new codec',
  );
});
test('a newer epoch cannot cross an unacknowledged old response', async (t) => {
  const f = fixture(t);
  await f.attach();
  const client = f.clients[0];
  client.source('one');
  client.audio('one');
  client.source('two', '第二段。', 2000);
  client.options.onAudio(Buffer.alloc(960), {
    utteranceId: 'two',
    responseId: 'response_two',
    epoch: 2,
    sourceSequence: 2,
  });
  assert.equal(f.failures.length, 1);
  assert.equal(f.phones.remote.media().length, 1);
});

test('completed acknowledged sources roll beyond 1024 while retired callbacks cannot replay audio or raw', async (t) => {
  const counts: Array<{
    sources: number;
    responses: number;
    pendingSources: number;
  }> = [];
  const f = fixture(
    t,
    {},
    {
      enabled: true,
      voice: 'echo',
      onRetention: (event) => counts.push(event),
    },
  );
  await f.attach();
  const client = f.clients[0];
  let first!: RealtimePrototypeTranscriptEvent;
  for (let index = 0; index < 1100; index += 1) {
    const id = `turn_${index}`;
    const source = client.source(id, `原文${index}`, 1000 + index);
    if (!index) first = source;
    client.translation(id);
    client.audio(id);
    client.complete(id);
    f.phones.remote.acknowledge();
    // The fake remote keeps only the current transport frame history.
    f.phones.remote.sent.length = 0;
  }
  assert.equal(client.acknowledgements.length, 1100);
  assert.deepEqual(f.failures, []);
  assert.ok(
    counts.every(
      (event) =>
        event.sources <= 1024 &&
        event.responses <= 1024 &&
        event.pendingSources <= 1024,
    ),
  );
  assert.equal(counts.at(-1)?.sources, 1024);
  const received = f.transcripts.length;
  client.options.onConversationTranscript(first);
  client.options.onAudio(Buffer.alloc(960), {
    utteranceId: first.utteranceId!,
    responseId: 'response_turn_0',
    epoch: 1,
    sourceSequence: 1,
  });
  client.options.onSourceCorrection?.({
    utteranceId: first.utteranceId!,
    epoch: 1,
    sourceSequence: 1,
    sourceRevision: 1,
    correctionRevision: 2,
    rawText: '古老更正不可复活',
    at: first.at,
    reason: 'revised',
    audioExposed: true,
  });
  assert.equal(f.transcripts.length, received);
  assert.equal(f.phones.remote.media().length, 0);
  assert.deepEqual(f.failures, []);
  // A recently retained snapshot still permits a separate future-context correction.
  client.options.onSourceCorrection?.({
    utteranceId: 'turn_1099',
    epoch: 1,
    sourceSequence: 1100,
    sourceRevision: 1,
    correctionRevision: 2,
    rawText: '最近更正',
    at: 2099,
    reason: 'revised',
    audioExposed: true,
  });
  assert.ok(
    f.captions.getContext!({ role: 'remote', at: 11000 }).entries.some(
      (entry) => entry.text === '最近更正',
    ),
  );
});
test('later empty finals retire without a count gate while an earlier committed ASR remains admissible out of order', async (t) => {
  const f = fixture(t);
  await f.attach();
  const client = f.clients[0];
  client.commit('slow', 1000);
  for (let index = 0; index < 1100; index += 1)
    client.source(`empty_${index}`, index % 2 ? '' : '。', 2000 + index);
  client.source('slow', '先说但识别较迟', 1000);
  client.translation('slow');
  client.audio('slow');
  client.complete('slow');
  f.phones.remote.acknowledge();
  assert.equal(client.acknowledgements.length, 1);
  assert.ok(
    f.transcripts.some(
      (event) => event.utteranceId === 'slow' && event.kind === 'original',
    ),
  );
  assert.deepEqual(f.failures, []);
});
test('fractional source sample-end metadata does not prevent shared raw context observation', async (t) => {
  const f = fixture(t);
  await f.attach();
  const client = f.clients[0];
  client.commit('fraction');
  const event = {
    id: 'fraction:original',
    utteranceId: 'fraction',
    role: 'local' as const,
    kind: 'original' as const,
    text: '短原文',
    final: true,
    at: 1000,
    sourceEndAt: 1000 + 1 / 24,
    sourceRevision: 1,
    inputEpoch: 1,
    sourceSequence: 1,
    pairing: 'explicit' as const,
  };
  client.options.onConversationTranscript(event);
  assert.equal(
    f.captions.getContext!({ role: 'remote', at: 11000 }).entries[0].text,
    '短原文',
  );
  assert.deepEqual(f.failures, []);
});

test('remote original remains byte exact while the local regular readiness promise is unresolved', async (t) => {
  let client!: Client;
  const f = fixture(
    t,
    {},
    {
      enabled: true,
      voice: 'echo',
      createClient: (settings) => {
        client = new Client(settings);
        client.ready = new Promise<void>(() => {});
        return client;
      },
    },
  );
  await f.attach();
  const original = Buffer.from(
    Array.from({ length: 160 }, (_, index) => index),
  );
  f.media('remote', original);
  assert.equal(
    f.phones.local.media().at(-1).media.payload,
    original.toString('base64'),
  );
  assert.equal(client.aborted, 0);
  assert.deepEqual(f.failures, []);
});
test('explicit no-audio withdrawals retire their source evidence without becoming a lifetime count cap', async (t) => {
  const f = fixture(t);
  await f.attach();
  const client = f.clients[0];
  for (let index = 0; index < 1100; index += 1) {
    client.source(`withdraw_${index}`, '本段撤销', 1000 + index);
    client.options.onEvidence?.({
      type: 'withdrawn',
      epoch: 1,
      sourceSequence: index + 1,
    });
  }
  client.audio('withdraw_1099');
  client.complete('withdraw_1099');
  assert.equal(f.phones.remote.media().length, 0);
  assert.deepEqual(f.failures, []);
  client.source('next', '继续有效原文', 3000);
  client.translation('next');
  client.audio('next');
  client.complete('next');
  f.phones.remote.acknowledge();
  assert.equal(client.acknowledgements.length, 1);
  assert.deepEqual(f.failures, []);
});

test('a recent initially empty final accepts separate late raw correction for shared future context without reopening its audio snapshot', async (t) => {
  const corrections: RealtimePrototypeSourceCorrection[] = [];
  const f = fixture(
    t,
    {},
    {
      enabled: true,
      voice: 'echo',
      onSourceCorrection: (event) => corrections.push(event),
    },
  );
  await f.attach();
  const client = f.clients[0];
  client.source('empty', '', 1000);
  const correction: RealtimePrototypeSourceCorrection = {
    utteranceId: 'empty',
    epoch: 1,
    sourceSequence: 1,
    sourceRevision: 1,
    correctionRevision: 2,
    rawText: '后来确认的原文',
    at: 1000,
    reason: 'revised',
    audioExposed: false,
  };
  client.options.onSourceCorrection?.(correction);
  assert.deepEqual(corrections, [correction]);
  assert.equal(
    f.captions.getContext!({ role: 'remote', at: 11000 }).entries[0].text,
    correction.rawText,
  );
  assert.equal(f.transcripts[0].text, '');
  assert.equal(f.transcripts.length, 1);
  assert.equal(f.phones.remote.media().length, 0);
  assert.deepEqual(f.failures, []);
});
