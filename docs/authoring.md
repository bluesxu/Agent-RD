# Authoring —— Agent-RD skill 写作准入规则与契约冻结表

> 这是**写作约定**，不是运行期规则。运行期必须生效的规则写在 `skills/*/SKILL.md`。
> 本文档的读者是「往这个仓库加 skill、改 skill、抽 references 的人」——
> 包括人类，也包括被派去改 skill 的 agent。**改 skill 之前先读这里。**

---

## 1. 散文准入规则（抄 CE 四条）

一段内容能留在 SKILL.md 正文里，必须满足三条之一：

1. 说了一个**可证伪的约束**（「写 dispatch.md，六行，最后一行必须是为什么不选次优」）
2. **对抗某个已知默认倾向**（「不许相信 Builder 的 git status 自报」）
3. 提供**会改变决策的领域知识**（「`TeamCreate` 在很多环境根本不存在」）

硬规则：

- 「要认真」「要产出高质量结果」这类话**不许单独存在**。
- **一条本身就站得住的指令，后面不要再贴励志理由。**「为什么必须写」这类说服性文字
  **直接删除**，正文只留「做什么 + 什么算做到了」。
- 同一条指令只在**已经证明会跑偏的那个点**重复，别处不重复。

**怎么判断「这段该不该留下」**：去掉它，运行期 agent 的行为会不会变？不会变 = 搬走或删掉。

## 2. 钩子统一模板（AC-3）

从正文抽走内容时，原地只留钩子，**不许留完整摘要**（load stub）。

```
> 📎 **{什么条件下要读}** → 读 `references/{file}.md`（role={self|forward|human}）
> 不读会：{具体后果}
```

- **条件**：用触发条件，不是内容分类。「存量代码且要并行」✅；「关于并行的细节」❌
- **后果子句**：紧邻下一行，以 `不读会` 或 `不转发会` 开头（**闭集**，lint 只认这两个）。
  必须说出**具体丢失什么判别力**，禁止「否则流程不完整」「否则可能出问题」这类空后果。
  ✅「不读会：默认假设可并行，在必须一起改的文件上留下『项目是坏的』中间态」
  ❌「不读会：流程不完整」
- **role**：`self` = 执行者自己读；`forward` = 整份转发给子 agent，本体不读正文
  （此时后果子句写「不转发会」）。
- **每个 `references/` 文件必须有且只有一个钩子，且必须在本 skill 自己的主文件里。**
  ⛔ **L1 层不许跨 skill 引用**（A skill 的钩子不许指向 B skill 的 references/）——
  否则断链窗口 + 孤儿判定互相误杀。跨 skill 依赖用「跑打印命令」解决，不写文件路径。
- **不许有 `README.md` / `index.md` 当索引**。索引只有一处：SKILL.md 末尾的 References 表。

## 3. 抽取阈值

一段内容满足以下任一条件，**且 ≥ 25 行**，就抽进 `references/`：

| 条件 | 例子 |
|---|---|
| **条件触发** | 降级三档、熔断处置、Blindspot Pass —— 只有命中才读 |
| **流程后段才用** | 仲裁细则、收尾规则 —— 走到那一步才读 |
| **读者不是编排者**（角色轴） | Builder prompt 模板、变异算子表 —— 整份转发给子 agent |

- **一个加载条件一个文件**。不许把多个条件压进一个文件（读任何一条就得整份加载，
  等于没拆）。
- ⛔ **原地不许留完整摘要**。摘要写全了 agent 就不去读原文了。
- 写作理由文字**直接删除，不落盘**。

## 4. 目录与命名约定

```
skills/<skill>/
  SKILL.md                    # 每次都读的骨架：做什么 + 什么算做到了 + 钩子
  references/
    prompts/                  # 角色轴：整份转发给子 agent，编排者只转发不阅读
    <触发条件>.md             # 条件命中才读，平铺不建子目录
```

- 文件名全小写 kebab-case。**文件名 = 触发条件，不是内容分类**
  （`circuit-breaker.md` ✅ / `details.md`、`notes.md` ❌）。
- 只建 `prompts/` 一级子目录。`branches/` 与 `narrative/` 的边界是主观的，
  建了只会产生「这篇放哪」的持续争论，而搬家会改路径、改路径会断钩子。
- 文件名的条件与钩子行的条件**同形**——漏钩才能一眼看出来。

## 5. 搬家纪律（AC-7）

