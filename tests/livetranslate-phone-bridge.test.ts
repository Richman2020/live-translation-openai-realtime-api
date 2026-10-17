/* eslint-disable no-await-in-loop -- Every offline phone fixture owns separate fake sessions. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';

import { createLiveTranslatePhoneBridge } from '../src/solo/livetranslate-phone-bridge';
import type { LiveTranslatePhoneConfig } from '../src/solo/livetranslate-phone-config';
import type {
  LiveTranslateClientOptions,
  LiveTranslateSession,
} from '../src/experiments/livetranslate-types';
import { Pcm24kToPcmu, PcmuToPcm16k } from '../src/solo/translation-pcm';
import { ConversationEventAdapter } from '../src/solo/conversation-events';
import { createConversationModel } from '../public/conversation-model.js';
import { sendDiagnosticFixture } from './fixtures/livetranslate-send-diagnostic';

const config: LiveTranslatePhoneConfig = {
  region: 'beijing',
  workspaceId: 'offline-space',
  apiKey: 'SYNTHETIC_NONCREDENTIAL',
  model: 'qwen3.8-livetranslate-flash-realtime',
  voice: 'Andre',
};
class Phone extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  sent: any[] = [];

  terminated = 0;

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

  receive(event: unknown) {
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

  ack() {
    for (const event of this.sent.filter((value) => value.event === 'mark'))
      this.receive(event);
  }

  terminate() {
    if (this.readyState !== WebSocket.CLOSED) {
      this.terminated += 1;
      this.readyState = WebSocket.CLOSED;
      this.emit('close');
    }
  }

  socket() {
    return this as unknown as WebSocket;
  }

  audio() {
    return Buffer.concat(
      this.sent
        .filter((event) => event.event === 'media')
        .map((event) => Buffer.from(event.media.payload, 'base64')),
    );
  }
}
function session(
  role: 'local' | 'remote',
  conflict = false,
): LiveTranslateSession {
  const voice = role === 'local' ? 'Andre' : 'Tina';
  const sid = `session_${role}`;
  const top = {
    status: 'reported',
    value: voice,
    actualType: 'string',
  } as const;
  const nested = {
    status: 'reported',
    value: conflict ? 'Tina' : voice,
    actualType: 'string',
  } as const;
  return {
    role,
    sessionId: sid,
    model: config.model,
    voice: nested.value,
    requestedVoice: voice,
    topLevelVoice: voice,
    sessionOutputVoiceEcho: nested,
    voiceCloneEnabled: false,
    voiceCloneConfirmation: 'explicit_false',
    voiceConfirmation: conflict
      ? 'approved_top_level_andre_nested_tina'
      : 'exact_match',
    voicePolicy: {
      mode: conflict
        ? 'approved_andre_tina_metadata_conflict'
        : 'strict_requested_voice',
      requestedVoice: voice,
      responseVoiceAllowlist: conflict ? ['Andre', 'Tina'] : [voice],
      acknowledgement: {
        sessionId: sid,
        eventId: 'ack',
        receiveSequence: 2,
        receivedAt: 1000,
        sessionTopLevelEcho: top,
        sessionNestedEcho: nested,
      },
      acousticVoice: 'unknown_not_measured',
    },
    targetLanguage: role === 'local' ? 'en' : 'zh',
    configurationAcknowledgement: {
      eventId: 'ack',
      receiveSequence: 2,
      receivedAt: 1000,
      basis: 'provider_session_updated',
    },
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    outputModalities: role === 'local' ? ['text', 'audio'] : ['text'],
  };
}
function fixture() {
  const phones = {
    local: new Phone('MZ_local'),
    remote: new Phone('MZ_remote'),
  };
  const supplied = new Map<string, LiveTranslateClientOptions>();
  const appended = { local: [] as Buffer[], remote: [] as Buffer[] };
  const resolves: Record<string, (value: LiveTranslateSession) => void> = {};
  const aborted = { local: 0, remote: 0 };
  const failures: string[] = [];
  const captions: any[] = [];
  const diagnostics: any[] = [];
  const transcripts: any[] = [];
  const audio: any[] = [];
  const admissions: any[] = [];
  const adapter = new ConversationEventAdapter('synthetic-call', () => 1000);
  const model = createConversationModel({ sessionId: 'synthetic-call' });
  const bridge = createLiveTranslatePhoneBridge(
    {
      apiKey: 'unused-openai-key',
      model: 'unused-model',
      now: () => 1000,
      onTranscript(event) {
        transcripts.push(event);
        const accepted = adapter.transcript(event);
        if (accepted) model.apply(accepted);
        for (const update of adapter.takeTurnUpdates()) model.apply(update);
      },
      onFailure: (code) => failures.push(code),
      onCaptionState: (event) => captions.push(event),
      onAudioDiagnostic: (event) => audio.push(event),
      admitAudio: (event) => {
        admissions.push(event);
        return true;
      },
    },
    {
      config,
      onDiagnostic: (event) => diagnostics.push(event),
      deps: {
        createClient: (options) => {
          supplied.set(options.role, options);
          return {
            ready: new Promise<LiveTranslateSession>((resolve) => {
              resolves[options.role] = resolve;
            }),
            append: (pcm) => appended[options.role].push(Buffer.from(pcm)),
            async finish() {
              /* Synthetic supplier has no tail. */
            },
            abort() {
              aborted[options.role] += 1;
            },
          };
        },
      },
    },
  );
  const attach = (role: 'local' | 'remote') =>
    bridge.attach(role, phones[role].socket(), phones[role].streamSid);
  const ready = async (
    role: 'local' | 'remote',
    replacement = session(role),
  ) => {
    resolves[role](replacement);
    await tick();
  };
  const pair = async () => {
    attach('local');
    await ready('local');
    attach('remote');
    await ready('remote');
  };
  const source = (
    role: 'local' | 'remote',
    id: string,
    text: string,
    revision = 1,
    final = true,
  ) =>
    supplied.get(role)!.onSource!({
      role,
      sessionId: `session_${role}`,
      sourceId: id,
      text,
      revision,
      final,
      at: 1000,
    });
  const translation = (
    role: 'local' | 'remote',
    id: string,
    rawId: string | undefined,
    text: string,
    revision = 1,
    final = true,
  ) =>
    supplied.get(role)!.onTranslation!({
      role,
      sessionId: `session_${role}`,
      translationId: id,
      responseId: `response_${id}`,
      ...(rawId ? { sourceId: rawId } : {}),
      pairing: rawId ? 'explicit' : 'unpaired',
      text,
      revision,
      final,
      at: 1000,
    });
  let sequence = 0;
  const pcm = (
    id: string,
    data = Buffer.alloc(9600, 1),
    chosenSequence?: number,
  ) => {
    const options = supplied.get('local')!;
    sequence = chosenSequence ?? sequence + 1;
    options.onTiming!({
      role: 'local',
      sessionId: 'session_local',
      responseId: `response_${id}`,
      stage: 'audio_first_sample',
      at: 1000,
    });
    options.onAudio!(data, {
      role: 'local',
      sessionId: 'session_local',
      translationId: id,
      responseId: `response_${id}`,
      eventId: `event_${sequence}`,
      pairing: 'unpaired',
      sequence,
    });
  };
  const complete = (id: string) =>
    supplied.get('local')!.onTiming!({
      role: 'local',
      sessionId: 'session_local',
      responseId: `response_${id}`,
      stage: 'response_completed',
      at: 1000,
    });
  return {
    bridge,
    phones,
    supplied,
    appended,
    aborted,
    failures,
    captions,
    diagnostics,
    transcripts,
    audio,
    admissions,
    model,
    attach,
    ready,
    pair,
    source,
    translation,
    pcm,
    complete,
  };
}

