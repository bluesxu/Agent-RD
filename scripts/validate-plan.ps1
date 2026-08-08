<#
.SYNOPSIS
  校验 acceptance.json / tasks.json 的机械规则。

.DESCRIPTION
  这道门是无人化的前提。它拦下的是后面自动流程无论如何都发现不了的那类错误：
  - 验收标准判定不了  -> L3 永远无法判断"做完了没有"
  - 同层文件重叠      -> 并行 Builder 互相覆盖，diff 里看不出来
  - AC 没被任何 task 覆盖 -> 悄悄漏掉一整块需求

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\validate-plan.ps1 -Feature user-login -Stage spec
  powershell -ExecutionPolicy Bypass -File scripts\validate-plan.ps1 -Feature user-login -Stage plan
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Feature,
    [ValidateSet('spec', 'plan')][string]$Stage = 'plan',
    [string]$Root = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'

$dir      = Join-Path $Root ".workflow\features\$Feature"
$acPath   = Join-Path $dir 'acceptance.json'
$taskPath = Join-Path $dir 'tasks.json'
$specPath = Join-Path $dir 'spec.md'

$errors   = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

function Add-Err([string]$m) { $script:errors.Add($m) }
function Add-Warn([string]$m) { $script:warnings.Add($m) }

# PowerShell 里 @($null) 的长度是 1 而不是 0，缺省字段会变成一个 null 元素。
# 所有从 JSON 读出来的数组字段都要过这个函数。
function AsList($v) {
    if ($null -eq $v) { return @() }
    return @($v | Where-Object { $null -ne $_ })
}

# ---------- 前置：上次是不是被中断在半路 ----------
# 为什么挂在这里而不是往 SKILL.md 里加一句「必须先跑 check-artifacts」：
# 「写进 skill 正文」这条路已经被证伪三次（见 KNOWN-ISSUES 的 A15）——
# 规则写得很清楚、没被执行、都是复盘才发现的，而违反者是持有规则原文的编排者本人。
# 所以不新增调用点，寄生到一条**流程上绕不过去**的路上：
# validate-plan 不过就不许派 agent，它必跑。
#
# 只硬拦 inflight（退出码 2），因为它是唯一无歧义的信号：
# 「派出去的东西没收回来」只有这一个含义。
# 产物缺失（1）在流程中段是正常的，一律阻塞会天天误报，
# 然后人开始习惯性跳过检查 —— 跟没有检查一样。
$checkArt = Join-Path $PSScriptRoot 'check-artifacts.ps1'
if (Test-Path $checkArt) {
    $caOut  = & powershell -ExecutionPolicy Bypass -File $checkArt -Root $Root -Feature $Feature 2>$null | Out-String
    $caCode = $LASTEXITCODE
    if ($caCode -eq 2) {
        Write-Host $caOut
        Write-Host "=== validate-plan 中止：上次运行被中断在半路 ===" -ForegroundColor Red
        Write-Host "  先按上面的 inflight 收尾，把 run.json 的 inflight 清成 null，再回来规划。" -ForegroundColor Red
        Write-Host "  在没收尾的状态下继续规划，会基于一份不知道真假的进度做决策。" -ForegroundColor DarkGray
        exit 2
    }
    if ($caCode -eq 3) {
        Add-Warn "存在孤儿证据（evidence/ 下有文件没被任何报告引用）。跑 check-artifacts.ps1 看清单 —— 要么在报告里认领，要么删掉。无主证据会被后人误当成有效依据。"
    }
}

