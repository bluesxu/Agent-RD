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
            if ([string]::IsNullOrWhiteSpace($s.check)) {
                Add-Err "$id judge=machine 但没有 check 命令。判定不了的不是验收标准，是愿望。"
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
                    Add-Err "$id 的 check 带了用例过滤条件，但没走 check-ac.ps1 守卫。过滤匹配不到任何用例时运行器也返回 0 —— 这条 AC 的测试没写时 check 照样绿。改成: powershell -ExecutionPolicy Bypass -File <agentflow>/scripts/check-ac.ps1 -Cmd `"<原命令>`" -MustMatch `"<本 AC 的测试名>`""
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
            # 实跑教训：AC「短链总数没有增加」在 HTTP 层根本观测不到（服务没有统计端点），
            # 这条 AC 从写下来那刻起就只能靠白盒验证，而校验脚本当时放行了它。
            # 逼作者写出观察通道 —— 写不出来，说明这条不该是 agent 判定。
            if ([string]::IsNullOrWhiteSpace($s.observe)) {
                Add-Err "$id judge=agent 但没有 observe。必须写清楚用产品对外暴露的哪个接口去观察（HTTP 端点 / 页面 / CLI 命令 / 落盘文件）。写不出来说明这条黑盒不可验证，应改成 machine 或重新设计。"
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

        $byId    = @{}
        $covered = @{}

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

            foreach ($c in (AsList $t.covers)) {
                $covered[$c] = $true
                if ($acIds -notcontains $c) { Add-Err "$id 的 covers 引用了不存在的 $c" }
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
