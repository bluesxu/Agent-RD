# Agent-RD — 安装指南

## 给用户看

把下面这句话复制给你的 AI Agent，它会全程代办：

```
帮我安装 Agent-RD：https://raw.githubusercontent.com/bluesxu/agent-rd/main/docs/install.md
```

> 🛡️ **只写你自己的目录：** 安装只往 `~/.claude/` 里放东西 —— skill 装进
> `~/.claude/skills/`，一个环境变量写进 `~/.claude/settings.json`。
> 两处都会先把已有文件备份成 `*.bak-<时间戳>` 再动。

> 📦 **装完不会碰你的项目：** 一个项目文件都不改。
> 等你真的要在某个项目里走完整流程，再跑一条初始化命令。

Agent-RD 是一套给 Claude Code 用的「多 AI 审核交付流程」：把写代码的 AI 产出的东西，
先过另一批 AI 的审查和验收，才交到你手上。开源仓库：<https://github.com/bluesxu/agent-rd>

---

## 给 AI Agent 看

### 目标

把 Agent-RD 的全套 skill 装进用户的 `~/.claude/`，配好 Agent Teams 开关，
然后**教用户怎么用**。装完用户重启 Claude Code、输入 `/rd` 即可开始。

**一趟跑完，不要中间停下来做预览或等确认。** 三步：装 skill → 配开关 → 讲怎么用。
每一步都自带备份、都幂等、都可逆，用不着先演一遍再来一遍。

**这次安装到「告诉用户怎么用」为止。** 不要顺手在任何项目里跑 `init-rd.js` ——
见步骤 3 的说明。

### ⚠️ 边界

- **不要** 用 `sudo` / 管理员权限跑任何一步，Agent-RD 全程只写用户目录。
- **不要** 改 `~/.claude/` 和目标项目之外的任何文件。
- **不要** 装本文档没列出的包。
- **不要** 把仓库 clone 进用户当前的 agent workspace / 工作目录——那会污染用户的项目。
- **不要跑 dry-run**。`install.js` 不带参数是 dry-run，`enable-agent-teams.js` 有 `-DryRun`，
  本流程两个都不用：直接上真参数。写之前有备份，看一遍执行计划换不来更多安全，只多烧一轮往返。
- **不要主动跑 `init-rd.js`**——那是用户自己决定在哪个项目里用的时候才跑的，
  哪怕当前目录看起来就是个项目也不要跑。这是本文档里**唯一**需要用户先点头的命令，
  理由见步骤 3。
- 本文档列出的步骤照做即可，不用逐条等用户确认。**超出本文档范围**的动作
  （需要更高权限、要改别的文件、要装别的包）**必须先问用户**，让 ta 决定。

### 📁 目录规则

| 用途 | 位置 |
|---|---|
| Agent-RD 仓库本体 | `~/.agent-rd/repo/`（Windows：`%USERPROFILE%\.agent-rd\repo\`） |
| 安装后的 skill | `~/.claude/skills/` |
| Claude Code 配置 | `~/.claude/settings.json` |
| 项目内 skill 完整工作区 | `<用户项目>/.rd/`（规格 / 报告 / 守卫脚本 / **AC 测试**，整体不进 git） |
| 临时文件 | 系统临时目录 |

**仓库位置是固定的，不要「随便挑个地方」**：以后升级要回到这里 `git pull`，
用户将来初始化项目也要用它的绝对路径。用户明确指定了别的目录就听 ta 的，
但同样要记牢并全程复用。

### 前置条件（先检查）

```bash
node --version    # 需要 18+，能跑 Claude Code 的机器上一定有
git --version
```

三平台均可：Windows / macOS / Linux。缺任何一个，先告诉用户怎么装，再继续。

### 步骤 1：装 skill

```bash
git clone https://github.com/bluesxu/agent-rd.git ~/.agent-rd/repo
cd ~/.agent-rd/repo
node install.js -Apply
```

已经克隆过就**不要重复克隆**，进去更新再装：

```bash
cd ~/.agent-rd/repo && git pull && node install.js -Apply
```

`-Apply` 只做一件事：把全套 skill 拷进 `~/.claude/skills/`（已存在的先备份成
`*.bak-<时间戳>` 再覆盖）。它不修改任何配置文件，也不碰任何项目。

把最终仓库路径记下来并告诉用户，后面步骤都引用它。

> ⚠️ **它末尾打印的「下一步」里有一条 `init-rd.js`，这次不要照着跑。**
> 那条是给「已经决定好在哪个项目里用」的场景准备的，本次安装按步骤 2、3 走。

### 步骤 2：配 Agent Teams（失败就跳过）

Agent Teams 只服务 `rd-build` 的 A 档并行 —— 队友之间有共享任务列表、能互相通信。
**不开也能跑**：`rd-build` 会自动降级到 B 档并行子 agent，编排规则完全相同。
（`rd-plan` 的方案论证不走 Teams，它要的是互不通信的独立样本，与这个开关无关。）
接着跑：

```bash
node ~/.agent-rd/repo/scripts/enable-agent-teams.js
```

它往 `~/.claude/settings.json` 的 `env` 里合并一个键
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"`，其余内容原样保留，写之前先把原文件
备份成 `settings.json.bak-<时间戳>`。幂等，重复跑无害。

