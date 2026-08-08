# agentflow

**给 Claude Code 的四层自动化开发流水线：业务梳理 → 多 agent 并行开发 → 三层自动审核 → 经验沉淀。**

正常路径上，人只在**第一步**出现。实现、审查、验收全部由 agent 完成。

> 不依赖 tmux、不依赖 WSL、不依赖 codex/gemini CLI。**Windows 原生可跑。**

`Claude Code` · `AI agent workflow` · `multi-agent orchestration` · `自动化验收` ·
`acceptance criteria` · `mutation testing` · `code review automation` · `PowerShell`

---

## 它解决什么问题

**去掉人工审核之后，最难的不是让 agent 写代码，是判断它写完了没有。**

多 agent 流水线的典型失败形态不是「写得差」，而是：

- 测试全绿、review 全过，**但功能是假的** —— agent 为了让测试变绿而加 mock、加 fallback、放宽断言
- 「我做完了」没有任何东西能反驳 —— 验收标准当初就没写成可判定的形式
- 并行改同一个文件产生的冲突，**自动审查看不出来** —— reviewer 拿到的 diff 已经是覆盖后的，它自洽

agentflow 的全部设计围绕一件事：**让「做完了没有」这个问题在开工之前就已经有答案。**

---

## 什么时候用，什么时候别用

| ✅ 适合 | ❌ 不适合 |
|---|---|
| 绿地功能开发，模块边界清晰 | 单文件小改动（用 `direct` 策略，或者根本别用这套） |
| 涉及权限 / 持久化数据 / 并发语义的高危改动 | 探索性原型，需求本身还没想清楚 |
| 需要「事后能证明当初验过什么」的项目 | 追求最低 token 成本的日常任务 |
| Windows 环境（这是它的原生环境） | **非 Windows** —— 验收命令内嵌 `powershell`，见「已知边界」 |

内置**七条策略**按任务难度分诊（`direct` / `guarded` / `full` / `refactor-safe` /
`diagnose` / `research-only` / `review-only`），S 级任务不会被拖进全套流程。

---

## 安装

```powershell
# 1. 看看会做什么（dry-run，不改任何东西）
powershell -ExecutionPolicy Bypass -File install.ps1

# 2. 确认后真正安装，并开启 Agent Teams
powershell -ExecutionPolicy Bypass -File install.ps1 -Apply -EnableAgentTeams

# 3. 到你的项目里初始化
cd D:\your\project
powershell -ExecutionPolicy Bypass -File <agentflow>\scripts\init-workflow.ps1
```

`install.ps1` 默认 dry-run，覆盖已有 skill 会先备份。
`init-workflow.ps1` 是增量的，已存在的文件一律跳过；它会按项目类型挑 L1 门预设、
创建 `.gitignore`、下发守卫脚本，并对配好的门命令做一次冒烟测试。

重启 Claude Code，调用 `/wf`。

---

## 使用

```
/wf 我想做一个支持锁定策略的登录功能
```

```
阶段 0  wf-spec    ← 人在这里，且正常路径上只在这里
        AI 连续拷问（失败路径 / 边界值 / 权限 / 数据兼容 / 不做什么 / 判定方式）
        产出 spec.md + spec-internal.md + acceptance.json
        ⛔ 硬门槛：每条验收标准必须机器可判定，且不许出现技术选型

阶段 1  wf-plan    全自动
        2~3 个异构 agent 并行独立出方案 → 主 agent 仲裁
        把阶段 0 的判据具化成本技术栈的命令
        产出 design.md + tasks.json（文件级 DAG）
        ⛔ validate-plan.ps1 必须通过

阶段 2  wf-build   全自动
        按 layer 并行 spawn Builder → 三层审核闭环
        ⛔ 最多 3 轮，超限熔断

阶段 3  wf-keep    收尾
        筛选值得长期复用的经验 → lessons/
```

### 三层审核闭环

```
L1 机械门     gate-l1.ps1     零 LLM 成本，先跑，早失败早退出
   ↓ pass
L2 异构审查   wf-review       冻结目标 → fresh reviewer → 分级 findings + 变异测试
   ↓ blocking = 0
L3 场景验收   wf-eval         fresh evaluator，拿不到实现和测试，只能真的跑一遍
   ↓ 全部 pass
✅ 完成
```

