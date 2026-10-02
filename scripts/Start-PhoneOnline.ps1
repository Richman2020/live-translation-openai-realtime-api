param([switch]$Serve)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeDir = Join-Path $repoRoot '.runtime'
$recordPath = Join-Path $runtimeDir 'desktop-online-process.json'
$scriptPath = [IO.Path]::GetFullPath($PSCommandPath)
$powerShellPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
if ($Serve) {
    $entry = Join-Path $PSScriptRoot 'desktop-online.ts'
    $child = Start-Process -FilePath $nodePath -ArgumentList @('--import', 'tsx', ('"' + $entry + '"')) -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'desktop-online.stdout.log') -RedirectStandardError (Join-Path $runtimeDir 'desktop-online.stderr.log') -PassThru
    $child.WaitForExit()
    exit $child.ExitCode
}
$sha = [Security.Cryptography.SHA256]::Create()
try { $lockName = 'Local\AIPhoneOnline-' + ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($repoRoot.ToLowerInvariant())))).Replace('-', '') } finally { $sha.Dispose() }
$mutex = [Threading.Mutex]::new($false, $lockName)
$owned = $false
try {
    try { $owned = $mutex.WaitOne(3000) } catch [Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { throw 'AI 电话连接恢复程序正在启动。' }
    if (Test-Path -LiteralPath $recordPath -PathType Leaf) {
        $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
        if ($record.projectRoot -ne $repoRoot -or $record.launcherPath -ne $scriptPath) { throw '连接恢复进程记录不属于本项目。' }
        $candidate = Get-Process -Id ([int]$record.processId) -ErrorAction SilentlyContinue
        if ($null -ne $candidate) {
            $value = $record.startedAt
            $expected = if ($value -is [DateTime]) { $value.ToUniversalTime() } else { [DateTime]::ParseExact([string]$value, 'o', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() }
            $info = Get-CimInstance Win32_Process -Filter "ProcessId = $($candidate.Id)"
            if ($candidate.Path -ne $powerShellPath -or $candidate.StartTime.ToUniversalTime() -ne $expected -or $info.CommandLine -notmatch [regex]::Escape($scriptPath) -or $info.CommandLine -notmatch '(?i)(?:^|\s)-Serve(?:\s|$)') { throw '连接恢复进程身份不匹配，未操作其他进程。' }
            Write-Output 'AI Phone connection recovery is already running.'
            return
        }
    }
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $commandLine = '"' + $powerShellPath + '" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '" -Serve'
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $repoRoot; ProcessStartupInformation = $startup }
    if ($created.ReturnValue -ne 0 -or -not $created.ProcessId) { throw '无法独立启动连接恢复后台。' }
    $process = Get-Process -Id ([int]$created.ProcessId) -ErrorAction Stop
    @{ processId = $process.Id; startedAt = $process.StartTime.ToUniversalTime().ToString('o'); projectRoot = $repoRoot; launcherPath = $scriptPath } | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding UTF8
    Write-Output 'AI Phone connection recovery started.'
} finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
