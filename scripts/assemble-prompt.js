#!/usr/bin/env node
/*
  assemble-prompt —— 从 tasks.json 的 task + design.md + acceptance.json + builder.md 模板
  生成自包含的 Builder prompt。

  编排者只补两样 builder.md 里没有的东西：「切入角度」和「读到的真实接口签名」
  （本脚本产出的是模板骨架，契约片段在 contracts.json 落地后由改动三拼接）。

  用法：
    node assemble-prompt.js -Feature {slug} -Task T1

  输出：拼好的 prompt 文本到 stdout。退出码：0 = 成功；2 = 用不了（缺参数/文件缺失）。
*/
'use strict';

const fs = require('fs');
const path = require('path');

const isTty = process.stdout.isTTY;
const C = {
  red: (s) => (isTty ? '\x1b[31m' + s + '\x1b[0m' : s),
  yellow: (s) => (isTty ? '\x1b[33m' + s + '\x1b[0m' : s),
};
function err(s) { process.stderr.write((isTty ? '\x1b[31m' : '') + s + (isTty ? '\x1b[0m' : '') + '\n'); }

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
    else if (key === 'task') args.Task = val;
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));
const Root = path.resolve(args.Root || process.cwd());
const Feature = args.Feature || '';
const TaskId = args.Task || '';

if (!Feature || !TaskId) {
  err('缺少 -Feature 或 -Task');
  process.exit(2);
}

const fdir = path.join(Root, '.rd', 'features', Feature);
const HERE = __dirname;
const builderTpl = path.join(HERE, '..', 'skills', 'rd-build', 'references', 'prompts', 'builder.md');

function readJson(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

// ---- task ----
const tasks = readJson(path.join(fdir, 'tasks.json'));
const task = tasks && Array.isArray(tasks.tasks) ? tasks.tasks.find((t) => t.id === TaskId) : null;
if (!task) {
  err(`tasks.json 里找不到 task ${TaskId}`);
  process.exit(2);
}

// ---- design.md 的「选定方案」和「契约变化」两节 ----
function extractSection(md, title) {
  const lines = String(md).split(/\r?\n/);
  const out = [];
  let capturing = false;
  for (const ln of lines) {
    const m = ln.match(/^#{1,6}\s+(.*)$/);
    if (m) {
      if (m[1].trim() === title) { capturing = true; continue; }
      if (capturing) break;
    }
    if (capturing) out.push(ln);
  }
  return out.join('\n').trim();
}
let designSections = '';
const designPath = path.join(fdir, 'design.md');
if (fs.existsSync(designPath)) {
  const md = fs.readFileSync(designPath, 'utf8');
  const chosen = extractSection(md, '选定方案');
  const contract = extractSection(md, '契约变化');
  designSections = (chosen ? '## 选定方案\n' + chosen : '(design.md 缺「选定方案」)')
    + '\n\n' + (contract ? '## 契约变化\n' + contract : '(design.md 缺「契约变化」)');
} else {
  designSections = '(缺 design.md —— 方案与契约无法摘录)';
}

// ---- 本 task covers 的 AC ----
const ac = readJson(path.join(fdir, 'acceptance.json'));
const scenarios = ac && Array.isArray(ac.scenarios) ? ac.scenarios : [];
const covered = scenarios.filter((s) => Array.isArray(task.covers) && task.covers.indexOf(s.id) >= 0);
const acText = covered.length > 0
  ? covered.map((s) =>
      `### ${s.id} ${s.name || ''}\n`
      + `- given: ${s.given || ''}\n`
      + `- when: ${s.when || ''}\n`
      + `- then: ${s.then || ''}\n`
      + `- judge: ${s.judge || ''}\n`
      + `- checkIntent: ${s.checkIntent || ''}\n`
      + (s.check ? `- check: ${s.check}\n` : '')
    ).join('\n')
  : `（task ${TaskId} 的 covers 没有命中任何 acceptance.json 场景 —— 确认 covers 写对了）`;

// ---- 本 task 相关的契约片段（contracts.json 里它是 producer 或 consumer）----
let contractText = '';
const contractsCfg = readJson(path.join(fdir, 'contracts.json'));
const contracts = contractsCfg && Array.isArray(contractsCfg.contracts) ? contractsCfg.contracts : [];
const myContracts = contracts.filter((c) =>
  (Array.isArray(c.producers) && c.producers.indexOf(task.id) >= 0) ||
  (Array.isArray(c.consumers) && c.consumers.indexOf(task.id) >= 0)
);
if (myContracts.length > 0) {
  contractText = '（跨任务契约 —— 你与上下游的接口约定，照它写，别自己发明）\n' + myContracts.map((c) =>
    `### ${c.id} ${c.name || ''} [${c.kind || ''}]\n`
    + `- pattern: ${c.pattern || ''}\n`
    + `- files: ${(Array.isArray(c.files) ? c.files : []).join(', ')}\n`
    + `- producers: ${(Array.isArray(c.producers) ? c.producers : []).join(', ')}\n`
    + `- consumers: ${(Array.isArray(c.consumers) ? c.consumers : []).join(', ')}\n`
    + (c.note ? `- note: ${c.note}\n` : '')
  ).join('\n');
} else {
  contractText = '（本 task 不涉及跨任务契约）';
}

// ---- 模板 ----
if (!fs.existsSync(builderTpl)) {
  err(`找不到 builder 模板 ${builderTpl}`);
  process.exit(2);
}
let tpl = fs.readFileSync(builderTpl, 'utf8');

const replace = {
  '{task.id}': task.id,
  '{task.name}': task.name || '',
  '{绝对路径}': Root,
  '{slug}': Feature,
  '{task.files 逐行列出}': (Array.isArray(task.files) ? task.files : []).join('\n'),
  '{design.md 的「选定方案」和「契约变化」两节全文}': designSections,
  '{本 task covers 的那几条 AC 的完整内容}': acText,
  '{本 task 相关的契约片段}': contractText,
  '{task.steps}': (Array.isArray(task.steps) ? task.steps : []).join('\n'),
  '{task.selfCheck}': task.selfCheck || '(缺 selfCheck)',
};

let missing = false;
for (const k of Object.keys(replace)) {
  if (!tpl.includes(k)) { missing = true; }
  tpl = tpl.split(k).join(replace[k]);
}

if (missing) {
  err('警告：模板里有占位符没被本脚本替换（模板与脚本不同步）。产物里残留 {xxx}。');
}

process.stdout.write(tpl);
process.exit(0);
