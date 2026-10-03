// Synthetic browser/worklet fixtures only. No real microphone or API calls.
// Run from the repository root: node tests/voice-capture.test.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync('public/voice-capture.js', 'utf8');
const workletSource = readFileSync('public/voice-capture-worklet.js', 'utf8');
let checks = 0;
function passed(label) {
  checks++;
  console.log(`PASS ${label}`);
}

for (const rate of [44100, 48000]) {
  let Processor;
  class Base {
    constructor() {
      this.messages = [];
      this.port = { postMessage: (message) => this.messages.push(message) };
    }
  }
  vm.runInNewContext(workletSource, {
    AudioWorkletProcessor: Base,
    sampleRate: rate,
    registerProcessor: (_, value) => {
      Processor = value;
    },
    Uint8Array,
    DataView,
    Math,
    Number,
  });
  const processor = new Processor({
    processorOptions: { maxFrames: rate * 90 },
  });
  const block = Float32Array.from({ length: 128 }, (_, i) =>
    i % 3 === 0 ? -1 : i % 3 === 1 ? 0.5 : 1,
  );
  for (let i = 0; i < Math.ceil((rate * 90) / 128) + 2; i++)
    processor.process([[block]]);
  const done = processor.messages.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.frames, rate * 90);
  assert.equal(done.reason, 'limit');
  const chunks = processor.messages.filter(
    (message) => message.type === 'chunk',
  );
  assert.equal(
    chunks.reduce((length, message) => length + message.bytes.length, 0),
    rate * 90 * 2,
  );
  const first = new DataView(chunks[0].bytes.buffer);
  assert.equal(first.getInt16(0, true), -32768);
  assert.equal(first.getInt16(2, true), 16384);
  assert.equal(first.getInt16(4, true), 32767);
  passed(`${rate} Hz: 90-second worklet cap, PCM16 signs and full byte count`);

  const partial = new Processor({ processorOptions: { maxFrames: rate * 30 } });
  partial.process([[Float32Array.from([0.25, NaN, Infinity, -0.25])]]);
  partial.port.onmessage({ data: { type: 'stop' } });
  partial.port.onmessage({ data: { type: 'stop' } });
  assert.equal(partial.messages.length, 2);
  assert.equal(partial.messages[0].bytes.length, 8);
  assert.equal(partial.messages[1].invalid, 2);
  assert.equal(partial.messages[1].frames, 4);
  passed(
    `${rate} Hz: short stop flush is idempotent and nonfinite input detected`,
  );
}

