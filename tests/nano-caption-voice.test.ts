import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNanoCaptionVoice } from '../src/solo/nano-caption-voice';
import type { LocalVoiceSynthesizer } from '../src/solo/continuous-translation-bridge';
import type { NanoVoicePostprocessor } from '../src/solo/nano-voice-postprocess';

function fixture() {
  const raw = Buffer.alloc(4800, 1);
  const processed = Buffer.alloc(5200, 2);
  const sourceCalls: { text: string; signal?: AbortSignal }[] = [];
  const processingCalls: { pcm: Buffer; signal?: AbortSignal }[] = [];
  const source: LocalVoiceSynthesizer = {
    ready: Promise.resolve(),
    async synthesize(text, signal) {
      sourceCalls.push({ text, signal });
      return { pcm: raw, sampleRate: 24000, metrics: { generationMs: 42, audioMs: 100 } };
    },
  };
  const processor = {
    ready: Promise.resolve(),
    async process(pcm: Buffer, signal?: AbortSignal) {
      processingCalls.push({ pcm, signal });
      return { pcm: processed, metrics: {} };
    },
    close() {},
  } as unknown as NanoVoicePostprocessor;
  return { raw, processed, sourceCalls, processingCalls, source, processor };
}

test('B adapter processes each sentence once, preserves source and reports actual slower audio length', async () => {
  const f = fixture(); const c = new AbortController();
  const voice = createNanoCaptionVoice(f.source, f.processor);
  const result = await voice.synthesize('Tomorrow, not today.', c.signal);
  assert.equal(voice.maxOutputSeconds, 22);
  assert.deepEqual(f.sourceCalls, [{ text: 'Tomorrow, not today.', signal: c.signal }]);
  assert.deepEqual(f.processingCalls, [{ pcm: f.raw, signal: c.signal }]);
  assert.equal(result.pcm, f.processed);
  assert.equal(result.metrics.generationMs, 42);
  assert.equal(result.metrics.audioMs, 5200 / 48);
  assert.equal(f.raw.equals(Buffer.alloc(4800, 1)), true);
});

test('postprocessor readiness failure stops synthesis instead of silently using old voice', async () => {
  const f = fixture(); f.processor.ready = Promise.reject(new Error('DSP_NOT_READY'));
  const voice = createNanoCaptionVoice(f.source, f.processor);
  await assert.rejects(voice.ready, /DSP_NOT_READY/);
  await assert.rejects(voice.synthesize('Hello.'), /DSP_NOT_READY/);
  assert.equal(f.sourceCalls.length, 0);
});

test('cancel while readiness is pending rejects promptly and never synthesizes later', async () => {
  const f = fixture(); let ready!: () => void;
  f.source.ready = new Promise<void>(resolve => { ready = resolve; });
  const voice = createNanoCaptionVoice(f.source, f.processor);
  const c = new AbortController(); const promise = voice.synthesize('Hello.', c.signal);
  c.abort(); await assert.rejects(promise, { name: 'AbortError' });
  ready(); await voice.ready; await Promise.resolve();
  assert.equal(f.sourceCalls.length, 0);
});

test('hangup after raw synthesis prevents postprocessing or late output', async () => {
  const f = fixture(); const c = new AbortController();
  const original = f.source.synthesize;
  f.source.synthesize = async (...args) => { const result = await original(...args); c.abort(); return result; };
  await assert.rejects(createNanoCaptionVoice(f.source, f.processor).synthesize('Hello.', c.signal), { name: 'AbortError' });
  assert.equal(f.processingCalls.length, 0);
});

test('hangup during postprocessing discards a late successful result', async () => {
  const f = fixture(); const c = new AbortController();
  const original = f.processor.process;
  f.processor.process = async (...args) => { const result = await original(...args); c.abort(); return result; };
  await assert.rejects(createNanoCaptionVoice(f.source, f.processor).synthesize('Hello.', c.signal), { name: 'AbortError' });
  assert.equal(f.processingCalls.length, 1);
});
