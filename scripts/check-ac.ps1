<#
.SYNOPSIS
  跑一条被过滤的验收命令，并确认它「真的验到了东西」。

.DESCRIPTION
  为什么需要这层包装：几乎所有测试运行器在「过滤条件匹配不到任何用例」时都会**成功退出**。

    node --test --test-name-pattern "ZZZ-NONEXISTENT"   -> exit 0
    jest -t "does-not-exist"                            -> exit 0（默认）

  于是 acceptance.json 里那条「只跑这条 AC 对应用例」的 check，
  在**这条 AC 的测试根本没写**的情况下照样是绿的 —— 门被骗过，AC 从未被验证。

  这个脚本要求两件事同时成立才算通过：
    1. 命令退出码为 0
    2. 命令输出里至少出现一次 -MustMatch 指定的字符串

  第 2 条就是「确实有用例被跑到了」的证据。

.EXAMPLE
  powershell -File check-ac.ps1 -Cmd 'node --test --test-name-pattern "test-seam AC-1"' -MustMatch "test-seam AC-1"
  powershell -File check-ac.ps1 -Cmd 'pytest -k login_lockout' -MustMatch "login_lockout" -MinMatches 2
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Cmd,
    [Parameter(Mandatory = $true)][string]$MustMatch,
    [int]$MinMatches = 1,
    [string]$Root = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'

Push-Location $Root
try {
    $raw = & cmd /c "$Cmd 2>&1"
    $code = $LASTEXITCODE
} catch {
    $raw = $_.Exception.Message
    $code = 1
} finally {
    Pop-Location
}

$text = ($raw | Out-String)

# 统计 MustMatch 出现次数（纯字面量，不当正则）
$hits = 0
$idx = 0
while ($true) {
    $idx = $text.IndexOf($MustMatch, $idx, [StringComparison]::Ordinal)
    if ($idx -lt 0) { break }
    $hits++
    $idx += $MustMatch.Length
}

Write-Host ""
Write-Host "  cmd       : $Cmd" -ForegroundColor Gray
Write-Host "  exit      : $code" -ForegroundColor Gray
Write-Host "  matched   : $hits 次 `"$MustMatch`" (要求 >= $MinMatches)" -ForegroundColor Gray

if ($code -ne 0) {
    Write-Host ""
    Write-Host "=== FAIL —— 命令本身失败 ===" -ForegroundColor Red
    Write-Host ($text.Trim())
    exit 1
}

if ($hits -lt $MinMatches) {
    Write-Host ""
    Write-Host "=== FAIL —— 命令成功了，但一个用例都没匹配到 ===" -ForegroundColor Red
    Write-Host "    退出码 0 在这里不代表通过：过滤条件匹配不到任何用例时，" -ForegroundColor Yellow
    Write-Host "    测试运行器也会成功退出。这条 AC 实际上从未被验证。" -ForegroundColor Yellow
    Write-Host "    要么这条 AC 的测试还没写，要么用例名和过滤条件对不上。" -ForegroundColor Yellow
    Write-Host ""
    Write-Host ($text.Trim())
    exit 1
}

Write-Host ""
Write-Host "=== PASS ===" -ForegroundColor Green
Write-Host ""
exit 0
