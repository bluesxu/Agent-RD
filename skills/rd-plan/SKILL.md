---
name: rd-plan
description: 阶段 1 技术选型与方案设计。派多个异构 agent 并行独立出方案，主 agent 仲裁，产出 design.md 和文件级任务 DAG tasks.json。全自动，不需要人工审批。
argument-hint: "[feature slug]"
---

# rd-plan

多 agent 并行论证技术方案，仲裁出一个，然后切成互不冲突的文件级任务 DAG。

**前置**：`.rd/features/{slug}/spec.md` 和 `acceptance.json` 存在且已通过 spec 阶段校验。
不存在就先去 `rd-spec`。

## 第一步：并行论证

派 **2~3 个探索 agent 独立出方案**。硬性要求：

- **不继承主对话历史**（每个 agent 的任务必须自包含，把 `spec.md` 全文、
  **`spec-internal.md` 全文**（若存在）和 `acceptance.json` 放进它的 prompt）。
  理由：继承了你的假设的 agent 不再独立，
  它会去找支持你已有倾向的证据，而不是真的另想一条路。
- **异构优先，但有能力下限**：能指定不同厂商/不同模型就指定 —— 同一个模型出三份方案，
  大概率是同一份方案的三种措辞。
  **但异构必须在 opus 级模型之间做，不许为了「够异构」派低能力模型出方案。**
  理由见下面「模型档位」：方案错了，后面三道门一个都拦不住。
- **每个 agent 必须把方案写进自己的文件**（见下一节「方案必须落盘」）。
- **提示词不许三份完全一样**（见「三份提示词必须有差异」）。
- **同一条消息里全部派出**，然后**立即等待，停止你自己的一切分析、检索和文件操作**，
  直到全部返回。

  > 这条是硬纪律。派了不等，你会先形成自己的结论，三份返回结果只被扫一眼就丢掉 ——
  > 界面上四个 agent 都在工作，信息增量上只有一份。

- 每个 agent 的产出要求：**方案 + 关键取舍 + 它主动排除了哪些路及原因 + 风险**，
  涉及现有代码的结论必须带 `file:line`。

- **单个 agent 超 10 分钟未返回**：视为异常，不要继续盲等。先看它的
  `proposals/plan-{x}.md` 写到哪儿了 —— 有多少落盘的就算多少。
  ⛔ **但「停掉它」是流程外动作（铁律 7 ①），必须先问用户**，
  提问时要写清「不停的话会怎样」（通常是：也能继续等，只是更慢）。
  没得到许可之前不许自行终止，更不许当它不存在直接往下走。

> 📎 **派发前的角度差异化 + planFanout 对账** → 读 `references/fanout-angles.md`
> 不读会：三份提示词写成一模一样 —— 换模型也只是换措辞，仲裁变成挑文笔

## 三份提示词必须有差异 —— 同一份提示词换三个模型，还是同一份方案

**硬性要求：派给每个论证 agent 的提示词不许完全相同。**

但差异只能加在一个地方。分清楚什么变、什么绝对不变：

| | 变不变 | 说明 |
|---|---|---|
| `spec.md` / `spec-internal.md` / `acceptance.json` 全文 | **一字不许变** | 这是规格，是输入，不是变量。三份不一致，三个方案就在回答三个不同的问题，仲裁失去意义 |
| **切入角度**（agent 被要求优先照顾什么） | **必须各不相同** | 差异全部加在这里 |
| 输出格式、必填小节、`file:line` 要求 | 不变 | 否则没法横向比 |

派发 prompt 的具体模板见文末 References 表（role=forward，整份转发）。

## 方案必须落盘 —— 不落盘的方案，中断即归零

**每个论证 agent 在任务书里被指定一个输出文件**：

```
.rd/features/{slug}/proposals/plan-a.md      ← 派给第 1 个 agent
.rd/features/{slug}/proposals/plan-b.md      ← 第 2 个
.rd/features/{slug}/proposals/plan-c.md      ← 第 3 个
```

