param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcherPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Start-AIPhone.ps1'))
$recordPath = Join-Path $projectRoot '.runtime\solo-process.json'
$environmentPath = Join-Path $projectRoot '.env'
$message = '本机电话服务当前没有运行。'
$localToken = ''

function Invoke-LocalService([string]$url, [string]$method, [string]$token = '') {
    $response = $null
    try {
        $request = [System.Net.HttpWebRequest]::Create($url)
        $request.Proxy = $null; $request.Method = $method
        $request.Timeout = 20000; $request.ReadWriteTimeout = 20000
        if ($token) { $request.Headers.Add('Authorization', 'Bearer ' + $token) }
        if ($method -eq 'POST') {
            $request.ContentType = 'application/json'
            $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes('{}')
            $request.ContentLength = $bodyBytes.Length
            $requestStream = $request.GetRequestStream()
            try { $requestStream.Write($bodyBytes, 0, $bodyBytes.Length) } finally { $requestStream.Dispose() }
        }
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
    } finally { if ($null -ne $response) { $response.Dispose() } }
}

try {
    if (Test-Path -LiteralPath $recordPath -PathType Leaf) {
        $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
        if ($record.appId -ne 'ai-phone-solo' -or $record.projectRoot -ne $projectRoot -or $record.launcherPath -ne $launcherPath) { throw '启动记录不属于本项目，未停止任何程序。' }
        $workerId = [int]$record.launcherPid
        $worker = Get-Process -Id $workerId -ErrorAction SilentlyContinue
        if ($null -ne $worker) {
            $expectedStart = [DateTime]::Parse($record.launcherStartedAt).ToUniversalTime()
            $workerInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $workerId"
            if ($worker.StartTime.ToUniversalTime() -ne $expectedStart -or $workerInfo.Name -ne 'powershell.exe' -or $workerInfo.CommandLine -notmatch [regex]::Escape($launcherPath) -or $workerInfo.CommandLine -notmatch '(?i)(?:^|\s)-Serve(?:\s|$)') { throw '进程身份与本项目记录不匹配，未停止任何程序。' }
            $allProcesses = @(Get-CimInstance Win32_Process)
            $descendants = New-Object 'System.Collections.Generic.List[object]'
            $knownIds = New-Object 'System.Collections.Generic.HashSet[int]'
            [void]$knownIds.Add($workerId)
            do {
                $added = $false
                foreach ($candidate in $allProcesses) {
                    if ($knownIds.Contains([int]$candidate.ParentProcessId) -and $knownIds.Add([int]$candidate.ProcessId)) { $descendants.Add($candidate); $added = $true }
                }
            } while ($added)
            $listener = Get-NetTCPConnection -LocalPort ([int]$record.port) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($null -eq $listener) { throw '未找到可确认的电话服务，线路清理状态未知；未强制结束后台进程。' }
            if (-not $knownIds.Contains([int]$listener.OwningProcess)) { throw '当前端口属于另一程序，未停止任何程序。' }
            $server = Get-Process -Id ([int]$listener.OwningProcess) -ErrorAction Stop
            if (-not $record.serverPid -or $server.Id -ne [int]$record.serverPid -or $server.StartTime.ToUniversalTime() -ne [DateTime]::Parse($record.serverStartedAt).ToUniversalTime()) { throw '电话服务进程已经变化，未停止任何程序。' }
            $baseUrl = 'http://127.0.0.1:' + [int]$record.port
            $health = Invoke-LocalService "$baseUrl/health" 'GET'
            if ($health.appId -ne 'ai-phone-solo' -or $health.mode -ne 'solo' -or $health.ok -ne $true) { throw '本机服务身份无法确认，未停止任何程序。' }
            if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) { throw '本机访问凭据文件缺失，无法安全清理线路；未强制结束进程。' }
            $environmentText = [System.IO.File]::ReadAllText($environmentPath)
            $tokenMatches = [regex]::Matches($environmentText, '(?m)^\s*LOCAL_ACCESS_TOKEN\s*=\s*([^\r\n]*)')
            if ($tokenMatches.Count -gt 0) {
                $localToken = $tokenMatches[$tokenMatches.Count - 1].Groups[1].Value.Trim()
                if (($localToken.StartsWith('"') -and $localToken.EndsWith('"')) -or ($localToken.StartsWith("'") -and $localToken.EndsWith("'"))) { $localToken = $localToken.Substring(1, $localToken.Length - 2) }
                else { $localToken = ($localToken -split '\s+#', 2)[0].Trim() }
            }
            if ($localToken.Length -lt 32) { throw '本机访问凭据无效，无法安全清理线路；未强制结束进程。' }
            try { $shutdown = Invoke-LocalService "$baseUrl/api/shutdown" 'POST' $localToken }
            catch { throw '电话线路清理请求未成功确认。服务保持运行，请在工作台结束通话后重试；未强制结束进程。' }
            if ($shutdown.ok -ne $true -or $shutdown.safeToStop -ne $true) { throw '电话线路清理未成功确认；未强制结束任何进程。' }
            $timer = [System.Diagnostics.Stopwatch]::StartNew()
            do {
                $server.Refresh()
                if ($server.HasExited) { break }
                Start-Sleep -Milliseconds 200
            } while ($timer.ElapsedMilliseconds -lt 12000)
            # Only an acknowledged shutdown permits cleaning up this launcher's remaining workers.
            for ($index = $descendants.Count - 1; $index -ge 0; $index--) {
                $candidate = $descendants[$index]
                $stillRunning = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $candidate.ProcessId)
                if ($null -ne $stillRunning -and $stillRunning.CreationDate -eq $candidate.CreationDate -and $stillRunning.ParentProcessId -eq $candidate.ParentProcessId) { Stop-Process -Id ([int]$candidate.ProcessId) -ErrorAction SilentlyContinue }
            }
            $worker.Refresh()
            if (-not $worker.HasExited -and $worker.StartTime.ToUniversalTime() -eq $expectedStart) { Stop-Process -Id $workerId -ErrorAction Stop }
            $message = '电话线路已清理，AI 电话服务已停止。再次点击桌面「AI 电话」即可打开。'
        }
    }
    if (-not $Quiet) { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($message, 'AI 电话', 'OK', 'Information') | Out-Null }
    Write-Output $message
} catch {
    $errorText = $_.Exception.Message
    if ($localToken) { $errorText = $errorText.Replace($localToken, '[redacted]') }
    if (-not $Quiet) { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($errorText, '停止电话服务失败', 'OK', 'Error') | Out-Null }
    Write-Error $errorText -ErrorAction Continue
    exit 1
}
