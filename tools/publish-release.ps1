<#
  整理助手 · 在线发包与更新清单生成脚本
  ------------------------------------------------------------------
  用法：
    1) 生成静态站点 / OSS / R2 / Gitee / Nginx 清单：
       pwsh -File .\tools\publish-release.ps1 -BaseUrl "https://cdn.example.com/tidy/"

    2) 生成 GitHub Releases 清单（可选 -UploadGitHub 自动调 gh 上传）：
       pwsh -File .\tools\publish-release.ps1 -GitHubRepo "Bireo/QDisk"
       pwsh -File .\tools\publish-release.ps1 -GitHubRepo "Bireo/QDisk" -UploadGitHub

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
  [string]$GitHubRepo = 'Bireo/QDisk',
  [string]$Notes = '',
  [string]$NotesFile = '',
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

$instFile = "QDisk_${Version}_x64-setup.exe"
$portFile = "QDisk_${Version}_x64-portable.zip"
$instPath = Join-Path $releaseDir $instFile
$portPath = Join-Path $releaseDir $portFile

$hasInst = Test-Path $instPath
$hasPort = Test-Path $portPath
if (-not $hasInst -and -not $hasPort) {
  throw "release\ 中找不到 v$Version 的安装包或便携包（期望 $instFile 或 $portFile）"
}

function Get-Sha256Lower([string]$p) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $fs = New-Object System.IO.FileStream($p, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read, 262144)
  try {
    $hash = $sha.ComputeHash($fs)
    return ([BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant())
  } finally {
    $fs.Dispose()
    $sha.Dispose()
  }
}

function Get-NotesFromChangelog([string]$ver, [string]$path) {
  if (-not (Test-Path $path)) { return "轻盘 QDisk v$ver 正式发布。" }
  $raw = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
  $escaped = [regex]::Escape($ver)
  $m = [regex]::Match($raw, "(?ms)^##\s+${escaped}\b.*?(?=^##\s+|\z)")
  if (-not $m.Success) { return "轻盘 QDisk v$ver 正式发布。" }
  $txt = $m.Value.Trim()
  if ($txt.Length -gt 2400) { $txt = $txt.Substring(0, 2400).TrimEnd() + "`n…" }
  return $txt
}

if (-not $Notes) {
  $Notes = Get-NotesFromChangelog -ver $Version -path $changelogPath
}
$ReleaseBody = $Notes
if ($NotesFile) {
  if (-not (Test-Path -LiteralPath $NotesFile)) {
    throw "找不到 NotesFile：$NotesFile"
  }
  $ReleaseBody = [IO.File]::ReadAllText($NotesFile, [Text.Encoding]::UTF8).Trim()
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

function Get-Sha256Parallel([string[]]$Paths) {
  if (-not ([System.Management.Automation.PSTypeName]'TidyFastSha').Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Security.Cryptography;
using System.Threading.Tasks;

public static class TidyFastSha {
  public static ConcurrentDictionary<string, string> ComputeAll(string[] paths) {
    var dict = new ConcurrentDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    Parallel.ForEach(paths, p => {
      using (var sha = SHA256.Create())
      using (var fs = new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.Read, 262144)) {
        var h = sha.ComputeHash(fs);
        dict[p] = BitConverter.ToString(h).Replace("-", "").ToLowerInvariant();
      }
    });
    return dict;
  }
}
'@
  }
  return [TidyFastSha]::ComputeAll($Paths)
}

$hashTargets = New-Object System.Collections.Generic.List[string]
if ($hasInst) { $hashTargets.Add($instPath) }
if ($hasPort) { $hashTargets.Add($portPath) }
$shaMap = if ($hashTargets.Count -gt 0) { Get-Sha256Parallel -Paths ($hashTargets.ToArray()) } else { @{} }

$sums = New-Object System.Collections.Generic.List[string]

if ($hasInst) {
  $sha = $shaMap[$instPath]
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
  $sha = $shaMap[$portPath]
  $len = (Get-Item -LiteralPath $portPath).Length
  # 纯 ASCII 文件名，确保 GitHub Releases 下载地址与 latest.json 100% 字节对齐、绝不 404
  $remotePortFile = "QDisk_${Version}_x64-portable.zip"
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
$latestTmp = "$latestPath.tmp"
$sumsTmp = "$sumsPath.tmp"
[IO.File]::WriteAllText($latestTmp, $jsonText + "`n", $enc)
Move-Item -LiteralPath $latestTmp -Destination $latestPath -Force
[IO.File]::WriteAllText($sumsTmp, (($sums -join "`n") + "`n"), $enc)
Move-Item -LiteralPath $sumsTmp -Destination $sumsPath -Force

Write-Host "已生成发包清单：$latestPath（v$Version / $Channel）" -ForegroundColor Green
Write-Host "已生成校验摘要：$sumsPath" -ForegroundColor DarkGray

if ($UploadGitHub) {
  if (-not $GitHubRepo) { throw '启用 -UploadGitHub 必须同时提供 -GitHubRepo "owner/repo"' }
  $gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
  if (-not $gh) { throw '未找到 GitHub CLI (gh)，请先安装并执行 gh auth login' }
  $files = @()
  if ($hasInst) { $files += $instPath }
  $tmpAsciiPort = $null
  if ($hasPort) {
    $files += $portPath
  }
  # Strictly upload SHA256SUMS.txt then latest.json LAST after binary assets
  $files += @($sumsPath, $latestPath)
  $tag = "v$Version"
  $tmpBody = Join-Path ([IO.Path]::GetTempPath()) "tidy_release_notes_${Version}.md"
  [IO.File]::WriteAllText($tmpBody, $ReleaseBody + "`n", $enc)
  $args = @('release', 'create', $tag) + $files + @('--repo', $GitHubRepo, '--title', "轻盘 QDisk $tag", '--notes-file', $tmpBody)
  if ($Channel -eq 'beta') { $args += '--prerelease' }
  Write-Host "正在上传 Release $tag 到 GitHub ($GitHubRepo)…" -ForegroundColor Cyan
  try {
    & $gh @args
    if ($LASTEXITCODE -ne 0) { throw "gh release create 失败（退出码 $LASTEXITCODE）" }
  } finally {
    if (Test-Path -LiteralPath $tmpBody) {
      Remove-Item -LiteralPath $tmpBody -Force -ErrorAction SilentlyContinue
    }
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
