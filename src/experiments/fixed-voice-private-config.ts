/** Private configuration writer for the isolated fixed-voice lab only. */
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';

import { restrictWindowsPrivateFile } from '../solo/config';
import { validFixedVoiceId } from './elevenlabs-speech-client';

const NAMES = [
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID_EN',
  'ELEVENLABS_VOICE_ID_ZH',
] as const;
const MAX_ENV_BYTES = 256 * 1024;

export class PrivateVoiceConfigError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'PrivateVoiceConfigError';
  }
}

function fail(code: string): never {
  throw new PrivateVoiceConfigError(code);
}

export function validatePrivateVoiceValues(
  input: unknown,
): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail('INVALID_FIELDS');
  const values: Record<string, string> = {};
  for (const [name, raw] of Object.entries(input)) {
    if (!NAMES.includes(name as (typeof NAMES)[number])) fail('INVALID_FIELDS');
    if (typeof raw !== 'string' || raw.length > 1024 || /[\r\n\0]/.test(raw))
      fail('INVALID_FIELDS');
    const value = raw.trim();
    if (value) values[name] = value;
  }
  if (!/^[A-Za-z0-9_-]{20,1024}$/.test(values.ELEVENLABS_API_KEY || ''))
    fail('INVALID_KEY');
  for (const name of NAMES.slice(1)) {
    if (values[name] && !validFixedVoiceId(values[name]))
      fail('INVALID_VOICE_ID');
  }
  return values;
}

/** Check every existing ancestor, including the repository itself. */
export function verifyPrivateVoicePath(projectRoot: string): string {
  const root = path.resolve(projectRoot);
  let current = root;
  for (;;) {
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      fail('UNSAFE_CONFIG_PATH');
    if (realpathSync(current).toLowerCase() !== current.toLowerCase())
      fail('UNSAFE_CONFIG_PATH');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const envPath = path.join(root, '.env');
  let envInfo: ReturnType<typeof lstatSync>;
  try {
    envInfo = lstatSync(envPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (envInfo) {
    const info = envInfo;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      fail('UNSAFE_CONFIG_PATH');
    if (info.size > MAX_ENV_BYTES) fail('CONFIG_TOO_LARGE');
  }
  return envPath;
}

/** Preserve the existing protected DACL, rejecting permissive source files. */
function preserveWindowsAcl(source: string, target: string): void {
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = [System.IO.File]::GetAccessControl($env:AI_PHONE_VOICE_SOURCE)
$allowed = @($user.Value, $system.Value)
if (-not $acl.AreAccessRulesProtected) { throw 'Unsafe ACL' }
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
foreach ($rule in $rules) {
  if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin $allowed) { throw 'Unsafe ACL' }
}
foreach ($identity in $allowed) {
  if (-not ($rules | Where-Object { $_.IdentityReference.Value -eq $identity -and ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl })) { throw 'Unsafe ACL' }
}
[System.IO.File]::SetAccessControl($env:AI_PHONE_VOICE_TARGET, $acl)
$actual = [System.IO.File]::GetAccessControl($env:AI_PHONE_VOICE_TARGET)
$section = [System.Security.AccessControl.AccessControlSections]::Access
if ($actual.GetSecurityDescriptorSddlForm($section) -ne $acl.GetSecurityDescriptorSddlForm($section)) { throw 'ACL mismatch' }
`;
  execFileSync(
    path.join(
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
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      env: {
        ...process.env,
        AI_PHONE_VOICE_SOURCE: source,
        AI_PHONE_VOICE_TARGET: target,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      maxBuffer: 65_536,
    },
  );
}

/** Never returns values or touches any phone setting. Existing values are immutable. */
export function savePrivateVoiceConfig(
  projectRoot: string,
  input: unknown,
): void {
  const values = validatePrivateVoiceValues(input);
  let temp: string | undefined;
  try {
    const envPath = verifyPrivateVoicePath(projectRoot);
    const existed = existsSync(envPath);
    const original = existed ? readFileSync(envPath) : Buffer.alloc(0);
    if (!Buffer.from(original.toString('utf8')).equals(original))
      fail('INVALID_CONFIG_ENCODING');
    const disk = parse(original);
    const additions: string[] = [];
    for (const [name, value] of Object.entries(values)) {
      // Do not let a later empty duplicate hide an existing nonempty value.
      for (const line of original.toString('utf8').split(/\r?\n/)) {
        const previous = parse(line)[name];
        if (previous && previous !== value) fail('EXISTING_VALUE_CONFLICT');
      }
      if (disk[name] && disk[name] !== value) fail('EXISTING_VALUE_CONFLICT');
      if (!disk[name]) additions.push(`${name}=${JSON.stringify(value)}`);
    }
    if (!additions.length) return;
    // Append after optional empty placeholders; dotenv reads the last value.
    // Preserve every existing byte, including multiline values and comments.
    const text = original.toString('utf8');
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const output = `${text}${text && !text.endsWith('\n') ? newline : ''}${additions.join(newline)}${newline}`;
    if (Buffer.byteLength(output) > MAX_ENV_BYTES) fail('CONFIG_TOO_LARGE');
    temp = `${envPath}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
    writeFileSync(temp, '', { flag: 'wx', mode: 0o600 });
    if (process.platform === 'win32') {
      restrictWindowsPrivateFile(temp);
      if (existed) preserveWindowsAcl(envPath, temp);
      // eslint-disable-next-line no-bitwise -- Inspect POSIX group and other access bits.
    } else if (existed && (lstatSync(envPath).mode & 0o077) !== 0) {
      fail('UNSAFE_CONFIG_PERMISSIONS');
    }
    const info = lstatSync(temp);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      fail('UNSAFE_CONFIG_PATH');
    writeFileSync(temp, output, { flag: 'r+' });
    verifyPrivateVoicePath(projectRoot);
    if (
      existsSync(envPath) !== existed ||
      (existed && !readFileSync(envPath).equals(original))
    )
      fail('CONFIG_CHANGED_DURING_SAVE');
    renameSync(temp, envPath);
    temp = undefined;
  } catch (error) {
    if (error instanceof PrivateVoiceConfigError) throw error;
    fail('PRIVATE_CONFIG_WRITE_FAILED');
  } finally {
    if (temp) {
      try {
        unlinkSync(temp);
      } catch {
        /* No credential-bearing diagnostics. */
      }
    }
  }
}
