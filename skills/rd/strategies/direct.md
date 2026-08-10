# 策略：direct —— 直接做

> 适用：S 级任务（单文件、范围清晰、预估 < 30 行），或 chore，或用户明确说了"直接做"。
> 预算量级：**~1 万 token**
>
> **中断处理**：不要预估「能不能一口气跑完」—— 中断可以发生在任何时刻，预估必然出错。
> 要求是**进度持续落盘**：派 agent 前写 inflight，拿到结果立刻落盘，不要攒到阶段末尾一次性写。
> 恢复时跑 `scripts/check-artifacts.js`，**以产物为准，不以记忆为准**。
> **产物还要能自证写完**：每个文件的最后一个动作是盖收尾标记 `<!-- RD-DONE ... -->`
> （JSON 产物用 `"_complete": true`）。没有标记的一律按未完成处理 ——
> 「文件在」和「文件写完了」是两回事，中断留下的半截产物在前一个尺度上完全正常。

## 流程

1. 读 `.rd/attention.md`（存在的话）
2. 写代码前先看相邻实现，写得像这个项目原本的代码
3. 改
4. 跑测试层：
   ```
   node <agent-rd>/scripts/gate-test.js
   ```
5. 报告：做了什么、改了哪些文件、测试层输出

## 不做什么

- 不建 `.rd/features/` 目录
- 不写 spec / acceptance / design / tasks
- 不派任何 agent
- 不做审查层、不做验收层

## 硬门槛

- **测试层必须跑，且必须贴真实输出。**这是唯一保留的门，跑都不跑就没有任何保障了。
- **发现范围比预估大**（要动 3 个以上文件、或碰到权限/数据/并发）→
  **停下来，告诉用户要升级策略**，不要硬着头皮用 direct 做完。
- 声称完成前给出与声明相称的证据。"应该可以"不算完成。

## 本策略的加载清单

**会用到**
- `skills/rd/references/out-of-flow.md` — 发生流程外动作时（先问用户三件套）
- `skills/rd/references/strategy-rationale.md` — 用户质疑选型 / 要求降级时

**永不加载**
- `skills/rd-spec/` — 本策略不建 spec / acceptance（S 级零产物）
- `skills/rd-plan/` — 本策略不派方案 agent
- `skills/rd-build/` — 本策略你自己写，不走 Builder / 三层闭环
- `skills/rd-review/` — 本策略没有审查层阶段
- `skills/rd-eval/` — 本策略没有验收层阶段
- `skills/rd-keep/` — 本策略不建 feature 目录，无经验沉淀环节
