<#
.SYNOPSIS
  产物清单校验 —— 回答「我现在在哪一步、该有的东西缺了什么、有没有无主的证据」。

.DESCRIPTION
  这个脚本存在的理由是两条实跑教训：

  1. **中断是常态，不是意外。**5 小时配额窗口下运行被反复打断，
     恢复时全靠翻文件、凭记忆猜进度。框架里有「某个 agent 死了」的完整协议，
     却没有任何东西处理「编排者自己的会话被切断」。

  2. **要求写在那儿，但没人检查有没有照做。**
     `wf-plan` 要求写 run.json、`wf-build` 要求每轮追加、`wf-review` 要求写报告正文 ——
     三处都是明文，实跑里三处都落空了，而且直到收尾复盘才被发现。

  所以这个脚本不加任何新要求，只做一件事：
  **把已有的要求变成可执行的检查。**要求已经够多了，缺的是有人检查。

.PARAMETER Root
  项目根目录。默认当前目录。

.PARAMETER Feature
  feature slug。省略时若 .workflow/features/ 下只有一个就自动选中。

.PARAMETER Json
  输出 JSON，供程序消费。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\check-artifacts.ps1 -Root D:\code\my-project

.EXAMPLE
  # 被打断后恢复，第一件事：
  powershell -ExecutionPolicy Bypass -File scripts\check-artifacts.ps1 -Feature screener

.NOTES
  退出码（`validate-plan` 和 `gate-l1` 依赖这个划分，不要改动语义）：

    0  干净
    1  有产物缺失
    2  **上一次运行被中断在半路**（run.json 的 inflight 非空）—— 唯一无歧义的硬阻塞信号
    3  产物齐全但有孤儿证据
    4  用不了（找不到 .workflow / feature 不明确 / feature 目录不存在）

  **2 只能表示 inflight，不许复用。**寄生在 `validate-plan` 与 `gate-l1` 开头的前置检查
  正是靠它做硬拦；一旦 2 还兼表「环境问题」，那两处就会把「路径写错」误当成「上次被中断」，
  然后人开始习惯性跳过检查 —— 跟没有检查一样。
