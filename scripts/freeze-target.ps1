<#
.SYNOPSIS
  冻结 L2 审查目标，并在 reviewer 返回后校验目标没被动过。

.DESCRIPTION
  审查最常见的失效方式不是审得不好，而是"审的东西已经不是最终的东西"——
  reviewer 还在看的时候主流程又改了几个文件，findings 全部对不上号。
  这个脚本把 diff 内容做 SHA-256 存档，reviewer 返回后 -Verify 一次即可发现漂移。

.EXAMPLE
  # 冻结
  git add -A
  powershell -ExecutionPolicy Bypass -File scripts\freeze-target.ps1 -Feature user-login -Round 1

  # reviewer 返回后校验
  powershell -ExecutionPolicy Bypass -File scripts\freeze-target.ps1 -Feature user-login -Round 1 -Verify
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Feature,
    [string]$Root = (Get-Location).Path,
    [int]$Round = 1,
    [switch]$Verify
)

$ErrorActionPreference = 'Stop'

function Get-Sha256Hex([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        $hash  = $sha.ComputeHash($bytes)
        return (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally {
        $sha.Dispose()
    }
}

# 【B8】冻结范围：默认只冻结 tasks.json 声明的文件，而不是全仓 diff。
#
# 实跑教训：新项目没有 .gitignore 时 `git add -A` 会把 node_modules 全部 staged，
# 冻结出 682 个文件的「审查目标」。reviewer 拿到这种目标要么被淹没，要么草草扫过 ——
# 两种结果都让冻结机制形同虚设。
# 大仓上会更严重：全仓 diff 里绝大部分内容与本轮改动无关。
#
# 顺带收获：一旦有了声明范围，「staged 里有哪些文件不在任何 task 的 files 里」
# 就变成可机械检测的了 —— 那正是越界改文件的信号（见 A6：agent 无法自证边界）。
function Get-DeclaredFiles([string]$FeatureDir) {
    $tasksPath = Join-Path $FeatureDir 'tasks.json'
    if (-not (Test-Path $tasksPath)) { return @() }
    try {
        $t = Get-Content $tasksPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return @()
    }
    $out = @()
    foreach ($task in @($t.tasks | Where-Object { $null -ne $_ })) {
        foreach ($f in @($task.files | Where-Object { $null -ne $_ })) {
            $out += $f.Replace('\', '/')
        }
    }
    return @($out | Sort-Object -Unique)
}

function Get-CurrentDiff([string]$RepoRoot, [string[]]$Scope) {
    Push-Location $RepoRoot
    try {
        # 有声明范围就用 git pathspec 限定；没有则退回全仓（并在调用处告警）
        $spec = ''
        if ($Scope -and $Scope.Count -gt 0) {
            $quoted = @($Scope | ForEach-Object { '"' + $_ + '"' })
            $spec = ' -- ' + ($quoted -join ' ')
        }

        $staged = & cmd /c "git diff --staged$spec 2>&1"
        $code = $LASTEXITCODE
        if ($code -ne 0) {
            throw "git diff --staged 失败：$($staged | Out-String)"
        }
        $text = ($staged | Out-String)
        $mode = 'staged'
        if ([string]::IsNullOrWhiteSpace($text)) {
            $text = (& cmd /c "git diff HEAD$spec 2>&1" | Out-String)
            $mode = 'worktree'
        }
        # ⚠ `--name-only` 必须放在 `--` **之前**。`--` 之后的一切都会被 git 当成 pathspec，
        # 写成 `git diff --staged -- <paths> --name-only` 会让 `--name-only` 变成一个文件名，
        # 于是返回的是 diff 正文而不是文件名列表 —— 实测把 2 个文件报成了 14 个。
        $files = @(& cmd /c "git diff --staged --name-only$spec 2>&1")
        if ($mode -eq 'worktree') {
            $files = @(& cmd /c "git diff HEAD --name-only$spec 2>&1")
        }

        # 越界检测：不带 pathspec 再取一次全量改动名单，差集就是「不在任何 task 的 files 里」的
        $outOfScope = @()
        if ($Scope -and $Scope.Count -gt 0) {
            $allCmd = if ($mode -eq 'staged') { 'git diff --staged --name-only 2>&1' } else { 'git diff HEAD --name-only 2>&1' }
            $all = @(& cmd /c $allCmd)
            $scopeSet = @{}
            foreach ($s in $Scope) { $scopeSet[$s.ToLower()] = $true }
            foreach ($f in $all) {
                $n = ("$f").Trim().Replace('\', '/')
                if ($n -and -not $scopeSet.ContainsKey($n.ToLower())) { $outOfScope += $n }
            }
        }
        # 【C8】不能把 git 的错误输出当成 commit 号存下来。
        # 实测教训：非 git 仓库 / 无提交时，`2>&1` 会把整段
        # `fatal: ambiguous argument 'HEAD'…` 写进 baseCommit，
        # 于是冻结记录里「以哪个基线为准」这一项变成垃圾，独立方无法重建审查基线。
        # sha256 那一项是好的，所以 -Verify 照样能用 —— 这正是它一直没被发现的原因。
        $base = (& cmd /c "git rev-parse HEAD 2>NUL" | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $base -notmatch '^[0-9a-f]{7,40}$') {
            $base = $null   # 宁可留空，也不留一段假装是 commit 号的报错
        }
        return [pscustomobject]@{ text = $text; mode = $mode; files = $files; base = $base; outOfScope = $outOfScope }
    } finally {
        Pop-Location
    }
}

$dir        = Join-Path $Root ".rd\features\$Feature"
$targetPath = Join-Path $dir "review-target.json"

if (-not (Test-Path $dir)) {
    Write-Host "[freeze] 找不到 $dir" -ForegroundColor Red
    exit 2
}

$declared = Get-DeclaredFiles -FeatureDir $dir
if ($declared.Count -eq 0) {
    Write-Host "[freeze] ⚠ 读不到 tasks.json 的 files 声明，退回**全仓 diff**。" -ForegroundColor Yellow
    Write-Host "         全仓 diff 会把依赖目录、构建产物一起冻进审查目标（实测出现过 682 个文件），" -ForegroundColor DarkGray
    Write-Host "         reviewer 要么被淹没要么草草扫过 —— 两种结果都让冻结机制形同虚设。" -ForegroundColor DarkGray
}

$current = Get-CurrentDiff -RepoRoot $Root -Scope $declared
$hash    = Get-Sha256Hex -Text $current.text

if ($Verify) {
    if (-not (Test-Path $targetPath)) {
        Write-Host "[freeze] 没有已冻结的目标，无法校验。" -ForegroundColor Red
        exit 2
    }
    $frozen = Get-Content $targetPath -Raw -Encoding UTF8 | ConvertFrom-Json

    if ($frozen.sha256 -eq $hash) {
        Write-Host "[freeze] OK —— 目标未漂移 ($($hash.Substring(0,12)))" -ForegroundColor Green
        exit 0
    }

    Write-Host "[freeze] TargetMoved —— 审查目标在审查期间被改动" -ForegroundColor Red
    Write-Host "         冻结时: $($frozen.sha256.Substring(0,12))  ($($frozen.frozenAt))" -ForegroundColor Yellow
    Write-Host "         当前:   $($hash.Substring(0,12))" -ForegroundColor Yellow
    Write-Host "         本轮审查作废。重新冻结完整目标后再派 reviewer。" -ForegroundColor Yellow
    exit 1
}

if ([string]::IsNullOrWhiteSpace($current.text)) {
    Write-Host "[freeze] 工作树没有任何改动，没什么可审的。" -ForegroundColor Yellow
    exit 2
}

$diffDir = Join-Path $dir "reports"
if (-not (Test-Path $diffDir)) { New-Item -ItemType Directory -Path $diffDir -Force | Out-Null }
$diffPath = Join-Path $diffDir "l2-round$Round.diff"
# 必须写成与 Get-Sha256Hex 完全相同的字节（UTF-8 无 BOM），否则独立方对这个文件
# 跑 Get-FileHash 会得到与 review-target.json 里记录的 hash 不同的值，冻结就失去了
# 「第三方可复核」的意义。Out-File -Encoding utf8 在 PS 5.1 会加 BOM，不能用。
[System.IO.File]::WriteAllText($diffPath, $current.text, (New-Object System.Text.UTF8Encoding($false)))

$outOfScope = @($current.outOfScope | Where-Object { $_ -and $_.Trim() })

$target = [pscustomobject]@{
    feature      = $Feature
    round        = $Round
    mode         = $current.mode
    sha256       = $hash
    baseCommit   = $current.base
    scope        = $(if ($declared.Count -gt 0) { 'tasks.json declared files' } else { 'whole-repo (fallback)' })
    scopeFiles   = @($declared)
    files        = @($current.files | Where-Object { $_ -and $_.Trim() })
    outOfScope   = $outOfScope
    diffPath     = $diffPath
    frozenAt     = (Get-Date).ToString('o')
}
# 不走管道：见 check-artifacts 里同一个坑（局部变量与 switch 参数撞名、管道属性名绑定）
$targetJson = ConvertTo-Json -InputObject $target -Depth 5
[System.IO.File]::WriteAllText($targetPath, $targetJson, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "[freeze] 目标已冻结" -ForegroundColor Green
Write-Host "         sha256 : $($hash.Substring(0,12))" -ForegroundColor Gray
Write-Host "         mode   : $($current.mode)" -ForegroundColor Gray
Write-Host "         scope  : $($target.scope)  ($($declared.Count) 个声明文件)" -ForegroundColor Gray
Write-Host "         files  : $($target.files.Count)  ← 本轮实际改动且在范围内的" -ForegroundColor Gray
Write-Host "         diff   : $diffPath" -ForegroundColor Gray

if ($outOfScope.Count -gt 0) {
    Write-Host ""
    Write-Host "         ⚠ 有 $($outOfScope.Count) 个改动文件**不在任何 task 的 files 声明里**：" -ForegroundColor Yellow
    foreach ($f in ($outOfScope | Select-Object -First 12)) { Write-Host "             $f" -ForegroundColor Yellow }
    if ($outOfScope.Count -gt 12) { Write-Host "             …还有 $($outOfScope.Count - 12) 个" -ForegroundColor Yellow }
    Write-Host "         它们**不在本次审查目标里**。要么是越界改动（agent 改了白名单外的文件)，" -ForegroundColor DarkGray
    Write-Host "         要么是 tasks.json 的 files 声明漏了。两种都该先弄清楚再派 reviewer。" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "         现在可以派 reviewer。在它返回之前不要改动工作树。" -ForegroundColor DarkGray
Write-Host ""
exit 0
