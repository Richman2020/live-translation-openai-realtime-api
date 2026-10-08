import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'dotenv';

import { validOpenAIProxyUrl } from './openai-websocket';

export const TRANSCRIPTION_MODELS = [
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
  'whisper-1',
] as const;
export const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-1';
export function validTranscriptionModel(value: unknown): boolean {
  return TRANSCRIPTION_MODELS.includes(
    value as (typeof TRANSCRIPTION_MODELS)[number],
  );
}

export const SETTING_NAMES = [
  'API_PORT',
  'API_HOST',
  'PUBLIC_BASE_URL',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_TWIML_APP_SID',
  'TWILIO_CALLER_NUMBER',
  'OPENAI_API_KEY',
  'OPENAI_REALTIME_MODEL',
  'OPENAI_TRANSCRIPTION_MODEL',
  'OPENAI_PROXY_URL',
  'LOCAL_ACCESS_TOKEN',
] as const;
export type SettingName = (typeof SETTING_NAMES)[number];
export type SoloConfig = Record<SettingName, string>;
export type ConfigCheck = {
  name: SettingName;
  status: 'ready' | 'missing' | 'invalid';
};
const required: SettingName[] = [
  'PUBLIC_BASE_URL',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_TWIML_APP_SID',
  'TWILIO_CALLER_NUMBER',
  'OPENAI_API_KEY',
  'OPENAI_REALTIME_MODEL',
  'OPENAI_TRANSCRIPTION_MODEL',
  'LOCAL_ACCESS_TOKEN',
];
const placeholder =
  /placeholder|replace[-_ ]|your[-_ ]|XXXXX|^AC0+$|^SK0+$|^AP0+$/i;

