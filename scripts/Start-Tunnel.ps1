$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeDir = Join-Path $repoRoot '.runtime'
$binaryPath = Join-Path $runtimeDir 'tools\cloudflared.exe'
$statePath = Join-Path $runtimeDir 'tunnel.json'
$logPath = Join-Path $runtimeDir 'tunnel.log'
$envPath = Join-Path $repoRoot '.env'
$localToken = ''
$createdProcess = $null
$createdRecord = $null
$launchLock = $null
$lockAcquired = $false

function Read-SharedLog([string]$path) {
  # Start-Process keeps redirected stderr open; allow its writer to remain open.
  $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    $reader = New-Object IO.StreamReader($stream)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
  } finally { $stream.Dispose() }
}

function Test-SameRecord($left, $right) {
  return ($null -ne $left -and $null -ne $right -and
    [string]$left.processId -eq [string]$right.processId -and
    [string]$left.startedAt -eq [string]$right.startedAt -and
    [string]$left.binary -eq [string]$right.binary)
}

function Get-MatchingProcess($record) {
  $processNumber = 0
  if (-not [int]::TryParse([string]$record.processId, [ref]$processNumber) -or $processNumber -le 0 -or
      [string]$record.binary -ne $binaryPath -or -not $record.startedAt) {
    throw 'The tunnel record is invalid; no process was changed.'
  }
  $candidate = Get-Process -Id $processNumber -ErrorAction SilentlyContinue
  if ($null -eq $candidate) { return $null }
  if ($candidate.Path -ne $binaryPath -or $candidate.StartTime.ToUniversalTime().ToString('o') -ne $record.startedAt) {
    throw 'The recorded PID belongs to a different process; no process was changed.'
  }
  return $candidate
}

function Invoke-LocalApi([string]$path, [string]$method = 'GET', [string]$body = '') {
  $response = $null
  try {
    $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$port$path")
    $request.Proxy = $null
    $request.Timeout = 5000
    $request.ReadWriteTimeout = 5000
    $request.Method = $method
    $request.Headers.Add('Authorization', 'Bearer ' + $localToken)
    if ($method -eq 'POST') {
      $request.ContentType = 'application/json'
      $bytes = [Text.Encoding]::UTF8.GetBytes($body)
      $request.ContentLength = $bytes.Length
      $requestStream = $request.GetRequestStream()
      try { $requestStream.Write($bytes, 0, $bytes.Length) } finally { $requestStream.Dispose() }
    }
    $response = $request.GetResponse()
    $reader = New-Object IO.StreamReader($response.GetResponseStream())
    try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
  } catch {
    throw 'The authenticated local phone API request failed. Keep the workbench running and check its call status.'
  } finally { if ($null -ne $response) { $response.Dispose() } }
}

function Get-LocalStatus {
  $status = Invoke-LocalApi '/api/status'
  if ($status.mode -ne 'solo' -or $status.identity -ne 'ai-phone' -or
      -not ($status.PSObject.Properties.Name -contains 'activeSession')) {
    throw 'The local phone service identity or call status could not be verified.'
  }
  return $status
}

function Save-PublicAddress([string]$url) {
  $status = Get-LocalStatus
  if ([string]$status.publicUrl -eq $url) { return }
  if ($null -ne $status.activeSession) {
    throw 'End the active call and confirm cleanup before changing the public callback address.'
  }
  # The server checks idle state again atomically before saving and reloading settings.
  $saved = Invoke-LocalApi '/api/settings' 'POST' (@{ PUBLIC_BASE_URL = $url } | ConvertTo-Json -Compress)
  if ($saved.publicUrl -ne $url) { throw 'The local phone service did not confirm the public callback address.' }
}

