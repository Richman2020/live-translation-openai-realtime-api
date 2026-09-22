param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeDir = [System.IO.Path]::GetFullPath((Join-Path $repoRoot '.runtime'))
$statePath = [System.IO.Path]::GetFullPath((Join-Path $runtimeDir 'tunnel.json'))
$expectedBinary = [System.IO.Path]::GetFullPath((Join-Path $runtimeDir 'tools\cloudflared.exe'))
$environmentPath = Join-Path $repoRoot '.env'
$localToken = ''
$message = '本项目的公网隧道当前没有运行。'

function Read-PrivateToken {
    if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) { return '' }
    $content = [System.IO.File]::ReadAllText($environmentPath)
    $matchesForToken = [regex]::Matches($content, '(?m)^\s*(?:export\s+)?LOCAL_ACCESS_TOKEN\s*=\s*([^\r\n]*)')
    if ($matchesForToken.Count -eq 0) { return '' }
    $value = $matchesForToken[$matchesForToken.Count - 1].Groups[1].Value.Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        return $value.Substring(1, $value.Length - 2)
    }
    return ($value -split '\s+#', 2)[0].Trim()
}

function Test-ServiceListening([int]$portNumber) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect('127.0.0.1', $portNumber, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(700)) { throw '无法确认本机电话服务是否离线，隧道保持运行。' }
        $client.EndConnect($pending)
        return $true
    } catch {
        $cause = $_.Exception.GetBaseException()
        if ($cause -is [System.Net.Sockets.SocketException] -and $cause.SocketErrorCode -eq [System.Net.Sockets.SocketError]::ConnectionRefused) {
            return $false
        }
        throw '无法确认本机电话服务状态，隧道保持运行。'
    } finally { $client.Dispose() }
}

function Assert-NoActiveCall([int]$portNumber, [string]$token) {
    # Only a refused loopback connection establishes that the service is offline.
    # Authentication errors, timeouts and malformed responses never mean idle.
    if (-not (Test-ServiceListening $portNumber)) { return }
    if ($token.Length -lt 32) { throw '本机访问凭据不可用，无法确认通话是否结束；隧道保持运行。' }
    $response = $null
    try {
        $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$portNumber/api/status")
        $request.Proxy = $null
        $request.Timeout = 3000
        $request.ReadWriteTimeout = 3000
        $request.Headers.Add('Authorization', 'Bearer ' + $token)
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        try { $status = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    } catch {
        throw '无法读取本机通话状态，隧道保持运行。请先在工作台结束通话后重试。'
    } finally { if ($null -ne $response) { $response.Dispose() } }
    if ($status.mode -ne 'solo' -or $status.identity -ne 'ai-phone' -or -not ($status.PSObject.Properties.Name -contains 'activeSession')) {
        throw '本机服务身份或通话状态无法确认，隧道保持运行。'
    }
    if ($null -ne $status.activeSession) {
        throw '当前仍有通话或待确认的线路清理。请先在 AI 电话工作台挂断，确认线路结束后再停止公网隧道。'
    }
}

function Get-MatchingTunnel([int]$processNumber, [DateTime]$expectedStart) {
    $candidate = Get-Process -Id $processNumber -ErrorAction SilentlyContinue
    if ($null -eq $candidate) { return $null }
    if ($candidate.Path -ne $expectedBinary -or $candidate.StartTime.ToUniversalTime() -ne $expectedStart) {
        throw '记录中的 PID 已不属于本项目的隧道，未停止任何程序。'
    }
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processNumber"
    if ($null -eq $processInfo -or $processInfo.Name -ne 'cloudflared.exe' -or $processInfo.ExecutablePath -ne $expectedBinary) {
        throw '公网隧道程序身份无法确认，未停止任何程序。'
    }
    $portMatch = [regex]::Match($processInfo.CommandLine, '(?i)(?:^|\s)--url(?:=|\s+)"?http://127\.0\.0\.1:(\d+)"?(?:\s|$)')
    if (-not $portMatch.Success) { throw '进程不是本项目预期的本机电话隧道，未停止任何程序。' }
    $tunnelPort = [int]$portMatch.Groups[1].Value
    if ($tunnelPort -lt 1024 -or $tunnelPort -gt 65535) { throw '隧道目标端口无效，未停止任何程序。' }
    return [PSCustomObject]@{ Process = $candidate; Port = $tunnelPort }
}

try {
    # The sole removable file is this repository's exact tunnel state file.
    if ($runtimeDir -ne (Join-Path $repoRoot '.runtime') -or $statePath -ne (Join-Path $runtimeDir 'tunnel.json')) {
        throw '隧道记录路径不属于本项目，未执行停止操作。'
    }
    if ((Test-Path -LiteralPath $runtimeDir) -and ((Get-Item -LiteralPath $runtimeDir -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw '运行目录是链接，无法确认隧道记录归属；未执行停止操作。'
    }
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        if ((Get-Item -LiteralPath $statePath -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw '隧道记录是链接，未执行停止操作。'
        }
        $originalState = [System.IO.File]::ReadAllText($statePath)
        $record = $originalState | ConvertFrom-Json
        $tunnelProcessNumber = 0
        if (-not [int]::TryParse([string]$record.processId, [ref]$tunnelProcessNumber) -or $tunnelProcessNumber -le 0) {
            throw '隧道记录中的 PID 无效，未停止任何程序。'
        }
        if (-not $record.binary -or [System.IO.Path]::GetFullPath([string]$record.binary) -ne $expectedBinary -or -not $record.startedAt) {
            throw '隧道记录不属于本项目，未停止任何程序。'
        }
        $expectedStart = [DateTime]::Parse([string]$record.startedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        $matching = Get-MatchingTunnel $tunnelProcessNumber $expectedStart
        if ($null -ne $matching) {
            $localToken = Read-PrivateToken
            Assert-NoActiveCall $matching.Port $localToken
            # Recheck PID/start time after the HTTP request, before stopping anything.
            $matching = Get-MatchingTunnel $tunnelProcessNumber $expectedStart
            if ($null -ne $matching) {
                Stop-Process -InputObject $matching.Process -ErrorAction Stop
                if (-not $matching.Process.WaitForExit(3000)) { throw '隧道退出尚未确认，保留运行记录以便重试。' }
            }
            $message = '本项目的公网隧道已停止。再次启动后地址会变化，需要重新核对电话回调配置。'
        }
        if (Test-Path -LiteralPath $statePath -PathType Leaf) {
            if ([System.IO.File]::ReadAllText($statePath) -ne $originalState) {
                throw '隧道记录在操作期间发生变化，已保留新记录。'
            }
            Remove-Item -LiteralPath $statePath -Force
        }
    }
    if (-not $Quiet) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($message, 'AI 电话公网隧道', 'OK', 'Information') | Out-Null
    }
    Write-Output $message
} catch {
    $errorText = $_.Exception.Message
    if ($localToken) { $errorText = $errorText.Replace($localToken, '[redacted]') }
    if (-not $Quiet) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($errorText, '停止公网隧道失败', 'OK', 'Error') | Out-Null
    }
    Write-Error $errorText -ErrorAction Continue
    exit 1
}
