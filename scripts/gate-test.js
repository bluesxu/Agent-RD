#!/usr/bin/env node
/*
  gate-test —— 测试层，零 LLM 成本。

  职责：
    1. 跑审查层写的全部 AC 测试 —— acceptance.json 里 judge=machine 的每条 AC 的
       check 命令（带 -MustMatch 锚点，唯一官方执行）。Builder 不跑测试，
       验收层不重跑 machine AC —— 每次 fix 后测试层重跑，机械判定不丢。
    2. check-artifacts 文档校验（RD-DONE / 必填小节 / 回执字段）—— 审查层报告必须
       完整（末行 RD-DONE + 四节有内容）、孤儿证据必须清零。

  原「L1 机械门」的语法门移除 —— 语法检查下沉到 Builder 完成门（node --check / tsc --noEmit）。

  用法：
    node gate-test.js
    node gate-test.js -Feature user-login -Round 2

  退出码：0 = PASS；1 = FAIL（有测试失败 / 审查层报告未写完 / 孤儿证据）；
          2 = 配置缺失 / 上次被中断在半路。
*/
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const isTty = process.stdout.isTTY;
const C = {
  gray: (s) => (isTty ? '\x1b[90m' + s + '\x1b[0m' : s),
  dark: (s) => (isTty ? '\x1b[90m' + s + '\x1b[0m' : s),
  red: (s) => (isTty ? '\x1b[31m' + s + '\x1b[0m' : s),
  green: (s) => (isTty ? '\x1b[32m' + s + '\x1b[0m' : s),
  yellow: (s) => (isTty ? '\x1b[33m' + s + '\x1b[0m' : s),
  cyan: (s) => (isTty ? '\x1b[36m' + s + '\x1b[0m' : s),
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
let Feature = args.Feature || '';
const Round = args.Round;

function asArr(v) { return Array.isArray(v) ? v : (v === null || v === undefined ? [] : [v]); }
function isBlank(s) { return s === null || s === undefined || String(s).trim() === ''; }

// ---- Feature 缺省：只有一个 feature 时直接用 ----
if (!Feature) {
  const featRoot = path.join(Root, '.rd', 'features');
  let dirs = [];
  try {
    dirs = fs.readdirSync(featRoot).filter((d) => {
      try { return fs.statSync(path.join(featRoot, d)).isDirectory(); } catch { return false; }
    });
  } catch { dirs = []; }
  if (dirs.length === 1) Feature = dirs[0];
}

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

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

const checkArt = path.join(__dirname, 'check-artifacts.js');

// ---- 文档校验（一次 -Json 既做 inflight 前置，也做收尾判定）----
/*
  check-artifacts -Json 的输出结构：{ stages:[{name,label,missing}], orphans:[], inflight, ... }。
  测试层阶段的文档校验只盯两件事：
    1. 审查层报告（review stage）必须完整 —— 末行 RD-DONE + 四节有内容，否则审到一半。
    2. 孤儿证据必须清零 —— evidence/ 下的无主文件会被后人误当有效依据。
  其余 stage 的缺失（验收层还没跑、spec 阶段产物等）在测试层阶段是正常的，不判。
*/
let docReviewMissing = [];
let docOrphans = [];
let docJson = '';
let inflightBlocked = false;
if (exists(checkArt)) {
  const r = spawnSync(process.execPath, [checkArt, '-Root', Root, '-Feature', Feature, '-Json'], {
    cwd: Root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  docJson = r.stdout ? r.stdout.toString('utf8') : '';
  let info = null;
  try { info = JSON.parse(docJson); } catch (e) { info = null; }
  if (info !== null) {
    if (info.inflight) {
      inflightBlocked = true;
    } else {
      const review = asArr(info.stages).find((s) => s.name === 'review');
      if (review) docReviewMissing = asArr(review.missing);
      docOrphans = asArr(info.orphans);
    }
  }
}

if (inflightBlocked) {
  out(docJson);
  out(C.red('[Test] 中止：上次运行被中断在半路。'));
  out(C.red('     先按上面的 inflight 收尾，把 run.json 的 inflight 清成 null，再跑测试层。'));
  out(C.dark('     在没收尾的状态下跑测试，绿了也不知道绿的是哪一版。'));
  process.exit(2);
}

// ---- 配置：acceptance.json ----
const acPath = path.join(Root, '.rd', 'features', Feature, 'acceptance.json');
if (!exists(acPath)) {
  out(C.red(`[Test] 找不到 ${acPath}`));
  out(C.yellow('     测试由审查层写在 acceptance.json 的 machine AC 里，测试层从这里取。'));
  out(C.yellow('     先跑 rd-spec + rd-plan + rd-build（审查层写测试），再回来跑测试层。'));
  process.exit(2);
}

let ac = null;
try { ac = JSON.parse(fs.readFileSync(acPath, 'utf8')); }
catch (e) {
  out(C.red(`[Test] acceptance.json 不是合法 JSON: ${e.message}`));
  process.exit(2);
}

// ---- 跑审查层写的全部测试：每条 machine AC 的 check（带 -MustMatch 锚点）----
// 改动十一（L1 失败批量修）已吸收：gate-test **无条件收集全部失败**，不 early-exit ——
// 每条 AC 是独立测试，全量收集给 owner/审查层完整失败面，比逐个修逐个重跑省一轮。
// -ContinueOnFailure 旗标保留仅作向后兼容，跑不跑都一样。
const machineACs = asArr(ac.scenarios).filter((s) => s.judge === 'machine' && !isBlank(s.check));

out('');
out(C.cyan(`=== 测试层 (${machineACs.length} 条 machine AC) ===`));

const results = [];
let testFailed = false;
const tailLines = 25;

for (const s of machineACs) {
  out('');
  out(C.gray(`  -> ${s.id}: ${s.check}`));
  const t0 = Date.now();
  const r = runShell(String(s.check), Root);
  const seconds = Math.round(((Date.now() - t0) / 1000) * 10) / 10;
  const lines = r.text.split(/\r?\n/);
  const tail = lines.length > tailLines ? lines.slice(-tailLines).join('\n') : r.text;
  const ok = r.code === 0;
  if (!ok) testFailed = true;
  results.push({ ac: s.id, cmd: String(s.check), exitCode: r.code, ok, seconds, tail: tail.replace(/\s+$/, '') });
  if (ok) {
    out(C.green(`     PASS  (${seconds}s)`));
  } else {
    out(C.red(`     FAIL  exit=${r.code}  (${seconds}s)`));
  }
}

if (machineACs.length === 0) {
  out(C.yellow('  ⚠ 没有任何 machine AC 的 check —— 本 feature 的测试要么全是 agent 判定'));
  out(C.yellow('   （那归验收层），要么审查层还没写。继续做文档校验。'));
}

// ---- 落盘 l1-round{N}.json（数据模型保留 l1 命名）----
const report = {
  stage: 'l1', feature: Feature, round: Round, verdict: testFailed ? 'fail' : 'pass',
  ts: new Date().toISOString(),
  tests: results.map((x) => ({ ac: x.ac, exitCode: x.exitCode, ok: x.ok, seconds: x.seconds })),
  docReviewMissing,
  docOrphans,
};
if (Feature) {
  const dir = path.join(Root, '.rd', 'features', Feature, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `l1-round${Round}.json`), JSON.stringify(report, null, 2), 'utf8');
  out('');
  out(C.dark(`  报告: .rd/features/${Feature}/reports/l1-round${Round}.json`));
}

// ---- 文档校验判定 ----
const docFailed = docReviewMissing.length > 0 || docOrphans.length > 0;
if (docReviewMissing.length > 0) {
  out('');
  out(C.red(`  ⛔ 审查层报告未写完（${docReviewMissing.length} 项）—— 审到一半的 diff 不能往下走：`));
  for (const m of docReviewMissing) out(C.red('      · ' + m));
}
if (docOrphans.length > 0) {
  out('');
  out(C.red(`  ⛔ 孤儿证据 ${docOrphans.length} 个 —— 在 evidence/ 里但没有任何报告引用：`));
  for (const o of docOrphans) out(C.red('      · ' + o));
}

const verdict = (testFailed || docFailed) ? 'fail' : 'pass';
out('');
if (verdict === 'pass') {
  out(C.green('=== 测试层 PASS —— 可以进入验收层 ==='));
} else {
  out(C.red('=== 测试层 FAIL ==='));
  if (testFailed) {
    out('');
    for (const r of results.filter((x) => !x.ok)) {
      out(C.red(`--- ${r.ac} (exit ${r.exitCode}) ---`));
      out(r.tail);
      out('');
    }
  }
}
out('');

process.exit(verdict === 'pass' ? 0 : 1);
