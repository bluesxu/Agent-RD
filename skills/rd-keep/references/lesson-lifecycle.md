# lesson 生命周期、read-repair 与分类

> 📎 从 `skills/rd-keep/SKILL.md` 抽出。**加载条件**：写或复用 lesson 时。
> 不读会：写出的 lesson 缺元数据、或把 `validated` 直接写上去 ——
> 知识库烂掉的过程是无声的，没有任何机制会告诉你它已经烂了。

## status 生命周期

| status | 含义 | 怎么变 |
|---|---|---|
| `observed` | 观察到一次，还没被复用验证 | **初始值。新写的 lesson 一律是这个，没有例外。** |
| `validated` | 后续任务真的用上了并且验证成功 | 只在独立的后续任务中确实采用并验证成功时升级，补一次代表性证据 |
| `retired` | 当前仓库事实直接反证，或发现了 canonical owner | 只写原因和替代/反证指针，不删文件 |

> ⛔ **不许出生即 `validated`。**实跑教训：项目一的两条 lesson 的 frontmatter
> 写的都是 `status: validated`，而该项目唯一的后续 feature 从来没被建过 ——
> 不存在任何独立后续任务，`validated` 是被直接写上去的。
>
> 这导致一个更糟的后果：清单里「生命周期从未走过」这个判断，
> 实际情况不是「没人走」，是**有人直接写了终点**，而没有任何东西检查它。
>
> 想写 `validated`，先回答：**是哪个独立的后续任务用上了它？验证证据在哪？**
> 答不出来就是 `observed`。

## read-repair —— 检索到 lesson 时先核实

做一次有界的、最低成本的定向核实
（读现有代码/测试/文档）。核实不了就跳过这条，**不要为了核实 lesson 去跑大范围测试**。

只有 scope 符合、未退役、当前事实成立、并且**真实改变了计划或验证**的条目才算有效命中。
命中时报告：`经验命中：{path}（{status}）；核验：{fact}；影响：{改变了什么}`。

只是相关但没改变行为的，不要制造复用证据。

## 分类目录

lesson 按 frontmatter 的 `category` 归类，共四类：

| category | 收什么 |
|---|---|
| `skill-design` | skill / 流程 / 规则本身的设计经验 |
| `workflow` | 流程执行的踩坑（某阶段怎么跑、哪里会断） |
| `integrations` | 外部工具/服务集成（第三方库、CLI、API 的坑） |
| `conventions` | 仓库约定（依赖方向、错误格式、migration 纪律） |

文件平铺在 `.rd/lessons/`，分类信息在 frontmatter（检索时按 category 过滤）。
命名沿用 `{YYYY-MM-DD}-{slug}.md`。**date 字段是过期机制的抓手**：
攒到一定量后，按 date 从旧到新审查哪条已不成立、哪条该 retired。
