# agentflow

一条四层流水线：**业务梳理 → 多 agent 并行开发 → 三层自动审核 → 经验沉淀**。

人只在第一步出现。实现、审查、验收全部由 agent 完成，正常路径无人介入。

不依赖 tmux、不依赖 WSL、不依赖 codex/gemini CLI。Windows 原生可跑。

---

## 为什么是这四层

这套东西不是从零设计的，是把四个已验证方案里各自最成熟的那块拼起来。
**理由是：只有编排层的技术在快速变化，另外三层的设计已经收敛了**——
不同流派的人独立得出了几乎相同的结论（异构审查、目标冻结、轮次熔断、经验筛选）。

| 层 | 来源 | 抄了什么 |
|---|---|---|
| **编排** | Claude Code 原生 Agent Teams | 独立上下文的队友 + 共享任务列表；按文件边界分工避免并发冲突 |
| **验收** | Spexcode 的 eval 子系统 | agent 像终端用户一样跑自然语言场景并附证据。**核心洞见：自然语言比代码更难 overfit** |
| **审查** | CodeStable + CCG | 异构 reviewer、目标冻结 SHA-256、叶子执行器不派生、blocking 清零、3 轮熔断 |
| **记忆** | CodeStable 的 attention + lessons | 普通任务零产物；只沉淀"能长期复用"的；lesson 有 observed/validated/retired 生命周期 |
| **纪律** | Codex 子代理实践（linux.do 2578075） | 派发后立即等待；`fork_turns=none` 任务自包含；深度锁 1 层；10 分钟超时介入 |

---

## 装

```powershell
# 1. 看看会做什么（dry-run，不改任何东西）
powershell -ExecutionPolicy Bypass -File install.ps1

# 2. 确认后真正安装，并开启 Agent Teams
powershell -ExecutionPolicy Bypass -File install.ps1 -Apply -EnableAgentTeams

# 3. 到你的项目里初始化
cd D:\your\project
powershell -ExecutionPolicy Bypass -File D:\System\Downloads\code\temp\agentflow\scripts\init-workflow.ps1
```

`install.ps1` 默认 dry-run；覆盖已有 skill 会先备份；改 `settings.json` 前也会备份。
`init-workflow.ps1` 是增量的，已存在的文件一律跳过。

重启 Claude Code，调用 `/wf`。

---

## 用

```
/wf 我想做一个支持锁定策略的登录功能
```

`wf` 分诊后转 `wf-spec`，然后一路往下：

```
阶段 0  wf-spec    ← 人在这里，且只在这里
        AI 连续拷问（失败路径/边界值/权限/数据兼容/不做什么/判定方式）
        产出 spec.md + acceptance.json
        ⛔ 硬门槛：每条验收标准必须机器可判定

阶段 1  wf-plan    全自动
        2~3 个异构 agent 并行独立出方案 → 主 agent 仲裁
        产出 design.md + tasks.json（文件级 DAG）
        ⛔ validate-plan.ps1 必须通过

阶段 2  wf-build   全自动
        TeamCreate → 按 layer 并行 spawn Builder → 三层审核闭环
        ⛔ 最多 3 轮，超限熔断

阶段 3  wf-keep    收尾
        筛选值得长期复用的经验 → lessons/
```

### 三层审核闭环

```
L1 机械门     gate-l1.ps1       零 LLM 成本，先跑，早失败早退出
   ↓ pass
L2 异构审查   wf-review         冻结目标 → fresh reviewer（异构模型）→ 分级 findings
   ↓ blocking = 0
L3 场景验收   wf-eval           fresh evaluator，拿不到实现和测试，只能真的跑一遍
   ↓ 全部 pass
✅ 完成
```

任一层失败 → 派 fix agent（新 agent，干净上下文）→ **回到 L1 重跑**，进入下一轮。

---

## 三个关键设计

### 1. acceptance.json 是整条流水线的燃料

去掉人工审核，等价于要求**验收标准在开工前就已经机器可判定**。

每条场景必须有 `judge`：
- `machine` → 必须给 `check`，一条命令，退出码即结论
- `agent` → 必须给 `evidence`，验收 agent 要交回什么证据

**写不出 check 也说不清 evidence 的，不是验收标准，是愿望。**
`validate-plan.ps1 -Stage spec` 会机械拦下这类条目。