test('fixed Andre local and strict Tina text-only remote use separate phone sessions, never an audition runner', async () => {
  const h = fixture();
  h.attach('local');
  assert.equal(h.supplied.size, 1);
  assert.equal(h.supplied.get('local')!.voice, 'Andre');
  assert.equal(h.supplied.get('local')!.usage, 'phone');
  assert.equal(h.supplied.get('local')!.allowAndreTopLevelWithTinaOutput, true);
  await h.ready('local', session('local', true));
  h.attach('remote');
  await h.ready('remote');
  assert.equal(h.supplied.get('remote')!.voice, 'Tina');
  assert.equal(
    h.supplied.get('remote')!.allowAndreTopLevelWithTinaOutput,
    false,
  );
  assert.equal(h.supplied.get('remote')!.allowMissingVoiceCloneEcho, false);
  assert.equal(
    h.diagnostics.filter((event) => event.stage === 'configuration').length,
    2,
  );
  assert.equal(
    h.diagnostics.find((event) => event.role === 'local').voicePolicy,
    'approved_andre_tina_metadata_conflict',
  );
  h.bridge.close();
  assert.deepEqual(h.aborted, { local: 1, remote: 1 });
});

test('real shared codecs receive exact 16 kHz PCM and remote original remains byte-identical, independent of captions', async () => {
  const h = fixture();
  await h.pair();
  const input = Buffer.from(Array.from({ length: 160 }, (_, index) => index));
  h.phones.local.media(input);
  h.phones.remote.media(input);
  assert.deepEqual(
    Buffer.concat(h.appended.local),
    new PcmuToPcm16k().push(input),
  );
  assert.deepEqual(
    Buffer.concat(h.appended.remote),
    new PcmuToPcm16k().push(input),
  );
  assert.deepEqual(h.phones.local.audio(), input);
  assert(
    h.admissions.some(
      (event) =>
        event.stage === 'input' && event.bytes === 640 && event.audioMs === 20,
    ),
  );
  const pcm = Buffer.alloc(19200, 3);
  h.pcm('one', pcm);
  h.complete('one');
  await tick();
  assert.deepEqual(h.phones.remote.audio(), new Pcm24kToPcmu().push(pcm));
  assert(
    h.diagnostics.some(
      (event) =>
        event.stage === 'playback_queued' &&
        event.actualPlaybackStartAt === null,
    ),
  );
  assert(h.diagnostics.some((event) => event.stage === 'playback_drained'));
  h.bridge.close();
});

