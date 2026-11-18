<#
  整理助手 构建脚本
  ------------------------------------------------------------------
  .\build.ps1                           全量：重建外壳 + 打安装包 + 打便携包（默认）
  .\build.ps1 -AppOnly                  只重建外壳，覆盖根目录 tidy-assistant.exe
  .\build.ps1 -Bundle                   只补打 NSIS 安装包到 release\
  .\build.ps1 -Portable                 只补打便携 zip 到 release\
  .\build.ps1 -Engine                   只重建 Python 引擎（覆盖 引擎\）
  .\build.ps1 -Bump patch|minor|major   递增版本号（写入 tauri.conf.json + Cargo.toml）
  .\build.ps1 -Version 2.1.0            直接指定版本号
  .\build.ps1 -Clean                    先删构建缓存再构建

  默认全量是有原因的：只出 exe 时 release\ 里的安装包会停在老版本，
  用户装了安装包就等于装到旧功能（1.36.8 记过这个坑）。

  版本规范见 docs\01-当前版\版本管理与发布规范.md：
  每次改动都要有版本号；release\ 只留最新与上一版（本脚本自动清理更旧的同类产物）。

  为什么路径这么绕：
  - GNU 工具链不能处理中文路径，所以源码必须放在纯 ASCII 目录（本目录已是）。
  - 全局没有 `cargo tauri`，统一用本目录 tools\cargo-tauri.exe。
  - 构建缓存放 D:\Builds（纯 ASCII），不污染源码树。
#>
[CmdletBinding()]
param(
  [switch]$Engine,
  [switch]$Bundle,
  [switch]$Portable,
  [switch]$AppOnly,
  [switch]$Clean,
  [switch]$Status,
  [string]$Version,
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Bump
)

$ErrorActionPreference = 'Stop'
$root      = $PSScriptRoot
$tauriDir  = Join-Path $root 'src\src-tauri'
$engineSrc = Join-Path $root 'src\engine'
$confPath  = Join-Path $tauriDir 'tauri.conf.json'
$cargoPath = Join-Path $tauriDir 'Cargo.toml'
$target    = 'D:\Builds\tidyassistant-target'
$pyTag     = 'Astral\CPython3.11.15'   # 与现网引擎的 python311.dll 对齐

# ---------------------------------------------------------------- 构建管理
# 锁 / 源码快照 / 构建台账都在 tools\build-manager.ps1：
#   - 同一时间只允许一个会话构建（锁文件 D:\Builds\.locks\tidyassistant.build.lock）
#   - 构建前把当前源码树提交进 git（tag build-<版本>），产物永远追得回源码
#   - 每次构建追加一条记录到 D:\Builds\tidyassistant-builds.jsonl
# 规范见 docs\01-当前版\构建管理.md。缺模块就直接中止，绝不在无锁状态下构建。
$managerPath = Join-Path $root 'tools\build-manager.ps1'
if (-not (Test-Path $managerPath)) { throw "缺少构建管理模块：$managerPath（已中止，避免无锁并发构建）" }
. $managerPath
if ($Status) { Show-TidyBuildStatus -Root $root; return }

