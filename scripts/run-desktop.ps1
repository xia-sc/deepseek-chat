# 安装/更新桌面版：直接复制已解压的 win-unpacked，绕开 zip 与网络标记（Mark-of-the-Web）。
# 用法：
#   pwsh -ExecutionPolicy Bypass -File scripts\run-desktop.ps1
#   pwsh -ExecutionPolicy Bypass -File scripts\run-desktop.ps1 -Destination 'D:\Apps\DeepSeek-Chat'
param(
  [string]$Source = (Join-Path $PSScriptRoot '..\release-app\win-unpacked'),
  [string]$Destination = 'D:\Apps\DeepSeek-Chat'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Source)) {
  Write-Host "找不到构建产物：$Source" -ForegroundColor Red
  Write-Host '请先运行 pnpm dist:exe' -ForegroundColor Yellow
  exit 1
}

$exeName = 'DeepSeek Chat.exe'
$sourceExe = Join-Path $Source $exeName
if (-not (Test-Path -LiteralPath $sourceExe)) {
  Write-Host "找不到可执行文件：$sourceExe" -ForegroundColor Red
  exit 1
}

Write-Host "目标目录：$Destination"
if (Test-Path -LiteralPath $Destination) {
  # 只清理程序文件，保留同目录的 data（配置与会话）
  Get-ChildItem -LiteralPath $Destination -Force |
    Where-Object { $_.Name -ne 'data' } |
    Remove-Item -Recurse -Force
} else {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
}

Write-Host '正在复制文件...'
Copy-Item -Path (Join-Path $Source '*') -Destination $Destination -Recurse -Force

# 清除可能残留的网络标记，避免“Internet 安全设置阻止打开”的提示
Get-ChildItem -LiteralPath $Destination -Recurse -File | ForEach-Object {
  Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue
}

$targetExe = Join-Path $Destination $exeName
Write-Host "启动：$targetExe" -ForegroundColor Green
Start-Process -FilePath $targetExe
Write-Host '完成。首次运行会在程序目录下生成 data 文件夹（配置与会话）。'
