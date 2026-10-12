import assert from 'node:assert/strict';
import { request } from 'node:http';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from 'dotenv';

import { startFixedVoiceIntake } from '../scripts/configure-fixed-voice-local';
import { restrictWindowsPrivateFile } from '../src/solo/config';
import {
  savePrivateVoiceConfig,
  validatePrivateVoiceValues,
  verifyPrivateVoicePath,
} from '../src/experiments/fixed-voice-private-config';

const KEY = 'test_fixture_credential_123456789';
function sandbox(): string {
  return mkdtempSync(path.join(tmpdir(), 'voice-intake-test-'));
}
function cleanup(root: string): void {
  assert.equal(realpathSync(root), root);
  assert.ok(root.startsWith(path.join(tmpdir(), 'voice-intake-test-')));
  rmSync(root, { recursive: true, force: true });
}
function secureEnv(root: string, text: string): string {
  const filename = path.join(root, '.env');
  writeFileSync(filename, '', { mode: 0o600 });
  if (process.platform === 'win32') restrictWindowsPrivateFile(filename);
  writeFileSync(filename, text);
  return filename;
}
function http(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; body: string; headers: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: options.method || 'GET', headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}
function tokenFrom(html: string): string {
  const value = /'X-Config-Token':'([a-f0-9]+)'/.exec(html)?.[1];
  assert.ok(value);
  return value;
}

test('private voice fields reject unknown keys, line breaks, invalid ids and key omission', () => {
  for (const input of [
    null,
    [],
    {},
    { ELEVENLABS_API_KEY: KEY, OPENAI_API_KEY: KEY },
    { ELEVENLABS_API_KEY: `${KEY}\nOTHER=1` },
    { ELEVENLABS_API_KEY: KEY, ELEVENLABS_VOICE_ID_EN: '../unsafe' },
    { ELEVENLABS_API_KEY: 'x'.repeat(1025) },
  ])
    assert.throws(() => validatePrivateVoiceValues(input));
  assert.deepEqual(
    validatePrivateVoiceValues({
      ELEVENLABS_API_KEY: KEY,
      ELEVENLABS_VOICE_ID_ZH: '',
    }),
    { ELEVENLABS_API_KEY: KEY },
  );
});

test('private save preserves unrelated bytes and existing secret, accepts exact repetition', () => {
  const root = sandbox();
  try {
    const prefix =
      '# retained comment\r\nOPENAI_API_KEY="unchanged_test"\r\nEXTRA=abc # keep\r\n';
    const filename = secureEnv(root, `${prefix}ELEVENLABS_API_KEY=\r\n`);
    savePrivateVoiceConfig(root, {
      ELEVENLABS_API_KEY: KEY,
      ELEVENLABS_VOICE_ID_EN: 'voice_en_123',
    });
    const saved = readFileSync(filename);
    assert.ok(saved.toString().startsWith(prefix));
    assert.equal(parse(saved).ELEVENLABS_API_KEY, KEY);
    assert.equal(parse(saved).OPENAI_API_KEY, 'unchanged_test');
    savePrivateVoiceConfig(root, { ELEVENLABS_API_KEY: KEY });
    assert.deepEqual(readFileSync(filename), saved);
    assert.throws(
      () =>
        savePrivateVoiceConfig(root, { ELEVENLABS_API_KEY: `${KEY}different` }),
      /EXISTING_VALUE_CONFLICT/,
    );
    assert.deepEqual(readFileSync(filename), saved);
  } finally {
    cleanup(root);
  }
});

test('duplicate empty variable cannot hide a nonempty value from overwrite protection', () => {
  const root = sandbox();
  try {
    const filename = secureEnv(
      root,
      `ELEVENLABS_API_KEY=${KEY}\nELEVENLABS_API_KEY=\n`,
    );
    const before = readFileSync(filename);
    assert.throws(
      () => savePrivateVoiceConfig(root, { ELEVENLABS_API_KEY: `${KEY}new` }),
      /EXISTING_VALUE_CONFLICT/,
    );
    assert.deepEqual(readFileSync(filename), before);
  } finally {
    cleanup(root);
  }
});

test('private path rejects junction ancestors and hard-linked env files', () => {
  const root = sandbox();
  const other = sandbox();
  try {
    symlinkSync(other, path.join(root, 'redirect'), 'junction');
    assert.throws(
      () => verifyPrivateVoicePath(path.join(root, 'redirect')),
      /UNSAFE_CONFIG_PATH/,
    );
    const original = path.join(root, 'original');
    writeFileSync(original, 'fixture');
    linkSync(original, path.join(root, '.env'));
    assert.throws(() => verifyPrivateVoicePath(root), /UNSAFE_CONFIG_PATH/);
  } finally {
    cleanup(root);
    cleanup(other);
  }
});

