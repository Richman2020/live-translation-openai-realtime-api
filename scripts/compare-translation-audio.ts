import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'dotenv';
import WebSocket from 'ws';
import { createContinuousTranslationClient } from '../src/solo/continuous-translation-client';
import { PcmuToPcm24k, Pcm24kToPcmu } from '../src/solo/translation-pcm';
import { analyzePcmuPlayback } from '../src/solo/translation-audio-measurement';
import {
  TranslationBridge,
  type TranslationRole,
} from '../src/solo/translation-bridge';

// Explicit, bounded paid API experiment. Never imports the server, creates a
// Twilio client, dials a number, updates .env or records a live microphone.
// All audio and text outputs must remain under the Git-ignored .runtime folder.
const args = process.argv.slice(2);
const allowed = new Set([
  '--input',
  '--role',
  '--out',
  '--direct',
  '--synthetic',
  '--noise-reduction',
]);
const values = new Map<string, string>();
for (let index = 0; index < args.length; index += 1) {
  const name = args[index];
  if (!allowed.has(name) || values.has(name))
    throw new Error('INVALID_ARGUMENTS');
  if (name === '--direct' || name === '--synthetic') values.set(name, 'true');
  else {
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('MISSING_ARGUMENT');
    values.set(name, value);
  }
}
const role = values.get('--role') as TranslationRole;
if (
  !['local', 'remote'].includes(role) ||
  !values.get('--input') ||
  !values.get('--out')
)
  throw new Error('USE_INPUT_PCMU_ROLE_LOCAL_OR_REMOTE_OUT_RUNTIME');
const requestedNoiseReduction = values.get('--noise-reduction');
if (
  requestedNoiseReduction !== undefined &&
  !['off', 'near_field', 'far_field'].includes(requestedNoiseReduction)
)
  throw new Error('NOISE_REDUCTION_MUST_BE_OFF_NEAR_FIELD_OR_FAR_FIELD');
const noiseReduction =
  requestedNoiseReduction === 'off'
    ? null
    : (requestedNoiseReduction as 'near_field' | 'far_field' | undefined);
const privateRoot = resolve('.runtime');
const outputRoot = resolve(values.get('--out')!);
const outputRelative = relative(privateRoot, outputRoot);
if (
  !outputRelative ||
  outputRelative.startsWith('..') ||
  isAbsolute(outputRelative)
)
  throw new Error('OUTPUT_MUST_BE_INSIDE_RUNTIME');
const input = readFileSync(resolve(values.get('--input')!));
if (!input.length || input.length > 60 * 8000)
  throw new Error('INPUT_LIMIT_60_SECONDS_PCMU_8000_MONO');
