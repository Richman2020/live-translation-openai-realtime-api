param([switch]$NoOpen, [switch]$Serve)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimePath = Join-Path $projectRoot '.runtime'
$environmentPath = Join-Path $projectRoot '.env'
$recordPath = Join-Path $runtimePath 'solo-process.json'
$launcherPath = [System.IO.Path]::GetFullPath($PSCommandPath)
$windowsPowerShellPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$mutex = $null
$ownsMutex = $false

function Read-EnvironmentValue([string]$content, [string]$name) {
    $matchesForName = [regex]::Matches($content, '(?m)^\s*' + [regex]::Escape($name) + '\s*=\s*([^\r\n]*)')
    if ($matchesForName.Count -eq 0) { return '' }
    $value = $matchesForName[$matchesForName.Count - 1].Groups[1].Value.Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) { return $value.Substring(1, $value.Length - 2) }
    return ($value -split '\s+#', 2)[0].Trim()
}

function Write-PrivateEnvironment([string]$content) {
    $temporaryPath = Join-Path $projectRoot ('.env.local-write-' + [Guid]::NewGuid().ToString('N'))
    try {
        $file = New-Item -ItemType File -Path $temporaryPath
        $acl = New-Object System.Security.AccessControl.FileSecurity
        $acl.SetAccessRuleProtection($true, $false)
        $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $systemIdentity = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($currentIdentity, 'FullControl', 'Allow')))
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($systemIdentity, 'FullControl', 'Allow')))
        Set-Acl -LiteralPath $temporaryPath -AclObject $acl
        [System.IO.File]::WriteAllText($temporaryPath, $content, (New-Object System.Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $environmentPath -PathType Leaf) { [System.IO.File]::Replace($temporaryPath, $environmentPath, $null) }
        else { [System.IO.File]::Move($temporaryPath, $environmentPath) }
    } finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) { Remove-Item -LiteralPath $temporaryPath -Force }
    }
}

function Get-ServiceHealth([string]$baseUrl) {
    $response = $null
    try {
        $request = [System.Net.HttpWebRequest]::Create("$baseUrl/health")
        $request.Proxy = $null; $request.Timeout = 700; $request.ReadWriteTimeout = 700
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
    } catch { return $null } finally { if ($null -ne $response) { $response.Dispose() } }
}

function Test-ServiceHealth($health) { return ($null -ne $health -and $health.appId -eq 'ai-phone-solo' -and $health.mode -eq 'solo' -and $health.ok -eq $true) }

function Test-PortInUse([int]$portNumber) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect('127.0.0.1', $portNumber, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(300)) { return $false }
        $client.EndConnect($pending); return $true
    } catch { return $false } finally { $client.Dispose() }
}

function Test-Descendant([int]$candidateId, [int]$ancestorId) {
    $visited = New-Object 'System.Collections.Generic.HashSet[int]'
    while ($candidateId -gt 0 -and $visited.Add($candidateId)) {
        if ($candidateId -eq $ancestorId) { return $true }
        $processEntry = Get-CimInstance Win32_Process -Filter "ProcessId = $candidateId"
        if ($null -eq $processEntry) { return $false }
        $candidateId = [int]$processEntry.ParentProcessId
    }
    return $false
}

