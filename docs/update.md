# Agent-RD — 升级指南

## 给用户看

把下面这句话复制给你的 AI Agent，它会全程代办：

```
帮我升级 Agent-RD：https://raw.githubusercontent.com/bluesxu/agent-rd/main/docs/update.md
```

> 🛡️ **只写你自己的目录：** 升级只动 `~/.agent-rd/` 和 `~/.claude/` —— 更新仓库、
> 重装 skill，都不碰你的项目。已存在的 skill 先备份成 `*.bak-<时间戳>` 再覆盖。

> 📦 **升级不改存量 feature：** 已经跑完的 feature 产物原样保留。
> 只是「下次再跑门 / 再开新 feature」会按新规则来（见下文「存量 feature 迁移提示」）。

---

## 给 AI Agent 看

### 目标

把已安装的 Agent-RD 升级到最新版（改动十三「Builder 纯实现」改造后），
**一趟跑完，不要中间停下来做预览或等确认**。步骤：更新仓库 → 重装 skill →
清理运行时残留 → 同步运行时依赖 → 讲清楚行为变化。

**这次升级到「讲清楚行为变化」为止。** 不要替用户改任何项目的 `.rd/`——
存量 feature 的迁移是用户自己决定什么时候做，本文档只给提示，不动手。

### ⚠️ 边界

- **不要** 用 `sudo` / 管理员权限，全程只写用户目录。
- **不要** 改 `~/.claude/` 和 `~/.agent-rd/` 之外的任何文件。
- **不要** 主动改存量 feature 的 `tasks.json` / `contracts.json` / 回执 ——
  那些是用户项目里的产物，属于用户，升级不动它们，只在步骤 4 讲清楚影响。
- 本文档列出的步骤照做即可，不用逐条等用户确认。**超出本文档范围**的动作必须先问用户。

### 📁 目录规则