if ($Clean) {
  Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host '已清理构建缓存' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- 版本号

function Get-Version {
  $json = Get-Content $confPath -Raw -Encoding UTF8 | ConvertFrom-Json
  return [string]$json.version
}

function Set-Version([string]$v) {
  if ($v -notmatch '^\d+\.\d+\.\d+$') { throw "版本号格式错误：$v（应为 1.2.3）" }
  $enc = New-Object Text.UTF8Encoding($false)

  $conf = [IO.File]::ReadAllText($confPath, [Text.Encoding]::UTF8)
  $conf = [regex]::Replace($conf, '("version"\s*:\s*")[^"]+(")', { param($m) $m.Groups[1].Value + $v + $m.Groups[2].Value }, 1)
  [IO.File]::WriteAllText($confPath, $conf, $enc)

  $cargo = [IO.File]::ReadAllText($cargoPath, [Text.Encoding]::UTF8)
  $cargo = [regex]::Replace($cargo, '(?m)^(version\s*=\s*")[^"]+(")', { param($m) $m.Groups[1].Value + $v + $m.Groups[2].Value }, 1)
  [IO.File]::WriteAllText($cargoPath, $cargo, $enc)
}

function Next-Version([string]$cur, [string]$kind) {
  $p = $cur.Split('.')
  $a = [int]$p[0]; $b = [int]$p[1]; $c = [int]$p[2]
  switch ($kind) {
    'major' { return "$($a + 1).0.0" }
    'minor' { return "$a.$($b + 1).0" }
    'patch' { return "$a.$b.$($c + 1)" }
  }
}

# 版本号的实际读写放在主流程里（必须先拿到构建锁，否则两个会话会互相覆盖）

# ---------------------------------------------------------------- 构建步骤

function Build-IndexWalk {
  Write-Host '[0/2] 编译 Rust 遍历器 indexwalk…' -ForegroundColor Cyan
  $env:RUSTUP_TOOLCHAIN = 'gnu-d'
  $env:CARGO_HOME       = 'D:\Tool\cargo-ascii'
  $env:CARGO_TARGET_DIR = 'D:\Builds\indexwalk-target'
  $env:Path             = 'D:\Tool\binutils\mingw64\bin;' + $env:Path

  $proj = Join-Path $engineSrc 'walkr'
  & cargo build --release --manifest-path (Join-Path $proj 'Cargo.toml')
  if ($LASTEXITCODE -ne 0) { throw 'indexwalk 构建失败' }

  $built = 'D:\Builds\indexwalk-target\release\indexwalk.exe'
  if (-not (Test-Path $built)) { throw 'indexwalk.exe 未生成' }
  # 源码目录也放一份：直接跑 tidy.py 时能找到它，不必设环境变量
  Copy-Item $built (Join-Path $engineSrc 'indexwalk.exe') -Force
  Write-Host ('  遍历器：{0:N0} KB' -f ((Get-Item $built).Length / 1KB)) -ForegroundColor DarkGray
  return $built
}

function Build-Engine {
  Write-Host '[1/2] 打包 Python 引擎…' -ForegroundColor Cyan
  $work = 'D:\Builds\tidyassistant-engine'
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  $walkExe = Build-IndexWalk
  # 构建用的解释器：优先用带齐运行期依赖的 venv（pillow/docx/pypdf/pystray…），
  # 没有就退回裸 py 标签。裸环境缺依赖时 PyInstaller 会静默跳过那些包，
  # 打出来的引擎看着能跑，实际缺能力——见 docs\01-当前版\打包与发布.md。
  $enginePy = 'D:\Builds\engine-venv\Scripts\python.exe'
  Push-Location $engineSrc
  try {
    if (Test-Path $enginePy) {
      & $enginePy -m PyInstaller --noconfirm --distpath "$work\dist" --workpath "$work\build" '整理助手引擎.spec'
    } else {
      Write-Host '  警告：没找到 engine-venv，用裸环境打包（可能缺 PIL/docx 等）' -ForegroundColor Yellow
      & py -V:$pyTag -m PyInstaller --noconfirm --distpath "$work\dist" --workpath "$work\build" '整理助手引擎.spec'
    }
    if ($LASTEXITCODE -ne 0) { throw 'PyInstaller 构建失败' }
  } finally { Pop-Location }

  # 遍历器是独立进程，放到引擎目录根下，tidy.py 会优先用它
  Copy-Item $walkExe (Join-Path $work 'dist\整理助手引擎\indexwalk.exe') -Force

  # 运行中的引擎会锁住 引擎\ 里的文件，先关掉；否则 robocopy 会一直重试
  Get-Process -Name tidy-assistant,整理助手引擎 -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500

  # /MIR 而不是 /E：引擎目录里会残留上一版才用到的文件（旧构建漏删会多出几十 MB），
  # /XF 数据位置.json 保住运行时状态。被占用最多重试两次就报错，不无声卡住。
  robocopy "$work\dist\整理助手引擎" (Join-Path $root '引擎') /MIR /XF '数据位置.json' /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "引擎目录复制失败（robocopy 退出码 $LASTEXITCODE）" }
  Write-Host ('引擎已更新：{0:N1} MB' -f ((Get-ChildItem (Join-Path $root '引擎') -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)) -ForegroundColor Green
}

function Build-App {
  Write-Host '[1/2] 编译 Rust 外壳…' -ForegroundColor Cyan
  $env:RUSTUP_TOOLCHAIN = 'gnu-d'
  $env:CARGO_HOME       = 'D:\Tool\cargo-ascii'
  $env:CARGO_TARGET_DIR = $target
  $env:Path             = 'D:\Tool\binutils\mingw64\bin;' + $env:Path

  $cli = Join-Path $root 'tools\cargo-tauri.exe'
  Push-Location $tauriDir
  try {
    if (Test-Path $cli) {
      $cliArgs = @('build')
      if ($Bundle) { $cliArgs += @('--bundles', 'nsis') }
      & $cli @cliArgs
    } else {
      & cargo build --release --target x86_64-pc-windows-gnu
    }
    if ($LASTEXITCODE -ne 0) { throw 'Rust 构建失败' }
  } finally { Pop-Location }

  # 运行中的实例会锁住 exe，先关掉（引擎跟着退）
  $running = Get-Process -Name tidy-assistant,整理助手引擎 -ErrorAction SilentlyContinue
  if ($running) {
    Write-Host '  关闭运行中的实例…' -ForegroundColor DarkGray
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 800
  }

  $built = Join-Path $target 'x86_64-pc-windows-gnu\release\tidy-assistant.exe'
  if (-not (Test-Path $built)) { throw "找不到产物：$built" }
  Copy-Item $built (Join-Path $root 'tidy-assistant.exe') -Force
  Write-Host ('exe 已更新：{0:N0} B（{1}）' -f (Get-Item $built).Length, $current) -ForegroundColor Green

  if ($Bundle) {
    $nsis = Join-Path $target 'x86_64-pc-windows-gnu\release\bundle\nsis'
    # 只认当前版本号的产物：目录里可能残留旧版本（tauri 不会清理），拿错就会把旧包当新包发
    $pkg = Get-ChildItem (Join-Path $nsis "TidyAssistant_${current}_x64-setup.exe") -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $pkg) {
      # 只有目录里根本没有当前版本时才回退；回退到别的版本会把旧包当新包发，所以直接报错
      $latest = Get-ChildItem "$nsis\*.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
      $hint = if ($latest) { "目录里最新的是 $($latest.Name)" } else { '目录是空的' }
      throw "没有 $current 的安装包（$hint）。tauri 可能没重新打包，别拿旧包顶替。"
    }
    if (-not $pkg) { throw "没找到 NSIS 产物：$nsis" }
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'release') | Out-Null
    Copy-Item $pkg.FullName (Join-Path $root 'release') -Force
    Write-Host ("安装包：release\{0}（{1:N1} MiB）" -f $pkg.Name, ($pkg.Length / 1MB)) -ForegroundColor Green
  }
}

