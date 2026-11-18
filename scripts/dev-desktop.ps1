# 启动 Electron 桌面外壳并加载 rspack dev server（热更新）。
#
# 工作区目录被加上 Low 完整性标签后，Electron 运行时放在工作区内会启动即崩溃，
# 因此先把运行时复制到 %LOCALAPPDATA%，再从那里加载本项目源码。
#
# 用法：
#   终端 1：pnpm dev            （rspack dev server，8080/8090 端口）
#   终端 2：pnpm dev:desktop:win
param(
  [string]$DevUrl = 'http://localhost:8090',
  [string]$RuntimeDir = (Join-Path $env:LOCALAPPDATA 'dsh-electron-dev'),
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'DeepSeek Chat Dev')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sourceDist = Join-Path $root 'node_modules\electron\dist'
$sourceExe = Join-Path $sourceDist 'electron.exe'
if (-not (Test-Path $sourceExe)) {
  throw "找不到 Electron 运行时：$sourceExe，请先执行 pnpm install"
}

# 首次运行或 Electron 版本变化时，同步运行时到工作区外
$sourceVersion = (Get-Content (Join-Path $root 'node_modules\electron\package.json') -Raw | ConvertFrom-Json).version
$stamp = Join-Path $RuntimeDir 'version.txt'
$needCopy = -not (Test-Path (Join-Path $RuntimeDir 'electron.exe'))
if (-not $needCopy -and (Test-Path $stamp)) {
  $needCopy = ((Get-Content $stamp -Raw).Trim() -ne $sourceVersion)
}
if ($needCopy) {
  Write-Host "同步 Electron 运行时到 $RuntimeDir ..."
  if (Test-Path $RuntimeDir) {
    Remove-Item $RuntimeDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  Copy-Item (Join-Path $sourceDist '*') $RuntimeDir -Recurse -Force
  Set-Content -Path $stamp -Value $sourceVersion -Encoding UTF8
}

# dev server 没起时给出明确提示，而不是打开空白窗口
try {
  Invoke-WebRequest -Uri $DevUrl -UseBasicParsing -TimeoutSec 3 | Out-Null
} catch {
  Write-Warning "无法访问 $DevUrl，请先在另一个终端执行 pnpm dev"
}

# DSH 会话会设置 ELECTRON_RUN_AS_NODE=1，它会让 Electron 以 Node 模式运行并立即退出
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$env:DEEPSEEK_CHAT_DEV_URL = $DevUrl
$env:DEEPSEEK_CHAT_DATA_DIR = $DataDir

Write-Host "启动 Electron（开发数据目录：$DataDir）"
& (Join-Path $RuntimeDir 'electron.exe') $root '--no-sandbox'
exit $LASTEXITCODE
