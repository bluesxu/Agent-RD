# 回执审计（O-5）与证据补齐模式

> 📎 从 `skills/rd-build/SKILL.md` 抽出。**加载条件**：收到 Builder 的回执时。
> 不读会：Builder 说「跑过了 verify」就信了 ——
> 没有字段对账，回执自述是否可信完全无法机械判。

## 回执是什么

Builder 完成前必须把结构化回执写入 `.rd/features/{slug}/reports/receipts/{taskId}.json`。
必填字段与字段语义见 `docs/authoring.md` §6.2 的冻结表（权威源是脚本，拿不准跑
`node <agentrd>/scripts/check-artifacts.js -Sections`）。

**存在的回执逐份校验字段**（缺字段 / 空白 / 占位符都点名），失败信息必须指出问题字段名。
**缺失的回执不设「必须每 task 都有」硬门**（那会把存量 feature 全判成未完成）——
对账走 `run.json` 的 `inflight.agents[].receiptPath`：**登记过、磁盘上找不到 = 这一份丢了**。

## 证据补齐模式 —— 第一次不合格，打回补证据，不许重做

回执缺字段或含糊到看不出验证结果 → **再叫 Builder 一次进「证据补齐模式」**：

- **不许重新实现**。只许回去补证据。
- 第二次还说不清 → **判 blocked**，不许往下走。

## filesChanged 对账（编排者做，不是脚本）

脚本只管「字段在不在、空不空」。`filesChanged` 与 `task.files` 白名单的**集合对账**
由编排者在 Step 4 边界核对里做（`git diff --name-only` 比白名单）。
回执自报是线索，不是证据 —— 以字节流核对为准。
