<#
  整理助手 · 模型池生成与刷新脚本
  ------------------------------------------------------------------
  用法：
    .\tools\gen-ai-pool.ps1           刷新 OpenRouter 免费模型清单并验证 pool.js
    .\tools\gen-ai-pool.ps1 -Check    仅检查当前 pool.js 数据完整性与免费端点数量
#>
[CmdletBinding()]
param(
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$poolPath = Join-Path $root 'src\web\js\ai\pool.js'

if (-not (Test-Path $poolPath)) {
  throw "找不到模型池文件：$poolPath"
}

Write-Host "==> 检查模型池文件：$poolPath" -ForegroundColor Cyan

# 1. 验证 JS 语法与加载
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  throw "需要 Node.js 环境来验证模型池。"
}

$evalScript = @"
const fs = require('fs');
const window = {};
const code = fs.readFileSync('$($poolPath.Replace('\', '/'))', 'utf8');
try {
  eval(code);
  const p = window.AIPool;
  console.log(JSON.stringify({
    ok: true,
    providersCount: p.providers.length,
    modelsCount: p.count(),
    freeCount: p.freeCount ? p.freeCount() : p.providers.filter(x => x.free || x.local).length,
    freeProviders: p.providers.filter(x => x.free || x.local).map(x => ({ id: x.id, name: x.name, free: !!x.free, local: !!x.local, models: x.models.length }))
  }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
}
"@

$checkResult = & $node -e $evalScript | ConvertFrom-Json
if (-not $checkResult.ok) {
  throw "模型池 pool.js 解析失败：$($checkResult.error)"
}

Write-Host "当前厂商总数：$($checkResult.providersCount)，模型总数：$($checkResult.modelsCount)，免费/本地厂商：$($checkResult.freeCount)" -ForegroundColor Green
Write-Host "免费/本地厂商列表：" -ForegroundColor Gray
foreach ($fp in $checkResult.freeProviders) {
  $tag = if ($fp.local) { "[本地]" } else { "[免费]" }
  Write-Host "  - $tag $($fp.name) ($($fp.id)) : $($fp.models) 个模型" -ForegroundColor DarkGray
}

if ($Check) {
  Write-Host "检查完成。" -ForegroundColor Green
  return
}

# 2. 在线检查 OpenRouter 免费池动态（带 5 秒超时）
Write-Host "`n==> 尝试连接 OpenRouter API 获取最新可用 :free 模型..." -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod -Uri "https://openrouter.ai/api/v1/models" -Method Get -TimeoutSec 5
  if ($r -and $r.data) {
    $freeToolModels = $r.data | Where-Object {
      ($_.id -like "*:free" -or ($_.pricing.prompt -eq 0 -and $_.pricing.completion -eq 0)) -and
      ($_.supported_parameters -contains "tools")
    }
    Write-Host "成功获取 OpenRouter 线上免费且支持工具调用的模型数：$($freeToolModels.Count)" -ForegroundColor Green
    foreach ($m in $freeToolModels) {
      Write-Host "  * $($m.id) - $($m.name) (ctx: $($m.context_length))" -ForegroundColor DarkGreen
    }
  }
} catch {
  Write-Host "OpenRouter API 连接跳过或超时（可能受网络或代理影响），保留当前精选配置。" -ForegroundColor Yellow
}

Write-Host "`n==> pool.js 验证就绪。" -ForegroundColor Green
