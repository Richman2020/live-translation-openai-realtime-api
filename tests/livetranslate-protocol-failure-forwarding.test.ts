import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import {
  LIVE_TRANSLATE_ITEM_CONFLICT_KINDS,
  type LiveTranslateClientOptions,
  type LiveTranslateProtocolDiagnostic,
  type LiveTranslateSession,
} from '../src/experiments/livetranslate-types';
import { createLiveTranslatePhoneBridge } from '../src/solo/livetranslate-phone-bridge';
import { sanitizeLiveTranslatePhoneDiagnostic } from '../src/solo/livetranslate-phone-diagnostics';

/** Callback-boundary simulation, not a captured supplier frame or real call. */
function fixture() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    bufferedAmount: number;
    send: (...args: unknown[]) => void;
    terminate: () => void;
  };
  socket.readyState = WebSocket.OPEN;
  socket.bufferedAmount = 0;
  socket.send = () => {};
  socket.terminate = () => {};
  let clientOptions: LiveTranslateClientOptions;
  let aborted = 0;
  const diagnostics: unknown[] = [];
  const captions: any[] = [];
  const bridge = createLiveTranslatePhoneBridge(
    {
      apiKey: 'unused-synthetic-openai',
      model: 'unused-synthetic-model',
      now: () => 3000,
      onTranscript() {},
      onFailure() {},
      onCaptionState: (event) => captions.push(event),
    },
    {
      config: {
        region: 'beijing',
        workspaceId: 'offline-space',
        apiKey: 'SYNTHETIC_NONCREDENTIAL',
        model: 'qwen3.8-livetranslate-flash-realtime',
        voice: 'Andre',
      },
      onDiagnostic: (event) => diagnostics.push(event),
      deps: {
        createClient: (options) => {
          clientOptions = options;
          return {
            ready: new Promise<LiveTranslateSession>(() => {}),
            append() {},
            async finish() {},
            abort() {
              aborted += 1;
            },
          };
        },
      },
    },
  );
  bridge.attach('local', socket as unknown as WebSocket, 'MZ_synthetic');
  return {
    bridge,
    diagnostics,
    captions,
    client: () => clientOptions,
    aborted: () => aborted,
  };
}
function fatal(conflictKind: LiveTranslateProtocolDiagnostic['conflictKind']) {
  return {
    role: 'local',
    at: 2900,
    stage: 'ready',
    eventType: 'conversation.item.created',
    validationPath: 'item.id',
    expected: 'consistent_item_binding',
    actualType: 'string',
    fatal: true,
    code: 'LIVETRANSLATE_ITEM_CONFLICT',
    conflictKind,
    receiveSequence: 17,
  } as const;
}

test('all seven fixed branches reach phone diagnostics once, then existing onError stops translation', () => {
  for (const kind of LIVE_TRANSLATE_ITEM_CONFLICT_KINDS) {
    const h = fixture();
    try {
      h.client().onProtocolDiagnostic?.(fatal(kind));
      h.client().onProtocolDiagnostic?.(fatal('output_after_source'));
      const failures = h.diagnostics.filter(
        (event: any) => event.stage === 'protocol_failure',
      );
      assert.equal(failures.length, 1);
      const safe = sanitizeLiveTranslatePhoneDiagnostic(failures[0]);
      assert.equal(safe?.conflictKind, kind);
      assert.equal(safe?.receiveSequence, 17);
      assert.equal(safe?.eventType, 'conversation.item.created');
      assert.equal(safe?.role, 'local');
      assert.equal(
        h.aborted(),
        0,
        'diagnostic delivery itself does not own cleanup',
      );
      h.client().onError?.('LIVETRANSLATE_ITEM_CONFLICT', {});
      assert.equal(h.aborted(), 1);
      assert(h.captions.some((event) => event.translationStopped === true));
      assert.equal(
        h.diagnostics.filter((event: any) => event.stage === 'failed').length,
        1,
      );
      h.client().onProtocolDiagnostic?.(fatal(kind));
      assert.equal(
        h.diagnostics.filter((event: any) => event.stage === 'protocol_failure')
          .length,
        1,
      );
    } finally {
      h.bridge.close();
    }
  }
});

test('callback projection drops private fields, getters and unknown failure codes without executing accessors', () => {
  const h = fixture();
  let getters = 0;
  try {
    const hostile = {
      ...fatal('source_after_output'),
      text: 'PRIVATE_SPEECH',
      sourceId: 'PRIVATE_ID',
    };
    Object.defineProperty(hostile, 'eventType', {
      get() {
        getters += 1;
        throw new Error('DO_NOT_READ');
      },
    });
    h.client().onProtocolDiagnostic?.(hostile);
    assert.equal(getters, 0);
    const result = h.diagnostics.find(
      (event: any) => event.stage === 'protocol_failure',
    );
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('PRIVATE'), false);
    assert.equal(serialized.includes('eventType'), false);
    h.client().onError?.('LIVETRANSLATE_ITEM_CONFLICT', {});
  } finally {
    h.bridge.close();
  }
  const unknown = fixture();
  try {
    unknown.client().onProtocolDiagnostic?.({
      ...fatal('source_after_output'),
      code: 'PRIVATE_CODE',
    });
    assert.equal(unknown.diagnostics.length, 0);
    for (const name of ['fatal', 'code']) {
      const event = { ...fatal('source_after_output') };
      Object.defineProperty(event, name, {
        get() {
          getters += 1;
          throw new Error('DO_NOT_READ');
        },
      });
      unknown.client().onProtocolDiagnostic?.(event);
    }
    assert.equal(getters, 0);
    assert.equal(unknown.diagnostics.length, 0);
  } finally {
    unknown.bridge.close();
  }
});
