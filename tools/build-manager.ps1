# 整理助手 · 构建管理模块
# ------------------------------------------------------------------
# 这个文件被 build.ps1 点源引入，负责三件事：
#   1. 构建锁：同一时间只允许一个会话构建（锁文件 D:\Builds\.locks\tidyassistant.build.lock）
#   2. 源码快照：构建前用 git 提交当前工作树，构建产物永远能追回到确切源码
#   3. 构建台账：每次构建（成功/失败）追加一条 JSON 记录，含版本、exe 哈希、git 提交
#
# 单独使用：
#   .\tools\build-manager.ps1 -Status      # 看当前构建状态
#   .\tools\build-manager.ps1 -Check       # 只做一致性检查，非 0 退出即有问题
#
# 设计约束：
# - 不依赖 git 也能工作：没有 .git 时跳过快照，其余照常。
# - 不修改源码，不碰 引擎\ 与 release\（那是 build.ps1 的职责）。
# - 锁的持有者用 PID + 进程启动时间判定，PID 被复用不会误判为「还活着」。

$script:TidyLockDir     = 'D:\Builds\.locks'
$script:TidyLockPath    = Join-Path $script:TidyLockDir 'tidyassistant.build.lock'
$script:TidyJournalPath = 'D:\Builds\tidyassistant-builds.jsonl'
$script:TidyLock        = $null

function Get-TidyVersion {
  param([string]$Root)
  $conf = Join-Path $Root 'src\src-tauri\tauri.conf.json'
  if (-not (Test-Path $conf)) { throw "找不到版本配置：$conf" }
  return [string](Get-Content $conf -Raw -Encoding UTF8 | ConvertFrom-Json).version
}

function Get-TidyCargoVersion {
  param([string]$Root)
  $cargo = Join-Path $Root 'src\src-tauri\Cargo.toml'
  if (-not (Test-Path $cargo)) { return '' }
  $raw = [IO.File]::ReadAllText($cargo, [Text.Encoding]::UTF8)
  $m = [regex]::Match($raw, '(?m)^version\s*=\s*"([^"]+)"')
  if ($m.Success) { return $m.Groups[1].Value }
  return ''
}

function Get-TidySessionTag {
  if ($env:DSH_SESSION_ID -and $env:DSH_SESSION_ID.Length -ge 8) {
    return $env:DSH_SESSION_ID.Substring(0, 8)
  }
  return "pid-$PID"
}

function Get-TidyFileSha256 {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return '' }
  return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-TidyProcessAlive {
  param([int]$ProcessId, [long]$StartTicks)
  $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $p) { return $false }
  if ($StartTicks -gt 0) {
    try { return ($p.StartTime.Ticks -eq $StartTicks) } catch { return $false }
  }
  return $true
}

function Read-TidyLock {
  if (-not (Test-Path $script:TidyLockPath)) { return $null }
  try {
    return (Get-Content $script:TidyLockPath -Raw -Encoding UTF8 | ConvertFrom-Json)
  } catch {
    return $null
  }
}

# 找出不是本进程发起的、正在跑本项目的 cargo/rustc。
# 用来兜住还在用旧版 build.ps1（没有锁）的会话。
function Get-TidyForeignBuild {
  $procs = Get-CimInstance Win32_Process -Filter "Name='cargo.exe' OR Name='cargo-tauri.exe' OR Name='rustc.exe'" -ErrorAction SilentlyContinue
  $found = @()
  foreach ($p in $procs) {
    if ($p.ProcessId -eq $PID) { continue }
    if ($p.CommandLine -and $p.CommandLine -match 'tidyassistant|TidyAssistant') {
      $found += [pscustomobject]@{ ProcessId = $p.ProcessId; Name = $p.Name; CommandLine = $p.CommandLine }
    }
  }
  return $found
}