任一层失败 → 派 fix agent（新 agent，干净上下文）→ **回到 L1 重跑**。

---

## 核心设计

### 1. `acceptance.json` 是整条流水线的燃料

去掉人工审核，等价于要求**验收标准在开工前就已经机器可判定**。

| `judge` | 必须给出 |
|---|---|
| `machine` | 阶段 0 给 `checkIntent`（判据），阶段 1 给 `check`（命令） |
| `agent` | `observe`（用哪个对外接口看）+ `preconditions`（什么条件下比对才算数）+ `evidence` |

**写不出判据、也说不清要什么证据的，不是验收标准，是愿望。**
`validate-plan.ps1` 会机械拦下这类条目。

### 2. L3 是唯一能识破「假绿」的一层

只有 L1 + L2 的话，你会得到一个**测试全绿、review 全过、但功能是假的**交付物。

所以 `wf-eval` 被硬性隔离：**拿不到 diff、拿不到测试代码、拿不到实现过程**，
只拿到自然语言场景和一个跑起来的系统。**它只能真的操作一遍。**

> 核心洞见：**自然语言场景比代码更难被 overfit。**

### 3. 变异测试 —— 唯一直接检验「测试够不够用」的手段

测试通过只说明**实现和测试一致**，不说明实现是对的。

`tasks.json` 的 `mutationTargets` 声明哪些文件必须做变异测试；
Builder 按固定算子表机械造变异体，**存活 > 0 不算完成**；
Reviewer 再重跑上轮变异体作对照，**并自造新的** —— 因为 Builder 用自己的想象力
变异自己的代码，造出来的必然是他的测试已经能杀掉的那些。

### 4. 同层文件不许重叠

两个 Builder 同时改一个文件，产生的冲突**自动审查抓不出来**。
所以 `tasks.json` 按**文件边界**切而不是按功能切，`validate-plan.ps1` 做交集检查。

---

## 机械保障清单

这套东西的主张是「不靠提示词，靠机械拦截」。以下每条都是脚本强制的：

| 拦什么 | 怎么拦 |
|---|---|
| **空过** —— 过滤匹配不到用例时运行器也返回 0 | `check-ac.ps1` 要求退出码 0 **且**输出里出现指定锚点 |
| **单锚点盖不住多子句** | `-MustMatch` 支持多锚点（`;;` 分隔），**全部命中才算通过** |
| **验收标准提前锁死技术栈** | 阶段 0 的 `checkIntent` 里出现技术栈名词直接报错 |
| **判定的隐含前提没地方写** | agent 判定的 AC 强制 `preconditions` 非空 |
| **命令不可移植** | `check` 含嵌套转义引号直接报错（同一命令在 bash 与 PowerShell 下结论会翻转） |
| **审查目标中途被换** | `freeze-target.ps1` SHA-256 冻结 + `-Verify` 检测漂移 |
| **审查目标被依赖目录淹没** | 冻结范围收窄到 `tasks.json` 声明的文件；越界文件单独列出 |
| **被打断后不知道从哪续** | `check-artifacts.ps1` 输出「当前阶段 / 缺什么 / 上次中断在哪」 |
| **中断留下的无主证据** | 点名 `evidence/` 里没被任何报告引用的文件 |
| **该写的记录没写** | `run.json` 的轮次与磁盘产物对账，双向检测 |
| **规则在评判过程中被改** | 框架指纹存进 `run.json`，漂移且无书面说明即失败 |
| **「只有编排者说行」被忽略** | 每次检查打印结论来源统计，自证不计入独立验证 |
| **编排者跳出流程自作主张** | 七类高危动作必须先问用户，落盘裁决，缺记录即失败 |

---

## 实跑数据

> ⚠️ **产物可复核性说明**：下面只列**磁盘上有产物可查**的数字。
> 早期另一个项目（短链服务）的数据曾出现在本文档中，**该项目已被删除，
> 其数字此后永久不可复核**，因此全部移除，不再作为证据引用。

**项目：币安 4h 均线选币 CLI**（7 条验收标准，TypeScript / Node 24）