function Build-Portable {
  Write-Host '[2/2] 打包便携版…' -ForegroundColor Cyan
  $stage = 'D:\Builds\tidyassistant-portable'
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $stage | Out-Null

  Copy-Item (Join-Path $root 'tidy-assistant.exe') $stage -Force
  Copy-Item (Join-Path $root 'WebView2Loader.dll') $stage -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $root 'THIRD_PARTY.md') $stage -Force -ErrorAction SilentlyContinue
  robocopy (Join-Path $root '引擎') (Join-Path $stage '引擎') /E /NFL /NDL /NJH /NJS /NP | Out-Null
  Remove-Item (Join-Path $stage '引擎\数据位置.json') -Force -ErrorAction SilentlyContinue   # 运行时会重建，别把本机数据目录带给别人

  @"
整理助手 $current 便携版
=====================
直接双击 tidy-assistant.exe 即可运行，无需安装。
数据目录：%LOCALAPPDATA%\整理助手数据（配置、日志、WebView2 缓存、整理历史）
引擎：本目录下 引擎\整理助手引擎.exe
注意：整个目录可以放在任意位置，但路径请勿包含中文，否则 WebView2 无法初始化。
RAR：首次打开 RAR 时会自动下载官方 UnRAR64.dll 并校验，需要联网；许可见 THIRD_PARTY.md。
"@ | Set-Content (Join-Path $stage '使用说明.txt') -Encoding UTF8

  $zip = Join-Path $root "release\整理助手_${current}_便携版.zip"
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'release') | Out-Null
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
  Write-Host ('便携包：release\{0}（{1:N1} MiB）' -f (Split-Path $zip -Leaf), ((Get-Item $zip).Length / 1MB)) -ForegroundColor Green
}

# ---------------------------------------------------------------- 只留最新与上一版

function Remove-OldReleases([string]$pattern) {
  $dir = Join-Path $root 'release'
  if (-not (Test-Path $dir)) { return }
  $files = Get-ChildItem $dir -Filter $pattern -File -ErrorAction SilentlyContinue
  if (-not $files) { return }

  $groups = $files | Group-Object {
    if ($_.Name -match '(\d+\.\d+\.\d+)') { $Matches[1] } else { '0.0.0' }
  } | Sort-Object { [version]$_.Name } -Descending

  foreach ($g in ($groups | Select-Object -Skip 2)) {
    foreach ($f in $g.Group) {
      Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
      Write-Host ("  清理旧包：{0}" -f $f.Name) -ForegroundColor DarkGray
    }
  }
}

# ---------------------------------------------------------------- 主流程（全程持锁）

# 默认就把「装得上、发得出」的整套产物一起做：根目录 exe + NSIS 安装包 + 便携 zip。
# 历史教训（1.36.8 记录的坑）：1.35.x–1.36.x 一直用默认参数构建，只重编了根目录
# tidy-assistant.exe，没带 -Bundle/-Portable，于是 release\ 里的安装包与便携包
# 始终停在 1.34.1，用户装完自然看不到后来做的功能。
# 临时只想快速验证外壳能不能编译时，才用 -AppOnly 跳过打包。
if (-not $Engine -and -not $AppOnly) { $Bundle = $true; $Portable = $true }

