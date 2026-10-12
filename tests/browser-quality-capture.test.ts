/* eslint-disable max-classes-per-file -- Browser fixtures are isolated mock surfaces. */
/* eslint-disable no-await-in-loop -- Flush deterministic browser promise queues. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const qualityFixtures = JSON.parse(
  readFileSync('tests/fixtures/phone-quality-v1.json', 'utf8'),
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class EventSurface {
  readonly listeners = new Map<string, Set<(...args: any[]) => unknown>>();

  addEventListener(type: string, listener: (...args: any[]) => unknown) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (...args: any[]) => unknown) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: object = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class Element extends EventSurface {
  disabled = false;

  checked = false;

  hidden = false;

  textContent = '';

  src = '';

  href = '';

  download = '';

  selectedIndex = 0;

  private ownValue = '';

  readonly children: Element[] = [];

  readonly attributes = new Map<string, string>();

  get value() {
    return this.children[this.selectedIndex]?.value ?? this.ownValue;
  }

  set value(value: string) {
    const index = this.children.findIndex((item) => item.value === value);
    if (index >= 0) this.selectedIndex = index;
    else this.ownValue = value;
  }

  append(child: Element) {
    this.children.push(child);
  }

  appendChild(child: Element) {
    this.append(child);
    return child;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === 'src') this.src = '';
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  pause() {}

  load() {}

  remove() {}

  click() {
    this.dispatch('click');
  }
}

function streamFixture() {
  const track = new EventSurface() as EventSurface & {
    readyState: string;
    stop: () => void;
  };
  track.readyState = 'live';
  let stopped = 0;
  track.stop = () => {
    stopped += 1;
    track.readyState = 'ended';
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  };
  return { stream, track, stopped: () => stopped };
}

type MockStream = ReturnType<typeof streamFixture>['stream'];
type Rendered = { getChannelData: (channel: number) => Float32Array };

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function pageFixture(
  options: {
    getUserMedia?: () => Promise<MockStream>;
    resume?: () => Promise<void>;
    render?: (length: number) => Promise<Rendered>;
  } = {},
) {
  const elements = new Map<string, Element>();
  const element = (name: string) => {
    if (!elements.has(name)) elements.set(name, new Element());
    return elements.get(name)!;
  };
  const window = new EventSurface();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 1;
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  let microphoneRequests = 0;
  let networkRequests = 0;
  const defaultStream = streamFixture();
  class AudioNode {
    connections = 0;

    disconnected = 0;

    gain = { value: 1 };

    onaudioprocess: ((event: unknown) => void) | null = null;

    connect() {
      this.connections += 1;
    }

    disconnect() {
      this.disconnected += 1;
    }

    start() {}
  }
  const contexts: MockAudioContext[] = [];
  const processors: AudioNode[] = [];
  const offlineContexts: MockOfflineContext[] = [];
  class MockAudioContext {
    sampleRate = 48000;

    destination = {};

    state = 'suspended';

    closed = 0;

    constructor() {
      contexts.push(this);
    }

    async resume() {
      await options.resume?.();
      this.state = 'running';
    }

    async close() {
      this.closed += 1;
      this.state = 'closed';
    }

    createMediaStreamSource() {
      return new AudioNode();
    }

    createScriptProcessor() {
      const node = new AudioNode();
      processors.push(node);
      return node;
    }

    createGain() {
      return new AudioNode();
    }
  }
  class MockOfflineContext {
    destination = {};

    constructor(
      readonly channels: number,
      readonly length: number,
      readonly rate: number,
    ) {
      offlineContexts.push(this);
    }

    createBuffer() {
      return { copyToChannel() {} };
    }

    createBufferSource() {
      return new AudioNode();
    }

    async startRendering() {
      return options.render
        ? options.render(this.length)
        : {
            getChannelData: () => new Float32Array(this.length).fill(0.2),
          };
    }
  }
  const context = vm.createContext({
    qualityFixtures,
    document: {
      getElementById: element,
      createElement: () => new Element(),
      body: new Element(),
    },
    window,
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          microphoneRequests += 1;
          return options.getUserMedia
            ? options.getUserMedia()
            : defaultStream.stream;
        },
      },
    },
    AudioContext: MockAudioContext,
    OfflineAudioContext: MockOfflineContext,
    Blob,
    URL: {
      createObjectURL: (blob: Blob) => {
        blobs.push(blob);
        return `blob:local-${blobs.length}`;
      },
      revokeObjectURL: (url: string) => revoked.push(url),
    },
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    setTimeout: (callback: () => void, delay: number) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: () => {
      networkRequests += 1;
      throw new Error('NETWORK_FORBIDDEN_IN_RECORDING_PAGE');
    },
    WebSocket: class {
      constructor() {
        networkRequests += 1;
        throw new Error('NETWORK_FORBIDDEN_IN_RECORDING_PAGE');
      }
    },
    console,
  });
  const source = readFileSync('public/quality-capture.js', 'utf8').replace(
    /^import\s+\{\s*qualityFixtures\s*\}\s+from\s+['"]\.\/quality-fixtures\.js['"];?\s*/,
    '',
  );
  vm.runInContext(source, context);
  return {
    element,
    contexts,
    processors,
    offlineContexts,
    timers,
    blobs,
    revoked,
    defaultStream,
    requests: () => ({
      microphone: microphoneRequests,
      network: networkRequests,
    }),
    consent(value = true) {
      element('consent').checked = value;
      element('consent').dispatch('change');
    },
    click(name: string) {
      element(name).click();
    },
    pagehide() {
      window.dispatch('pagehide', { persisted: true });
    },
    pageshow() {
      window.dispatch('pageshow', { persisted: true });
    },
    frame(samples = 24000) {
      processors.at(-1)?.onaudioprocess?.({
        inputBuffer: {
          getChannelData: () => new Float32Array(samples).fill(0.2),
        },
      });
    },
    expireRecordingTimer() {
      const entry = [...timers.entries()].find(
        ([, value]) => value.delay === 60000,
      );
      assert.ok(entry, 'active recording must have a 60 second wall timer');
      timers.delete(entry[0]);
      entry[1].callback();
    },
  };
}

