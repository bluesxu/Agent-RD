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
out(C.cyan(`=== Agent-RD init -> ${Root} ===`));

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

  const test = preset !== null && preset !== undefined ? preset : tpl.test;

  // 没有任何语言标记文件时，这套门是猜的（默认按 node）。标记出来，让阶段 1 必须回来解决。
  const markers = ['Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'package.json'];
  let hasMarker = false;
  for (const mk of markers) { if (fs.existsSync(path.join(Root, mk))) { hasMarker = true; break; } }

  const outCfg = {
    test,
    _note: `由 init-rd 按项目类型 [${kind}] 生成。按你的项目改。required=false 只警告不阻塞。顺序即执行顺序，越便宜的放越前面。`,
  };
  if (!hasMarker) {
    outCfg._provisional = true;
    outCfg._provisionalNote = '⚠️ 目录里没有任何语言标记文件（Cargo.toml / go.mod / pyproject.toml / requirements.txt / package.json），上面这套门是**猜的**（默认按 node）。技术选型是阶段 1 的事 —— rd-plan 仲裁完之后必须回来改掉这份配置并删除本标记。在此之前，测试层验的是一个还没被决定的技术栈。';
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
  out(C.dark('             对  -Cmd "node --test .rd/features/{feature}/tests/*.test.js --test-name-pattern=<feature>\\sAC-1" -MustMatch "<feature> AC-1"'));
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
for (const g of (Array.isArray(gatesCfg.test) ? gatesCfg.test : [])) {
  if (g.kind === 'syntax') {
    out(C.dark(`    ✓ ${g.name}: 内建语法门，无需外部命令`));
    continue;
  }
  let code;
  let errText = '';
  try {
    const r = spawnSync(String(g.cmd), { cwd: Root, shell: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    code = r.error ? -1 : (r.status === null ? -1 : r.status);
    errText = r.stderr ? r.stderr.toString('utf8') : '';
  } catch (e) {
    code = -1;
  }

  /* ⚠ Windows 上 spawnSync 返回的是**无符号 32 位**退出码：
     一个失败进程可能报成 4294963238，而它其实是 -4058。
     旧判据只认 127 / 9009 / -1，于是这类「压根没跑起来」被判成「✓ 可执行」——
     和「freeze 冻出空 diff」同一个形状：门坏了却报绿，
     而绿是这条流水线上最不该被伪造的信号。 */
  const norm = code > 0x7fffffff ? (code | 0) : code;

  /* ⛔ 不要靠 stderr 的文案判断「命令不存在」。
     cmd.exe 用**系统代码页**输出（中文 Windows 是 GBK），按 utf8 解出来是乱码，
     匹配中文错误串必然落空 —— 这个坑本身就是写这段时踩出来的。
     只留 ASCII 且跨 shell 稳定的几个标记，其余一律靠退出码分档。 */
  const asciiNotFound = /not recognized|command not found|ENOENT|No such file/i.test(errText);
  const cannotRun = norm === 127 || norm === 9009 || norm < 0 || asciiNotFound;

  if (code === 0) {
    out(C.dark(`    ✓ ${g.name}: 可执行且当前通过`));
  } else if (cannotRun) {
    out(C.yellow(`    ⚠ ${g.name}: 命令跑不起来 (exit ${code}${norm !== code ? ` → 归一 ${norm}` : ''}) — ${g.cmd}`));
    out(C.yellow('      测试层会一直挂在这里。装好依赖或改掉这条命令。'));
  } else {
    /* 退出码非 0 但不在上面那几个已知形态里。**这里不许猜**：
       Windows 的 cmd.exe 对「命令根本不存在」返回的也是 1，
       而它的错误文案是系统代码页编码的（中文 Windows 上按 utf8 解出来是乱码），
       所以脚本没有可靠办法区分「命令不存在」和「lint 真的有问题」。
       原先这里写「确认这是预期的（比如测试还没写）」—— 对一个拼错的命令说这句话，
       等于把人往错误方向推。分不清就说分不清，两条排查路径都给出来。 */
    out(C.yellow(`    ⚠ ${g.name}: 当前不通过 (exit ${code}) — ${g.cmd}`));
    out(C.dark('      测试层会在这条门 FAIL。两种可能，都要排查：'));
    out(C.dark('        ① 命令不存在或依赖没装（Windows 下这种情况也返回 exit 1，看不出来）'));
    out(C.dark('        ② 命令跑通了但检查没过（测试还没写、lint 真有问题）'));
    out(C.dark('      手动跑一遍这条命令，看输出属于哪种。'));
  }
  const firstLine = errText.split(/\r?\n/).filter((x) => x.trim())[0];
  if (code !== 0 && firstLine) out(C.dark(`      stderr: ${firstLine.substring(0, 120)}`));
}

out('');
out(C.dark('  ⛔ .rd/ 的 git 策略由开发者自行决定 —— skill 不写 .gitignore、不做忽略决定。'));
out(C.dark('     要不要把 .rd/（spec / design / acceptance / 报告 / AC 测试）提交进 git，你说了算。'));
out(C.dark('     freeze 无论 .rd/ 是否被忽略，都会排除它的运行产物、单独从磁盘收集测试，流程不受影响。'));
out('');
out(C.green('=== 完成。在 Claude Code 里调用 /rd 开始 ==='));
out('');
process.exit(0);
out(C.green('=== 完成。在 Claude Code 里调用 /rd 开始 ==='));
out('');
process.exit(0);
