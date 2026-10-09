import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  loadPhoneRuntime,
  parsePhoneRuntime,
  requireLocalPhoneRuntime,
} from '../src/solo/cloud-runtime';
import { ConfigStore } from '../src/solo/config';
import { buildSoloServer } from '../src/solo/server';

const cloudEnv = {
  AI_PHONE_RUNTIME_MODE: 'cloud',
  PORT: '8080',
  CLOUD_PUBLIC_ORIGIN: 'https://phone.example.com/',
};

test('local is the default and platform PORT does not change its existing settings', () => {
  assert.deepEqual(parsePhoneRuntime({}), { mode: 'local' });
  const local = parsePhoneRuntime({
    AI_PHONE_RUNTIME_MODE: 'local',
    PORT: 'not-a-local-port',
    CLOUD_PUBLIC_ORIGIN: 'http://ignored-in-local-mode.invalid',
  });
  assert.deepEqual(local, { mode: 'local' });
  assert.doesNotThrow(() => requireLocalPhoneRuntime(local));
  assert.throws(
    () => parsePhoneRuntime({ AI_PHONE_RUNTIME_MODE: 'Cloud' }),
    /INVALID_AI_PHONE_RUNTIME_MODE/,
  );
});

test('cloud plan pins HTTPS and WSS origin, platform PORT and one warm instance', () => {
  const runtime = parsePhoneRuntime(cloudEnv);
  assert.deepEqual(runtime, {
    mode: 'cloud',
    host: '0.0.0.0',
    port: 8080,
    publicOrigin: 'https://phone.example.com',
    mediaOrigin: 'wss://phone.example.com',
    warmInstances: 1,
  });
  assert.throws(
    () => requireLocalPhoneRuntime(runtime),
    /CLOUD_AUTH_NOT_IMPLEMENTED/,
  );
  for (const PORT of ['', '0', '65536', '8080abc', '3.5', '-1'])
    assert.throws(
      () => parsePhoneRuntime({ ...cloudEnv, PORT }),
      /INVALID_CLOUD_PORT/,
    );
  for (const PORT of ['1', '443', '65535'])
    assert.equal(parsePhoneRuntime({ ...cloudEnv, PORT }).mode, 'cloud');
  for (const CLOUD_WARM_INSTANCES of ['0', '2', 'auto'])
    assert.throws(
      () => parsePhoneRuntime({ ...cloudEnv, CLOUD_WARM_INSTANCES }),
      /CLOUD_REQUIRES_SINGLE_WARM_INSTANCE/,
    );
});

test('cloud origin rejects credentials, insecure protocols and non-origin components without echoing values', () => {
  for (const CLOUD_PUBLIC_ORIGIN of [
    '',
    'http://phone.example.com',
    'wss://phone.example.com',
    'https://fixture-secret@phone.example.com',
    'https://phone.example.com/private',
    'https://phone.example.com/?secret=fixture-secret',
    'https://phone.example.com/#fixture-secret',
    'https://localhost',
    'https://127.0.0.1',
    'https://127.0.0.2',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://0.0.0.0',
    'https://[::]',
    'https://phone.localhost',
    'https://*.example.com',
  ])
    assert.throws(
      () => parsePhoneRuntime({ ...cloudEnv, CLOUD_PUBLIC_ORIGIN }),
      { message: 'INVALID_CLOUD_PUBLIC_ORIGIN' },
    );
});

test('private file cloud mode is honored and explicit environment mode takes precedence', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-phone-cloud-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envPath = join(dir, '.env');
  writeFileSync(
    envPath,
    Object.entries(cloudEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );
  const runtime = loadPhoneRuntime({ envPath, environment: {} });
  assert.equal(runtime.mode, 'cloud');
  assert.throws(
    () => requireLocalPhoneRuntime(runtime),
    /CLOUD_AUTH_NOT_IMPLEMENTED/,
  );
  assert.deepEqual(
    loadPhoneRuntime({
      envPath,
      environment: { AI_PHONE_RUNTIME_MODE: 'local' },
    }),
    { mode: 'local' },
  );
});

test('exported server builder refuses cloud mode before exposing routes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-phone-cloud-builder-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envPath = join(dir, '.env');
  writeFileSync(
    envPath,
    Object.entries(cloudEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );
  const configStore = new ConfigStore({ envPath, generateToken: false });
  await assert.rejects(
    buildSoloServer({ configStore }),
    /CLOUD_AUTH_NOT_IMPLEMENTED/,
  );
  assert.equal(configStore.value.LOCAL_ACCESS_TOKEN, '');
});

test('solo process refuses cloud mode before writing local secrets or listening', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-phone-cloud-process-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      createRequire(import.meta.url).resolve('tsx'),
      fileURLToPath(new URL('../src/solo/index.ts', import.meta.url)),
    ],
    {
      cwd: dir,
      env: { ...process.env, ...cloudEnv },
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.equal(child.error, undefined);
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /CLOUD_AUTH_NOT_IMPLEMENTED/);
  assert.equal(child.stdout, '');
  assert.equal(existsSync(join(dir, '.env')), false);
});