| 项 | 数字 | 产物 |
|---|---|---|
| 验收标准 | 7 条（machine 5 / agent 2） | `acceptance.json` |
| L1 机械门 | 2 轮，29 → 35 个测试 | `l1-round1.json` / `l1-round2.json` |
| L2 异构审查 | round1 blocking **3** → round2 blocking **0** | `l2-round1.md` / `l2-round2.md` + `.diff` |
| L3 场景验收 | 6 pass / 1 blocked | `l3-round1.md` |
| 经验沉淀 | 3 条 lesson | `lessons/` |
| 真实运行 | 扫描 530 个标的，8 秒完成 | `evidence/ac-6-main-run.log` |

### 三层门各自抓到了什么

| 层 | 抓到 | 为什么别人抓不到 |
|---|---|---|
| **L1** | 配好的门命令本身是坏的 | 8 个 Builder 全没碰到 —— 他们跑的是具体文件路径 |
| **L2** | 冻结机制记录的 hash 与产物字节不符 | 只有真去核对 hash 的人才会发现 |
| **L2（变异测试）** | 一个模块 6 个变异体**全部存活** | 测试全绿，静态审查看不出测试没有判别力 |
| **L3** | 9 条可用性问题，含一个真实业务缺陷 | L1 看语法、L2 看 diff，**结构上都发现不了「能跑但难用」** |

**每一层都抓到了只有它能抓到的东西。**

### 变异测试的对照实验

同一个仓库、同一轮审查：

```
EMA 模块       6 个变异体  →  6 个全部被杀
pipeline 模块  6 个变异体  →  6 个全部存活
```

**唯一的差别：EMA 那个任务书里写了变异测试要求，pipeline 那个没写。**
这是把变异测试接进框架的直接依据。

---

## 人工介入点

| 位置 | 性质 |
|---|---|
| **阶段 0 拷问** | 常规。你是需求的唯一来源，这一步省不掉 |
| **流程外动作**（铁律 7） | 编排者要中止 agent、改框架、跳过门、人工代替判定等，**必须先问你** |
| **wf-keep 的候选报告** | 低成本确认，不回应就按 agent 判断写 |
| **熔断** | 异常路径。正常不触发 |

熔断条件：`ROUND > 3` / L1 连续重试 3 次 / 连续 2 轮 L2 blocking 指纹相同 / 同一 task 失败 2 次。

---

## 已知边界

**诚实列出，不藏。**

- **非 Windows 上流水线无法完成** —— 验收命令内嵌 `powershell -File`。这是结构性限制，不是「可能有问题」。
- **真异构审查尚未实现** —— 设计要求跨厂商模型互审，实际两次实跑都是同厂商跨模型（大号审小号）。
  当前用「同模型 + 不同提示词切入角度」缓解，**这是缓解不是替代**：换提示词换的是搜索顺序，不是知识盲区。
  跨厂商的可行路径已探明，见 [ROADMAP.md](ROADMAP.md)。
- **成本没有对照组** —— 从未有人拿同一需求不用它做一遍再比较。所以「值不值这个代价」目前没有答案。
- **验证来自单一项目** —— 已记录的流程类发现中，绝大多数只有一个数据点。见 [KNOWN-ISSUES.md](KNOWN-ISSUES.md)。
- **纯库项目效果打折** —— 没有「真实入口」，L3 会退化成集成测试。
- **Agent Teams 是实验性功能**，Windows 上只能用 in-process 模式；`TeamCreate` 失败时自动降级为串行，流程不中断。
- **多 agent 并行约 5 倍 token** —— 简单 CRUD 用单 agent 更划算。

> 完整缺陷清单见 **[KNOWN-ISSUES.md](KNOWN-ISSUES.md)**，
> 待完善能力见 **[ROADMAP.md](ROADMAP.md)**，独立审计见 **[AUDIT.md](AUDIT.md)**。
> 这三份文件按「已暴露的缺陷 / 还没建的能力 / 外部视角」分工，**都不做修饰**。

---

## 目录