# ---------- spec.md ----------
if (-not (Test-Path $specPath)) {
    Add-Err "缺少 spec.md"
} else {
    $spec = Get-Content $specPath -Raw -Encoding UTF8
    if ($spec -notmatch '(?m)^##\s*范围') {
        Add-Err "spec.md 缺少「## 范围」一节"
    } elseif ($spec -notmatch '(?ms)^##\s*范围.*?[-*+]\s*[*_`]*\s*不做\s*[*_`]*\s*[:：]\s*\S') {
        # 容忍 markdown 强调与不同列表符号：「- 不做：」「- **不做**：」「* `不做`:」都算数。
        # 早期版本只认最朴素的一种写法，会对完全合规的 spec 误报。
        Add-Err "spec.md 的「范围」里「不做」为空。没有边界的需求，agent 一定会越界。"
    }

    # 【B13】提示性内容不该留在 spec.md 里 —— L3 验收者会读它的全文。
    #
    # 「未决风险」和「怎么确认算对了」本质是**一份提示清单**：
    # 它们告诉验收者「作者怕哪里错、打算怎么抓」。验收者照着找到了，什么都不证明 ——
    # 而它要写的「场外观察」，全部价值就在于「那是自己撞见的」。
    #
    # 早期版本的写法是「验收者只许读 spec.md 的两节」。那条规则**根本无法被遵守**：
    # 读文件的工具只能整读，实跑里验收者只能事后报备「我看到了全部 75 行」。
    # 做不到的规则会腐蚀做得到的规则，所以改成按文件切分：这两节移到 spec-internal.md。
    #
    # ⚠️ 只警告不报错：已有项目的 spec.md 就是合在一起的，
    # 报错会把它们全部拦死，而这属于文档组织问题，不是判定能力缺陷。
    $internalPath = Join-Path $dir 'spec-internal.md'
    $leaky = @()
    if ($spec -match '(?m)^##\s*未决风险')     { $leaky += '未决风险' }
    if ($spec -match '(?m)^#{2,3}.*怎么确认算对') { $leaky += '怎么确认算对了' }
    if ($leaky.Count -gt 0 -and -not (Test-Path $internalPath)) {
        Add-Warn "spec.md 里还留着「$($leaky -join '」「')」。这几节是给出方案的人看的，不是给验收者看的 —— L3 验收者会读 spec.md 全文，读到它们等于拿到一份提示清单，之后它的「场外观察」就不再是自己撞见的了。把它们移到同目录的 spec-internal.md（L3 禁读、方案 agent 必读）。"
    }
}

# ---------- acceptance.json ----------
$ac = $null
if (-not (Test-Path $acPath)) {
    Add-Err "缺少 acceptance.json"
} else {
    try {
        $ac = Get-Content $acPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        Add-Err "acceptance.json 不是合法 JSON: $($_.Exception.Message)"
    }
}