/** Restrict and verify an EMPTY temporary file before putting any secret in it. */
export function restrictWindowsPrivateFile(path: string): void {
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$path = $env:AI_PHONE_PRIVATE_FILE_PATH
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = [System.Security.AccessControl.FileSecurity]::new()
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
foreach ($identity in @($user, $system)) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
[System.IO.File]::SetAccessControl($path, $acl)
$actual = [System.IO.File]::GetAccessControl($path)
if (-not $actual.AreAccessRulesProtected) { throw 'Unprotected private file' }
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$allowed = @($user.Value, $system.Value)
foreach ($rule in $rules) {
  if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin $allowed) { throw 'Unexpected private file permission' }
}
foreach ($identity in $allowed) {
  if (-not ($rules | Where-Object { $_.IdentityReference.Value -eq $identity -and ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl })) { throw 'Missing private file permission' }
}
`;
  // The command contains no file contents or credentials. Only a literal path is
  // passed via an environment variable, so quotes/metacharacters cannot be code.
  execFileSync(
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
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      env: { ...process.env, AI_PHONE_PRIVATE_FILE_PATH: path },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
      maxBuffer: 65536,
    },
  );
}

export function validPublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
export function checkConfig(config: SoloConfig): ConfigCheck[] {
  const checks: ConfigCheck[] = required.map((name) => {
    const value = config[name] || '';
    if (!value || placeholder.test(value)) return { name, status: 'missing' };
    let valid = true;
    if (name === 'PUBLIC_BASE_URL') valid = validPublicUrl(value);
    if (name === 'TWILIO_ACCOUNT_SID') valid = /^AC[0-9a-f]{32}$/i.test(value);
    if (name === 'TWILIO_API_KEY_SID') valid = /^SK[0-9a-f]{32}$/i.test(value);
    if (name === 'TWILIO_TWIML_APP_SID')
      valid = /^AP[0-9a-f]{32}$/i.test(value);
    if (name === 'TWILIO_CALLER_NUMBER')
      valid = /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(value);
    if (name === 'TWILIO_AUTH_TOKEN') valid = /^[0-9a-f]{32}$/i.test(value);
    if (name === 'TWILIO_API_KEY_SECRET') valid = value.length >= 20;
    if (name === 'OPENAI_API_KEY')
      valid = value.startsWith('sk-') && value.length >= 20;
    if (name === 'OPENAI_TRANSCRIPTION_MODEL')
      valid = validTranscriptionModel(value);
    if (name === 'LOCAL_ACCESS_TOKEN') valid = value.length >= 32;
    return { name, status: valid ? 'ready' : 'invalid' };
  });
  if (config.OPENAI_PROXY_URL)
    checks.push({
      name: 'OPENAI_PROXY_URL',
      status: validOpenAIProxyUrl(config.OPENAI_PROXY_URL)
        ? 'ready'
        : 'invalid',
    });
  return checks;
}

export class ConfigStore {
  readonly envPath: string;

  private current: SoloConfig;

  constructor(
    options: {
      envPath?: string;
      values?: Partial<SoloConfig>;
      generateToken?: boolean;
    } = {},
  ) {
    this.envPath = options.envPath || resolve('.env');
    if (existsSync(this.envPath) && lstatSync(this.envPath).isSymbolicLink())
      throw new Error('Configuration must not be a symbolic link');
    const disk = existsSync(this.envPath)
      ? parse(readFileSync(this.envPath))
      : {};
    this.current = Object.fromEntries(
      SETTING_NAMES.map((name) => [
        name,
        options.values?.[name] ?? process.env[name] ?? disk[name] ?? '',
      ]),
    ) as SoloConfig;
    this.current.API_PORT ||= '5050';
    this.current.API_HOST ||= '127.0.0.1';
    this.current.OPENAI_REALTIME_MODEL ||= 'gpt-realtime-1.5';
    this.current.OPENAI_TRANSCRIPTION_MODEL ||= DEFAULT_TRANSCRIPTION_MODEL;
    this.current.PUBLIC_BASE_URL = this.current.PUBLIC_BASE_URL.replace(
      /\/$/,
      '',
    );
    if (!this.current.LOCAL_ACCESS_TOKEN && options.generateToken !== false)
      this.save({ LOCAL_ACCESS_TOKEN: randomBytes(32).toString('hex') });
  }

  get value(): SoloConfig {
    return { ...this.current };
  }

  checks(): ConfigCheck[] {
    return checkConfig(this.current);
  }

  configured(): boolean {
    return this.checks().every((check) => check.status === 'ready');
  }

  save(input: Record<string, unknown>): void {
    if (existsSync(this.envPath) && lstatSync(this.envPath).isSymbolicLink())
      throw new Error('Configuration must not be a symbolic link');
    const next = { ...this.current };
    const accepted: Partial<SoloConfig> = {};
    for (const [name, raw] of Object.entries(input)) {
      if (!SETTING_NAMES.includes(name as SettingName))
        throw new Error('Unknown configuration field');
      if (typeof raw !== 'string' || raw.length > 4096 || /[\r\n\0]/.test(raw))
        throw new Error('Invalid configuration value');
      const value = raw.trim();
      if (
        name === 'OPENAI_TRANSCRIPTION_MODEL' &&
        !validTranscriptionModel(value)
      )
        throw new Error('INVALID_OPENAI_TRANSCRIPTION_MODEL');
      // Blank secrets stay unchanged; an explicitly blank proxy restores direct access.
      // eslint-disable-next-line no-continue
      if (!value && name !== 'OPENAI_PROXY_URL') continue;
      if (name === 'API_HOST' && !['127.0.0.1', '::1'].includes(value))
        throw new Error('API_HOST must be loopback');
      if (
        name === 'API_PORT' &&
        (!/^\d+$/.test(value) || +value < 1024 || +value > 65535)
      )
        throw new Error('Invalid API_PORT');
      if (name === 'PUBLIC_BASE_URL' && !validPublicUrl(value))
        throw new Error('PUBLIC_BASE_URL must be an HTTPS origin');
      if (name === 'OPENAI_PROXY_URL' && value && !validOpenAIProxyUrl(value))
        throw new Error('OPENAI_PROXY_URL must be an HTTP or HTTPS origin');
      if (name === 'LOCAL_ACCESS_TOKEN' && value.length < 32)
        throw new Error('LOCAL_ACCESS_TOKEN must have at least 32 characters');
      accepted[name as SettingName] =
        name === 'PUBLIC_BASE_URL' ? value.replace(/\/$/, '') : value;
      next[name as SettingName] = accepted[name as SettingName];
    }
    const text = existsSync(this.envPath)
      ? readFileSync(this.envPath, 'utf8')
      : '';
    let lines = text.split(/\r?\n/);
    for (const [name, value] of Object.entries(accepted)) {
      lines = lines.filter(
        (line) => !new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line),
      );
      // dotenv double-quoted strings support escaped quotes; no interpolation is used.
      lines.push(`${name}=${JSON.stringify(value)}`);
    }
    const temp = `${this.envPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      // NTFS rename preserves the temporary file's DACL, not the replaced file's.
      // Create it empty, secure it, and only then write the secret-bearing text.
      writeFileSync(temp, '', { mode: 0o600, flag: 'wx' });
      if (process.platform === 'win32') restrictWindowsPrivateFile(temp);
      if (lstatSync(temp).isSymbolicLink() || !lstatSync(temp).isFile())
        throw new Error('Invalid temporary file');
      writeFileSync(
        temp,
        `${lines.filter((line, i) => line || i > 0).join('\n')}\n`,
        { flag: 'r+' },
      );
      renameSync(temp, this.envPath);
    } catch {
      try {
        if (existsSync(temp)) unlinkSync(temp);
      } catch {
        /* Do not expose file contents in errors. */
      }
      throw new Error('Private configuration write failed');
    }
    this.current = next;
  }
}
