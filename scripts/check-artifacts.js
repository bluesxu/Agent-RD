#!/usr/bin/env node
/*
  check-artifacts —— 产物清单校验：回答「我现在在哪一步、该有的东西缺了什么、有没有无主的证据」。

  存在理由（两条实跑教训）：
    1. 中断是常态。配额窗口下反复被打断，恢复全靠翻文件猜进度。
    2. 要求写在那儿，但没人检查有没有照做。run.json / 每轮追加 / 报告正文，三处都落空过。

  这个脚本不加新要求，只把已有要求变成可执行的检查。

  用法：
    node check-artifacts.js [-Root <dir>] [-Feature <slug>] [-Json]

  退出码（validate-plan 与 gate-l1 依赖这个划分，不要改动语义）：
    0  干净
    1  有产物缺失
    2  **上一次运行被中断在半路**（run.json 的 inflight 非空）—— 唯一无歧义的硬阻塞信号
    3  产物齐全但有待处置项（孤儿证据 / 记录对不上 / 框架漂移 / 流程外动作无裁决）
    4  用不了（找不到 .rd / feature 不明确 / feature 目录不存在）

  **2 只能表示 inflight，不许复用。**
*/
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

// ---- 参数解析：兼容 -Key value 与 --Key=value；-Json 是开关 ----
function parseArgs(argv) {
  const args = { Json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-Json' || a === '--Json') { args.Json = true; continue; }
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
let Feature = args.Feature || '';

// ---- 小工具 ----
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function listDirFiles(dir, filter) {
  // 返回 [name]，只文件，filter 可选 (name)=>bool
  if (!isDir(dir)) return [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile()); }
  catch { return []; }
  if (filter) names = names.filter(filter);
  return names;
}
function listDirDirs(dir) {
  if (!isDir(dir)) return [];
  try { return fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory()); }
  catch { return []; }
}
function walkFiles(dir) {
  // 递归返回绝对路径数组
  const acc = [];
  if (!isDir(dir)) return acc;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) acc.push(full);
    }
  }
  return acc;
}
function readJsonFile(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function readText(p) {
  return fs.readFileSync(p, 'utf8');
}
function asList(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : [v];
}

const rd = path.join(Root, '.rd');
if (!exists(rd)) {
  out(C.red(`找不到 ${rd} —— 这个目录不是 Agent-RD 项目，或者还没跑 init-rd。`));
  process.exit(4);
}

// ---- 定位 feature ----
const featRoot = path.join(rd, 'features');
if (!Feature) {
  const dirs = listDirDirs(featRoot);
  if (dirs.length === 1) {
    Feature = dirs[0];
  } else if (dirs.length === 0) {
    out(C.yellow(`${featRoot} 下没有任何 feature。流程还没开始。`));
    process.exit(4);
  } else {
    out(C.yellow('有多个 feature，用 -Feature 指定其中一个：'));
    for (const d of dirs) out('  ' + d);
    process.exit(4);
  }
}

const fdir = path.join(featRoot, Feature);
const reports = path.join(fdir, 'reports');
const evidence = path.join(reports, 'evidence');
if (!isDir(fdir)) {
  out(C.red(`找不到 feature 目录: ${fdir}`));
  process.exit(4);
}

const Has = (p) => exists(path.join(fdir, p));
const HasRoot = (p) => exists(path.join(Root, p));

// ---- 收集各阶段轮次编号 ----
function roundNums(dir, re) {
  if (!isDir(dir)) return [];
  const nums = [];
  for (const n of listDirFiles(dir)) {
    if (!re.test(n)) continue;
    const m = n.match(/round(\d+)/);
    if (m) nums.push(parseInt(m[1], 10));
  }
  return Array.from(new Set(nums)).sort((a, b) => a - b);
}
const l1 = roundNums(reports, /^l1-round.*\.json$/i);
const l2 = roundNums(reports, /^l2-round.*\.md$/i);
const l2d = roundNums(reports, /^l2-round.*\.diff$/i);
const l3 = roundNums(reports, /^l3-round.*\.md$/i);

// ---- run.json ----
const runPath = path.join(fdir, 'run.json');
let run = null;
let runErr = null;
if (exists(runPath)) {
  try { run = readJsonFile(runPath); }
  catch (e) { runErr = e.message; }
}

// ---- lessons ----
const lessonsDir = path.join(rd, 'lessons');
const lessons = listDirFiles(lessonsDir, (n) => n.endsWith('.md'));

// ---- 阶段定义：每个阶段「完成」的判据 ----
const stages = [];
stages.push({
  name: 'dispatch', label: '派发决策',
  missing: [
    ...(!Has('dispatch.md') ? ['dispatch.md  ← rd 要求 ≥M 复杂度落一份派发决策记录（六行）'] : []),
  ],
});
stages.push({
  name: 'spec', label: '业务梳理',
  missing: [
    ...(!Has('spec.md') ? ['spec.md'] : []),
    ...(!Has('acceptance.json') ? ['acceptance.json'] : []),
  ],
});
stages.push({
  name: 'plan', label: '方案与拆解',
  missing: [
    ...(!Has('design.md') ? ['design.md'] : []),
    ...(!Has('tasks.json') ? ['tasks.json'] : []),
    ...(!HasRoot('.rd/gates.json') ? ['.rd/gates.json'] : []),
    ...(!exists(runPath) ? ['run.json  ← rd-plan:101 明文要求「通过后写 run.json」'] : []),
  ],
});
stages.push({
  name: 'build', label: '开发与 L1 机械门',
  missing: [
    ...(l1.length === 0 ? ['l1-round{N}.json  ← 一轮机械门都没跑过'] : []),
  ],
});

// L2：每个存在的 .diff 都必须有对应的 .md
const l2Missing = [];
if (l2.length === 0 && l2d.length === 0) {
  l2Missing.push('l2-round{N}.md + .diff  ← 一轮异构审查都没跑过');
}
for (const n of l2d) {
  if (!l2.includes(n)) {
    l2Missing.push(`l2-round${n}.md  ← .diff 在但报告正文不在。rd-review:91 明文要求写正文`);
  }
}
stages.push({ name: 'review', label: 'L2 异构审查', missing: l2Missing });

stages.push({
  name: 'eval', label: 'L3 场景验收',
  missing: [
    ...(l3.length === 0 ? ['l3-round{N}.md  ← 一轮场景验收都没跑过'] : []),
  ],
});

// keep：允许「本次无采纳」，但必须有痕迹
const keepMissing = [];
const keepRecorded = run !== null && Object.prototype.hasOwnProperty.call(run, 'keep');
if (lessons.length === 0 && !keepRecorded) {
  keepMissing.push('lessons/*.md 或 run.json 里的 keep 记录  ← rd-keep 要求「无采纳也要显式报告」');
}
stages.push({ name: 'keep', label: '经验沉淀', missing: keepMissing });

// ---- inflight ----
let inflight = null;
const inflightAgents = [];
if (run !== null && Object.prototype.hasOwnProperty.call(run, 'inflight') && run.inflight !== null && run.inflight !== undefined) {
  inflight = run.inflight;
  for (const a of asList(inflight.agents)) {
    const rp = a.reportPath;
    let ex = false;
    let size = 0;
    if (rp) {
      const full = path.join(Root, rp);
      if (exists(full)) { ex = true; try { size = fs.statSync(full).size; } catch { size = 0; } }
    }
    inflightAgents.push({
      name: a.name, role: a.role, task: a.task,
      reportPath: rp, reportExists: ex, reportBytes: size,
    });
  }
}

// ---- 框架指纹 ----
function getFrameworkFingerprint(agentRDRoot) {
  const subDirs = ['skills', 'scripts', 'templates'];
  let files = [];
  for (const d of subDirs) {
    const full = path.join(agentRDRoot, d);
    if (!exists(full)) continue;
    files = files.concat(walkFiles(full));
  }
  if (files.length === 0) return null;
  const sorted = files.slice().sort();
  const sha = crypto.createHash('sha256');
  for (const f of sorted) {
    // 路径也进 hash：只改文件名同样算漂移
    const rel = path.relative(agentRDRoot, f).split(path.sep).join('/').replace(/^\//, '');
    sha.update(rel + '\n', 'utf8');
    sha.update(fs.readFileSync(f));
  }
  return { sha256: sha.digest('hex'), fileCount: sorted.length };
}

const fwRoot = path.resolve(__dirname, '..'); // scripts/ 的父目录 = Agent-RD 根
const fwNow = getFrameworkFingerprint(fwRoot);
let fwState = 'unknown'; // captured | same | drifted | acknowledged | unknown
let fwRecorded = null;
if (run !== null && fwNow !== null) {
  fwRecorded = run.frameworkFingerprint;
  if (fwRecorded === null || fwRecorded === undefined || !fwRecorded.sha256) {
    fwState = 'captured';
  } else if (fwRecorded.sha256 === fwNow.sha256) {
    fwState = 'same';
  } else if (run.frameworkDriftAcknowledged) {
    fwState = 'acknowledged';
  } else {
    fwState = 'drifted';
  }
}

// ---- 流程外动作 ----
const oof = run ? asList(run.outOfFlowActions) : [];
const oofNoDecision = [];
let oofFrameworkApproved = false;
for (const a of oof) {
  if (!a.userDecision) {
    oofNoDecision.push(`${a.action} → ${a.target}`);
  }
  if (a.action === 'modify-framework' && a.userDecision === 'approved') {
    oofFrameworkApproved = true;
  }
  if (a.userDecision && !a.ifNotDone) {
    oofNoDecision.push(`${a.action} → ${a.target}（缺 ifNotDone：没写清「不做会怎样」，等于诱导式提问）`);
  }
}

// ---- 结论来源统计 ----
const verdictBy = { agent: 0, orchestrator: 0, human: 0, other: 0 };
if (run !== null) {
  for (const r of asList(run.rounds)) {
    for (const layer of ['l1', 'l2', 'l3']) {
      let by = r[`${layer}_verified_by`];
      if (!by) by = r[`${layer}_judged_by`];
      if (!by) {
        const res = r[layer];
        if (res === null || res === undefined) continue;
        if (typeof res === 'string' && /^not_/.test(res)) continue;
        by = 'agent';
      }
      if (Object.prototype.hasOwnProperty.call(verdictBy, by)) verdictBy[by]++;
      else verdictBy.other++;
    }
  }
}

// ---- 对账：run.json 记的轮次 vs 磁盘上实际存在的轮次产物 ----
const roundGaps = [];
if (run !== null) {
  const recorded = [];
  for (const r of asList(run.rounds)) {
    if (r.round !== null && r.round !== undefined) recorded.push(parseInt(r.round, 10));
  }
  // 正向：磁盘上有产物的轮次，run.json 必须有记录
  const onDisk = Array.from(new Set([...l1, ...l2, ...l3])).sort((a, b) => a - b);
  for (const n of onDisk) {
    if (!recorded.includes(n)) {
      roundGaps.push(`round ${n} 有落盘产物，但 run.json 的 rounds 里没有这一条（rd-build:245 要求每轮结束追加）`);
    }
  }
  // 非 agent 下的判定必须带证据
  for (const r of asList(run.rounds)) {
    for (const layer of ['l1', 'l2', 'l3']) {
      const by = r[`${layer}_verified_by`];
      if (!by) continue;
      if (by === 'agent') continue;
      const ev = r[`${layer}_evidence`];
      if (!ev) {
        roundGaps.push(`round ${r.round} 的 ${layer} 标了 ${layer}_verified_by=${by}，但没有 ${layer}_evidence —— 非 agent 下的判定必须指得出可复核的证据（命令原文 + 原始输出）`);
      }
    }
  }
  // 反向：run.json 自己声称的证据文件必须真的存在
  for (const r of asList(run.rounds)) {
    for (const field of ['l1_evidence', 'l2_evidence', 'l3_evidence']) {
      const v = r[field];
      if (!v) continue;
      for (const piece of String(v).split(/\s*\+\s*/)) {
        const rel = piece.trim();
        if (rel === '' || !/\.(md|json|diff|log)$/.test(rel)) continue;
        const full = path.join(fdir, rel);
        if (!exists(full)) {
          roundGaps.push(`round ${r.round} 的 ${field} 指向 "${rel}"，但该文件不存在 —— 记录里的依据是空的`);
        }
      }
    }
  }
}

// ---- 孤儿证据 ----
const orphans = [];
const evFiles = walkFiles(evidence);
if (evFiles.length > 0) {
  let allText = '';
  for (const rf of listDirFiles(reports, (n) => n.endsWith('.md'))) {
    try { allText += readText(path.join(reports, rf)); } catch { /* ignore */ }
  }
  const allLower = allText.toLowerCase();
  for (const e of evFiles) {
    const nm = path.basename(e);
    if (!allLower.includes(nm.toLowerCase())) orphans.push(nm);
  }
}

// ---- 判定当前进度 ----
const doneStages = [];
let firstIncomplete = null;
for (const s of stages) {
  const m = asList(s.missing);
  if (m.length === 0) {
    if (firstIncomplete === null) doneStages.push(s.label);
  } else {
    if (firstIncomplete === null) firstIncomplete = s;
  }
}
let totalMissing = 0;
for (const s of stages) totalMissing += asList(s.missing).length;

// ---- JSON 输出 ----
if (args.Json) {
  const jsonOut = {
    feature: Feature,
    rounds: { l1, l2, l2diff: l2d, l3 },
    runJsonExists: exists(runPath),
    runJsonError: runErr,
    runJsonStage: run !== null ? run.stage : null,
    inflight,
    inflightAgents,
    stages,
    orphans,
    totalMissing,
    nextStep: inflight !== null ? '先按 inflight 收尾' : (firstIncomplete !== null ? firstIncomplete.label : '全部阶段产物齐全'),
  };
  out(JSON.stringify(jsonOut, null, 2));
  if (inflight !== null) process.exit(2);
  if (totalMissing > 0) process.exit(1);
  if (orphans.length > 0) process.exit(3);
  process.exit(0);
}

// ---- 人读输出 ----
out('');
out(C.cyan(`=== 产物清单校验 [${Feature}] ===`));
out('');
out(C.gray('  轮次：'));
out('    L1 机械门   ' + (l1.length ? 'round ' + l1.join(', ') : '（无）'));
out('    L2 审查     ' + (l2.length ? 'round ' + l2.join(', ') : '（无）') + (l2d.length ? '   diff: round ' + l2d.join(', ') : ''));
out('    L3 验收     ' + (l3.length ? 'round ' + l3.join(', ') : '（无）'));
if (run !== null) {
  out('    run.json    stage=' + run.stage + '  status=' + run.status);
} else if (runErr) {
  out(C.yellow('    run.json    ⚠ 解析失败: ' + runErr));
} else {
  out(C.yellow('    run.json    ✗ 不存在'));
}
out('');

// inflight
if (inflight !== null) {
  out(C.red('  ⛔ 上一次运行被中断在半路（run.json 的 inflight 非空）'));
  out(C.red(`     stage=${inflight.stage}  round=${inflight.round}  开始于 ${inflight.startedAt}`));
  if (inflight.what) out(C.red(`     当时在做：${inflight.what}`));
  if (inflightAgents.length > 0) {
    out(C.red('     派出去还没收回来的 agent：'));
    for (const a of inflightAgents) {
      if (a.reportExists) {
        out(C.yellow(`       · ${a.name} [${a.role}] task=${a.task}  报告已在（${a.reportBytes} 字节）—— 需人工确认是否完整`));
      } else {
        out(C.red(`       · ${a.name} [${a.role}] task=${a.task}  报告不存在 —— 这个 agent 的产出不算数`));
      }
    }
  }
  out(C.dark('     恢复动作：核对上面每份报告在不在、完不完整；不完整的产出不算数，'));
  out(C.dark('     它写进 evidence/ 的东西要么认领要么删。**以产物为准，不以记忆为准。**'));
  out('');
}

// 逐阶段
for (const s of stages) {
  const m = asList(s.missing);
  if (m.length === 0) {
    out(C.green(`  ✓ ${s.label.padEnd(14)} 齐全`));
  } else {
    out(C.red(`  ✗ ${s.label.padEnd(14)} 缺 ${m.length} 项`));
    for (const x of m) out(C.red('      · ' + x));
  }
}

// 框架指纹
out('');
if (fwState === 'captured') {
  out(C.cyan(`  📌 框架指纹已记入 run.json（${fwNow.fileCount} 个规则文件，${fwNow.sha256.substring(0, 12)}）`));
  out(C.dark('     这是「开考时的考卷」。之后每次检查都会比对 —— 规则若在评判过程中被改过，这里会报出来。'));
} else if (fwState === 'same') {
  out(C.green(`  ✓ 框架未漂移（${fwNow.fileCount} 个规则文件，${fwNow.sha256.substring(0, 12)}）`));
} else if (fwState === 'acknowledged') {
  out(C.yellow(`  ⚠ 框架已改动，但有书面说明：${run.frameworkDriftAcknowledged}`));
} else if (fwState === 'drifted') {
  out(C.red('  ⛔ 评判标准在评判过程中被改过（框架指纹漂移）'));
  if (!oofFrameworkApproved) {
    out(C.red('     ⚠ 而且 outOfFlowActions 里没有一条 modify-framework 的用户裁决 ——'));
    out(C.red('       按铁律 7，改框架属于流程外动作，必须先问用户。这次没有记录。'));
  }
  out(C.red(`     开跑时: ${fwRecorded.sha256.substring(0, 12)}  (${fwRecorded.fileCount} 个文件)`));
  out(C.red(`     现在  : ${fwNow.sha256.substring(0, 12)}  (${fwNow.fileCount} 个文件)`));
  out(C.dark('     改框架经常是对的 —— 这里不禁止。但没有任何东西能区分「修好了一个缺陷」和'));
  out(C.dark('     「把挡路的规则拿掉了」，所以必须留一句话。在 run.json 写：'));
  out(C.dark('       "frameworkDriftAcknowledged": "改了什么、为什么、是否影响本次已下的结论"'));
}

// 流程外动作
if (oof.length > 0 || oofNoDecision.length > 0) {
  out('');
  out(C.gray(`  流程外动作：${oof.length} 条（铁律 7 要求先问用户）`));
  for (const a of oof) {
    const mark = a.userDecision === 'approved' ? '✓' : (a.userDecision === 'rejected' ? '✗' : '?');
    out(C.dark(`     ${mark} ${a.action} → ${a.target}  [${a.userDecision ? a.userDecision : '无裁决'}]`));
  }
  if (oofNoDecision.length > 0) {
    out(C.red('     ⛔ 下面这些是自作主张（没有用户裁决，或提问时没写清「不做会怎样」）：'));
    for (const x of oofNoDecision) out(C.red('        · ' + x));
  }
}

// 结论来源
if (run !== null) {
  const indep = verdictBy.agent;
  const self = verdictBy.orchestrator + verdictBy.other;
  out('');
  out(C.gray(`  结论来源：agent 判定 ${verdictBy.agent} 条 / 编排者自证 ${verdictBy.orchestrator} 条 / 人工判定 ${verdictBy.human} 条`));
  if (self > 0) {
    out(C.yellow('     ⚠ 编排者自证的不计入独立验证 —— 出题、答题、判卷是同一个人。'));
  }
  if (indep === 0 && (self + verdictBy.human) > 0) {
    out(C.yellow('     ⚠ 本 feature **没有任何一条结论**来自独立 agent 判定。'));
  }
}

// 轮次对账
out('');
if (roundGaps.length > 0) {
  out(C.yellow(`  ⚠ run.json 与磁盘产物对不上（${roundGaps.length} 处）：`));
  for (const g of roundGaps) out(C.yellow('      · ' + g));
  out(C.dark('    `rd-build:245` 要求每轮结束追加一行到 rounds。对不上说明某一轮结束时没人动手。'));
  out(C.dark('    补回去 —— 不补的话，熔断计数、指纹比对全都建立在一份不完整的记录上。'));
} else {
  out(C.green('  ✓ run.json 的 rounds 与磁盘产物一致'));
}

// 孤儿产物
out('');
if (orphans.length > 0) {
  out(C.yellow(`  ⚠ 孤儿证据 ${orphans.length} 个 —— 在 evidence/ 里，但没有任何报告引用它们：`));
  for (const o of orphans) out(C.yellow('      · ' + o));
  out(C.dark('    这些文件通常来自被中断或被终止的 agent。它们是真实证据，'));
  out(C.dark('    但没人知道属于哪一轮、验证了什么 —— 要么在报告里认领，要么删掉。'));
} else {
  out(C.green('  ✓ 无孤儿证据'));
}

// ---- 留痕：写回 lastCheckedAt / 首次捕获框架指纹 ----
if (run !== null && exists(runPath)) {
  try {
    const now = new Date().toISOString();
    run.lastCheckedAt = now;
    if (fwState === 'captured' && fwNow !== null) {
      run.frameworkFingerprint = {
        sha256: fwNow.sha256,
        fileCount: fwNow.fileCount,
        capturedAt: now,
        _note: '开跑时框架（skills/ + scripts/ + templates/）的指纹。之后每次 check-artifacts 都比对：规则若在评判过程中被改过，会报漂移。改框架不被禁止，但必须在 frameworkDriftAcknowledged 里写一句为什么 —— 否则无法区分「修好了一个缺陷」和「把挡路的规则拿掉了」。',
      };
    }
    fs.writeFileSync(runPath, JSON.stringify(run, null, 2), 'utf8');
  } catch (e) {
    out(C.yellow(`  ⚠ 无法写回 run.json 的 lastCheckedAt：${e.message}`));
  }
}

// ---- 结论与退出码 ----
out('');
if (inflight !== null) {
  out(C.red('=== 上次运行被中断在半路，先按上面的 inflight 收尾 ==='));
  out('');
  out(C.dark('  收完尾把 run.json 的 inflight 清成 null，再继续往下走。'));
  out('');
  process.exit(2);
}
if (totalMissing > 0) {
  out(C.yellow(`=== 缺 ${totalMissing} 项，下一步：${firstIncomplete.label} ===`));
  out('');
  out(C.dark('  被打断后恢复时，以这里为准，不要凭记忆接着往下走。'));
  out('');
  process.exit(1);
}
if (orphans.length > 0 || roundGaps.length > 0 || fwState === 'drifted' || oofNoDecision.length > 0) {
  const why = [];
  if (oofNoDecision.length > 0) why.push(`${oofNoDecision.length} 条流程外动作没有用户裁决`);
  if (fwState === 'drifted') why.push('评判标准中途被改过且无书面说明');
  if (orphans.length > 0) why.push(`${orphans.length} 个孤儿证据`);
  if (roundGaps.length > 0) why.push(`${roundGaps.length} 处轮次记录对不上`);
  out(C.yellow(`=== 阶段产物齐全，但有 ${why.join('、')} 待处置 ===`));
  out('');
  out(C.dark('  不判为通过：无主证据是「中断留下的残骸」，会被后人误当成有效依据；'));
  out(C.dark('  记录对不上则意味着熔断计数与指纹比对建立在一份不完整的 run.json 上。'));
  out('');
  process.exit(3);
}
out(C.green('=== 全部阶段产物齐全，无孤儿证据 ==='));
out('');
process.exit(0);
