#!/usr/bin/env node
/*
  install —— 安装 Agent-RD 的 7 个 skill 到 ~/.claude/skills/（跨平台：Windows / macOS / Linux）。

  默认 dry-run，只打印将要做什么。确认无误后加 -Apply 真正执行。
  本脚本只复制 skill 目录，不修改任何配置文件。
  Agent Teams 的开关由 scripts/enable-agent-teams.js 单独负责，见 docs/install.md 步骤 2。
  用法：
    node install.js
    node install.js -Apply
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
  const args = { Apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-Apply' || a === '--Apply') { args.Apply = true; continue; }
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
out(C.cyan(`=== Agent-RD install [${mode}] ===`));
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
