#!/usr/bin/env node
/*
  gate-test —— 测试层，零 LLM 成本。

  （1a 阶段：文件从 gate-l1.js 改名而来，职责仍是跑 .rd/gates.json 机械门；
   1d 阶段改为「跑审查层写的全部测试（-MustMatch 锚点）+ 文档校验」。）

  按 .rd/gates.json 里的顺序逐条执行命令，任一 required 项失败即整体失败。
  命令越便宜的放越前面，早失败早退出，省下后面所有审查 token。

  用法：
    node gate-test.js
    node gate-test.js -Feature user-login -Round 2
    node gate-test.js -Feature user-login -Round 2 -ContinueOnFailure

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

/* ---- 语法门（kind: "syntax"）----

   为什么要内建而不是写成一条 cmd：`node --check` **一次只吃一个文件**，
   `node --check public/*.js` 在 shell 展开成多个参数后直接报错；
   而且通配的展开行为 cmd 与 sh 还不一样。于是「给前端加个语法下限」
   这件本该零成本的事，写成 cmd 反而没人写得对。

   实跑教训：public/ 完全在机器门之外，一个 canvas 渲染缺陷靠 L3 真实浏览器
   才暴露，白跑一整轮 —— 而在那之前，连语法层都没有门。
   tsc 不覆盖 public/ 是设计，但逐文件 node --check 是零成本的下限。

   配置形如：
     { "name": "frontend-syntax", "kind": "syntax",
       "dirs": ["public", "src/web"], "ext": [".js", ".mjs"] }
   不写 ext 时默认 .js / .mjs / .cjs。exclude 默认排除 node_modules / .git。 */
const DEFAULT_SYNTAX_EXT = ['.js', '.mjs', '.cjs'];

/* ⚠ 默认排除**只有** node_modules 和 .git，不含 dist / build / coverage。

   原先带上了后三个，而排除是按 basename 在**每一层**匹配的 ——
   于是任何叫 `build/` 的业务目录（构建脚本源码、`src/dist/` 这种命名的产物页）
   会被整体跳过，而「空过防护」只在一个文件都没找到时才触发，
   少检查一半文件照样报 PASS。实测 `src/build/broken.js` 里一个确定的语法错误被判绿。

   两种错的代价不对称：多查一个产物目录只是慢一点，
   漏查一个真源码目录会让 L1 报出一个伪造的绿。所以默认宁可多查。
   项目确有需要就自己写 exclude。 */
const DEFAULT_SYNTAX_EXCLUDE = ['node_modules', '.git'];

function collectFiles(root, dirs, exts, excludes) {
  const acc = [];
  let symlinks = 0;
  for (const d of dirs) {
    const base = path.resolve(root, d);
    if (!fs.existsSync(base)) continue;
    const stack = [base];
    while (stack.length > 0) {
      const cur = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (excludes.indexOf(e.name) >= 0) continue;
        const full = path.join(cur, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        if (e.isFile()) {
          if (exts.indexOf(path.extname(e.name).toLowerCase()) >= 0) acc.push(full);
          continue;
        }
        // 符号链接：不跟随（避免软链环导致无限递归），但要计数 ——
        // 静默跳过会让 monorepo 里 symlink 的源码目录整体漏检而无人知晓。
        if (e.isSymbolicLink() && exts.indexOf(path.extname(e.name).toLowerCase()) >= 0) symlinks++;
      }
    }
  }
  return { files: acc.sort(), symlinks };
}

/* ⚠ 不再做「进程内 vm 编译」快路径 —— N6 当初为了省 spawn 开销加过，被 L2 复审
   抓出假绿：`vm.Script` 按传统脚本解析，接受 `var await = 1` / `with(...)`，
   而 `node --check` 对 ESM 文件（.mjs，或 type:module 项目的 .js）会拒绝它们。
   于是「vm 成功就跳过 spawn」的快路径对 ESM 文件是**反向判据**：
   该 FAIL 的反而直接过，L1 报绿 —— 正是 F4 要消灭的伪造绿。
   `node --check` 一次只吃一个文件（多文件只查第一个就 exit 0），也没有别的
   进程内等价物。逐文件 spawn 每个约 50-80ms，几千文件约一两分钟 ——
   这是「最便宜的闸」能接受的量级，换一个不伪造绿的保证。 */
