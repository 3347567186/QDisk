<#
  整理助手 · 在线发包与更新清单生成脚本
  ------------------------------------------------------------------
  用法：
    1) 生成静态站点 / OSS / R2 / Gitee / Nginx 清单：
       pwsh -File .\tools\publish-release.ps1 -BaseUrl "https://cdn.example.com/tidy/"

    2) 生成 GitHub Releases 清单（可选 -UploadGitHub 自动调 gh 上传）：
       pwsh -File .\tools\publish-release.ps1 -GitHubRepo "owner/TidyAssistant"
       pwsh -File .\tools\publish-release.ps1 -GitHubRepo "owner/TidyAssistant" -UploadGitHub

    3) 本机一键起本地更新源做真实端到端验证（127.0.0.1 放行 HTTP）：
       pwsh -File .\tools\publish-release.ps1 -ServeLocal -Port 18765
       （然后在软件「设置 → 版本与在线更新」填入 http://127.0.0.1:18765/latest.json）

  产物（统一落盘到 release\）：
    - release\latest.json      标准在线更新清单（含安装版 + 便携版 + SHA-256 + 体积 + 更新日志）
    - release\SHA256SUMS.txt   通用 SHA-256 校验表
#>
[CmdletBinding()]
param(
  [string]$Version,
  [ValidateSet('stable', 'beta')]
  [string]$Channel = 'stable',
  [string]$BaseUrl = '',
  [string]$GitHubRepo = '3347567186/TidyAssistant',
  [string]$Notes = '',
  [string]$MinVersion = '',
  [switch]$UploadGitHub,
  [switch]$ServeLocal,
  [int]$Port = 18765
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$confPath = Join-Path $root 'src\src-tauri\tauri.conf.json'
$releaseDir = Join-Path $root 'release'
$changelogPath = Join-Path $root 'docs\01-当前版\变更记录.md'

if (-not $Version) {
  $conf = Get-Content $confPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $Version = [string]$conf.version
}
if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
  throw "版本号格式无效：$Version"
}

if (-not (Test-Path $releaseDir)) {
  throw "找不到 release 目录：$releaseDir（请先运行 .\build.ps1 构建产物）"
}

$instFile = "TidyAssistant_${Version}_x64-setup.exe"
$portFile = "整理助手_${Version}_便携版.zip"
$instPath = Join-Path $releaseDir $instFile
$portPath = Join-Path $releaseDir $portFile

$hasInst = Test-Path $instPath
$hasPort = Test-Path $portPath
if (-not $hasInst -and -not $hasPort) {
  throw "release\ 中找不到 v$Version 的安装包或便携包（期望 $instFile 或 $portFile）"
}

