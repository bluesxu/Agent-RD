#!/usr/bin/env node
/*
  check-artifacts —— 产物清单校验：回答「我现在在哪一步、该有的东西缺了什么、有没有无主的证据」。

  存在理由（三条实跑教训）：
    1. 中断是常态。配额窗口下反复被打断，恢复全靠翻文件猜进度。
    2. 要求写在那儿，但没人检查有没有照做。run.json / 每轮追加 / 报告正文，三处都落空过。
    3. **文件存在 ≠ 文件完成**。rd-plan 派 3 个方案 agent，A 中断后内容归零、B/C 正常返回，
       仲裁拿着 2 份照常进行 —— 全程没有任何东西报出「你少了一份」。
       只查「文件在不在」的检查，对半截产物和完整产物给出同一个答案。

  这个脚本不加新要求，只把已有要求变成可执行的检查。

  用法：
    node check-artifacts.js [-Root <dir>] [-Feature <slug>] [-Json]
    node check-artifacts.js -SelfTest        # 证伪自检：喂已知应失败的输入，确认检查报得出失败
    node check-artifacts.js -Sections        # 打印各产物的必填小节表（写报告的 agent 照它写）

  退出码（validate-plan 与 gate-test 依赖这个划分，不要改动语义）：
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
  const args = { Json: false, SelfTest: false, Sections: false, SkillLint: false, Skill: '', Baseline: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-Json' || a === '--Json') { args.Json = true; continue; }
    if (a === '-SelfTest' || a === '--SelfTest') { args.SelfTest = true; continue; }
    if (a === '-Sections' || a === '--Sections') { args.Sections = true; continue; }
    if (a === '-SkillLint' || a === '--SkillLint') { args.SkillLint = true; continue; }
    const m = a.match(/^--?([A-Za-z]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = m[2];
    if (val === undefined && i + 1 < argv.length && !/^--?/.test(argv[i + 1])) val = argv[++i];
    if (key === 'root') args.Root = val;
    else if (key === 'feature') args.Feature = val;
    else if (key === 'skill') args.Skill = val;
    else if (key === 'baseline') args.Baseline = val;
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

/* ================== 收尾检测点（D-1） ==================

  规则：**完成的文件必须有收尾的检测点。没有标记的，一律视为未完成或只完成了一半。**

  判据是两条【同时】成立，缺一不可：
    1. 尾部有 RD-DONE 标记 —— 它是写文件的最后一个动作，
       中断发生在任何时刻，都不可能让一个没写完的文件带上它。
    2. 该产物要求的必填小节全部有实际内容 —— 不是只有标题、不是只剩模板占位符。

  为什么不能只查标记：单靠标记挡不住「先盖章再写正文」和「空壳但标记齐全」。
  一个对空壳也放行的检测点没有判别力 —— 见 run.json 的 A18「证伪优先」。
  所以 -SelfTest 存在：它拿已知应该失败的输入喂进来，确认这套检查真的报得出失败。

  run.json 不在此列：它是活状态文件，全程被反复改写，它的「完成」由 stage/status
  表示，不由尾标记表示。给一个每轮都要更新的文件盖「完成」章，章本身就是谎话。
*/
const DONE_MARK_RE = /^<!--\s*RD-DONE\b[\s\S]*-->$/;

// 各产物的必填小节。空数组 = 只查尾标记，不查小节。
const REQUIRED_SECTIONS = {
  'spec.md': ['要解决什么', '范围', '关键约束', '已确认的决策'],
  'design.md': ['选定方案', '技术选型', '影响面', '契约变化', '被排除的方案'],
  'proposal': ['方案', '关键取舍', '被排除的路', '风险'],
  'l2': ['审查结论', 'blocking', 'important', 'nit'],
  'l3': ['验收结论', '逐条', '收尾附录'],
  'dispatch.md': [],
};

/* ---- 契约常量（唯一真值在 docs/authoring.md §6 的围栏块，-SkillLint 会对账） ---- */

// 三档行为判定条件名。必须是「模型能诚实自查」的行为条件，不是形容词。
const RUBRIC_CONDITIONS = [
  'contract-break:blocking',
  'wrong-result-silent:blocking',
  'fabricated-verification:blocking',
  'guard-evasion:blocking',
  'unhandled-failure-path:important',
  'coverage-gap:important',
  'contract-drift:important',
  'performance-risk:important',
  'maintainability-trap:important',
  'testability-gap:important',
  'redundant-logic:nit',
  'misleading-name:nit',
  'stale-doc:nit',
];
const CONDITION_NAMES = new Set(RUBRIC_CONDITIONS.map((c) => c.split(':')[0]));

// Builder 结构化回执（reports/receipts/{taskId}.json）必填字段。
const RECEIPT_FIELDS = ['taskId', 'filesChanged', 'selfCheckCommand', 'selfCheckOutput', 'deviations'];

/*
  -Sections：把上面这张表打印出来。

  这是 F7 的解法：必填小节原本**只存在于本文件里**，写报告的 agent（reviewer /
  evaluator）看不到它，于是每次都靠撞门才知道缺哪节，编排者事后手工补 ——
  实跑里补了三份。让「写报告的人」和「检查报告的人」看同一张表，
  唯一可靠的办法是这张表能被打印出来，而不是在两处各抄一遍。
*/
function printSections() {
  out('');
  out(C.cyan('=== 各产物的必填小节（权威来源：check-artifacts.js REQUIRED_SECTIONS）==='));
  out('');
  for (const key of Object.keys(REQUIRED_SECTIONS)) {
    const secs = REQUIRED_SECTIONS[key];
    if (secs.length === 0) {
      out(`  ${key.padEnd(12)} —— 只查尾标记，不查小节`);
    } else {
      out(`  ${key.padEnd(12)} ${secs.map((s) => '「' + s + '」').join(' ')}`);
    }
  }
  out('');
  out(C.dark('  判据是两条同时成立：① 尾部有 <!-- RD-DONE ... --> 标记；'));
  out(C.dark('  ② 每个必填小节都有实际内容（只有标题或只剩模板占位符 = 空壳，不算）。'));
  out(C.dark('  JSON 产物（tasks.json / acceptance.json）用 "_complete": true 代替尾标记。'));
  out('');
  out(C.cyan('=== 契约（权威来源：docs/authoring.md §6 冻结表，-SkillLint 会对账）==='));
  out('');
  out(C.dark('  审查层报告每条 finding 必填「- 判定条件: <名字>」。合法名字（冻结）：'));
  for (const c of RUBRIC_CONDITIONS) {
    const [name, tier] = c.split(':');
    out(`    ${name.padEnd(24)} ${tier}`);
  }
  out('');
  out(C.dark('  Builder 回执 reports/receipts/{taskId}.json 必填字段（冻结）：'));
  out(`    ${RECEIPT_FIELDS.join(' / ')}`);
  out('');
}

