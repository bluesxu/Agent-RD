#!/usr/bin/env node
/*
  verify-contracts —— 契约 vs 实现的机械对账（改动三的防漂移闸）。

  契约先行省时间的前提是「契约不被实现悄悄破坏」。这个脚本在全部任务完成后
  对 contracts.json 声明的每个契约做字面量抽检：pattern 必须在声明的 files 里出现。
  缺一个 → 报错，交由审查层处理（contract-drift）。

  pattern 是纯字面量（函数名 / 字段名 / DOM id / 配置键），不当正则 ——
  「字段在不在」用字面量 grep 就够，正则反而引入误判面。

  用法：
    node verify-contracts.js -Feature {slug}

  退出码：0 = 全部契约满足；1 = 有契约被破坏/文件缺失；2 = 用不了（contracts.json 缺失）。
*/
'use strict';

const fs = require('fs');
const path = require('path');

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

function asArr(v) { return Array.isArray(v) ? v : (v === null || v === undefined ? [] : [v]); }
function isBlank(s) { return s === null || s === undefined || String(s).trim() === ''; }

if (!Feature) {
  out(C.red('[verify-contracts] 缺少 -Feature'));
  process.exit(2);
}

const contractsPath = path.join(Root, '.rd', 'features', Feature, 'contracts.json');
if (!fs.existsSync(contractsPath)) {
  out(C.yellow('[verify-contracts] 无 contracts.json —— 本 feature 没有契约（或没做契约先行），跳过。'));
  process.exit(2);
}

let cfg;
try { cfg = JSON.parse(fs.readFileSync(contractsPath, 'utf8')); }
catch (e) {
  out(C.red(`[verify-contracts] contracts.json 不是合法 JSON: ${e.message}`));
  process.exit(1);
}

const contracts = asArr(cfg.contracts);
out('');
out(C.cyan(`=== 契约对账 [${Feature}]（${contracts.length} 条）===`));

const issues = [];

for (const c of contracts) {
  const id = c.id || '(缺 id)';
  if (isBlank(c.pattern)) { issues.push(`${id}  缺 pattern（机械抽检字面量）`); continue; }
  const files = asArr(c.files);
  if (files.length === 0) { issues.push(`${id}  缺 files（pattern 该在哪些文件里出现）`); continue; }

  for (const f of files) {
    const full = path.join(Root, String(f).replace(/\\/g, '/'));
    if (!fs.existsSync(full)) {
      issues.push(`${id}  文件不存在: ${f} —— 契约落地的文件没被实现出来`);
      continue;
    }
    let txt;
    try { txt = fs.readFileSync(full, 'utf8'); } catch (e) { issues.push(`${id}  读不了 ${f}: ${e.message}`); continue; }
    if (txt.indexOf(String(c.pattern)) < 0) {
      issues.push(`${id}  在 ${f} 里找不到字面量 "${c.pattern}" —— 契约被实现悄悄破坏（contract-drift）`);
    }
  }
}

if (issues.length === 0) {
  out(C.green(`  ✓ ${contracts.length} 条契约全部被实现兑现`));
  out('');
  out(C.green('=== 契约对账 PASS ==='));
  out('');
  process.exit(0);
}

out('');
for (const i of issues) out(C.red('  ✗ ' + i));
out('');
out(C.red(`=== 契约对账 FAIL（${issues.length} 处）—— 交审查层按 contract-drift 处理 ===`));
out('');
process.exit(1);