function runSyntaxGate(g, cwd) {
  const dirs = Array.isArray(g.dirs) ? g.dirs : [];
  if (dirs.length === 0) {
    return { code: 1, text: `[gate-test] kind:"syntax" 的门 "${g.name}" 没有声明 dirs，无从检查。` };
  }
  const exts = (Array.isArray(g.ext) && g.ext.length > 0 ? g.ext : DEFAULT_SYNTAX_EXT)
    .map((x) => String(x).toLowerCase());
  const excludes = Array.isArray(g.exclude) ? g.exclude : DEFAULT_SYNTAX_EXCLUDE;

  const { files, symlinks } = collectFiles(cwd, dirs, exts, excludes);
  if (files.length === 0) {
    // 空过防护：声明了要查却一个文件都没查到，多半是目录名写错了。
    return { code: -101, text: `[gate-test] 语法门 "${g.name}" 在 ${dirs.join(', ')} 下没找到任何 ${exts.join('/')} 文件 —— 判定为空过。目录名是不是写错了？` };
  }

  const bad = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { cwd, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    const code = r.error ? 1 : (r.status === null ? 1 : r.status);
    if (code !== 0) {
      const se = r.stderr ? r.stderr.toString('utf8') : '';
      bad.push(`${path.relative(cwd, f).split(path.sep).join('/')}\n${se.trim()}`);
    }
  }
  const note = symlinks > 0 ? `（另有 ${symlinks} 个符号链接未跟随）` : '';
  if (bad.length === 0) {
    return { code: 0, text: `[gate-test] 语法门 "${g.name}": ${files.length} 个文件全部通过 node --check${note}` };
  }
  return { code: 1, text: `[gate-test] 语法门 "${g.name}": ${bad.length}/${files.length} 个文件语法错误${note}\n\n` + bad.join('\n\n') };
}

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
  out(C.red(`[Test] 找不到 ${configPath}`));
  out(C.yellow('     先跑 init-rd.js，或从 templates/gates.json 复制一份。'));
  process.exit(2);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  out(C.red(`[Test] gates.json 不是合法 JSON: ${e.message}`));
  process.exit(2);
}
function asArr(v) { return Array.isArray(v) ? v : (v === null || v === undefined ? [] : [v]); }

const gates = Array.isArray(config.l1) ? config.l1 : [];
// 每条门要么有 cmd，要么是 kind:"syntax"。两者都没有的话它什么也不做却照常报 PASS。
for (const g of gates) {
  if (g.kind !== 'syntax' && (g.cmd === null || g.cmd === undefined || String(g.cmd).trim() === '')) {
    out(C.red(`[Test] gates.json 里的门 "${g.name || '(无名)'}" 既没有 cmd 也不是 kind:"syntax"`));
    process.exit(2);
  }
}
if (gates.length === 0) {
  out(C.red('[Test] gates.json 的 l1 为空，没有可执行的测试门。'));
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
    out(C.red(`[Test] 中止：上次运行被中断在半路。`));
    out(C.red('     先按上面的 inflight 收尾，把 run.json 的 inflight 清成 null，再跑测试层。'));
    out(C.dark('     在没收尾的状态下跑门，绿了也不知道绿的是哪一版。'));
    process.exit(2);
  }
  if (caCode === 3) {
    out(C.yellow('[Test] ⚠ 存在孤儿证据（evidence/ 下有文件没被任何报告引用）。'));
    out(C.dark('     跑 check-artifacts.js 看清单 —— 要么在报告里认领，要么删掉。'));
  }
}

out('');
out(C.cyan(`=== 测试层 (${gates.length} 项) ===`));

const results = [];
let failed = false;
const tailLines = 40;

for (const g of gates) {
  const required = g.required === undefined || g.required === null ? true : Boolean(g.required);

  const isSyntax = g.kind === 'syntax';

  out('');
  out(C.gray(`  -> ${g.name}: ${isSyntax ? `node --check（${asArr(g.dirs).join(', ')}）` : g.cmd}`));

  const t0 = Date.now();
  const { code: rawCode, text: text } = isSyntax ? runSyntaxGate(g, Root) : runShell(g.cmd, Root);
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
      tail = `[gate-test] 命令退出码为 0，但输出里找不到 "${g.mustMatch}" —— 判定为空过。\n` +
             '          很可能是没有文件可检查、或没有测试被收集到。\n\n' + tail;
    }
  }

  results.push({
    name: g.name,
    cmd: isSyntax ? `node --check [${asArr(g.dirs).join(', ')}]` : g.cmd,
    kind: isSyntax ? 'syntax' : 'cmd',
    required, exitCode: code, ok, seconds, tail: tail.replace(/\s+$/, ''),
  });

  /* ⛔ 空过（-100 / -101）无视 required。
     `required:false` 的语义是「这道检查没通过可以先放行」，
     不是「这道检查根本没检查到东西也可以放行」—— 后者是反自欺机制被自己关掉。
     实测：给一个目录名写错的语法门加上 required:false，就能拿到 L1 PASS。 */
  const isEmptyPass = code === -100 || code === -101;
  if (!ok && isEmptyPass && !required) {
    out(C.red(`     FAIL  exit=${code}  (${seconds}s) ← 空过防护无视 required:false`));
    failed = true;
    if (!args.ContinueOnFailure) {
      out(C.dark('     后续项跳过（early exit）。加 -ContinueOnFailure 可跑完全部。'));
      break;
    }
  } else if (ok) {
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
  out(C.green('=== 测试层 PASS ==='));
} else {
  out(C.red('=== 测试层 FAIL —— 不要派 reviewer，先把机械问题修掉 ==='));
  out('');
  for (const r of results.filter((x) => !x.ok && x.required)) {
    out(C.red(`--- ${r.name} (exit ${r.exitCode}) ---`));
    out(r.tail);
    out('');
  }
}
out('');

process.exit(verdict === 'pass' ? 0 : 1);