test('caption source/translation revisions remain separate and late pairing does not replay PCM', async () => {
  const h = fixture();
  await h.pair();
  h.source('local', 's1', '不，五十。', 1, false);
  h.source('local', 's1', '不，五十，不是十五。', 2);
  h.translation('local', 't1', undefined, 'No, fifty, not fifteen.', 1, false);
  h.pcm('t1');
  const bytes = h.phones.remote.audio().length;
  h.translation('local', 't1', 's1', 'No, fifty, not fifteen.', 2);
  h.source('remote', 's2', 'Do not cancel.');
  h.translation('remote', 't2', 's2', '不要取消。');
  const local = h.transcripts
    .filter((event) => event.role === 'local' && event.kind === 'translation')
    .at(-1);
  assert.equal(local.pairing, 'explicit');
  assert.equal(local.sourceRevision, undefined);
  assert.equal(h.phones.remote.audio().length, bytes);
  assert(
    h.transcripts.some(
      (event) =>
        event.role === 'remote' &&
        event.kind === 'translation' &&
        event.text === '不要取消。',
    ),
  );
  assert.equal(h.failures.length, 0);
  h.bridge.close();
});

test('mark credits bound queued PCM and keep remote original moving while later translated audio waits', async () => {
  const h = fixture();
  await h.pair();
  h.phones.remote.autoAck = false;
  h.pcm('long', Buffer.alloc(480000, 1));
  h.complete('long');
  await tick();
  const before = h.phones.remote.audio().length;
  assert(before > 0 && before <= 48000);
  h.phones.remote.receive({
    event: 'mark',
    streamSid: 'MZ_remote',
    mark: { name: 'wrong_mark' },
  });
  assert.equal(h.phones.remote.audio().length, before);
  h.phones.local.receive({
    event: 'mark',
    streamSid: 'MZ_local',
    mark: { name: 'unknown_mark' },
  });
  h.phones.remote.media(Buffer.alloc(160, 0x90));
  assert.equal(h.phones.local.audio().length, 160);
  h.phones.remote.ack();
  await tick();
  assert(h.phones.remote.audio().length > before);
  assert.equal(h.failures.length, 0);
  h.bridge.close();
});

test('model fatal stops both suppliers and clears translated playback while phone and English original stay alive', async () => {
  const h = fixture();
  await h.pair();
  h.phones.remote.autoAck = false;
  h.pcm('long', Buffer.alloc(480000, 1));
  h.supplied.get('local')!.onError!('LIVETRANSLATE_CONNECTION_CLOSED', {
    closeCode: 1006,
  });
  const atStop = h.phones.remote.audio().length;
  const submitted = h.appended.local.length + h.appended.remote.length;
  assert.deepEqual(h.aborted, { local: 1, remote: 1 });
  assert.equal(h.phones.local.terminated, 0);
  assert.equal(h.phones.remote.terminated, 0);
  assert(h.phones.remote.sent.some((event) => event.event === 'clear'));
  assert(h.captions.some((event) => event.translationStopped === true));
  h.pcm('late');
  h.phones.local.media(Buffer.alloc(160));
  h.phones.remote.media(Buffer.alloc(160, 0x90));
  h.phones.remote.ack();
  assert.equal(h.phones.remote.audio().length, atStop);
  assert.equal(h.appended.local.length + h.appended.remote.length, submitted);
  assert.equal(h.phones.local.audio().length, 160);
  assert.deepEqual(h.failures, []);
  assert.equal(
    h.diagnostics.find((event) => event.stage === 'failed').closeCode,
    1006,
  );
  h.bridge.close();
  assert.equal(h.phones.local.terminated, 1);
  assert.equal(h.phones.remote.terminated, 1);
});

