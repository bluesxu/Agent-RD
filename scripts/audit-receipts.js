#!/usr/bin/env node
/*
  audit-receipts —— 逐份审计 Builder 结构化回执（取代编排者手工对账）。

  每份 reports/receipts/{taskId}.json 校验三件事：
    1. 必填字段齐全（taskId / filesChanged / selfCheckCommand / selfCheckOutput / deviations）
    2. selfCheckOutput 非空白、非占位符 —— 回执说「自检过了」不能只有一句话
    3. filesChanged ⊆ tasks.json 的 files 白名单 —— 自报的改动在不在任务书范围内

  回执自述是线索不是证据 —— 越界文件的最终证据看 boundary-check 的 git diff，
  这里只做结构对账。

  用法：
    node audit-receipts.js -Feature {slug}

  退出码：0 = 全部回执合规；1 = 有问题；2 = 用不了（feature 缺失 / 无回执目录）。
*/
'use strict';

const fs = require('fs');
const path = require('path');

const RECEIPT_FIELDS = ['taskId', 'filesChanged', 'selfCheckCommand', 'selfCheckOutput', 'deviations'];
const PLACEHOLDER_RE = /\{[^{}]*\}/;

const isTty = process.stdout.isTTY;
const C = {
  red: (s) => (isTty ? '\x1b[31m' + s + '\x1b[0m' : s),
  green: (s) => (isTty ? '\x1b[32m' + s + '\x1b[0m' : s),
  yellow: (s) => (isTty ? '\x1b[33m' + s + '\x1b[0m' : s),
  dark: (s) => (isTty ? '\x1b[90m' + s + '\x1b[0m' : s),
  cyan: (s) => (isTty ? '\x1b[36m' + s + '\x1b[0m' : s),
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
    else if (key === 'feature') args.Feature = val;
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));
const Root = args.Root || process.cwd();
const Feature = args.Feature || '';

if (!Feature) {
  out(C.red('[audit-receipts] 缺少 -Feature'));
  process.exit(2);
}

const fdir = path.join(Root, '.rd', 'features', Feature);
if (!fs.existsSync(fdir)) {
  out(C.red(`[audit-receipts] 找不到 ${fdir}`));
  process.exit(2);
}

// ---- tasks.json 白名单：taskId → files（小写、正斜杠基准）----
const whitelist = {};
const tasksPath = path.join(fdir, 'tasks.json');
if (fs.existsSync(tasksPath)) {
  try {
    const t = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
    for (const task of (Array.isArray(t.tasks) ? t.tasks : [])) {
      whitelist[task.id] = new Set(
        (Array.isArray(task.files) ? task.files : []).map((f) => String(f).replace(/\\/g, '/').toLowerCase())
      );
    }
  } catch (e) { /* 无 tasks.json 时白名单为空，filesChanged 校验退化为「必须有内容」 */ }
}

const receiptsDir = path.join(fdir, 'reports', 'receipts');
if (!fs.existsSync(receiptsDir)) {
  out(C.yellow('[audit-receipts] 无回执目录 —— 没有 Builder 回执可审计。'));
  out(C.dark('               若 build 已声称完成却没有回执，先查 run.json 的 inflight 对账。'));
  process.exit(2);
}

function hasMeaning(v) {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0 && v.some((x) => hasMeaning(x));
  const s = String(v).replace(/\{[^{}]*\}/g, '').replace(/[\s|`>*_#-]/g, '');
  return s.length > 0;
}

const files = fs.readdirSync(receiptsDir).filter((n) => n.endsWith('.json')).sort();
out('');
out(C.cyan(`=== 回执审计 [${Feature}]（${files.length} 份）===`));

const issues = [];
const warnings = [];

for (const n of files) {
  const full = path.join(receiptsDir, n);
  let obj;
  try { obj = JSON.parse(fs.readFileSync(full, 'utf8')); }
  catch (e) { issues.push(`${n}  JSON 解析失败：${e.message}`); continue; }
  if (obj === null || typeof obj !== 'object') { issues.push(`${n}  顶层不是对象`); continue; }

  // 必填字段
  for (const f of RECEIPT_FIELDS) {
    const v = obj[f];
    if (v === null || v === undefined) { issues.push(`${n}  缺必填字段 ${f}`); continue; }
    if (!hasMeaning(v)) { issues.push(`${n}  字段 ${f} 是空壳（空白或占位符）`); }
  }
  if (PLACEHOLDER_RE.test(String(obj.selfCheckOutput === undefined ? '' : obj.selfCheckOutput))) {
    issues.push(`${n}  selfCheckOutput 是占位符（${obj.selfCheckOutput}）—— 不是真实输出`);
  }

  // filesChanged ⊆ 白名单（按 taskId 对号入座）
  const wl = whitelist[obj.taskId];
  if (Array.isArray(obj.filesChanged)) {
    for (const fc of obj.filesChanged) {
      const norm = String(fc).replace(/\\/g, '/').toLowerCase();
      if (wl && !wl.has(norm)) {
        issues.push(`${n}  filesChanged 里的 ${fc} 不在 task ${obj.taskId} 的 files 白名单里`);
      }
    }
  }
}

for (const w of warnings) out(C.yellow('  WARN  ' + w));

if (issues.length === 0) {
  out(C.green(`  ✓ ${files.length} 份回执全部合规`));
  out('');
  out(C.green('=== 回执审计 PASS ==='));
  out('');
  process.exit(0);
}

out('');
for (const i of issues) out(C.red('  ✗ ' + i));
out('');
out(C.red(`=== 回执审计 FAIL（${issues.length} 处）—— 打回补证据，不许重做 ===`));
out('');
process.exit(1);