test('recording page requires consent, never opens network, and recovers from denied microphone', async () => {
  const f = pageFixture({
    getUserMedia: async () => {
      throw new Error('NotAllowedError');
    },
  });
  f.click('record');
  await flush();
  assert.equal(f.requests().microphone, 0);
  assert.equal(f.element('record').disabled, true);
  f.consent();
  f.click('record');
  await flush();
  assert.equal(f.requests().microphone, 1);
  assert.equal(f.element('record').disabled, false);
  assert.equal(f.element('stop').disabled, true);
  assert.equal(f.element('consent').disabled, false);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.requests().network, 0);
});

test('late microphone permission after pagehide stops tracks and cached page can record again', async () => {
  const pending = deferred<MockStream>();
  const granted = streamFixture();
  const f = pageFixture({ getUserMedia: () => pending.promise });
  f.consent();
  f.click('record');
  await flush();
  f.pagehide();
  f.pageshow();
  pending.resolve(granted.stream);
  await flush();
  assert.ok(granted.stopped() >= 1);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.element('record').disabled, false);
  assert.equal(f.element('stop').disabled, true);
  assert.equal(f.element('count').textContent, '已录制 0 / 14');
});

test('pagehide during AudioContext resume immediately releases pending resources and ignores resume completion', async () => {
  const pendingResume = deferred<void>();
  const f = pageFixture({ resume: () => pendingResume.promise });
  f.consent();
  f.click('record');
  await flush();
  assert.equal(f.contexts.length, 1);
  f.pagehide();
  assert.ok(
    f.defaultStream.stopped() >= 1,
    'pending media stream must be released before resume settles',
  );
  assert.ok(f.contexts[0].closed >= 1);
  pendingResume.resolve();
  await flush();
  f.pageshow();
  assert.equal(
    f.processors.length,
    0,
    'stale resume must never connect recording graph',
  );
  assert.equal(f.timers.size, 0);
  assert.equal(f.element('record').disabled, false);
});

