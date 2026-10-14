import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ALIYUN_AUDITION_LIMITS,
  parseAliyunAuditionWave,
  prepareAliyunAuditionInput,
  readAliyunAuditionFile,
} from '../src/experiments/aliyun-audition-input';

function wave(seconds = 1, seed = 1): Buffer {
  const data = Buffer.alloc(seconds * 48000);
  data.writeInt16LE(seed, 0);
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(data.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

type ClipFixture = {
  id: string;
  role: string;
  wav: string;
  sha256: string;
  speechEndMs?: number;
};

function fixture(callback: (root: string, clips: ClipFixture[]) => void) {
  const root = mkdtempSync(join(tmpdir(), 'aliyun-audition-input-'));
  const clips = [
    {
      id: 'zh-one',
      role: 'local',
      wav: 'zh.wav',
      sha256: '',
      speechEndMs: 800,
    },
    {
      id: 'en-one',
      role: 'remote',
      wav: 'en.wav',
      sha256: '',
      speechEndMs: 900,
    },
  ];
  try {
    clips.forEach((clip, index) => {
      const bytes = wave(1, index + 1);
      writeFileSync(join(root, clip.wav), bytes);
      clip.sha256 = createHash('sha256').update(bytes).digest('hex');
    });
    callback(root, clips);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function manifest(root: string, clips: ClipFixture[], extra = {}): string {
  const path = join(root, 'input.json');
  writeFileSync(
    path,
    JSON.stringify({ version: 1, region: 'beijing', clips, ...extra }),
  );
  return path;
}

test('offline input binds both directions to exact WAV hashes and manual endpoints', () => {
  fixture((root, clips) => {
    const result = prepareAliyunAuditionInput(manifest(root, clips));
    assert.equal(result.totalSeconds, 2);
    assert.equal(result.region, 'beijing');
    assert.equal(result.clips[0].pcm.length, 48000);
    assert.equal(result.clips[0].speechEndMs, 800);
    assert.equal(result.clips[1].role, 'remote');
    assert.match(result.manifestSha256, /^[a-f0-9]{64}$/u);
    assert.equal(ALIYUN_AUDITION_LIMITS.inputSeconds, 24);
  });
});

test('absent manually marked endpoints stay unknown rather than inferred from silence', () => {
  fixture((root, clips) => {
    const noEndpoints = clips.map(({ speechEndMs: _omitted, ...clip }) => clip);
    assert.equal(
      prepareAliyunAuditionInput(manifest(root, noEndpoints)).clips[0]
        .speechEndMs,
      undefined,
    );
  });
});

test('input rejects changed recording hashes before any provider selection', () => {
  fixture((root, clips) => {
    clips[0].sha256 = '0'.repeat(64);
    assert.throws(
      () => prepareAliyunAuditionInput(manifest(root, clips)),
      /HASH_MISMATCH/u,
    );
  });
});

test('reusing the same recording as both speakers is rejected', () => {
  fixture((root, clips) => {
    clips[1].wav = clips[0].wav;
    clips[1].sha256 = clips[0].sha256;
    assert.throws(
      () => prepareAliyunAuditionInput(manifest(root, clips)),
      /DUPLICATE_SAMPLE/u,
    );
  });
});

test('input requires Chinese and English roles and rejects extra prompt/reference fields', () => {
  fixture((root, clips) => {
    assert.throws(
      () =>
        prepareAliyunAuditionInput(
          manifest(
            root,
            clips.map((clip) => ({ ...clip, role: 'local' })),
          ),
        ),
      /ENGLISH_SAMPLE_MISSING/u,
    );
    assert.throws(
      () =>
        prepareAliyunAuditionInput(
          manifest(root, clips, { referenceTranslation: 'Do not send.' }),
        ),
      /MANIFEST_INVALID/u,
    );
  });
});

test('all sent samples including quiet tails count toward the cumulative 24-second limit', () => {
  fixture((root, clips) => {
    const bytes = wave(24);
    writeFileSync(join(root, 'zh.wav'), bytes);
    clips[0].sha256 = createHash('sha256').update(bytes).digest('hex');
    assert.throws(
      () => prepareAliyunAuditionInput(manifest(root, clips)),
      /INPUT_LIMIT_EXCEEDED/u,
    );
  });
});

test('four-clip limit, duplicate source IDs and region validity are checked locally', () => {
  fixture((root, clips) => {
    assert.throws(
      () =>
        prepareAliyunAuditionInput(
          manifest(root, [...clips, ...clips, clips[0]]),
        ),
      /MANIFEST_INVALID/u,
    );
    assert.throws(
      () =>
        prepareAliyunAuditionInput(
          manifest(root, [clips[0], { ...clips[1], id: clips[0].id }]),
        ),
      /CLIP_INVALID/u,
    );
    assert.throws(
      () =>
        prepareAliyunAuditionInput(
          manifest(root, clips, { region: 'unknown' }),
        ),
      /MANIFEST_INVALID/u,
    );
  });
});

test('relative paths cannot escape a portable manifest directory', () => {
  fixture((root, clips) => {
    clips[0].wav = '../outside.wav';
    assert.throws(
      () => prepareAliyunAuditionInput(manifest(root, clips)),
      /PATH_OUTSIDE_MANIFEST/u,
    );
    clips[0].wav = '/tmp/outside.wav';
    assert.throws(
      () => prepareAliyunAuditionInput(manifest(root, clips)),
      /CLIP_INVALID/u,
    );
  });
});

test('symlink recordings and nonregular input files are refused without following them', () => {
  fixture((root, clips) => {
    symlinkSync('zh.wav', join(root, 'linked.wav'));
    clips[0].wav = 'linked.wav';
    assert.throws(
      () => prepareAliyunAuditionInput(manifest(root, clips)),
      /SYMLINK_FORBIDDEN/u,
    );
    assert.throws(
      () => readAliyunAuditionFile(root, 1024),
      /REGULAR_FILE_REQUIRED/u,
    );
  });
});

test('stereo, wrong rate, float encoding and malformed WAV lengths are rejected', () => {
  for (const [offset, value, kind] of [
    [22, 2, 16],
    [24, 16000, 32],
    [20, 3, 16],
    [4, 0, 32],
  ]) {
    const bytes = wave();
    if (kind === 16) bytes.writeUInt16LE(value, offset);
    else bytes.writeUInt32LE(value, offset);
    assert.throws(() => parseAliyunAuditionWave(bytes), /WAV_/u);
  }
});

test('manual endpoint outside the recording is rejected instead of producing false latency', () => {
  fixture((root, clips) => {
    clips[0].speechEndMs = 1001;
    assert.throws(
      () => prepareAliyunAuditionInput(manifest(root, clips)),
      /SPEECH_ENDPOINT_INVALID/u,
    );
  });
});
