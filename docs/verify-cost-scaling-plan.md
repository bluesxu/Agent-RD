# 验证强度随风险缩放 —— Agent-RD 改造执行计划

> 目的：消除「低风险任务付高风险价格」的无效消耗。web-ui-v2 实测 6 小时 agent 时间，T7（两行换色）/T9（CSS）这类 leaf 任务也在跑全量测试 + 全量变异，验证成本与风险不成比例。
> 状态：**计划，未执行**。改框架属铁律 7 流程外动作，执行前需用户批准。

## 一、现状与落点（读源码结论）

| 环节 | 现状 | 浪费点 |
|---|---|---|
| task.verify | rd-plan 第四步手写命令字符串，builder 逐条执行 | leaf 任务跑全量测试 |
| mutationTargets | `string[]`，validate-plan 卡 machine AC 下限，builder.md 要求 ≥5 变异体 | leaf 任务也跑 5+ 变异 |
| 分层派发 | rd-build Step 2：「派 layer N 前先读 layer<N 实际签名」 | 串行链，下游等上游实现而非等契约 |
| L3 | rd-build：一个 fresh evaluator 串行跑全部 AC（machine+agent） | machine AC 本可用脚本直接跑；agent AC 串行 |
| 编排者机械环节 | 回执字段审计 / git diff 对白名单 / 读上游签名 / 组装 prompt 全靠手写 | 每层 ~几分钟编排时间，进不了并行 |

## 二、五项改动（按「价值/风险」排序执行）

---

### 改动一：verify 按 blast radius 收窄
**价值：高　风险：中（需 tasks schema 变更 + 覆盖完整性校验）**

**现状**：`tasks.json` 的 `verify` 是手写命令串；builder 照它跑。T7/T9 的 verify 被写成全量 `node --test`，跟它们的改动零关系。

**改法**：
1. `templates/tasks.json`：task 增加 `tests: string[]` 字段 —— 该 task 改动**能影响的测试文件集**（rd-plan 切任务时声明）。
2. `scripts/validate-plan.js`：校验「每个 task 的 `files` 都落在某个 task 的 `tests` 的依赖半径内」，防漏声明（改动文件无测试覆盖 = 报错）。
3. `scripts/gate-l1.js`：保持项目级全量门不变（那是最后防线，且便宜）。
4. `skills/rd-build/references/prompts/builder.md`：verify 从「手写全量」改为「`tests` 字段展开的窄集 + 必要时补显式全量」。leaf 任务（纯前端 CSS/JS 改色）自动收窄为 `node --check` 级。
5. rd-plan 切任务时声明 `tests`：`public/chart.js` → 无（或语法检查）；`src/web/scanner.ts` → scanner+server+persistence 相关测试；`src/types.ts` → 全量（共享类型全局扇出）。

**verify.js 测试**：validate-plan 用例断言「缺 tests 或 files 未被任何 tests 覆盖」→ FAIL。

---

### 改动二：变异测试按风险分级
**价值：高　风险：低（纯新增字段，不动现有行为）**

**现状**：`mutationTargets: string[]`；validate-plan 只要求 machine AC 的覆盖任务非空；builder.md 统一「≥5 变异体」。T1（加 15 行字段）跑 8 个变异体纯属仪式。

**改法**：
1. `templates/tasks.json`：`mutationTargets` 改为 `{ files: string[], depth: 'light' | 'full' }`（或加并列字段 `mutationDepth`）。`light` = leaf/简单任务（1-2 变异体或跳过，跳过在回执注明理由）；`full` = 纯逻辑/交互/并发模块（scanner、market.js 这类，保留 ≥5）。
2. `scripts/validate-plan.js`：machine AC 覆盖任务仍需非空 mutationTargets（下限不变）；`depth` 缺省 = `light`。
3. `skills/rd-build/references/prompts/builder.md`：变异测试段按 `depth` 分支——`light` 造 1-2 个或明说跳过，`full` 保留现在的 5+ 与逐条报告。
4. `skills/rd-build/SKILL.md` Step 1b 的「给编排者」段补充：`full` 的判定依据 =「正确性只有测试能验」的模块（纯计算/并发/状态机），`light` =「错误能被类型/语法/L1 兜住」的薄改动。

**verify.js 测试**：validate-plan 用例断言 depth 取值合法；builder 回执对 light 跳过变异不判 partial。