test('remote audio and invalid duplicate PCM fail translation only, while real phone stop still requests owner cleanup', async () => {
  const remote = fixture();
  await remote.pair();
  remote.supplied.get('remote')!.onAudio!(Buffer.alloc(9600), {
    role: 'remote',
    sessionId: 'session_remote',
    translationId: 't1',
    responseId: 'r1',
    eventId: 'e1',
    sequence: 1,
    pairing: 'unpaired',
  });
  assert.equal(
    remote.diagnostics.find((event) => event.stage === 'failed').code,
    'LIVETRANSLATE_PHONE_REMOTE_AUDIO_FORBIDDEN',
  );
  assert.equal(remote.phones.local.audio().length, 0);
  remote.bridge.close();
  const duplicate = fixture();
  await duplicate.pair();
  duplicate.pcm('one');
  const bytes = duplicate.phones.remote.audio().length;
  duplicate.pcm('one', Buffer.alloc(9600, 1), 1);
  assert.equal(duplicate.phones.remote.audio().length, bytes);
  duplicate.pcm('one', Buffer.alloc(9600, 2), 1);
  assert.equal(
    duplicate.diagnostics.find((event) => event.stage === 'failed').code,
    'LIVETRANSLATE_PHONE_AUDIO_ORDER_INVALID',
  );
  duplicate.phones.local.receive({ event: 'stop', streamSid: 'MZ_local' });
  assert.equal(duplicate.failures.length, 1);
  assert.equal(duplicate.phones.remote.terminated, 1);
});

test('a later FIFO-buffered completed response is not retired before its actual audio arrives', async () => {
  const h = fixture();
  await h.pair();
  const local = h.supplied.get('local')!;
  local.onTiming!({
    role: 'local',
    sessionId: 'session_local',
    stage: 'response_created',
    responseId: 'response_later',
    at: 1000,
  });
  local.onTiming!({
    role: 'local',
    sessionId: 'session_local',
    stage: 'audio_first_sample',
    responseId: 'response_later',
    at: 1001,
  });
  h.complete('later');
  await tick();
  assert.equal(h.phones.remote.audio().length, 0);
  h.pcm('later', Buffer.alloc(19200, 3));
  await tick();
  assert(h.diagnostics.some((event) => event.stage === 'playback_drained'));
  assert.equal(h.phones.remote.audio().length, 3200);
  h.bridge.close();
});

test('every voice protocol stage remains separate metadata and never logs raw content or supplier identifiers', async () => {
  const h = fixture();
  await h.pair();
  const local = h.supplied.get('local')!;
  for (const eventType of [
    'session.created',
    'session.updated',
    'response.created',
    'response.done',
  ] as const)
    local.onVoiceEvidence!({
      role: 'local',
      sessionId: 'PRIVATE_SUPPLIER_ID',
      responseId: 'PRIVATE_RESPONSE',
      eventId: 'PRIVATE_EVENT',
      receiveSequence: 2,
      receivedAt: 1000,
      eventType,
      requestedVoice: 'Andre',
      sessionTopLevelEcho: {
        value: 'Andre',
        status: 'reported',
        actualType: 'string',
      },
      sessionNestedEcho: {
        value: 'Tina',
        status: 'reported',
        actualType: 'string',
      },
      responseEcho: {
        value: eventType === 'response.done' ? null : 'Andre',
        status: eventType === 'response.done' ? 'missing' : 'reported',
        actualType: eventType === 'response.done' ? 'missing' : 'string',
      },
      policyMode: 'approved_andre_tina_metadata_conflict',
      acceptedByVoicePolicy: true,
      acousticVoice: 'unknown_not_measured',
    });
  const evidence = h.diagnostics.filter(
    (event) => event.stage === 'voice_evidence',
  );
  assert.equal(evidence.length, 4);
  assert.equal(evidence.at(-1).responseVoiceStatus, 'missing');
  assert.equal(evidence.at(-1).responseVoice, null);
  assert(!JSON.stringify(h.diagnostics).includes('PRIVATE'));
  assert(!JSON.stringify(h.diagnostics).includes(config.apiKey));
  h.bridge.close();
  const count = h.diagnostics.length;
  local.onProtocolDiagnostic!({
    role: 'local',
    at: 1000,
    stage: 'configuring',
    eventType: 'session.updated',
    validationPath: 'session.enable_voice_clone',
    expected: 'false',
    actualType: 'missing',
    fatal: false,
    code: 'LIVETRANSLATE_CLONE_CONFIRMATION_MISSING',
  });
  assert.equal(h.diagnostics.length, count);
});

