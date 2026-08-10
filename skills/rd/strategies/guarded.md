# 策略：guarded —— 轻量有护栏

> 适用：M 级 feature、L/XL 级 chore，或被风险修正从 direct 升上来的任务。
> 预算量级：**~10 万 token**
>
> **中断处理**：不要预估「能不能一口气跑完」—— 中断可以发生在任何时刻，预估必然出错。
> 要求是**进度持续落盘**：派 agent 前写 inflight，拿到结果立刻落盘，不要攒到阶段末尾一次性写。
> 恢复时跑 `scripts/check-artifacts.js`，**以产物为准，不以记忆为准**。
> **产物还要能自证写完**：每个文件的最后一个动作是盖收尾标记 `<!-- RD-DONE ... -->`
> （JSON 产物用 `"_complete": true`）。没有标记的一律按未完成处理 ——
> 「文件在」和「文件写完了」是两回事，中断留下的半截产物在前一个尺度上完全正常。

## 和 full 的区别

省掉两件事：**多方案并行论证**、**L3 场景验收**。
保留：精简拷问、L1 机械门、L2 异构审查。

**省 L3 意味着**：如果实现 agent 写出"测试全绿但功能是假的"，这条策略抓不到。
所以 **M 级以上、涉及用户可见行为的功能，宁可升到 full**。

## 阶段

### 1. 精简拷问 [required]

不走 `rd-spec` 的六类全套。只问三件事，一次一个：

1. **失败路径**：输入非法、依赖挂了、超时了，分别怎么办？
2. **不做什么**：明确的排除项。这条最容易漏，也最容易让 agent 越界。
3. **判定方式**：这件事做对了，你怎么知道？

产出**不建目录**，直接在对话里形成共识；但**判定方式必须写成一条能跑的命令或一个可观察的现象**。
写不出来 → 继续问，或升级到 full 走完整的 `acceptance.json`。

### 2. 串行实现 [required]

**你自己写，或派一个 agent 顺序写。不并行。**

写代码前先看相邻实现。项目有测试设施时优先测试先行。

### 3. L1 机械门 [required]

```
node <agent-rd>/scripts/gate-l1.js
```
不过 → 修 → 重跑。**最多 3 次**，仍失败则停下来报告。

### 4. L2 异构审查 [required]

1. `git add -A`，冻结目标：
   ```
   node <agent-rd>/scripts/freeze-target.js -Feature {slug}
   ```
   （没有 feature 目录时可省略 `-Feature`，改用 `git diff` 直接交给 reviewer）
2. 派**一个 fresh reviewer**，异构模型优先（与实现者不同厂商 > 不同模型 > 同构）
3. 它单轮执行 `rd-review`，只读，返回分级 findings
4. **reviewer 返回前你不得改动工作树**
5. blocking > 0 → 修 → **回到 L1 重跑** → 再审（沿用同一 reviewer 的同一 session 做 follow-up）

**最多 2 轮**。超限仍有 blocking → 停下来报告，建议升级到 full 重新设计。

### 5. 收尾

报告：做了什么、改了哪些文件、L1 输出、L2 结论与 findings 处理情况。

有值得长期复用的经验 → 调 `rd-keep`，没有就明说"本次无采纳"。

## 硬门槛

- **不许跳过 L2。**这是 guarded 与 direct 的唯一实质区别。
- **不许在 blocking 未清零时宣称完成。**
- **判定方式写不出来就不许开工。**
- 中途发现涉及权限/安全/持久化数据/并发语义 → **升级到 full**，不要在 guarded 里做完。

## 本策略的加载清单

**会用到**
- `skills/rd-spec/references/interview-probes.md` — 精简拷问也要先诊断开场白缺什么
- `skills/rd-build/references/degrade-and-breaker.md` — 载体降级 / 熔断 / 外部中断时
- `skills/rd-build/references/orch-selfcheck.md` — 编排者宣布核对结论前
- `skills/rd-review/references/severity-rubric.md` — L2 定级时
- `skills/rd-review/references/mutation-followup.md` — mutationTargets 非空时
- `skills/rd-keep/references/lesson-lifecycle.md` — 收尾写/复用 lesson 时
- `skills/rd/references/out-of-flow.md` — 流程外动作时

**永不加载**
- `skills/rd-plan/` — 本策略不做多方案并行论证（和 full 的省点之一）
- `skills/rd-eval/` — 本策略没有 L3 场景验收（和 full 的省点之二）
- `skills/rd-spec/references/confirmation-gate.md` — 精简拷问不建 spec.md，没有确认门环节
- `skills/rd-spec/references/blindspot-map.md` — 精简三问不涉及「评估不了」的用户决策地图