---

### 改动三：contracts.json 契约先冻结
**价值：最高（砍掉最大串行墙钟）　风险：最高（契约 vs 实现漂移）**

**现状**：rd-build Step 2「派 layer N 前先读 layer<N 实际产出的接口签名」—— 这是串行链的根源。下游任务依赖的是**上游实现完成**，而不是**契约已定义**。

**改法**：
1. rd-plan 产出 `contracts.json`（新模板）：**跨任务接口契约**——类型签名（`buildProjection(tickers): MarketProjectionEntry[]`）、API 形状（`/api/board` 响应行带 `priceChangePercent`）、DOM id/class（`#symbol-dropdown`、`th.sortable`）。与 `tasks.json` 同时冻结，`validate-plan -Stage plan` 校验它存在且覆盖所有跨层依赖。
2. `skills/rd-build/SKILL.md` Step 2 改为：**下游任务依赖「契约已定义」而非「上游 task 已 done」**。派发时把 contracts.json 的对应片段写进 prompt，不再等上游实现。
3. **防漂移（关键）**：契约 ≠ 实现，必须有对账。新增 `scripts/verify-contracts.js`：所有任务完成后，对 contracts.json 声明的签名做机械抽检（grep 实际定义/导出，或类型级断言），不一致 → 报错进 L2。这样「契约先行省时间」和「契约不被实现悄悄破坏」同时成立。
4. 层结构从「实现依赖」变「契约依赖」：5 层串行 → 契约根 + 其余按契约并行。T8（index.html）不再等 T5（server）实现完，只等 contracts.json 里 DOM/白名单契约冻结。

**verify.js 测试**：fixture 里 contracts.json 声明一个假签名，实现不一致 → verify-contracts FAIL。

**风险与缓解**：这是五项里唯一可能引入新 bug 源的（契约先行会掩盖「上游实际实现偏离契约」）。缓解 = verify-contracts.js 机械对账 + L2 审查默认检查「实现 vs contracts.json」。若对账成本大于收益，回退为「契约先行只用于 DOM/API 形状这类静态面，类型签名仍等上游」。

---

### 改动四：L3 并行 + 按变更范围缩 scope
**价值：中　风险：中（evaluator 隔离 + 并发安全）**

**现状**：一个 evaluator 串行跑 8 条 AC（103 min）。machine 4 条是快脚本，agent 4 条是慢浏览器。

**改法**：
1. `skills/rd-build/SKILL.md` L3 段：machine AC **由脚本直接跑**（check-ac 本来就是命令，不需要 LLM evaluator）；LLM evaluator 只负责 agent AC。
2. agent AC 拆给 **2-3 个 evaluator 并行**（同一 server，只读观察者，无冲突）：各自跑自己分到的 AC，证据按 evaluator 分目录。
3. **按变更范围缩 scope**：rd-build 从 `tasks.json` 的 `covers` + git diff 算出「本轮触碰的 AC」；只深验这些。全前端 feature（本轮）全验；纯后端 feature 跳过 agent 浏览器 AC（在报告里显式标「未覆盖原因」）。
4. `check-artifacts.js`：l3 报告命名支持多 evaluator（`l3-round1.md` + `l3-round1-eval2.md`），收尾附录各自写隔离审计。

**verify.js 测试**：check-artifacts 接受多份 l3 报告而不报孤儿。

---

### 改动五：编排者机械环节脚本化
**价值：中（省编排者 ~30-40 min，间接）　风险：低（纯新增脚本）**

**现状**：编排者手工做——回执字段审计、`git diff --name-only` 对白名单、读上游签名、组装 builder prompt。

**改法**（三个新脚本 + 一个复用）：
1. `scripts/audit-receipts.js -Feature {slug}`：逐份回执校验必填字段 + verifyOutput 非占位符 + filesChanged ⊆ tasks.json 白名单。取代编排者手工对账。
2. `scripts/boundary-check.js -Feature {slug}`：`git diff --name-only` + `.rd/features/{slug}/tests/` 磁盘 walk，对比白名单，输出越界清单 + 字节级检查（BOM/裸控制字节）。取代 Step 4 手核。
3. `scripts/assemble-prompt.js`：从 `tasks.json` 的 task + `contracts.json` + builder.md 模板生成自包含 prompt，编排者只补「角度」与「读到的真实签名」。
4. `skills/rd-build/SKILL.md` Step 3/4 引用以上脚本；Step 4b（A18 自核纪律）保留——脚本也算编排者的工具，结论仍要双路复算落盘。