class Element {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.listeners = new Map();
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this._value = '';
    this.selectedIndex = 0;
    this.className = '';
  }
  addEventListener(name, callback) {
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(callback);
    this.listeners.set(name, listeners);
  }
  removeEventListener(name, callback) {
    this.listeners.get(name)?.delete(callback);
  }
  dispatch(name, event = {}) {
    for (const callback of this.listeners.get(name) || []) callback(event);
  }
  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (child) => child !== this,
      );
  }
  get options() {
    return this.children;
  }
  get value() {
    return this.tag === 'select'
      ? this.children[this.selectedIndex]?.value || this._value
      : this._value;
  }
  set value(value) {
    const index = this.children.findIndex((child) => child.value === value);
    if (this.tag === 'select' && index >= 0) this.selectedIndex = index;
    else this._value = value;
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  removeAttribute(name) {
    delete this[name];
  }
  pause() {
    this.paused = true;
  }
  load() {}
  click() {
    this.dispatch('click');
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...((selector === 'audio' && child.tag === 'audio') ||
      (selector === '.clip' && child.className === 'clip')
        ? [child]
        : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

function streamFixture() {
  const track = new Element();
  track.readyState = 'live';
  track.label = 'Synthetic mic';
  track.stops = 0;
  track.stop = () => {
    track.stops++;
    track.readyState = 'ended';
  };
  track.getSettings = () => ({
    sampleRate: 48000,
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    deviceId: 'mic-test',
  });
  return {
    track,
    stream: { getTracks: () => [track], getAudioTracks: () => [track] },
  };
}

function page(options = {}) {
  const ids = [
    ...readFileSync('public/voice-capture.html', 'utf8').matchAll(
      /id="([^"]+)"/g,
    ),
  ].map((match) => match[1]);
  const elements = Object.fromEntries(
    ids.map((id) => [
      id,
      new Element(['passage', 'microphone'].includes(id) ? 'select' : 'div'),
    ]),
  );
  const defaultMic = new Element('option');
  defaultMic.value = 'default';
  elements.microphone.append(defaultMic);
  const contexts = [];
  const processors = [];
  const timers = new Map();
  let timerId = 0;
  let calls = 0;
  const mock = streamFixture();
  class Context {
    constructor() {
      contexts.push(this);
      this.sampleRate = options.rate || 48000;
      this.closed = 0;
      this.destination = {};
      this.audioWorklet = {
        addModule: async () => {
          if (options.moduleFails) throw new Error('MODULE_FAILED');
        },
      };
    }
    async resume() {}
    async close() {
      this.closed++;
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} };
    }
  }
  class Worklet {
    constructor() {
      processors.push(this);
      this.port = {
        closed: 0,
        onmessage: null,
        postMessage: (message) => {
          this.stopRequested = message.type === 'stop';
        },
        close: () => this.port.closed++,
      };
    }
    connect() {}
    disconnect() {
      this.disconnected = true;
    }
  }
  const document = {
    body: new Element('body'),
    getElementById: (id) => elements[id],
    createElement: (tag) => new Element(tag),
    querySelectorAll: (selector) =>
      Object.values(elements).flatMap((element) =>
        element.querySelectorAll(selector),
      ),
  };
  const window = new Element();
  window.AudioContext = Context;
  window.AudioWorkletNode = Worklet;
  window.confirm = () => true;
  const sandbox = {
    document,
    window,
    navigator: {
      mediaDevices: {
        getUserMedia: async (constraints) => {
          calls++;
          sandbox.lastConstraints = constraints;
          return options.getUserMedia ? options.getUserMedia() : mock.stream;
        },
        enumerateDevices: async () => [],
      },
    },
    AudioContext: Context,
    AudioWorkletNode: Worklet,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    Blob,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Math,
    Number,
    Date,
    JSON,
    setTimeout: (callback, ms) => {
      const id = ++timerId;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(
    source +
      '\nglobalThis.test = {start,stop,wave,receive,clips,elements,get active(){return active;}};',
    context,
  );
  return {
    ...sandbox.test,
    context,
    sandbox,
    elements,
    mock,
    contexts,
    processors,
    timers,
    window,
    calls: () => calls,
    getActive: () => sandbox.test.active,
  };
}

async function flush() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}

