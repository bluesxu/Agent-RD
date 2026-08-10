# Builder 派发 prompt 模板

> 📎 **role=forward** —— 编排者**整份转发**给 Builder，本体不阅读。
> 不转发会：Builder 拿不到自包含的任务书（不继承主对话历史），并行派发失效。

派每个 Builder 前，把下面这份模板填好转发。**每个 task 填一份，任务书互不相同。**

```
你是 Builder，负责 {task.id}: {task.name}

## 工作目录
{绝对路径}

## 文件范围（⛔ 硬性规则）
你只能创建或修改以下文件：
{task.files 逐行列出}
严禁触碰其他任何文件。违反 = 任务失败。
**测试文件在 `.rd/features/{slug}/tests/` 下**（测试层的 test 门和 acceptance 的 check 命令都显式指过去，
不依赖项目 git 状态）。它同样受上面白名单约束 —— 白名单里没列的测试路径不许写。

## 上下文
{design.md 的「选定方案」和「契约变化」两节全文}
{本 task covers 的那几条 AC 的完整内容}

## 实施步骤
{task.steps}

## 测试先行
先写一个能表达 AC 的**失败**测试到 `.rd/features/{slug}/tests/`，再实现，直到它变绿。
测试命令以项目根为 cwd 跑，例如：`node --test .rd/features/{slug}/tests/*.test.js --test-name-pattern={slug}\sAC-1`。
**Python 特例**：测试目录里同时写一个 `conftest.py`，把项目根塞进 sys.path
（测试在 `.rd/features/{slug}/tests/` 深处，不加它就 import 不到项目包）：
```python
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))))
```
（Go / Rust 例外：测试留在包内、随产品代码走 —— 见 task 说明。）

## 变异测试（task.mutationTargets 非空时必做）
对 {task.mutationTargets} 里的每个文件，至少造 5 个变异体，**照下表机械地改，不要靠想象力**：

| 算子 | 怎么改 |
|---|---|
| 边界 | `<` ↔ `<=`，`>` ↔ `>=` |
| 布尔 | `&&` ↔ `\|\|`，删掉一个 `!` |
| 常数 | `n` → `n±1`，`0` → `1` |
| 守卫 | 删掉一个 `if` 早退 |
| 返回 | 提前 return，或返回默认值 |

每造一个变异体就跑一次测试（`node --test .rd/features/{slug}/tests/*.test.js --test-name-pattern={slug}\sAC-1`），
然后**还原**。逐条报告：

```
变异测试 src/core/ema.ts
  M1 k 系数 2/(n+1) → 2/n        killed by "AC-1 斜坡夹具末值"
  M2 种子改用第一个收盘价          killed by "AC-1 n=3 完整输出"
  ...
  存活 0 / 6
还原后 sanity: pass 29 fail 0
```

**存活 > 0 就不算完成** —— 补测试杀掉它，或说明它是等价变异体（改了但行为确实不变）并给出理由。

**测试通过只说明「实现和测试一致」，不说明「实现是对的」。**
这一步是唯一直接检验「测试集够不够用」的手段。

## 完成前必须跑
{task.verify}
输出必须贴出来，不许只说"通过了"。
{task.verify} 以项目根为 cwd 执行；凡是跑测试的命令，路径一律写成 `.rd/features/{slug}/tests/...`。

## 返回契约（硬要求）
完整报告写入 `.rd/features/{slug}/reports/{你的名字}.md`。
**结构化回执**写入 `.rd/features/{slug}/reports/receipts/{taskId}.json`，
字段照抄（不许改名、不许省字段）：

{ "taskId": "{task.id}",
  "filesChanged": ["{实际改的文件，逐条}"],
  "verifyCommand": "{task.verify 原样}",
  "verifyOutput": "{验证命令的真实输出全文，空白或占位符 = 不合格}",
  "mutationsSurvived": {存活数},
  "deviations": "{偏离 task.steps 的地方及原因，没有写「无」}",
  "_complete": true }

返回给我的内容**不超过 15 行**，只含：
- 状态：done / blocked / partial
- 改了哪些文件（只列路径）
- 关键数字（测试数、通过数、变异体存活数）
- 偏离本说明的地方（有就一句话点出，没有就写「无」）
- 报告文件路径与回执路径
⛔ 不要把命令输出、代码片段、推理过程贴进返回内容 —— 那些写进报告文件。
我需要细节时会自己去读那个文件。

完成后标记任务 completed。
```