- **硬约束条目一律逐字搬运，不许重写措辞、不许合并、不许「顺手改进」。**
- 硬约束 = 以 ⛔ 开头的行、含「必须 / 不许 / 不得 / 禁止 / 一律 / 硬门槛」的行、
  `## 硬门槛` 与 `## 铁律` 小节内的每一条、表格单元格内的 ⛔。
- 本次改造**零删除**：任何一条现存硬约束，改造后必须能在主文件或该 skill 的 references/ 里
  **原文 grep 到**。有意改写或删除的，必须写进 design.md 的「有意改写的约束」表并说明理由。
- 判定靠 `-SkillLint` 的守恒检查 + `check-artifacts.js -SkillLint` 全量跑。

## 6. 冻结表 —— 契约的权威定义

以下两个围栏块是**唯一真值**。`check-artifacts.js` 里的常量必须与之逐字一致，
`-SelfTest` 会对账（不一致自检红）。**散文侧不许再抄一份枚举**——
只写「权威来源是 `-Sections` 输出，拿不准就跑一下」。复制了就会漂移。

### 6.1 L2 三档行为判定条件名

```
<!-- conditions:start -->
contract-break:blocking
wrong-result-silent:blocking
fabricated-verification:blocking
guard-evasion:blocking
unhandled-failure-path:important
coverage-gap:important
contract-drift:important
performance-risk:important
maintainability-trap:important
testability-gap:important
redundant-logic:nit
misleading-name:nit
stale-doc:nit
<!-- conditions:end -->
```

**为什么是这些名字而不是形容词**：模型无法诚实自查「这严重吗」，但能自查
「这条规则没人实现时会静默产出错误结果吗」。每档绑定行为条件，而不是置信度。

| 条件名 | 档 | 行为判据（模型能诚实自查的） |
|---|---|---|
| `contract-break` | blocking | 改动对外的契约/接口，调用方照新契约写会崩 |
| `wrong-result-silent` | blocking | 正常路径产出错误结果而不报错 |
| `fabricated-verification` | blocking | 测试/验证存在假绿（断言未锚定、被绕过、mock 过度） |
| `guard-evasion` | blocking | 守卫被绕过或降级为形式，该拦的没拦住 |
| `unhandled-failure-path` | important | 一条真实可触达的失败路径没有处理（异常/超时/空值/边界） |
| `coverage-gap` | important | 关键路径缺验证，且缺失会掩盖回归 |
| `contract-drift` | important | 实现与已冻结契约不一致，但当前输入未触发 |
| `performance-risk` | important | 数据集/负载到真实规模时性能退化到不可接受（能指出现实的规模拐点） |
| `maintainability-trap` | important | 结构让后续改动成本非线性上升（god object / 紧耦合 / 穿透层） |
| `testability-gap` | important | 关键行为缺可测接缝，验证只能靠人工/一次性手段 |
| `redundant-logic` | nit | 不改变行为但增加维护负担的重复 |
| `misleading-name` | nit | 命名误导读者 |
| `stale-doc` | nit | 注释/文档与行为不一致，不影响运行 |

**升档规则**：多个审查者提到同一件事可以升一档，**前提是那些审查者真正独立派发**
（同 context 里的多个视角不算多个证人）。

### 6.2 Builder 结构化回执必填字段

```
<!-- receipt-fields:start -->
taskId
filesChanged
verifyCommand
verifyOutput
mutationsSurvived
deviations
<!-- receipt-fields:end -->
```

- 位置：`reports/receipts/{taskId}.json`，顶层 `_complete: true`。
- `verifyOutput` 必须是真实文本——空白或纯占位符判不合格。
- `deviations` 写偏离任务书的地方及原因，没有写「无」。
- 证据补齐模式：回执缺字段或含糊 → 打回补证据，**不许重新实现**；第二次仍不合格 → 判 blocked。

## 7. 新增一个 skill 时的检查清单

1. 建 `skills/<name>/SKILL.md`，frontmatter 三件套 `name` / `description` / `argument-hint`。
2. 按第 1 节准入规则过一遍正文。
3. 凡满足第 3 节阈值的内容 → 抽进 `references/`，原地留钩子。
4. 每个 `references/` 文件在主文件里**有且只有一个**钩子（本 skill 自己）。
5. 7 份 `strategies/*.md` 的「本策略的加载清单」各加一行——**会用到**或**永不加载**二选一，
   不许不写。这是新增 skill 最容易漏的一步，`-SkillLint` 会点名未登记的 skill。
6. `install.js` **不用改**（`copyDir` 递归复制整个 skill 目录）。
7. 跑 `node scripts/check-artifacts.js -SkillLint`，绿了才算加完。