const cfg = parse(readFileSync(resolve('.env')));
if (!cfg.OPENAI_API_KEY) throw new Error('MISSING_EXISTING_PROJECT_KEY');
const proxyUrl = values.has('--direct') ? '' : cfg.OPENAI_PROXY_URL || '';
const model = cfg.OPENAI_REALTIME_MODEL || 'gpt-realtime-1.5';
const transcriptionModel = cfg.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1';
mkdirSync(dirname(outputRoot), { recursive: true });
// A fresh directory prevents accidentally overwriting a previous comparison.
mkdirSync(outputRoot);
const startedAt = new Date().toISOString();
const started = performance.now();
const now = () => Math.round((performance.now() - started) * 10) / 10;
const source = Buffer.concat([
  Buffer.alloc(2400, 255),
  input,
  Buffer.alloc(32000, 255),
]);
type Output = {
  bytes: Buffer[];
  deltas: { atMs: number; bytes: number }[];
  transcripts: { atMs: number; text: string; kind: string; final: boolean }[];
  sentInputBytes: number;
};
const oldOutput: Output = {
  bytes: [],
  deltas: [],
  transcripts: [],
  sentInputBytes: 0,
};
const newOutput: Output = {
  bytes: [],
  deltas: [],
  transcripts: [],
  sentInputBytes: 0,
};
const readyRoles = new Set<TranslationRole>();
const metrics: unknown[] = [];
const candidateFormats: unknown[] = [];
const candidateRawOutput: Buffer[] = [];
let candidateRawOutputBytes = 0;
let failure: string | undefined;
let oldCompletedResponses = 0;
let oldConnections = 0;
const oldCommitted = new Set<string>();
const oldTranscribed = new Set<string>();
const oldNonempty = new Set<string>();
let candidateFilterDrainBytes = 0;
let firstInputAtMs: number | undefined;
let lastInputAtMs: number | undefined;
let lastSpeechFileFrameAtMs: number | undefined;
let continuousFinished = false;
const receive = (out: Output, bytes: Buffer) => {
  if (!bytes.length) return;
  if (
    out.bytes.reduce((size, part) => size + part.length, 0) + bytes.length >
    120 * 8000
  )
    throw new Error('OUTPUT_LIMIT_120_SECONDS');
  out.bytes.push(bytes);
  out.deltas.push({ atMs: now(), bytes: bytes.length });
};
class MemoryPhone extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  constructor(readonly phoneRole: TranslationRole) {
    super();
  }
  send(raw: string, callback?: (error?: Error) => void) {
    const event = JSON.parse(raw);
    if (event.event === 'media') {
      if (this.phoneRole === role)
        throw new Error('WRONG_TRANSLATION_RECIPIENT');
      receive(oldOutput, Buffer.from(event.media.payload, 'base64'));
    }
    // Do not synthesize mark acknowledgments: no actual phone played this audio.
    callback?.();
  }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  terminate() {
    this.close();
  }
}
const phones = {
  local: new MemoryPhone('local'),
  remote: new MemoryPhone('remote'),
};
const legacy = new TranslationBridge({
  apiKey: cfg.OPENAI_API_KEY,
  model,
  transcriptionModel,
  proxyUrl,
  createWebSocket: (url, options) => {
    const socket = new WebSocket(url, options);
    const providerRole = oldConnections++ === 0 ? 'local' : 'remote';
    if (oldConnections > 2) failure ||= 'LEGACY_RECONNECT_DURING_EXPERIMENT';
    socket.on('message', (raw) => {
      try {
        const event = JSON.parse(String(raw));
        if (providerRole !== role || typeof event.item_id !== 'string') return;
        if (event.type === 'input_audio_buffer.committed')
          oldCommitted.add(event.item_id);
        if (
          event.type === 'conversation.item.input_audio_transcription.completed'
        ) {
          oldTranscribed.add(event.item_id);
          if (typeof event.transcript === 'string' && event.transcript.trim())
            oldNonempty.add(event.item_id);
        }
      } catch {
        /* The production bridge handles malformed events. */
      }
    });
    return socket;
  },
  onFailure: () => {
    failure ||= 'LEGACY_PROVIDER_FAILED';
  },
  onTranscript: (event) => {
    if (event.role !== role) {
      failure ||= 'UNEXPECTED_OTHER_SPEAKER_TRANSCRIPT';
      return;
    }
    oldOutput.transcripts.push({
      atMs: now(),
      text: event.text,
      kind: event.kind,
      final: event.final,
    });
  },
  onMetric: (event) => metrics.push(event),
  onConnection: (event) => {
    if (event.state === 'ready') readyRoles.add(event.role);
  },
  onAudioDiagnostic: (event) => {
    if (
      event.role === role &&
      event.stage === 'generated' &&
      event.generatedBytes
    )
      oldCompletedResponses += 1;
  },
});
const inputConverter = new PcmuToPcm24k();
const outputConverter = new Pcm24kToPcmu();
const continuous = createContinuousTranslationClient({
  apiKey: cfg.OPENAI_API_KEY,
  targetLanguage: role === 'local' ? 'en' : 'zh',
  noiseReduction,
  proxyUrl,
  createWebSocket: (url, options) => {
    const socket = new WebSocket(url, options);
    socket.on('message', (raw) => {
      try {
        const event = JSON.parse(String(raw));
        if (
          event.type === 'session.output_audio.delta' &&
          candidateFormats.length < 4
        )
          candidateFormats.push({
            sampleRate: event.sample_rate,
            channels: event.channels,
            format: event.format,
            elapsedMs: event.elapsed_ms,
          });
      } catch {
        /* The client validates and handles malformed events. */
      }
    });
    return socket;
  },
  onAudio: (pcm) => {
    // Preserve exactly the provider PCM before telephone conversion. The same
    // 120-second audio limit applies; no padding or resampling is added here.
    if (candidateRawOutputBytes + pcm.length > 120 * 48000)
      throw new Error('OUTPUT_LIMIT_120_SECONDS');
    candidateRawOutput.push(Buffer.from(pcm));
    candidateRawOutputBytes += pcm.length;
    receive(newOutput, outputConverter.push(pcm));
  },
  onTranscript: (text) =>
    newOutput.transcripts.push({
      atMs: now(),
      text,
      kind: 'translation_delta',
      final: false,
    }),
  onError: (code) => {
    failure ||= `CONTINUOUS_${code}`;
  },
});
const limit = setTimeout(() => {
  failure ||= 'HARD_LIMIT_100_SECONDS';
  continuous.abort();
  legacy.close();
}, 100000);
async function waitFor(check: () => boolean, timeoutMs: number) {
  const end = performance.now() + timeoutMs;
  while (!check()) {
    if (failure) throw new Error(failure);
    if (performance.now() >= end) throw new Error('STEP_TIMEOUT');
    await delay(20);
  }
}
function wav(pcm: Buffer, sampleRate: number) {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
const attempt = {
  startedAt,
  role,
  synthetic: values.has('--synthetic'),
  realPhone: false,
  existingProjectKey: true,
  route: proxyUrl ? 'configured_proxy' : 'direct',
  model,
  transcriptionModel,
  candidate: 'gpt-realtime-translate',
  candidateNoiseReduction: requestedNoiseReduction ?? 'provider_default',
  limitMs: 100000,
  inputBytes: input.length,
  inputSha256: createHash('sha256').update(input).digest('hex'),
  format: 'PCMU_8000_mono',
  prefixSilenceMs: 300,
  suffixSilenceMs: 4000,
};
writeFileSync(
  resolve(outputRoot, 'attempt.json'),
  JSON.stringify(attempt, null, 2),
);
console.log(JSON.stringify({ phase: 'start', ...attempt }));
try {
  legacy.attach(
    'local',
    phones.local as unknown as WebSocket,
    'MZ_benchmark_local',
  );
  legacy.attach(
    'remote',
    phones.remote as unknown as WebSocket,
    'MZ_benchmark_remote',
  );
  await Promise.all([
    continuous.ready,
    waitFor(() => readyRoles.size === 2, 12000),
  ]);
  firstInputAtMs = now();
  const pacingStart = performance.now();
  for (let offset = 0; offset < source.length; offset += 160) {
    if (failure) throw new Error(failure);
    const targetTime = pacingStart + offset / 8;
    await delay(Math.max(0, targetTime - performance.now()));
    if (performance.now() - targetTime > 250)
      throw new Error('INPUT_PACING_STALL');
    const frame = source.subarray(offset, offset + 160);
    continuous.append(inputConverter.push(frame));
    newOutput.sentInputBytes += frame.length;
    phones[role].emit(
      'message',
      Buffer.from(
        JSON.stringify({
          event: 'media',
          streamSid: `MZ_benchmark_${role}`,
          media: { track: 'inbound', payload: frame.toString('base64') },
        }),
      ),
    );
    oldOutput.sentInputBytes += frame.length;
    if (offset < 2400 + input.length) lastSpeechFileFrameAtMs = now();
    lastInputAtMs = now();
  }
  // Stream close drains the candidate's remaining audio; it is not phone hangup.
  await continuous.finish();
  continuousFinished = true;
  if (!newOutput.deltas.length) throw new Error('NO_CONTINUOUS_AUDIO');
  // Drain the FIR's retained final samples exactly once after provider drain.
  // These eight milliseconds are measured and labelled as local padding.
  const drained = outputConverter.push(Buffer.alloc(384));
  candidateFilterDrainBytes = drained.length;
  receive(newOutput, drained);
  await waitFor(
    () =>
      oldCompletedResponses > 0 &&
      oldCommitted.size > 0 &&
      [...oldCommitted].every((id) => oldTranscribed.has(id)) &&
      oldCompletedResponses === oldNonempty.size &&
      Boolean(oldOutput.deltas.length) &&
      now() - oldOutput.deltas[oldOutput.deltas.length - 1].atMs > 3000,
    20000,
  );
} catch (error) {
  // Only known application codes are retained. Never log raw provider errors.
  const message = error instanceof Error ? error.message : '';
  failure ||= /^[A-Z_0-9:]+$/.test(message) ? message : 'EXPERIMENT_FAILED';
} finally {
  clearTimeout(limit);
  continuous.abort();
  legacy.close();
  const candidateRawPcm = Buffer.concat(candidateRawOutput);
  writeFileSync(
    resolve(outputRoot, 'continuous-provider-24k.wav'),
    wav(candidateRawPcm, 24000),
  );
  const summary = (label: string, out: Output) => {
    const bytes = Buffer.concat(out.bytes);
    const energyPlayback = analyzePcmuPlayback(bytes, out.deltas);
    const decoder = new PcmuToPcm24k();
    writeFileSync(resolve(outputRoot, `${label}.pcmu`), bytes);
    writeFileSync(
      resolve(outputRoot, `${label}.wav`),
      wav(decoder.push(Buffer.concat([bytes, Buffer.alloc(80, 255)])), 24000),
    );
    const first = out.deltas[0]?.atMs;
    return {
      sentInputBytes: out.sentInputBytes,
      outputBytes: bytes.length,
      outputDurationMs: bytes.length / 8,
      firstAudioAtMs: first,
      firstAudioAfterInputStartMs:
        first === undefined || firstInputAtMs === undefined
          ? null
          : Math.round(first - firstInputAtMs),
      firstAudioAfterSourceFileEndMs:
        first === undefined || lastSpeechFileFrameAtMs === undefined
          ? null
          : Math.round(first - lastSpeechFileFrameAtMs),
      lastAudioAtMs: out.deltas.at(-1)?.atMs,
      energyPlayback,
      estimatedFirstEnergyAfterInputStartMs:
        energyPlayback.firstEnergyAtMs === null || firstInputAtMs === undefined
          ? null
          : Math.round(energyPlayback.firstEnergyAtMs - firstInputAtMs),
      deltas: out.deltas,
      transcripts: out.transcripts,
    };
  };
  const result = {
    ...attempt,
    completedAt: new Date().toISOString(),
    elapsedMs: now(),
    failure: failure || null,
    continuousFinished,
    oldCompletedResponses,
    legacyObservedCommittedTurns: oldCommitted.size,
    legacyObservedFinalTranscripts: oldTranscribed.size,
    legacyObservedNonemptyTranscripts: oldNonempty.size,
    // The old protocol does not acknowledge a final input drain in this run.
    // Completing observed turns is not proof that every source word was heard.
    legacyFinalInputDrainConfirmed: false,
    candidateFilterDrainBytes,
    candidateRawOutput: {
      file: 'continuous-provider-24k.wav',
      format: 'PCM16LE_24000_mono',
      bytes: candidateRawPcm.length,
      durationMs: candidateRawPcm.length / 48,
      sha256: createHash('sha256').update(candidateRawPcm).digest('hex'),
      beforeTelephoneConversion: true,
      includesLocalFilterDrain: false,
    },
    firstInputAtMs,
    lastSpeechFileFrameAtMs,
    lastInputAtMs,
    legacy: summary('legacy', oldOutput),
    continuous: summary('continuous', newOutput),
    metrics,
    candidateFormats,
    limits: [
      'SYNTHETIC_TRANSPORT_NOT_PHONE',
      'FIRST_AUDIO_CHUNK_MAY_INCLUDE_SILENCE',
      'SOURCE_FILE_END_IS_NOT_LAST_SPOKEN_PHONEME',
      'TEXT_IS_DIAGNOSTIC_NOT_AUDIO_ACCEPTANCE',
      'LEGACY_OUTPUT_COMPLETENESS_REQUIRES_REVIEW',
      'NO_MEASURED_EAR_LATENCY',
      'ENERGY_TIMING_USES_THRESHOLD_AND_IDEAL_FIFO_NOT_SEMANTIC_ALIGNMENT',
    ],
  };
  writeFileSync(
    resolve(outputRoot, 'result.json'),
    JSON.stringify(result, null, 2),
  );
  const publicSummary = (out: typeof result.legacy) => ({
    inputBytes: out.sentInputBytes,
    outputBytes: out.outputBytes,
    outputDurationMs: out.outputDurationMs,
    firstAudioAfterInputStartMs: out.firstAudioAfterInputStartMs,
    firstAudioAfterSourceFileEndMs: out.firstAudioAfterSourceFileEndMs,
    estimatedFirstEnergyAfterInputStartMs:
      out.estimatedFirstEnergyAfterInputStartMs,
  });
  console.log(
    JSON.stringify({
      phase: 'complete',
      role,
      failure: result.failure,
      continuousFinished,
      legacy: publicSummary(result.legacy),
      continuous: publicSummary(result.continuous),
      realPhone: false,
    }),
  );
  if (failure) process.exitCode = 1;
}