function Get-Sha256Lower([string]$p) {
  return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-NotesFromChangelog([string]$ver, [string]$path) {
  if (-not (Test-Path $path)) { return "TidyAssistant v$ver 正式发布。" }
  $raw = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
  $escaped = [regex]::Escape($ver)
  $m = [regex]::Match($raw, "(?ms)^##\s+${escaped}\b.*?(?=^##\s+|\z)")
  if (-not $m.Success) { return "TidyAssistant v$ver 正式发布。" }
  $txt = $m.Value.Trim()
  if ($txt.Length -gt 2400) { $txt = $txt.Substring(0, 2400).TrimEnd() + "`n…" }
  return $txt
}

if (-not $Notes) {
  $Notes = Get-NotesFromChangelog -ver $Version -path $changelogPath
}

if ($ServeLocal) {
  $BaseUrl = "http://127.0.0.1:$Port/"
} elseif ($GitHubRepo) {
  $repo = $GitHubRepo.Trim().Trim('/')
  if ($repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw "GitHubRepo 格式应为 owner/repo：$GitHubRepo"
  }
  $BaseUrl = "https://github.com/$repo/releases/download/v$Version/"
} elseif ($BaseUrl) {
  $BaseUrl = $BaseUrl.Trim()
  if (-not $BaseUrl.EndsWith('/')) { $BaseUrl += '/' }
}

function Format-AssetUrl([string]$base, [string]$fileName) {
  if (-not $base) { return $fileName }
  $encoded = [Uri]::EscapeDataString($fileName)
  return "$base$encoded"
}

$manifest = [ordered]@{
  schemaVersion = 1
  version       = $Version
  channel       = $Channel
  pubDate       = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
  minVersion    = $MinVersion
  notes         = $Notes
}

$sums = New-Object System.Collections.Generic.List[string]

if ($hasInst) {
  $sha = Get-Sha256Lower $instPath
  $len = (Get-Item -LiteralPath $instPath).Length
  $url = Format-AssetUrl $BaseUrl $instFile
  $manifest['installer'] = [ordered]@{
    file   = $instFile
    url    = $url
    size   = $len
    sha256 = $sha
  }
  $manifest['platforms'] = [ordered]@{
    'windows-x86_64' = [ordered]@{
      file   = $instFile
      url    = $url
      size   = $len
      sha256 = $sha
    }
  }
  $sums.Add("$sha  $instFile")
}

if ($hasPort) {
  $sha = Get-Sha256Lower $portPath
  $len = (Get-Item -LiteralPath $portPath).Length
  # 红队防 404：GitHub Releases 会改写含中文字符的附件名，上传到 GitHub 时统一使用纯 ASCII 文件名
  $remotePortFile = if (-not $ServeLocal -and $GitHubRepo) {
    "TidyAssistant_${Version}_x64-portable.zip"
  } else {
    $portFile
  }
  $url = Format-AssetUrl $BaseUrl $remotePortFile
  $manifest['portable'] = [ordered]@{
    file   = $remotePortFile
    url    = $url
    size   = $len
    sha256 = $sha
  }
  $sums.Add("$sha  $remotePortFile")
}

$enc = New-Object Text.UTF8Encoding($false)
$latestPath = Join-Path $releaseDir 'latest.json'
$sumsPath = Join-Path $releaseDir 'SHA256SUMS.txt'
$jsonText = $manifest | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText($latestPath, $jsonText + "`n", $enc)
[IO.File]::WriteAllText($sumsPath, (($sums -join "`n") + "`n"), $enc)

Write-Host "已生成发包清单：$latestPath（v$Version / $Channel）" -ForegroundColor Green
Write-Host "已生成校验摘要：$sumsPath" -ForegroundColor DarkGray

if ($UploadGitHub) {
  if (-not $GitHubRepo) { throw '启用 -UploadGitHub 必须同时提供 -GitHubRepo "owner/repo"' }
  $gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
  if (-not $gh) { throw '未找到 GitHub CLI (gh)，请先安装并执行 gh auth login' }
  $files = @($latestPath, $sumsPath)
  if ($hasInst) { $files += $instPath }
  $tmpAsciiPort = $null
  if ($hasPort) {
    # 使用纯 ASCII 临时副本上传，保证 GitHub Releases 下载地址与 latest.json 100% 字节对齐、绝不 404
    $tmpAsciiPort = Join-Path ([IO.Path]::GetTempPath()) "TidyAssistant_${Version}_x64-portable.zip"
    Copy-Item -LiteralPath $portPath -Destination $tmpAsciiPort -Force
    $files += $tmpAsciiPort
  }
  $tag = "v$Version"
  $args = @('release', 'create', $tag) + $files + @('--repo', $GitHubRepo, '--title', "TidyAssistant $tag", '--notes', $Notes)
  if ($Channel -eq 'beta') { $args += '--prerelease' }
  Write-Host "正在上传 Release $tag 到 GitHub ($GitHubRepo)…" -ForegroundColor Cyan
  try {
    & $gh @args
    if ($LASTEXITCODE -ne 0) { throw "gh release create 失败（退出码 $LASTEXITCODE）" }
  } finally {
    if ($tmpAsciiPort -and (Test-Path -LiteralPath $tmpAsciiPort)) {
      Remove-Item -LiteralPath $tmpAsciiPort -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Host "GitHub Release 发布成功：https://github.com/$GitHubRepo/releases/tag/$tag" -ForegroundColor Green
}

if ($ServeLocal) {
  $listener = [System.Net.HttpListener]::new()
  $prefix = "http://127.0.0.1:$Port/"
  $listener.Prefixes.Add($prefix)
  $listener.Start()
  Write-Host "`n本地更新测试源已启动：$($prefix)latest.json" -ForegroundColor Cyan
  Write-Host "按 Ctrl+C 停止服务。请在软件「设置 → 版本与在线更新」填入上述地址测试。" -ForegroundColor Yellow
  try {
    while ($listener.IsListening) {
      $ctx = $listener.GetContext()
      $reqPath = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
      $resp = $ctx.Response
      if (-not $reqPath -or $reqPath -eq 'latest.json') {
        $reqPath = 'latest.json'
      }
      if ($reqPath.Contains('..') -or $reqPath.Contains('/') -or $reqPath.Contains('\')) {
        $resp.StatusCode = 403
        $resp.Close()
        continue
      }
      $full = Join-Path $releaseDir $reqPath
      if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        $resp.StatusCode = 404
        $resp.Close()
        continue
      }
      $resp.ContentType = if ($reqPath.EndsWith('.json')) { 'application/json; charset=utf-8' }
        elseif ($reqPath.EndsWith('.txt')) { 'text/plain; charset=utf-8' }
        else { 'application/octet-stream' }
      $fs = [IO.File]::OpenRead($full)
      try {
        $resp.ContentLength64 = $fs.Length
        $fs.CopyTo($resp.OutputStream)
      } finally {
        $fs.Dispose()
        $resp.OutputStream.Close()
      }
      Write-Host ("  [200] /{0}" -f $reqPath) -ForegroundColor DarkGray
    }
  } finally {
    $listener.Stop()
    $listener.Close()
  }
}