**verify.js 测试**：三个新脚本各造 fixture 断言退出码与检出行为。

---

## 三、执行顺序（依赖优先，每步独立可回滚）

| 阶段 | 改动 | 依赖 | 预计改动量 |
|---|---|---|---|
| P0 | 改动二（变异分级） | 无 | templates + validate-plan + builder.md 各几行 |
| P1 | 改动五（编排脚本） | 无（纯新增脚本） | 3 个新脚本 + SKILL.md 引用 |
| P2 | 改动一（verify 收窄） | P1 的边界脚本可用 | tasks 模板 + validate-plan + builder.md |
| P3 | 改动四（L3 并行/缩 scope） | 无 | rd-build/rd-eval/check-artifacts |
| P4 | 改动三（contracts.json） | P0/P2 的 schema 变更 | 最大：rd-plan + rd-build + 新脚本 |

**P0 先行理由**：最小、独立、立竿见影（立省 leaf 任务 ~30% 时间），先验证「改框架」这条部署路径走通，再动大的。

## 四、部署与回归

1. 改 **D:\System\Downloads\code\.project\Agent-RD**（源仓，remote=github.com/bluesxu/agent-rd）。
2. skills/ 改动 → `node install.js` 同步到 `~/.claude/skills/`（运行时技能源）。
3. scripts/ 改动 → 同步到运行时 home（`C:\Users\blues\.agent-rd\repo\scripts`，本机编排实际调用路径）。
4. 每阶段跑 `node scripts/verify.js`（框架自带 fixture 回归，现有 8 组用例 + 新增）确认不破坏既有脚本契约。
5. ⛔ 改框架 = 铁律 7 流程外动作（`modify-framework`）—— **执行前必须用户批准**，且在 `run.json` 记录 `frameworkDriftAcknowledged`。
6. 每阶段独立 commit（可回滚）；P4（contracts.json）最复杂，若对账脚本成本失控则按「风险与缓解」回退为静态面先行。

## 五、预期收益（对 web-ui-v2 这类 feature）

| 改动 | 省时估计 | 机制 |
|---|---|---|
| 一 + 二（leaf 任务轻门） | ~40 min | 去掉 leaf 任务的全量测试 + 变异 |
| 三（契约并行） | ~40 min 墙钟 | 5 层串行 → 契约根 + 并行 |
| 四（L3 并行/缩 scope） | ~40 min | 单 evaluator 103min → 并行 + machine 脚本化 |
| 五（编排脚本） | ~30 min 编排 | 手工对账 → 脚本 |
| **合计** | **6h → ~3.5h** | 验证成本 ∝ blast radius |

**不能省（诚实）**：`full` 任务的真变异（这次真抓到 AC-3 ② 缺口）、L3 对零机器门前端的那一层、集成任务本身的实现时间。省这三样不是「减少无意义消耗」，是把防线拆了。

## 六、本次 web-ui-v2 的校准输入

- 风险分级依据（改 `rd` 分诊或 `rd-plan` 定档时参考）：数据源已存在、纯增字段且向后兼容 → guarded；破坏既有数据/契约才 full。
- 已记 lessons：`2026-08-10-*` 六条（子串陷阱/语义判据反例/可选字段兼容/惰性补全三件套/前端双导出/字节锁）。

---

## 七、追加：计划之外的优化点（改动六~十二）

> 通读 7 个 skill 主文件 + 关键 references + 5 个核心脚本后补记。
> 五项改动解决的是：leaf 任务过度验证、分层串行、L3 串行、编排者手工。
> 剩下最大的串行墙钟是 **L2 单 reviewer 审全量 diff** 和 **fix 阶段的串行循环**。

### ⚠️ 前置发现：verify.js 基线是红的，开考即失败

计划第四节说「每阶段跑 `node scripts/verify.js` 确认不破坏既有脚本契约」——
但**现在这个基线就是红的**，实测 4 个用例失败，fixture 落后于现行规则：

