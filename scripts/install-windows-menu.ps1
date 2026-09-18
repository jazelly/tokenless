$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $repositoryRoot 'dist\windows\TokenlessApiTray.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Build first / 请先构建' }
$programs = [Environment]::GetFolderPath('Programs')
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $programs 'Tokenless API.lnk'))
$shortcut.TargetPath = $executable
$shortcut.WorkingDirectory = Split-Path -Parent $executable
$shortcut.Description = 'Tokenless API'
$shortcut.Save()
Start-Process -FilePath $executable -WindowStyle Hidden
Write-Output 'Tokenless API tray launched; Start menu shortcut installed. / Tokenless API 托盘已启动，已创建开始菜单快捷方式。'
