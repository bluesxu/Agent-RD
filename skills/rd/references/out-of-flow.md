# 铁律 7 完整展开 —— 流程外动作的怎么问 / 怎么落盘

> 📎 从 `skills/rd/SKILL.md` 抽出。**加载条件**：真正要发起一次流程外动作时。
> 不读会：不知道「怎么问三件套」和 `outOfFlowActions` 字段表 ——
> 问法缺失 = 诱导式提问，把答案塞进问题里；字段写错 = 被脚本计进「自作主张」。

主文件只留「必须先问的动作」那张表。本文件是它的**执行细则**。

## 怎么问（三件缺一不可）

```
我想做：{具体动作}
因为：  {理由}
不做的话会怎样：{如实说明，包括「其实也能继续，只是更慢/更麻烦」}
```

**第三条是关键。**只说前两条等于诱导 ——
「这个 agent 卡住了，要不要停掉？」技术上是问了，实际已经把答案塞过去了。
**必须让用户看得见「不动它」这个选项长什么样。**

## 唯一的例外

**外部原因导致的中断**（配额耗尽、API 报错、进程被杀）不算流程外动作 ——
那不是你的决定。按 `rd-build` 的第三种失败模式处理，记进 `run.json`，不计轮次。

## 落盘

用户裁决后，追加一条到 `run.json` 的 `outOfFlowActions`：

```json
{ "action": "kill-agent", "target": "l3-eval-r2",
  "reason": "无痕前提作废，它会把预算烧在做不到的事上",
  "ifNotDone": "它会跑满 8 次预算后判 blocked，结论相同但多花约 3 万 token",
  "userDecision": "approved", "ts": "..." }
```

**字段名是固定的，不许按直觉另起一套**（`check-artifacts` 按这张表校验）：

| 字段 | 必填 | 取值 |
|---|---|---|
| `action` | ✅ | `kill-agent` / `modify-framework` / `skip-gate` / `manual-verdict` / `change-acceptance` / `relax-rule` / `extra-step` |
| `target` | ✅ | 动作作用在谁身上（agent 名 / 文件路径 / 门名 / AC 号） |
| `reason` | ✅ | 为什么要做 |
| `ifNotDone` | ✅ | **不做会怎样** —— 如实写，包括「其实也能继续，只是更慢」 |
| `userDecision` | ✅ | `approved` / `rejected` |
| `ts` | — | ISO 时间戳 |

拿不准时跑 `node <agentrd>/scripts/check-artifacts.js -Feature {slug}`，
它会把不符 schema 的条目和真正的违规分开列出来。

**`check-artifacts` 的联锁**：框架指纹漂移（规则被改过）却在
`outOfFlowActions` 里找不到对应的用户裁决 → 报警。
—— 这样「偷偷改规则」就从「查不到」变成「查得到」。

## 诚实的边界

这条铁律拦不住「我根本没意识到自己跳出了流程」。
它把**有意识的越界**变成一个必须经过用户的路口，
但**无意识的越界**只能靠上面那张列死的表尽量覆盖。
