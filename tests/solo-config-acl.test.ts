import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigStore, restrictWindowsPrivateFile } from '../src/solo/config';

function powershell(path: string, script: string): string {
  return execFileSync(
    join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(
        `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n$path = $env:AI_PHONE_ACL_TEST_PATH\n${script}`,
        'utf16le',
      ).toString('base64'),
    ],
    {
      env: { ...process.env, AI_PHONE_ACL_TEST_PATH: path },
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
    },
  );
}
function assertPrivateAcl(path: string): void {
  const actual = JSON.parse(
    powershell(
      path,
      `
$acl = [System.IO.File]::GetAccessControl($path)
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{ Identity = $_.IdentityReference.Value; Inherited = $_.IsInherited; Access = $_.AccessControlType.ToString(); FullControl = (($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) } })
@{ Protected = $acl.AreAccessRulesProtected; CurrentUser = $user; Rules = $rules } | ConvertTo-Json -Depth 4 -Compress
`,
    ),
  );
  assert.equal(actual.Protected, true);
  const expected = [...new Set([actual.CurrentUser, 'S-1-5-18'])].sort();
  assert.deepEqual(
    [...new Set(actual.Rules.map((rule: any) => rule.Identity))].sort(),
    expected,
  );
  for (const rule of actual.Rules) {
    assert.equal(rule.Inherited, false);
    assert.equal(rule.Access, 'Allow');
    assert.equal(rule.FullControl, true);
  }
}

test(
  'Windows empty secret temp and repeated atomic env replacement allow only current user and SYSTEM',
  { skip: process.platform !== 'win32' },
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), "ai-phone-acl & '"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const emptyTemp = join(dir, 'empty-before-secret.tmp');
    writeFileSync(emptyTemp, '', { flag: 'wx' });
    restrictWindowsPrivateFile(emptyTemp);
    assert.equal(statSync(emptyTemp).size, 0);
    assertPrivateAcl(emptyTemp);

    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'OPENAI_API_KEY=synthetic-old-fixture\n');
    // Deliberately give the OLD fixture a broad explicit ACE. Replacement must
    // establish a fresh private DACL, not inherit this access or rely on chmod.
    powershell(
      envPath,
      `
$acl = [System.IO.File]::GetAccessControl($path)
$users = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($users, [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[System.IO.File]::SetAccessControl($path, $acl)
`,
    );
    const store = new ConfigStore({
      envPath,
      generateToken: false,
      values: {
        LOCAL_ACCESS_TOKEN: 'fixture-only-local-token-not-a-real-secret',
      },
    });
    store.save({ OPENAI_API_KEY: 'synthetic-new-fixture' });
    assertPrivateAcl(envPath);
    store.save({ OPENAI_REALTIME_MODEL: 'fixture-model' });
    assertPrivateAcl(envPath);
    assert.match(readFileSync(envPath, 'utf8'), /synthetic-new-fixture/);
    assert.deepEqual(readdirSync(dir).sort(), [
      '.env',
      'empty-before-secret.tmp',
    ]);
  },
);

test(
  'Windows ACL setup failure preserves the old env and removes the still-empty temporary file',
  { skip: process.platform !== 'win32' },
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-phone-acl-failure-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const envPath = join(dir, '.env');
    const original = 'OPENAI_API_KEY=synthetic-original-fixture\n';
    writeFileSync(envPath, original);
    const store = new ConfigStore({
      envPath,
      generateToken: false,
      values: {
        LOCAL_ACCESS_TOKEN: 'fixture-only-local-token-not-a-real-secret',
      },
    });
    let wasEmpty = false;
    const command = t.mock.method(
      childProcess,
      'execFileSync',
      (_file, _args, options: any) => {
        wasEmpty = statSync(options.env.AI_PHONE_PRIVATE_FILE_PATH).size === 0;
        throw new Error('fixture ACL setup failure');
      },
    );
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => store.save({ OPENAI_API_KEY: 'synthetic-replacement-fixture' }),
        /Private configuration write failed/,
      );
      assert.equal(command.mock.callCount(), 1);
      assert.equal(wasEmpty, true);
    } finally {
      command.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(readFileSync(envPath, 'utf8'), original);
    assert.deepEqual(readdirSync(dir), ['.env']);
  },
);
