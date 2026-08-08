<#
.SYNOPSIS
  L1 机械门 —— 零 LLM 成本的第一道闸。

.DESCRIPTION
  按 .rd/gates.json 里的顺序逐条执行命令，任一 required 项失败即整体失败。
  命令越便宜的放越前面，早失败早退出，省下后面所有审查 token。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\gate-l1.ps1
  powershell -ExecutionPolicy Bypass -File scripts\gate-l1.ps1 -Feature user-login -Round 2
#>
[CmdletBinding()]
param(
    [string]$Root = (Get-Location).Path,
    [string]$Feature,
    [int]$Round = 1,
    [switch]$ContinueOnFailure
)

$ErrorActionPreference = 'Stop'
$configPath = Join-Path $Root '.rd\gates.json'

if (-not (Test-Path $configPath)) {
    Write-Host "[L1] 找不到 $configPath" -ForegroundColor Red
    Write-Host "     先跑 init-rd.ps1，或从 templates/gates.json 复制一份。" -ForegroundColor Yellow
    exit 2
}

$config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$gates  = @($config.l1)

if ($gates.Count -eq 0) {
    Write-Host "[L1] gates.json 的 l1 为空，没有可执行的机械门。" -ForegroundColor Red
    exit 2
}

# ---- 前置：上次是不是被中断在半路 ----
# 寄生在这里的理由同 validate-plan：L1 是每轮第一道闸，绕不过去。
# 不新增「必须调用」的规则 —— 那条路已被证伪三次（KNOWN-ISSUES 的 A15）。
# 只硬拦 inflight（退出码 2），产物缺失只警告：
# build 阶段 L2/L3 本来就还没有，一律阻塞会天天误报，然后人开始习惯性跳过。
$checkArt = Join-Path $PSScriptRoot 'check-artifacts.ps1'
if (Test-Path $checkArt) {
    $caArgs = @('-ExecutionPolicy', 'Bypass', '-File', $checkArt, '-Root', $Root)
    if ($Feature) { $caArgs += @('-Feature', $Feature) }
    $caOut  = & powershell @caArgs 2>$null | Out-String
    $caCode = $LASTEXITCODE
    if ($caCode -eq 2) {
        Write-Host $caOut
        Write-Host "[L1] 中止：上次运行被中断在半路。" -ForegroundColor Red
        Write-Host "     先按上面的 inflight 收尾，把 run.json 的 inflight 清成 null，再跑 L1。" -ForegroundColor Red
        Write-Host "     在没收尾的状态下跑门，绿了也不知道绿的是哪一版。" -ForegroundColor DarkGray
        exit 2
    }
    if ($caCode -eq 3) {
        Write-Host "[L1] ⚠ 存在孤儿证据（evidence/ 下有文件没被任何报告引用）。" -ForegroundColor Yellow
        Write-Host "     跑 check-artifacts.ps1 看清单 —— 要么在报告里认领，要么删掉。" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "=== L1 机械门 ($($gates.Count) 项) ===" -ForegroundColor Cyan

$results  = @()
$failed   = $false
$tailLines = 40

foreach ($g in $gates) {
    $required = $true
    if ($null -ne $g.required) { $required = [bool]$g.required }

    Write-Host ""
    Write-Host "  -> $($g.name): $($g.cmd)" -ForegroundColor Gray

    $sw = [Diagnostics.Stopwatch]::StartNew()
    Push-Location $Root
    try {
        $raw  = & cmd /c "$($g.cmd) 2>&1"
        $code = $LASTEXITCODE
    } catch {
        $raw  = $_.Exception.Message
        $code = 1
    } finally {
        Pop-Location
    }
    $sw.Stop()

    $text = ($raw | Out-String)
    $lines = $text -split "`r?`n"
    if ($lines.Count -gt $tailLines) {
        $tail = ($lines | Select-Object -Last $tailLines) -join "`n"
    } else {
        $tail = $text
    }

    $ok = ($code -eq 0)

    # 【#16】防「空过」：退出码 0 不等于「真的检查了东西」。
    # 实测：空项目上 `npx tsc --noEmit` 和 `node --test` 都返回 0 —— 没文件可查，
    # 没测试可跑，于是 L1 全绿。gate 条目可用 mustMatch 声明「输出里必须出现什么」，
    # 出现不了就判失败，哪怕退出码是 0。
    if ($ok -and -not [string]::IsNullOrWhiteSpace($g.mustMatch)) {
        if ($text.IndexOf([string]$g.mustMatch, [StringComparison]::Ordinal) -lt 0) {
            $ok = $false
            $code = -100
            $tail = "[gate-l1] 命令退出码为 0，但输出里找不到 `"$($g.mustMatch)`" —— 判定为空过。`n" +
                    "          很可能是没有文件可检查、或没有测试被收集到。`n`n" + $tail
        }
    }

    $results += [pscustomobject]@{
        name     = $g.name
        cmd      = $g.cmd
        required = $required
        exitCode = $code
        ok       = $ok
        seconds  = [math]::Round($sw.Elapsed.TotalSeconds, 1)
        tail     = $tail.TrimEnd()
    }

    if ($ok) {
        Write-Host "     PASS  ($([math]::Round($sw.Elapsed.TotalSeconds,1))s)" -ForegroundColor Green
    } elseif ($required) {
        Write-Host "     FAIL  exit=$code  ($([math]::Round($sw.Elapsed.TotalSeconds,1))s)" -ForegroundColor Red
        $failed = $true
        if (-not $ContinueOnFailure) {
            Write-Host "     后续项跳过（early exit）。加 -ContinueOnFailure 可跑完全部。" -ForegroundColor DarkGray
            break
        }
    } else {
        Write-Host "     WARN  exit=$code（非阻塞项）" -ForegroundColor Yellow
    }
}

$verdict = 'pass'
if ($failed) { $verdict = 'fail' }

$report = [pscustomobject]@{
    stage   = 'l1'
    feature = $Feature
    round   = $Round
    verdict = $verdict
    ts      = (Get-Date).ToString('o')
    gates   = $results
}

if ($Feature) {
    $dir = Join-Path $Root ".rd\features\$Feature\reports"
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $out = Join-Path $dir "l1-round$Round.json"
    $report | ConvertTo-Json -Depth 6 | Out-File -FilePath $out -Encoding utf8
    Write-Host ""
    Write-Host "  报告: $out" -ForegroundColor DarkGray
}

Write-Host ""
if ($verdict -eq 'pass') {
    Write-Host "=== L1 PASS —— 可以进入 L2 异构审查 ===" -ForegroundColor Green
} else {
    Write-Host "=== L1 FAIL —— 不要派 reviewer，先把机械问题修掉 ===" -ForegroundColor Red
    Write-Host ""
    foreach ($r in ($results | Where-Object { -not $_.ok -and $_.required })) {
        Write-Host "--- $($r.name) (exit $($r.exitCode)) ---" -ForegroundColor Red
        Write-Host $r.tail
        Write-Host ""
    }
}
Write-Host ""

if ($verdict -eq 'pass') { exit 0 } else { exit 1 }