**失败了就跳过，不要重试、不要手动改 JSON、不要卡在这里。**
退出码 1 就是失败（常见原因：`settings.json` 是手写的 JSONC 带注释，解析不过）。
它失败时**绝不会覆盖用户原文件**，所以跳过是安全的。

失败就**记下这件事**，继续走步骤 3，到步骤 4 再回来问用户。
不开这个开关也能用——Agent-RD 会自动降级为子 agent 执行，功能不受影响，
少掉的是常驻具名队友和队友间互相喊话的能力。

> 顺带一提：`/permissions` 管的是工具权限规则，不管环境变量，在那里找不到这个键。

### 步骤 3：告诉用户怎么用（本次安装的终点）

**这是安装的最后一个实质步骤，也是最容易被跳过的一个。**
不要只说一句「装好了，输入 /rd」就收尾——把下面这些讲清楚：

**怎么开始**

1. **重启 Claude Code**（skill 和 `settings.json` 都要重启才加载）
2. 直接输入 `/rd` 加上你的诉求，比如 `/rd 给用户表加一个软删除字段`
3. 不想记命令也行：装完之后你正常提开发需求，`rd` 会自己被触发来分诊

**它会先分诊，不是所有任务都走全套**

`/rd` 拿到诉求后先判断任务类型（feature / bugfix / refactor / chore / research / review）、
复杂度（S/M/L/XL）和风险，再选一条相称的路线，共七条。
改三行的 bug 走轻量路径，跨模块的新功能才上全套三层门。
它会把这次的分诊结论打印给你，你不认同可以当场要求换路线。

**成本要有个数**：最重的 `full` 路线**每条验收标准约 14 万 token**。
所以分诊是有意义的，不要嫌它啰嗦。

**几句能直接抄的话**

| 你想要 | 就这么说 |
|---|---|
| 别分析了，直接改 | `直接做：<诉求>` / `小修一下：<诉求>` |
| 只审代码，别动 | `审一下 <范围>` |
| 只做调研和选型，不写代码 | `调研 <题目>` |
| 走完整流程 | `/rd <诉求>`，让它自己判 |

前三条是写死在 skill 里的逃生舱短语，认这几个词。

**七个 skill 分别是什么**

| skill | 干什么 |
|---|---|
| `rd` | 入口与分诊，选路线。**平时只用这一个** |
| `rd-spec` | 业务梳理，产出验收标准。**整条流水线唯一需要你参与的环节** |
| `rd-plan` | 多个 AI 并行出方案，仲裁后产出设计与任务 DAG |
| `rd-build` | 并行实现 + L1 机械门 / L2 异构审查 / L3 场景验收，全自动闭环 |
| `rd-eval` | L3 场景验收，像终端用户一样跑场景——唯一能识破「测试全绿但功能是假的」的一层 |
| `rd-review` | L2 异构代码审查，只读，可单独喊 |
| `rd-keep` | 收尾沉淀经验 |

后面六个是 `rd` 按路线自动调的，你不用手动记；`rd-review` 想单独用也可以。

**（可选）要在某个项目里走完整流程时，先初始化一次**

轻量路线跑机械门要读 `.rd/gates.json`，完整路线还要往 `.rd/` 里落产物。
所以**每个项目第一次用之前**，在那个项目根目录跑一次：

