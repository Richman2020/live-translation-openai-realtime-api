$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcherPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Start-AIPhone.ps1'))
$windowsPowerShellPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) { throw '未找到 AI 电话启动脚本。' }
if (-not (Test-Path -LiteralPath $windowsPowerShellPath -PathType Leaf)) { throw '未找到 Windows PowerShell。' }
$desktopPath = [Environment]::GetFolderPath('Desktop')
if (-not $desktopPath) { throw '无法确定当前用户桌面目录。' }
$startupPath = [Environment]::GetFolderPath('Startup')
$runtimeDir = Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$shortcutPaths = @((Join-Path $desktopPath 'AI电话.lnk'), (Join-Path $desktopPath 'AI电话（预览）.lnk'))
if ($startupPath) {
  New-Item -ItemType Directory -Path $startupPath -Force | Out-Null
  $shortcutPaths += Join-Path $startupPath 'AI电话在线.lnk'
}
$shell = New-Object -ComObject WScript.Shell
try {
  foreach ($shortcutPath in $shortcutPaths) {
    if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
        Copy-Item -LiteralPath $shortcutPath -Destination (Join-Path $runtimeDir ('shortcut-before-' + [Guid]::NewGuid().ToString('N') + '.lnk'))
    }
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $windowsPowerShellPath
    $shortcut.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherPath + '"'
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.WindowStyle = 7
    $shortcut.Description = '真实 AI 电话：自动恢复线路并保持在线'
    $shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',13'
    $shortcut.Save()
    Write-Output "Desktop shortcut installed: $shortcutPath"
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
    $shortcut = $null
  }
} finally {
    if ($null -ne $shortcut) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
}
