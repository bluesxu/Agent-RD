#!/usr/bin/env node
/*
  install —— 安装 AgentRD 的 7 个 skill 到 ~/.claude/skills/（跨平台：Windows / macOS / Linux）。

  默认 dry-run，只打印将要做什么。确认无误后加 -Apply 真正执行。
  -EnableAgentTeams 会往 ~/.claude/settings.json 写入
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1（会先备份原文件）。

  用法：
    node install.js
    node install.js -Apply -EnableAgentTeams
    node install.js -Apply -ClaudeHome /custom/.claude

  退出码：0 = 成功（含 dry-run）；2 = 源目录缺失。
*/
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const isTty = process.stdout.isTTY;
const C = {
  gray: (s) => (isTty ? '[90m' + s + '[0m' : s),
  dark: (s) => (isTty ? '[90m' + s + '[0m' : s),
  red: (s) => (isTty ? '[31m' + s + '[0m' : s),
  green: (s) => (isTty ? '[32m' + s + '[0m' : s),
  yellow: (s) => (isTty ? '[33m' + s + '[0m' : s),
  cyan: (s) => (isTty ? '[36m' + s + '[0m' : s),
};
function out(s) { process.stdout.write(s + '\n'); }

function parseArgs(argv) {
  const args = { Apply: false, EnableAgentTeams: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-Apply' || a === '--Apply') { args.Apply = true; continue; }
    if (a === '-EnableAgentTeams' || a === '--EnableAgentTeams') { args.EnableAgentTeams = true; continue; }
    const m = a.match(/^--?([A-Za-z]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = m[2];
    if (val === undefined && i + 1 < argv.length && !/^--?/.test(argv[i + 1])) val = argv[++i];
    if (key === 'claudehome') args.ClaudeHome = val;
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));
const ClaudeHome = args.ClaudeHome || path.join(os.homedir(), '.claude');

const here = __dirname;
const srcSkills = path.join(here, 'skills');
const dstSkills = path.join(ClaudeHome, 'skills');

if (!fs.existsSync(srcSkills)) {
  out(C.red(`找不到 skills 目录: ${srcSkills}`));
  process.exit(2);
}

const mode = args.Apply ? 'APPLY' : 'DRY-RUN（不会改任何东西）';

out('');
out(C.cyan(`=== AgentRD install [${mode}] ===`));
out(C.dark(`    源:   ${srcSkills}`));
out(C.dark(`    目标: ${dstSkills}`));
out('');

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

const skills = fs.readdirSync(srcSkills, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

for (const name of skills) {
  const dst = path.join(dstSkills, name);
  const exists = fs.existsSync(dst);
  const tag = exists ? 'OVERWRITE' : 'install';
  const color = exists ? C.yellow : C.green;

  out(color(`  ${tag.padEnd(10)} ${name}`));

  if (args.Apply) {
    if (!fs.existsSync(dstSkills)) fs.mkdirSync(dstSkills, { recursive: true });
    if (exists) {
      const bak = `${dst}.bak-${ts()}`;
      fs.renameSync(dst, bak);
      out(C.dark(`             备份旧版本 -> ${path.basename(bak)}`));
    }
    copyDir(path.join(srcSkills, name), dst);
  }
}

if (args.EnableAgentTeams) {
  out('');
  out(C.cyan('  --- Agent Teams ---'));
  const settingsPath = path.join(ClaudeHome, 'settings.json');

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
    catch { settings = {}; }
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  if (!settings.env || typeof settings.env !== 'object') settings.env = {};

  const current = settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  if (current === '1') {
    out(C.dark('  已经是 1，无需改动'));
  } else {
    out(C.yellow(`  将设置 env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = 1  (当前: '${current === undefined ? '' : current}')`));
    if (args.Apply) {
      if (fs.existsSync(settingsPath)) {
        const bak = `${settingsPath}.bak-${ts()}`;
        fs.copyFileSync(settingsPath, bak);
        out(C.dark(`  已备份 -> ${path.basename(bak)}`));
      }
      settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
      out(C.green(`  已写入 ${settingsPath}`));
    }
  }
  out('');
  out(C.dark('  注意：Windows 上只能用 in-process 模式（主终端 Shift+上/下 切换队友）。'));
  out(C.dark('        split panes 需要 tmux 或 iTerm2。'));
}

out('');
if (args.Apply) {
  out(C.green('=== 安装完成 ==='));
  out('');
  out(C.cyan('下一步：'));
  out(C.gray('  1. cd 到你的项目'));
  out(C.gray(`  2. node "${path.join(here, 'scripts', 'init-rd.js')}"`));
  out(C.gray('  3. 重启 Claude Code，调用 /rd'));
} else {
  out(C.yellow('=== 这是 dry-run。确认无误后重跑并加 -Apply ==='));
}
out('');
process.exit(0);