{
  const fixture = page();
  assert.equal(fixture.calls(), 0);
  assert.equal(fixture.elements.record.disabled, true);
  await fixture.start();
  assert.equal(fixture.calls(), 0);
  passed('initial page and unchecked consent never acquire microphone');
}
{
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const fixture = page({ getUserMedia: () => pending });
  fixture.elements.consent.checked = true;
  const starting = fixture.start();
  await flush();
  assert.equal(fixture.calls(), 1);
  fixture.stop();
  assert.equal(fixture.getActive(), null);
  assert.equal(fixture.contexts[0].closed, 1);
  resolve(fixture.mock.stream);
  await starting;
  assert.equal(fixture.mock.track.stops, 1);
  assert.equal(fixture.clips.length, 0);
  passed('cancel during getUserMedia releases context and late-arriving track');
}
{
  const fixture = page({ moduleFails: true });
  fixture.elements.consent.checked = true;
  await fixture.start();
  assert.equal(fixture.mock.track.stops, 1);
  assert.equal(fixture.contexts[0].closed, 1);
  assert.equal(fixture.getActive(), null);
  passed('worklet load failure stops microphone and closes context');
}
{
  const fixture = page();
  fixture.elements.consent.checked = true;
  await fixture.start();
  const session = fixture.getActive();
  assert.equal(session.phase, 'recording');
  assert.equal(
    fixture.sandbox.lastConstraints.audio.echoCancellation.ideal,
    false,
  );
  assert.equal(
    fixture.sandbox.lastConstraints.audio.noiseSuppression.ideal,
    false,
  );
  assert.equal(
    fixture.sandbox.lastConstraints.audio.autoGainControl.ideal,
    false,
  );
  fixture.receive(session, {
    type: 'chunk',
    bytes: new Uint8Array(48000 * 2),
    rms: 0.1,
  });
  fixture.stop();
  assert.equal(fixture.mock.track.stops, 1);
  assert.equal(fixture.processors[0].stopRequested, true);
  fixture.receive(session, {
    type: 'done',
    frames: 48000,
    energy: 480,
    peak: 0.3,
    clipped: 0,
    invalid: 0,
  });
  assert.equal(fixture.getActive(), null);
  assert.equal(fixture.clips.length, 1);
  assert.equal(fixture.clips[0].trial, true);
  assert.equal(fixture.clips[0].durationSeconds, 1);
  assert.equal(fixture.contexts[0].closed, 1);
  assert.equal(fixture.processors[0].port.closed, 1);
  const bytes = await fixture.clips[0].blob.arrayBuffer();
  const view = new DataView(bytes);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 96000);
  assert.equal(bytes.byteLength, 96044);
  passed(
    'manual stop flush releases all capture resources and preserves native WAV header',
  );
}
{
  const fixture = page();
  fixture.elements.consent.checked = true;
  await fixture.start();
  fixture.stop();
  const timeout = [...fixture.timers.values()].find(
    (timer) => timer.ms === 1500,
  );
  assert.ok(timeout);
  timeout.callback();
  assert.equal(fixture.getActive(), null);
  assert.equal(fixture.clips.length, 0);
  assert.equal(fixture.contexts[0].closed, 1);
  assert.ok(fixture.mock.track.stops >= 1);
  passed('flush timeout releases capture and refuses incomplete clip');
}
{
  const fixture = page();
  fixture.elements.consent.checked = true;
  await fixture.start();
  const session = fixture.getActive();
  fixture.receive(session, {
    type: 'chunk',
    bytes: new Uint8Array(48000 * 2),
    rms: 0.1,
  });
  fixture.mock.track.dispatch('ended');
  assert.equal(session.phase, 'stopping');
  assert.equal(fixture.mock.track.stops, 1);
  fixture.receive(session, {
    type: 'done',
    frames: 48000,
    energy: 480,
    peak: 0.3,
    clipped: 0,
    invalid: 0,
  });
  assert.equal(fixture.getActive(), null);
  assert.equal(fixture.clips.length, 1);
  assert.ok(
    fixture.clips[0].advisory.some((advice) => advice.includes('麦克风已断开')),
  );
  assert.equal(fixture.contexts[0].closed, 1);
  passed(
    'track ended saves flushed prefix with explicit incomplete advisory and cleanup',
  );
}
{
  const fixture = page();
  fixture.elements.consent.checked = true;
  await fixture.start();
  fixture.elements.consent.checked = false;
  fixture.elements.consent.dispatch('change');
  assert.equal(fixture.getActive(), null);
  assert.equal(fixture.mock.track.stops, 1);
  assert.equal(fixture.contexts[0].closed, 1);
  passed('consent revocation cancels capture and releases microphone');
}
{
  const fixture = page();
  fixture.elements.consent.checked = true;
  await fixture.start();
  fixture.window.dispatch('pagehide');
  assert.equal(fixture.getActive(), null);
  assert.equal(fixture.mock.track.stops, 1);
  assert.equal(fixture.contexts[0].closed, 1);
  passed('pagehide stops recording and clears memory');
}

console.log(
  `${checks} targeted simulation checks passed; no real microphone used.`,
);
