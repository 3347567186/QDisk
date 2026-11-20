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
  $skip = @('数据', 'cache', '__pycache__', '.pytest_cache')
  $newer = Get-ChildItem $engineSrc -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Extension -in @('.py', '.spec', '.json', '.yaml', '.yml', '.txt', '.md') -and
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

# ---------------------------------------------------------------- 测试门禁

# 为什么构建前必须跑测试：
# 这个项目在 1.35–1.41 之间积累了 40 多个版本「测试红了没人跑」的历史——
# scope.selftest 的一条断言盯死了 state.running，1.41.6 改成多会话之后
# 代码是对的、测试是红的，一直红到被发现。同一时期 test_migrate_engine
# 11 条红，对应的是 flatten 迁移把文件放错目录的真实 bug。
# 没有门禁的时候，「改完不跑测试」和「跑完不看结果」都不留痕迹；
# 加了门禁之后，坏掉的代码进不了 release\。
function Invoke-TidyTestGate {
  Write-Host '跑测试门禁…' -ForegroundColor Cyan
  $py = 'D:\Builds\engine-venv\Scripts\python.exe'
  if (-not (Test-Path $py)) {
    Write-Host '  警告：没找到 engine-venv，用裸 py 跑引擎测试' -ForegroundColor Yellow
    $py = 'py'
  }
  $failed = @()

  $modules = @('test_engine_rpc', 'test_migrate_engine', 'test_settings_dir', 'test_app_guard')
  Push-Location $engineSrc
  try {
    foreach ($m in $modules) {
      $out = & $py -m unittest $m 2>&1
      $code = $LASTEXITCODE
      $tail = ($out | Select-String -Pattern '^(Ran |OK|FAILED)' | ForEach-Object { $_.Line }) -join ' '
      if ($code -ne 0) {
        $failed += "引擎测试 $m 未通过（$tail）"
        Write-Host ("  [红] {0}：{1}" -f $m, $tail) -ForegroundColor Red
      } else {
        Write-Host ("  [绿] {0}：{1}" -f $m, $tail) -ForegroundColor DarkGray
      }
    }
  } finally { Pop-Location }

  # 前端自测：6 个 *.selftest.mjs 各自 process.exit(非0) 表示失败
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    Write-Host '  警告：没找到 node，跳过前端自测' -ForegroundColor Yellow
  } else {
    $aiDir = Join-Path $root 'src\web\js\ai'
    foreach ($f in (Get-ChildItem $aiDir -Filter '*.selftest.mjs' -File | Sort-Object Name)) {
      $out = & $node $f.FullName 2>&1
      $code = $LASTEXITCODE
      $last = ($out | Where-Object { $_ -match '结果：' } | Select-Object -Last 1)
      if (-not $last) { $last = ($out | Where-Object { $_ -match '\S' -and $_ -notmatch '^[─━-]+$' } | Select-Object -Last 1) }
      if ($code -ne 0) {
        $failed += "前端自测 $($f.Name) 未通过（$last）"
        Write-Host ("  [红] {0}：{1}" -f $f.Name, $last) -ForegroundColor Red
      } else {
        Write-Host ("  [绿] {0}：{1}" -f $f.Name, $last) -ForegroundColor DarkGray
      }
    }
  }

  # Rust 侧单元测试：只在 Rust 源码比上次成功跑过时更新时才跑。
  # 为什么加条件：cargo test 首轮要编译 3 分多钟，每次都跑会把「改一行前端」
  # 的迭代成本抬高。但只要 src-tauri 下有任何 .rs / Cargo.toml 变过，就必须跑——
  # 1.42.x 这一轮我在 archive 模块做去重（三处手写 from_utf16 收成一处），
  # 这类改动编译期零警告、运行期只在遇到特定压缩包时才露头，没有测试就是裸奔。
  $rustDir = Join-Path $root 'src\src-tauri'
  $stampPath = 'D:\Builds\.rust-test-stamp'
  $newest = Get-ChildItem $rustDir -Recurse -File -Include *.rs, Cargo.toml -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\target\\' } |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  $stamp = if (Test-Path $stampPath) { (Get-Item $stampPath).LastWriteTimeUtc } else { [datetime]::MinValue }
  if ($newest -and $newest.LastWriteTimeUtc -gt $stamp) {
    $cargo = (Get-Command cargo -ErrorAction SilentlyContinue).Source
    if (-not $cargo) {
      Write-Host '  警告：没找到 cargo，跳过 Rust 测试' -ForegroundColor Yellow
    } else {
      # 与 Build-IndexWalk 用同一套工具链变量：gnu-d 工具链、ASCII 的 CARGO_HOME、
      # 独立 target 目录（不和构建共用，避免互相把对方的产物判成过期）。
      $env:RUSTUP_TOOLCHAIN = 'gnu-d'
      $env:CARGO_HOME = 'D:\Tool\cargo-ASCII'
      $env:CARGO_TARGET_DIR = 'D:\Builds\tidyassistant-test-target'
      $env:PATH = "D:\Tool\binutils\mingw64\bin;$env:PATH"
      $out = & $cargo test --release --manifest-path (Join-Path $rustDir 'Cargo.toml') 2>&1
      $code = $LASTEXITCODE
      $tail = ($out | Select-String -Pattern '^test result' | ForEach-Object { $_.Line }) -join ' '
      $warns = ($out | Select-String -Pattern '^warning: ' | Where-Object { $_.Line -notmatch 'generated \d+ warning' } | Measure-Object).Count
      if ($code -ne 0) {
        $failed += "Rust 测试未通过（$tail）"
        Write-Host ("  [红] cargo test：{0}" -f $tail) -ForegroundColor Red
      } else {
        Write-Host ("  [绿] cargo test：{0}" -f $tail) -ForegroundColor DarkGray
      }
      # 警告不再「忍着」：0 是这个项目的基线。允许的唯一例外是被 #[allow(dead_code)]
      # 显式标注意图的函数（它们不算 warning）。
      if ($warns -gt 0) {
        $failed += "Rust 编译有 $warns 条警告（基线是 0）"
        Write-Host ("  [红] cargo 警告：{0} 条" -f $warns) -ForegroundColor Red
      }

      # 还要单独看一次「不带 cfg(test)」的编译：cargo test 是在 cfg(test) 下编译的，
      # 只在测试里用到的函数在那次编译里是「有调用者」的，一条警告都不会有；
      # 而真正发出去的 exe 不带 cfg(test)，同样的函数就是死代码。
      # 1.42.7 就是这么漏过去的：Budget::used() 只有测试在用，cargo test 全绿，
      # 构建时刷出一条 warning: method `used` is never used。
      # 判据和上面一致：0 条，除非显式 #[allow(dead_code)]。
      $bout = & $cargo build --release --manifest-path (Join-Path $rustDir 'Cargo.toml') 2>&1
      $bcode = $LASTEXITCODE
      $bwarns = ($bout | Select-String -Pattern '^warning: ' | Where-Object { $_.Line -notmatch 'generated \d+ warning' } | Measure-Object).Count
      if ($bcode -ne 0) {
        $failed += "Rust 发布构建失败（cargo build --release 退出码 $bcode）"
        Write-Host ("  [红] cargo build --release：退出码 {0}" -f $bcode) -ForegroundColor Red
      } elseif ($bwarns -gt 0) {
        $failed += "Rust 发布构建有 $bwarns 条警告（基线是 0；注意这与 cargo test 的警告不是一回事）"
        Write-Host ("  [红] cargo build 警告：{0} 条" -f $bwarns) -ForegroundColor Red
        ($bout | Select-String -Pattern '^warning: ' | Where-Object { $_.Line -notmatch 'generated \d+ warning' } |
            Select-Object -First 5 | ForEach-Object { Write-Host ("        " + $_.Line.Trim()) -ForegroundColor DarkYellow })
      } else {
        Write-Host '  [绿] cargo build --release：0 条警告' -ForegroundColor DarkGray
      }

      if ($code -eq 0) { Set-Content -Path $stampPath -Value (Get-Date -Format o) -Encoding UTF8 }
    }
  } else {
    Write-Host '  [跳过] cargo test：Rust 源码自上次通过后没变过' -ForegroundColor DarkGray
  }

  if ($failed.Count -gt 0) {
    throw ("测试门禁不通过（{0} 项）：`n  {1}" -f $failed.Count, ($failed -join "`n  "))
  }
  Write-Host '测试门禁通过' -ForegroundColor Green
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

# 只跑测试门禁：不取构建锁、不改版本号、不产生产物。
# 改完一处想快速知道有没有碰坏东西时用这个，比全量构建快得多。
if ($TestsOnly) { Invoke-TidyTestGate; return }

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
  # 包里的引擎必须是最新源码打出来的：这条以前没有，于是 1.39.0 / 1.40.0
  # 都出过「安装包装好了、新方法却 404」的包。只在真打包时查。
  if (-not $AppOnly -and ($Bundle -or $Portable)) {
    if (Test-EngineStale) { $issues.Add('引擎比源码旧：这次打出来的包装的仍是旧引擎，新功能在真机上会 404') }
  }
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