| 失败用例 | 原因 |
|---|---|
| `生成 .gitignore` | verify.js 还在断言 init-rd 生成 .gitignore，但 commit `914ad49` 已删该逻辑 |
| `产物齐全无孤儿 → exit 0` | fixture 写 `'x\n'` 空壳文件，过不了 check-artifacts 后来加的「空壳判未完成」内容检查 |
| `孤儿证据 → exit 3` | 同上，产物缺失(exit 1)先于孤儿(exit 3)触发 |
| `plan 阶段合规 → exit 0` | fixture 的 T1 `verify: 'echo ok'` 没锚 `-MustMatch`，过不了 validate-plan 的 F3 跨 task 聚合检查 |

**影响**：计划依赖它做每阶段回归护栏，而它开考就是红的。执行任何改动前，
先把 verify.js 的 fixture 与现行规则对账修绿。修 verify.js 属改框架 = 铁律 7，需用户批准。

---

### 改动六：L2 切片并行审查 —— 价值：高　风险：中

**现状**：改动三（contracts.json）落地后所有 task 并行构建，round 1 的 diff 会变成
整个 feature 一次性出现。此时 L2 派「一个 fresh reviewer」读全量 diff ——
这是五项落地后**剩下的最大单点 opus 串行块**。

而且框架自己已预设了多 reviewer：升档规则要求「多个**真正独立派发**的审查者
提到同一件事可以升一档」（rd-review SKILL.md），但 rd-build 从没派过第二个 ——
这条规则至今是空转条件。

**改法**：
1. 对同一份冻结目标，按**契约边界**（contracts.json 的每个跨层契约 = 上游 producer + 下游 consumer）切片。
2. 派 2-3 个 reviewer 并行各审一片，主 agent 合并 findings。
3. 每个 reviewer 仍拿完整 diff + design.md 契约变化，但深读自己分片内的文件。

**收益**：L2 墙钟 ≈ 最慢切片 + 合并（约 1/2~1/3），且 independent witness 让升档规则
第一次真正生效（质量提升是白送的）。

**风险与缓解**：切片丢了跨模块交互视野（那是 L2 强项）。缓解 = 按契约边界切而非按目录切，
切片内保留完整上下游；合并时主 agent 对「契约实现 vs 契约声明」做一次对账
（正好复用改动三的 verify-contracts.js）。

---

### 改动七：fix 阶段并行 —— 价值：中　风险：中

**现状**：`blocking > 0 → fix agent 修 → 回 L1`，一个 fix agent 串行修所有 blocking。

**改法**：blocking findings 按「触及的文件集」分组，**不相交的组各派一个 fix agent 并行修**
（复用 tasks.json 同层不重叠的白名单校验逻辑），修完一次 follow-up 复审。
相交的归同组，避免共享 helper 被并发改出不一致。

**收益**：fix 阶段是 L2 之外第二个串行循环，每轮可能 10-20 分钟。并行修 + 单次复审可砍半。

**风险**：并行 fix 引入交叉不一致。缓解 = 按文件不相交分组是硬前提，相交必归同组。

---

### 改动十：depends_on 粒度派发（改动三的轻量前置）—— 价值：中　风险：低

**现状**：rd-build Step 3「当前 layer 全部 completed → spawn 下一 layer」。
整层等待，一个慢 task 阻塞所有下游 —— 即使 T5 只依赖 T1、而 T2 还卡着，T5 也得干等。

**改法**：改为「某 task 的 `depends_on` 全部 completed 即可 spawn」，不等整层。
validate-plan 已校验依赖指向更低层，机械安全。

**收益**：这是 contracts.json 的 ~30% 版本 —— 不改任何 schema，只改等待粒度，就能重叠出部分并行。
**若改动三判定太险回退为「静态面先行」，这个就是兜底并行。**

---

### 改动九：L3 的服务构建/启动与 L2 重叠 —— 价值：中　风险：低-中

**现状**：rd-build L3 段「你先把服务启动好」发生在 L2 通过之后。
对 build 慢的 web 项目，`npm run build` + 起服务 3-5 分钟是纯串行等待，且每轮都要等。

**改法**：L2 reviewer 派出后（冻结目标已定、reviewer 只读），编排者在 L2 审查期间
并行跑「构建 + 启动服务」。L2 一过即可直接进 L3，零等待。

**关键前提**：构建产物必须 `gitignore` 化 —— freeze 的 `-Verify` 会把「审查期间新增的
范围外文件」判成越界，而 gitignore 掉的文件被 `ls-files --others --exclude-standard` 排除。
**不 gitignore 产物就开跑，会直接把本轮 freeze 弄废。**

