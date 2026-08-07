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

function Get-CurrentDiff([string]$RepoRoot) {
    Push-Location $RepoRoot
    try {
        $staged = & cmd /c "git diff --staged 2>&1"
        $code = $LASTEXITCODE
        if ($code -ne 0) {
            throw "git diff --staged 失败：$($staged | Out-String)"
        }
        $text = ($staged | Out-String)
        $mode = 'staged'
        if ([string]::IsNullOrWhiteSpace($text)) {
            $text = (& cmd /c "git diff HEAD 2>&1" | Out-String)
            $mode = 'worktree'
        }
        $files = @(& cmd /c "git diff --staged --name-only 2>&1")
        if ($mode -eq 'worktree') {
            $files = @(& cmd /c "git diff HEAD --name-only 2>&1")
        }
        $base = (& cmd /c "git rev-parse HEAD 2>&1" | Out-String).Trim()
        return [pscustomobject]@{ text = $text; mode = $mode; files = $files; base = $base }
    } finally {
        Pop-Location
    }
}

$dir        = Join-Path $Root ".workflow\features\$Feature"
$targetPath = Join-Path $dir "review-target.json"

if (-not (Test-Path $dir)) {
    Write-Host "[freeze] 找不到 $dir" -ForegroundColor Red
    exit 2
}

$current = Get-CurrentDiff -RepoRoot $Root
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

$target = [pscustomobject]@{
    feature   = $Feature
    round     = $Round
    mode      = $current.mode
    sha256    = $hash
    baseCommit= $current.base
    files     = @($current.files | Where-Object { $_ -and $_.Trim() })
    diffPath  = $diffPath
    frozenAt  = (Get-Date).ToString('o')
}
$target | ConvertTo-Json -Depth 5 | Out-File -FilePath $targetPath -Encoding utf8

Write-Host ""
Write-Host "[freeze] 目标已冻结" -ForegroundColor Green
Write-Host "         sha256 : $($hash.Substring(0,12))" -ForegroundColor Gray
Write-Host "         mode   : $($current.mode)" -ForegroundColor Gray
Write-Host "         files  : $($target.files.Count)" -ForegroundColor Gray
Write-Host "         diff   : $diffPath" -ForegroundColor Gray
Write-Host ""
Write-Host "         现在可以派 reviewer。在它返回之前不要改动工作树。" -ForegroundColor DarkGray
Write-Host ""
exit 0
