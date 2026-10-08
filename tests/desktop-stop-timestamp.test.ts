import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// Parse and load ONLY the timestamp helper. Never execute the stop script,
// contact a service, or inspect/terminate the running phone process.
const checkTimestamps = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:AI_PHONE_STOP_TEST_SCRIPT, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Stop script does not parse' }
$helper = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'ConvertTo-RecordedUtcTime' }, $true)
if ($null -eq $helper) { throw 'Missing timestamp helper' }
. ([scriptblock]::Create($helper.Extent.Text))
$uses = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'ConvertTo-RecordedUtcTime' }, $true))
if ($uses.Count -ne 2 -or -not ($uses.Extent.Text -match '\$record\.launcherStartedAt') -or -not ($uses.Extent.Text -match '\$record\.serverStartedAt')) { throw 'Both identity checks must use the helper' }
$originalCulture = [System.Threading.Thread]::CurrentThread.CurrentCulture
$checks = 0
$decodedTypes = @()
try {
    foreach ($culture in @('en-US', 'zh-CN', 'de-DE')) {
        [System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::GetCultureInfo($culture)
        $utc = [DateTime]::ParseExact('2026-09-28T08:09:10.1234567Z', 'o', [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
        $record = '{"launcherStartedAt":"2026-09-28T08:09:10.1234567Z","serverStartedAt":"2026-09-28T16:09:10.1234567+08:00"}' | ConvertFrom-Json
        $decodedTypes += $record.launcherStartedAt.GetType().FullName
        foreach ($value in @($utc, $utc.ToLocalTime(), $utc.ToString('o'), '2026-09-28T16:09:10.1234567+08:00', $record.launcherStartedAt, $record.serverStartedAt)) {
            $actual = ConvertTo-RecordedUtcTime $value
            if ($actual.Kind -ne [DateTimeKind]::Utc -or $actual.Ticks -ne $utc.Ticks) { throw "Exact UTC ticks changed under $culture" }
            if ($actual -eq $utc.AddTicks(1)) { throw 'One-tick process mismatch was accepted' }
            $checks++
        }
        # Exercise the exact process -> ISO -> JSON -> comparison path on THIS
        # disposable test shell, without accessing the phone server or records.
        $selfStart = (Get-Process -Id $PID).StartTime.ToUniversalTime()
        $selfRecord = @{ launcherStartedAt = $selfStart.ToString('o'); serverStartedAt = $selfStart.ToString('o') } | ConvertTo-Json | ConvertFrom-Json
        foreach ($value in @($selfRecord.launcherStartedAt, $selfRecord.serverStartedAt)) {
            if ((ConvertTo-RecordedUtcTime $value).Ticks -ne $selfStart.Ticks) { throw 'Actual process timestamp changed' }
            $checks++
        }
    }
    foreach ($invalid in @($null, 12345, @{ time = '2026-09-28' }, 'not-a-date', '2026-09-28T08:09:10.1234567', [DateTime]::SpecifyKind($utc, [DateTimeKind]::Unspecified))) {
        $rejected = $false
        try { $null = ConvertTo-RecordedUtcTime $invalid } catch { $rejected = $true }
        if (-not $rejected) { throw 'Invalid or timezone-free timestamp was accepted' }
        $checks++
    }
} finally { [System.Threading.Thread]::CurrentThread.CurrentCulture = $originalCulture }
@{ version = $PSVersionTable.PSVersion.ToString(); checks = $checks; decodedTypes = $decodedTypes } | ConvertTo-Json -Compress
`;

for (const [name, shell] of [
  [
    'Windows PowerShell',
    join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
  ],
  ['PowerShell 7', 'pwsh.exe'],
]) {
  test(
    `desktop stop preserves exact process identity timestamps in ${name}`,
    { skip: process.platform !== 'win32' },
    (t) => {
      let output: string;
      try {
        output = execFileSync(
          shell,
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            Buffer.from(checkTimestamps, 'utf16le').toString('base64'),
          ],
          {
            env: {
              ...process.env,
              AI_PHONE_STOP_TEST_SCRIPT: resolve('scripts/Stop-AIPhone.ps1'),
            },
            windowsHide: true,
            encoding: 'utf8',
            timeout: 20000,
          },
        );
      } catch (error) {
        if (
          name === 'PowerShell 7' &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          t.skip('Optional PowerShell 7 is not installed');
          return;
        }
        throw error;
      }
      const actual = JSON.parse(output.replace(/^\uFEFF/, '').trim());
      assert.equal(actual.checks, 30);
      assert.equal(actual.decodedTypes.length, 3);
      if (name === 'Windows PowerShell') {
        assert.match(actual.version, /^5\./);
        assert.deepEqual(actual.decodedTypes, Array(3).fill('System.String'));
      } else {
        assert.match(actual.version, /^7\./);
        assert.ok(
          actual.decodedTypes.every((type: string) =>
            ['System.String', 'System.DateTime'].includes(type),
          ),
        );
      }
      t.diagnostic(
        `${actual.version}: ${actual.checks} identity checks; JSON ${actual.decodedTypes[0]}`,
      );
    },
  );
}