---

### 改动八：L1 语法门并行 + 增量 —— 价值：低-中　风险：低

**现状**：语法门逐文件串行 `spawnSync node --check`，注释自述「每个 50-80ms，
几千文件约一两分钟」，且每轮、每次 fix 后全量重跑。

**改法**：
1. **并行 spawn**（concurrency = CPU 核数）。`vm.Script` 快路径被否是正确性问题，
   **并行 spawn 不碰判定逻辑**，零风险。
2. **增量**：第 1 轮全量，后续轮只重查 diff 涉及的文件 —— `node --check` 逐文件独立无状态，
   文件没变不需要重查。复用 freeze 已有的 sha 快照机制。

**收益**：大仓每轮省 ~1 min，乘轮数 + fix 重跑次数。

---

### 改动十一：L1 失败批量修（并入改动八的配套）—— 价值：低

**现状**：gate-l1 默认 early-exit，多个 gate 同时失败时逐个修、逐个重跑 L1。
单 gate 内部已是全量收集，所以只在多 gate 同时挂时浪费循环。

**改法**：失败轮用 `-ContinueOnFailure` 一次收集全部失败项交给 fix agent。价值低，一行改动。

---

### 改动十二：Builder 变异测试并发跑 —— 价值：低

**现状**：builder.md「每造一个变异体就跑一次测试」= 5-8 次全测试串行。
改动二已解决「数量」，这是剩余的单次速度，且是 Sonnet 级 agent 的墙钟，收益有限。

**改法**：变异体并发 spawn 测试。谨慎：full 模块的对抗性变异（Builder 造 + reviewer 重放）是
设计成双份的，削掉就丢对抗 —— 这里只改单次跑的速度，不改数量与双份结构。

---

## 八、追加汇总与执行顺序

| 改动 | 价值 | 风险 | 机制 | 预期省时（web-ui-v2 类） |
|---|---|---|---|---|
| 六 L2 切片并行 | 高 | 中 | opus 串行审全量 → 2-3 片并行 + 独立证人 | ~20-40 min |
| 七 fix 并行 | 中 | 中 | 不相交 blocking 并行修 | ~10-20 min |
| 十 depends_on 粒度派发 | 中 | 低 | 等依赖不等整层 | ~15-30 min（无 contracts 时） |
| 九 L3 准备与 L2 重叠 | 中 | 低-中 | build+start 塞进 L2 审查期 | ~3-5 min/轮 |
| 八 L1 语法门并行+增量 | 低-中 | 低 | 并行 spawn + 只查变化文件 | ~1 min/轮 |
| 十一 / 十二 | 低 | 低 | 批量修 / 变异并发 | 零星 |

**执行顺序建议**：改动十（零 schema 变更、立即可用）→ 改动八（纯脚本）→ 改动九
（需 gitignore 约定）→ 改动七 → 改动六（依赖 contracts.json 落地）。

**前置条件**：先把 verify.js 基线修绿（见「前置发现」），否则第四节的回归护栏不可用。

**不能省（诚实）**：同前 —— `full` 任务的对抗性变异、L2 对真正跨模块交互的深审
（切片只是换并行度，不是换深度）。

**合计**：原五项 6h → ~3.5h；追加六~十二后 3.5h → **~3h**（L2/fix 串行与每轮准备期为主）。

---

## 九、Builder 纯实现改造 —— 测试执行去重（改动十三）

> **用户决策链（2026-08-10 三轮探讨收敛）**：
> 1. 问题本质 = **同一条测试被以同样目的反复执行**，不是「谁写测试」。
> 2. 解法 = **每种判定一次执行、一个归属**；Builder 只写代码，不碰测试。
> 3. 测试作者 = **审查层 reviewer**（审完代码后写全部 AC 测试 + 变异，不是独立测试作者、不是 Builder）。
> 4. 修复 = **回唤 owner Builder**（谁写出的 bug 谁负责，SendMessage 续 session）+ **审查层复审**（以 spec 定责）。
> 5. 原「L1 机械门」概念**不要了**，只保留文档规范校验；语法门下沉到 Builder 自检。
> 状态：**计划，未执行**。改框架 = 铁律 7 流程外动作，执行前需用户批准。
> 本改动**吸收改动一（verify 收窄）与改动二（变异分级）**——Builder 不跑测试/变异时，那两个改动对 build 侧失去意义。