文件必须含这四个小节，且每节非空（`check-artifacts` 机械校验）：
`## 方案` / `## 关键取舍` / `## 被排除的路` / `## 风险`。
**最后一行盖收尾标记**：

```markdown
<!-- RD-DONE stage=plan artifact=plan-a by={模型/agent 名} at={ISO8601} -->
```

> 📎 **为什么必须落盘（中断即归零的实跑教训）** → 读 `references/rationale.md`（role=human）
> 不读会：无运行期后果

**派发之前**，把这三个文件路径写进 `run.json` 的 `inflight`：

```json
"inflight": {
  "stage": "plan", "round": 1, "startedAt": "{ISO8601}",
  "what": "并行出方案，派了 3 个",
  "agents": [
    { "name": "A", "role": "planner", "task": "plan-a",
      "reportPath": ".rd/features/{slug}/proposals/plan-a.md",
      "dispatchedAt": "{ISO8601}" }
  ]
}
```

这样中断后重进来，`check-artifacts` 能直接对账：inflight 说派了 3 份，
`proposals/` 里只有 2 个文件 → **A 丢了，位置明确**。

**同一时刻还要写一份 `planFanout`** —— 内容和上面的名单一样，但它不会被清掉：

```json
"planFanout": {
  "at": "{ISO8601}",
  "dispatched": [
    { "name": "A", "model": "{opus 级模型标识}", "angle": "优先最小改动",
      "reportPath": ".rd/features/{slug}/proposals/plan-a.md" },
    { "name": "B", "model": "{另一个 opus 级模型}", "angle": "优先长期可维护",
      "reportPath": ".rd/features/{slug}/proposals/plan-b.md" },
    { "name": "C", "model": "{再一个}", "angle": "优先风险最低、可回滚",
      "reportPath": ".rd/features/{slug}/proposals/plan-c.md" }
  ]
}
```

> 📎 **为什么两份看起来一样的名单（inflight vs planFanout）** → 读 `references/rationale.md`（role=human）
> 不读会：无运行期后果

**收齐后立刻把 `inflight` 清成 null**，并把结果落进 `rounds`。
⛔ **`planFanout` 不许清、不许改** —— 改它等于篡改「本该有几份」。

## 仲裁之前先点数 —— 派出去几个，回来几个

**这是硬门槛，不是提醒。**

```bash
node <agent-rd>/scripts/check-artifacts.js -Feature {slug} -Json
```

看 `proposalsComplete` 与 `proposalsLost`。**对不上就不许开始仲裁**，按顺序处理：

1. **先重派一次**。丢失的那一份用同样的任务书重新派，输出到同一个路径。
2. 重派仍然失败，才允许降级用剩下的继续 —— 但必须在 `design.md`
   的「未决风险」里明写：**少了哪一份、为什么少、这次仲裁只基于 N 份**。
3. 不足 2 份完整方案时**不许往下走**。只有一个方案，「被排除的方案」一节写不出来，
   整个并行论证等于走过场。

> 📎 **降级留痕 / 打分复核 / 分歧写进 design** → 读 `references/arbitration.md`
> 不读会：把方案的每一行重读一遍（买的是压缩却当场退光），
> 或在方案不足时悄悄降级而不留痕

## 第二步：仲裁

你（主 agent）逐条对照 `spec.md` 的「关键约束」和 `acceptance.json` 打分裁决。

> 📎 **方案收齐之后** → 读 `references/arbitration.md`
> 不读会：把方案的每一行重读一遍（买的是压缩却当场退光），
> 或在方案不足时悄悄降级而不留痕。打分 / 复核 / 降级留痕的完整规则都在那里

## 第三步：写 design.md

```markdown
# {feature} — 设计

## 选定方案
{一段话说清楚结构，不贴大段代码}

## 技术选型
| 决策点 | 选定 | 备选 | 为什么 |
|---|---|---|---|

## 影响面
- 必须修改：{文件列表}
- 需要验证：{不改但会被影响的}
- 仍需调查：{没查清的，明确写出来}

## 契约变化
{API/schema/事件格式 变或不变，明确写。没有就写"无"}

## 被排除的方案
{每条：方案 + 排除理由。这一节不许为空}

## 未决风险
{没有就写"无"}

<!-- RD-DONE stage=plan artifact=design at={ISO8601} -->
```

