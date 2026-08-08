# 帮我安装 AgentRD

> **这份文件是给 AI 编程 Agent 看的安装指令。** 用户把它（或它的链接）发给你，就是让你**替 ta 把 AgentRD 装好**，全程代办，只在要改环境的把关点停下来确认。
>
> AgentRD 是一套给 Claude Code 用的「多 AI 审核交付流程」：把写代码的 AI 产出的东西，先过另一批 AI 的审查和验收，才交到用户手上。开源仓库：<https://github.com/bluesxu/agentrd>

## 前置条件（先检查）

- **Node.js 18+**：跑 `node --version` 确认。能跑 Claude Code 的机器上一定有它。
- **git**：跑 `git --version` 确认。
- 三平台均可：Windows / macOS / Linux。

缺任何一个，先告诉用户怎么装，再继续。

## 安装步骤

按顺序执行。**标 ⚠️ 的步骤会改动用户环境，先停下来给用户看一眼即将执行什么、等 ta 点头再跑**；其余只读步骤你自己跑就行。

### 1. 准备仓库（只读）

挑一个固定位置克隆下来（用户没指定就用一个顺手的工具目录）。已经克隆过就进仓库 `git pull` 更新到最新：

```bash
git clone https://github.com/bluesxu/agentrd.git
```

### 2. 预览安装计划（只读）

进入仓库目录，先跑 **dry-run**（这是默认模式，不会改任何东西），把它打印的执行计划原样展示给用户：

```bash
cd agentrd
node install.js
```

### 3. ⚠️ 真正安装

用户确认没问题之后：

```bash
node install.js -Apply -EnableAgentTeams
```

这一步做的事：把全套 skill 拷进 `~/.claude/skills/`（已存在的会先备份成 `*.bak-<时间戳>` 再覆盖），并往 `~/.claude/settings.json` 写入 `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`（同样先备份原文件）。

> 如果用户不想开 Agent Teams，去掉 `-EnableAgentTeams` 即可，功能会自动降级、不影响流程。

### 4. ⚠️ 在项目里初始化

**先问我要在哪个项目里用**，然后**切到那个项目的根目录**再跑（它操作的是「当前项目」）：

```bash
cd <用户的项目目录>
node <agentrd 仓库的绝对路径>/scripts/init-rd.js
```

它是增量、不覆盖已有文件的：自动识别项目语言、按类型配好 `.rd/gates.json` 的检查命令、下发守卫脚本到 `.rd/bin/`、建好 `.gitignore`，并把配好的命令实际跑一遍确认能执行。

### 5. 收尾

明确告诉用户：**重启 Claude Code，输入 `/rd` 开始使用**。

## 常见问题

- **Windows 上 Agent Teams 只有单窗口（in-process）模式**——这是 Claude Code 在 Windows 的既有限制，不是安装出错。主终端用 Shift+上/下切换队友。
- **重复运行 install.js 是安全的**：幂等，旧版会被备份后覆盖。
- **`node` 命令找不到**：确认 Node.js 已安装且在 PATH 里，装好后重开终端再试。

安装完成的标准：`~/.claude/skills/` 下出现这套 skill，项目里出现 `.rd/` 目录，且 `init-rd.js` 末尾打印「在 Claude Code 里调用 /rd 开始」。