### 〇、命名修订：L1 / L2 / L3 退役

改动十三重构了三层职责与执行顺序，旧编号 **L1 / L2 / L3 与真实流程矛盾**——改造后原 L2（审查）跑在第一位、原 L1（测试执行）跑在第二位，编号和执行顺序对不上；「机械门」「异构审查」的旧语义也全部失效。**统一弃用 L1/L2/L3 编号，改按「执行顺序 + 职责」命名：**

| 新名 | 职责 | 原对应 | 载体 | 执行顺序 |
|---|---|---|---|---|
| **审查层（Review）** | 审代码 → blocking 清零 → 写全部 AC 测试 → 自造变异体验证 → 修复复审仲裁 | 原 L2 | `rd-review`（职责扩展） | **第 1 步** |
| **测试层（Test）** | 机械跑全部测试（-MustMatch 锚点）+ 文档校验，零 LLM | 原 L1 | `gate-l1.js` → `gate-test.js`（改名） | **第 2 步** |
| **验收层（Acceptance）** | agent AC 场景验收（真实行为判定） | 原 L3 | `rd-eval` | **第 3 步** |

- **执行顺序 = 层名顺序**：审查 → 测试 → 验收。不再有「L2 跑在 L1 前面」这种编号矛盾。
- **旧词退役**：「机械门」「异构审查」「L1 机械门」「L2 异构审查」在本改动落地后不再使用。
- **改动一~十二里的 L1/L2/L3**：本改动落地后统一按上表映射理解（那里的 L1 = 测试层，L2 = 审查层，L3 = 验收层）。
- **物理改名**：`gate-l1.js` → `gate-test.js`；`rd-review` / `rd-eval` skill 名保留（与「审查」「验收」对应）。改名属铁律 7，与改动十三同批批准。

### 一、重复在哪（读源码结论）

一条 AC 测试在 web-ui-v2 里实际被执行的次数：

| 环节 | 现在做了什么 | 目的 |
|---|---|---|
| Builder | test-first 跑 1 次 + 变异 ≥5 个各跑 1 次 + verify 跑 1 次 | 判「我自己写对了」 |
| 测试层（原 L1） | 全量项目测试门跑 1 次 | 判「这套测试过不过」 |
| 审查层（原 L2） | 对照组重放 + 自造变异体再跑 | 判「测试够不够」+ 重跑 Builder 跑过的 |
| 验收层（原 L3） | machine AC 又跑 1 次 | 判「这套测试过不过」 |

**「这套测试过不过」这一个问题，Builder + 测试层 + 验收层判了三遍；同一批变异 Builder + 审查层跑了两遍。** 这才是「无意义」。

### 二、新分工：每种判定只跑一次

| 判定 | 归属 | 跑几次 |
|---|---|---|
| 这套测试**过不过**（正确性） | **测试层**（机械、零 LLM、带锚点） | 1 |
| 测试集**够不够用**（充分性，变异） | **审查层**（自造变异体，独立于实现者） | 只审查层这一组 |
| 系统对真实用户**真不真**（行为） | **验收层**（agent AC 观察） | 1 |
| Builder 开发期自测 | 无——Builder 不跑测试 | 0 |

- **Builder**：只写产品代码 + `node --check` / `tsc --noEmit` 自检（替代原 L1 语法门，Sonnet 便宜）。**不写测试、不跑测试、不做变异**。完成门 = 代码写对 + 自检过，过不了不许报 done。
- **审查层**：审代码 → blocking 清零 → **写全部 AC 测试**（checkIntent + 它刚深读的真实接口）→ full 模块自造变异体验证测试集 → 产出「测试 + 变异报告」。
- **测试层**：跑审查层写的全部测试（带 -MustMatch 锚点，唯一官方执行）+ check-artifacts 文档校验（RD-DONE / 必填小节 / 回执字段）。原语法门移除。
- **验收层**：只做 agent AC（真实行为判定）。machine AC 已被测试层覆盖，**不重跑**——每次 fix 后测试层都会重跑，不丢机械判定。

### 三、时序（必须这么排）