```bash
cd <你的项目目录>
node ~/.agent-rd/repo/scripts/init-rd.js
```

它是增量的、不覆盖已有文件：自动识别项目语言、按类型配好 `.rd/gates.json` 的检查命令、
下发守卫脚本到 `.rd/bin/`、在 `.gitignore` 里加 `.rd/`，并把配好的命令实际跑一遍确认能执行。
一个项目只需要跑一次。

**仓库会只剩产品代码**：skill 的所有产物（spec / design / acceptance / 报告 / **AC 测试**）
都进 `.rd/`，整体被 gitignore、不进 git。项目树里出现的只有产品代码本身。

**Agent 注意**：把这条命令**给用户看**就行，**不要替 ta 跑**——
你不知道 ta 想在哪个项目里用，猜错就是往别人的仓库里写文件。
只有用户在这次对话里明确说了「就在 X 项目初始化」，才 `cd` 过去跑。
**这是本文档里唯一一条需要用户先点头的命令**，因为它是唯一一条写到 `~/.claude/` 之外的。

### 步骤 4：收尾复查 + 补配置

先确认两件事都成立：

- `~/.claude/skills/` 下出现了 `rd` / `rd-spec` / `rd-plan` / `rd-build` / `rd-eval` / `rd-review` / `rd-keep`
- 步骤 1 的输出里没有报错

然后按步骤 2 的结果分两种情况收尾：

**步骤 2 成功** —— 汇报完成，提醒重启 Claude Code，结束。

**步骤 2 失败被跳过** —— 现在才问用户，把选项和后果一起摆出来，别只给一个「要不要」：

```
Agent Teams 的开关我没写进去：{原原本本的失败原因}
它是干什么的：rd-plan / rd-build 靠它开常驻具名队友做并行编排。
不加会怎样：照样能用，会自动降级成子 agent 跑，功能不缺，
            少掉的是常驻队友和队友间互相喊话，编排稍慢一些。
要加的话，跑这一条就行（会先备份 settings.json，幂等，可重复跑）：

  node ~/.agent-rd/repo/scripts/enable-agent-teams.js

加完重启 Claude Code 生效。
```

用户说加，就把上面那条命令跑掉；说不加，直接结束，**不要劝**。

---

## 命令速查

| 命令 | 作用 |
|---|---|
| `node install.js -Apply` | 安装 skill 到 `~/.claude/skills/`（旧版先备份） |
| `node ~/.agent-rd/repo/scripts/enable-agent-teams.js` | 开启 Agent Teams（写 `settings.json`，幂等，写前备份） |
| `cd ~/.agent-rd/repo && git pull` | 更新到最新版（之后重跑 `install.js -Apply`） |
| `node ~/.agent-rd/repo/scripts/init-rd.js` | 在当前项目初始化 `.rd/`（每个项目一次） |

> `install.js` 不带 `-Apply` 是 dry-run，只打印计划不写文件；
> `enable-agent-teams.js` 也有 `-DryRun`。想先看一眼再动手时用得上，
> 但正常安装用不着，直接上真参数就行。

## 常见问题

- **装完 `/rd` 找不到**：skill 是启动时加载的，**重启 Claude Code**。
- **`/rd` 能用但跑门报「gates.json 缺失」**：这个项目还没初始化，
  在项目根目录跑一次 `node ~/.agent-rd/repo/scripts/init-rd.js`。
- **`enable-agent-teams.js` 报 JSON 解析失败**：`~/.claude/settings.json` 里有注释或尾逗号
  （标准 JSON 不允许）。手动改成合法 JSON 再跑，或者干脆手动加那个键——
  脚本失败时不会动你的原文件。
- **Windows 上 Agent Teams 只有单窗口（in-process）模式**——这是 Claude Code 在 Windows 的
  既有限制，不是安装出错。主终端用 Shift+上/下切换队友。
- **重复运行 `install.js -Apply` 是安全的**：幂等，旧版会被备份后覆盖。
- **`node` 命令找不到**：确认 Node.js 已安装且在 PATH 里，装好后重开终端再试。
- **找不到仓库在哪**：默认在 `~/.agent-rd/repo`。安装时换过位置的话，以当时记录的路径为准。