站内那些端到端无人化流水线实测完成度只有 50%~80%，失败根因高度一致——
不是 agent 写得差，是**没人能判定它写完了没有**。

### 2. L3 是唯一能识破"假绿"的一层

只有 L1 + L2 的话，你会得到一个**测试全绿、review 全过、但功能是假的**交付物。

agent 极容易 overfit 到固定测试代码：加 mock、加 fallback、放宽断言。
而 L2 的 reviewer 看到测试是绿的，很难判断这份绿是真的。

所以 `wf-eval` 被硬性隔离：**拿不到 diff、拿不到测试代码、拿不到实现过程**，
只拿到 `acceptance.json` 的自然语言场景和一个跑起来的系统。它只能真的操作一遍。

这也是为什么 `judge: "agent"` 的 `then` 必须写成用户能观察到的现象，
不许出现函数名和文件名——`validate-plan.ps1` 会检查这条。

### 3. 同层文件不许重叠

两个 Builder 同时改一个文件，产生的冲突**自动审查抓不出来**——
reviewer 看到的是一份已经被覆盖过的 diff，它是自洽的。

所以 `tasks.json` 按**文件边界**切而不是按功能切，
`validate-plan.ps1` 对同一 layer 内任意两个 task 做文件交集检查。

---

## 人工介入点

| 位置 | 性质 |
|---|---|
| **阶段 0 拷问** | 常规。你是需求的唯一来源，这一步省不掉 |
| **wf-keep 的候选报告** | 低成本确认，不回应就按 agent 判断写 |
| **熔断** | 异常路径。正常不触发 |

熔断条件：

- ROUND > 3
- L1 连续重试 3 次仍失败
- 连续 2 轮 L2 的 blocking findings 指纹相同（原地打转）
- 同一个 task 失败 2 次

熔断时输出完整状态摘要和根因判断，建议回 `wf-plan` 重新设计或缩小范围。

---

## 目录

```
agentflow/
├── README.md
├── install.ps1                  # 装 skill 到 ~/.claude/skills（默认 dry-run）
├── skills/
│   ├── wf/                      # 入口分诊
│   ├── wf-spec/                 # 阶段 0 业务梳理
│   ├── wf-plan/                 # 阶段 1 技术选型 + DAG
│   ├── wf-build/                # 阶段 2 并行实现 + 审核闭环（编排者）
│   ├── wf-review/               # L2 异构审查（叶子，只读）
│   ├── wf-eval/                 # L3 场景验收（叶子，隔离）
│   └── wf-keep/                 # 阶段 3 经验沉淀
├── templates/
│   ├── acceptance.json          # 带完整 schema 说明和正反例
│   ├── tasks.json
│   ├── gates.json               # 含 node/python/go/rust 预设
│   ├── run.json
│   └── attention.md
└── scripts/
    ├── init-workflow.ps1        # 在项目里建 .workflow/（增量，不覆盖）
    ├── gate-l1.ps1              # L1 机械门
    ├── freeze-target.ps1        # 冻结审查目标 + -Verify 检测漂移
    └── validate-plan.ps1        # 校验 acceptance/tasks 的机械规则
```

项目里生成的运行时结构：

```
.workflow/
├── attention.md              # 每次开工必读，30 行以内
├── gates.json                # L1 命令清单
├── lessons/                  # 按关键词检索的经验
└── features/{slug}/
    ├── spec.md               ┐
    ├── acceptance.json       │ 进 git，是项目资产
    ├── design.md             │
    ├── tasks.json            ┘
    ├── run.json              ┐
    ├── review-target.json    │ 建议 gitignore，运行时产物
    └── reports/              ┘
```

---

## 为什么用 JSON 而不是 YAML

`acceptance` 和 `tasks` 用 JSON，是为了让 `validate-plan.ps1` 在
**Windows PowerShell 5.1 上零依赖**跑起来——5.1 没有 `ConvertFrom-Yaml`。

校验脚本能不能跑，直接决定这套流程能不能无人化。为此牺牲一点 YAML 的可读性是值得的。
`spec.md` 和 `design.md` 仍然是 markdown。

---

## 一次完整实跑的数据

在一个零依赖 Node 短链服务上跑通了全流程（5 条 AC / 8 个并行 Builder / 2 轮审核）：