```
build        Builder 只写代码 + node --check / tsc --noEmit 自检（Sonnet，便宜）
  ↓
审查层        审代码 → blocking 清零（follow-up 确认）→ 写全部 AC 测试 + 变异
            （时机卡死：blocking 清零之后、freeze 通过之后。写测试发生在 freeze 校验
              通过之后，测试不进本轮审查目标，但进下一轮 freeze）
  ↓
测试层        跑审查层写的全部测试（-MustMatch 锚点，唯一官方执行）+ check-artifacts 文档校验
            ├─ 测试失败 → 回唤 owner Builder 修 → 审查层复审 → 测试层重跑（见第四节）
            └─ 通过 ↓
验收层        agent AC（真实行为判定）—— machine AC 已被测试层覆盖，不重跑
```

### 四、修复闭环：回唤 owner + 审查层复审

**回唤 owner 在新设计里才安全**：Builder 不写测试，测试失败 = 一个与 Builder 无关的外部信号。它没有改测试的能力和动机（审查层写的测试它碰不着），造假风险消失。旧框架用 fresh fix agent（干净上下文防作弊）的前提「Builder 同时是代码+测试作者」已不存在。

**分流规则**（写进 degrade-and-breaker.md）：
| 失败类型 | 处置 |
|---|---|
| 局部失败（漏判空、边界、小 bug） | **回唤失败文件的 owner Builder**（SendMessage 续 session，省重读全代码的 token/time） |
| 方向性失败（审查层 blocking 带 `contract-break` / `wrong-result-silent`） | 换 fresh agent 或熔断——回唤 owner 对新方案没有新视角 |
| 同一处二次失败 | 走现有熔断「同一个 task 失败 2 次 → 换假设」 |

**owner 定位**：按失败文件反查 `run.json` 的 `inflight.agents[].files` 白名单——机械可查，跨任务破坏也能定位对（T5 搞坏了 T1 的文件，owner 是 T1 的 Builder）。

**审查层复审以 spec 定责**（判定标准钉死，防「测试迁就实现」）：
> 以 spec 为准，不以实现为准，不以测试为准。
> - 修复后符合 spec、测试仍红 → **测试错**，审查层改自己的测试（只朝 checkIntent 靠，红线：不许朝实现靠拢；-MustMatch 锚点是 plan 冻结的，改不到锚点以下）。
> - 修复后不符合 spec → **代码错**，owner 再修。
> - 两者都符合 spec 却失败 → 不可能，说明测试断言与 spec 对不上，仍判测试错。

**防「为错误测试扭曲正确代码」**：回唤 owner 的指令里写死——「如果代码看起来正确、但测试期望的是另一回事，**不要改代码让它绿**，把测试失败原文带回来」。否则 owner 最自然的反应是改到绿，而那个测试可能是审查层写错的。

**收敛保护**：修复→复审循环每轮 ≤2 次，超了走熔断。变异只在修复**碰到 mutationTargets（full）文件**时才重跑，没碰不重跑。

### 五、风险与缓解

| 风险 | 缓解 |
|---|---|
| ① 删原「L1 机械门」= opus 撞上「跑不起来」的代码 | 语法门下沉到 **Builder 完成门**（node --check / tsc --noEmit，Sonnet 便宜，过不了不许报 done）。审查层永远看不到非解析代码 |
| ② 谁写谁审的 overfit（审查层审了实现再写测试） | 兜底三道：验收层 agent AC（行为判定，唯一能识破假绿）+ plan 冻结的 -MustMatch 锚点 + 下一轮 fresh 审查层交叉独立（「每轮新 agent」规则）。**如实承认**：本轮内测试修改无独立审查者，这是「审查层写测试」方案的固有代价 |
| ③ 审查层写测试时机 | 卡死：blocking 清零之后、freeze 通过之后；测试进下一轮 freeze |
| ④ 修复质量 | 审查层复审以 spec 定责。**成本如实**：每轮修复 = Sonnet 修 + opus 复审，比「测试层裸重跑」贵，换来修复质量有人管（机械判不了「这个修法是不是 hack」） |
| ⑤ 审查层会话变长（审 + 写测试 + 变异 + 复审） | 10 分钟无进展哨兵照旧；「测试作者」模式可拆给紧跟的独立 agent（计划内保留可选项） |

### 六、触达文件清单