test('extremely small PCM chunks use mark credits without overflowing, dropping or coalescing true repeats', async () => {
  const h = fixture();
  await h.pair();
  h.phones.remote.autoAck = false;
  const all: Buffer[] = [];
  for (let index = 0; index < 512; index += 1) {
    const chunk = Buffer.alloc(6, index % 100);
    all.push(chunk);
    h.pcm('tiny', chunk);
  }
  assert.equal(
    h.phones.remote.sent.filter((event) => event.event === 'mark').length,
    200,
  );
  h.complete('tiny');
  for (let index = 0; index < 4; index += 1) {
    h.phones.remote.ack();
    await tick();
  }
  assert.deepEqual(
    h.phones.remote.audio(),
    new Pcm24kToPcmu().push(Buffer.concat(all)),
  );
  assert(h.diagnostics.some((event) => event.stage === 'playback_drained'));
  assert.deepEqual(h.failures, []);
  assert.equal(h.aborted.local, 0);
  h.bridge.close();
});

test('model readiness input overflow stops translation only, including caption startup, without stopping original audio', async () => {
  for (const direction of ['local', 'remote'] as const) {
    const h = fixture();
    h.attach('local');
    if (direction === 'remote') await h.ready('local');
    h.attach('remote');
    h.phones[direction].media(Buffer.alloc(16000, 0x90));
    h.phones[direction].media(Buffer.alloc(160, 0x90));
    await tick();
    assert(h.captions.some((event) => event.translationStopped));
    assert.deepEqual(h.aborted, { local: 1, remote: 1 });
    assert.equal(h.phones.local.terminated, 0);
    assert.equal(h.phones.remote.terminated, 0);
    const originalBefore = h.phones.local.audio().length;
    h.phones.remote.media(Buffer.alloc(160, 0x90));
    assert.equal(h.phones.local.audio().length, originalBefore + 160);
    assert.deepEqual(h.failures, []);
    h.bridge.close();
  }
});

test('ready policy cannot broaden a remote clone or reuse a different session acknowledgement', async () => {
  for (const defect of ['wrongAck', 'remoteClone']) {
    const h = fixture();
    h.attach('local');
    if (defect === 'wrongAck') {
      const invalid = session('local');
      invalid.voicePolicy!.acknowledgement.sessionId = 'unrelated_session';
      await h.ready('local', invalid);
    } else {
      await h.ready('local');
      h.attach('remote');
      const invalid = session('remote');
      invalid.voiceCloneEnabled = null;
      invalid.voiceCloneConfirmation = 'missing_echo_warning';
      await h.ready('remote', invalid);
    }
    assert(
      h.diagnostics.some(
        (event) =>
          event.stage === 'failed' &&
          event.code === 'LIVETRANSLATE_PHONE_CONFIGURATION_INVALID',
      ),
    );
    assert.equal(h.phones.local.terminated, 0);
    assert.deepEqual(h.failures, []);
    h.bridge.close();
  }
});

