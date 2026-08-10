# 策略：refactor-safe —— 存量改造

> 适用：M 级以上的 refactor，以及任何「主要在修改已有文件」的 L/XL 改动（即使类型是 feature）。
> 预算量级：**~10~20 万 token**
>
> **中断处理**：不要预估「能不能一口气跑完」—— 中断可以发生在任何时刻，预估必然出错。
> 要求是**进度持续落盘**：派 agent 前写 inflight，拿到结果立刻落盘，不要攒到阶段末尾一次性写。
> 恢复时跑 `scripts/check-artifacts.js`，**以产物为准，不以记忆为准**。
> **产物还要能自证写完**：每个文件的最后一个动作是盖收尾标记 `<!-- RD-DONE ... -->`
> （JSON 产物用 `"_complete": true`）。没有标记的一律按未完成处理 ——
> 「文件在」和「文件写完了」是两回事，中断留下的半截产物在前一个尺度上完全正常。

## 阶段

### 0. 精简拷问 [required] —— 重点问边界

重构的需求方通常已经知道要改什么。别问"你想要什么"，问这三件事：

1. **对外行为要不要变？**（多数重构的答案是"不许变"，那就写死成约束）
2. **哪些文件明确不许碰？**
3. **现有测试是不是可信的基线？**有多少条、是不是全绿？

产出 `spec.md` + `acceptance.json`。**验收标准里必须有一条是"既有测试全部保持绿色"。**

### 1. 行为基线快照 [required]

**改之前**，把要保证"不变"的对外行为采一份基线：

- HTTP 服务：把关键响应的**原始字节**（状态行 + 头 + body）存下来
- CLI：把关键命令的 stdout/stderr 与退出码存下来
- 库：把公开 API 的签名列出来

**改完后逐字节 diff（只忽略时间戳一类必然变化的字段）。**
**"逐字节不变"要分清是响应字节不变，还是所有可观察行为都不变。**

### 2. 切分判断 [required] —— 这一步不许跳

派 **1~3 个 agent 出方案**，并在 prompt 里**明确给出"说切不开"的许可**：

> "如果你认为这些文件无法切成互不重叠的并行任务，请明确说出来并解释为什么。"

然后按结论走：

| 结论 | 做法 |
|---|---|
| 能切开，且**每个 task 单独落地后仓库仍自洽** | 正常并行 |
| 能切开但**有集成顺序依赖** | 串行核心任务 + 并行下游任务 |
| **切不开** | 全部串行，一个 agent 顺序做完 |

**默认走串行。**只有当方案明确论证了并行安全，才并行。

写 `tasks.json` 时，串行核心放 layer 1 且**只有一个 task**，下游新增文件放 layer 2 并行。

### 3. 实现

按上一步的结论执行。串行核心完成时，**既有测试必须重新全绿**才能往下走。

### 4. L1 → L2 → L3 [required]

三道门全开，但**方向是回归导向**：

- **L1**：既有测试必须仍然全绿，一条都不许少
- **L2**：reviewer 的首要任务是**找行为漂移**，不是找代码风格
- **L3**：拿**改前的基线**去比对，而不是只看新写的断言

### 5. 沉淀

调 `rd-keep`。重构常常会产出"某某机制其实不承重"这类高价值 lesson。

## 硬门槛

- **不许在没采基线的情况下开工。**改完才想起来对比就晚了。
- **不许假设可以并行。**必须有一份方案明确论证过。
- **不许修改既有断言来迁就新结构。**测试红了就是改坏了，不是测试过时了。
- **不许顺手做范围外的清理。**混进来的无关改动会让复审分不清哪些是结构性改动。

## 本策略的加载清单

**会用到**
- `skills/rd-spec/references/interview-probes.md` — 精简拷问（边界三问）也要先诊断开场白
- `skills/rd-spec/references/confirmation-gate.md` — 写 spec.md 前确认门（边界三问产出 spec）
- `skills/rd-plan/references/fanout-angles.md` — 切分判断的方案 agent 角度差异化
- `skills/rd-plan/references/arbitration.md` — 切分判断收齐后点数与仲裁
- `skills/rd-plan/references/prompts/planner.md` — 派切分判断 agent（role=forward）
- `skills/rd-build/references/prompts/builder.md` — 派发 Builder（role=forward）
- `skills/rd-build/references/receipt-audit.md` — 收到 Builder 回执时
- `skills/rd-build/references/degrade-and-breaker.md` — 载体降级 / 熔断 / 外部中断时
- `skills/rd-build/references/orch-selfcheck.md` — 编排者宣布核对结论前（基线快照核对尤其要读）
- `skills/rd-review/references/severity-rubric.md` — L2 定级时
- `skills/rd-review/references/mutation-followup.md` — mutationTargets 非空时
- `skills/rd-eval/references/edge-outcomes.md` — 出现 skipped / blocked 判定时
- `skills/rd-keep/references/lesson-lifecycle.md` — 收尾写/复用 lesson 时
- `skills/rd/references/out-of-flow.md` — 流程外动作时

**永不加载**
- 无整 skill 永不加载 —— 本策略走精简拷问→切分→实现→L1+L2+L3（回归导向），
  大部分 skill 的 references 都可能用到。`blindspot-map.md` 是**条件加载**（命中「用户评估不了」
  才读），不是永不加载，所以不列入本栏。
