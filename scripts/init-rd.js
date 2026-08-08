#!/usr/bin/env node
/*
  init-rd —— 在一个项目里初始化 .rd/ 骨架。

  增量、不覆盖：已存在的文件一律跳过并提示。
  会自动探测项目类型，给 gates.json 挑一个合适的预设。

  用法：
    node init-rd.js
    node init-rd.js -Root D:\\code\\my-project

  退出码：0 = 完成；2 = 用不了。
*/
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = a.match(/^--?([A-Za-z]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = m[2];
    if (val === undefined && i + 1 < argv.length && !/^--?/.test(argv[i + 1])) val = argv[++i];
    if (key === 'root') args.Root = val;
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));
const Root = args.Root || process.cwd();

const here = __dirname; // scripts/
const templates = path.join(path.dirname(here), 'templates');

if (!fs.existsSync(templates)) {
  out(C.red(`找不到 templates 目录: ${templates}`));
  process.exit(2);
}

out('');
out(C.cyan(`=== AgentRD init -> ${Root} ===`));

const rd = path.join(Root, '.rd');
for (const d of [rd, path.join(rd, 'lessons'), path.join(rd, 'features')]) {
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true });
    out(C.green('  created  ' + path.relative(Root, d)));
  } else {
    out(C.dark('  exists   ' + path.relative(Root, d)));
  }
}

// ---- 项目类型探测 ----
let kind = 'node';
if (fs.existsSync(path.join(Root, 'Cargo.toml'))) kind = 'rust';
else if (fs.existsSync(path.join(Root, 'go.mod'))) kind = 'go';
else if (fs.existsSync(path.join(Root, 'pyproject.toml'))) kind = 'python';
else if (fs.existsSync(path.join(Root, 'requirements.txt'))) kind = 'python';