| 项 | 数字 |
|---|---|
| agent 派发 | 14 次 |
| subagent tokens | **约 704k** |
| 折算 | **一条验收标准 ≈ 14 万 token** |
| 交付 | 7 个源文件 / 6 个测试文件 / 50 个测试 |
| 结果 | L2 blocking 清零，**L3 5/5 通过**，熔断未触发 |

**软约束的实际遵守度**（这是最想要的那组数字）：

| 约束 | 遵守 |
|---|---|
| 文件白名单 | 9/9 ✅ |
| 不创建子 agent | 14/14 ✅ |
| 贴真实命令输出 | 14/14 ✅ |
| 不改断言迁就实现 | ✅（reviewer 独立确认全仓无 skip/mock/放宽） |
| 主动披露偏离 | ✅ 5 次 |
| 同一消息派出 | ❌ **编排者自己违反了** |

遵守度远好于预期 —— 唯一的违反者是持有规则原文的那个。
**所以能机械化的一律机械化，别指望提示词。**

### 三层门各自抓到了什么（别人抓不到的）

| 层 | 抓到 |
|---|---|
| L1 | `node --test tests/` 在 Node 24 下是坏的 —— 8 个 Builder 全没碰到（他们跑的是具体文件） |
| L2 | 非 ASCII URL 提交成功但跳转必 500；413 分支实际不可达（客户端拿到的是 ECONNRESET） |
| 编排者字节核对 | 源文件注释里的裸 NUL/DEL —— **三层门全漏** |
| L3 | 一条 AC 在黑盒层面根本不可观测；7 条前两层结构上发现不了的可用性问题 |

**每一层都抓到了只有它能抓到的东西。**

### 三个反直觉的教训

1. **自报不是证据。**一个 Builder 正确诊断并修好了某个 bug，然后在解释修复的注释里
   原样重演了同一个 bug，并声明"没有重犯风险"。四道防线全漏。
2. **覆盖面缺口 ≠ 断言造假。**测试没有 mock、没有 skip、没有放宽断言 ——
   问题是它精确覆盖了 5 条 AC，然后停在了作者自己写的那些分支门口。后者更隐蔽。
3. **边界约束不消除压力，只改变去向。**修复 agent 面对"要暴露内部实例但无权改那个文件"
   的冲突时没有越界，而是把变通挤进了它有权改的文件里。白名单守住，设计气味转移。

## 改脚本时注意

`scripts/*.ps1` **必须存成 UTF-8 with BOM**。

Windows PowerShell 5.1 读没有 BOM 的 `.ps1` 时会按系统 ANSI codepage 解码，
中文注释和字符串直接变乱码，然后引号配对失败、整个脚本报语法错误
（`Unexpected token` / `The hash literal was incomplete`）。

用 VS Code 改的话，右下角编码选 **UTF-8 with BOM**。命令行修复：

```powershell
$enc = New-Object System.Text.UTF8Encoding($true)
Get-ChildItem .\scripts -Filter *.ps1 | ForEach-Object {
    $t = [IO.File]::ReadAllText($_.FullName, [Text.Encoding]::UTF8)
    [IO.File]::WriteAllText($_.FullName, $t, $enc)
}
```

（`.md` 和 `.json` 不受影响，无 BOM 即可。）

## 已知边界

- **Agent Teams 是实验性功能**，且 Windows 上只能用 in-process 模式
  （主终端 `Shift+↑/↓` 切队友）。split panes 要 tmux/iTerm2。
  `TeamCreate` 失败时 `wf-build` 会自动降级为串行实现，流程不中断。
- **5 人团队约 5 倍 token**。收益明显的场景才值得开：3 层以上联动的复杂功能、
  跨模块批量重构。简单 CRUD 用单 agent 更划算。
- **异构 reviewer 需要你的环境里有第二个模型可用**。只有一个模型时会回退到同构，
  `wf-build` 会在报告里标出来——同模型自审的效力明显更弱，这是已知妥协。
- **L3 需要系统能被跑起来**。纯库项目没有"真实入口"，这类项目 `judge: "agent"`
  的场景会退化成集成测试，防 overfit 的效果会打折。

## 许可证

本项目采用 [PolyForm Noncommercial License 1.0.0](LICENSE)。

个人使用、学习、研究、非营利组织使用免费。**任何商业用途需事先获得作者书面许可**——
包括但不限于将其纳入商业产品、对外提供付费服务、或在营利性组织内部使用。
商业授权请通过 GitHub issue 联系。
