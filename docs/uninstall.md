# Agent-RD — 卸载指南

## 给用户看

把下面这句话复制给你的 AI Agent，它会全程代办：

```
帮我卸载 Agent-RD：https://raw.githubusercontent.com/bluesxu/agent-rd/main/docs/uninstall.md
```

> 🛡️ **只动 Agent-RD 自己装的东西：** 卸载只碰两处 —— ① `~/.claude/skills/` 里的 7 个
> `rd` 开头的 skill、② 仓库目录 `~/.agent-rd/`。
> 其他 skill、你的项目代码，一概不碰。

> 📂 **项目里的 `.rd/` 不会动：** 在某个项目里初始化出来的 `.rd/` 目录（验收标准、设计、
> 报告、经验……）是你的工作产物，**卸载不删**。要不要删、怎么处理，你自己决定。

Agent-RD 是一套给 Claude Code 用的「多 AI 审核交付流程」。卸载就是把安装时写进你环境的
东西撤掉，一个项目文件都不改。开源仓库：<https://github.com/bluesxu/agent-rd>

---

## 给 AI Agent 看

### 目标

把 Agent-RD 安装时写进用户环境的两处全部撤掉，撤完验证干净，再告诉用户怎么确认卸载完成：
① `~/.claude/skills/` 下的 7 个 skill；② 仓库 `~/.agent-rd/`。
另外处理安装/升级时留下的 `.bak-*` 备份（先问用户）。

**卸载和安装只有一处不一样：安装是覆盖（写之前有备份），卸载是删除（删了不一定有得回滚）。**
所以动手前先把清单亮给用户、等一次确认；每个删除目标都必须先确认是 Agent-RD 装的，不能凭名字猜。

### ⚠️ 边界

- **不要** 用 `sudo` / 管理员权限跑任何一步。
- **只删这两处**：7 个 skill 目录、仓库目录。**不要** 碰其他 skill、任何项目文件。
- **不要用通配符删 skill**（`rm -rf ~/.claude/skills/rd*` 会把用户自己叫 `rd-…` 的其他 skill 一起误删）。
  只删清单里确切列出的 7 个目录名。
- **不要删任何 `.rd/` 目录** —— 那是用户在项目里的产物，卸载不背这个锅，交给用户决定。
- 删之前**必须验证**目标是 Agent-RD 装的（判别方法见步骤 2）。验证不过 → **别删，问用户**。
- 用户自定义过某个 skill（内容和仓库副本对不上）→ 删前提醒一句，别默默丢掉用户的改动。
- 一个确认点：步骤 1 摸完清单后，把「要删哪些」亮给用户、等一次确认再动手；
  之后 `.bak-*` 备份怎么处理再问一次。除此之外不要逐条打断。

### 📁 目录规则

