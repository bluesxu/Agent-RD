<#
.SYNOPSIS
  在一个项目里初始化 .rd/ 骨架。

.DESCRIPTION
  增量、不覆盖：已存在的文件一律跳过并提示。
  会自动探测项目类型，给 gates.json 挑一个合适的预设。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\init-rd.ps1 -Root D:\code\my-project
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
Write-Host "=== AgentRD init -> $Root ===" -ForegroundColor Cyan

$rd = Join-Path $Root '.rd'
foreach ($d in @($rd, (Join-Path $rd 'lessons'), (Join-Path $rd 'features'))) {
    if (-not (Test-Path $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
        Write-Host "  created  $($d.Replace($Root,'.'))" -ForegroundColor Green
    } else {
        Write-Host "  exists   $($d.Replace($Root,'.'))" -ForegroundColor DarkGray
    }
}

# ---- 项目类型探测（gates 预设和 .gitignore 预设都要用，所以提到最前面）----
# 早期版本把它埋在 gates.json 的 else 分支里，于是 gates.json 已存在时 $kind 是空的，
# 后面用到它的地方会静默拿到默认值。
$kind = 'node'
if     (Test-Path (Join-Path $Root 'Cargo.toml'))      { $kind = 'rust' }
elseif (Test-Path (Join-Path $Root 'go.mod'))          { $kind = 'go' }
elseif (Test-Path (Join-Path $Root 'pyproject.toml'))  { $kind = 'python' }
elseif (Test-Path (Join-Path $Root 'requirements.txt')){ $kind = 'python' }

# ---- gates.json：按项目类型挑预设 ----
$gatesDst = Join-Path $rd 'gates.json'
if (Test-Path $gatesDst) {
    Write-Host "  exists   .\.rd\gates.json（跳过，不覆盖）[检测到: $kind]" -ForegroundColor DarkGray
} else {
    $tpl = Get-Content (Join-Path $templates 'gates.json') -Raw -Encoding UTF8 | ConvertFrom-Json

    $preset = $null
    if     ($kind -eq 'rust')   { $preset = $tpl._presets.rust }
    elseif ($kind -eq 'go')     { $preset = $tpl._presets.go }
    elseif ($kind -eq 'python') { $preset = $tpl._presets.python }

    if ($null -ne $preset) { $l1 = $preset } else { $l1 = $tpl.l1 }

    # 【A9】没有任何语言标记文件时，这里是在**猜**（而且默认猜成 node）。
    # 而 init-rd 往往在阶段 0 之前就跑了 —— 那时技术选型还没论证。
    # 猜出来的 gates 会和 acceptance.json 的 check 一起，把技术栈钉死在阶段 1 之前。
    # 标记出来，让阶段 1 必须回来解决它。
    $markers = @('Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'package.json')
    $hasMarker = $false
    foreach ($mk in $markers) { if (Test-Path (Join-Path $Root $mk)) { $hasMarker = $true; break } }

    $out = [pscustomobject]@{
        l1     = $l1
        _note  = "由 init-rd 按项目类型 [$kind] 生成。按你的项目改。required=false 只警告不阻塞。顺序即执行顺序，越便宜的放越前面。"
    }
    if (-not $hasMarker) {
        $out | Add-Member -MemberType NoteProperty -Name '_provisional' -Value $true
        $out | Add-Member -MemberType NoteProperty -Name '_provisionalNote' -Value "⚠️ 目录里没有任何语言标记文件（Cargo.toml / go.mod / pyproject.toml / requirements.txt / package.json），上面这套门是**猜的**（默认按 node）。技术选型是阶段 1 的事 —— rd-plan 仲裁完之后必须回来改掉这份配置并删除本标记。在此之前，L1 机械门验的是一个还没被决定的技术栈。"
    }
    $out | ConvertTo-Json -Depth 6 | Out-File -FilePath $gatesDst -Encoding utf8
    Write-Host "  created  .\.rd\gates.json  [预设: $kind]" -ForegroundColor Green
}

# ---- attention.md ----
$attDst = Join-Path $rd 'attention.md'
if (Test-Path $attDst) {
    Write-Host "  exists   .\.rd\attention.md（跳过）" -ForegroundColor DarkGray
} else {
    Copy-Item (Join-Path $templates 'attention.md') $attDst
    Write-Host "  created  .\.rd\attention.md" -ForegroundColor Green
}

# ---- 随项目下发守卫脚本，让项目自包含 ----
# 为什么必须这样：AgentRD 装在项目外面，acceptance.json 里的 check 只能用相对路径引它。
# 而那个相对路径的基准（feature 目录）和测试命令需要的基准（项目根）**不是同一个** ——
# 结果是从任何目录跑都不通：在 feature 目录下脚本找得到但测试找不到，在项目根下脚本找不到。
# 实测教训：两个项目里所有 machine 判定的 check，从写下来到被发现，一次都没成功执行过。
$binDir = Join-Path $rd 'bin'
if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Path $binDir -Force | Out-Null }
$guardSrc = Join-Path $here 'check-ac.ps1'
$guardDst = Join-Path $binDir 'check-ac.ps1'
if (Test-Path $guardSrc) {
    Copy-Item $guardSrc $guardDst -Force
    Write-Host "  vendored .\.rd\bin\check-ac.ps1" -ForegroundColor Green
    Write-Host "           acceptance.json 的 check 一律从**项目根**执行，且**不许有嵌套转义引号**：" -ForegroundColor DarkGray
    Write-Host "             对  -Cmd `"node --test --test-name-pattern=<feature>\sAC-1`" -MustMatch `"<feature> AC-1`"" -ForegroundColor DarkGray
    Write-Host "             错  -Cmd `"node --test --test-name-pattern \`"<feature> AC-1\`"`" ..." -ForegroundColor DarkGray
    Write-Host "           错的那种在 bash 下能过、在 PowerShell 下反斜杠被吃掉导致引号错配，" -ForegroundColor DarkGray
    Write-Host "           连 -MustMatch 都会被吞进 -Cmd，得到一个**假 FAIL**。用 --flag=value + 正则 \s 绕开。" -ForegroundColor DarkGray
} else {
    Write-Host "  ⚠ 找不到 $guardSrc，未能下发守卫脚本" -ForegroundColor Yellow
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

# ---- 【B7】.gitignore：直接创建，不再只是「建议」 ----
#
# 实跑教训：新项目没有 .gitignore，`git add -A` 把 node_modules 全部 staged，
# freeze-target 冻结出 682 个文件的「审查目标」。只在这里打印一行建议是不够的 ——
# 建议不会被执行（见 KNOWN-ISSUES 的 A15：规则写了没人做）。
#
# ⚠️ 忽略清单里**故意不含** .rd 下的任何东西。
# 早期版本建议忽略 run.json / reports/ / review-target.json，理由是「运行时产物」。
# 那个判断是错的：它们是**证据链** —— run.json 是进度真相源，
# reports/ 是「三层门到底抓到了什么」的唯一凭据，review-target.json 是冻结签名。
# 审计对这套框架最重的一条指控就是「L2/L3 报告一份都不存在」，
# 把它们忽略掉等于把那条指控制度化。
$giPath = Join-Path $Root '.gitignore'

$common = @('# --- AgentRD init ---', '.DS_Store', 'Thumbs.db', '*.log')
switch ($kind) {
    'python' { $langIgnore = @('__pycache__/', '*.py[cod]', '.venv/', 'venv/', '.pytest_cache/', '.mypy_cache/', 'dist/', 'build/', '*.egg-info/') }
    'go'     { $langIgnore = @('bin/', '*.exe', '*.test', 'coverage.out') }
    'rust'   { $langIgnore = @('target/', 'Cargo.lock.orig') }
    default  { $langIgnore = @('node_modules/', 'dist/', 'build/', 'coverage/', '.env', '.env.local') }
}
$want = $common + $langIgnore

if (Test-Path $giPath) {
    $gi = Get-Content $giPath -Raw -Encoding UTF8
    $missing = @($want | Where-Object { $_ -notmatch '^#' -and $gi -notmatch [regex]::Escape($_) })
    if ($missing.Count -gt 0) {
        Add-Content -Path $giPath -Value ("`n# --- AgentRD init [$kind] ---") -Encoding UTF8
        foreach ($m in $missing) { Add-Content -Path $giPath -Value $m -Encoding UTF8 }
        Write-Host ""
        Write-Host "  appended .gitignore  追加 $($missing.Count) 条 [$kind]" -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "  exists   .gitignore（已覆盖依赖/构建产物，未改动）" -ForegroundColor DarkGray
    }
} else {
    $want | Out-File -FilePath $giPath -Encoding UTF8
    Write-Host ""
    Write-Host "  created  .gitignore  [$kind 预设，$($want.Count) 条]" -ForegroundColor Green
    Write-Host "           没有它，git add -A 会把依赖目录 staged，" -ForegroundColor DarkGray
    Write-Host "           freeze-target 就会冻出一个几百个文件的审查目标。" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  ⛔ 忽略清单里故意不含 .rd 下的任何东西：" -ForegroundColor DarkGray
Write-Host "     run.json / reports/ / review-target.json / lessons/ 全都要进 git —— 它们是证据链，" -ForegroundColor DarkGray
Write-Host "     不是运行时垃圾。spec / acceptance / design / tasks 同理。" -ForegroundColor DarkGray
Write-Host ""
Write-Host "=== 完成。在 Claude Code 里调用 /rd 开始 ===" -ForegroundColor Green
Write-Host ""
