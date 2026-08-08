#!/usr/bin/env node
/*
  freeze-target —— 冻结 L2 审查目标，并在 reviewer 返回后校验目标没被动过。

  审查最常见的失效方式不是审得不好，而是"审的东西已经不是最终的东西"——
  reviewer 还在看的时候主流程又改了几个文件，findings 全部对不上号。
  这个脚本把 diff 内容做 SHA-256 存档，reviewer 返回后 -Verify 一次即可发现漂移。

  用法：
    # 冻结（先把改动 git add -A）
    node freeze-target.js -Feature user-login -Round 1
    # reviewer 返回后校验
    node freeze-target.js -Feature user-login -Round 1 -Verify

  退出码：0 = 已冻结 / OK 未漂移；1 = TargetMoved 漂移；2 = 用不了 / 没东西可审。
*/
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const isTty = process.stdout.isTTY;
const C = {
  gray: (s) => (isTty ? '[90m' + s + '[0m' : s),
  dark: (s) => (isTty ? '[90m' + s + '[0m' : s),
  red: (s) => (isTty ? '[31m' + s + '[0m' : s),
  green: (s) => (isTty ? '[32m' + s + '[0m' : s),
  yellow: (s) => (isTty ? '[33m' + s + '[0m' : s),
};
function out(s) { process.stdout.write(s + '\n'); }

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function parseArgs(argv) {
  const args = { Round: 1, Verify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-Verify' || a === '--Verify') { args.Verify = true; continue; }
    const m = a.match(/^--?([A-Za-z]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = m[2];
    if (val === undefined && i + 1 < argv.length && !/^--?/.test(argv[i + 1])) val = argv[++i];
    if (key === 'feature') args.Feature = val;
    else if (key === 'root') args.Root = val;
    else if (key === 'round') args.Round = parseInt(val, 10) || 1;
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));
const Root = args.Root || process.cwd();
const Feature = args.Feature || '';
const Round = args.Round;

if (!Feature) {
  out(C.red('[freeze] 缺少 -Feature'));
  process.exit(2);
}

// ---- 跑 git（数组参数，不走 shell，天然避开 2>NUL / 引号这类 cmd 专属写法）----
function git(argvArr, cwd) {
  const r = spawnSync('git', argvArr, { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const code = r.error ? 1 : (r.status === null ? 1 : r.status);
  return {
    code,
    stdout: r.stdout ? r.stdout.toString('utf8') : '',
    stderr: r.stderr ? r.stderr.toString('utf8') : '',
  };
}

// ---- 冻结范围：默认只冻结 tasks.json 声明的文件，而不是全仓 diff ----
// 实跑教训：新项目没有 .gitignore 时 git add -A 会把 node_modules 全部 staged，
// 冻结出几百个文件的「审查目标」。有了声明范围，越界改文件就变成可机械检测的。
function getDeclaredFiles(featureDir) {
  const tasksPath = path.join(featureDir, 'tasks.json');
  if (!fs.existsSync(tasksPath)) return [];
  let t;
  try { t = JSON.parse(fs.readFileSync(tasksPath, 'utf8')); } catch { return []; }
  const outArr = [];
  for (const task of (Array.isArray(t.tasks) ? t.tasks : [])) {
    for (const f of (Array.isArray(task.files) ? task.files : [])) {
      if (f !== null && f !== undefined) outArr.push(String(f).replace(/\\/g, '/'));
    }
  }
  return Array.from(new Set(outArr)).sort();
}

function getCurrentDiff(repoRoot, scope) {
  // 有声明范围就用 git pathspec 限定；没有则退回全仓
  const scoped = scope && scope.length > 0;
  const specArgs = scoped ? ['--', ...scope] : [];

  // ⚠ `--name-only` 必须放在 `--` **之前**，否则会被 git 当成 pathspec 里的一个文件名。
  let diff = git(['diff', '--staged', ...specArgs], repoRoot);
  if (diff.code !== 0) {
    throw new Error('git diff --staged 失败：' + (diff.stdout + '\n' + diff.stderr));
  }
  let text = diff.stdout;
  let mode = 'staged';
  if (!text.trim()) {
    text = git(['diff', 'HEAD', ...specArgs], repoRoot).stdout;
    mode = 'worktree';
  }

  let files = git(['diff', '--staged', '--name-only', ...specArgs], repoRoot).stdout.split(/\r?\n/).filter((x) => x.trim());
  if (mode === 'worktree') {
    files = git(['diff', 'HEAD', '--name-only', ...specArgs], repoRoot).stdout.split(/\r?\n/).filter((x) => x.trim());
  }

  // 越界检测：不带 pathspec 再取一次全量改动名单，差集就是「不在任何 task 的 files 里」的
  let outOfScope = [];
  if (scoped) {
    const allCmd = mode === 'staged' ? ['diff', '--staged', '--name-only'] : ['diff', 'HEAD', '--name-only'];
    const all = git(allCmd, repoRoot).stdout.split(/\r?\n/).filter((x) => x.trim());
    const scopeSet = new Set(scope.map((s) => s.toLowerCase()));
    for (const f of all) {
      const n = String(f).trim().replace(/\\/g, '/');
      if (n && !scopeSet.has(n.toLowerCase())) outOfScope.push(n);
    }
  }

  // 不能把 git 的错误输出当成 commit 号存下来：校验形态，不然宁可留空。
  const rev = git(['rev-parse', 'HEAD'], repoRoot);
  let base = null;
  if (rev.code === 0) {
    const b = rev.stdout.trim();
    if (/^[0-9a-f]{7,40}$/i.test(b)) base = b;
  }

  return { text, mode, files, base, outOfScope };
}

const dir = path.join(Root, '.rd', 'features', Feature);
const targetPath = path.join(dir, 'review-target.json');

if (!fs.existsSync(dir)) {
  out(C.red(`[freeze] 找不到 ${dir}`));
  process.exit(2);
}

const declared = getDeclaredFiles(dir);
if (declared.length === 0) {
  out(C.yellow('[freeze] ⚠ 读不到 tasks.json 的 files 声明，退回**全仓 diff**。'));
  out(C.dark('         全仓 diff 会把依赖目录、构建产物一起冻进审查目标（实测出现过 682 个文件），'));
  out(C.dark('         reviewer 要么被淹没要么草草扫过 —— 两种结果都让冻结机制形同虚设。'));
}

let current;
try {
  current = getCurrentDiff(Root, declared);
} catch (e) {
  out(C.red('[freeze] ' + (e && e.message ? e.message : String(e))));
  process.exit(2);
}
const hash = sha256Hex(current.text);

if (args.Verify) {
  if (!fs.existsSync(targetPath)) {
    out(C.red('[freeze] 没有已冻结的目标，无法校验。'));
    process.exit(2);
  }
  const frozen = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  if (frozen.sha256 === hash) {
    out(C.green(`[freeze] OK —— 目标未漂移 (${hash.substring(0, 12)})`));
    process.exit(0);
  }
  out(C.red('[freeze] TargetMoved —— 审查目标在审查期间被改动'));
  out(C.yellow(`         冻结时: ${frozen.sha256.substring(0, 12)}  (${frozen.frozenAt})`));
  out(C.yellow(`         当前:   ${hash.substring(0, 12)}`));
  out(C.yellow('         本轮审查作废。重新冻结完整目标后再派 reviewer。'));
  process.exit(1);
}

if (!current.text.trim()) {
  out(C.yellow('[freeze] 工作树没有任何改动，没什么可审的。'));
  process.exit(2);
}

const diffDir = path.join(dir, 'reports');
fs.mkdirSync(diffDir, { recursive: true });
const diffPath = path.join(diffDir, `l2-round${Round}.diff`);
// 必须写成与 sha256Hex 完全相同的字节（UTF-8 无 BOM），否则第三方对这个文件
// 重新 hash 会得到与 review-target.json 记录不同的值。
fs.writeFileSync(diffPath, current.text, 'utf8');

const outOfScope = current.outOfScope.filter((x) => x && x.trim());

const target = {
  feature: Feature,
  round: Round,
  mode: current.mode,
  sha256: hash,
  baseCommit: current.base,
  scope: declared.length > 0 ? 'tasks.json declared files' : 'whole-repo (fallback)',
  scopeFiles: declared,
  files: current.files.filter((x) => x && x.trim()),
  outOfScope,
  diffPath,
  frozenAt: new Date().toISOString(),
};
fs.writeFileSync(targetPath, JSON.stringify(target, null, 2), 'utf8');

out('');
out(C.green('[freeze] 目标已冻结'));
out(C.gray(`         sha256 : ${hash.substring(0, 12)}`));
out(C.gray(`         mode   : ${current.mode}`));
out(C.gray(`         scope  : ${target.scope}  (${declared.length} 个声明文件)`));
out(C.gray(`         files  : ${target.files.length}  ← 本轮实际改动且在范围内的`));
out(C.gray(`         diff   : ${diffPath}`));

if (outOfScope.length > 0) {
  out('');
  out(C.yellow(`         ⚠ 有 ${outOfScope.length} 个改动文件**不在任何 task 的 files 声明里**：`));
  for (const f of outOfScope.slice(0, 12)) out(C.yellow('             ' + f));
  if (outOfScope.length > 12) out(C.yellow(`             …还有 ${outOfScope.length - 12} 个`));
  out(C.dark('         它们**不在本次审查目标里**。要么是越界改动（agent 改了白名单外的文件)，'));
  out(C.dark('         要么是 tasks.json 的 files 声明漏了。两种都该先弄清楚再派 reviewer。'));
}

out('');
out(C.dark('         现在可以派 reviewer。在它返回之前不要改动工作树。'));
out('');
process.exit(0);