$mode     = if ($Engine) { 'engine' } elseif ($Bundle) { 'full' } elseif ($Portable) { 'portable' } else { 'app' }
$appBuilt = (-not $Engine -and (-not $Portable -or $Bundle))

Enter-TidyBuildLock -Root $root -Mode $mode | Out-Null
$startedAt = Get-Date
$record = @{
  version  = ''
  kind     = 'none'
  mode     = $mode
  session  = (Get-TidySessionTag)
  result   = 'failed'
  git      = ''
  exe      = ''
  exeBytes = 0
  releases = @()
  duration = ''
  note     = ''
}

try {
  $current = Get-Version

  if ($Bump) {
    $next = Next-Version $current $Bump
    Set-Version $next
    Write-Host "版本号：$current → $next（$Bump）" -ForegroundColor Green
    $current = $next
    $record.kind = "bump:$Bump"
  } elseif ($Version) {
    Set-Version $Version
    Write-Host "版本号：$current → $Version（指定）" -ForegroundColor Green
    $current = $Version
    $record.kind = 'explicit'
  } else {
    Write-Host "版本号：$current" -ForegroundColor DarkGray
  }
  $record.version = $current
  Update-TidyBuildLock -Version $current

  # 构建前快照：把当前工作树（含别人的未提交改动）固定成一个 git 提交。
  # 之后不管谁再改、谁再构建，这一次产物的源码都追得回来。
  Write-Host '记录源码快照…' -ForegroundColor DarkGray
  $snapshot = Save-TidySourceSnapshot -Root $root -Version $current -Reason $mode
  $record.git = $snapshot
  if ($snapshot) { Write-Host ("  源码快照：{0}（tag build-{1}）" -f $snapshot, $current) -ForegroundColor DarkGray }

  if ($Engine)  { Build-Engine }
  if ($appBuilt) { Build-App }
  if ($Portable) { Build-Portable }

  if ($Bundle)   { Remove-OldReleases 'TidyAssistant_*_x64-setup.exe' }
  if ($Portable) { Remove-OldReleases '*便携版.zip' }

  # 产物自检：版本、二进制、安装包三者必须对得上
  $exe = Join-Path $root 'tidy-assistant.exe'
  if (Test-Path $exe) {
    $record.exe = Get-TidyFileSha256 $exe
    $record.exeBytes = (Get-Item $exe).Length
  }
  $releases = @()
  if ($Bundle) {
    $pkg = Join-Path $root ("release\TidyAssistant_{0}_x64-setup.exe" -f $current)
    if (-not (Test-Path $pkg)) { throw "安装包缺失：$pkg" }
    $releases += @{ name = (Split-Path $pkg -Leaf); sha256 = (Get-TidyFileSha256 $pkg) }
  }
  if ($Portable) {
    $zip = Join-Path $root ("release\整理助手_{0}_便携版.zip" -f $current)
    if (-not (Test-Path $zip)) { throw "便携包缺失：$zip" }
    $releases += @{ name = (Split-Path $zip -Leaf); sha256 = (Get-TidyFileSha256 $zip) }
  }
  $record.releases = $releases

  $issues = Test-TidyBuildHealth -Root $root -SkipExe:(-not $appBuilt)
  if ($issues.Count -gt 0) { throw ("产物自检不通过：" + ($issues -join '；')) }

  $record.result = 'ok'
} catch {
  $record.duration = ('{0:N1}s' -f ((Get-Date) - $startedAt).TotalSeconds)
  $record.note = $_.Exception.Message
  Write-TidyBuildRecord -Root $root -Record $record
  Write-Host ("构建失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
  throw
} finally {
  Exit-TidyBuildLock
}

$record.duration = ('{0:N1}s' -f ((Get-Date) - $startedAt).TotalSeconds)
Write-TidyBuildRecord -Root $root -Record $record

$tagged = Tag-TidyBuild -Root $root -Version $current -Commit $snapshot
if (-not $tagged) {
  Write-Host ("警告：build-{0} 标签已存在（同版本重复构建）。版本规范禁止一份版本号对应两份不同二进制，确认这次不是要顶替已发布的包。" -f $current) -ForegroundColor Yellow
}

$prevSame = Get-TidyBuildHistory -Last 80 | Where-Object { $_.version -eq $current -and $_.result -eq 'ok' -and $_.exe -and $_.exe -ne $record.exe }
if ($prevSame) {
  Write-Host ("警告：版本 {0} 之前构建过，且 exe 哈希不同。回滚时无法判断装的是哪一份，请递增版本号。" -f $current) -ForegroundColor Yellow
}

Write-Host ("构建完成：{0}（{1}，{2}）" -f $current, $record.duration, $record.git) -ForegroundColor Green
Write-Host ("release\ 现存：{0}" -f ((Get-ChildItem (Join-Path $root 'release') -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ' | ')) -ForegroundColor Cyan
