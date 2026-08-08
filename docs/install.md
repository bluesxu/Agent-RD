# AgentRD — 安装指南

## 给用户看

把下面这句话复制给你的 AI Agent，它会全程代办：

```
帮我安装 AgentRD：https://raw.githubusercontent.com/bluesxu/agentrd/main/docs/install.md
```

> 🛡️ **默认不改环境：** `node install.js` 不带参数就是 dry-run，只打印执行计划。
> 真正写文件的只有 `-Apply` 那一步，Agent 会先停下来给你确认。

AgentRD 是一套给 Claude Code 用的「多 AI 审核交付流程」：把写代码的 AI 产出的东西，
先过另一批 AI 的审查和验收，才交到你手上。开源仓库：<https://github.com/bluesxu/agentrd>

---

## 给 AI Agent 看

### 目标

把 AgentRD 的全套 skill 装进用户的 `~/.claude/`，并在用户指定的项目里初始化 `.rd/`。
装完用户重启 Claude Code、输入 `/rd` 即可使用。

### ⚠️ 边界

- **不要** 用 `sudo` / 管理员权限跑任何一步，AgentRD 全程只写用户目录。
- **不要** 改 `~/.claude/` 和目标项目之外的任何文件。
- **不要** 装本文档没列出的包。
- **不要** 把仓库 clone 进用户当前的 agent workspace / 工作目录——那会污染用户的项目。
- 标 ⚠️ 的步骤会改动用户环境：**先把即将执行的命令原样给用户看，等 ta 点头再跑**。
- 需要更高权限或超出上面范围时，**告诉用户**需要什么，让 ta 决定。

### 📁 目录规则

| 用途 | 位置 |
|---|---|
| AgentRD 仓库本体 | `~/.agentrd/repo/`（Windows：`%USERPROFILE%\.agentrd\repo\`） |
| 安装后的 skill | `~/.claude/skills/` |
| Claude Code 配置 | `~/.claude/settings.json` |
| 项目内配置与守卫脚本 | `<用户项目>/.rd/` |
| 临时文件 | 系统临时目录 |

**仓库位置是固定的，不要「随便挑个地方」**：第 4 步要用到它的绝对路径，
以后升级也要回到这里 `git pull`。用户明确指定了别的目录就听 ta 的，但同样要记牢并全程复用。

### 前置条件（先检查）

```bash
node --version    # 需要 18+，能跑 Claude Code 的机器上一定有
git --version
```

三平台均可：Windows / macOS / Linux。缺任何一个，先告诉用户怎么装，再继续。

### 步骤 1：准备仓库（只读）

```bash
git clone https://github.com/bluesxu/agentrd.git ~/.agentrd/repo
```

已经克隆过就**不要重复克隆**，进去更新即可：

```bash
cd ~/.agentrd/repo && git pull
```

把最终路径记下来并告诉用户，后面步骤都引用它。

### 步骤 2：预览安装计划（只读）

dry-run 是默认模式，不会改任何东西。把它打印的执行计划**原样**展示给用户：

```bash
cd ~/.agentrd/repo
node install.js
```

### 步骤 3：⚠️ 安装 skill

用户确认没问题之后：

```bash
node install.js -Apply
```

这一步只做一件事：把全套 skill 拷进 `~/.claude/skills/`（已存在的先备份成
`*.bak-<时间戳>` 再覆盖）。它不修改任何配置文件。

### 步骤 3b：开启 Agent Teams（可选，推荐，由用户操作）

Agent Teams 是 `rd-plan` / `rd-build` 并行编排依赖的能力。请用户自行在
`~/.claude/settings.json` 中加入：

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

这个键要手动加进 `settings.json`——`/permissions` 管的是工具权限规则，不管环境变量，
在那里找不到它。已经有 `env` 对象就往里加字段，不要整个替换掉。

不开也能用——AgentRD 会自动降级为子 agent 执行，功能不受影响，
少掉的是常驻具名队友和队友间互相喊话的能力。所以**不要卡在这一步**，
用户没开就继续走第 4 步。

### 步骤 4：⚠️ 在项目里初始化

**先问用户要在哪个项目里用**，然后**切到那个项目的根目录**再跑——它操作的是「当前目录」这个项目：

```bash
cd <用户的项目目录>
node ~/.agentrd/repo/scripts/init-rd.js
```

它是增量的、不覆盖已有文件：自动识别项目语言、按类型配好 `.rd/gates.json` 的检查命令、
下发守卫脚本到 `.rd/bin/`、建好 `.gitignore`，并把配好的命令实际跑一遍确认能执行。

### 步骤 5：收尾复查

确认三件事都成立，再向用户汇报：

- `~/.claude/skills/` 下出现了这套 skill
- 项目里出现了 `.rd/` 目录
- `init-rd.js` 末尾打印了「在 Claude Code 里调用 /rd 开始」

然后明确告诉用户：**重启 Claude Code，输入 `/rd` 开始使用**。

---

## 命令速查

| 命令 | 作用 |
|---|---|
| `node install.js` | 预览安装计划（默认，只读） |
| `node install.js -Apply` | 真正安装 skill 到 `~/.claude/skills/` |
| `cd ~/.agentrd/repo && git pull` | 更新到最新版（之后重跑 install.js） |
| `node ~/.agentrd/repo/scripts/init-rd.js` | 在当前项目初始化 `.rd/` |

## 常见问题

- **Windows 上 Agent Teams 只有单窗口（in-process）模式**——这是 Claude Code 在 Windows 的
  既有限制，不是安装出错。主终端用 Shift+上/下切换队友。
- **重复运行 `install.js` 是安全的**：幂等，旧版会被备份后覆盖。
- **`node` 命令找不到**：确认 Node.js 已安装且在 PATH 里，装好后重开终端再试。
- **找不到仓库在哪**：默认在 `~/.agentrd/repo`。安装时换过位置的话，以当时记录的路径为准。