try {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) { throw '未找到 Node.js，请先安装 Node.js，再打开 AI 电话。' }
    $nodePath = $nodeCommand.Source
    $npmCliPath = Join-Path ([System.IO.Path]::GetDirectoryName($nodePath)) 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $npmCliPath -PathType Leaf)) { throw '未找到 npm，请修复 Node.js 安装。' }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\tsx') -PathType Container)) { throw '项目依赖尚未安装。请在项目目录运行 npm ci 后重试。' }

    # The hidden worker inherits no credentials through command arguments.
    if ($Serve) {
        Set-Location -LiteralPath $projectRoot
        # Own the log handles here: the WMI-created worker outlives its caller.
        $serverProcess = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $npmCliPath + '"'), 'run', 'start:solo') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'solo.stdout.log') -RedirectStandardError (Join-Path $runtimePath 'solo.stderr.log') -PassThru
        $serverProcess.WaitForExit()
        exit $serverProcess.ExitCode
    }

    $mutex = New-Object System.Threading.Mutex($false, 'Local\AIPhoneSoloLauncher_5050')
    try { $ownsMutex = $mutex.WaitOne(3000) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'AI 电话正在启动，请稍后再次点击。' }
    $environmentText = if (Test-Path -LiteralPath $environmentPath -PathType Leaf) { [System.IO.File]::ReadAllText($environmentPath) } else { '' }
    $localToken = Read-EnvironmentValue $environmentText 'LOCAL_ACCESS_TOKEN'
    if ($localToken.Length -lt 32 -or $localToken -match '(?i)placeholder|change.?me|your.?token') {
        $randomBytes = New-Object byte[] 32
        $randomGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $randomGenerator.GetBytes($randomBytes) } finally { $randomGenerator.Dispose() }
        $localToken = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        if ($environmentText -match '(?m)^\s*LOCAL_ACCESS_TOKEN\s*=') { $environmentText = [regex]::Replace($environmentText, '(?m)^\s*LOCAL_ACCESS_TOKEN\s*=[^\r\n]*', ('LOCAL_ACCESS_TOKEN=' + $localToken)) }
        else { $environmentText = $environmentText.TrimEnd() + "`r`nLOCAL_ACCESS_TOKEN=$localToken`r`n" }
        Write-PrivateEnvironment $environmentText
    }
    $portNumber = 5050
    $portText = Read-EnvironmentValue $environmentText 'API_PORT'
    if ($portText -and (-not [int]::TryParse($portText, [ref]$portNumber) -or $portNumber -lt 1024 -or $portNumber -gt 65535)) { throw 'API_PORT 需要是 1024–65535 之间的本机端口。' }
    $baseUrl = "http://127.0.0.1:$portNumber"
    $health = Get-ServiceHealth $baseUrl
    if (-not (Test-ServiceHealth $health)) {
        if (Test-PortInUse $portNumber) { throw "本机端口 $portNumber 已被其他程序占用，AI 电话未启动。" }
        New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
        if (-not (Test-Path -LiteralPath $windowsPowerShellPath -PathType Leaf)) { throw '未找到 Windows PowerShell，无法启动后台服务。' }
        # Start through the local Windows process provider, not as a child of the
        # invoking terminal/job. Some tool hosts kill their entire job on exit.
        # No scheduled task, service installation, elevated account or secret args.
        $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
        $workerCommand = '"' + $windowsPowerShellPath + '" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcherPath + '" -Serve'
        $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $workerCommand; CurrentDirectory = $projectRoot; ProcessStartupInformation = $startup }
        if ($created.ReturnValue -ne 0 -or -not $created.ProcessId) { throw ('Windows 无法独立启动电话后台（代码 ' + $created.ReturnValue + '），未改用临时后台。') }
        $worker = Get-Process -Id ([int]$created.ProcessId) -ErrorAction Stop
        $workerStart = $worker.StartTime.ToUniversalTime().ToString('o')
        $processRecord = @{ launcherPid = $worker.Id; launcherStartedAt = $workerStart; launcherPath = $launcherPath; projectRoot = $projectRoot; port = $portNumber; appId = 'ai-phone-solo' }
        $processRecord | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding UTF8
        $timer = [System.Diagnostics.Stopwatch]::StartNew()
        do {
            $health = Get-ServiceHealth $baseUrl
            if (Test-ServiceHealth $health) { break }
            $worker.Refresh()
            if ($worker.HasExited) { throw '本机电话服务启动失败，请查看项目 .runtime 目录中的 solo.stderr.log 和 solo.worker.stderr.log。' }
            Start-Sleep -Milliseconds 200
        } while ($timer.ElapsedMilliseconds -lt 20000)
        if (-not (Test-ServiceHealth $health)) { throw '电话服务未能及时启动，请查看项目 .runtime 目录中的日志。' }
        $listener = Get-NetTCPConnection -LocalPort $portNumber -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $listener -or -not (Test-Descendant ([int]$listener.OwningProcess) $worker.Id)) { throw '端口进程与本项目启动记录不匹配，未打开工作台。' }
        $actualServer = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
        $processRecord.serverPid = $actualServer.Id
        $processRecord.serverStartedAt = $actualServer.StartTime.ToUniversalTime().ToString('o')
        $processRecord | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding UTF8
    }
    $mutex.ReleaseMutex(); $ownsMutex = $false
    if (-not $NoOpen) {
        $desktopUrl = $baseUrl + '/#token=' + [Uri]::EscapeDataString($localToken)
        $browserCandidates = @(
            (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
            (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
            (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe'),
            (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
        )
        $browserPath = $browserCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
        if ($browserPath) { Start-Process -FilePath $browserPath -ArgumentList @("--app=$desktopUrl", '--window-size=1440,1000') | Out-Null }
        else { Start-Process $desktopUrl | Out-Null }
    }
    Write-Output "AI Phone is ready: $baseUrl"
} catch {
    $errorText = $_.Exception.Message
    if ($localToken) { $errorText = $errorText.Replace($localToken, '[redacted]') }
    if ($Serve) {
        # WMI does not redirect the worker's own errors. Keep those separate from
        # the live Node stderr handle; no environment or credentials are logged.
        try {
            New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
            $workerFailure = @{ at = [DateTime]::UtcNow.ToString('o'); code = 'WORKER_START_FAILED'; message = $errorText }
            $workerFailure | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $runtimePath 'solo.worker.stderr.log') -Encoding UTF8
        } catch { # Preserve the original failure if logging itself is unavailable.
        }
    }
    if (-not $NoOpen -and -not $Serve) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($errorText, 'AI 电话启动失败', 'OK', 'Error') | Out-Null
    }
    Write-Error $errorText -ErrorAction Continue
    exit 1
} finally {
    if ($ownsMutex -and $null -ne $mutex) { $mutex.ReleaseMutex() }
    if ($null -ne $mutex) { $mutex.Dispose() }
}
