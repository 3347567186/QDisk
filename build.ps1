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
  .\build.ps1 -SkipTests                跳过测试门禁（只在自己确认过测试是红的、且与本次改动无关时用）

  测试门禁：构建前跑引擎 4 个 unittest 模块 + 前端 6 个 selftest，
  任何一项红就中止，不产出任何产物。

  默认全量是有原因的：只出 exe 时 release\ 里的安装包会停在老版本，
  用户装了安装包就等于装到旧功能（1.36.8 记过这个坑）。

  引擎也会自动跟上：默认全量/打包时会比对 src\engine\ 与 引擎\整理助手引擎.exe
  的时间，源码更新就先重建引擎再打包，并在产物自检里再查一次。
  （1.39.0、1.40.0 都出过「包装好了、新方法 404」的包，原因就是以前只有 -Engine 才重建。）
  只想快速验外壳能编译时用 -AppOnly，它明确不动引擎。

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
  [switch]$SkipTests,
  [switch]$TestsOnly,
  [string]$Version,
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Bump,
  [string]$ReleaseBaseUrl = '',
  [ValidateSet('stable', 'beta')]
  [string]$Channel = 'stable'
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
  if ($v -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$') {
    throw "版本号格式错误：$v（应为 1.2.3 或 1.2.3-beta.1）"
  }
  $enc = New-Object Text.UTF8Encoding($false)

  $conf = [IO.File]::ReadAllText($confPath, [Text.Encoding]::UTF8)
  $conf = [regex]::Replace($conf, '("version"\s*:\s*")[^"]+(")', { param($m) $m.Groups[1].Value + $v + $m.Groups[2].Value }, 1)
  [IO.File]::WriteAllText($confPath, $conf, $enc)

  $cargo = [IO.File]::ReadAllText($cargoPath, [Text.Encoding]::UTF8)
  $cargo = [regex]::Replace($cargo, '(?m)^(version\s*=\s*")[^"]+(")', { param($m) $m.Groups[1].Value + $v + $m.Groups[2].Value }, 1)
  [IO.File]::WriteAllText($cargoPath, $cargo, $enc)

  $lockPath = Join-Path $tauriDir 'Cargo.lock'
  if (Test-Path -LiteralPath $lockPath) {
    $lockRaw = [IO.File]::ReadAllText($lockPath, [Text.Encoding]::UTF8)
    $lockNew = [regex]::Replace(
      $lockRaw,
      '(?ms)(\[\[package\]\]\r?\nname\s*=\s*"tidy-assistant"\r?\nversion\s*=\s*")[^"]+(")(?=(?:\r?\n(?!source\s*=)|\z))',
      { param($m) $m.Groups[1].Value + $v + $m.Groups[2].Value },
      1
    )
    if ($lockNew -ne $lockRaw) {
      [IO.File]::WriteAllText($lockPath, $lockNew, $enc)
    }
  }
}

function Next-Version([string]$cur, [string]$kind) {
  $m = [regex]::Match($cur.Trim(), '^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$')
  if (-not $m.Success) { throw "无法解析当前版本号：$cur（应为 1.2.3 或 1.2.3-beta.1）" }
  $a = [int]$m.Groups[1].Value
  $b = [int]$m.Groups[2].Value
  $c = [int]$m.Groups[3].Value
  $pre = $m.Groups[4].Value
  switch ($kind) {
    'major' { return "$($a + 1).0.0" }
    'minor' { return "$a.$($b + 1).0" }
    'patch' {
      # 若当前为预发布版（如 1.46.7-beta.1），patch 按 SemVer 直接转正为 1.46.7，不跳号
      if ($pre) { return "$a.$b.$c" }
      return "$a.$b.$($c + 1)"
    }
  }
}

# 版本号的实际读写放在主流程里（必须先拿到构建锁，否则两个会话会互相覆盖）

# ---------------------------------------------------------------- 性能与耗时辅助

