$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcherPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Start-AIPhone.ps1'))
$windowsPowerShellPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) { throw '未找到 AI 电话启动脚本。' }
if (-not (Test-Path -LiteralPath $windowsPowerShellPath -PathType Leaf)) { throw '未找到 Windows PowerShell。' }
$desktopPath = [Environment]::GetFolderPath('Desktop')
if (-not $desktopPath) { throw '无法确定当前用户桌面目录。' }
$shortcutPath = Join-Path $desktopPath 'AI电话.lnk'
$shell = New-Object -ComObject WScript.Shell
try {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $windowsPowerShellPath
    $shortcut.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherPath + '"'
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.WindowStyle = 7
    $shortcut.Description = '打开本机 AI 电话双向翻译工作台'
    $shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',13'
    $shortcut.Save()
    Write-Output "Desktop shortcut installed: $shortcutPath"
} finally {
    if ($null -ne $shortcut) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
}