```
agentflow/
├── README.md
├── KNOWN-ISSUES.md              # 框架级缺陷清单（含撤回与修正记录）
├── ROADMAP.md                   # 待完善能力，每条写清「卡在哪」
├── AUDIT.md                     # 独立审计报告
├── install.ps1                  # 装 skill 到 ~/.claude/skills（默认 dry-run）
├── skills/
│   ├── wf/                      # 入口分诊 + 七条策略
│   ├── wf-spec/                 # 阶段 0 业务梳理
│   ├── wf-plan/                 # 阶段 1 技术选型 + DAG
│   ├── wf-build/                # 阶段 2 并行实现 + 审核闭环
│   ├── wf-review/               # L2 异构审查（叶子，只读）
│   ├── wf-eval/                 # L3 场景验收（叶子，隔离）
│   └── wf-keep/                 # 阶段 3 经验沉淀
├── templates/                   # acceptance / tasks / gates / run / attention
├── examples/lessons/            # 合格 lesson 的写法参照
└── scripts/
    ├── init-workflow.ps1        # 建 .workflow/（增量，含门命令冒烟测试）
    ├── gate-l1.ps1              # L1 机械门
    ├── check-ac.ps1             # 验收命令守卫（防空过 + 多锚点）
    ├── check-artifacts.ps1      # 产物清单校验 + 中断恢复 + 框架指纹
    ├── freeze-target.ps1        # 冻结审查目标 + -Verify 检测漂移
    └── validate-plan.ps1        # 校验 acceptance / tasks 的机械规则
```

项目里生成的运行时结构：

```
.workflow/
├── attention.md              # 每次开工必读，30 行以内
├── gates.json                # L1 命令清单
├── bin/check-ac.ps1          # 随项目下发的守卫，项目自包含
├── lessons/                  # 按关键词检索的经验
└── features/{slug}/
    ├── dispatch.md           ┐
    ├── spec.md               │
    ├── spec-internal.md      │ 全部进 git —— 它们是证据链，不是运行时垃圾
    ├── acceptance.json       │
    ├── design.md             │
    ├── tasks.json            │
    ├── run.json              │
    ├── review-target.json    │
    └── reports/              ┘  L1/L2/L3 报告 + evidence/
```

> ⚠️ **`reports/` 和 `run.json` 应当进 git。**早期版本建议 gitignore 它们，
> 理由是「运行时产物」—— 那个判断是错的：它们是**证据链**。
> 审计对这套框架最重的一条指控就是「L2/L3 报告一份都不存在」，
> 把它们忽略掉等于把那条指控制度化。

---

## 开发约定

`scripts/*.ps1` **必须存成 UTF-8 with BOM**。

Windows PowerShell 5.1 读没有 BOM 的 `.ps1` 时会按系统 ANSI codepage 解码，
中文注释直接变乱码，然后引号配对失败、整个脚本报语法错误。

```powershell
$enc = New-Object System.Text.UTF8Encoding($true)
Get-ChildItem .\scripts -Filter *.ps1 | ForEach-Object {
    $t = [IO.File]::ReadAllText($_.FullName, [Text.Encoding]::UTF8)
    [IO.File]::WriteAllText($_.FullName, $t, $enc)
}
```

**为什么用 JSON 而不是 YAML**：为了让 `validate-plan.ps1` 在
Windows PowerShell 5.1 上**零依赖**跑起来 —— 5.1 没有 `ConvertFrom-Yaml`。
校验脚本能不能跑，直接决定这套流程能不能无人化。

---

## 设计来源

这套东西不是从零设计的，是把几个已验证方案里各自最成熟的那块拼起来。
**理由是：只有编排层的技术在快速变化，另外三层的设计已经收敛了** ——
不同流派的人独立得出了几乎相同的结论（异构审查、目标冻结、轮次熔断、经验筛选）。

| 层 | 来源 | 借鉴了什么 |
|---|---|---|
| **编排** | Claude Code 原生 Agent Teams | 独立上下文的队友 + 共享任务列表；按文件边界分工 |
| **验收** | Spexcode 的 eval 子系统 | agent 像终端用户一样跑自然语言场景并附证据 |
| **审查** | CodeStable + CCG | 异构 reviewer、目标冻结、叶子执行器不派生、轮次熔断 |
| **记忆** | CodeStable 的 attention + lessons | 只沉淀「能长期复用」的；lesson 有生命周期 |
| **纪律** | Codex 子代理实践 | 派发后立即等待；任务自包含；深度锁 1 层 |

---

## 许可证

[PolyForm Noncommercial License 1.0.0](LICENSE)

个人使用、学习、研究、非营利组织使用免费。**任何商业用途需事先获得作者书面许可** ——
包括但不限于纳入商业产品、对外提供付费服务、或在营利性组织内部使用。
商业授权请通过 GitHub issue 联系。
