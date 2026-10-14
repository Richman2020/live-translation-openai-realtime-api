import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { prepareAuditionInput } from '../src/experiments/realtime-audition-input';

function pcm(ms: number, amplitude = 2500): Buffer {
  const output = Buffer.alloc(ms * 48);
  for (let index = 0; index < output.length; index += 2)
    output.writeInt16LE(amplitude, index);
  return output;
}

function chunk(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(name);
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
}

function wave(audio: Buffer, extra: Buffer[] = []): Buffer {
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(24000, 4);
  format.writeUInt32LE(48000, 8);
  format.writeUInt16LE(2, 12);
  format.writeUInt16LE(16, 14);
  const chunks = Buffer.concat([
    chunk('fmt ', format),
    ...extra,
    chunk('data', audio),
  ]);
  const header = Buffer.alloc(12);
  header.write('RIFF');
  header.writeUInt32LE(chunks.length + 4, 4);
  header.write('WAVE', 8);
  return Buffer.concat([header, chunks]);
}

function fixture(
  context: TestContext,
  audio = pcm(1000),
  extra: Buffer[] = [],
) {
  const directory = mkdtempSync(join(tmpdir(), 'audition-input-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const wavPath = join(directory, 'input.wav');
  const manifestPath = join(directory, 'manifest.json');
  let wav = wave(audio, extra);
  const manifest = {
    version: 1,
    sourceKind: 'self-recorded-test',
    sourceDescription: 'Offline synthetic test fixture; no real speech.',
    rightsConfirmed: true,
    voiceConsentConfirmed: true,
    containsRealCall: false,
    file: {
      path: 'input.wav',
      sha256: createHash('sha256').update(wav).digest('hex'),
    },
    segments: [
      {
        id: 'sample-1',
        startSample: 0,
        endSample: audio.length / 2,
        sourceText: '你好，这是离线测试占位。',
      },
    ],
  };
  const save = () => {
    writeFileSync(wavPath, wav);
    writeFileSync(manifestPath, JSON.stringify(manifest));
  };
  const replaceWave = (replacement: Buffer) => {
    wav = replacement;
    manifest.file.sha256 = createHash('sha256').update(wav).digest('hex');
    save();
  };
  save();
  return { directory, wavPath, manifestPath, manifest, save, replaceWave };
}

test('preflight accepts canonical PCM24k mono16LE and derives exact source samples without credentials', (context) => {
  const input = pcm(1000);
  const setup = fixture(context, input);
  const prepared = prepareAuditionInput(setup.manifestPath);
  assert.deepEqual(prepared.pcm, input);
  assert.equal(prepared.sampleRate, 24000);
  assert.equal(prepared.totalSamples, 24000);
  assert.equal(prepared.totalSeconds, 1);
  assert.equal(prepared.preflightCommits, 1);
  assert.equal(prepared.preflightSubmittedSamples, 24000);
  assert.deepEqual(prepared.preflightCommitSamples, [24000]);
  assert.deepEqual(prepared.preflightSources, [
    { sequence: 1, startSample: 0, endSample: 24000, pcmBytes: 48000 },
  ]);
  assert.deepEqual(prepared.segments[0].pcm, input);
  assert.equal(prepared.manifestPath, setup.manifestPath);
  assert.equal(prepared.wavPath, setup.wavPath);
});

test('bounded RIFF chunks with odd-byte padding are skipped, never submitted as source audio', (context) => {
  const input = pcm(1000);
  const setup = fixture(context, input, [chunk('JUNK', Buffer.from('abc'))]);
  assert.deepEqual(prepareAuditionInput(setup.manifestPath).pcm, input);
});

test('selected source segments are concatenated in sample order without unselected gaps', (context) => {
  const setup = fixture(
    context,
    Buffer.concat([pcm(500), pcm(1000, 0), pcm(500, 1500)]),
  );
  setup.manifest.segments = [
    { id: 'first', startSample: 0, endSample: 12000, sourceText: '第一句。' },
    {
      id: 'second',
      startSample: 36000,
      endSample: 48000,
      sourceText: '第二句。',
    },
  ];
  setup.save();
  const result = prepareAuditionInput(setup.manifestPath);
  assert.deepEqual(result.pcm, Buffer.concat([pcm(500), pcm(500, 1500)]));
  assert.equal(result.totalSamples, 24000);
  assert.equal(result.preflightCommits, 1);
  assert.deepEqual(
    result.segments.map((item) => item.id),
    ['first', 'second'],
  );
});

test('exactly 24 seconds produces six four-second commits and one extra sample is rejected', (context) => {
  const setup = fixture(context, pcm(24000));
  const accepted = prepareAuditionInput(setup.manifestPath);
  assert.equal(accepted.preflightCommits, 6);
  assert.deepEqual(accepted.preflightCommitSamples, Array(6).fill(96000));
  setup.replaceWave(wave(Buffer.concat([pcm(24000), Buffer.alloc(2)])));
  assert.throws(
    () => prepareAuditionInput(setup.manifestPath),
    /AUDITION_INPUT_SOURCE_EXCEEDS_24_SECONDS/,
  );
});

test('more than six pause-driven commits are rejected even below 24 seconds', (context) => {
  const setup = fixture(
    context,
    Buffer.concat(
      Array.from({ length: 7 }, () => Buffer.concat([pcm(600), pcm(600, 0)])),
    ),
  );
  assert.throws(
    () => prepareAuditionInput(setup.manifestPath),
    /AUDITION_INPUT_MORE_THAN_6_COMMITS/,
  );
});

test('all-silent input is rejected without inventing speech or adding padding', (context) => {
  const setup = fixture(context, pcm(1000, 0));
  assert.throws(
    () => prepareAuditionInput(setup.manifestPath),
    /AUDITION_INPUT_NO_SUBMITTABLE_AUDIO/,
  );
});

test('consent, provenance, version and reference-answer fields are strict', (context) => {
  const setup = fixture(context);
  const original = JSON.parse(JSON.stringify(setup.manifest));
  const changes: Record<string, unknown>[] = [
    { version: 2 },
    { sourceKind: 'real-call' },
    { sourceDescription: ' ' },
    { rightsConfirmed: false },
    { voiceConsentConfirmed: false },
    { containsRealCall: true },
    { referenceTranslation: 'Hello.' },
  ];
  for (const change of changes) {
    writeFileSync(
      setup.manifestPath,
      JSON.stringify({ ...original, ...change }),
    );
    assert.throws(
      () => prepareAuditionInput(setup.manifestPath),
      /AUDITION_INPUT_MANIFEST_OR_CONSENT/,
    );
  }
});

test('reference answers in source segments are rejected instead of reaching model input', (context) => {
  const setup = fixture(context);
  writeFileSync(
    setup.manifestPath,
    JSON.stringify({
      ...setup.manifest,
      segments: [
        { ...setup.manifest.segments[0], expectedTranslation: 'Hello.' },
      ],
    }),
  );
  assert.throws(
    () => prepareAuditionInput(setup.manifestPath),
    /AUDITION_INPUT_INVALID_OR_UNORDERED_SEGMENT/,
  );
});

test('wrong hash and extra file-manifest fields are rejected', (context) => {
  const setup = fixture(context);
  setup.manifest.file.sha256 = '0'.repeat(64);
  setup.save();
  assert.throws(
    () => prepareAuditionInput(setup.manifestPath),
    /AUDITION_INPUT_SHA256_MISMATCH/,
  );
  writeFileSync(
    setup.manifestPath,
    JSON.stringify({
      ...setup.manifest,
      file: { ...setup.manifest.file, expectedText: 'not accepted' },
    }),
  );
  assert.throws(
    () => prepareAuditionInput(setup.manifestPath),
    /AUDITION_INPUT_FILE_MANIFEST/,
  );
});

test('absolute paths, traversal, alternate separators and non-WAV source files are rejected', (context) => {
  const setup = fixture(context);
  for (const path of [
    setup.wavPath,
    '../input.wav',
    'nested/../../input.wav',
    'nested\\input.wav',
    'C:input.wav',
    './input.wav',
    'nested//input.wav',
    'input.pcm',
  ]) {
    setup.manifest.file.path = path;
    setup.save();
    assert.throws(
      () => prepareAuditionInput(setup.manifestPath),
      /AUDITION_INPUT_RELATIVE_WAVE_PATH_REQUIRED/,
    );
  }
});

test('symbolic manifest, source and parent paths are rejected even for in-root targets', (context) => {
  const setup = fixture(context);
  const manifestLink = join(setup.directory, 'link.json');
  symlinkSync(setup.manifestPath, manifestLink);
  assert.throws(
    () => prepareAuditionInput(manifestLink),
    /AUDITION_INPUT_SYMLINK_FORBIDDEN/,
  );
  symlinkSync(setup.wavPath, join(setup.directory, 'link.wav'));
  setup.manifest.file.path = 'link.wav';
  setup.save();
  assert.throws(
    () => prepareAuditionInput(setup.manifestPath),
    /AUDITION_INPUT_SYMLINK_FORBIDDEN/,
  );
  symlinkSync(setup.directory, join(setup.directory, 'linked-directory'));
  assert.throws(
    () =>
      prepareAuditionInput(
        join(setup.directory, 'linked-directory', 'manifest.json'),
      ),
    /AUDITION_INPUT_SYMLINK_FORBIDDEN/,
  );
});

test('directories, missing files, oversized manifests and malformed JSON have fixed failures', (context) => {
  const setup = fixture(context);
  mkdirSync(join(setup.directory, 'directory.json'));
  assert.throws(
    () => prepareAuditionInput(join(setup.directory, 'directory.json')),
    /AUDITION_INPUT_REGULAR_FILE_REQUIRED/,
  );
  assert.throws(
    () => prepareAuditionInput(join(setup.directory, 'missing.json')),
    /AUDITION_INPUT_FILE_UNREADABLE/,
  );
  writeFileSync(setup.manifestPath, 'x'.repeat(128 * 1024 + 1));
  assert.throws(
    () => prepareAuditionInput(setup.manifestPath),
    /AUDITION_INPUT_FILE_SIZE/,
  );
  writeFileSync(setup.manifestPath, '{');
  assert.throws(
    () => prepareAuditionInput(setup.manifestPath),
    /AUDITION_INPUT_INVALID_MANIFEST_JSON/,
  );
});

test('non-PCM, stereo, wrong rate, wrong byte rate or block alignment, and float input are rejected', (context) => {
  const setup = fixture(context);
  for (const [offset, value, width] of [
    [20, 3, 2],
    [22, 2, 2],
    [24, 48000, 4],
    [28, 24000, 4],
    [32, 4, 2],
    [34, 32, 2],
  ]) {
    const changed = wave(pcm(1000));
    if (width === 2) changed.writeUInt16LE(value, offset);
    else changed.writeUInt32LE(value, offset);
    setup.replaceWave(changed);
    assert.throws(
      () => prepareAuditionInput(setup.manifestPath),
      /AUDITION_INPUT_PCM24K_MONO16LE_REQUIRED/,
    );
  }
});

test('truncated, oversized and duplicate RIFF chunks cannot bypass WAV validation', (context) => {
  const setup = fixture(context);
  const truncated = wave(pcm(1000)).subarray(0, -1);
  setup.replaceWave(truncated);
  assert.throws(
    () => prepareAuditionInput(setup.manifestPath),
    /AUDITION_INPUT_INVALID_WAVE/,
  );
  const overrun = wave(pcm(1000));
  overrun.writeUInt32LE(0xffffffff, 40);
  setup.replaceWave(overrun);
  assert.throws(
    () => prepareAuditionInput(setup.manifestPath),
    /AUDITION_INPUT_INVALID_WAVE_CHUNK/,
  );
  setup.replaceWave(wave(pcm(1000), [chunk('data', pcm(100))]));
  assert.throws(
    () => prepareAuditionInput(setup.manifestPath),
    /AUDITION_INPUT_DUPLICATE_WAVE_CHUNK/,
  );
  setup.replaceWave(wave(Buffer.alloc(3)));
  assert.throws(
    () => prepareAuditionInput(setup.manifestPath),
    /AUDITION_INPUT_PCM24K_MONO16LE_REQUIRED/,
  );
});

test('out-of-range, overlapping, duplicate, too-short and unordered source selections are rejected', (context) => {
  const setup = fixture(context);
  const original = setup.manifest.segments[0];
  const cases = [
    [{ ...original, startSample: -1 }],
    [{ ...original, startSample: 0.5 }],
    [{ ...original, endSample: 24001 }],
    [{ ...original, endSample: 2399 }],
    [{ ...original, sourceText: '' }],
    [original, { ...original }],
    [
      { ...original, startSample: 10000, endSample: 15000 },
      { ...original, id: 'second', startSample: 0, endSample: 10000 },
    ],
    [
      { ...original, endSample: 15000 },
      { ...original, id: 'second', startSample: 10000 },
    ],
  ];
  for (const segments of cases) {
    setup.manifest.segments = segments;
    setup.save();
    assert.throws(
      () => prepareAuditionInput(setup.manifestPath),
      /AUDITION_INPUT_INVALID_OR_UNORDERED_SEGMENT/,
    );
  }
});

test('100ms source is accepted but empty or more than six segment selections are rejected', (context) => {
  const setup = fixture(context, pcm(100));
  assert.equal(prepareAuditionInput(setup.manifestPath).preflightCommits, 1);
  for (const segments of [[], Array(7).fill(setup.manifest.segments[0])]) {
    setup.manifest.segments = segments;
    setup.save();
    assert.throws(
      () => prepareAuditionInput(setup.manifestPath),
      /AUDITION_INPUT_SEGMENTS_REQUIRED_MAX_6/,
    );
  }
});