test('metadata joins only explicit source edges and keeps provider endpoint, PCM receipt and mark drainage distinct', async () => {
  const h = fixture();
  await h.pair();
  const local = h.supplied.get('local')!;
  h.source('local', 's1', 'Synthetic raw.');
  local.onTiming!({
    role: 'local',
    sessionId: 'session_local',
    sourceId: 's1',
    stage: 'source_stopped',
    providerAudioMs: 20,
    at: 1100,
  });
  h.translation('local', 'one', 's1', 'Synthetic output.');
  local.onTiming!({
    role: 'local',
    sessionId: 'session_local',
    responseId: 'response_one',
    stage: 'translation_completed',
    at: 1300,
  });
  h.pcm('one');
  h.complete('one');
  await tick();
  const link = h.diagnostics.find((event) => event.stage === 'association');
  assert.equal(typeof link.sourceSequence, 'number');
  assert.equal(typeof link.responseSequence, 'number');
  for (const stage of [
    'translation_completed',
    'audio_first_sample',
    'playback_queued',
    'playback_drained',
  ]) {
    const event = h.diagnostics.find((item) => item.stage === stage);
    assert.equal(event.sourceSequence, link.sourceSequence);
    assert.equal(event.responseSequence, link.responseSequence);
    assert.equal(event.clock, 'application_epoch_ms');
    assert.equal(event.actualPlaybackStartAt, null);
  }
  const endpoint = h.diagnostics.find(
    (event) => event.stage === 'source_stopped',
  );
  assert.equal(endpoint.providerEndpointBasis, 'provider_stream_estimate');
  local.onTiming!({
    role: 'local',
    sessionId: 'session_local',
    responseId: 'response_unknown',
    stage: 'audio_first_sample',
    at: 1400,
  });
  assert.equal(h.diagnostics.at(-1).sourceSequence, undefined);
  h.phones.local.media(Buffer.alloc(160));
  const input = h.diagnostics.find((event) => event.stage === 'input_received');
  assert.equal(input.basis, 'client_accepted_not_written');
  assert.equal(input.inputAudioMs, 20);
  h.bridge.close();
});

test('send diagnostic windows use the bound track and still reach observers after close without resuming business', async () => {
  const h = fixture();
  await h.pair();
  const local = h.supplied.get('local')!;
  local.onSendDiagnostic!({ ...sendDiagnosticFixture(), role: 'remote' });
  const first = h.diagnostics.find((event) => event.stage === 'send_window');
  assert.equal(first.role, 'local');
  assert.equal(first.sendDiagnostic.records[0].senderBufferedBytes, null);
  const original = Buffer.from([0xff, 0x80, 0x10]);
  h.phones.remote.media(original);
  assert.deepEqual(h.phones.local.audio(), original);
  const failureCount = h.failures.length;
  h.bridge.close();
  const transcriptCount = h.transcripts.length;
  local.onSendDiagnostic!({
    ...sendDiagnosticFixture('cancelled'),
    role: 'remote',
  });
  local.onSendDiagnostic!({
    ...sendDiagnosticFixture('late_callback'),
    role: 'remote',
  });
  local.onSendDiagnostic!({
    ...sendDiagnosticFixture('backlog_warning'),
    role: 'local',
  });
  const windows = h.diagnostics.filter(
    (event) => event.stage === 'send_window',
  );
  assert.deepEqual(
    windows.map((event) => event.sendDiagnostic.trigger),
    ['backlog_warning', 'cancelled', 'late_callback'],
  );
  assert.ok(windows.every((event) => event.role === 'local'));
  h.source('local', 'retired', 'Synthetic late text.');
  assert.equal(h.transcripts.length, transcriptCount);
  assert.deepEqual(h.aborted, { local: 1, remote: 1 });
  assert.equal(h.failures.length, failureCount);
});

test('routine send callbacks still advance written input evidence without continuous normal send logs', async () => {
  const h = fixture();
  await h.pair();
  const local = h.supplied.get('local')!;
  for (let index = 1; index <= 20; index += 1) {
    for (const stage of [
      'send_accepted',
      'send_started',
      'send_written',
    ] as const) {
      local.onSendObservation!({
        stage,
        at: 1000 + index * 1000,
        eventType: 'input_audio_buffer.append',
        sendSequence: index,
        observedSequence: index,
        audioBytes: 640,
        acceptedAudioBytes: index * 640,
        writtenAudioBytes: index * 640,
        pendingAudioBytes: 0,
        pendingWireBytes: 0,
        readyState: 1,
        bufferedBytes: 0,
        role: 'local',
        queuedDurationMs: 0,
      });
    }
  }
  assert.equal(
    h.diagnostics.some((event) =>
      ['send_accepted', 'send_started', 'send_written'].includes(event.stage),
    ),
    false,
  );
  local.onTiming!({
    role: 'local',
    sessionId: 'session_local',
    sourceId: 'source_after_send',
    stage: 'source_stopped',
    providerAudioMs: 50,
    at: 22000,
  });
  const endpoint = h.diagnostics.find(
    (event) => event.stage === 'source_stopped',
  );
  assert.equal(endpoint.inputWrittenAudioMs, 400);
  h.bridge.close();
});