#>
[CmdletBinding()]
param(
    [string]$Root = (Get-Location).Path,
    [string]$Feature,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

# ---- PS 5.1 自保：@($null) 的长度是 1 不是 0，(Where-Object).Count 单匹配返回 $null ----
function AsList($x) {
    if ($null -eq $x) { return @() }
    return @($x | Where-Object { $null -ne $_ })
}

$wf = Join-Path $Root '.workflow'
if (-not (Test-Path $wf)) {
    Write-Host "找不到 $wf —— 这个目录不是 agentflow 项目，或者还没跑 init-workflow。" -ForegroundColor Red
    exit 4
}

# ---- 定位 feature ----
$featRoot = Join-Path $wf 'features'
if (-not $Feature) {
    $dirs = AsList (Get-ChildItem -Path $featRoot -Directory -ErrorAction SilentlyContinue)
    if ($dirs.Count -eq 1) {
        $Feature = $dirs[0].Name
    } elseif ($dirs.Count -eq 0) {
        Write-Host "$featRoot 下没有任何 feature。流程还没开始。" -ForegroundColor Yellow
        exit 4
    } else {
        Write-Host "有多个 feature，用 -Feature 指定其中一个：" -ForegroundColor Yellow
        foreach ($d in $dirs) { Write-Host "  $($d.Name)" }
        exit 4
    }
}

$fdir    = Join-Path $featRoot $Feature
$reports = Join-Path $fdir 'reports'
$evidence= Join-Path $reports 'evidence'
if (-not (Test-Path $fdir)) {
    Write-Host "找不到 feature 目录: $fdir" -ForegroundColor Red
    exit 4
}

function Has($p) { return (Test-Path (Join-Path $fdir $p)) }
function HasRoot($p) { return (Test-Path (Join-Path $Root $p)) }

# ---- 收集各阶段的轮次编号 ----
function RoundNums($dir, $pattern) {
    if (-not (Test-Path $dir)) { return @() }
    $files = AsList (Get-ChildItem -Path $dir -Filter $pattern -File -ErrorAction SilentlyContinue)
    $nums = @()
    foreach ($f in $files) {
        $m = [regex]::Match($f.Name, 'round(\d+)')
        if ($m.Success) { $nums += [int]$m.Groups[1].Value }
    }
    return @($nums | Sort-Object -Unique)
}

$l1  = RoundNums $reports 'l1-round*.json'
$l2  = RoundNums $reports 'l2-round*.md'
$l2d = RoundNums $reports 'l2-round*.diff'
$l3  = RoundNums $reports 'l3-round*.md'

# ---- run.json ----
$runPath = Join-Path $fdir 'run.json'
$run = $null
$runErr = $null
if (Test-Path $runPath) {
    try { $run = Get-Content $runPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { $runErr = $_.Exception.Message }
}

# ---- lessons ----
$lessonsDir = Join-Path $wf 'lessons'
$lessons = AsList (Get-ChildItem -Path $lessonsDir -Filter '*.md' -File -ErrorAction SilentlyContinue)

# ---- 阶段定义：每个阶段「完成」的判据 ----
$stages = @()

$stages += [pscustomobject]@{
    name = 'dispatch'; label = '派发决策'
    missing = @(
        $(if (-not (Has 'dispatch.md')) { 'dispatch.md  ← wf 要求 ≥M 复杂度落一份派发决策记录（六行）' })
    ) | Where-Object { $_ }
}

$stages += [pscustomobject]@{
    name = 'spec'; label = '业务梳理'
    missing = @(
        $(if (-not (Has 'spec.md'))        { 'spec.md' })
        $(if (-not (Has 'acceptance.json')){ 'acceptance.json' })
    ) | Where-Object { $_ }
}

$stages += [pscustomobject]@{
    name = 'plan'; label = '方案与拆解'
    missing = @(
        $(if (-not (Has 'design.md'))  { 'design.md' })
        $(if (-not (Has 'tasks.json')) { 'tasks.json' })
        $(if (-not (HasRoot '.workflow/gates.json')) { '.workflow/gates.json' })
        $(if (-not (Test-Path $runPath)) { 'run.json  ← wf-plan:101 明文要求「通过后写 run.json」' })
    ) | Where-Object { $_ }
}

$stages += [pscustomobject]@{
    name = 'build'; label = '开发与 L1 机械门'
    missing = @(
        $(if ($l1.Count -eq 0) { 'l1-round{N}.json  ← 一轮机械门都没跑过' })
    ) | Where-Object { $_ }
}

# L2：每个存在的 .diff 都必须有对应的 .md（这正是项目一的失败形态）
$l2Missing = @()
if ($l2.Count -eq 0 -and $l2d.Count -eq 0) {
    $l2Missing += 'l2-round{N}.md + .diff  ← 一轮异构审查都没跑过'
}
foreach ($n in $l2d) {
    if ($l2 -notcontains $n) {
        $l2Missing += "l2-round$n.md  ← .diff 在但报告正文不在。wf-review:91 明文要求写正文"
    }
}
$stages += [pscustomobject]@{ name='review'; label='L2 异构审查'; missing=$l2Missing }

$stages += [pscustomobject]@{
    name = 'eval'; label = 'L3 场景验收'
    missing = @(
        $(if ($l3.Count -eq 0) { 'l3-round{N}.md  ← 一轮场景验收都没跑过' })
    ) | Where-Object { $_ }
}

# keep：允许「本次无采纳」，但必须有痕迹
$keepMissing = @()
$keepRecorded = $false
if ($null -ne $run -and $null -ne $run.PSObject.Properties['keep']) { $keepRecorded = $true }
if ($lessons.Count -eq 0 -and -not $keepRecorded) {
    $keepMissing += 'lessons/*.md 或 run.json 里的 keep 记录  ← wf-keep 要求「无采纳也要显式报告」'
}
$stages += [pscustomobject]@{ name='keep'; label='经验沉淀'; missing=$keepMissing }

# ---- inflight：上一次运行是不是被中断在半路 ----
# 非 null 就意味着「派出去了但没收回来」。这是恢复时第一个该看的东西 ——
# 它比「缺哪个文件」更精确：它告诉你当时有谁在跑、该产出什么。
$inflight = $null
$inflightAgents = @()
if ($null -ne $run -and $null -ne $run.PSObject.Properties['inflight'] -and $null -ne $run.inflight) {
    $inflight = $run.inflight
    foreach ($a in (AsList $inflight.agents)) {
        $rp = $a.reportPath
        $exists = $false
        $size = 0
        if ($rp) {
            $full = Join-Path $Root $rp
            if (Test-Path $full) { $exists = $true; $size = (Get-Item $full).Length }
        }
        $inflightAgents += [pscustomobject]@{
            name = $a.name; role = $a.role; task = $a.task
            reportPath = $rp; reportExists = $exists; reportBytes = $size
        }
    }
}

# ---- 【A13d】框架指纹：开跑时把「评判标准」拍照存档，之后比对有没有被改过 ----
#
# 框架自己早就有这个招数 —— `freeze-target.ps1` 冻结审查目标，理由是它自己写的：
# 「审查最常见的失效方式不是审得不好，而是**审的东西已经不是最终的东西**」。
#
# 这句话反过来一样成立：**如果规则在评判过程中能被改，「通过」就不值钱。**
# 而框架唯一没有用这个招数管住的地方，就是框架自己。
#
# 实跑教训（同一天内发生三次）：加一条新规则 → 回头改项目让它符合 → 宣布「通过」。
# 每一步都可能是对的（大部分改动确实在修真 bug），但**没有任何东西能区分
# 「修好了一个缺陷」和「把挡路的规则拿掉了」**。
#
# ⚠️ 这里不禁止改框架 —— 禁止是错的，改框架经常是必要的。
# 它只把「规则被改过」从看不见变成有记录，并且要求写一句为什么。
function Get-FrameworkFingerprint([string]$AgentflowRoot) {
    $subDirs = @('skills', 'scripts', 'templates')
    $files = @()
    foreach ($d in $subDirs) {
        $full = Join-Path $AgentflowRoot $d
        if (-not (Test-Path $full)) { continue }
        $files += @(Get-ChildItem -Path $full -Recurse -File -ErrorAction SilentlyContinue)
    }
    if ($files.Count -eq 0) { return $null }
    $sorted = @($files | Sort-Object FullName)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $ms  = New-Object System.IO.MemoryStream
    try {
        foreach ($f in $sorted) {
            # 路径也进 hash：只改文件名（比如把一条规则挪到别处）同样算漂移
            $rel = $f.FullName.Substring($AgentflowRoot.Length).Replace('\', '/').TrimStart('/')
            $nb = [Text.Encoding]::UTF8.GetBytes($rel + "`n")
            $ms.Write($nb, 0, $nb.Length)
            $cb = [IO.File]::ReadAllBytes($f.FullName)
            $ms.Write($cb, 0, $cb.Length)
        }
        $ms.Position = 0
        $hash = $sha.ComputeHash($ms)
        return [pscustomobject]@{
            sha256    = (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
            fileCount = $sorted.Count
        }
    } finally {
        $ms.Dispose()
        $sha.Dispose()
    }
}

$fwRoot = Split-Path -Parent $PSScriptRoot
$fwNow  = Get-FrameworkFingerprint $fwRoot
$fwState = 'unknown'      # captured | same | drifted | acknowledged | unknown
$fwRecorded = $null
if ($null -ne $run -and $null -ne $fwNow) {
    $fwRecorded = $run.frameworkFingerprint
    if ($null -eq $fwRecorded -or [string]::IsNullOrWhiteSpace($fwRecorded.sha256)) {
        $fwState = 'captured'          # 首次见到，记下来
    } elseif ($fwRecorded.sha256 -eq $fwNow.sha256) {
        $fwState = 'same'
    } elseif (-not [string]::IsNullOrWhiteSpace($run.frameworkDriftAcknowledged)) {
        $fwState = 'acknowledged'
    } else {
        $fwState = 'drifted'
    }
}

# ---- 【铁律 7】流程外动作：必须先问用户，且必须留裁决记录 ----
#
# 流程内的每个动作都有守卫，流程外的动作一个守卫都没有 ——
# 而实跑中真正出问题的地方，恰恰是编排者跳出流程做的那些事：
# 掐掉两个正在跑的验收 agent、十余次修改框架本身、用人工判定替代 agent 判定。
# 这些动作没有一条是被禁止的，因为流程压根没提到它们。
#
# 这里做一个**联锁**：框架指纹漂移（= 规则被改过）却找不到对应的用户裁决，
# 就意味着规则是被偷偷改的。「偷偷改规则」从此由查不到变成查得到。
$oof = AsList $run.outOfFlowActions
$oofNoDecision = @()
$oofFrameworkApproved = $false
foreach ($a in $oof) {
    if ([string]::IsNullOrWhiteSpace($a.userDecision)) {
        $oofNoDecision += "$($a.action) → $($a.target)"
    }
    if ($a.action -eq 'modify-framework' -and $a.userDecision -eq 'approved') {
        $oofFrameworkApproved = $true
    }
    # 提问必须包含「不做的话会怎样」—— 缺了它，「问」就退化成通知
    if (-not [string]::IsNullOrWhiteSpace($a.userDecision) -and [string]::IsNullOrWhiteSpace($a.ifNotDone)) {
        $oofNoDecision += "$($a.action) → $($a.target)（缺 ifNotDone：没写清「不做会怎样」，等于诱导式提问）"
    }
}

# ---- 【A13d】结论来源统计：把「只有我一个人说行」从一段自白变成一个数字 ----
$verdictBy = [ordered]@{ agent = 0; orchestrator = 0; human = 0; other = 0 }
if ($null -ne $run) {
    foreach ($r in (AsList $run.rounds)) {
        foreach ($layer in @('l1', 'l2', 'l3')) {
            $by = $r."${layer}_verified_by"
            if ([string]::IsNullOrWhiteSpace($by)) { $by = $r."${layer}_judged_by" }

            if ([string]::IsNullOrWhiteSpace($by)) {
                # 没显式标注判定者：只有该层真的作为门跑过才算一条，缺省视为 agent 判定
                $res = $r.$layer
                if ($null -eq $res) { continue }
                if ($res -is [string] -and $res -match '^not_') { continue }   # not_run / not_reached / not_run_as_gate
                $by = 'agent'
            }
            # 显式标了判定者的，**即使该层没作为门跑过也要计入** ——
            # 踩过的坑：round 3 的 l1 是 not_run_as_gate（没跑门），
            # 但编排者确实对那 5 条 check 下了「全部通过」的结论并标了 l1_verified_by=orchestrator。
            # 按「没跑门就跳过」算，这条自证结论会凭空消失 —— 而它恰恰是最该被数出来的那种。

            if ($verdictBy.Contains($by)) { $verdictBy[$by] = $verdictBy[$by] + 1 }
            else { $verdictBy['other'] = $verdictBy['other'] + 1 }
        }
    }
}

# ---- 【A15】对账：run.json 记的轮次 vs 磁盘上实际存在的轮次产物 ----
# 「派 agent 前写 inflight、每轮结束追加 rounds」这两条是靠编排者自觉的，
# 没有任何机制能强制他动手 —— 而 A15 的三个数据点都表明，靠自觉的那部分会落空。
#
# 但**不一致是可以机械检测的**：磁盘上有 l1-round3.json 而 run.json 的 rounds 只有 2 条，
# 就说明第 3 轮结束时没人追加。这不能阻止遗漏，但能让遗漏**在下一次跑门时立刻可见**，
# 而不是等到收尾复盘。
#
# ⚠ 只做两个方向里**可靠的那些**：
#  - 正向（磁盘 → run.json）按轮次编号比对：有 l1-round3.json 而 rounds 里没有 3，一定是漏记。
#  - 反向**不按编号比对**。实测踩过：run.json 的 round 3 对应的产物文件叫 `l3-round2.md`
#    （轮次编号与文件名编号在项目里分了叉），按编号比对会产生假报警。
#    改成核对每条 rounds 里 `*_evidence` 字段指向的文件是否真的存在 —— 那才是它自己声称的依据。
$roundGaps = @()
if ($null -ne $run) {
    $recorded = @()
    foreach ($r in (AsList $run.rounds)) {
        if ($null -ne $r.round) { $recorded += [int]$r.round }
    }

    # 正向：磁盘上有产物的轮次，run.json 必须有记录
    $onDisk = @(($l1 + $l2 + $l3) | Sort-Object -Unique)
    foreach ($n in $onDisk) {
        if ($recorded -notcontains $n) {
            $roundGaps += "round $n 有落盘产物，但 run.json 的 rounds 里没有这一条（wf-build:245 要求每轮结束追加）"
        }
    }

    # 【A18】编排者自己下的判定，必须带可复核的证据。
    #
    # 判定链的最后一环 —— 编排者写的一次性核对脚本 —— 是整条链上唯一没有守卫的地方。
    # 实测七次出错，其中最危险的一类不报错也不崩溃，只是数字是错的
    # （git 的 --name-only 放在 `--` 之后，2 个文件被报成 14 个，差点被当成正确结果记下来）。
    #
    # 这里能机械卡住的只有一件事：**凡是标了「由编排者核对」的结论，必须指得出证据文件。**
    # 卡不住的是核对本身对不对 —— 编排者上面没有人。见 A13。
    foreach ($r in (AsList $run.rounds)) {
        foreach ($layer in @('l1', 'l2', 'l3')) {
            $by = $r."${layer}_verified_by"
            if ([string]::IsNullOrWhiteSpace($by)) { continue }
            if ($by -eq 'agent') { continue }   # agent 判定的证据由三层门自己产出
            $ev = $r."${layer}_evidence"
            if ([string]::IsNullOrWhiteSpace($ev)) {
                $roundGaps += "round $($r.round) 的 $layer 标了 ${layer}_verified_by=$by，但没有 ${layer}_evidence —— 非 agent 下的判定必须指得出可复核的证据（命令原文 + 原始输出）"
            }
        }
    }

    # 反向：run.json 自己声称的证据文件必须真的存在
    foreach ($r in (AsList $run.rounds)) {
        foreach ($field in @('l1_evidence', 'l2_evidence', 'l3_evidence')) {
            $v = $r.$field
            if ([string]::IsNullOrWhiteSpace($v)) { continue }
            # 字段里可能写成 "a.md + b.diff"，逐个拆开核对
            foreach ($piece in ($v -split '\s*\+\s*')) {
                $rel = $piece.Trim()
                if ($rel -eq '' -or $rel -notmatch '\.(md|json|diff|log)$') { continue }
                $full = Join-Path $fdir $rel
                if (-not (Test-Path $full)) {
                    $roundGaps += "round $($r.round) 的 $field 指向 `"$rel`"，但该文件不存在 —— 记录里的依据是空的"
                }
            }
        }
    }
}

# ---- 孤儿证据：evidence/ 下没被任何报告引用的文件 ----
$orphans = @()
$evFiles = AsList (Get-ChildItem -Path $evidence -File -Recurse -ErrorAction SilentlyContinue)
if ($evFiles.Count -gt 0) {
    $allText = ''
    $rptFiles = AsList (Get-ChildItem -Path $reports -Filter '*.md' -File -ErrorAction SilentlyContinue)
    foreach ($r in $rptFiles) {
        $allText += (Get-Content $r.FullName -Raw -Encoding UTF8)
    }
    foreach ($e in $evFiles) {
        if ($allText.IndexOf($e.Name, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            $orphans += $e.Name
        }
    }
}

# ---- 判定当前进度 ----
$doneStages = @()
$firstIncomplete = $null
foreach ($s in $stages) {
    $m = AsList $s.missing
    if ($m.Count -eq 0) {
        if ($null -eq $firstIncomplete) { $doneStages += $s.label }
    } else {
        if ($null -eq $firstIncomplete) { $firstIncomplete = $s }
    }
}

$totalMissing = 0
foreach ($s in $stages) { $totalMissing += (AsList $s.missing).Count }

# ---- JSON 输出 ----
if ($Json) {
    $out = [pscustomobject]@{
        feature      = $Feature
        rounds       = [pscustomobject]@{ l1=$l1; l2=$l2; l2diff=$l2d; l3=$l3 }
        runJsonExists= (Test-Path $runPath)
        runJsonError = $runErr
        runJsonStage = $(if ($null -ne $run) { $run.stage } else { $null })
        inflight     = $inflight
        inflightAgents = $inflightAgents
        stages       = $stages
        orphans      = $orphans
        totalMissing = $totalMissing
        nextStep     = $(if ($null -ne $inflight) { '先按 inflight 收尾' } elseif ($null -ne $firstIncomplete) { $firstIncomplete.label } else { '全部阶段产物齐全' })
    }
    $out | ConvertTo-Json -Depth 6
    if ($null -ne $inflight)      { exit 2 }
    if ($totalMissing -gt 0)      { exit 1 }
    if ($orphans.Count -gt 0)     { exit 3 }
    exit 0
}

# ---- 人读输出 ----
Write-Host ""
Write-Host "=== 产物清单校验 [$Feature] ===" -ForegroundColor Cyan
Write-Host ""

# 轮次矩阵
Write-Host "  轮次：" -ForegroundColor Gray
Write-Host ("    L1 机械门   " + $(if ($l1.Count) { "round " + ($l1 -join ', ') } else { '（无）' }))
Write-Host ("    L2 审查     " + $(if ($l2.Count) { "round " + ($l2 -join ', ') } else { '（无）' }) + $(if ($l2d.Count) { "   diff: round " + ($l2d -join ', ') } else { '' }))
Write-Host ("    L3 验收     " + $(if ($l3.Count) { "round " + ($l3 -join ', ') } else { '（无）' }))
if ($null -ne $run) {
    Write-Host ("    run.json    stage=" + $run.stage + "  status=" + $run.status)
} elseif ($runErr) {
    Write-Host ("    run.json    ⚠ 解析失败: " + $runErr) -ForegroundColor Yellow
} else {
    Write-Host  "    run.json    ✗ 不存在" -ForegroundColor Yellow
}
Write-Host ""

# inflight —— 恢复时第一个该看的东西，所以放在最前面
if ($null -ne $inflight) {
    Write-Host "  ⛔ 上一次运行被中断在半路（run.json 的 inflight 非空）" -ForegroundColor Red
    Write-Host ("     stage={0}  round={1}  开始于 {2}" -f $inflight.stage, $inflight.round, $inflight.startedAt) -ForegroundColor Red
    if ($inflight.what) { Write-Host ("     当时在做：{0}" -f $inflight.what) -ForegroundColor Red }
    if ($inflightAgents.Count -gt 0) {
        Write-Host "     派出去还没收回来的 agent：" -ForegroundColor Red
        foreach ($a in $inflightAgents) {
            if ($a.reportExists) {
                Write-Host ("       · {0} [{1}] task={2}  报告已在（{3} 字节）—— 需人工确认是否完整" -f $a.name, $a.role, $a.task, $a.reportBytes) -ForegroundColor Yellow
            } else {
                Write-Host ("       · {0} [{1}] task={2}  报告不存在 —— 这个 agent 的产出不算数" -f $a.name, $a.role, $a.task) -ForegroundColor Red
            }
        }
    }
    Write-Host "     恢复动作：核对上面每份报告在不在、完不完整；不完整的产出不算数，" -ForegroundColor DarkGray
    Write-Host "     它写进 evidence/ 的东西要么认领要么删。**以产物为准，不以记忆为准。**" -ForegroundColor DarkGray
    Write-Host ""
}

# 逐阶段
foreach ($s in $stages) {
    $m = AsList $s.missing
    if ($m.Count -eq 0) {
        Write-Host ("  ✓ {0,-14} 齐全" -f $s.label) -ForegroundColor Green
    } else {
        Write-Host ("  ✗ {0,-14} 缺 {1} 项" -f $s.label, $m.Count) -ForegroundColor Red
        foreach ($x in $m) { Write-Host "      · $x" -ForegroundColor Red }
    }
}

# 框架指纹 + 结论来源
Write-Host ""
switch ($fwState) {
    'captured' {
        Write-Host "  📌 框架指纹已记入 run.json（$($fwNow.fileCount) 个规则文件，$($fwNow.sha256.Substring(0,12))）" -ForegroundColor Cyan
        Write-Host "     这是「开考时的考卷」。之后每次检查都会比对 —— 规则若在评判过程中被改过，这里会报出来。" -ForegroundColor DarkGray
    }
    'same' {
        Write-Host "  ✓ 框架未漂移（$($fwNow.fileCount) 个规则文件，$($fwNow.sha256.Substring(0,12))）" -ForegroundColor Green
    }
    'acknowledged' {
        Write-Host "  ⚠ 框架已改动，但有书面说明：$($run.frameworkDriftAcknowledged)" -ForegroundColor Yellow
    }
    'drifted' {
        Write-Host "  ⛔ 评判标准在评判过程中被改过（框架指纹漂移）" -ForegroundColor Red
        if (-not $oofFrameworkApproved) {
            Write-Host "     ⚠ 而且 outOfFlowActions 里没有一条 modify-framework 的用户裁决 ——" -ForegroundColor Red
            Write-Host "       按铁律 7，改框架属于流程外动作，必须先问用户。这次没有记录。" -ForegroundColor Red
        }
        Write-Host "     开跑时: $($fwRecorded.sha256.Substring(0,12))  ($($fwRecorded.fileCount) 个文件)" -ForegroundColor Red
        Write-Host "     现在  : $($fwNow.sha256.Substring(0,12))  ($($fwNow.fileCount) 个文件)" -ForegroundColor Red
        Write-Host "     改框架经常是对的 —— 这里不禁止。但没有任何东西能区分「修好了一个缺陷」和" -ForegroundColor DarkGray
        Write-Host "     「把挡路的规则拿掉了」，所以必须留一句话。在 run.json 写：" -ForegroundColor DarkGray
        Write-Host "       `"frameworkDriftAcknowledged`": `"改了什么、为什么、是否影响本次已下的结论`"" -ForegroundColor DarkGray
    }
}

if ($oof.Count -gt 0 -or $oofNoDecision.Count -gt 0) {
    Write-Host ""
    Write-Host ("  流程外动作：{0} 条（铁律 7 要求先问用户）" -f $oof.Count) -ForegroundColor Gray
    foreach ($a in $oof) {
        $mark = if ($a.userDecision -eq 'approved') { '✓' } elseif ($a.userDecision -eq 'rejected') { '✗' } else { '?' }
        Write-Host ("     {0} {1} → {2}  [{3}]" -f $mark, $a.action, $a.target, $(if ($a.userDecision) { $a.userDecision } else { '无裁决' })) -ForegroundColor DarkGray
    }
    if ($oofNoDecision.Count -gt 0) {
        Write-Host "     ⛔ 下面这些是自作主张（没有用户裁决，或提问时没写清「不做会怎样」）：" -ForegroundColor Red
        foreach ($x in $oofNoDecision) { Write-Host "        · $x" -ForegroundColor Red }
    }
}

if ($null -ne $run) {
    $indep = $verdictBy['agent']
    $self  = $verdictBy['orchestrator'] + $verdictBy['other']
    Write-Host ""
    Write-Host ("  结论来源：agent 判定 {0} 条 / 编排者自证 {1} 条 / 人工判定 {2} 条" -f $verdictBy['agent'], $verdictBy['orchestrator'], $verdictBy['human']) -ForegroundColor Gray
    if ($self -gt 0) {
        Write-Host "     ⚠ 编排者自证的不计入独立验证 —— 出题、答题、判卷是同一个人。" -ForegroundColor Yellow
    }
    if ($indep -eq 0 -and ($self + $verdictBy['human']) -gt 0) {
        Write-Host "     ⚠ 本 feature **没有任何一条结论**来自独立 agent 判定。" -ForegroundColor Yellow
    }
}

# 轮次对账
Write-Host ""
if ($roundGaps.Count -gt 0) {
    Write-Host "  ⚠ run.json 与磁盘产物对不上（$($roundGaps.Count) 处）：" -ForegroundColor Yellow
    foreach ($g in $roundGaps) { Write-Host "      · $g" -ForegroundColor Yellow }
    Write-Host "    `wf-build:245` 要求每轮结束追加一行到 rounds。对不上说明某一轮结束时没人动手。" -ForegroundColor DarkGray
    Write-Host "    补回去 —— 不补的话，熔断计数、指纹比对全都建立在一份不完整的记录上。" -ForegroundColor DarkGray
} else {
    Write-Host "  ✓ run.json 的 rounds 与磁盘产物一致" -ForegroundColor Green
}

# 孤儿产物
Write-Host ""
if ($orphans.Count -gt 0) {
    Write-Host "  ⚠ 孤儿证据 $($orphans.Count) 个 —— 在 evidence/ 里，但没有任何报告引用它们：" -ForegroundColor Yellow
    foreach ($o in $orphans) { Write-Host "      · $o" -ForegroundColor Yellow }
    Write-Host "    这些文件通常来自被中断或被终止的 agent。它们是真实证据，" -ForegroundColor DarkGray
    Write-Host "    但没人知道属于哪一轮、验证了什么 —— 要么在报告里认领，要么删掉。" -ForegroundColor DarkGray
} else {
    Write-Host "  ✓ 无孤儿证据" -ForegroundColor Green
}

# ---- 留痕：把本次检查的时间写回 run.json ----
# 它不阻止任何事，作用只有一个：让「整个过程中一次都没查过」变得可见。
# 收尾时若 lastCheckedAt 早于最后一次产物变更，说明中间没查过。
# 实跑教训：A15 的三个数据点全都不是被流程抓到的，都是复盘才发现的 ——
# 留痕至少把发现时间从「复盘」提前到「收尾」。
if ($null -ne $run -and (Test-Path $runPath)) {
    try {
        # ⚠ 局部变量绝对不能叫 $json。
        # PowerShell 变量**不区分大小写**，而本脚本的参数里有 `[switch]$Json` ——
        # 于是 `$json = <字符串>` 实际是在给那个 switch 类型的参数变量赋值，
        # 类型约束当场拒绝，抛「Cannot convert String to SwitchParameter」。
        #
        # 这个坑极难查，因为：
        #  1. 报错文本长得像**参数绑定**错误，会让人去怀疑同一行的 cmdlet（ConvertTo-Json）；
        #  2. 把同样几行拆出来单独跑（交互式或独立脚本）**全都通过** ——
        #     因为那些上下文里没有 `[switch]$Json` 这个参数。
        # 排查时唯一有效的线索是：报错行号一直是对的，错的是我对那一行的解读。
        $now = (Get-Date).ToString('o')
        Add-Member -InputObject $run -MemberType NoteProperty -Name 'lastCheckedAt' -Value $now -Force
        # 首次见到就把框架指纹记下来 —— 这是「开考时的考卷」。
        # 之后不再覆盖：覆盖等于每次检查都重新拍一张照，漂移就永远发现不了。
        if ($fwState -eq 'captured' -and $null -ne $fwNow) {
            $fp = [pscustomobject]@{
                sha256     = $fwNow.sha256
                fileCount  = $fwNow.fileCount
                capturedAt = $now
                _note      = '开跑时框架（skills/ + scripts/ + templates/）的指纹。之后每次 check-artifacts 都比对：规则若在评判过程中被改过，会报漂移。改框架不被禁止，但必须在 frameworkDriftAcknowledged 里写一句为什么 —— 否则无法区分「修好了一个缺陷」和「把挡路的规则拿掉了」。'
            }
            Add-Member -InputObject $run -MemberType NoteProperty -Name 'frameworkFingerprint' -Value $fp -Force
        }
        $runJsonText = ConvertTo-Json -InputObject $run -Depth 12
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [IO.File]::WriteAllText($runPath, $runJsonText, $utf8NoBom)
    } catch {
        Write-Host "  ⚠ 无法写回 run.json 的 lastCheckedAt（第 $($_.InvocationInfo.ScriptLineNumber) 行）：$($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}

# 结论
# 退出码：0 = 干净；1 = 有缺失；2 = 上次被中断在半路（inflight 非空）；3 = 齐全但有孤儿证据；4 = 用不了
Write-Host ""
if ($null -ne $inflight) {
    Write-Host "=== 上次运行被中断在半路，先按上面的 inflight 收尾 ===" -ForegroundColor Red
    Write-Host ""
    Write-Host "  收完尾把 run.json 的 inflight 清成 null，再继续往下走。" -ForegroundColor DarkGray
    Write-Host ""
    exit 2
}
if ($totalMissing -gt 0) {
    Write-Host "=== 缺 $totalMissing 项，下一步：$($firstIncomplete.label) ===" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  被打断后恢复时，以这里为准，不要凭记忆接着往下走。" -ForegroundColor DarkGray
    Write-Host ""
    exit 1
}
if ($orphans.Count -gt 0 -or $roundGaps.Count -gt 0 -or $fwState -eq 'drifted' -or $oofNoDecision.Count -gt 0) {
    $why = @()
    if ($oofNoDecision.Count -gt 0) { $why += "$($oofNoDecision.Count) 条流程外动作没有用户裁决" }
    if ($fwState -eq 'drifted')  { $why += "评判标准中途被改过且无书面说明" }
    if ($orphans.Count -gt 0)   { $why += "$($orphans.Count) 个孤儿证据" }
    if ($roundGaps.Count -gt 0) { $why += "$($roundGaps.Count) 处轮次记录对不上" }
    Write-Host "=== 阶段产物齐全，但有 $($why -join '、') 待处置 ===" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  不判为通过：无主证据是「中断留下的残骸」，会被后人误当成有效依据；" -ForegroundColor DarkGray
    Write-Host "  记录对不上则意味着熔断计数与指纹比对建立在一份不完整的 run.json 上。" -ForegroundColor DarkGray
    Write-Host ""
    exit 3
}
Write-Host "=== 全部阶段产物齐全，无孤儿证据 ===" -ForegroundColor Green
Write-Host ""
exit 0