function Format-CompactDuration([double]$TotalSeconds) {
  if ([double]::IsNaN($TotalSeconds) -or [double]::IsInfinity($TotalSeconds) -or $TotalSeconds -lt 0) {
    return '0.0s'
  }
  $tenths = [long][Math]::Round($TotalSeconds * 10.0, [MidpointRounding]::AwayFromZero)
  if ($tenths -lt 600) {
    return ('{0:0.0}s' -f ($tenths / 10.0))
  }
  $sec = [long][Math]::Floor($tenths / 10.0)
  $days = [long][Math]::Floor($sec / 86400)
  $rem = $sec % 86400
  $hours = [long][Math]::Floor($rem / 3600)
  $rem = $rem % 3600
  $mins = [long][Math]::Floor($rem / 60)
  $s = $rem % 60
  if ($days -gt 0) { return "${days}d${hours}h${mins}m${s}s" }
  if ($hours -gt 0) { return "${hours}h${mins}m${s}s" }
  return "${mins}m${s}s"
}

# 自动探测当前 gnu-d 工具链内置的 rust-lld (gcc-ld\ld.lld.exe)，找不到时无感回退默认 GNU ld
function Enable-FastRustLinker {
  try {
    $sysroot = (& rustc --print sysroot 2>$null | Select-Object -First 1)
    if ($sysroot) {
      $lldDir = Join-Path $sysroot.Trim() 'lib\rustlib\x86_64-pc-windows-gnu\bin\gcc-ld'
      $lldExe = Join-Path $lldDir 'ld.lld.exe'
      if (Test-Path -LiteralPath $lldExe) {
        if ($env:Path -notlike "*$lldDir*") {
          $env:Path = "$lldDir;$env:Path"
        }
        $curFlags = [string]$env:RUSTFLAGS
        if ($curFlags -notmatch '-fuse-ld=') {
          $env:RUSTFLAGS = (($curFlags.Trim() + ' -C link-arg=-fuse-ld=lld').Trim())
        }
        return $true
      }
    }
  } catch {}
  return $false
}

function Start-AsyncGateProcess {
  param(
    [string]$Kind,
    [string]$Name,
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory,
    [hashtable]$EnvVars = @{}
  )
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
  foreach ($a in $Arguments) { [void]$psi.ArgumentList.Add([string]$a) }
  foreach ($k in $EnvVars.Keys) { $psi.Environment[$k] = [string]$EnvVars[$k] }
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  return [pscustomobject]@{
    Kind   = $Kind
    Name   = $Name
    Proc   = $proc
    OutTsk = $proc.StandardOutput.ReadToEndAsync()
    ErrTsk = $proc.StandardError.ReadToEndAsync()
  }
}

# ---------------------------------------------------------------- 构建步骤

function Build-IndexWalk {
  $proj = Join-Path $engineSrc 'walkr'
  $dstExe = Join-Path $engineSrc 'indexwalk.exe'
  $built = 'D:\Builds\indexwalk-target\release\indexwalk.exe'
  if (-not $Clean -and (Test-Path -LiteralPath $dstExe)) {
    $exeTime = (Get-Item -LiteralPath $dstExe).LastWriteTimeUtc
    $newerWalk = Get-ChildItem $proj -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Extension -in @('.rs', '.toml', '.lock') -and $_.FullName -notmatch '\\target\\' -and $_.LastWriteTimeUtc -gt $exeTime }
    if (-not $newerWalk) {
      Write-Host ('[0/2] 跳过 indexwalk 重编（源码未变，复用现存 {0:N0} KB）' -f ((Get-Item -LiteralPath $dstExe).Length / 1KB)) -ForegroundColor DarkGray
      return $dstExe
    }
  }

  Write-Host '[0/2] 编译 Rust 遍历器 indexwalk…' -ForegroundColor Cyan
  $env:RUSTUP_TOOLCHAIN = 'gnu-d'
  $env:CARGO_HOME       = 'D:\Tool\cargo-ascii'
  $env:CARGO_TARGET_DIR = 'D:\Builds\indexwalk-target'
  $env:Path             = 'D:\Tool\binutils\mingw64\bin;' + $env:Path
  [void](Enable-FastRustLinker)

  & cargo build --release --manifest-path (Join-Path $proj 'Cargo.toml')
  if ($LASTEXITCODE -ne 0) { throw 'indexwalk 构建失败' }

  if (-not (Test-Path $built)) { throw 'indexwalk.exe 未生成' }
  # 源码目录也放一份：直接跑 tidy.py 时能找到它，不必设环境变量
  Copy-Item $built $dstExe -Force
  Write-Host ('  遍历器：{0:N0} KB' -f ((Get-Item $built).Length / 1KB)) -ForegroundColor DarkGray
  return $built
}