| 用途 | 位置 |
|---|---|
| Agent-RD 仓库本体 | `~/.agent-rd/`（Windows：`%USERPROFILE%\.agent-rd\`） |
| 已安装的 skill（卸载目标） | `~/.claude/skills/` 下的 `rd` / `rd-spec` / `rd-plan` / `rd-build` / `rd-eval` / `rd-review` / `rd-keep` |
| 安装/升级留下的备份（要处理） | `~/.claude/skills/*.bak-<时间戳>` |
| 项目内 skill 工作区（**不删**） | `<用户项目>/.rd/` |

> 如果当初安装用了 `-ClaudeHome` 指定别的目录，下面所有 `~/.claude` 一律换成那个目录。

### 前置条件

不需要 node，也不需要 git。三平台均可。

### 步骤 1：摸清装了什么（先看，不删）

把这几条都跑一遍，结果记下来：

```bash
ls ~/.claude/skills/                     # 7 个 skill 哪些在
ls -d ~/.claude/skills/rd* 2>/dev/null   # 有哪些 rd 开头的东西（含 .bak-*）
ls -d ~/.agent-rd 2>/dev/null            # 仓库在不在
ls -d ~/.claude/skills/*.bak-* 2>/dev/null   # 备份文件
```

`.rd/` 目录：**不要全盘扫**。问用户在哪些项目里跑过 `init-rd.js`，或直接提醒用户项目里的 `.rd/` 由 ta 自己处理。

把结果整理成清单，**亮给用户、等一次确认**再动手：

- 在的 7 个 skill 目录（逐个列）
- 仓库目录（在不在）
- 找到的 `.bak-*` 备份（这些**先不删**，步骤 4 再定）

> ⚠️ 例外：清单里任何一项**无法确认是 Agent-RD 装的**，别等用户开口，直接停下来问。
> 拿不准的东西宁可留着，也不误删。

### 步骤 2：删 skill

逐个核对 7 个目录，**只删能确认是 Agent-RD 的**：

```bash
for d in rd rd-spec rd-plan rd-build rd-eval rd-review rd-keep; do
  if [ -d ~/.claude/skills/$d ]; then
    if grep -Eq "阶段 [0-9]|L[123]|acceptance\.json|Agent-RD" ~/.claude/skills/$d/SKILL.md 2>/dev/null; then
      rm -rf ~/.claude/skills/$d && echo "已删 $d"
    else
      echo "⚠️ 没删 $d —— SKILL.md 里没有 Agent-RD 的流水线标记，需要问用户"
    fi
  fi
done
```

判别规则（满足其一即可认定是 Agent-RD 的）：
1. **仓库副本比对（最可靠）**：`~/.agent-rd/repo/skills/<name>` 存在，且安装目录和它 `diff -r` 一致。
2. **SKILL.md 自证**：`name:` 字段等于目录名，且 `description:` 里带 Agent-RD 流水线术语
   （`阶段 0/1/2/3`、`L1/L2/L3`、`acceptance.json`、`spec.md`、`分诊` 等任一）。
3. 目录里有配套子目录（`references/`、`templates/` 等）作为佐证。

全都不满足 → 拿不准，**别删，问用户**。

> 只删上面**确切列出的 7 个名字**。看到任何别的 `rd-*` 目录，一律先问，不顺手删。

> 如果用户自定义过某个 skill（内容和仓库副本对不上），删之前提醒一句：这会丢掉 ta 的改动。
> 想留档的话先让用户备份，再继续删。

### 步骤 3：删仓库（可选，默认删）

`~/.agent-rd/` 只是一份 clone，删了随时能重新 clone，但它同时也是文档和以后升级的入口。问用户一句：

- **删**：`rm -rf ~/.agent-rd`
- **留**：不删。不影响卸载（skill 已删，没有 skill 会再去读它），下次想重装还能直接 `git pull`。

> 顺序：先做步骤 2（还要拿它当判别依据），再删仓库。

### 步骤 4：处理 `.bak-*` 备份（用户决定）

步骤 1 里找到的 `.bak-*` 是安装/升级时替你留的旧版本。**默认先留着，把选项摆给用户**：

| 选项 | 做法 | 后果 |
|---|---|---|
| A. 回滚 | 把 `.bak-*` 改名回原名（`rd.bak-20260810-120000` → `rd`） | 退回到 Agent-RD 动手之前的样子 |
| B. 删干净 | `rm -rf ~/.claude/skills/*.bak-*` | 彻底清掉 |
| C. 留着 | 什么都不做 | 不占多少空间，日后自己处理 |

- 只有确实存在 `.bak-*` 的文件才谈得上 A。全新安装（之前没有旧版本）通常没有这些文件，
  删掉 skill 就是全部，没有回滚可言。
- 多个 `.bak-*` 并存（装过多次）时，把文件名和时间戳亮给用户，由 ta 决定回滚到哪个版本。

### 步骤 5：收尾复查

```bash
ls ~/.claude/skills/                    # 7 个 rd 开头的应该都没了
ls -d ~/.agent-rd 2>/dev/null           # 若选了删，应该不存在
```

确认后，把下面这些交代给用户：

- **重启 Claude Code**。skill 是启动时加载的，重启后 `/rd` 不再出现。
- **项目里的 `.rd/` 没动**：卸载不碰它。哪些项目里有、要不要删，用户自己定。
  要删是 `rm -rf <项目>/.rd`，但**删之前想清楚**：里面是验收标准、设计、报告、经验这些证据，
  建议先 `git commit` 或存档再删。
- 卸载后 `~/.claude/` 目录本身还在（它本来就是 Claude Code 的家），只是里面 Agent-RD 装的东西没了。

---

## 命令速查

| 命令 | 作用 |
|---|---|
| `ls ~/.claude/skills/` | 看哪些 skill 在 |
| `rm -rf ~/.claude/skills/rd ~/.claude/skills/rd-spec ~/.claude/skills/rd-plan ~/.claude/skills/rd-build ~/.claude/skills/rd-eval ~/.claude/skills/rd-review ~/.claude/skills/rd-keep` | 删 7 个 skill（逐个列全，不用通配符） |
| `rm -rf ~/.agent-rd` | 删仓库（可选） |
| `rm -rf ~/.claude/skills/*.bak-*` | 清备份（可选，先问） |

## 常见问题

- **卸载完 `/rd` 还在？** skill 是启动时加载的，**重启 Claude Code**。还不行就查
  `~/.claude/skills/` 下有没有残留。
- **卸载了想反悔？** 只要 `.bak-*` 备份还在，就能回滚（步骤 4 选项 A）。
- **找不到 `~/.agent-rd`？** 无所谓，skill 照删；仓库早已不在就正好跳过步骤 3。
- **某个 skill 拿不准是不是 Agent-RD 的？** 别删，问用户。判别：SKILL.md 里带 Agent-RD 的流水线标记
  （`阶段 0/1/2/3`、`L1/L2/L3`、`acceptance.json` 等）。
- **Windows 上路径怎么对？** `%USERPROFILE%\.claude\skills`、`%USERPROFILE%\.agent-rd`。
  PowerShell 删目录用 `Remove-Item -Recurse -Force <路径>`。
- **项目里的 `.rd/` 还留着？** 那是你的产物，卸载不碰。留着无害（skill 没了没人再读它），想清就自己删。
- **想重装？** 随时可以：重新跑一遍 `docs/install.md`。仓库重 clone、skill 重装，全程幂等。
