<#
.SYNOPSIS
  在一个项目里初始化 .workflow/ 骨架。

.DESCRIPTION
  增量、不覆盖：已存在的文件一律跳过并提示。
  会自动探测项目类型，给 gates.json 挑一个合适的预设。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\init-workflow.ps1 -Root D:\code\my-project
#>
[CmdletBinding()]
param(
    [string]$Root = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$templates = Join-Path (Split-Path -Parent $here) 'templates'

if (-not (Test-Path $templates)) {
    Write-Host "找不到 templates 目录: $templates" -ForegroundColor Red
    exit 2
}

Write-Host ""
Write-Host "=== agentflow init -> $Root ===" -ForegroundColor Cyan

$wf = Join-Path $Root '.workflow'
foreach ($d in @($wf, (Join-Path $wf 'lessons'), (Join-Path $wf 'features'))) {
    if (-not (Test-Path $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
        Write-Host "  created  $($d.Replace($Root,'.'))" -ForegroundColor Green
    } else {
        Write-Host "  exists   $($d.Replace($Root,'.'))" -ForegroundColor DarkGray
    }
}

# ---- gates.json：按项目类型挑预设 ----
$gatesDst = Join-Path $wf 'gates.json'
if (Test-Path $gatesDst) {
    Write-Host "  exists   .\.workflow\gates.json（跳过，不覆盖）" -ForegroundColor DarkGray
} else {
    $tpl = Get-Content (Join-Path $templates 'gates.json') -Raw -Encoding UTF8 | ConvertFrom-Json

    $preset = $null
    $kind   = 'node'
    if     (Test-Path (Join-Path $Root 'Cargo.toml'))      { $preset = $tpl._presets.rust;   $kind = 'rust' }
    elseif (Test-Path (Join-Path $Root 'go.mod'))          { $preset = $tpl._presets.go;     $kind = 'go' }
    elseif (Test-Path (Join-Path $Root 'pyproject.toml'))  { $preset = $tpl._presets.python; $kind = 'python' }
    elseif (Test-Path (Join-Path $Root 'requirements.txt')){ $preset = $tpl._presets.python; $kind = 'python' }

    if ($null -ne $preset) { $l1 = $preset } else { $l1 = $tpl.l1 }

    $out = [pscustomobject]@{
        l1     = $l1
        _note  = "由 init-workflow 按项目类型 [$kind] 生成。按你的项目改。required=false 只警告不阻塞。顺序即执行顺序，越便宜的放越前面。"
    }
    $out | ConvertTo-Json -Depth 6 | Out-File -FilePath $gatesDst -Encoding utf8
    Write-Host "  created  .\.workflow\gates.json  [预设: $kind]" -ForegroundColor Green
}

# ---- attention.md ----
$attDst = Join-Path $wf 'attention.md'
if (Test-Path $attDst) {
    Write-Host "  exists   .\.workflow\attention.md（跳过）" -ForegroundColor DarkGray
} else {
    Copy-Item (Join-Path $templates 'attention.md') $attDst
    Write-Host "  created  .\.workflow\attention.md" -ForegroundColor Green
}

# ---- 【#5】gate 命令冒烟：确认它们至少「能被执行」 ----
# 实跑教训：gates.json 里写了 `node --test tests/`，在 Node 24 下会把目录当模块加载而失败。
# 8 个 Builder 全都没碰到，因为他们跑的是具体文件路径。这条命令从写下来到 L1 第一次跑，
# 中间没有任何环节验证过它可执行。
$gatesCfg = Get-Content $gatesDst -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host ""
Write-Host "  --- gate 命令冒烟（只验能否执行，失败不阻塞）---" -ForegroundColor Cyan
foreach ($g in @($gatesCfg.l1)) {
    Push-Location $Root
    try {
        $null = & cmd /c "$($g.cmd) 2>&1"
        $code = $LASTEXITCODE
    } catch {
        $code = -1
    } finally {
        Pop-Location
    }
    # 127 / 9009 = 命令不存在；-1 = 抛异常。这几种是「跑不起来」，其余退出码只是「没通过」，正常。
    if ($code -eq 127 -or $code -eq 9009 -or $code -eq -1) {
        Write-Host "    ⚠ $($g.name): 命令跑不起来 (exit $code) — $($g.cmd)" -ForegroundColor Yellow
        Write-Host "      L1 会一直挂在这里。装好依赖或改掉这条命令。" -ForegroundColor Yellow
    } else {
        Write-Host "    ✓ $($g.name): 可执行 (exit $code)" -ForegroundColor DarkGray
    }
}

# ---- .gitignore 建议 ----
$giPath = Join-Path $Root '.gitignore'
$want   = @('.workflow/features/*/run.json', '.workflow/features/*/reports/', '.workflow/features/*/review-target.json')
if (Test-Path $giPath) {
    $gi = Get-Content $giPath -Raw -Encoding UTF8
    $missing = @($want | Where-Object { $gi -notmatch [regex]::Escape($_) })
    if ($missing.Count -gt 0) {
        Write-Host ""
        Write-Host "  建议往 .gitignore 追加（运行时产物，不该进版本库）：" -ForegroundColor Yellow
        foreach ($m in $missing) { Write-Host "    $m" -ForegroundColor Yellow }
    }
} else {
    Write-Host ""
    Write-Host "  没有 .gitignore。建议创建并加入：" -ForegroundColor Yellow
    foreach ($m in $want) { Write-Host "    $m" -ForegroundColor Yellow }
}

Write-Host ""
Write-Host "  spec / acceptance / design / tasks / lessons 都应该进 git —— 它们是项目资产。" -ForegroundColor DarkGray
Write-Host ""
Write-Host "=== 完成。在 Claude Code 里调用 /wf 开始 ===" -ForegroundColor Green
Write-Host ""
