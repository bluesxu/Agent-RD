#!/usr/bin/env node
/*
  check-ac —— 跑一条被过滤的验收命令，并确认它「真的验到了东西」——而且验的是**每一个**该验的点。

  解决两个问题：

  ## 问题一：退出码 0 不代表通过（空过 / vacuous pass）

  几乎所有测试运行器在「过滤条件匹配不到任何用例」时都会**成功退出**：
    node --test --test-name-pattern "ZZZ-NONEXISTENT"   -> exit 0
    jest -t "does-not-exist"                            -> exit 0（默认）
  于是 acceptance.json 里那条「只跑这条 AC 对应用例」的 check，
  在**这条 AC 的测试根本没写**的情况下照样是绿的 —— 门被骗过，AC 从未被验证。
  所以要求两件事同时成立：命令退出码为 0，**且**输出里出现了指定的锚点。

  ## 问题二：then 是多子句的，一个布尔值盖不住

  一条 AC 的 then 常常写着好几个并列要求，而 check 只能给出「是/否」。
  所以 -MustMatch 接受**多个**锚点，一条子句一个，**全部命中才算通过**。

  用法（跨平台，等价于原 check-ac.ps1）：
    node check-ac.js -Cmd "node --test --test-name-pattern=feat\\sAC-1" -MustMatch "feat AC-1"
    node check-ac.js -Cmd "..." -MustMatch "数值精确匹配;;SMA 种子;;长度不足返回 null"

  -MustMatch 多个锚点用 `;;` 分隔（两个分号连写在测试名里几乎不会自然出现）。
  也支持重复给多个 -MustMatch 旗标。锚点是纯字面量，不当正则。

  退出码：0 = 通过；1 = 命令失败或锚点缺失。
*/
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

// ---- 终端着色：只有真 TTY 才输出 ANSI，被 agent/CI 捕获时保持纯文本 ----
const isTty = process.stdout.isTTY;
const C = {
  gray: (s) => (isTty ? '[90m' + s + '[0m' : s),
  red: (s) => (isTty ? '[31m' + s + '[0m' : s),
  green: (s) => (isTty ? '[32m' + s + '[0m' : s),
  yellow: (s) => (isTty ? '[33m' + s + '[0m' : s),
};

function out(s) { process.stdout.write(s + '\n'); }

// 统计某个锚点出现次数（纯字面量，不当正则；不重叠计数）
function countHits(haystack, needle) {
  let n = 0;
  let i = 0;
  for (;;) {
    i = haystack.indexOf(needle, i);
    if (i < 0) break;
    n++;
    i += needle.length;
  }
  return n;
}

// ---- 参数解析：兼容 -Key value 与 --Key=value；同名旗标可重复 ----
function parseArgs(argv) {
  const args = { MustMatch: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = a.match(/^--?([A-Za-z]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (val === undefined) {
      // 值在下一个 token
      if (i + 1 < argv.length && !/^--?/.test(argv[i + 1])) {
        val = argv[++i];
      } else {
        val = '';
      }
    }
    const lk = key.toLowerCase();
    if (lk === 'mustmatch') args.MustMatch.push(val);
    else if (lk === 'cmd') args.Cmd = val;
    else if (lk === 'minmatches') args.MinMatches = parseInt(val, 10);
    else if (lk === 'root') args.Root = val;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const Cmd = args.Cmd;
const MinMatches = Number.isInteger(args.MinMatches) && args.MinMatches > 0 ? args.MinMatches : 1;
const Root = args.Root || process.cwd();

if (!Cmd || args.MustMatch.length === 0) {
  out('');
  out(C.red('  用法: node check-ac.js -Cmd "<命令>" -MustMatch "<锚点1;;锚点2…>" [-MinMatches N] [-Root <dir>]'));
  out('');
  process.exit(2);
}

// 跑命令：shell=true 让 Node 选 cmd.exe（Windows）或 sh（Unix），一处兼容两侧。
// 显式捕获 stdout/stderr 并合并 —— 不靠 shell 的 2>&1，跨平台一致。
let code;
let text;
try {
  const r = spawnSync(Cmd, {
    cwd: Root,
    shell: true,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  const so = r.stdout ? r.stdout.toString('utf8') : '';
  const se = r.stderr ? r.stderr.toString('utf8') : '';
  text = so + (se ? '\n' + se : '');
  if (r.error) {
    // shell 本身起不来
    code = -1;
    text = String(r.error);
  } else {
    code = r.status === null ? 1 : r.status;
  }
} catch (e) {
  code = 1;
  text = String(e && e.message ? e.message : e);
}

// 展开锚点：支持 `;;` 分隔，也支持重复旗标
const anchors = [];
for (const m of args.MustMatch) {
  if (m === null || m === undefined) continue;
  for (const piece of String(m).split(';;')) {
    const p = piece.trim();
    if (p !== '') anchors.push(p);
  }
}

const results = anchors.map((a) => ({ anchor: a, hits: countHits(text, a) }));
const missing = results.filter((r) => r.hits < MinMatches);

out('');
out(C.gray('  cmd       : ' + Cmd));
out(C.gray('  exit      : ' + code));
for (const r of results) {
  const ok = r.hits >= MinMatches;
  const mark = ok ? ' ' : '✗';
  const line = `  matched ${mark} : ${r.hits} 次  "${r.anchor}"  (要求 >= ${MinMatches})`;
  out(ok ? C.gray(line) : C.red(line));
}

if (code !== 0) {
  out('');
  out(C.red('=== FAIL —— 命令本身失败 ==='));
  out(text.trim());
  process.exit(1);
}

if (missing.length > 0) {
  out('');
  if (missing.length === anchors.length) {
    out(C.red('=== FAIL —— 命令成功了，但一个锚点都没匹配到 ==='));
    out(C.yellow('    退出码 0 在这里不代表通过：过滤条件匹配不到任何用例时，'));
    out(C.yellow('    测试运行器也会成功退出。这条 AC 实际上从未被验证。'));
    out(C.yellow('    要么这条 AC 的测试还没写，要么用例名和过滤条件对不上。'));
  } else {
    out(C.red('=== FAIL —— 部分子句没有被锁住 ==='));
    out(C.yellow('    命令退出码是 0，其他锚点也命中了，但下面这几个没有：'));
    for (const m of missing) out(C.yellow('      · ' + m.anchor));
    out(C.yellow('    这意味着 then 里对应的那几句要求**没有测试在管**。'));
    out(C.yellow('    部分满足不是通过 —— 补上对应的用例，或说明那一句为什么不该由测试锁。'));
  }
  out('');
  out(text.trim());
  process.exit(1);
}

out('');
out(C.green(`=== PASS —— ${anchors.length} 个锚点全部命中 ===`));
out('');
process.exit(0);
