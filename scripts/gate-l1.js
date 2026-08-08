#!/usr/bin/env node
/*
  gate-l1 —— L1 机械门，零 LLM 成本的第一道闸。

  按 .rd/gates.json 里的顺序逐条执行命令，任一 required 项失败即整体失败。
  命令越便宜的放越前面，早失败早退出，省下后面所有审查 token。

  用法：
    node gate-l1.js
    node gate-l1.js -Feature user-login -Round 2
    node gate-l1.js -Feature user-login -Round 2 -ContinueOnFailure

  退出码：0 = PASS；1 = FAIL；2 = 配置缺失 / 上次被中断在半路。
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
  const args = { Round: 1, ContinueOnFailure: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-ContinueOnFailure' || a === '--ContinueOnFailure') { args.ContinueOnFailure = true; continue; }
    const m = a.match(/^--?([A-Za-z]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = m[2];
    if (val === undefined && i + 1 < argv.length && !/^--?/.test(argv[i + 1])) val = argv[++i];
    if (key === 'root') args.Root = val;
    else if (key === 'feature') args.Feature = val;
    else if (key === 'round') args.Round = parseInt(val, 10) || 1;
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));
const Root = args.Root || process.cwd();
const Feature = args.Feature || '';
const Round = args.Round;

// 跑一条命令：shell=true 让 Node 选 cmd / sh。合并 stdout+stderr，返回 {code, text}。
function runShell(cmd, cwd) {
  try {
    const r = spawnSync(cmd, { cwd, shell: true, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    if (r.error) return { code: 1, text: String(r.error) };
    const so = r.stdout ? r.stdout.toString('utf8') : '';
    const se = r.stderr ? r.stderr.toString('utf8') : '';
    return { code: r.status === null ? 1 : r.status, text: so + (se ? '\n' + se : '') };
  } catch (e) {
    return { code: 1, text: String(e && e.message ? e.message : e) };
  }
}

const configPath = path.join(Root, '.rd', 'gates.json');
if (!fs.existsSync(configPath)) {
  out(C.red(`[L1] 找不到 ${configPath}`));
  out(C.yellow('     先跑 init-rd.js，或从 templates/gates.json 复制一份。'));
  process.exit(2);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  out(C.red(`[L1] gates.json 不是合法 JSON: ${e.message}`));
  process.exit(2);
}
const gates = Array.isArray(config.l1) ? config.l1 : [];
if (gates.length === 0) {
  out(C.red('[L1] gates.json 的 l1 为空，没有可执行的机械门。'));
  process.exit(2);
}

// ---- 前置：上次是不是被中断在半路 ----
// 寄生于 L1 的理由：L1 是每轮第一道闸，绕不过去。只硬拦 inflight（退出码 2），产物缺失只警告。
const checkArt = path.join(__dirname, 'check-artifacts.js');
if (fs.existsSync(checkArt)) {
  const caArgv = [checkArt, '-Root', Root];
  if (Feature) caArgv.push('-Feature', Feature);
  let caCode = 0;
  let caOut = '';
  try {
    const r = spawnSync(process.execPath, caArgv, { cwd: Root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    caCode = r.status === null ? 0 : r.status;
    caOut = (r.stdout ? r.stdout.toString('utf8') : '');
  } catch (e) {
    caCode = 0; caOut = '';
  }
  if (caCode === 2) {
    out(caOut);
    out(C.red('[L1] 中止：上次运行被中断在半路。'));
    out(C.red('     先按上面的 inflight 收尾，把 run.json 的 inflight 清成 null，再跑 L1。'));
    out(C.dark('     在没收尾的状态下跑门，绿了也不知道绿的是哪一版。'));
    process.exit(2);
  }
  if (caCode === 3) {
    out(C.yellow('[L1] ⚠ 存在孤儿证据（evidence/ 下有文件没被任何报告引用）。'));
    out(C.dark('     跑 check-artifacts.js 看清单 —— 要么在报告里认领，要么删掉。'));
  }
}

out('');
out(C.cyan(`=== L1 机械门 (${gates.length} 项) ===`));

const results = [];
let failed = false;
const tailLines = 40;

for (const g of gates) {
  const required = g.required === undefined || g.required === null ? true : Boolean(g.required);

  out('');
  out(C.gray(`  -> ${g.name}: ${g.cmd}`));

  const t0 = Date.now();
  const { code: rawCode, text: text } = runShell(g.cmd, Root);
  const seconds = Math.round(((Date.now() - t0) / 1000) * 10) / 10;

  let lines = text.split(/\r?\n/);
  let tail = lines.length > tailLines ? lines.slice(-tailLines).join('\n') : text;

  let ok = rawCode === 0;
  let code = rawCode;

  // 防「空过」：退出码 0 不等于真的检查了东西。mustMatch 声明「输出里必须出现什么」。
  if (ok && g.mustMatch !== undefined && g.mustMatch !== null && String(g.mustMatch).trim() !== '') {
    if (text.indexOf(String(g.mustMatch)) < 0) {
      ok = false;
      code = -100;
      tail = `[gate-l1] 命令退出码为 0，但输出里找不到 "${g.mustMatch}" —— 判定为空过。\n` +
             '          很可能是没有文件可检查、或没有测试被收集到。\n\n' + tail;
    }
  }

  results.push({
    name: g.name, cmd: g.cmd, required, exitCode: code, ok, seconds, tail: tail.replace(/\s+$/, ''),
  });

  if (ok) {
    out(C.green(`     PASS  (${seconds}s)`));
  } else if (required) {
    out(C.red(`     FAIL  exit=${code}  (${seconds}s)`));
    failed = true;
    if (!args.ContinueOnFailure) {
      out(C.dark('     后续项跳过（early exit）。加 -ContinueOnFailure 可跑完全部。'));
      break;
    }
  } else {
    out(C.yellow(`     WARN  exit=${code}（非阻塞项）`));
  }
}

const verdict = failed ? 'fail' : 'pass';

const report = {
  stage: 'l1', feature: Feature, round: Round, verdict,
  ts: new Date().toISOString(), gates: results,
};

if (Feature) {
  const dir = path.join(Root, '.rd', 'features', Feature, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `l1-round${Round}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  out('');
  out(C.dark(`  报告: ${outPath}`));
}

out('');
if (verdict === 'pass') {
  out(C.green('=== L1 PASS —— 可以进入 L2 异构审查 ==='));
} else {
  out(C.red('=== L1 FAIL —— 不要派 reviewer，先把机械问题修掉 ==='));
  out('');
  for (const r of results.filter((x) => !x.ok && x.required)) {
    out(C.red(`--- ${r.name} (exit ${r.exitCode}) ---`));
    out(r.tail);
    out('');
  }
}
out('');

process.exit(verdict === 'pass' ? 0 : 1);