// 把 Markdown 切成小节。围栏代码块里的 # 不算标题。
function parseSections(txt) {
  const lines = String(txt).split(/\r?\n/);
  const secs = [];
  let cur = null;
  let inFence = false;
  for (const ln of lines) {
    if (/^\s*(```|~~~)/.test(ln)) { inFence = !inFence; if (cur) cur.body.push(ln); continue; }
    const m = inFence ? null : ln.match(/^(#{1,6})\s+(.*)$/);
    if (m) { cur = { level: m[1].length, title: m[2].trim(), body: [] }; secs.push(cur); continue; }
    if (cur) cur.body.push(ln);
  }
  return secs;
}

/*
  一个小节的「深正文」= 它自己的正文 + 它所有子小节的正文。
  不这么算的话，`## 逐条` 下面全是 `### AC-1 / ### AC-2` 时，
  父小节自己的正文是空的，会被误判成空壳 —— 而它其实是这份报告里最实的一节。
*/
function deepBody(secs, i) {
  const lvl = secs[i].level;
  const acc = secs[i].body.slice();
  // 只收子小节的【正文】，不收它们的标题 —— 一堆光秃秃的子标题不是内容，
  // 收了的话「父小节空 + 子小节也空」会被算成有内容，检查就失去判别力。
  for (let j = i + 1; j < secs.length && secs[j].level > lvl; j++) {
    acc.push(...secs[j].body);
  }
  return acc;
}

/*
  小节正文里有多少「真内容」。以下一律不算：
    - 模板占位符 {xxx}
    - GFM 表格的骨架（表头行 + 紧随其后的分隔行）—— 只有数据行算内容。
      不去掉表头的话，`| 决策点 | 选定 | 备选 | 为什么 |` 这种空表也能蒙混过关。
    - RD-DONE 标记本身
    - 纯标点与空白
*/
function meaningfulLen(bodyLines) {
  const kept = [];
  const lines = asList(bodyLines);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (DONE_MARK_RE.test(ln.trim())) continue;
    const isRow = /^\s*\|.*\|\s*$/.test(ln);
    const nextIsSep = i + 1 < lines.length && /^\s*\|[\s|:-]*\|\s*$/.test(lines[i + 1]);
    if (isRow && nextIsSep) { i++; continue; }          // 表头 + 分隔行，一起跳过
    if (/^\s*\|[\s|:-]*\|\s*$/.test(ln)) continue;      // 落单的分隔行
    kept.push(ln);
  }
  return kept.join('\n')
    .replace(/\{[^{}]*\}/g, '')
    .replace(/[\s|`>*_#-]/g, '')
    .length;
}

function tailMarked(txt) {
  const lines = String(txt).split(/\r?\n/);
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === '') i--;
  if (i < 0) return false;
  return DONE_MARK_RE.test(lines[i].trim());
}

/*
  返回 { state, why }
    state: 'ok'      —— 有尾标记且必填小节都有内容
           'partial' —— 文件在，但没写完（无标记 / 缺小节 / 小节是空壳）
           'missing' —— 文件不在
  partial 与 missing 在流程上是同一类：都不算数，都不许往下走。
  分开只是为了让恢复的人知道「是从来没开始，还是被中断在半路」。
*/
function checkMarkdown(fullPath, required) {
  if (!exists(fullPath)) return { state: 'missing', why: [] };
  let txt;
  try { txt = readText(fullPath); } catch (e) { return { state: 'partial', why: ['读不出来：' + e.message] }; }
  const why = [];
  if (!tailMarked(txt)) why.push('末行没有 RD-DONE 收尾标记 —— 按 D-1 视为未写完');
  const secs = parseSections(txt);
  for (const name of asList(required)) {
    // 标题可能不止一处命中（H1 文件标题常与某个小节同名），
    // 只要有【任意一处】命中且正文非空就算数 —— 否则会把「# 方案 a」这种空标题误判成空壳
    const hits = [];
    for (let i = 0; i < secs.length; i++) {
      if (secs[i].title.toLowerCase().includes(String(name).toLowerCase())) hits.push(i);
    }
    if (hits.length === 0) { why.push(`缺必填小节「${name}」`); continue; }
    if (!hits.some((i) => meaningfulLen(deepBody(secs, i)) > 0)) {
      why.push(`必填小节「${name}」是空壳（只有标题或只剩占位符）`);
    }
  }
  return { state: why.length === 0 ? 'ok' : 'partial', why };
}

// JSON 类产物：截断的 JSON parse 就会失败，已经自带一半保护；
// 「合法却只写了一半」挡不住，所以另加显式的 _complete 字段。
function checkJson(fullPath) {
  if (!exists(fullPath)) return { state: 'missing', why: [] };
  let obj;
  try { obj = readJsonFile(fullPath); }
  catch (e) { return { state: 'partial', why: ['JSON 解析失败（多半是被中断在半路截断了）：' + e.message] }; }
  if (obj === null || typeof obj !== 'object') return { state: 'partial', why: ['顶层不是对象'] };
  if (obj._complete !== true) return { state: 'partial', why: ['缺 "_complete": true —— 按 D-1 视为未写完'] };
  return { state: 'ok', why: [] };
}

// 把检查结果翻译成 stages.missing 里的一行
function missLine(label, res, hint) {
  if (res.state === 'ok') return [];
  if (res.state === 'missing') return [label + (hint ? '  ← ' + hint : '')];
  return [`${label}  ⚠ 只写了一半：${res.why.join('；')}`];
}

/* ================== 散文准入 / 契约 / AC-7 的检查族 ==================

  这些检查是对「框架自身」的结构校验（-SkillLint），与对「某次 feature 产物」
  的校验（-Feature）是两个生命周期，所以独立成早退模式，不混进 stages 计数器。
  唯一例外是审查层报告条件名与回执字段 —— 它们是 feature 产物，
  挂在 -Feature 主流程里。
*/

function normalizeWs(s) { return String(s).replace(/\s+/g, ' ').trim(); }
// 去掉全部空白：守恒比对用这个（容忍 markdown 折行 —— 长句搬进 reference 折行后
// 换行变成空格，逐字比对会误报；内容守恒关心的是「句子还在」，不是「换行位置没变」）
function stripWs(s) { return String(s).replace(/\s+/g, ''); }

// 一段值里有没有「真内容」：去掉占位符/纯符号后仍非空
function hasMeaning(v) {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0 && v.some((x) => hasMeaning(x));
  if (typeof v === 'object') return Object.keys(v).length > 0;
  const s = String(v).replace(/\{[^{}]*\}/g, '').replace(/[\s|`>*_#-]/g, '');
  return s.length > 0;
}

// 硬约束提取（AC-7 守恒）：⛔ 开头 / 含必须·不许·不得·禁止·一律·硬门槛 / 硬门槛·铁律小节内每条
function extractHardConstraints(txt) {
  const lines = String(txt).split(/\r?\n/);
  const out = [];
  let inHardSection = false;
  for (const raw of lines) {
    const ln = raw.trim().replace(/^>+\s*/, ''); // 剥掉引用块装饰，`>` 不是内容
    if (/^##\s+(硬门槛|铁律)\s*$/.test(ln)) { inHardSection = true; continue; }
    if (/^##/.test(ln)) { inHardSection = false; }
    if (ln === '' || /^#/.test(ln) || ln.startsWith('<!--')) continue;
    if (inHardSection) { out.push(normalizeWs(ln.replace(/^[-*]\s+/, ''))); continue; }
    if (/^⛔/.test(ln) || /(必须|不许|不得|禁止|一律|硬门槛)/.test(ln)) { out.push(normalizeWs(ln)); }
  }
  return out;
}

/*
  references/ 的孤儿与断链（AC-2）。
  A = 本 skill references/** 实际文件集；B = 本 skill 被引用的引用路径。
  两种引用形态：
    · 未限定 `references/x.md`（本 skill 的 SKILL.md 钩子里）→ 计入本 skill 的 B，
      并检查本 skill references/x.md 存在。
    · 限定 `skills/<name>/references/x.md`（策略加载清单里）→ 走全局存在性检查
      （限定到本 skill 的也计入本 skill 的 B）。
  orphans = A − B；dangling = 所有提到但没有对应真实文件的路径。
*/
function checkRefs(skillDir, strategiesFiles, skillsRoot) {
  const refsDir = path.join(skillDir, 'references');
  const a = walkFiles(refsDir).map((f) => path.relative(skillDir, f).split(path.sep).join('/'));
  const skillName = path.basename(skillDir);
  const rootDir = path.resolve(skillsRoot, '..'); // 限定路径 skills/<name>/... 相对 ROOT，不是相对 skills/
  const b = new Set();
  const dangling = [];
  const seen = new Set();
  const re = /(?:skills\/[A-Za-z0-9_.-]+\/)?references\/[A-Za-z0-9_./-]+\.md/g;
  const scanFiles = [path.join(skillDir, 'SKILL.md')].concat(strategiesFiles);
  for (const f of scanFiles) {
    if (!exists(f)) continue;
    const srcLabel = path.relative(skillsRoot, f).split(path.sep).join('/');
    const txt = readText(f);
    let m;
    while ((m = re.exec(txt)) !== null) {
      const raw = m[0];
      if (raw.startsWith('references/')) {
        // 未限定：本 skill 局部
        b.add(raw);
        if (!exists(path.join(skillDir, raw)) && !seen.has(srcLabel + ' → ' + raw)) {
          seen.add(srcLabel + ' → ' + raw);
          dangling.push(`${srcLabel} → ${raw}（引用了不存在的文件）`);
        }
      } else {
        // 限定：skills/<name>/references/x.md，相对 rootDir 解析
        const full = path.join(rootDir, raw);
        if (!exists(full) && !seen.has(srcLabel + ' → ' + raw)) {
          seen.add(srcLabel + ' → ' + raw);
          dangling.push(`${srcLabel} → ${raw}（引用了不存在的文件）`);
        }
        if (raw.startsWith('skills/' + skillName + '/references/')) {
          b.add(raw.slice(('skills/' + skillName + '/').length));
        }
      }
    }
  }
  const orphans = a.filter((p) => !b.has(p));
  return { orphans, dangling };
}

/*
  钩子检查（AC-3）。对 SKILL.md 逐行：
    · 含 📎 的行：必须有反引号包住的 references/...md 路径、文件必须存在、
      紧邻非空行必须以「不读会/不转发会」开头（闭集）、role= 取值合法。
    · 反向 warn：含 references/ 路径但没有 📎 的行（防锚点被编辑器改写成变体后漏检），
      跳过 markdown 表格行（References 索引表合法存在）。
*/
function checkHooks(skillDir) {
  const issues = [];
  const warns = [];
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!exists(skillMd)) return { issues: [`缺 ${path.basename(skillDir)}/SKILL.md`], warns: [] };
  const lines = readText(skillMd).split(/\r?\n/);
  let inRefsSection = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^##\s*References/i.test(ln)) { inRefsSection = true; continue; }
    if (/^#/.test(ln)) inRefsSection = false;
    if (!ln.includes('📎')) {
      if (!inRefsSection && !/^\s*\|.*\|\s*$/.test(ln) && /references\/[A-Za-z0-9_./-]+\.md/.test(ln)) {
        warns.push(`${path.basename(skillDir)}:${i + 1} 含 references/ 路径但无 📎 钩子标记（锚点可能被改写，lint 会漏检）`);
      }
      continue;
    }
    const m = ln.match(/`references\/[A-Za-z0-9_./-]+\.md`/);
    if (!m) { issues.push(`${path.basename(skillDir)}:${i + 1} 📎 行缺反引号包住的 references/...md 路径`); continue; }
    const refPath = m[0].replace(/`/g, '');
    if (!exists(path.join(skillDir, refPath))) {
      issues.push(`${path.basename(skillDir)}:${i + 1} 📎 指向 ${refPath}，但文件不存在`);
    }
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    if (j >= lines.length) {
      issues.push(`${path.basename(skillDir)}:${i + 1} 📎 后缺后果子句（须以「不读会」或「不转发会」开头）`);
    } else {
      const next = lines[j].trim().replace(/^>\s*/, ''); // 剥掉引用块前缀
      if (!/^(不读会|不转发会)/.test(next)) {
        issues.push(`${path.basename(skillDir)}:${i + 1} 后果子句须以「不读会」或「不转发会」开头（闭集），实得: ${next.slice(0, 40)}`);
      }
    }
    const roleM = ln.match(/role=(\w+)/);
    if (roleM && ['self', 'forward', 'human'].indexOf(roleM[1]) < 0) {
      issues.push(`${path.basename(skillDir)}:${i + 1} role=${roleM[1]} 不在合法集合 {self, forward, human}`);
    }
  }
  return { issues, warns };
}

/*
  审查层报告每条 finding 必须标注行为判定条件名。
  finding 小节 = `### B\d+` / `### I\d+` / `### N\d+` 标题。
  · 缺「- 判定条件: <名字>」→ 点名发现
  · 名字不在 CONDITION_NAMES → 点名「不在合法集合」
  · 三节都写「无」的报告没有 finding 小节 → 零 finding，照常通过
*/
function checkL2Findings(txt) {
  const issues = [];
  const lines = String(txt).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^###\s+([BIN])(\d+)\b/);
    if (!m) continue;
    const body = [];
    let j = i + 1;
    while (j < lines.length && !/^###/.test(lines[j])) { body.push(lines[j]); j++; }
    const condLine = body.find((ln) => /^\s*-?\s*判定条件\s*[:：]\s*\S/.test(ln));
    if (!condLine) {
      issues.push(`发现 ${m[1]}${m[2]} 缺「- 判定条件: <名字>」（行为条件名见 -Sections）`);
      continue;
    }
    const name = condLine.match(/^\s*-?\s*判定条件\s*[:：]\s*(\S+)/)[1];
    if (!CONDITION_NAMES.has(name)) {
      issues.push(`发现 ${m[1]}${m[2]} 的判定条件「${name}」不在合法集合`);
    }
  }
  return issues;
}

/*
  Builder 结构化回执 reports/receipts/{taskId}.json。
  必填字段见 RECEIPT_FIELDS；字段缺失 → 点名字段名；字段在但空白/占位符 → 点名「是空壳」。
  ⛔ 回执缺席本身不进 missing（存量 feature 没有回执很正常）—— 缺席对账走
  inflight.agents[].receiptPath（登记过、文件不存在 = 这一份丢了）。
*/
function checkReceipt(fullPath) {
  if (!exists(fullPath)) return ['文件不存在'];
  let obj;
  try { obj = readJsonFile(fullPath); }
  catch (e) { return ['JSON 解析失败（多半是被中断截断）：' + e.message]; }
  if (obj._complete !== true) return ['缺 "_complete": true'];
  const issues = [];
  for (const f of RECEIPT_FIELDS) {
    const v = obj[f];
    if (v === undefined || v === null) { issues.push(`缺必填字段 ${f}`); continue; }
    if (!hasMeaning(v)) { issues.push(`字段 ${f} 是空壳（空白或占位符，AC-5 ③）`); }
  }
  return issues;
}

// 解析 authoring.md 里的 `<!-- name:start -->` ... `<!-- name:end -->` 围栏块
function parseFenceBlock(txt, marker) {
  const re = new RegExp('<!--\\s*' + marker + ':start\\s*-->([\\s\\S]*?)<!--\\s*' + marker + ':end\\s*-->');
  const m = String(txt).match(re);
  if (!m) return null;
  return m[1].split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '' && !s.startsWith('<!--'));
}

/*
  冻结表对账（A18 双路复算）：脚本常量 vs docs/authoring.md 围栏块。
  抄错一个字，审查层报告会被判失败而原因看起来像脚本坏了 —— 把这条跨文件契约变成机械可证伪的。
*/
function checkContractAlignment(authoringPath) {
  const drift = [];
  if (!exists(authoringPath)) return ['缺 docs/authoring.md，无法对账冻结表'];
  const txt = readText(authoringPath);
  const cond = parseFenceBlock(txt, 'conditions');
  if (cond === null) drift.push('authoring.md 缺 <!-- conditions:start/end --> 围栏块');
  else if (cond.join('\n') !== RUBRIC_CONDITIONS.join('\n')) {
    drift.push('RUBRIC_CONDITIONS 与 authoring.md 冻结表不一致（两者必须逐字一致）');
  }
  const rc = parseFenceBlock(txt, 'receipt-fields');
  if (rc === null) drift.push('authoring.md 缺 <!-- receipt-fields:start/end --> 围栏块');
  else if (rc.join('\n') !== RECEIPT_FIELDS.join('\n')) {
    drift.push('RECEIPT_FIELDS 与 authoring.md 冻结表不一致（两者必须逐字一致）');
  }
  return drift;
}

/*
  AC-7 硬约束守恒：baselineDir/skills/** 里的每条硬约束，在「当前主文件 ∪ 该 skill 全部
  references」这个全集里必须仍能被逐字（归一化空白后）grep 到。找不到 = 规则搬丢。
  有意的删除必须写进 `.rd/features/ * /design.md` 的「有意改写/删除的约束」表（约束原文列
  与被删文本逐字一致），否则同样判丢 —— 这就是 AC-7「有意删除要留档」的机械形态。
  ⛔ 挡不住「条目还在、语气被稀释」（⛔ 不许 → 建议不要 计数不变）—— 那是审查层逐条比对的活。
*/
function documentedExemptions(rdRoot) {
  const ex = new Set();
  const featRoot = path.join(rdRoot, '.rd', 'features');
  if (!isDir(featRoot)) return ex;
  for (const f of walkFiles(featRoot)) {
    if (!f.endsWith('design.md')) continue;
    const lines = String(readText(f)).split(/\r?\n/);
    let inTable = false;
    for (const raw of lines) {
      const ln = raw.trim();
      if (/^##\s*有意改写\/删除的约束/.test(ln)) { inTable = true; continue; }
      if (/^##/.test(ln)) inTable = false;
      if (!inTable || !/^\|/.test(ln)) continue;
      const cells = ln.split('|').map((c) => c.trim());
      const first = cells[1] || '';
      if (first === '' || first === '约束原文' || /^[-:]+$/.test(first)) continue;
      // 剥掉 markdown 代码包裹反引号，再存 stripWs 形态
      ex.add(stripWs(first.replace(/^`+|`+$/g, '')));
    }
  }
  return ex;
}
function checkConserve(baselineDir, skillsRoot, rdRoot) {
  const issues = [];
  const baseSkills = path.join(baselineDir, 'skills');
  if (!isDir(baseSkills)) return ['守恒检查：基线目录下没有 skills/'];
  const exempt = documentedExemptions(rdRoot);
  for (const baseFile of walkFiles(baseSkills)) {
    if (!baseFile.endsWith('.md')) continue;
    const rel = path.relative(baseSkills, baseFile).split(path.sep).join('/');
    const constraints = extractHardConstraints(readText(baseFile));
    if (constraints.length === 0) continue;
    let curText = '';
    const curRel = path.join(skillsRoot, rel);
    if (exists(curRel)) curText += readText(curRel);
    const skillTop = rel.split('/')[0];
    const refsDir = path.join(skillsRoot, skillTop, 'references');
    for (const rf of walkFiles(refsDir)) curText += '\n' + readText(rf);
    const normCur = stripWs(curText);
    for (const c of constraints) {
      const cStripped = stripWs(c);
      if (exempt.has(cStripped)) continue; // 有意删除，design.md 已留档
      if (!normCur.includes(cStripped)) {
        issues.push('AC-7 守恒：基线 ' + rel + ' 的硬约束「' + c.slice(0, 50) + '」在改后全集里找不到（若是有意删除，把它写进 design.md 的「有意改写/删除的约束」表）');
      }
    }
  }
  return issues;
}

// -SkillLint 主入口：返回 { issues, warns, orphans, dangles }
function runSkillLint(root, skillName, baselineDir) {
  const skillsRoot = path.join(root, 'skills');
  const issues = [];
  const warns = [];
  const orphans = [];
  const dangles = [];
  if (!isDir(skillsRoot)) return { issues: ['skills/ 不存在'], warns, orphans, dangles };
  const strategiesDir = path.join(skillsRoot, 'rd', 'strategies');
  const strategiesFiles = listDirFiles(strategiesDir, (n) => n.endsWith('.md'))
    .map((n) => path.join(strategiesDir, n)).sort();
  const targets = skillName
    ? [path.join(skillsRoot, skillName)]
    : listDirDirs(skillsRoot).filter((d) => exists(path.join(skillsRoot, d, 'SKILL.md')))
        .map((d) => path.join(skillsRoot, d)).sort();
  for (const sd of targets) {
    const name = path.basename(sd);
    const refs = checkRefs(sd, strategiesFiles, skillsRoot);
    for (const o of refs.orphans) orphans.push(`${name}: ${o}`);
    for (const d of refs.dangling) dangles.push(`${name}: ${d}`);
    const hk = checkHooks(sd);
    issues.push(...hk.issues);
    warns.push(...hk.warns);
  }
  // 加载清单 + 冻结表对账只在全量模式跑（-Skill 单 skill 时跳过 —— T9 才生效）
  if (!skillName) {
    for (const sf of strategiesFiles) {
      const secs = parseSections(readText(sf));
      const load = secs.find((s) => s.title.includes('本策略的加载清单'));
      if (!load) { issues.push(`${path.basename(sf)} 缺「本策略的加载清单」小节（AC-6）`); continue; }
      const body = load.body.join('\n');
      if (!/会用到/.test(body)) issues.push(`${path.basename(sf)} 加载清单缺「会用到」子清单`);
      if (!/永不加载/.test(body)) issues.push(`${path.basename(sf)} 加载清单缺「永不加载」子清单`);
    }
    issues.push(...checkContractAlignment(path.join(root, 'docs', 'authoring.md')));
  }
  if (baselineDir) issues.push(...checkConserve(baselineDir, skillsRoot, root));
  return { issues, warns, orphans, dangles };
}

// ---- 只打印必填小节表就退出 ----
if (args.Sections) {
  printSections();
  process.exit(0);
}

// ---- 证伪自检：先确认这套检查有判别力，再让它去下结论 ----
if (args.SelfTest) {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-selftest-'));
  const cases = [];
  function T(name, filename, content, required, expect) {
    const p = path.join(tmp, filename);
    fs.writeFileSync(p, content, 'utf8');
    const res = filename.endsWith('.json') ? checkJson(p) : checkMarkdown(p, required);
    cases.push({ name, expect, got: res.state, pass: res.state === expect, why: res.why });
  }
  const DONE = '<!-- RD-DONE stage=plan artifact=t at=2026-01-01T00:00:00Z -->';

  T('完整文件应判 ok', 'a.md', '# T\n\n## 甲\n有内容一二三\n\n## 乙\n也有内容\n\n' + DONE + '\n', ['甲', '乙'], 'ok');
  T('无尾标记应判 partial', 'b.md', '# T\n\n## 甲\n有内容一二三\n\n## 乙\n也有内容\n', ['甲', '乙'], 'partial');
  T('缺小节应判 partial', 'c.md', '# T\n\n## 甲\n有内容一二三\n\n' + DONE + '\n', ['甲', '乙'], 'partial');
  T('小节空壳应判 partial', 'd.md', '# T\n\n## 甲\n有内容\n\n## 乙\n\n' + DONE + '\n', ['甲', '乙'], 'partial');
  T('只剩占位符应判 partial', 'e.md', '# T\n\n## 甲\n{一句话说清楚}\n\n' + DONE + '\n', ['甲'], 'partial');
  T('空表格应判 partial', 'f.md', '# T\n\n## 甲\n| 决策点 | 选定 |\n|---|---|\n\n' + DONE + '\n', ['甲'], 'partial');
  T('表格有数据行应判 ok', 'g.md', '# T\n\n## 甲\n| 决策点 | 选定 |\n|---|---|\n| 存储 | SQLite |\n\n' + DONE + '\n', ['甲'], 'ok');
  T('先盖章后正文为空应判 partial', 'h.md', '# T\n\n' + DONE + '\n\n## 甲\n\n', ['甲'], 'partial');
  T('围栏里的 # 不算标题', 'i.md', '# T\n\n```\n## 甲\n```\n\n' + DONE + '\n', ['甲'], 'partial');
  // 内容全在子小节里的父小节不算空壳（`## 逐条` 下面全是 `### AC-N` 是常态）
  T('内容在子小节里应判 ok', 'j.md', '# T\n\n## 甲\n\n### 甲一\n实际内容在这里\n\n' + DONE + '\n', ['甲'], 'ok');
  T('父子都空仍应判 partial', 'k.md', '# T\n\n## 甲\n\n### 甲一\n\n' + DONE + '\n', ['甲'], 'partial');
  T('文件不存在应判 missing', 'nope.md', '', [], 'missing');
  fs.unlinkSync(path.join(tmp, 'nope.md'));
  cases[cases.length - 1].got = checkMarkdown(path.join(tmp, 'nope.md'), []).state;
  cases[cases.length - 1].pass = cases[cases.length - 1].got === 'missing';

  T('截断 JSON 应判 partial', 'x.json', '{"a": 1, "b":', null, 'partial');
  T('无 _complete 应判 partial', 'y.json', '{"a": 1}', null, 'partial');
  T('有 _complete 应判 ok', 'z.json', '{"a": 1, "_complete": true}', null, 'ok');

  // ---- 散文准入 / 契约 / AC-7 新检查族的证伪用例（T1 契约，用例名是验收锚点） ----
  const baseCaseNames = cases.map((c) => c.name).slice(); // 原始 15 条用例名
  const lintTmp = path.join(tmp, 'lint');
  const mk = (rel, content) => {
    const p = path.join(lintTmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  };
  const L = (name, fn) => {
    let ok = false;
    try { ok = fn(); } catch (e) { ok = false; }
    cases.push({ name, expect: 'ok', got: ok ? 'ok' : 'fail', pass: ok, why: [] });
  };

  // AC-1：原始 15 条自检用例名必须全部仍在注册表（一条没少）
  L('AC-1 既有自检断言全绿应判 ok', () => baseCaseNames.every((n) => cases.some((c) => c.name === n)));

  // AC-2 孤儿：references/ 有文件但主文件从没引用它
  mk('skills/demo/SKILL.md', '# demo\n\n主文件，不引用任何 references。\n');
  mk('skills/demo/references/orphan.md', '# orphan\n');
  L('AC-2 孤儿文件应判 fail', () => runSkillLint(lintTmp, 'demo').orphans.some((o) => o.includes('orphan.md')));

  // AC-2 断链：钩子指向不存在的文件（AC-2 不查、但恰恰是规则搬丢的形状）
  fs.rmSync(path.join(lintTmp, 'skills', 'demo', 'references', 'orphan.md'));
  mk('skills/demo/SKILL.md', '# demo\n\n> 📎 **需要时** → 读 `references/nope.md`\n> 不读会：漏掉规则\n');
  L('AC-2 断链钩子应判 fail', () => runSkillLint(lintTmp, 'demo').dangles.some((d) => d.includes('nope.md')));

  // AC-3 钩子完整：条件 + 路径 + 后果子句齐全 → 不报
  mk('skills/demo/references/nope.md', '# nope\n规则内容。\n');
  mk('skills/demo/SKILL.md', '# demo\n\n> 📎 **存量代码要并行** → 读 `references/nope.md`（role=self）\n> 不读会：默认假设可并行，留下「项目是坏的」中间态\n');
  L('AC-3 钩子完整应判 ok', () => runSkillLint(lintTmp, 'demo').issues.length === 0);

  // AC-3 钩子缺后果：📎 后没有以 不读会/不转发会 开头的行
  mk('skills/demo/SKILL.md', '# demo\n\n> 📎 **存量代码要并行** → 读 `references/nope.md`\n');
  L('AC-3 钩子缺后果子句应判 fail', () => runSkillLint(lintTmp, 'demo').issues.some((i) => i.includes('后果子句')));

  // AC-6 加载清单：完整 vs 缺子清单（只在全量模式查）
  mk('skills/rd/strategies/guarded.md', '# 策略：guarded\n\n## 本策略的加载清单\n\n**会用到**\n- skills/demo/references/nope.md\n\n**永不加载**\n- skills/rd-eval/\n');
  L('AC-6 加载清单完整应判 ok', () => !runSkillLint(lintTmp).issues.some((i) => i.includes('guarded.md')));
  mk('skills/rd/strategies/guarded.md', '# 策略：guarded\n\n## 本策略的加载清单\n\n**会用到**\n- skills/rd-build/\n');
  L('AC-6 加载清单缺子清单应判 fail', () => runSkillLint(lintTmp).issues.some((i) => i.includes('guarded.md') && i.includes('永不加载')));

  // AC-4 条件名三态
  const okL2 = '## blocking\n\n### B1 问题\n\n- 判定条件: contract-break\n';
  const badL2 = '## blocking\n\n### B1 问题\n\n- 判定条件: very-severe\n';
  const noneL2 = '## blocking\n\n### B1 问题\n\n- 位置: x\n';
  L('AC-4 合法条件名应判 ok', () => checkL2Findings(okL2).length === 0);
  L('AC-4 拼错条件名应判 fail', () => checkL2Findings(badL2).some((i) => i.includes('不在合法集合')));
  L('AC-4 缺失条件名应判 fail', () => checkL2Findings(noneL2).some((i) => i.includes('缺「- 判定条件')));

  // AC-4 冻结表对账：authoring.md 围栏块与脚本常量不一致 → 报（A18 双路复算）
  mk('docs/authoring.md', '<!-- conditions:start -->\nwrong-name:blocking\n<!-- conditions:end -->\n<!-- receipt-fields:start -->\ntaskId\n<!-- receipt-fields:end -->\n');
  L('AC-4 冻结表漂移应判 fail', () => checkContractAlignment(path.join(lintTmp, 'docs', 'authoring.md')).length > 0);

  // AC-5 回执三态
  const okR = path.join(tmp, 'ok-receipt.json');
  fs.writeFileSync(okR, JSON.stringify({ _complete: true, taskId: 'T1', filesChanged: ['a.js'], selfCheckCommand: 'node --check a.js', selfCheckOutput: 'ok', deviations: '无' }), 'utf8');
  L('AC-5 合法回执应判 ok', () => checkReceipt(okR).length === 0);
  const missR = path.join(tmp, 'miss-receipt.json');
  fs.writeFileSync(missR, JSON.stringify({ _complete: true, taskId: 'T1' }), 'utf8');
  L('AC-5 缺字段回执应判 fail', () => checkReceipt(missR).some((i) => i.includes('filesChanged')));
  const phR = path.join(tmp, 'ph-receipt.json');
  fs.writeFileSync(phR, JSON.stringify({ _complete: true, taskId: 'T1', filesChanged: ['a.js'], selfCheckCommand: 'node --check a.js', selfCheckOutput: '{这里是输出}', deviations: '无' }), 'utf8');
  L('AC-5 占位符回执应判 fail', () => checkReceipt(phR).some((i) => i.includes('selfCheckOutput') && i.includes('空壳')));

  // AC-7 守恒：基线里有硬约束、改后全集里找不到 → 报
  const consBase = path.join(tmp, 'consbase');
  fs.mkdirSync(path.join(consBase, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(consBase, 'skills', 'demo', 'SKILL.md'),
    '# demo\n\n⛔ 不许在没采基线的情况下开工\n\n## 硬门槛\n\n- 不许假设可以并行\n', 'utf8');
  mk('skills/demo/SKILL.md', '# demo\n\n主文件没有那条约束了。\n');
  L('AC-7 硬约束守恒应判 fail', () => runSkillLint(lintTmp, 'demo', consBase).issues.some((i) => i.includes('AC-7 守恒')));

  let failed = 0;
  out('');
  out(C.cyan('=== 收尾检测点 · 证伪自检 ==='));
  out(C.dark('  先确认「已知应该失败的输入」真的会被判失败 —— 报不出失败的检查没有判别力。'));
  out('');
  for (const c of cases) {
    if (c.pass) out(C.green(`  ✓ ${c.name}`));
    else { failed++; out(C.red(`  ✗ ${c.name}  期望 ${c.expect}，实得 ${c.got}`)); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  out('');
  if (failed > 0) { out(C.red(`=== ${failed}/${cases.length} 条不通过 ===`)); out(''); process.exit(1); }
  out(C.green(`=== ${cases.length}/${cases.length} 条通过，检查具备判别力 ===`));
  out('');
  process.exit(0);
}

// ---- 框架自身结构检查（-SkillLint）：与 feature 产物生命周期分开，独立早退 ----
if (args.SkillLint) {
  const res = runSkillLint(Root, args.Skill, args.Baseline);
  out('');
  out(C.cyan('=== SkillLint' + (args.Skill ? ' [' + args.Skill + ']' : '') + ' ==='));
  out('');
  if (res.orphans.length) {
    out(C.red(`  ⛔ 孤儿 references/ ${res.orphans.length} 个（存在但从未被引用，AC-2）：`));
    for (const o of res.orphans) out(C.red('      · ' + o));
  } else {
    out(C.green('  ✓ 无孤儿 references/'));
  }
  if (res.dangles.length) {
    out(C.red(`  ⛔ 断链 ${res.dangles.length} 处（引用了不存在的文件）：`));
    for (const d of res.dangles) out(C.red('      · ' + d));
  } else {
    out(C.green('  ✓ 无断链'));
  }
  if (res.issues.length) {
    out(C.red(`  ⛔ ${res.issues.length} 处结构问题：`));
    for (const i of res.issues) out(C.red('      · ' + i));
  } else {
    out(C.green('  ✓ 无结构问题'));
  }
  for (const w of res.warns) out(C.yellow('  ⚠ ' + w));
  out('');
  if (res.orphans.length + res.dangles.length + res.issues.length > 0) {
    out(C.red('=== SkillLint FAIL ==='));
    out('');
    process.exit(1);
  }
  out(C.green('=== SkillLint PASS ==='));
  out('');
  process.exit(0);
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
const P = (rel) => path.join(fdir, rel);

// ---- 方案扇出对账：派出去 N 份，回来几份完整的 ----
/*
  这是 I-1 那个 bug 的正面防线。实跑里派了 3 个方案 agent，A 中断后归零，
  仲裁拿 2 份照常做完，全程无人知情 —— 因为方案当时根本不落盘，
  磁盘上没有任何东西能证明「本该有三份」。
  现在方案必须落到 proposals/plan-*.md，于是「回来几份」变成可数的。
*/
const proposalsDir = P('proposals');
const proposals = [];
for (const n of listDirFiles(proposalsDir, (x) => /^plan-.*\.md$/i.test(x))) {
  const res = checkMarkdown(path.join(proposalsDir, n), REQUIRED_SECTIONS.proposal);
  proposals.push({ name: n, state: res.state, why: res.why });
}
const proposalsOk = proposals.filter((p) => p.state === 'ok');
const proposalsPartial = proposals.filter((p) => p.state !== 'ok');

/*
  登记过、但磁盘上找不到对应文件的方案 —— 中断丢失的那一份。
  两个来源，缺一不可：
    · inflight.agents[].reportPath —— 中断当场就能看出来
    · run.planFanout.dispatched   —— **inflight 被清掉之后仍然算数**
  只靠 inflight 有个洞：派 3 份、回来 2 份，编排者顺手把 inflight 清了，
  「≥2 份完整」这条就过线了，少掉的那一份从此无人知晓。
  planFanout 是派发那一刻写死的名单，清 inflight 不影响它。
*/
const proposalsLost = [];
const lostSeen = new Set();
function noteLost(who, rel) {
  if (!rel || lostSeen.has(rel)) return;
  if (exists(path.join(Root, rel))) return;
  lostSeen.add(rel);
  proposalsLost.push(`${who} → ${rel}（派出去了，文件不存在 —— 这一份丢了）`);
}
if (run !== null && run.inflight && run.inflight.stage === 'plan') {
  for (const a of asList(run.inflight.agents)) noteLost(a.name || '?', a.reportPath);
}
if (run !== null && run.inflight) {
  for (const a of asList(run.inflight.agents)) {
    if (a.receiptPath) noteLost(a.name || '?', a.receiptPath);
  }
}
if (run !== null && run.planFanout) {
  for (const d of asList(run.planFanout.dispatched)) {
    if (typeof d === 'string') noteLost('planFanout', d);
    else noteLost(d.name || 'planFanout', d.reportPath || d.path);
  }
}

const stages = [];
stages.push({
  name: 'dispatch', label: '派发决策',
  missing: missLine('dispatch.md', checkMarkdown(P('dispatch.md'), REQUIRED_SECTIONS['dispatch.md']),
    'rd 要求 ≥M 复杂度落一份派发决策记录（六行）'),
});
stages.push({
  name: 'spec', label: '业务梳理',
  missing: [
    ...missLine('spec.md', checkMarkdown(P('spec.md'), REQUIRED_SECTIONS['spec.md'])),
    ...missLine('acceptance.json', checkJson(P('acceptance.json'))),
  ],
});

const planMissing = [];
// 方案份数：rd-plan 要求 2~3 个 agent 独立出方案，少于 2 份就没有「并行论证」可言
if (proposals.length === 0) {
  planMissing.push('proposals/plan-{a,b,c}.md  ← 一份方案都没落盘。方案只存在于返回消息里 = 中断即归零');
} else if (proposalsOk.length < 2) {
  planMissing.push(`proposals/ 只有 ${proposalsOk.length} 份完整方案（共 ${proposals.length} 份文件）` +
    '  ← rd-plan 要求 2~3 份独立方案。不足 2 份时「被排除的方案」无从谈起，仲裁等于走过场');
}
for (const p of proposalsPartial) {
  planMissing.push(`proposals/${p.name}  ⚠ 只写了一半：${p.why.join('；')}`);
}
for (const x of proposalsLost) planMissing.push('方案丢失：' + x);
planMissing.push(...missLine('design.md', checkMarkdown(P('design.md'), REQUIRED_SECTIONS['design.md'])));
planMissing.push(...missLine('tasks.json', checkJson(P('tasks.json'))));
if (!HasRoot('.rd/gates.json')) planMissing.push('.rd/gates.json');
if (!exists(runPath)) planMissing.push('run.json  ← rd-plan 明文要求「通过后写 run.json」');
stages.push({ name: 'plan', label: '方案与拆解', missing: planMissing });
// ---- 回执：已存在的逐份校验字段；缺席只报 advisory（对账走 receiptPath） ----
const receiptsMissing = [];
const receiptsDir = path.join(reports, 'receipts');
for (const n of listDirFiles(receiptsDir, (x) => /\.json$/i.test(x)).sort()) {
  for (const iss of checkReceipt(path.join(receiptsDir, n))) {
    receiptsMissing.push(`reports/receipts/${n}  ${iss}`);
  }
}

stages.push({
  name: 'build', label: '开发与测试层',
  missing: [
    ...(l1.length === 0 ? ['l1-round{N}.json  ← 一轮测试层都没跑过'] : []),
    ...receiptsMissing,
  ],
});

// 审查层：每个存在的 .diff 都必须有对应的 .md
const l2Missing = [];
if (l2.length === 0 && l2d.length === 0) {
  l2Missing.push('l2-round{N}.md + .diff  ← 一轮审查层都没跑过');
}
for (const n of l2d) {
  if (!l2.includes(n)) {
    l2Missing.push(`l2-round${n}.md  ← .diff 在但报告正文不在。rd-review:91 明文要求写正文`);
  }
}
// 已存在的审查报告，逐份查完成度 —— 被中断的报告和写完的报告，文件名长得一样
for (const n of listDirFiles(reports, (x) => /^l2-round.*\.md$/i.test(x))) {
  const full = path.join(reports, n);
  const res = checkMarkdown(full, REQUIRED_SECTIONS.l2);
  const miss = missLine('reports/' + n, res);
  // 每条 finding 必须标注命中的行为判定条件（缺/拼错都点名到具体发现）
  for (const fi of checkL2Findings(readText(full))) {
    miss.push('reports/' + n + '  ' + fi);
  }
  l2Missing.push(...miss);
}
stages.push({ name: 'review', label: '审查层', missing: l2Missing });

const l3Missing = [];
if (l3.length === 0) l3Missing.push('l3-round{N}.md  ← 一轮场景验收都没跑过');
for (const n of listDirFiles(reports, (x) => /^l3-round.*\.md$/i.test(x))) {
  l3Missing.push(...missLine('reports/' + n, checkMarkdown(path.join(reports, n), REQUIRED_SECTIONS.l3)));
}
/* 跑过验收层就必须留下运行手册。

   它是与 acceptance.json 并列的一等产物，只写「怎么观察」不写「怎么实现」。
   没有它，下一轮验收者会把时间花在重走上一轮已经走通的路上 ——
   实跑里第 1 轮 344 次工具调用、第 2 轮 122 次，其中大量是重复摸索
   （浏览器怎么驱动、页面什么结构、哪个标的数据不足、哪个控件点不动）。
   同时环境事实会随验收者退出而丢失，每轮判定口径也可能各自漂移。 */
if (l3.length > 0 && !exists(path.join(fdir, 'acceptance-runbook.md'))) {
  l3Missing.push('acceptance-runbook.md  ← 跑过验收层却没留下运行手册，下一轮验收者要从零重新摸索一遍');
}
stages.push({ name: 'eval', label: '验收层', missing: l3Missing });

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
// schema（唯一权威定义，rd/SKILL.md 铁律 7 里有同一张表）：
//   action       必填  kill-agent | modify-framework | skip-gate | manual-verdict
//                      | change-acceptance | relax-rule | extra-step
//   target       必填  动作作用在谁身上（agent 名 / 文件路径 / 门名 / AC 号）
//   reason       必填  为什么要做
//   ifNotDone    必填  不做会怎样（如实写，包括「其实也能继续，只是更慢」）
//   userDecision 必填  approved | rejected
//   ts           选填  ISO 时间戳
const OOF_KNOWN = ['action', 'target', 'reason', 'ifNotDone', 'userDecision', 'ts'];
const OOF_ACTIONS = ['kill-agent', 'modify-framework', 'skip-gate', 'manual-verdict',
  'change-acceptance', 'relax-rule', 'extra-step'];

const oof = run ? asList(run.outOfFlowActions) : [];
const oofNoDecision = [];
const oofMalformed = []; // 字段名对不上 schema 的：格式问题，不是违规
const oofBadAction = []; // 字段名对、但 action 取值未定义的：与上面分开计数
let oofFrameworkApproved = false;
for (const a of oof) {
  const keys = (a !== null && typeof a === 'object') ? Object.keys(a) : [];
  const knownHits = keys.filter((k) => OOF_KNOWN.indexOf(k) >= 0);

  // ⚠ 字段名不符时**不要**照常渲染。照常渲染会输出「? undefined → undefined [无裁决]」，
  //   并把这条计进「自作主张」——实跑里就是这么发生的：编排者按直觉写了
  //   { when, what, actor, detail }，结果被报成流程违规，查了半天才发现只是 schema 不对。
  //   降级为「列出实际见到的字段名」，让人一眼分清是格式问题还是真违规。
  if (knownHits.length === 0 || (a.action === undefined && a.target === undefined)) {
    oofMalformed.push(keys.length > 0 ? keys.join(', ') : '(空对象)');
    continue;
  }

  const missing = ['action', 'target', 'reason', 'ifNotDone', 'userDecision'].filter((k) => !a[k]);
  const label = `${a.action || '(缺 action)'} → ${a.target || '(缺 target)'}`;

  if (!a.userDecision) {
    oofNoDecision.push(label);
  } else if (missing.length > 0) {
    oofNoDecision.push(`${label}（缺 ${missing.join(' / ')}${missing.indexOf('ifNotDone') >= 0 ? '：没写清「不做会怎样」，等于诱导式提问' : ''}）`);
  }
  if (a.action === 'modify-framework' && a.userDecision === 'approved') {
    oofFrameworkApproved = true;
  }
  // 字段名对但 action 取值没定义 —— 与「字段名不符」分开计数。
  // 混在一个计数器里会汇总成「N 条流程外动作**字段名**不符 schema」，
  // 而 F2 的立意正是让人一眼分清问题类别。
  if (a.action && OOF_ACTIONS.indexOf(a.action) < 0) {
    oofBadAction.push(`action="${a.action}"（应为 ${OOF_ACTIONS.join(' | ')}）`);
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
    proposals,
    proposalsComplete: proposalsOk.length,
    proposalsLost,
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
out('    测试层     ' + (l1.length ? 'round ' + l1.join(', ') : '（无）'));
out('    审查层     ' + (l2.length ? 'round ' + l2.join(', ') : '（无）') + (l2d.length ? '   diff: round ' + l2d.join(', ') : ''));
out('    验收层     ' + (l3.length ? 'round ' + l3.join(', ') : '（无）'));
if (proposals.length > 0 || proposalsLost.length > 0) {
  const tail = proposalsPartial.length > 0 ? `，${proposalsPartial.length} 份只写了一半` : '';
  const line = `    方案扇出    ${proposalsOk.length} 份完整 / 共 ${proposals.length} 份${tail}`;
  out(proposalsOk.length >= 2 && proposalsPartial.length === 0 ? line : C.yellow(line));
  for (const x of proposalsLost) out(C.red('                ⛔ ' + x));
}
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
if (oof.length > 0 || oofNoDecision.length > 0 || oofMalformed.length > 0 || oofBadAction.length > 0) {
  out('');
  out(C.gray(`  流程外动作：${oof.length} 条（铁律 7 要求先问用户）`));
  for (const a of oof) {
    if (a === null || typeof a !== 'object' || (a.action === undefined && a.target === undefined)) continue;
    const mark = a.userDecision === 'approved' ? '✓' : (a.userDecision === 'rejected' ? '✗' : '?');
    out(C.dark(`     ${mark} ${a.action || '(缺 action)'} → ${a.target || '(缺 target)'}  [${a.userDecision ? a.userDecision : '无裁决'}]`));
  }
  if (oofMalformed.length > 0) {
    out(C.yellow('     ⚠ 下面这些**字段名对不上 schema**（是格式问题，不是流程违规）：'));
    for (const x of oofMalformed) out(C.yellow('        · 实际字段: ' + x));
    out(C.dark(`       应为: { ${OOF_KNOWN.join(', ')} }`));
  }
  if (oofBadAction.length > 0) {
    out(C.yellow('     ⚠ 下面这些**字段名是对的，但 action 取值未定义**：'));
    for (const x of oofBadAction) out(C.yellow('        · ' + x));
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
if (orphans.length > 0 || roundGaps.length > 0 || fwState === 'drifted' || oofNoDecision.length > 0 || oofMalformed.length > 0 || oofBadAction.length > 0) {
  const why = [];
  if (oofNoDecision.length > 0) why.push(`${oofNoDecision.length} 条流程外动作没有用户裁决`);
  if (oofMalformed.length > 0) why.push(`${oofMalformed.length} 条流程外动作字段名不符 schema`);
  if (oofBadAction.length > 0) why.push(`${oofBadAction.length} 条流程外动作的 action 取值未定义`);
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