**最后一行的 `RD-DONE` 是收尾标记，必须真的写在最后**（见「收尾标记」一节）。
`check-artifacts` 靠它区分「写完的 design.md」和「被中断在半路的 design.md」——
没有它，这份文件一律按未完成处理。

## 第四步：切 tasks.json —— 关键在切分规则

从 `templates/tasks.json` 起手。

**按文件边界切，不按功能切。**

功能是耦合的，文件不是。两个 agent 同时改一个文件，产生的冲突是自动审查抓不出来的
—— 它看到的是一份已经被覆盖过的 diff。所以：

| 规则 | 说明 |
|---|---|
| **同一 layer 内，任意两个 task 的 `files` 必须无交集** | 由 `validate-plan.js` 机械校验，不是靠自觉 |
| **`layer` 表示依赖深度** | layer 1 无依赖，layer N 只能依赖 layer < N |
| **每个 task 必须有 `verify`** | 一条它自己能跑的验证命令（窄，只覆盖它的文件）。测试类 verify 以项目根为 cwd，显式指向 `.rd/features/{slug}/tests/` 下对应文件 |
| **每个 task 必须有 `covers`** | 它负责满足哪几条 AC。所有 AC 必须被至少一个 task 覆盖 |
| **task 粒度**：一个自包含的工作单元，有明确交付物 | 太小 → 协调开销大于收益；太大 → 没有检查点 |

典型分层：layer 1 是底层（model / schema / util / store），layer 2 是上层
（service / route / controller / component），layer 3 是集成与端到端测试。

⛔ **测试文件一律进 `.rd/features/{slug}/tests/`，不许写进项目树。** 项目树里只放产品代码；
   AC 测试（含 `files` 白名单里的测试路径）全部落在 `.rd/features/{slug}/tests/` 下。
   所有 `check` / `verify` 命令以项目根为 cwd 执行，显式指向 `.rd/features/{slug}/tests/...`，
   不许依赖语言默认发现（项目树里没有测试）。`.rd/` 的 git 策略由开发者自定，与本条无关。
   **例外（语言硬约束）**：Go / Rust 的测试只能留在包内（`go test ./...` / `cargo test`
   只发现包内测试），这类语言的测试随产品代码走、留在项目树，视为产品代码的一部分。

## 第五步：把 checkIntent 具化成 check —— 技术定了才做得了这件事

**阶段 0 只写判据，不写命令**（业务梳理只讨论业务）。所以 `acceptance.json` 里
每条 `judge: "machine"` 的场景现在只有 `checkIntent`，没有 `check`。

**技术栈仲裁完之后，回到 `acceptance.json`，逐条把 `checkIntent` 翻译成选定栈的命令。**

```
checkIntent: 对一组写死的输入跑计算，逐个断言四个周期的输出与手工验算值一致
             （相对误差 < 1e-9），并能区分「用均值作初值」和「用首个数据点作初值」

     ↓ 选定 Node 之后

check:       node .rd/bin/check-ac.js
             -Cmd "node --test .rd/features/{slug}/tests/*.test.js --test-name-pattern={slug}\sAC-1"
             -MustMatch "AC-1: 数值精确匹配;;AC-1: 均值初值与首值初值可区分"
```

三条要求：

1. **`checkIntent` 不许动。**它是规格，你写的 `check` 是实现。
   改规格来迁就实现，是这套框架最严重的违规之一。
2. **`checkIntent` 里有几个并列判据，`-MustMatch` 就要有几个锚点**（`;;` 分隔）。
   一个锚点只能回答「有没有用例跑到」，回答不了「每一句是不是都被锁住了」。
3. **翻译不动的，说明阶段 0 那条判据本身有问题** —— 回头找 `rd-spec` 重写，
   不要在这里把它悄悄弱化。