test(
  'Windows inherited config ACL blocks save without changing original',
  { skip: process.platform !== 'win32' },
  () => {
    const root = sandbox();
    try {
      const filename = path.join(root, '.env');
      writeFileSync(filename, 'OTHER=unchanged\n');
      assert.throws(
        () => savePrivateVoiceConfig(root, { ELEVENLABS_API_KEY: KEY }),
        /PRIVATE_CONFIG_WRITE_FAILED/,
      );
      assert.equal(readFileSync(filename, 'utf8'), 'OTHER=unchanged\n');
    } finally {
      cleanup(root);
    }
  },
);

test('intake requires random route, exact host/origin and a separate CSRF token', async () => {
  const root = sandbox();
  let writes = 0;
  const intake = await startFixedVoiceIntake({
    projectRoot: root,
    save: () => {
      writes += 1;
    },
  });
  try {
    const origin = new URL(intake.url).origin;
    assert.equal((await http(origin)).status, 404);
    assert.equal(
      (await http(intake.url, { headers: { Host: 'evil.invalid' } })).status,
      403,
    );
    assert.equal(
      (await http(intake.url, { headers: { Origin: 'https://evil.invalid' } }))
        .status,
      403,
    );
    assert.equal(
      (await http(intake.url, { headers: { 'X-Forwarded-For': '127.0.0.1' } }))
        .status,
      403,
    );
    const page = await http(intake.url);
    assert.equal(page.status, 200);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.ok(page.body.includes('type="password"'));
    const token = tokenFrom(page.body);
    const headers = {
      'Content-Type': 'application/json',
      'X-Config-Token': token,
    };
    assert.equal(
      (
        await http(`${intake.url}/save`, {
          method: 'POST',
          headers,
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await http(`${intake.url}/save`, {
          method: 'POST',
          headers: { ...headers, Origin: origin, 'X-Config-Token': 'wrong' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(writes, 0);
  } finally {
    intake.close();
    await intake.closed;
    cleanup(root);
  }
});

test('valid single-use submission does not echo key and closes the intake', async () => {
  const root = sandbox();
  let received: unknown;
  const intake = await startFixedVoiceIntake({
    projectRoot: root,
    save: (input) => {
      received = validatePrivateVoiceValues(input);
    },
  });
  try {
    const page = await http(intake.url);
    const result = await http(`${intake.url}/save`, {
      method: 'POST',
      headers: {
        Origin: new URL(intake.url).origin,
        'Content-Type': 'application/json',
        'X-Config-Token': tokenFrom(page.body),
      },
      body: JSON.stringify({ ELEVENLABS_API_KEY: KEY }),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body, '{"ok":true}');
    assert.deepEqual(received, { ELEVENLABS_API_KEY: KEY });
    assert.ok(!result.body.includes(KEY));
    await intake.closed;
    await assert.rejects(http(intake.url));
    assert.equal(existsSync(path.join(root, '.env')), false);
  } finally {
    intake.close();
    cleanup(root);
  }
});

test('oversized or malformed submissions never reach the save callback', async () => {
  const root = sandbox();
  let writes = 0;
  const intake = await startFixedVoiceIntake({
    projectRoot: root,
    save: () => {
      writes += 1;
    },
  });
  try {
    const page = await http(intake.url);
    const headers = {
      Origin: new URL(intake.url).origin,
      'Content-Type': 'application/json',
      'X-Config-Token': tokenFrom(page.body),
    };
    const bad = await http(`${intake.url}/save`, {
      method: 'POST',
      headers,
      body: '{',
    });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.includes('INVALID_JSON'));
    const big = await http(`${intake.url}/save`, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': '5000' },
      body: 'x'.repeat(5000),
    });
    assert.equal(big.status, 400);
    assert.ok(big.body.includes('BODY_TOO_LARGE'));
    assert.equal(writes, 0);
  } finally {
    intake.close();
    await intake.closed;
    cleanup(root);
  }
});

test('intake TTL closes service without writing configuration', async () => {
  const root = sandbox();
  const intake = await startFixedVoiceIntake({
    projectRoot: root,
    ttlMs: 30,
    save: () => assert.fail('unexpected write'),
  });
  try {
    await intake.closed;
    await assert.rejects(http(intake.url));
    assert.equal(existsSync(path.join(root, '.env')), false);
  } finally {
    intake.close();
    cleanup(root);
  }
});