// ---- gates.json：按项目类型挑预设 ----
const gatesDst = path.join(rd, 'gates.json');
if (fs.existsSync(gatesDst)) {
  out(C.dark(`  exists   .rd/gates.json（跳过，不覆盖）[检测到: ${kind}]`));
} else {
  const tpl = JSON.parse(fs.readFileSync(path.join(templates, 'gates.json'), 'utf8'));

  let preset = null;
  if (kind === 'rust') preset = tpl._presets.rust;
  else if (kind === 'go') preset = tpl._presets.go;
  else if (kind === 'python') preset = tpl._presets.python;

  const l1 = preset !== null && preset !== undefined ? preset : tpl.l1;

  // 没有任何语言标记文件时，这套门是猜的（默认按 node）。标记出来，让阶段 1 必须回来解决。
  const markers = ['Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'package.json'];
  let hasMarker = false;
  for (const mk of markers) { if (fs.existsSync(path.join(Root, mk))) { hasMarker = true; break; } }

  const outCfg = {
    l1,
    _note: `由 init-rd 按项目类型 [${kind}] 生成。按你的项目改。required=false 只警告不阻塞。顺序即执行顺序，越便宜的放越前面。`,
  };
  if (!hasMarker) {
    outCfg._provisional = true;
    outCfg._provisionalNote = '⚠️ 目录里没有任何语言标记文件（Cargo.toml / go.mod / pyproject.toml / requirements.txt / package.json），上面这套门是**猜的**（默认按 node）。技术选型是阶段 1 的事 —— rd-plan 仲裁完之后必须回来改掉这份配置并删除本标记。在此之前，L1 机械门验的是一个还没被决定的技术栈。';
  }
  fs.writeFileSync(gatesDst, JSON.stringify(outCfg, null, 2), 'utf8');
  out(C.green(`  created  .rd/gates.json  [预设: ${kind}]`));
}

// ---- attention.md ----
const attDst = path.join(rd, 'attention.md');
if (fs.existsSync(attDst)) {
  out(C.dark('  exists   .rd/attention.md（跳过）'));
} else {
  fs.copyFileSync(path.join(templates, 'attention.md'), attDst);
  out(C.green('  created  .rd/attention.md'));
}

// ---- 随项目下发守卫脚本，让项目自包含（.rd/bin/check-ac.js）----
const binDir = path.join(rd, 'bin');
if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
const guardSrc = path.join(here, 'check-ac.js');
const guardDst = path.join(binDir, 'check-ac.js');
if (fs.existsSync(guardSrc)) {
  fs.copyFileSync(guardSrc, guardDst);
  out(C.green('  vendored .rd/bin/check-ac.js'));
  out(C.dark('           acceptance.json 的 check 一律从**项目根**执行，且**不许有嵌套转义引号**：'));
  out(C.dark('             对  -Cmd "node --test --test-name-pattern=<feature>\\sAC-1" -MustMatch "<feature> AC-1"'));
  out(C.dark('             错  -Cmd "node --test --test-name-pattern \\"<feature> AC-1\\"" ...'));
  out(C.dark('           错的那种在 sh 下能过、在 cmd 下反斜杠被吃掉导致引号错配，'));
  out(C.dark('           连 -MustMatch 都会被吞进 -Cmd，得到一个**假 FAIL**。用 --flag=value + 正则 \\s 绕开。'));
} else {
  out(C.yellow(`  ⚠ 找不到 ${guardSrc}，未能下发守卫脚本`));
}

// ---- gate 命令冒烟：确认它们至少「能被执行」 ----
const gatesCfg = JSON.parse(fs.readFileSync(gatesDst, 'utf8'));
out('');
out(C.cyan('  --- gate 命令冒烟（只验能否执行，失败不阻塞）---'));
for (const g of (Array.isArray(gatesCfg.l1) ? gatesCfg.l1 : [])) {
  let code;
  try {
    const r = spawnSync(String(g.cmd), { cwd: Root, shell: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    code = r.error ? -1 : (r.status === null ? -1 : r.status);
  } catch (e) {
    code = -1;
  }
  // 127 / 9009 = 命令不存在；-1 = 抛异常。这几种是「跑不起来」，其余退出码只是「没通过」，正常。
  if (code === 127 || code === 9009 || code === -1) {
    out(C.yellow(`    ⚠ ${g.name}: 命令跑不起来 (exit ${code}) — ${g.cmd}`));
    out(C.yellow('      L1 会一直挂在这里。装好依赖或改掉这条命令。'));
  } else {
    out(C.dark(`    ✓ ${g.name}: 可执行 (exit ${code})`));
  }
}

// ---- .gitignore：直接创建 ----
const giPath = path.join(Root, '.gitignore');

const common = ['# --- AgentRD init ---', '.DS_Store', 'Thumbs.db', '*.log'];
let langIgnore;
if (kind === 'python') langIgnore = ['__pycache__/', '*.py[cod]', '.venv/', 'venv/', '.pytest_cache/', '.mypy_cache/', 'dist/', 'build/', '*.egg-info/'];
else if (kind === 'go') langIgnore = ['bin/', '*.exe', '*.test', 'coverage.out'];
else if (kind === 'rust') langIgnore = ['target/', 'Cargo.lock.orig'];
else langIgnore = ['node_modules/', 'dist/', 'build/', 'coverage/', '.env', '.env.local'];
const want = common.concat(langIgnore);

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

if (fs.existsSync(giPath)) {
  const gi = fs.readFileSync(giPath, 'utf8');
  const missing = want.filter((w) => w.charAt(0) !== '#' && gi.indexOf(w) < 0);
  if (missing.length > 0) {
    let app = '\n# --- AgentRD init [' + kind + '] ---\n' + missing.join('\n') + '\n';
    fs.appendFileSync(giPath, app, 'utf8');
    out('');
    out(C.green(`  appended .gitignore  追加 ${missing.length} 条 [${kind}]`));
  } else {
    out('');
    out(C.dark('  exists   .gitignore（已覆盖依赖/构建产物，未改动）'));
  }
} else {
  fs.writeFileSync(giPath, want.join('\n') + '\n', 'utf8');
  out('');
  out(C.green(`  created  .gitignore  [${kind} 预设，${want.length} 条]`));
  out(C.dark('           没有它，git add -A 会把依赖目录 staged，'));
  out(C.dark('           freeze-target 就会冻出一个几百个文件的审查目标。'));
}

out('');
out(C.dark('  ⛔ 忽略清单里故意不含 .rd 下的任何东西：'));
out(C.dark('     run.json / reports/ / review-target.json / lessons/ 全都要进 git —— 它们是证据链，'));
out(C.dark('     不是运行时垃圾。spec / acceptance / design / tasks 同理。'));
out('');
out(C.green('=== 完成。在 Claude Code 里调用 /rd 开始 ==='));
out('');
process.exit(0);