> 📎 **为什么这一步存在（技术选型在论证前就被钉死的实跑教训）** → 读 `references/rationale.md`（role=human）
> 不读会：无运行期后果

**同时检查 `gates.json`**：如果它带着 `_provisional: true`，
说明 `init-rd` 当时在一个空目录上猜的语言（多半猜成了 node）。
按仲裁结果改掉，并删掉那个标记。

## 第六步：校验

```bash
node <agent-rd>/scripts/validate-plan.js -Feature {slug} -Stage plan
```

校验的是机械规则：文件不重叠、依赖不成环、AC 全覆盖、verify 非空。
**不过就改，不许手动跳过。**这道门是无人化的前提 —— 它拦下的是后面自动流程
无论如何都发现不了的那类错误。

通过后写 `run.json`（从模板起手），输出：

```
✅ 阶段 1 完成
   方案扇出：派 {N} 份 / 完整回收 {M} 份{丢失或降级时在这里写明}
   方案：{一句话}   排除 {N} 个备选
   任务：{X} 个，分 {Y} 层（layer1 并行 {a} / layer2 并行 {b} ...）
   AC 覆盖：{M}/{M}
   📍 Next: 调用 rd-build 开始并行实现
```

## 收尾标记 —— 文件存在 ≠ 文件完成

这一阶段产出的每个文件，**最后一个动作**都是盖收尾标记：

| 文件 | 标记 |
|---|---|
| `proposals/plan-{x}.md` | 末行 `<!-- RD-DONE stage=plan artifact=plan-x at={ISO8601} -->` |
| `design.md` | 末行 `<!-- RD-DONE stage=plan artifact=design at={ISO8601} -->` |
| `tasks.json` | 顶层加 `"_complete": true` |

标记写在最后，所以中断发生在任何时刻，都不可能让一个没写完的文件带上它 ——
这是区分「写完了」和「写了一半」唯一不依赖记忆的办法。

⛔ **不许先盖章再写正文。**`check-artifacts` 同时查「有没有标记」和
「必填小节是不是真有内容」，空壳配齐标记照样判未完成。

## 模型档位

**只有动代码的流程可以用 Sonnet 这种级别的模型，其余一律 opus 级。**

本阶段（出方案 + 仲裁 + 切 tasks）**全部属于 opus 级**，没有例外。

> 📎 **为什么方案阶段不能省算力** → 读 `references/rationale.md`（role=human）
> 不读会：无运行期后果

## 硬门槛

- **论证 agent 只许写一个文件：它自己的 `proposals/plan-{x}.md`。**
  除此之外全仓库只读 —— 不许碰源码、不许改 spec/acceptance、不许写 design.md。

  > 这条原本是「论证 agent 不许写文件」。收窄成现在这样，是因为那条规则的本意是
  > **别让论证阶段动到代码**，而不是「别留下产物」；而「不留产物」恰恰制造了
  > 中断即归零。既要只读、又要可恢复，边界就划在「只能写自己那一份方案」。
- **不许派了不等**。
- **不许跳过仲裁前点数**。派出去几份、回来几份完整的，对不上就先重派。
- **不许跳过 validate-plan**。
- **「被排除的方案」一节不许为空**。只出一个方案说明没有真的并行论证。
- **不许用低于 opus 级的模型出方案或仲裁**。
- 论证 agent 深度锁 1 层：**它们不得再派生子 agent**。

## References

| Reference | 加载条件 | 用途 |
|---|---|---|
| `references/fanout-angles.md` | 派方案 agent 之前 | 角度差异化 + 角度示例 + planFanout 对账 |
| `references/prompts/planner.md` | 派发时，role=forward 整份转发 | 方案 agent 自包含任务书模板 |
| `references/arbitration.md` | 方案收齐之后 | 点数 / 降级留痕 / 打分复核 |
| `references/rationale.md` | role=human，运行期永不加载 | 设计理由（落盘 / planFanout / 方案档位） |
