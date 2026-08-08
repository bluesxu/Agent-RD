<#
.SYNOPSIS
  跑一条被过滤的验收命令，并确认它「真的验到了东西」——而且验的是**每一个**该验的点。

.DESCRIPTION
  这个脚本解决两个问题。

  ## 问题一：退出码 0 不代表通过（空过 / vacuous pass）

  几乎所有测试运行器在「过滤条件匹配不到任何用例」时都会**成功退出**：

    node --test --test-name-pattern "ZZZ-NONEXISTENT"   -> exit 0
    jest -t "does-not-exist"                            -> exit 0（默认）

  于是 acceptance.json 里那条「只跑这条 AC 对应用例」的 check，
  在**这条 AC 的测试根本没写**的情况下照样是绿的 —— 门被骗过，AC 从未被验证。

  所以要求两件事同时成立：命令退出码为 0，**且**输出里出现了指定的锚点。

  ## 问题二【A14】：`then` 是多子句的，一个布尔值盖不住

  一条 AC 的 `then` 常常写着好几个并列要求，而 check 只能给出「是/否」。
  实跑里出现过：`then` 要求「初值必须用 SMA(period) 作种子」，
  而 check 只验证「有 ≥1 个名字含该 AC 编号的用例且退出码为 0」——
  那一句到底有没有被锁住，**从门外完全看不出来**。

  更糟的一次：某条规则实现了两遍（核心模块一份、编排层一份），
  只有一份有边界测试。机器判定通过，实际只锁住了一半。

  所以 -MustMatch 接受**多个**锚点，一条子句一个，**全部命中才算通过**。
  哪一句没被锁住，从输出里直接可见。

.PARAMETER MustMatch
  一个或多个锚点字符串（纯字面量，不当正则）。**全部**都要在输出中出现。
  推荐：`then` 有几个并列要求，就写几个锚点，每个对应一个测试名里的可见片段。

.PARAMETER MinMatches
  每个锚点各自要求的最少出现次数，默认 1。

.EXAMPLE
  # 单锚点（老写法，仍然支持）
  powershell -File check-ac.ps1 -Cmd "node --test --test-name-pattern=feat\sAC-1" -MustMatch "feat AC-1"

.EXAMPLE
  # 多锚点：then 有三个并列要求，就锁三个点。
  # ⚠ 用 `;;` 分隔，不要用逗号数组 —— 见下面的说明。
  powershell -File check-ac.ps1 -Cmd "node --test --test-name-pattern=feat\sAC-1" -MustMatch "数值精确匹配;;SMA 种子;;长度不足返回 null"

.NOTES
  ## 为什么多锚点要用 `;;` 而不是逗号数组

  `powershell -File script.ps1 -MustMatch "a","b"` **不会**绑定成两个元素 ——
  `-File` 模式把参数当扁平字符串传，两个值会被合并成 `a,b` 一个字符串。
  （直接在 PowerShell 里调 `.\check-ac.ps1 -MustMatch "a","b"` 倒是正常的，
  但 acceptance.json 的 check 走的恰恰是 `-File`。）

  不用逗号做分隔符，是因为锚点里出现逗号是完全正常的（测试名常有逗号）。
  所以约定 `;;`：两个分号连写在测试名里几乎不会自然出现。

  两种写法都支持：原生数组调用照常工作，`-File` 调用用 `;;`。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Cmd,
    [Parameter(Mandatory = $true)][string[]]$MustMatch,
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

# 统计某个锚点出现次数（纯字面量，不当正则）
function Count-Hits([string]$Haystack, [string]$Needle) {
    $n = 0
    $i = 0
    while ($true) {
        $i = $Haystack.IndexOf($Needle, $i, [StringComparison]::Ordinal)
        if ($i -lt 0) { break }
        $n++
        $i += $Needle.Length
    }
    return $n
}

# `powershell -File` 不做数组绑定，多个锚点会被合并成一个字符串。
# 所以约定用 `;;` 分隔，并在这里展开。原生数组调用不受影响（每个元素各自展开一次）。
$anchors = @()
foreach ($m in @($MustMatch | Where-Object { $null -ne $_ })) {
    foreach ($piece in ($m -split ';;')) {
        $p = $piece.Trim()
        if ($p -ne '') { $anchors += $p }
    }
}
$results = @()
foreach ($a in $anchors) {
    $results += [pscustomobject]@{ anchor = $a; hits = (Count-Hits $text $a) }
}
$missing = @($results | Where-Object { $_.hits -lt $MinMatches })

Write-Host ""
Write-Host "  cmd       : $Cmd" -ForegroundColor Gray
Write-Host "  exit      : $code" -ForegroundColor Gray
foreach ($r in $results) {
    $ok = $r.hits -ge $MinMatches
    $color = if ($ok) { 'Gray' } else { 'Red' }
    $mark  = if ($ok) { ' ' } else { '✗' }
    Write-Host ("  matched {0} : {1} 次  `"{2}`"  (要求 >= {3})" -f $mark, $r.hits, $r.anchor, $MinMatches) -ForegroundColor $color
}

if ($code -ne 0) {
    Write-Host ""
    Write-Host "=== FAIL —— 命令本身失败 ===" -ForegroundColor Red
    Write-Host ($text.Trim())
    exit 1
}

if ($missing.Count -gt 0) {
    Write-Host ""
    if ($missing.Count -eq $anchors.Count) {
        Write-Host "=== FAIL —— 命令成功了，但一个锚点都没匹配到 ===" -ForegroundColor Red
        Write-Host "    退出码 0 在这里不代表通过：过滤条件匹配不到任何用例时，" -ForegroundColor Yellow
        Write-Host "    测试运行器也会成功退出。这条 AC 实际上从未被验证。" -ForegroundColor Yellow
        Write-Host "    要么这条 AC 的测试还没写，要么用例名和过滤条件对不上。" -ForegroundColor Yellow
    } else {
        Write-Host "=== FAIL —— 部分子句没有被锁住 ===" -ForegroundColor Red
        Write-Host "    命令退出码是 0，其他锚点也命中了，但下面这几个没有：" -ForegroundColor Yellow
        foreach ($m in $missing) { Write-Host "      · $($m.anchor)" -ForegroundColor Yellow }
        Write-Host "    这意味着 then 里对应的那几句要求**没有测试在管**。" -ForegroundColor Yellow
        Write-Host "    部分满足不是通过 —— 补上对应的用例，或说明那一句为什么不该由测试锁。" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host ($text.Trim())
    exit 1
}

Write-Host ""
Write-Host "=== PASS —— $($anchors.Count) 个锚点全部命中 ===" -ForegroundColor Green
Write-Host ""
exit 0
