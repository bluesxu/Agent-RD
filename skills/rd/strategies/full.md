# 策略：full —— 全套

> 适用：L/XL 级 feature，或涉及权限/安全/持久化数据/并发语义的任何改动。
> 预算量级：**约 14 万 token / 每条验收标准**。5 条 AC ≈ 70 万。
>
> **中断处理**：不要预估「能不能一口气跑完」—— 中断可以发生在任何时刻，预估必然出错。
> 要求是**进度持续落盘**：派 agent 前写 inflight，拿到结果立刻落盘，不要攒到阶段末尾一次性写。
> 恢复时跑 `scripts/check-artifacts.js`，**以产物为准，不以记忆为准**。
> **产物还要能自证写完**：每个文件的最后一个动作是盖收尾标记 `<!-- RD-DONE ... -->`
> （JSON 产物用 `"_complete": true`）。没有标记的一律按未完成处理 ——
> 「文件在」和「文件写完了」是两回事，中断留下的半截产物在前一个尺度上完全正常。

## 什么时候值得

只有三类：

- 3 层以上联动的复杂新功能
- 跨模块批量改造
- 需要多角度交叉验证的高风险改动

**简单 CRUD 走这条是亏的。**

## 阶段

### 0. 业务梳理 [required] —— 人只在这里出现

调 `rd-spec`。完整六类拷问，产出 `spec.md` + `acceptance.json`。

**硬门槛**：`validate-plan.js -Stage spec` 必须通过。
每条验收标准要么有能跑的命令，要么有说得清的观察通道。写不出来就继续问。

### 1. 方案与选型 [required]

调 `rd-plan`。派 **2~3 个异构 agent 并行独立出方案**，然后仲裁。

- 全部在**同一条消息**里派出，派完**立即等待**，停止你自己的一切读写
- 每个 prompt 自包含，不继承主对话历史
- 单个 agent 超 10 分钟未返回 → 取部分结果，停掉它，记一笔
- 产出 `design.md` + `tasks.json`
- **硬门槛**：`validate-plan.js -Stage plan` 必须通过

**绿地才并行实现；存量代码先确认能不能切**（见 `refactor-safe.md` 的判断方法）。

### 2. 实现 + 三层门 [required]

调 `rd-build`。完整的审查层 → 测试层 → 验收层闭环，最多 3 轮，超限熔断。

**验收层是这条策略相对 guarded 的唯一增量，也是它贵的原因。**
它是唯一能识破「测试全绿但功能是假的」的一层 —— 省掉它就等于把 full 降级成了 guarded。

### 3. 沉淀

调 `rd-keep`。只收能长期复用的，没有就明说无采纳。

## 硬门槛

- **两道 validate-plan 都不许手动跳过**
- **验收层的 evaluator 必须是 fresh agent，且拿不到实现、diff、测试代码**
- **超出预算量级 2 倍时停下来告诉用户**，不要闷头烧完
- 中途发现任务其实是 M 级 → **可以降级到 guarded**，但要说清放弃了验收层、以及那意味着什么

## 本策略的加载清单

**会用到**
- `skills/rd-spec/references/interview-probes.md` — 完整拷问：四透镜诊断 + 组合检查
- `skills/rd-spec/references/confirmation-gate.md` — 写文件前的确认门 + 结算测试
- `skills/rd-spec/references/blindspot-map.md` — 命中「用户评估不了」触发信号时
- `skills/rd-plan/references/fanout-angles.md` — 派 3 方案 agent 前的角度差异化
- `skills/rd-plan/references/arbitration.md` — 方案收齐后的点数与仲裁
- `skills/rd-plan/references/prompts/planner.md` — 派发方案 agent（role=forward）
- `skills/rd-build/references/prompts/builder.md` — 派发 Builder（role=forward）
- `skills/rd-build/references/receipt-audit.md` — 收到 Builder 回执时
- `skills/rd-build/references/degrade-and-breaker.md` — 载体降级 / 熔断 / 外部中断时
- `skills/rd-build/references/orch-selfcheck.md` — 编排者宣布核对结论前
- `skills/rd-review/references/severity-rubric.md` — 审查层定级时
- `skills/rd-review/references/mutation-followup.md` — mutationTargets 非空时
- `skills/rd-eval/references/edge-outcomes.md` — 出现 skipped / blocked 判定时
- `skills/rd-keep/references/lesson-lifecycle.md` — 收尾写/复用 lesson 时
- `skills/rd/references/out-of-flow.md` — 流程外动作时

**永不加载**
- 无整 skill 永不加载 —— 本策略走全流程（拷问→方案→实现→审查层+测试层+验收层），
  所有 skill 的 references 都可能用到。剩下的「条件触发」是条件加载，不是永不加载。