function Enter-TidyBuildLock {
  param([string]$Root, [string]$Mode)

  New-Item -ItemType Directory -Force -Path $script:TidyLockDir | Out-Null

  $foreign = Get-TidyForeignBuild
  if ($foreign.Count -gt 0) {
    $names = ($foreign | ForEach-Object { "$($_.Name)#$($_.ProcessId)" }) -join ', '
    throw "检测到别的会话正在编译本项目（$names）。等它结束再构建；若确认是残留进程，先确认没有构建在跑再手工结束。"
  }

  for ($attempt = 0; $attempt -lt 4; $attempt++) {
    if (Test-Path $script:TidyLockPath) {
      $info = Read-TidyLock
      $alive = $false
      if ($info) {
        $alive = Test-TidyProcessAlive -ProcessId ([int]$info.pid) -StartTicks ([long]$info.startTicks)
      }
      if ($alive) {
        throw ("构建锁被占用：pid={0} 会话={1} 版本={2} 开始于 {3}。等它构建结束；不要删锁文件绕过。" -f `
          $info.pid, $info.session, $info.version, $info.startedAt)
      }
      $stale = "$($script:TidyLockPath).stale-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
      try { Move-Item $script:TidyLockPath $stale -Force } catch { Start-Sleep -Milliseconds 200; continue }
    }

    $me = Get-Process -Id $PID -ErrorAction SilentlyContinue
    $startTicks = 0
    if ($me) { $startTicks = $me.StartTime.Ticks }
    $payload = [ordered]@{
      pid        = $PID
      startTicks = $startTicks
      session    = (Get-TidySessionTag)
      version    = (Get-TidyVersion -Root $Root)
      mode       = $Mode
      startedAt  = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
      host       = $env:COMPUTERNAME
      command    = $MyInvocation.Line
    } | ConvertTo-Json -Compress

    try {
      $fs = [IO.File]::Open($script:TidyLockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
        $fs.Write($bytes, 0, $bytes.Length)
      } finally { $fs.Close() }
      $script:TidyLock = $payload | ConvertFrom-Json
      return $script:TidyLock
    } catch [System.IO.IOException] {
      Start-Sleep -Milliseconds 200
    }
  }
  throw '拿不到构建锁（有并发进程反复抢占）。稍后重试。'
}

function Update-TidyBuildLock {
  param([string]$Version)
  if (-not $script:TidyLock) { return }
  $obj = [ordered]@{
    pid        = $script:TidyLock.pid
    startTicks = $script:TidyLock.startTicks
    session    = $script:TidyLock.session
    version    = $Version
    mode       = $script:TidyLock.mode
    startedAt  = $script:TidyLock.startedAt
    host       = $script:TidyLock.host
    command    = $script:TidyLock.command
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($script:TidyLockPath, $obj, (New-Object Text.UTF8Encoding($false)))
  $script:TidyLock = $obj | ConvertFrom-Json
}

function Exit-TidyBuildLock {
  if (-not $script:TidyLock) { return }
  $info = Read-TidyLock
  # 只删自己持有的锁；别把接手的会话的锁删掉
  if ($info -and [int]$info.pid -eq $PID -and [long]$info.startTicks -eq [long]$script:TidyLock.startTicks) {
    Remove-Item $script:TidyLockPath -Force -ErrorAction SilentlyContinue
  }
  $script:TidyLock = $null
}

function Write-TidyBuildRecord {
  param([string]$Root, [hashtable]$Record)
  $Record['ts']   = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  $Record['root'] = $Root
  $line = ($Record | ConvertTo-Json -Compress -Depth 8)

  foreach ($dir in @((Split-Path $script:TidyJournalPath), (Join-Path $Root '.build'))) {
    try {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      $path = Join-Path $dir 'builds.jsonl'
      [IO.File]::AppendAllText($path, $line + "`n", (New-Object Text.UTF8Encoding($false)))
    } catch { }
  }
}

function Get-TidyBuildHistory {
  param([int]$Last = 5)
  if (-not (Test-Path $script:TidyJournalPath)) { return @() }
  $lines = Get-Content $script:TidyJournalPath -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $_.Trim() }
  if (-not $lines) { return @() }
  $tail = $lines | Select-Object -Last $Last
  $out = @()
  foreach ($l in $tail) {
    try { $out += ($l | ConvertFrom-Json) } catch { }
  }
  return $out
}

function Save-TidySourceSnapshot {
  param([string]$Root, [string]$Version, [string]$Reason)
  if (-not (Test-Path (Join-Path $Root '.git'))) { return '' }
  Push-Location $Root
  try {
    git add -A 2>&1 | Out-Null
    $dirty = git status --porcelain
    if ($dirty) {
      $msg = "pre-build $Version ($Reason)"
      git commit -q -m $msg 2>&1 | Out-Null
      # 提交期间若还有人在写，再补一次，避免快照漏文件
      if (git status --porcelain) {
        git add -A 2>&1 | Out-Null
        git commit -q -m "$msg [cont]" 2>&1 | Out-Null
      }
    }
    return (git rev-parse --short HEAD).Trim()
  } catch {
    return ''
  } finally {
    Pop-Location
  }
}

function Get-TidyGitSummary {
  param([string]$Root)
  if (-not (Test-Path (Join-Path $Root '.git'))) { return '(未启用 git)' }
  Push-Location $Root
  try {
    $sha = (git rev-parse --short HEAD 2>$null)
    $dirty = @(git status --porcelain 2>$null).Count
    return "$sha（未提交变更 $dirty 个文件）"
  } finally { Pop-Location }
}

function Tag-TidyBuild {
  param([string]$Root, [string]$Version, [string]$Commit)
  if (-not $Commit) { return $true }
  if (-not (Test-Path (Join-Path $Root '.git'))) { return $true }
  Push-Location $Root
  try {
    $tag = "build-$Version"
    $existing = (git tag -l $tag 2>$null)
    if (-not $existing) {
      git tag $tag $Commit 2>&1 | Out-Null
      return $true
    }
    return $false   # 同版本重复打 tag：上层负责告警
  } finally { Pop-Location }
}

# 一致性检查：版本两处是否一致、exe 是否对得上、有没有正在跑的构建
# -SkipExe：只构建引擎/只打便携包时，根目录 exe 本来就不该变，跳过 exe 版本比对
function Test-TidyBuildHealth {
  param([string]$Root, [switch]$SkipExe)
  $issues = New-Object System.Collections.Generic.List[string]
  $confVer  = Get-TidyVersion -Root $Root
  $cargoVer = Get-TidyCargoVersion -Root $Root
  if ($cargoVer -ne $confVer) {
    $issues.Add("版本源不一致：tauri.conf.json=$confVer，Cargo.toml=$cargoVer")
  }

  $exe = Join-Path $Root 'tidy-assistant.exe'
  if (-not $SkipExe) {
    if (-not (Test-Path $exe)) {
      $issues.Add('缺少运行副本 tidy-assistant.exe')
    } else {
      $fv = (Get-Item $exe).VersionInfo.FileVersion
      if ($fv -ne $confVer) {
        $issues.Add("exe 内嵌版本 $fv ≠ 配置版本 $confVer（构建没跑完，或产物没覆盖）")
      }
    }
  }

  $lock = Read-TidyLock
  if ($lock -and (Test-TidyProcessAlive -ProcessId ([int]$lock.pid) -StartTicks ([long]$lock.startTicks))) {
    $issues.Add("有构建正在进行：pid=$($lock.pid) 会话=$($lock.session) 版本=$($lock.version)")
  }

  foreach ($p in (Get-TidyForeignBuild)) {
    $issues.Add("有构建进程在跑：$($p.Name)#$($p.ProcessId)")
  }

  return $issues
}

function Show-TidyBuildStatus {
  param([string]$Root)
  $ver = Get-TidyVersion -Root $Root
  $cargoVer = Get-TidyCargoVersion -Root $Root
  $exe = Join-Path $Root 'tidy-assistant.exe'

  Write-Host ''
  Write-Host '整理助手 · 构建状态' -ForegroundColor Cyan
  Write-Host ("  版本（配置） : {0}" -f $ver)
  Write-Host ("  版本（Cargo）: {0}" -f $cargoVer)
  Write-Host ("  源码         : {0}" -f (Get-TidyGitSummary -Root $Root))

  if (Test-Path $exe) {
    $i = Get-Item $exe
    $fv = $i.VersionInfo.FileVersion
    $color = if ($fv -eq $ver) { 'Green' } else { 'Yellow' }
    Write-Host ("  运行副本     : {0}，内嵌 {1}，{2:N0} B，{3:yyyy-MM-dd HH:mm}" -f $i.Name, $fv, $i.Length, $i.LastWriteTime) -ForegroundColor $color
  } else {
    Write-Host '  运行副本     : 缺失' -ForegroundColor Red
  }

  $lock = Read-TidyLock
  if ($lock) {
    $alive = Test-TidyProcessAlive -ProcessId ([int]$lock.pid) -StartTicks ([long]$lock.startTicks)
    if ($alive) {
      Write-Host ("  构建锁       : 占用中 pid={0} 会话={1} 版本={2} 起于 {3}" -f $lock.pid, $lock.session, $lock.version, $lock.startedAt) -ForegroundColor Yellow
    } else {
      Write-Host ("  构建锁       : 残留（pid={0} 已退出），下次构建会自动清理" -f $lock.pid) -ForegroundColor DarkGray
    }
  } else {
    Write-Host '  构建锁       : 空闲' -ForegroundColor Green
  }

  $foreign = Get-TidyForeignBuild
  if ($foreign.Count -gt 0) {
    Write-Host ("  编译进程     : {0}" -f (($foreign | ForEach-Object { "$($_.Name)#$($_.ProcessId)" }) -join ', ')) -ForegroundColor Yellow
  }

  $rel = Join-Path $Root 'release'
  if (Test-Path $rel) {
    $files = Get-ChildItem $rel -File | Sort-Object LastWriteTime -Descending
    Write-Host ("  release      : {0} 个文件" -f $files.Count) -ForegroundColor DarkGray
    foreach ($f in ($files | Select-Object -First 4)) {
      Write-Host ("                 {0}  {1:N1} MB  {2:yyyy-MM-dd HH:mm}" -f $f.Name, ($f.Length / 1MB), $f.LastWriteTime) -ForegroundColor DarkGray
    }
  }

  $hist = Get-TidyBuildHistory -Last 5
  if ($hist.Count -gt 0) {
    Write-Host '  最近构建     :' -ForegroundColor DarkGray
    foreach ($h in $hist) {
      $tag = if ($h.result -eq 'ok') { 'OK ' } else { 'ERR' }
      Write-Host ("                 [{0}] {1} {2} {3} {4}" -f $tag, $h.version, $h.kind, $h.duration, $h.git) -ForegroundColor DarkGray
    }
  }

  $issues = Test-TidyBuildHealth -Root $Root
  if ($issues.Count -eq 0) {
    Write-Host '  一致性       : 通过' -ForegroundColor Green
  } else {
    Write-Host '  一致性       : 有问题' -ForegroundColor Red
    foreach ($i in $issues) { Write-Host ("                 - {0}" -f $i) -ForegroundColor Red }
  }
  Write-Host ''
}

# 被 build.ps1 点源时不自动执行；直接运行本文件时给个状态/检查入口
if ($MyInvocation.InvocationName -ne '.') {
  $root = Split-Path $PSScriptRoot -Parent
  if ($args -contains '-Check') {
    $issues = Test-TidyBuildHealth -Root $root
    if ($issues.Count -eq 0) { Write-Host '一致性检查通过' -ForegroundColor Green; exit 0 }
    $issues | ForEach-Object { Write-Host "问题：$_" -ForegroundColor Red }
    exit 1
  }
  Show-TidyBuildStatus -Root $root
}