| 文件 | 改什么 |
|---|---|
| `skills/rd-build/references/prompts/builder.md` | 删「测试先行」「变异测试」「完成前必须跑 verify」；完成门改 node --check 自检；回执字段删 `mutationsSurvived`、`verifyOutput` 改 `selfCheckOutput` |
| `skills/rd-build/SKILL.md` | Step 2 变异说明改「变异由审查层做」；派发后**保留 Builder session 直到本轮闭环**（不 shutdown）；加「回唤 owner 修复 + 审查层复审」闭环；freeze 时序；硬门槛更新 |
| `skills/rd-review/SKILL.md` | 加「测试作者」职责段；变异段改「自造对抗性变异」；「只读」硬门槛开窄口（补写 `.rd/features/{slug}/tests/` 除外）；复审以 spec 定责 + 测试修改红线 |
| `skills/rd-review/references/mutation-followup.md` | 不再复核 Builder 报告，改「自造变异体验证测试集」 |
| `scripts/validate-plan.js` | 删 A11（machine AC 必须有 mutationTargets）；删/改 F3（task verify 必须锚 machine AC）—— 两者随 Builder 不再跑测试而失去意义 |
| `templates/tasks.json` | `verify` → `selfCheck`；`mutationTargets` 语义改「审查层必须对这些文件做对抗性变异」；`_mutationRule` 更新 |
| `scripts/check-artifacts.js` | `RECEIPT_FIELDS` 删 `mutationsSurvived`；文档校验保留（RD-DONE / 必填小节 / 回执字段） |
| `skills/rd-build/references/receipt-audit.md` | 删 `mutationsSurvived` 字段对账；回执字段改 `selfCheckOutput` |
| `scripts/gate-l1.js` → **`gate-test.js`** | 职责改：跑审查层写的全部测试 + check-artifacts 文档校验；语法门移除（下沉 Builder） |
| `skills/rd-build/references/degrade-and-breaker.md` | 加「回唤 owner」分流：局部回唤 / 方向性换 fresh / 二次失败熔断 |
| `docs/authoring.md` §6.2 | 回执字段冻结表更新 |
| `scripts/verify.js` | fixture 补/改对应断言 —— 顺带修掉「前置发现」里受影响的红用例 |

### 七、与既有改动的合并

- **吸收改动一**（verify 按 blast radius 收窄）→ Builder 根本不跑 verify，leaf 任务 T7/T9 的「全量测试」从源头消失，比收窄更强。
- **吸收改动二**（变异按风险分级）→ light/full 分级保留，执行者从 Builder 换成审查层（`mutationTargets` 语义重定义）。
- **改动四交互**：验收层 machine AC 不再跑（测试层已覆盖）→ 改动四简化为「agent AC 并行 + 按变更范围缩 scope」。
- **改动八交互**：原 L1 语法门下沉 Builder 后，改动八对测试层（原 L1）的部分失效；Builder 自检天然增量（只查自己的文件）。
- **改动六交互（待设计时明确）**：审查层切片并行审查时，测试作者职责**不切片**（写全部 AC 测试），或按 AC 切片并让相邻切片的审查层交叉复审测试。
- **执行顺序更新**：改动十三排最前（吸收一/二、触达文件最多，改完别人才好动）；原 P0（改动二）与 P2（改动一）标记「被改动十三吸收」。前置条件仍是先把 verify.js 基线修绿。

### 八、预期收益（诚实，含成本）

| 环节 | 变化 | 省 / 花 |
|---|---|---|
| build：leaf 任务（T7 换色 / T9 CSS） | Builder 不再跑全量测试 + 5+ 变异 → 零 | **省 ~30 min**（原改动一/二目标，更强） |
| build：full 任务 | Builder 只写代码 + node --check | 省 ~10-20 min |
| 修复循环 | 回唤 owner 续 session，不再 fresh agent 重读全代码 | **省 token + 墙钟**（fresh 重读全部代码是最大的单次浪费） |
| 验收层 | 不再跑 machine AC | 省若干分钟/轮 |
| 审查层 | 多出「写全部测试 + 变异」opus 时间 | **花**（作者职责，非重复判定，可接受） |
| **合计（叠加八）** | 3h → **~2.5h** | build 侧归零 + 修复不重读代码为主，审查层侧为增量成本 |

**不能省（诚实）**：审查层的真变异（full 模块，这次真抓到过 AC-3 ② 缺口）、验收层 agent AC（唯一能识破假绿）、审查层每轮修复后的复审（机械判不了 hack）。

---
