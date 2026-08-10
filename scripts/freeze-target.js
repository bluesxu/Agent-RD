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
  // ⛔ 永远带 -c core.quotepath=false：默认值 true 会把非 ASCII 路径输出成八进制转义
  //   （"src/ä¸­..."），ls-files / diff --name-only 拿到转义串后，
  //   intent-to-add 找不到文件、声明路径永远匹配不上 —— 中文 Windows 上中文文件名直接全链断裂。
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...argvArr], { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
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

// ---- .rd 下的测试文件：被 gitignore 后 git diff 看不见，只能走磁盘 ----
// AC 测试由 Builder 写在 .rd/features/{Feature}/tests/，整体不进 git。
// git diff 对它们不可见（gitignored），但 L2 判断「这份绿是不是真的」必须读它们 ——
// 所以这里从磁盘 walk，纳入冻结目标与 diff。相对路径与 tasks.json 的 files 同基准（项目根）。
function readTestFiles(featureDir) {
  const tdir = path.join(featureDir, 'tests');
  const out = [];
  if (!fs.existsSync(tdir)) return out;
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(tdir, relDir), { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const rel = relDir ? relDir + '/' + e.name : e.name;
      if (e.isDirectory()) { stack.push(rel); continue; }
      if (!e.isFile()) continue;
      let buf;
      try { buf = fs.readFileSync(path.join(tdir, rel), 'utf8'); } catch { continue; }
      out.push({ rel: ('.rd/features/' + Feature + '/tests/' + rel).replace(/\\/g, '/'), sha256: sha256Hex(buf), content: buf });
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

// 测试段的确定性文本：相对上一轮快照只出有变化的文件（与 git diff 的增量语义一致）。
// 返回空串 = 本轮测试没有变化或还没有测试。
function buildTestSection(testFiles, prevSnap) {
  const prev = prevSnap || {};
  const changed = testFiles.filter((t) => prev[t.rel] !== t.sha256);
  if (changed.length === 0) return '';
  const lines = ['', '# --- tests/ under .rd/features/' + Feature + '/tests (gitignored, disk-walked) ---'];
  for (const t of changed) {
    lines.push('', '--- ' + t.rel + ' (sha256 ' + t.sha256.substring(0, 12) + ') ---', t.content.replace(/\n$/, ''));
  }
  return lines.join('\n') + '\n';
}

function loadSnap(diffDir, round) {
  const p = path.join(diffDir, `tests-round${round}.snap.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function snapOf(testFiles) {
  const snap = {};
  for (const t of testFiles) snap[t.rel] = t.sha256;
  return snap;
}

// ---- 未跟踪文件：git diff 天然看不见它们 ----
// 实跑教训：某轮 src/web/、public/ 和全部新测试都是未跟踪文件，两轮 freeze 生成的 diff
// 因此**逐字节相同**、且都不含本次改动的主体 —— 「审冻结 diff」实际什么都没审到，
// 而 L1/L2 双绿。修法：冻结前对**范围内**的未跟踪文件做 intent-to-add
// （`git add -N`，只登记路径不暂存内容），让它们以「新文件」形态进入 diff。
/* ⚠ 路径基准：`ls-files` 的输出相对 **cwd**，而 `diff --name-only` 的输出相对 **仓库根**。
   项目根就是仓库根时两者恰好相同，一旦项目嵌在更大的仓库里（monorepo，或 .git 在上层）
   就会错位 —— 同一个文件会同时出现在「已纳入」和「越界」两个清单里，
   越界清单从此 100% 是噪音，编排者只能学会无视它。
   统一用 `--full-name` 把 ls-files 也拉到仓库根基准。 */
function listUntracked(repoRoot, scope) {
  const specArgs = scope && scope.length > 0 ? ['--', ...scope] : [];
  const r = git(['ls-files', '--others', '--exclude-standard', '--full-name', ...specArgs], repoRoot);
  if (r.code !== 0) return [];
  return r.stdout.split(/\r?\n/).map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean);
}

// 项目根在仓库里的前缀（仓库根本身时为空串）。用来把 tasks.json 的声明路径
// （相对项目根）换算成仓库根基准，好和 diff/ls-files 的输出比对。
function repoPrefix(repoRoot) {
  const r = git(['rev-parse', '--show-prefix'], repoRoot);
  if (r.code !== 0) return '';
  return r.stdout.trim().replace(/\\/g, '/');
}

/* 内部一律用**仓库根基准**的路径（ls-files 加了 --full-name，diff 本来就是）。
   但 git 的 pathspec 是相对 **cwd** 解释的，所以真正下命令前必须把前缀脱掉，
   否则在子目录里跑会拼成 `app/app/src/a.js` 这种不存在的路径而静默失败。 */
function stripPrefix(p, prefix) {
  if (prefix && p.toLowerCase().indexOf(prefix.toLowerCase()) === 0) return p.slice(prefix.length);
  return p;
}

function intentToAdd(repoRoot, files, prefix) {
  const added = [];
  const failed = [];
  // 分批：路径多时一次性传会撞命令行长度上限，静默失败比报错更难查。
  const BATCH = 100;
  for (let i = 0; i < files.length; i += BATCH) {
    const chunk = files.slice(i, i + BATCH);
    const r = git(['add', '-N', '--', ...chunk.map((f) => stripPrefix(f, prefix))], repoRoot);
    if (r.code === 0) added.push(...chunk);
    else failed.push(...chunk);
  }
  return { added, failed };
}

function computeOutOfScope(repoRoot, scope, prefix, nameCmd, untrackedSkipped, isRdInternal) {
  const all = git(nameCmd, repoRoot).stdout.split(/\r?\n/).filter((x) => x.trim());
  // 声明路径相对项目根，diff / ls-files 的输出相对仓库根 —— 比对前先补上前缀。
  const scopeSet = new Set((Array.isArray(scope) ? scope : []).map((s) => (prefix + String(s).replace(/\\/g, '/')).toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const f of all.concat(untrackedSkipped)) {
    const n = String(f).trim().replace(/\\/g, '/');
    if (!n || isRdInternal(n)) continue; // .rd/ 是框架自己的记账，每轮都变，不是越界
    if (!scopeSet.has(n.toLowerCase()) && !seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      out.push(n);
    }
  }
  return out;
}

function getCurrentDiff(repoRoot, scope, opts) {
  // 有声明范围就用 git pathspec 限定；没有则退回全仓
  const scoped = scope && scope.length > 0;
  const specArgs = scoped ? ['--', ...scope] : [];
  const mutate = !(opts && opts.readOnly === true);

  // ① 未跟踪文件必须在任何 diff 之前纳入，否则新文件对 diff 不可见。
  //
  // ⛔ `.rd/` 要排除掉：它装的是本框架自己的产物（reports/、run.json、上一轮的 .diff）。
  //    .rd 是**本地工作区**（用户裁决：不进 git，不污染共享仓库），所以它们全是「未跟踪」的。
  //    不排除的话有两个后果：全仓兜底时把上一轮的 diff 文件冻进本轮 diff（自己包含自己）；
  //    以及每轮都把一堆 .rd/reports/*.diff 报成「agent 越界改了文件」—— 狼来了喊多了，
  //    真正的越界就没人看了。任务显式在 tasks.json 里声明的 .rd 文件不受影响（走 pathspec）。
  // `.rd/` 可能位于仓库根，也可能位于项目根（项目嵌在更大的仓库里时）。两种都要认。
  const prefix = repoPrefix(repoRoot);
  const isRdInternal = (p) => /(^|\/)\.rd\//.test(p);
  const untrackedAll = listUntracked(repoRoot, null).filter((p) => !isRdInternal(p));
  const untrackedInScope = scoped ? listUntracked(repoRoot, scope) : untrackedAll;
  const inScopeSetForCount = new Set(untrackedInScope.map((s) => s.toLowerCase()));
  const untrackedSkipped = untrackedAll.filter((u) => !inScopeSetForCount.has(u.toLowerCase()));

  /* ⛔ -Verify 不许改 index。
     它的契约是只读：拿当前状态算一次哈希去比对。在这里跑 `git add -N` 有两个后果 ——
     ① 一个声明为「校验」的动作却在改用户的仓库；
     ② 被 -N 登记过的未跟踪文件从此会被 `git reset --hard` 删掉（原本 reset 不碰它们）。
     校验路径改为**不写**，新出现的范围内未跟踪文件由下面的 newUntracked 单独报成漂移。 */
  const ita = mutate ? intentToAdd(repoRoot, untrackedInScope, prefix) : { added: [], failed: [] };
  const newUntracked = mutate ? [] : untrackedInScope;

  /* ⛔ skip-worktree / assume-unchanged 标记（NEW-3）：git 对这类文件**自己选择**
     不显示 diff 内容。混在正常改动里时它们会静默消失 —— 范围内声明的文件改动了，
     但 diff 里没有它、files 里没有它、零报警。与 F1 原缺陷同形状。
     `git ls-files -v` 的首字母小写即标记：s/S = skip-worktree，h/H = assume-unchanged（H 是正常暂存）。
     这些文件必须被点名，让编排者决定要不要处理。 */
  const markL = git(['ls-files', '-v', ...specArgs], repoRoot);
  const masked = [];
  if (markL.code === 0) {
    for (const ln of markL.stdout.split(/\r?\n/)) {
      // ⛔ 不许带 /i —— git ls-files -v 的正常缓存标记是**大写 H**，带 i 会把
      //    每个被跟踪的普通文件都当成 skip-worktree，masked 变成全量噪音。
      const m = ln.match(/^([sSh])\s+(.+)$/);
      if (m) masked.push(m[2].trim().replace(/\\/g, '/'));
    }
  }

  /* ⛔ 这里**固定用 `git diff HEAD`**，不再在 staged / worktree 之间二选一。

     踩过的坑：原先「有 intent-to-add 就走 HEAD，否则先试 --staged」看似等价，
     实际上第 2 轮就会退回它要修的那个缺陷 ——
     `git add -N` 是**一次性**的：第 1 轮登记之后，该文件不再出现在
     `ls-files --others` 里，于是第 2 轮 ita.added 为空 → 回落到 --staged；
     而 git ≥ 2.28 的 `diff --cached` **完全不显示 ita 条目**。
     只要 index 里有任何已暂存改动（真实流程里非常常见），
     第 2 轮冻出的 diff 里新文件就整个消失，而输出显示「未跟踪: 0 个」一切正常。

     `diff HEAD` 是 `diff --staged` 的超集（已暂存 + 未暂存 + ita 的内容全在），
     语义就是「相对上一次提交，这个工作树改了什么」—— 正是审查目标该有的定义。
     少一个可选分支，就少一条能静默丢内容的路径。 */
  const probe = git(['diff', 'HEAD', ...specArgs], repoRoot);
  if (probe.code !== 0) {
    // NEW-6：`git init` 后还没 commit 就 freeze 时 HEAD 不存在，diff 会报 bad revision。
    // 报错本身可读，但「fatal: bad revision 'HEAD'」会让新用户以为脚本坏了。
    // 一个没有任何提交的仓库本来也没有「相对上一次提交的改动」可言，直接说明白。
    const isUnborn = git(['rev-parse', '--verify', 'HEAD'], repoRoot).code !== 0;
    if (isUnborn) {
      throw new Error('仓库还没有任何提交（unborn HEAD）。freeze 需要一次初始提交作为 diff 的基准 —— 先 `git commit` 一次，再冻结。');
    }
    throw new Error('git diff HEAD 失败：' + (probe.stdout + '\n' + probe.stderr));
  }
  const text = probe.stdout;
  const mode = 'worktree';

  // ⚠ `--name-only` 必须放在 `--` **之前**，否则会被 git 当成 pathspec 里的一个文件名。
  const nameCmd = ['diff', 'HEAD', '--name-only'];
  let files = git([...nameCmd, ...specArgs], repoRoot).stdout.split(/\r?\n/).filter((x) => x.trim());

  // 越界检测：不带 pathspec 再取一次全量改动名单，差集就是「不在任何 task 的 files 里」的。
  // 未跟踪文件同样要参与越界检测 —— 范围外的新文件是最容易被漏掉的一类越界。
  // 声明为空（全仓兜底）时也照算 —— 见 getCurrentDiff 的调用方（-Verify 用它做范围外漂移比对）。
  const outOfScope = computeOutOfScope(repoRoot, scope, prefix, nameCmd, untrackedSkipped, isRdInternal);

  // 不能把 git 的错误输出当成 commit 号存下来：校验形态，不然宁可留空。
  const rev = git(['rev-parse', 'HEAD'], repoRoot);
  let base = null;
  if (rev.code === 0) {
    const b = rev.stdout.trim();
    if (/^[0-9a-f]{7,40}$/i.test(b)) base = b;
  }

  return {
    text, mode, files, base, outOfScope,
    masked,
    untracked: {
      included: ita.added, failed: ita.failed,
      outOfScopeCount: untrackedSkipped.length,
      newSinceFreeze: newUntracked,
    },
  };
}

const dir = path.join(Root, '.rd', 'features', Feature);
const diffDir = path.join(dir, 'reports');
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
  current = getCurrentDiff(Root, declared, { readOnly: args.Verify });
} catch (e) {
  out(C.red('[freeze] ' + (e && e.message ? e.message : String(e))));
  process.exit(2);
}

// 测试文件在 .rd/features/{Feature}/tests/、被 gitignore，git diff 看不见 —— 从磁盘收集，
// 与 git diff 拼成同一份可哈希的审查文本（freeze 与 -Verify 用同一条路径重算）。
const testFiles = readTestFiles(dir);
const prevSnap = loadSnap(diffDir, Round - 1);
const testSection = buildTestSection(testFiles, prevSnap);
const combined = current.text + testSection;
const hash = sha256Hex(combined);

if (args.Verify) {
  if (!fs.existsSync(targetPath)) {
    out(C.red('[freeze] 没有已冻结的目标，无法校验。'));
    process.exit(2);
  }
  const frozen = JSON.parse(fs.readFileSync(targetPath, 'utf8'));

  /* 测试文件漂移点名：git 看不见它们，sha256 比对会涵盖但报不出位置 —— 单独对账。
     冻结时把 testFiles（路径+sha）写进了 review-target.json，校验时重算并与它差集比对。 */
  const frozenTests = new Map((Array.isArray(frozen.testFiles) ? frozen.testFiles : []).map((t) => [t.path, t.sha256]));
  const drift = [];
  for (const t of testFiles) {
    if (!frozenTests.has(t.rel)) drift.push(t.rel + '  ← 新增');
    else if (frozenTests.get(t.rel) !== t.sha256) drift.push(t.rel + '  ← 内容变化');
  }
  for (const p of frozenTests.keys()) {
    if (!testFiles.some((t) => t.rel === p)) drift.push(p + '  ← 被删除');
  }
  if (drift.length > 0) {
    out(C.red('[freeze] TargetMoved —— 审查期间测试文件被改动'));
    for (const f of drift.slice(0, 10)) out(C.yellow('         ' + f));
    if (drift.length > 10) out(C.yellow(`         …还有 ${drift.length - 10} 个`));
    out(C.yellow('         本轮审查作废。重新冻结完整目标后再派 reviewer。'));
    process.exit(1);
  }

  /* ⛔ 范围外漂移（NEW-2）：-Verify 只比范围内哈希，范围外文件的改动不进 hash。
     冻结时把 outOfScope 快照写进了 review-target.json，校验时必须重算并与它差集比对 ——
     审查期间改/新增一个范围外文件，等于交付内容在 reviewer 眼皮底下变了，
     校验器却宣告「目标未漂移」。框架自己的文案把越界清单定义为
     「要么越界改动、要么 files 声明漏了」—— 所以它本来就是一个重要信号。
     冻结后新增的范围外未跟踪文件，ls-files 会列出，但 diff 不会 —— 也要查。 */
  const frozenOut = new Set((Array.isArray(frozen.outOfScope) ? frozen.outOfScope : []).map((p) => p.toLowerCase()));
  const appearedOut = current.outOfScope.filter((p) => !frozenOut.has(p.toLowerCase()));
  if (appearedOut.length > 0) {
    out(C.red('[freeze] TargetMoved —— 审查期间新增了范围外文件（越界改动）'));
    for (const f of appearedOut.slice(0, 10)) out(C.yellow('         + ' + f));
    if (appearedOut.length > 10) out(C.yellow(`         …还有 ${appearedOut.length - 10} 个`));
    out(C.yellow('         本轮审查作废。重新冻结完整目标后再派 reviewer。'));
    process.exit(1);
  }

  /* 校验路径不写 index（见 getCurrentDiff 的说明），所以冻结之后**新出现**的
     范围内未跟踪文件不会自动进 diff —— 它们的哈希影响为零，光比 sha256 发现不了。
     单独点名成漂移：审查期间新增文件属于目标被改动，和改一行没有区别。 */
  const appeared = current.untracked.newSinceFreeze.filter((f) => f && f.trim());
  if (appeared.length > 0) {
    out(C.red('[freeze] TargetMoved —— 审查期间新增了范围内的文件'));
    for (const f of appeared.slice(0, 10)) out(C.yellow('         + ' + f));
    if (appeared.length > 10) out(C.yellow(`         …还有 ${appeared.length - 10} 个`));
    out(C.yellow('         本轮审查作废。重新冻结完整目标后再派 reviewer。'));
    process.exit(1);
  }

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

if (!current.text.trim() && testSection.trim() === '') {
  out(C.yellow('[freeze] 工作树没有任何改动，也没有测试变化，没什么可审的。'));
  out(C.dark('         （未跟踪文件已通过 git add -N 一并检查过，不是「新文件看不见」）'));
  process.exit(2);
}

fs.mkdirSync(diffDir, { recursive: true });
const diffPath = path.join(diffDir, `l2-round${Round}.diff`);
// 必须写成与 sha256Hex 完全相同的字节（UTF-8 无 BOM），否则第三方对这个文件
// 重新 hash 会得到与 review-target.json 记录不同的值。
fs.writeFileSync(diffPath, current.text + testSection, 'utf8');
// 测试快照：供下一轮增量只重审变化的测试，也供 -Verify 比对漂移。
fs.writeFileSync(path.join(diffDir, `tests-round${Round}.snap.json`), JSON.stringify(snapOf(testFiles), null, 2), 'utf8');

const outOfScope = current.outOfScope.filter((x) => x && x.trim());
const declaredLower = new Set(declared.map((s) => s.toLowerCase()));
const testsOutOfScope = testFiles.filter((t) => !declaredLower.has(t.rel.toLowerCase()));

const target = {
  feature: Feature,
  round: Round,
  mode: current.mode,
  sha256: hash,
  baseCommit: current.base,
  scope: declared.length > 0 ? 'tasks.json declared files' : 'whole-repo (fallback)',
  scopeFiles: declared,
  files: current.files.filter((x) => x && x.trim()),
  testFiles: testFiles.map((t) => ({ path: t.rel, sha256: t.sha256 })),
  testsOutOfScope: testsOutOfScope.map((t) => t.rel),
  outOfScope,
  masked: current.masked,
  untrackedIncluded: current.untracked.included,
  untrackedFailed: current.untracked.failed,
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
out(C.gray(`         tests  : ${testFiles.length}  ← 磁盘 walk .rd/features/${Feature}/tests/`));
out(C.gray(`         diff   : ${diffPath}`));

// 未跟踪文件的纳入情况必须显式播报 —— 这一栏为 0 而工作树里明明有新文件时，
// 就是「diff 看不见新文件」这个故障正在发生。
const ut = current.untracked;
if (ut.included.length > 0) {
  out(C.green(`         未跟踪  : 已纳入 ${ut.included.length} 个（git add -N，只登记路径不暂存内容）`));
  for (const f of ut.included.slice(0, 8)) out(C.dark('             + ' + f));
  if (ut.included.length > 8) out(C.dark(`             …还有 ${ut.included.length - 8} 个`));
} else {
  out(C.gray('         未跟踪  : 0 个'));
}
if (ut.failed.length > 0) {
  out(C.red(`         ⚠ 有 ${ut.failed.length} 个未跟踪文件 git add -N 失败，**没进 diff**：`));
  for (const f of ut.failed.slice(0, 8)) out(C.red('             ! ' + f));
  out(C.red('           这些文件不在审查目标里。先弄清原因，否则本轮审查有盲区。'));
}
if (ut.outOfScopeCount > 0) {
  out(C.yellow(`         ⚠ 另有 ${ut.outOfScopeCount} 个未跟踪文件在声明范围之外，已跳过（见下方越界清单）`));
}

if (outOfScope.length > 0) {
  out('');
  out(C.yellow(`         ⚠ 有 ${outOfScope.length} 个改动文件**不在任何 task 的 files 声明里**：`));
  for (const f of outOfScope.slice(0, 12)) out(C.yellow('             ' + f));
  if (outOfScope.length > 12) out(C.yellow(`             …还有 ${outOfScope.length - 12} 个`));
  out(C.dark('         它们**不在本次审查目标里**。要么是越界改动（agent 改了白名单外的文件)，'));
  out(C.dark('         要么是 tasks.json 的 files 声明漏了。两种都该先弄清楚再派 reviewer。'));
}

if (testsOutOfScope.length > 0) {
  out('');
  out(C.yellow(`         ⚠ 有 ${testsOutOfScope.length} 个测试文件**不在任何 task 的 files 声明里**（越界）：`));
  for (const f of testsOutOfScope.slice(0, 12)) out(C.yellow('             ' + f.rel));
  if (testsOutOfScope.length > 12) out(C.yellow(`             …还有 ${testsOutOfScope.length - 12} 个`));
  out(C.dark('         Builder 在白名单外写了测试文件。修掉，或把路径加进 tasks.json 的 files。'));
}

if (current.masked.length > 0) {
  out('');
  out(C.yellow(`         ⚠ 有 ${current.masked.length} 个**范围内**文件带 skip-worktree / assume-unchanged 标记：`));
  for (const f of current.masked.slice(0, 12)) out(C.yellow('             ! ' + f));
  if (current.masked.length > 12) out(C.yellow(`             …还有 ${current.masked.length - 12} 个`));
  out(C.dark('         git 对这类文件**不显示 diff 内容** —— 它们就算被改了，本 diff 里也看不到。'));
  out(C.dark('         要么去掉标记（git update-index --no-skip-worktree <file>），要么本轮审查就不覆盖这些文件，先说清楚。'));
}

out('');
out(C.dark('         现在可以派 reviewer。在它返回之前不要改动工作树。'));
out('');
process.exit(0);