# ---------------------------------------------------------------- 引擎是否过期
# 1.39.0 与 1.40.0 都踩过同一个坑：改了 src\engine\ 下的 Python，跑「默认全量」构建，
# 打出来的安装包里装的仍是旧引擎 —— 因为 Build-Engine 只在显式 -Engine 时才跑。
# 结果新功能在真机上 404，而构建日志一片绿，看上去什么都对。
#
# 修法不是「默认全量就重建引擎」（PyInstaller 要几分钟，改个前端也要等它），
# 而是先看事实：源码比引擎二进制新，就说明包会装错东西，这时必须重建。
# 判据只看「会进引擎的源文件」，数据目录、缓存、__pycache__ 不算。
function Test-EngineStale {
  $exe = Join-Path $root '引擎\整理助手引擎.exe'
  if (-not (Test-Path $exe)) { return $true }
  $built = (Get-Item $exe).LastWriteTimeUtc
  $skip = @('数据', 'cache', '__pycache__', '.pytest_cache', 'target', 'dist', 'build')
  $newer = Get-ChildItem $engineSrc -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Extension -in @('.py', '.spec', '.json', '.yaml', '.yml', '.txt', '.rs', '.toml') -and
      $_.Name -notmatch '^(test_.*|.*_test)\.py$' -and
      -not ($_.FullName -split '\\' | Where-Object { $skip -contains $_ })
    } |
    Where-Object { $_.LastWriteTimeUtc -gt $built }
  if ($newer) {
    $newest = $newer | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    Write-Host ("  引擎已过期：{0} 比引擎二进制新（{1:N0} 个源文件）" -f `
      (Resolve-Path -Relative $newest.FullName), $newer.Count) -ForegroundColor Yellow
    return $true
  }
  return $false
}

function Build-Engine {
  Write-Host '[1/2] 打包 Python 引擎…' -ForegroundColor Cyan
  $work = 'D:\Builds\tidyassistant-engine'
  if ($Clean) {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    # 增量保留 PyInstaller 分析缓存 ($work\build)，仅清空输出目录 ($work\dist) 保证零残留
    Remove-Item (Join-Path $work 'dist') -Recurse -Force -ErrorAction SilentlyContinue
  }
  $walkExe = Build-IndexWalk
  # 构建用的解释器：优先用带齐运行期依赖的 venv（pillow/docx/pypdf/pystray…），
  # 没有就退回裸 py 标签。裸环境缺依赖时 PyInstaller 会静默跳过那些包，
  # 打出来的引擎看着能跑，实际缺能力——见 docs\01-当前版\打包与发布.md。
  $enginePy = 'D:\Builds\engine-venv\Scripts\python.exe'
  Push-Location $engineSrc
  try {
    $pyiArgs = @('-m', 'PyInstaller', '--noconfirm', '--log-level', 'WARN', '--distpath', "$work\dist", '--workpath', "$work\build", '整理助手引擎.spec')
    if ($Clean) { $pyiArgs = @('-m', 'PyInstaller', '--noconfirm', '--clean', '--log-level', 'WARN', '--distpath', "$work\dist", '--workpath', "$work\build", '整理助手引擎.spec') }
    if (Test-Path $enginePy) {
      & $enginePy @pyiArgs
    } else {
      Write-Host '  警告：没找到 engine-venv，用裸环境打包（可能缺 PIL/docx 等）' -ForegroundColor Yellow
      & py -V:$pyTag @pyiArgs
    }
    if ($LASTEXITCODE -ne 0) { throw 'PyInstaller 构建失败' }
  } finally {
    Pop-Location
  }

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
  if (Enable-FastRustLinker) {
    Write-Host '  链接加速器：已启用 rust-lld + 多核 ThinLTO' -ForegroundColor DarkGray
  }

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
  } finally {
    Pop-Location
  }

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
    $pkg = Get-ChildItem (Join-Path $nsis "QDisk_${current}_x64-setup.exe") -ErrorAction SilentlyContinue | Select-Object -First 1
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
轻盘 · QDisk $current 便携版
=====================
直接双击 tidy-assistant.exe 即可运行，无需安装。
数据目录：%LOCALAPPDATA%\整理助手数据（配置、日志、WebView2 缓存、整理历史）
引擎：本目录下 引擎\整理助手引擎.exe
注意：整个目录可以放在任意位置，但路径请勿包含中文，否则 WebView2 无法初始化。
RAR：首次打开 RAR 时会自动下载官方 UnRAR64.dll 并校验，需要联网；许可见 THIRD_PARTY.md。
"@ | Set-Content (Join-Path $stage '使用说明.txt') -Encoding UTF8

  $zip = Join-Path $root "release\QDisk_${current}_x64-portable.zip"
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'release') | Out-Null
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stage,
    $zip,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )
  Write-Host ('便携包：release\{0}（{1:N1} MiB）' -f (Split-Path $zip -Leaf), ((Get-Item $zip).Length / 1MB)) -ForegroundColor Green
}

# ---------------------------------------------------------------- 测试门禁

# 为什么构建前必须跑测试：
# 这个项目在 1.35–1.41 之间积累了 40 多个版本「测试红了没人跑」的历史——
# scope.selftest 的一条断言盯死了 state.running，1.41.6 改成多会话之后
# 代码是对的、测试是红的，一直红到被发现。同一时期 test_migrate_engine
# 11 条红，对应的是 flatten 迁移把文件放错目录的真实 bug。
# 没有门禁的时候，「改完不跑测试」和「跑完不看结果」都不留痕迹；
# 加了门禁之后，坏掉的代码进不了 release\。
function Invoke-TidyTestGate {
  $gateSw = [Diagnostics.Stopwatch]::StartNew()
  Write-Host '跑测试门禁（Python + Node + Rust 多核并行）…' -ForegroundColor Cyan
  $py = 'D:\Builds\engine-venv\Scripts\python.exe'
  if (-not (Test-Path $py)) {
    Write-Host '  警告：没找到 engine-venv，用裸 py 跑引擎测试' -ForegroundColor Yellow
    $py = (Get-Command py -ErrorAction Stop).Source
  }
  $failed = @()

  # 1. 先计算 Rust 源码与依赖内容指纹（~30ms），若需要跑 Rust 测试则与 Python/Node 并发执行
  $rustDir = Join-Path $root 'src\src-tauri'
  $stampPath = 'D:\Builds\.rust-test-stamp'
  $rustFp = & {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $sb = New-Object System.Text.StringBuilder
      $items = New-Object System.Collections.Generic.List[object]

      foreach ($f in (Get-ChildItem $rustDir -Recurse -File -Filter '*.rs' -ErrorAction SilentlyContinue |
          Where-Object { $_.FullName -notmatch '\\(target|gen)\\' })) {
        $rel = $f.FullName.Substring($rustDir.Length).TrimStart('\').ToLowerInvariant()
        $items.Add([pscustomobject]@{ Key = $rel; Text = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8) })
      }
      $capDir = Join-Path $rustDir 'capabilities'
      if (Test-Path $capDir) {
        foreach ($f in (Get-ChildItem $capDir -Recurse -File -Filter '*.json' -ErrorAction SilentlyContinue)) {
          $rel = $f.FullName.Substring($rustDir.Length).TrimStart('\').ToLowerInvariant()
          $items.Add([pscustomobject]@{ Key = $rel; Text = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8) })
        }
      }
      $ct = Join-Path $rustDir 'Cargo.toml'
      if (Test-Path $ct) {
        $raw = [IO.File]::ReadAllText($ct, [Text.Encoding]::UTF8)
        $norm = [regex]::Replace($raw, '(?m)^(\s*version\s*=\s*")[^"]+(")', '${1}<VER>${2}', 1)
        $items.Add([pscustomobject]@{ Key = 'cargo.toml'; Text = $norm })
      }
      $cl = Join-Path $rustDir 'Cargo.lock'
      if (Test-Path $cl) {
        $raw = [IO.File]::ReadAllText($cl, [Text.Encoding]::UTF8)
        $norm = [regex]::Replace($raw, '(?ms)(\[\[package\]\]\r?\nname\s*=\s*"tidy-assistant"\r?\nversion\s*=\s*")[^"]+(")', '${1}<VER>${2}', 1)
        $items.Add([pscustomobject]@{ Key = 'cargo.lock'; Text = $norm })
      }
      $tc = Join-Path $rustDir 'tauri.conf.json'
      if (Test-Path $tc) {
        $raw = [IO.File]::ReadAllText($tc, [Text.Encoding]::UTF8)
        $norm = [regex]::Replace($raw, '("version"\s*:\s*")[^"]+(")', '${1}<VER>${2}', 1)
        $items.Add([pscustomobject]@{ Key = 'tauri.conf.json'; Text = $norm })
      }
      $cc = Join-Path $rustDir '.cargo\config.toml'
      if (Test-Path $cc) {
        $items.Add([pscustomobject]@{ Key = '.cargo/config.toml'; Text = [IO.File]::ReadAllText($cc, [Text.Encoding]::UTF8) })
      }

      foreach ($it in ($items | Sort-Object Key)) {
        [void]$sb.Append($it.Key).Append("`0").Append($it.Text).Append("`0")
      }
      $bytes = [Text.Encoding]::UTF8.GetBytes($sb.ToString())
      $hash = $sha.ComputeHash($bytes)
      'fp:v1:' + ([BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant())
    } finally {
      $sha.Dispose()
    }
  }
  $prevStamp = if (Test-Path $stampPath) { (Get-Content -Path $stampPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue).Trim() } else { '' }
  $needRust = ($rustFp -ne $prevStamp)

  # 2. 并发启动 4 个隔离 Python 单测 + 8 个前端/官网自测 +（若指纹变化）Rust cargo test
  # 注意：每个 worker 独立目录放在 D:\Builds\temp\sub1\w_<pid>_<mod>，与原 sub1\sub2 保持完全相同的目录深度（避免触发 test_app_guard 7 层深度守卫）
  $testTempRoot = 'D:\Builds\temp\sub1'
  if (-not (Test-Path $testTempRoot)) { New-Item -ItemType Directory -Path $testTempRoot -Force | Out-Null }
  $workerTemps = New-Object System.Collections.Generic.List[string]
  $pyJobs = New-Object System.Collections.Generic.List[object]
  $nodeJobs = New-Object System.Collections.Generic.List[object]
  $allJobs = New-Object System.Collections.Generic.List[object]
  $rustJob = $null
  $cargo = $null

  try {
    $modules = @('test_engine_rpc', 'test_migrate_engine', 'test_settings_dir', 'test_app_guard')
    foreach ($m in $modules) {
      $wTmp = Join-Path $testTempRoot ("w_{0}_{1}" -f $PID, $m)
      New-Item -ItemType Directory -Path $wTmp -Force | Out-Null
      $workerTemps.Add($wTmp)
      $job = Start-AsyncGateProcess -Kind 'py' -Name $m -FilePath $py `
        -Arguments @('-B', '-m', 'unittest', $m) `
        -WorkingDirectory $engineSrc `
        -EnvVars @{
          TEMP                    = $wTmp
          TMP                     = $wTmp
          PYTHONDONTWRITEBYTECODE = '1'
          PYTHONUTF8              = '1'
          PYTHONIOENCODING        = 'utf-8'
        }
      $pyJobs.Add($job)
      $allJobs.Add($job)
    }

    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) {
      Write-Host '  警告：没找到 node，跳过前端自测' -ForegroundColor Yellow
    } else {
      $aiDir = Join-Path $root 'src\web\js\ai'
      foreach ($f in (Get-ChildItem $aiDir -Filter '*.selftest.mjs' -File | Sort-Object Name)) {
        $job = Start-AsyncGateProcess -Kind 'node' -Name $f.Name -FilePath $node `
          -Arguments @($f.FullName) `
          -WorkingDirectory $root
        $nodeJobs.Add($job)
        $allJobs.Add($job)
      }
    }

    if ($needRust) {
      $cargo = (Get-Command cargo -ErrorAction SilentlyContinue).Source
      if (-not $cargo) {
        Write-Host '  警告：没找到 cargo，跳过 Rust 测试' -ForegroundColor Yellow
      } else {
        $env:RUSTUP_TOOLCHAIN = 'gnu-d'
        $env:CARGO_HOME = 'D:\Tool\cargo-ascii'
        $env:CARGO_TARGET_DIR = 'D:\Builds\tidyassistant-test-target'
        $env:PATH = "D:\Tool\binutils\mingw64\bin;$env:PATH"
        [void](Enable-FastRustLinker)
        $rustEnv = @{
          RUSTUP_TOOLCHAIN = 'gnu-d'
          CARGO_HOME       = 'D:\Tool\cargo-ascii'
          CARGO_TARGET_DIR = 'D:\Builds\tidyassistant-test-target'
          PATH             = $env:PATH
        }
        if ($env:RUSTFLAGS) { $rustEnv['RUSTFLAGS'] = $env:RUSTFLAGS }
        $rustJob = Start-AsyncGateProcess -Kind 'rust' -Name 'cargo test' -FilePath $cargo `
          -Arguments @('test', '--manifest-path', (Join-Path $rustDir 'Cargo.toml')) `
          -WorkingDirectory $rustDir `
          -EnvVars $rustEnv
        $allJobs.Add($rustJob)
      }
    }

    # 3. 按确定顺序收集并输出 Python 测试结果
    foreach ($j in $pyJobs) {
      $j.Proc.WaitForExit()
      $combined = (($j.OutTsk.GetAwaiter().GetResult() + "`n" + $j.ErrTsk.GetAwaiter().GetResult()) -split "`r?`n")
      $code = $j.Proc.ExitCode
      $tail = ($combined | Select-String -Pattern '^(Ran |OK|FAILED)' | ForEach-Object { $_.Line }) -join ' '
      if ($code -ne 0) {
        $failed += "引擎测试 $($j.Name) 未通过（$tail）"
        Write-Host ("  [红] {0}：{1}" -f $j.Name, $tail) -ForegroundColor Red
        ($combined | Select-String -Pattern '^(FAIL:|ERROR:|AssertionError)' |
            Select-Object -First 6 | ForEach-Object { Write-Host ("        " + $_.Line.Trim()) -ForegroundColor DarkYellow })
      } else {
        Write-Host ("  [绿] {0}：{1}" -f $j.Name, $tail) -ForegroundColor DarkGray
      }
    }

    # 4. 按确定顺序收集并输出 Node 自测结果
    foreach ($j in $nodeJobs) {
      $j.Proc.WaitForExit()
      $combined = (($j.OutTsk.GetAwaiter().GetResult() + "`n" + $j.ErrTsk.GetAwaiter().GetResult()) -split "`r?`n")
      $code = $j.Proc.ExitCode
      $last = ($combined | Where-Object { $_ -match '结果：' } | Select-Object -Last 1)
      if (-not $last) { $last = ($combined | Where-Object { $_ -match '\S' -and $_ -notmatch '^[─━-]+$' } | Select-Object -Last 1) }
      if ($code -ne 0) {
        $failed += "前端自测 $($j.Name) 未通过（$last）"
        Write-Host ("  [红] {0}：{1}" -f $j.Name, $last) -ForegroundColor Red
      } else {
        Write-Host ("  [绿] {0}：{1}" -f $j.Name, $last) -ForegroundColor DarkGray
      }
    }

    # 5. 收集 Rust 测试结果，并跑非 cfg(test) 的 cargo check --release 零警告门禁
    if (-not $needRust) {
      Write-Host '  [跳过] cargo test / check：Rust 源码与依赖指纹未变（仅版本或非 Rust 文件变动）' -ForegroundColor DarkGray
    } elseif ($rustJob) {
      $rustJob.Proc.WaitForExit()
      $out = (($rustJob.OutTsk.GetAwaiter().GetResult() + "`n" + $rustJob.ErrTsk.GetAwaiter().GetResult()) -split "`r?`n")
      $code = $rustJob.Proc.ExitCode
      $tail = ($out | Select-String -Pattern '^test result' | ForEach-Object { $_.Line }) -join ' '
      $warns = ($out | Select-String -Pattern '^warning: ' | Where-Object { $_.Line -notmatch 'generated \d+ warning' } | Measure-Object).Count
      if ($code -ne 0) {
        $failed += "Rust 测试未通过（$tail）"
        Write-Host ("  [红] cargo test：{0}" -f $tail) -ForegroundColor Red
        ($out | Select-String -Pattern '^(test .+ FAILED|error(\[E\d+\])?:|thread .+ panicked|  assertion)' |
            Select-Object -First 12 | ForEach-Object { Write-Host ("        " + $_.Line.Trim()) -ForegroundColor DarkYellow })
      } else {
        Write-Host ("  [绿] cargo test：{0}" -f $tail) -ForegroundColor DarkGray
      }
      if ($warns -gt 0) {
        $failed += "Rust 编译有 $warns 条警告（基线是 0）"
        Write-Host ("  [红] cargo 警告：{0} 条" -f $warns) -ForegroundColor Red
      }

      $bcode = 0
      $bwarns = 0
      if ($code -eq 0 -or $tail) {
        $bout = & $cargo check --release --manifest-path (Join-Path $rustDir 'Cargo.toml') 2>&1
        $bcode = $LASTEXITCODE
        $bwarns = ($bout | Select-String -Pattern '^warning: ' | Where-Object { $_.Line -notmatch 'generated \d+ warning' } | Measure-Object).Count
        if ($bcode -ne 0) {
          $failed += "Rust 发布检查失败（cargo check --release 退出码 $bcode）"
          Write-Host ("  [红] cargo check --release：退出码 {0}" -f $bcode) -ForegroundColor Red
          ($bout | Select-String -Pattern '^error(\[E\d+\])?:' |
              Select-Object -First 8 | ForEach-Object { Write-Host ("        " + $_.Line.Trim()) -ForegroundColor DarkYellow })
        } elseif ($bwarns -gt 0) {
          $failed += "Rust 发布检查有 $bwarns 条警告（基线是 0；注意这与 cargo test 的警告不是一回事）"
          Write-Host ("  [红] cargo check 警告：{0} 条" -f $bwarns) -ForegroundColor Red
          ($bout | Select-String -Pattern '^warning: ' | Where-Object { $_.Line -notmatch 'generated \d+ warning' } |
              Select-Object -First 5 | ForEach-Object { Write-Host ("        " + $_.Line.Trim()) -ForegroundColor DarkYellow })
        } else {
          Write-Host '  [绿] cargo check --release：0 条警告' -ForegroundColor DarkGray
        }
      }

      if ($code -eq 0 -and $warns -eq 0 -and $bcode -eq 0 -and $bwarns -eq 0) {
        Set-Content -Path $stampPath -Value $rustFp -Encoding UTF8
      }
    }
  } finally {
    foreach ($j in $allJobs) {
      if ($null -ne $j -and $null -ne $j.Proc) {
        try { if (-not $j.Proc.HasExited) { $j.Proc.Kill($true) } } catch {}
        try { $j.Proc.Dispose() } catch {}
      }
    }
    foreach ($wTmp in $workerTemps) {
      Remove-Item -LiteralPath $wTmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  $gateSw.Stop()
  if ($failed.Count -gt 0) {
    throw ("测试门禁不通过（{0} 项）：`n  {1}" -f $failed.Count, ($failed -join "`n  "))
  }
  Write-Host ("测试门禁通过（耗时 {0}）" -f (Format-CompactDuration $gateSw.Elapsed.TotalSeconds)) -ForegroundColor Green
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

function Clear-TidyWorkspaceResidue {
  $residue = @(
    (Join-Path $root 'src\engine\__pycache__'),
    (Join-Path $root 'src\engine\数据'),
    (Join-Path $root 'src\src-tauri\target')
  )
  foreach ($p in $residue) {
    if (Test-Path -LiteralPath $p) {
      Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
      Write-Host ("  清理残留缓存：{0}" -f $p.Substring($root.Length + 1)) -ForegroundColor DarkGray
    }
  }
}

# ---------------------------------------------------------------- 主流程（全程持锁）

# 只跑测试门禁：不取构建锁、不改版本号、不产生产物。
# 改完一处想快速知道有没有碰坏东西时用这个，比全量构建快得多。
if ($TestsOnly) {
  Clear-TidyWorkspaceResidue
  Invoke-TidyTestGate
  return
}

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

  # 构建前先清扫违规缓存，再做快照
  Clear-TidyWorkspaceResidue
  Write-Host '记录源码快照…' -ForegroundColor DarkGray
  $snapshot = Save-TidySourceSnapshot -Root $root -Version $current -Reason $mode
  $record.git = $snapshot
  if ($snapshot) { Write-Host ("  源码快照：{0}（tag build-{1}）" -f $snapshot, $current) -ForegroundColor DarkGray }

  # 测试门禁放在快照之后、构建之前：红了就中止，一个产物都不动。
  # 快照先做是有意的——红的那一版源码也值得留痕，方便事后回看。
  if (-not $SkipTests) {
    Invoke-TidyTestGate
  } else {
    Write-Host '已跳过测试门禁（-SkipTests）' -ForegroundColor Yellow
  }

  # 引擎什么时候要重建：
  #   -Engine            → 明确要求
  #   默认全量/打包       → 只要 src\engine\ 比引擎二进制新就必须重建，
  #                        否则打出来的包装着旧引擎，新功能在真机上 404。
  #                        （1.39.0、1.40.0 都踩过；以前靠人记得加 -Engine，记不住。）
  #   -AppOnly           → 明确只要外壳，不动引擎
  $engineStale = $false
  if ($Engine) {
    $engineStale = $true
  } elseif (-not $AppOnly -and ($Bundle -or $Portable)) {
    $engineStale = Test-EngineStale
    if ($engineStale) { Write-Host '  本次会先重建引擎，再打包（否则包里的引擎是旧的）' -ForegroundColor Yellow }
  }
  if ($Engine -or $engineStale) { Build-Engine }
  if ($appBuilt) { Build-App }
  if ($Portable) { Build-Portable }

  if ($Bundle)   { Remove-OldReleases 'QDisk_*_x64-setup.exe'; Remove-OldReleases 'TidyAssistant_*_x64-setup.exe' }
  if ($Portable) { Remove-OldReleases 'QDisk_*_x64-portable.zip'; Remove-OldReleases '*便携版.zip' }

  # 自动同步生成 release\latest.json 与 SHA256SUMS.txt，开箱即可直接发包上线
  $pubScript = Join-Path $root 'tools\publish-release.ps1'
  if (($Bundle -or $Portable) -and (Test-Path $pubScript)) {
    & $pubScript -Version $current -Channel $Channel -BaseUrl $ReleaseBaseUrl
  }

  # 产物自检：复用 publish-release.ps1 已落盘的 SHA256SUMS.txt，避免二次重算 47MB 产物哈希
  $knownSha = @{}
  $sumsFile = Join-Path $root 'release\SHA256SUMS.txt'
  if (Test-Path -LiteralPath $sumsFile) {
    foreach ($line in (Get-Content -LiteralPath $sumsFile -Encoding UTF8 -ErrorAction SilentlyContinue)) {
      if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') {
        $knownSha[$Matches[2].Trim()] = $Matches[1].ToLowerInvariant()
      }
    }
  }
  $exe = Join-Path $root 'tidy-assistant.exe'
  if (Test-Path $exe) {
    $record.exe = Get-TidyFileSha256 $exe
    $record.exeBytes = (Get-Item $exe).Length
  }
  $releases = @()
  if ($Bundle) {
    $pkg = Join-Path $root ("release\QDisk_{0}_x64-setup.exe" -f $current)
    if (-not (Test-Path $pkg)) { throw "安装包缺失：$pkg" }
    $leaf = Split-Path $pkg -Leaf
    $sha = if ($knownSha.ContainsKey($leaf)) { $knownSha[$leaf] } else { Get-TidyFileSha256 $pkg }
    $releases += @{ name = $leaf; sha256 = $sha }
  }
  if ($Portable) {
    $zip = Join-Path $root ("release\QDisk_{0}_x64-portable.zip" -f $current)
    if (-not (Test-Path $zip)) { throw "便携包缺失：$zip" }
    $leaf = Split-Path $zip -Leaf
    $sha = if ($knownSha.ContainsKey($leaf)) { $knownSha[$leaf] } else { Get-TidyFileSha256 $zip }
    $releases += @{ name = $leaf; sha256 = $sha }
  }
  $record.releases = $releases

  $issues = Test-TidyBuildHealth -Root $root -SkipExe:(-not $appBuilt)
  # 包里的引擎必须是最新源码打出来的：这条以前没有，于是 1.39.0 / 1.40.0
  # 都出过「安装包装好了、新方法却 404」的包。只在真打包时查。
  if (-not $AppOnly -and ($Bundle -or $Portable)) {
    if (Test-EngineStale) { $issues.Add('引擎比源码旧：这次打出来的包装的仍是旧引擎，新功能在真机上会 404') }
  }
  if ($issues.Count -gt 0) { throw ("产物自检不通过：" + ($issues -join '；')) }

  $record.result = 'ok'
} catch {
  $record.duration = Format-CompactDuration ((Get-Date) - $startedAt).TotalSeconds
  $record.note = $_.Exception.Message
  Write-TidyBuildRecord -Root $root -Record $record
  Write-Host ("构建失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
  throw
} finally {
  Exit-TidyBuildLock
}

$record.duration = Format-CompactDuration ((Get-Date) - $startedAt).TotalSeconds
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