test('leaving during recording releases microphone, graph and timer and clears retained previews', async () => {
  const f = pageFixture();
  f.consent();
  f.click('record');
  await flush();
  f.frame();
  f.click('stop');
  await flush();
  assert.equal(f.element('count').textContent, '已录制 1 / 14');
  assert.ok(f.element('player').src.startsWith('blob:'));
  f.click('record');
  await flush();
  assert.equal(f.element('stop').disabled, false);
  f.pagehide();
  f.pageshow();
  await flush();
  assert.ok(f.defaultStream.stopped() >= 2);
  assert.ok(f.contexts.every((item) => item.closed >= 1));
  assert.ok(
    f.processors.every(
      (item) => item.onaudioprocess === null && item.disconnected >= 1,
    ),
  );
  assert.equal(f.timers.size, 0);
  assert.equal(f.element('record').disabled, false);
  assert.equal(f.element('stop').disabled, true);
  assert.equal(f.element('count').textContent, '已录制 0 / 14');
  assert.equal(f.element('player').src, '');
  assert.equal(f.element('player').hidden, true);
  assert.ok(f.revoked.length > 0);
});

test('late offline render cannot restore discarded samples or unlock a newer active recording', async () => {
  const render = deferred<Rendered>();
  const f = pageFixture({ render: () => render.promise });
  f.consent();
  f.click('record');
  await flush();
  f.frame();
  f.click('stop');
  await flush();
  assert.equal(f.offlineContexts.length, 1);
  f.pagehide();
  f.pageshow();
  f.click('record');
  await flush();
  assert.equal(f.contexts.length, 2);
  assert.equal(f.element('stop').disabled, false);
  render.resolve({ getChannelData: () => new Float32Array(4000).fill(0.2) });
  await flush();
  assert.equal(f.element('count').textContent, '已录制 0 / 14');
  assert.equal(
    f.element('record').disabled,
    true,
    'new recording still owns the busy state',
  );
  assert.equal(f.element('case').disabled, true);
  assert.equal(f.element('stop').disabled, false);
  assert.equal(f.element('player').hidden, true);
  assert.equal(f.processors[1].onaudioprocess === null, false);
  f.pagehide();
});

test('60 second sample limit retains at most 480000 output samples and releases all capture resources', async () => {
  const f = pageFixture();
  f.consent();
  f.click('record');
  await flush();
  f.frame(48000 * 61);
  await flush();
  assert.equal(f.offlineContexts.length, 1);
  assert.equal(f.offlineContexts[0].length, 480000);
  assert.equal(f.offlineContexts[0].rate, 8000);
  assert.ok(f.defaultStream.stopped() >= 1);
  assert.ok(f.contexts[0].closed >= 1);
  assert.equal(f.processors[0].onaudioprocess, null);
  assert.equal(f.timers.size, 0);
  assert.equal(f.element('record').disabled, false);
  assert.equal(f.element('stop').disabled, true);
  assert.equal(f.element('count').textContent, '已录制 1 / 14');
  assert.equal(f.blobs.at(-1)?.size, 44 + 480000 * 2);
});

test('60 second wall timer also stops when audio callbacks are sparse', async () => {
  const f = pageFixture();
  f.consent();
  f.click('record');
  await flush();
  f.frame();
  f.expireRecordingTimer();
  await flush();
  assert.ok(f.defaultStream.stopped() >= 1);
  assert.ok(f.contexts[0].closed >= 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.element('record').disabled, false);
  assert.equal(f.element('stop').disabled, true);
});

test('unplugging the microphone ends capture and releases resources instead of recording stale silence', async () => {
  const f = pageFixture();
  f.consent();
  f.click('record');
  await flush();
  f.frame();
  f.defaultStream.track.readyState = 'ended';
  f.defaultStream.track.dispatch('ended');
  await flush();
  assert.ok(f.defaultStream.stopped() >= 1);
  assert.ok(f.contexts[0].closed >= 1);
  assert.equal(f.processors[0].onaudioprocess, null);
  assert.equal(f.timers.size, 0);
  assert.equal(f.element('record').disabled, false);
  assert.equal(f.element('stop').disabled, true);
  assert.equal(f.element('count').textContent, '已录制 0 / 14');
  assert.equal(f.offlineContexts.length, 0);
  assert.equal(f.element('player').hidden, true);
  assert.match(f.element('status').textContent, /麦克风已断开/);
});