$acIds = @()
$machineAcIds = @()
$machineChecks = @{}
if ($null -ne $ac) {
    $scenarios = AsList $ac.scenarios
    if ($scenarios.Count -eq 0) {
        Add-Err "acceptance.json 没有任何 scenario"
    }

    $seen = @{}
    foreach ($s in $scenarios) {
        $id = $s.id
        if ([string]::IsNullOrWhiteSpace($id)) { Add-Err "有 scenario 缺少 id"; continue }
        if ($seen.ContainsKey($id)) { Add-Err "$id 重复" } else { $seen[$id] = $true }
        $acIds += $id

        foreach ($f in @('name', 'given', 'when', 'then')) {
            if ([string]::IsNullOrWhiteSpace($s.$f)) { Add-Err "$id 缺少 $f" }
        }

        $judge = $s.judge
        if ($judge -ne 'machine' -and $judge -ne 'agent') {
            Add-Err "$id 的 judge 必须是 machine 或 agent（当前: '$judge'）"
            continue
        }

        if ($judge -eq 'machine') {
            $machineAcIds += $id

            # 【A9】业务梳理只讨论业务 —— 阶段 0 要判据，阶段 1 才要命令。
            #
            # 原设计在阶段 0 就要求「一条能跑、退出码即结论的命令」，
            # 而命令必然带着语言和工具。于是技术选型在阶段 1 开始之前就已经定了 ——
            # 而阶段 1 还要派 2~3 个 agent（尽量不同厂商/不同模型）独立出方案再仲裁。
            # 实跑：三个论证 agent 里两个开口第一句就是「技术栈其实不用论证，已被钉死」。
            # 那套安排的成本照付，产出的是一场走过场。
            #
            # 这不是锚定问题，是**类别错误**：阶段 0 里根本不该有技术。
            $techTokens = @(
                'node ', 'node.', 'npm ', 'npx ', 'yarn ', 'pnpm ', 'deno ', 'bun ',
                'pytest', 'python ', 'pip ', 'poetry', 'tox ',
                'cargo ', 'go test', 'go build', 'dotnet ', 'mvn ', 'gradle ',
                'jest', 'mocha', 'vitest', 'rspec', 'phpunit', 'junit',
                'tsc ', '--test-name-pattern', 'powershell', 'bash '
            )
            $intent = "$($s.checkIntent)"

            if ([string]::IsNullOrWhiteSpace($intent)) {
                if ($Stage -eq 'spec') {
                    Add-Err "$id judge=machine 但没有 checkIntent。阶段 0 要的是【判据】不是【命令】：说清输入是什么、期望输出是什么、用什么判等（精确相等 / 相对误差 / 区间）。说不清就不是验收标准，是愿望 —— 回去继续拷问。"
                } else {
                    Add-Warn "$id 没有 checkIntent。阶段 0 应当先写下判据（输入 / 期望输出 / 判等方式），阶段 1 再具化成命令。缺了它，无法判断当前这条 check 是不是忠实地实现了原本的判据。"
                }
            } else {
                $badTok = $null
                foreach ($tk in $techTokens) {
                    if ($intent.IndexOf($tk, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $badTok = $tk.Trim(); break }
                }
                if ($null -ne $badTok) {
                    Add-Err "$id 的 checkIntent 里出现了技术栈名词「$badTok」。**业务梳理只讨论业务** —— 技术选型是阶段 1 的事，阶段 1 还要派 2~3 个 agent 独立出方案再仲裁。在阶段 0 写下工具名，等于开会之前就把结论写在纸上。把它改写成与语言无关的判据：输入是什么、期望输出是什么、用什么判等。"
                }
            }

            # 阶段 0 不要求 check —— 具体命令是阶段 1 技术选定之后的产物。
            if ([string]::IsNullOrWhiteSpace($s.check)) {
                if ($Stage -ne 'spec') {
                    Add-Err "$id judge=machine 但没有 check 命令。阶段 1 必须把 checkIntent 具化成选定技术栈的可执行命令，否则 L1/L3 无从判定。"
                }
            } else {
                # 【#11b】check 必须能区分是哪条 AC 挂了。
                # 实跑教训：AC-1/2/3 的 check 全是同一条 `node --test`。命令挂了你不知道
                # 是哪条 AC 挂的 —— 这个 check 只证明「实现者自己的测试套件过了」，
                # 不证明「这条 AC 成立」。要收窄到具体用例（如 `node --test -t AC-3`）。
                # 【审计发现】带过滤条件的 check 必须走 check-ac.ps1 守卫。
                # 原因：node --test --test-name-pattern / jest -t 等在「匹配不到任何用例」时
                # 也返回 0 —— 这条 AC 的测试根本没写，check 照样绿，门被骗过。
                # 守卫要求「退出码 0」且「输出里确实出现了指定串」两个条件同时成立。
                $filterFlags = @('--test-name-pattern', '-t ', '--grep', '-k ', '--filter', '-run ')
                $usesFilter = $false
                foreach ($ff in $filterFlags) {
                    if ($s.check.IndexOf($ff, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $usesFilter = $true }
                }
                if ($usesFilter -and $s.check -notmatch 'check-ac\.ps1') {
                    Add-Err "$id 的 check 带了用例过滤条件，但没走 check-ac.ps1 守卫。过滤匹配不到任何用例时运行器也返回 0 —— 这条 AC 的测试没写时 check 照样绿。改成: powershell -ExecutionPolicy Bypass -File .workflow/bin/check-ac.ps1 -Cmd `"<原命令>`" -MustMatch `"<本 AC 的测试名>`""
                }

                # 【L3 实测发现】check 里禁止出现嵌套转义引号 \" —— 它不可移植。
                # 同一个 check 字符串，bash 下 PASS，PowerShell 下 FAIL：
                #   写的是   -Cmd "node --test --test-name-pattern \"screener AC-1\"" -MustMatch "screener AC-1"
                #   PS 收到  -Cmd 'node --test --test-name-pattern " screener AC-1\ -MustMatch screener'
                # 反斜杠被吃掉后引号错配，连 -MustMatch 参数本身都被吞进 -Cmd。
                # 结果是**假 FAIL**：实现明明是对的，执行者却拿到一个失败结论。
                # 反过来也可能构造出假 PASS —— 取决于错配后剩下什么。
                #
                # 正解：用 `--flag=value` 形式 + 正则 \s 代替空格，把嵌套引号彻底消掉：
                #   -Cmd "node --test --test-name-pattern=screener\sAC-1" -MustMatch "screener AC-1"
                # 只剩一层引号，bash 和 PowerShell 解析结果一致。
                if ($s.check.IndexOf('\"') -ge 0) {
                    Add-Err "$id 的 check 含嵌套转义引号 \`" —— 不可移植，bash 下过、PowerShell 下会因引号错配得到假 FAIL。改用 --flag=value 形式，空格用正则 \s 代替，例如: -Cmd `"node --test --test-name-pattern=<feature>\s$id`" -MustMatch `"<feature> $id`""
                }

                $key = $s.check.Trim()
                if ($machineChecks.ContainsKey($key)) {
                    Add-Err "$id 的 check 与 $($machineChecks[$key]) 完全相同（`"$key`"）。同一条命令无法区分是哪条 AC 失败 —— 收窄到只跑这条 AC 对应的用例。"
                } else {
                    $machineChecks[$key] = $id
                }
            }
        } else {
            # 【#11】agent 判定的场景必须声明「用什么对外接口去观察」。
            # 实跑教训：有一条 AC 要求验「某个总数没有增加」，而服务按范围声明不做统计接口，
            # 这个数字在对外接口层根本观测不到 —— 该 AC 从写下来那刻起就只能靠白盒验证，
            # 而校验脚本当时放行了它。
            # 逼作者写出观察通道 —— 写不出来，说明这条不该是 agent 判定。
            if ([string]::IsNullOrWhiteSpace($s.observe)) {
                Add-Err "$id judge=agent 但没有 observe。必须写清楚用产品对外暴露的哪个接口去观察（HTTP 端点 / 页面 / CLI 命令 / 落盘文件）。写不出来说明这条黑盒不可验证，应改成 machine 或重新设计。"
            }

            # 【A16】agent 判定的场景必须声明「在什么条件下比对才算数」。
            # 实跑教训：一条 AC 要求把命令行数值与某看盘工具的读数比对，但没写明用哪种合约类型的图表。
            # 同一标的的现货与永续是两条独立行情序列，验收者若打开了错的那条，读数必然对不上，
            # 于是判「算法口径不一致」—— 它确实照着 when 做了、确实对照 then 判了，
            # 报告形式上无懈可击，结论却完全错误。
            # 隔离机制拦不住这种错：它防的是「偷看答案」，不是「前提缺失」。
            # 派发方当时是在 prompt 里口头补的这个前提 —— 口头补的前提不是前提，是运气。
            if ([string]::IsNullOrWhiteSpace($s.preconditions)) {
                Add-Err "$id judge=agent 但没有 preconditions。必须写清楚「在什么条件下比对才算数」—— 那些不满足就会让整条判定失效、但 given/when/then 里没地方写的前提（对照的是哪个数据源/环境/版本、服务跑在哪、外部工具的哪个具体配置）。缺了它，验收者会产出一份形式无懈可击、结论完全错误的报告。"
            }

            $ev = AsList $s.evidence
            if ($ev.Count -eq 0) {
                Add-Err "$id judge=agent 但 evidence 为空。拿不出证据的通过不算通过。"
            } else {
                $allowed = @('screenshot', 'recording', 'http-trace', 'log', 'file-content')
                foreach ($e in $ev) {
                    if ($allowed -notcontains $e) { Add-Err "$id 的 evidence '$e' 不在允许值内: $($allowed -join ', ')" }
                }
            }
            # 防 overfit: agent 场景的 then 不该出现实现细节
            if ($s.then -match '[A-Za-z_][A-Za-z0-9_]*\.(ts|tsx|js|jsx|py|go|rs|java|cs)\b') {
                Add-Err "$id judge=agent，但 then 里出现了文件名。用用户能观察到的现象来写，否则 wf-eval 会 overfit 到实现上。"
            }
            if ($s.then -match '\b(function|返回值|调用|handler|Handler)\b') {
                Add-Warn "$id 的 then 疑似含实现细节，检查一下是不是能改写成用户可观察的描述"
            }
        }
    }
}

# ---------- tasks.json ----------
if ($Stage -eq 'plan') {
    $tk = $null
    if (-not (Test-Path $taskPath)) {
        Add-Err "缺少 tasks.json"
    } else {
        try {
            $tk = Get-Content $taskPath -Raw -Encoding UTF8 | ConvertFrom-Json
        } catch {
            Add-Err "tasks.json 不是合法 JSON: $($_.Exception.Message)"
        }
    }

    if (-not (Test-Path (Join-Path $dir 'design.md'))) { Add-Err "缺少 design.md" }

    if ($null -ne $tk) {
        $tasks = AsList $tk.tasks
        if ($tasks.Count -eq 0) { Add-Err "tasks.json 没有任何 task" }

        $byId       = @{}
        $covered    = @{}
        $mutCovered = @{}

        foreach ($t in $tasks) {
            $id = $t.id
            if ([string]::IsNullOrWhiteSpace($id)) { Add-Err "有 task 缺少 id"; continue }
            if ($byId.ContainsKey($id)) { Add-Err "task $id 重复" }
            $byId[$id] = $t

            if ($null -eq $t.layer -or [int]$t.layer -lt 1) { Add-Err "$id 的 layer 必须是 >=1 的整数" }
            if ((AsList $t.files).Count -eq 0) { Add-Err "$id 的 files 为空" }
            if ((AsList $t.steps).Count -eq 0) { Add-Err "$id 的 steps 为空" }
            if ([string]::IsNullOrWhiteSpace($t.verify)) { Add-Err "$id 缺少 verify 命令" }
            if ((AsList $t.covers).Count -eq 0) { Add-Err "$id 的 covers 为空，说明它不对任何验收标准负责" }

            $hasMut = (AsList $t.mutationTargets).Count -gt 0
            foreach ($c in (AsList $t.covers)) {
                $covered[$c] = $true
                if ($hasMut) { $mutCovered[$c] = $id }
                if ($acIds -notcontains $c) { Add-Err "$id 的 covers 引用了不存在的 $c" }
            }

            # 【A13-①】任务书里出现「实测得到的期望值」——
            # 编排者把自己跑出来的数字直接写进任务书，Builder 就不是算出来的，是抄回来的。
            # 下游任何 agent 的「独立验证」都被诱导了：它验的是「有没有抄对」，
            # 不是「这个数字对不对」。而这类值往往还会漂（标的数量、市场统计），
            # 抄进去之后**没有任何环节会重新测一次**。
            #
            # ⚠️ 这条只能是警告，不能是错误：
            # 分不清「我实测的期望输出」和「设计参数」——
            # `minBars=800` 也是数字，但那是设计决策，本来就该写进任务书。
            # 判据是关键词而非数值本身：`实测`/`期望值`/`跑出来` 这类词，
            # 恰恰是作者自己在标注「这是观察到的结果」。
            #
            # ⛔ 不属于本条的：告诉 Builder 测试命名约定（如「测试名以 <feature> AC-N 开头」）。
            # 那是 check 机制的必要输入，不是污染 —— 锚点必须事先约定，否则 check 匹配不到。
            # 「锚点命中不证明正确性」这个弱点由 A11（变异测试）和 A14（多锚点）负责，不在这里。
            $obsMarkers = @('实测', '期望值', '跑出来', '实际得到', '实际测得', 'measured', 'observed value')
            foreach ($step in (AsList $t.steps)) {
                $s = "$step"
                $hit = $null
                foreach ($mk in $obsMarkers) {
                    if ($s.IndexOf($mk, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $hit = $mk; break }
                }
                if ($null -eq $hit) { continue }
                # 同一条 step 里还带具体数值才告警（纯文字说明不算）
                if ($s -notmatch '\d') { continue }
                # 给了推导式的放行：能自己复算就不算「抄答案」
                # 给了推导依据的放行：能自己复算就不算「抄答案」。
                # 「代数」两字单独出现就够 —— 实测踩过：「复用同一套代数期望值」被误报，
                # 因为豁免词写死成了「代数上」。宁可放过几条，也不要让告警变成噪音：
                # 一条会误报的告警，用不了几次就会被习惯性忽略，跟没有一样。
                if ($s -match '代数|推导|公式|定义为|由.{0,8}得出|=\s*P_|IEEE|浮点') { continue }
                $short = if ($s.Length -gt 48) { $s.Substring(0, 48) + '…' } else { $s }
                Add-Warn "$id 的 steps 里有一条带「$hit」+ 具体数值：「$short」。这类值是编排者跑出来的，Builder 只会抄不会算，下游的『独立验证』因此是被诱导的。要么补上推导依据（能复算就不算抄），要么把它移出任务书 —— 期望值属于 acceptance.json（做成什么样算对），不属于 tasks.json（怎么做）。"
            }
        }

        # 依赖检查
        foreach ($t in $tasks) {
            $layer = [int]$t.layer
            $deps  = AsList $t.depends_on
            if ($layer -gt 1 -and $deps.Count -eq 0) {
                Add-Warn "$($t.id) 在 layer $layer 但没有 depends_on，确认它真的依赖上一层"
            }
            foreach ($d in $deps) {
                if (-not $byId.ContainsKey($d)) {
                    Add-Err "$($t.id) 依赖了不存在的 $d"
                } elseif ([int]$byId[$d].layer -ge $layer) {
                    Add-Err "$($t.id) (layer $layer) 依赖 $d (layer $($byId[$d].layer))，依赖必须指向更低的 layer"
                }
            }
        }

        # 同层文件重叠 —— 并行安全的核心
        $layers = @($tasks | ForEach-Object { [int]$_.layer } | Sort-Object -Unique)
        foreach ($L in $layers) {
            $inLayer = @($tasks | Where-Object { [int]$_.layer -eq $L })
            for ($i = 0; $i -lt $inLayer.Count; $i++) {
                for ($j = $i + 1; $j -lt $inLayer.Count; $j++) {
                    $a = $inLayer[$i]; $b = $inLayer[$j]
                    $fa = AsList $a.files | ForEach-Object { $_.Replace('\', '/').ToLower() }
                    $fb = AsList $b.files | ForEach-Object { $_.Replace('\', '/').ToLower() }
                    $dup = AsList ($fa | Where-Object { $fb -contains $_ })
                    if ($dup.Count -gt 0) {
                        Add-Err "layer $L 内 $($a.id) 与 $($b.id) 的 files 重叠: $($dup -join ', ') —— 并行 Builder 会互相覆盖，而这类冲突审查抓不出来"
                    }
                }
            }
        }

        # AC 覆盖
        foreach ($id in $acIds) {
            if (-not $covered.ContainsKey($id)) {
                Add-Err "$id 没有被任何 task 覆盖"
            }
        }

        # 【A11】machine 判定的 AC 必须有变异测试目标。
        #
        # 为什么只卡 machine：judge=machine 的 AC，它的**全部**验证就是「测试通过了」。
        # 测试集不够用，这条 AC 就是空的 —— 而「测试通过」只说明实现与测试一致，
        # 不说明实现是对的。变异测试是唯一直接检验「测试集够不够用」的手段。
        # judge=agent 的 AC 有人真的按场景操作一遍，对测试充分性的依赖低得多，不强制。
        #
        # 实跑证据（一次近乎受控的对比）：同一个仓库、同一轮审查，
        # EMA 模块 6 个变异体全被杀，pipeline 模块 6 个全存活 ——
        # 唯一的差别是 **EMA 那个 task 的任务书里写了变异测试要求，pipeline 那个没写**。
        #
        # ⚠️ 这条规则目前只有一个数据点支撑，尚未在第二个独立项目上复现。
        foreach ($id in $machineAcIds) {
            if ($covered.ContainsKey($id) -and -not $mutCovered.ContainsKey($id)) {
                Add-Err "$id 是 machine 判定，但覆盖它的 task 没有一个声明了 mutationTargets。machine 判定的 AC 全部依赖「测试通过了」这一个信号 —— 测试集不够用时这条 AC 就是空的。在负责实现它的 task 上声明 mutationTargets（要做变异测试的源文件），Builder 必须报告变异体存活数，存活 > 0 不算完成。"
            }
        }

        # 【#3 / #5】gates.json 的语法门是否覆盖了 tasks.json 声明的全部源文件。
        # 实跑教训：gates.json 在 init-workflow 时生成，那时还不知道 wf-plan 会产出哪些文件。
        # 结果语法门只写了 `node --check src/server.js`，其余 6 个模块的语法错误抓不到。
        # tasks.json 一旦存在，这个覆盖关系就变成可机械校验的了。
        $gatesPath = Join-Path $Root '.workflow\gates.json'
        if (-not (Test-Path $gatesPath)) {
            Add-Err "缺少 .workflow/gates.json —— L1 机械门没有配置，无人化流程失去第一道闸"
        } else {
            try {
                $gates = Get-Content $gatesPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $cmds  = (AsList $gates.l1 | ForEach-Object { $_.cmd }) -join ' ; '

                # 【#15】有些检查器天生覆盖全项目，既不点名文件也不用通配：
                #   npx tsc --noEmit（按 tsconfig 的 include 全查）
                #   eslint .（按 eslint.config 全查）/ mypy .（按配置全查）
                # 这类 gate 用 "coversAllSrc": true 显式声明，本检查即跳过。
                # 早期版本会对它们误报「只覆盖 0/N 个源文件」。
                $declaresAll = @(AsList $gates.l1 | Where-Object { $_.coversAllSrc -eq $true }).Count -gt 0

                if ([string]::IsNullOrWhiteSpace($cmds)) {
                    Add-Err "gates.json 的 l1 为空"
                } elseif ($declaresAll) {
                    Write-Verbose "有 gate 声明了 coversAllSrc，跳过文件级覆盖检查"
                } else {
                    # 只看源码文件（tests 由测试门覆盖）
                    $srcFiles = @()
                    foreach ($t in $tasks) {
                        foreach ($f in (AsList $t.files)) {
                            $n = $f.Replace('\', '/')
                            if ($n -notmatch '(^|/)tests?/') { $srcFiles += $n }
                        }
                    }
                    $srcFiles = @($srcFiles | Sort-Object -Unique)

                    # 门里逐字出现的具体文件路径
                    $literal = @($srcFiles | Where-Object { $cmds.Replace('\', '/').Contains($_) })
                    # 是否有通配（for %f in (src\*.js) / **/*.ts / 目录级扫描 等）
                    $hasGlob = ($cmds -match '\*')

                    if (-not $hasGlob -and $literal.Count -lt $srcFiles.Count) {
                        $missing = @($srcFiles | Where-Object { $literal -notcontains $_ })
                        Add-Err ("gates.json 的 L1 只逐字覆盖了 {0}/{1} 个源文件，且没有通配。未覆盖: {2} —— 这些文件的语法/类型错误 L1 抓不到，只能靠测试恰好 import 到它们时才炸出来" -f $literal.Count, $srcFiles.Count, ($missing -join ', '))
                    } elseif (-not $hasGlob -and $srcFiles.Count -gt 1 -and $literal.Count -eq $srcFiles.Count) {
                        Add-Warn "gates.json 逐字列出了全部 $($srcFiles.Count) 个源文件。新增文件时容易漏，建议改成通配"
                    }
                }
            } catch {
                Add-Err "gates.json 不是合法 JSON: $($_.Exception.Message)"
            }
        }
    }
}

# ---------- 输出 ----------
Write-Host ""
Write-Host "=== validate-plan [$Stage] $Feature ===" -ForegroundColor Cyan

if ($warnings.Count -gt 0) {
    Write-Host ""
    foreach ($w in $warnings) { Write-Host "  WARN  $w" -ForegroundColor Yellow }
}

if ($errors.Count -gt 0) {
    Write-Host ""
    foreach ($e in $errors) { Write-Host "  ERR   $e" -ForegroundColor Red }
    Write-Host ""
    Write-Host "=== FAIL ($($errors.Count) 项) —— 修完再往下走，不要手动跳过 ===" -ForegroundColor Red
    Write-Host ""
    exit 1
}

Write-Host ""
if ($Stage -eq 'spec') {
    # 必须 @() 包裹：Where-Object 只匹配到 1 条时返回标量而非数组，PS 5.1 下 .Count 为 $null
    $m = @(AsList $ac.scenarios | Where-Object { $_.judge -eq 'machine' }).Count
    $a = @(AsList $ac.scenarios | Where-Object { $_.judge -eq 'agent' }).Count
    Write-Host "=== PASS —— $($acIds.Count) 条验收标准全部可判定 (machine $m / agent $a) ===" -ForegroundColor Green
} else {
    Write-Host "=== PASS —— DAG 合法、同层无文件冲突、AC 全覆盖 ===" -ForegroundColor Green
}
Write-Host ""
exit 0