function Write-TunnelRecord($record, [bool]$requireMatching) {
  if ($requireMatching) {
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf) -or
        -not (Test-SameRecord (Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json) $record)) {
      throw 'The tunnel record changed during startup; the new record was preserved.'
    }
  }
  [IO.File]::WriteAllText($statePath, ($record | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}

try {
  if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
    throw 'cloudflared is missing. Install the official Cloudflare Windows binary into .runtime\tools\cloudflared.exe.'
  }
  foreach ($path in @($runtimeDir, $statePath)) {
    if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'The tunnel runtime directory or state is a link; startup was refused.'
    }
  }
  $hash = [Security.Cryptography.SHA256]::Create()
  try { $lockName = 'Local\AIPhoneTunnel-' + ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($repoRoot.ToLowerInvariant())))).Replace('-', '') }
  finally { $hash.Dispose() }
  $launchLock = [Threading.Mutex]::new($false, $lockName)
  try { $lockAcquired = $launchLock.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $lockAcquired = $true }
  if (-not $lockAcquired) { throw 'Another tunnel startup is already in progress.' }

  $port = '5050'
  if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) { throw 'Start the AI Phone local workbench first.' }
  $envText = [IO.File]::ReadAllText($envPath)
  $portMatch = [regex]::Match($envText, '(?m)^API_PORT\s*=\s*["'']?(\d+)')
  if ($portMatch.Success) { $port = $portMatch.Groups[1].Value }
  if ([int]$port -lt 1024 -or [int]$port -gt 65535) { throw 'The local API port is invalid.' }
  $tokenMatch = [regex]::Match($envText, '(?m)^LOCAL_ACCESS_TOKEN\s*=\s*["'']?([A-Za-z0-9_-]+)')
  if (-not $tokenMatch.Success -or $tokenMatch.Groups[1].Value.Length -lt 32) { throw 'Local launcher token is missing.' }
  $localToken = $tokenMatch.Groups[1].Value
  $status = Get-LocalStatus

  $record = $null
  $tunnelProcess = $null
  if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    $record = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $tunnelProcess = Get-MatchingProcess $record
    if ($null -ne $tunnelProcess) {
      $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($tunnelProcess.Id)"
      $targetMatch = [regex]::Match([string]$processInfo.CommandLine, '(?i)(?:^|\s)--url(?:=|\s+)"?http://127\.0\.0\.1:(\d+)"?(?:\s|$)')
      if (-not $targetMatch.Success -or $targetMatch.Groups[1].Value -ne $port) {
        throw 'The existing tunnel targets another local port; stop it before starting a replacement.'
      }
    }
  }
  if ($null -eq $tunnelProcess) {
    if ($null -ne $status.activeSession) { throw 'End the active call and confirm cleanup before starting a new tunnel.' }
    $createdProcess = Start-Process -FilePath $binaryPath -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$port", '--no-autoupdate', '--protocol', 'http2') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDir 'tunnel.stdout.log') -RedirectStandardError $logPath
    $createdRecord = [PSCustomObject]@{ processId = $createdProcess.Id; startedAt = $createdProcess.StartTime.ToUniversalTime().ToString('o'); url = ''; binary = $binaryPath }
    # Register the process before polling logs or making any further HTTP requests.
    Write-TunnelRecord $createdRecord $false
    $record = $createdRecord
    $tunnelProcess = $createdProcess
  }

  $publicUrl = [string]$record.url
  if ($publicUrl -and $publicUrl -notmatch '^https://[a-z0-9-]+\.trycloudflare\.com$') {
    throw 'The recorded public tunnel address is invalid.'
  }
  if (-not $publicUrl) {
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
      if ($tunnelProcess.HasExited) { throw 'Cloudflare tunnel stopped before opening. See private .runtime/tunnel.log.' }
      if (Test-Path -LiteralPath $logPath -PathType Leaf) {
        $urlMatch = [regex]::Match((Read-SharedLog $logPath), 'https://[a-z0-9-]+\.trycloudflare\.com')
        if ($urlMatch.Success) { $publicUrl = $urlMatch.Value; break }
      }
      Start-Sleep -Milliseconds 500
    }
    if (-not $publicUrl) { throw 'Cloudflare tunnel URL was not received; inspect .runtime/tunnel.log.' }
    $record.url = $publicUrl
    Write-TunnelRecord $record $true
  }
  if ($null -eq (Get-MatchingProcess $record)) { throw 'The tunnel exited before configuration could be saved.' }
  Save-PublicAddress $publicUrl
  Write-Output "Public voice callback address: $publicUrl"
  Write-Output 'This temporary address changes after the tunnel restarts. Run configure:twilio after reviewing its plan.'
} catch {
  $failure = $_.Exception.Message
  if ($localToken) { $failure = $failure.Replace($localToken, '[redacted]') }
  # A reused tunnel belongs to a previous invocation and is never stopped here.
  if ($null -ne $createdProcess -and $null -ne $createdRecord) {
    try {
      $matching = Get-MatchingProcess $createdRecord
      if ($null -ne $matching) {
        Stop-Process -InputObject $matching -ErrorAction Stop
        if (-not $matching.WaitForExit(3000)) { throw 'Tunnel exit has not yet been confirmed.' }
      }
      if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        $currentRecord = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if (Test-SameRecord $currentRecord $createdRecord) { Remove-Item -LiteralPath $statePath -Force }
      }
    } catch {
      $failure += ' Cleanup could not be confirmed; the recorded process must be checked before retrying.'
    }
  }
  Write-Error $failure -ErrorAction Continue
  exit 1
} finally {
  if ($lockAcquired) { $launchLock.ReleaseMutex() }
  if ($null -ne $launchLock) { $launchLock.Dispose() }
}