| 用途 | 位置 |
|---|---|
| Agent-RD 仓库本体（升级就回这里 `git pull`） | `~/.agent-rd/repo/`（Windows：`%USERPROFILE%\.agent-rd\repo\`） |
| 安装后的 skill | `~/.claude/skills/` |

### 前置条件（先检查）

```bash
node --version    # 需要 22+
cd ~/.agent-rd/repo && git --version && git status   # 仓库在、干净
```

仓库不在 → 走安装指南（docs/install.md），不是升级。仓库有未提交改动 → 先问用户怎么处理
（升级要 pull，会与本地改动冲突）。

### 步骤 1：拉最新代码 + 重装 skill

```bash
cd ~/.agent-rd/repo
git pull
node install.js -Apply
```

`install.js -Apply` 把全套 skill 拷进 `~/.claude/skills/`（旧版先备份再覆盖），
不碰任何配置文件、不碰任何项目。幂等。

### 步骤 2：清理运行时残留

本次改造把 `gate-l1.js` 改名为 `gate-test.js`。确认旧的没留在运行时里：

```bash
rm -f ~/.agent-rd/repo/scripts/gate-l1.js
```

（`git pull` 正常会处理改名，这步是保险：双克隆或手动拷贝场景下旧文件可能残留。）

### 步骤 3：同步运行时依赖（只有「本机独立源仓」场景需要）

`git pull` 已把仓库内 `scripts/` / `skills/` / `templates/` 一起更新 —— 大多数机器这步跳过。

**只有**本机维护着另一份独立源仓、运行时 `repo/` 不是靠 pull 更新时，把这三处从源仓同步过去：

```bash
# 用你的源仓绝对路径替换 <SRC>（示例是 Windows 改造机）
SRC=<你的 Agent-RD 源仓路径>
cp -r "$SRC/scripts"/* ~/.agent-rd/repo/scripts/
rm -f ~/.agent-rd/repo/scripts/gate-l1.js
cp -r "$SRC/skills" ~/.agent-rd/repo/   # 覆盖式替换 skills/
cp -r "$SRC/templates"/* ~/.agent-rd/repo/templates/
```

**为什么 skills/ 和 templates/ 也要同步**：新版 `scripts/assemble-prompt.js` 从
`../skills/rd-build/references/prompts/builder.md` 读 Builder 模板（脚本与 skills 是兄弟目录）；
`templates/contracts.json` 是新模板。这些不同步，运行时读到的是旧版，`assemble-prompt`
拼出旧占位符、`init-rd` 拿不到契约模板 —— 都是「看着正常、用起来错」的坑。

同步后跑一次冒烟确认：

```bash
node ~/.agent-rd/repo/scripts/verify.js    # 应全绿（0 失败）
```

### 步骤 4：讲清楚「这次升级改了什么」+ 存量 feature 迁移提示

**先给用户看行为变化对照表**（这是本步骤的重点，别只说「升级完了」）：

| 旧（改动十三之前） | 新 |
|---|---|
| `gate-l1.js` —— L1 机械门，第一道闸 | `gate-test.js` —— 测试层，跑审查层写的全部测试 |
| Builder 测试先行 + 跑 verify + 做变异 | Builder **只写代码**，完成门 = `node --check` / `tsc --noEmit` 自检，不碰测试 |
| 测试由 Builder 写 | **测试作者 = 审查层 reviewer**（审完代码后写全部 AC 测试 + 自造对抗性变异） |
| `tasks.json` 用 `verify` 字段 | 用 `selfCheck` 字段（自检命令，不跑测试） |
| 回执字段 `verifyCommand` / `verifyOutput` / `mutationsSurvived` | `selfCheckCommand` / `selfCheckOutput` |
| 语法门（`kind:"syntax"`） | 移除，语法检查下沉 Builder 自检 |
| 三层编号 L1 / L2 / L3 | **审查层 → 测试层 → 验收层**（执行顺序 = 层名顺序） |
| 下游等上游 task 实现完 | **契约先行**（`contracts.json`），下游照契约写，上游实现偏离由 `verify-contracts.js` 对账 |
| （无） | 新脚本：`verify-contracts.js` / `audit-receipts.js` / `boundary-check.js` / `assemble-prompt.js` |
| 修复派 fresh fix agent | **回唤失败文件的 owner Builder** 修 + 审查层以 spec 定责复审 |
| 一个 reviewer 审全量 | 审查层按契约边界**切片并行**；blocking 按文件不相交**并行修复** |

**存量 feature 迁移提示**（升级**不自动改**，用户/agent 下次碰这些 feature 时注意）：

- 存量 `tasks.json` 的 `verify` 字段 → 下次跑 `validate-plan` 会报「缺 selfCheck」，
  改成 `selfCheck`（自检命令）即可。
- 存量 Builder 回执（`reports/receipts/*.json`）用的旧字段 → `check-artifacts` 会点名缺字段，
  重跑那一轮 build 让 Builder 补新格式回执即可。
- **有跨层依赖的 feature** → `validate-plan` 会开始要求 `contracts.json` 覆盖每条跨层依赖。
  下次进 build 前补一份（模板在 `templates/contracts.json`）。
- 报告文件名改成了**按层命名**：`test-round*`（测试层）/ `review-round*`（审查层）/ `eval-round*`（验收层）。
  存量 feature 里的旧 `l1/l2/l3-round*` 文件是历史产物，不迁移 —— 重跑 `check-artifacts` 会报缺失，属预期。

**「哪些没变」也要说一句**：`init-rd` 用法、`.rd/` 产物结构、八条路线、`rd` 入口分诊 —— 全没变。

### 步骤 5：收尾复查

确认：

- `~/.claude/skills/` 下 7 个 skill 都在（`rd` / `rd-spec` / `rd-plan` / `rd-build` / `rd-eval` / `rd-review` / `rd-keep`）
- 运行时 `scripts/` 里 **没有** `gate-l1.js`、**有** `gate-test.js`
- 步骤 3（如做了）的 `verify.js` 全绿
- 步骤 1 的输出没有报错

全部成立 → 提醒用户**重启 Claude Code**（skill 启动时加载），结束。

---

## 命令速查

| 命令 | 作用 |
|---|---|
| `cd ~/.agent-rd/repo && git pull && node install.js -Apply` | 更新仓库 + 重装 skill（升级核心两步） |
| `rm -f ~/.agent-rd/repo/scripts/gate-l1.js` | 清运行时残留（gate-l1 已改名 gate-test） |
| `node ~/.agent-rd/repo/scripts/verify.js` | 升级后冒烟：脚本契约全绿 |

## 常见问题

- **`git pull` 报冲突**：本地运行时 `repo/` 有未提交改动。一般是误改过脚本 ——
  让用户决定保留改动（`git stash` 后 pull，再 `git stash pop`）还是丢弃（`git reset --hard` 后 pull）。**别替用户选。**
- **升级完 `assemble-prompt` 拼出来的 prompt 有 `{xxx}` 占位符**：`repo/skills` 还是旧版
  （步骤 3 没做）。把源仓的 `skills/` 同步过去再重跑。
- **存量 feature 跑 `validate-plan` 报「缺 selfCheck」**：tasks.json 还是旧 `verify` 字段，
  改字段名即可（见步骤 4 迁移提示）。
- **存量 feature 跑 `validate-plan` 报「有跨层依赖但缺 contracts.json」**：补一份契约，
  模板在 `templates/contracts.json`。
- **`verify.js` 升级后红了**：先 `git pull` 确认仓库是最新；本机双克隆场景把
  `scripts/` + `skills/` + `templates/` 三处都同步（步骤 3），只同步 scripts 不够。
