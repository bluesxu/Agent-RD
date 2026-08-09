'use strict';
/* F1：freeze-target 必须把未跟踪文件纳入审查目标。

   原始故障：src/web/、public/ 和全部新测试都是未跟踪文件，`git diff` 对它们不可见，
   于是两轮 freeze 产出的 l2-round1.diff 与 l2-round2.diff **逐字节相同**，
   且都不含本次改动的主体。L1 绿、L2 读了那份 diff 也说不出哪里不对 ——
   审查证据链整个是空的，而没有任何东西报警。 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { initRepo, write, runScript, rmrf } = require('./helpers.js');

function setupFeature(root, files) {
  write(root, '.rd/features/demo/tasks.json', JSON.stringify({
    tasks: [{ id: 'T1', files }],
  }));
}

function readTarget(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.rd/features/demo/review-target.json'), 'utf8'));
}

function readDiff(root, round) {
  return fs.readFileSync(path.join(root, `.rd/features/demo/reports/l2-round${round}.diff`), 'utf8');
}

test('F1 未跟踪的新文件必须带着内容进入 diff', (t) => {
  const root = initRepo('freeze-untracked');
  t.after(() => rmrf(root));

  write(root, 'src/web/service.js', "console.log('service layer');\n");
  write(root, 'public/app.js', "console.log('frontend');\n");
  setupFeature(root, ['src/web/service.js', 'public/app.js']);

  const r = runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root], root);
  assert.strictEqual(r.code, 0, '冻结应成功:\n' + r.out);

  const diff = readDiff(root, 1);
  assert.match(diff, /\+\+\+ b\/src\/web\/service\.js/, '新文件应出现在 diff 里');
  assert.match(diff, /\+\+\+ b\/public\/app\.js/, '新文件应出现在 diff 里');
  // 只有文件名不算 —— intent-to-add 会把它渲染成空壳，那比不纳入更有欺骗性
  assert.match(diff, /^\+console\.log\('service layer'\);$/m, '新文件的内容行必须在 diff 里');
  assert.match(diff, /^\+console\.log\('frontend'\);$/m, '新文件的内容行必须在 diff 里');

  const target = readTarget(root);
  assert.strictEqual(target.untrackedIncluded.length, 2, 'review-target 应记录纳入了 2 个未跟踪文件');
});

test('F1 两轮之间改了未跟踪文件，两轮 diff 不能逐字节相同', (t) => {
  const root = initRepo('freeze-rounds');
  t.after(() => rmrf(root));

  write(root, 'src/web/service.js', "console.log('v1');\n");
  setupFeature(root, ['src/web/service.js']);

  assert.strictEqual(runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root], root).code, 0);
  write(root, 'src/web/service.js', "console.log('v2 fixed');\n");
  assert.strictEqual(runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '2', '-Root', root], root).code, 0);

  const d1 = readDiff(root, 1);
  const d2 = readDiff(root, 2);
  assert.notStrictEqual(d1, d2, '两轮 diff 逐字节相同 —— 原始故障复现');
  assert.match(d2, /v2 fixed/, '第 2 轮必须捕获到新内容');
});

test('F1 -Verify 能发现未跟踪文件在审查期间被改动', (t) => {
  const root = initRepo('freeze-verify');
  t.after(() => rmrf(root));

  write(root, 'src/web/service.js', "console.log('frozen');\n");
  setupFeature(root, ['src/web/service.js']);
  assert.strictEqual(runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root], root).code, 0);

  const clean = runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root, '-Verify'], root);
  assert.strictEqual(clean.code, 0, '没动过工作树时应判未漂移');

  write(root, 'src/web/service.js', "console.log('tampered');\n");
  const moved = runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root, '-Verify'], root);
  assert.strictEqual(moved.code, 1, '未跟踪文件被改动后应报 TargetMoved');
  assert.match(moved.out, /TargetMoved/);
});

test('F1 .gitignore 忽略的文件不许被拉进审查目标', (t) => {
  const root = initRepo('freeze-ignored');
  t.after(() => rmrf(root));

  write(root, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
  write(root, 'src/a.js', "console.log('a');\n");
  // 声明为空 → 走全仓兜底，这正是最容易把依赖目录冻进来的路径
  write(root, '.rd/features/demo/tasks.json', JSON.stringify({ tasks: [] }));

  assert.strictEqual(runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root], root).code, 0);
  const diff = readDiff(root, 1);
  assert.doesNotMatch(diff, /node_modules/, '被 gitignore 的文件不该进 diff');
  assert.match(diff, /src\/a\.js/, '正常新文件仍应进 diff');
});

test('F1 .rd/ 下的框架自身产物不算越界改动', (t) => {
  const root = initRepo('freeze-rd-noise');
  t.after(() => rmrf(root));

  write(root, 'src/a.js', "console.log('a');\n");
  setupFeature(root, ['src/a.js']);

  // 第 1 轮会在 .rd/features/demo/reports/ 下留一个 .diff，它本身是未跟踪的
  assert.strictEqual(runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root], root).code, 0);
  assert.strictEqual(runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '2', '-Root', root], root).code, 0);

  const target = readTarget(root);
  const rdNoise = target.outOfScope.filter((p) => p.indexOf('.rd/') === 0);
  assert.deepStrictEqual(rdNoise, [], '.rd/ 下的产物不该被报成越界改动：' + JSON.stringify(target.outOfScope));
});

/* 下面这组是 L2 审查补上的缺口（I7）：原来的夹具**从不留 staged 改动**，
   于是 freeze 的 staged 分支零覆盖 —— 把 F1 的修复整个回退，测试依然全绿。
   而真实流程里 index 有已暂存内容非常常见，正是在那个条件下第 2 轮会丢掉新文件。 */

test('F1 index 里有已暂存改动时，新文件仍必须带内容进 diff', (t) => {
  const root = initRepo('freeze-staged');
  t.after(() => rmrf(root));

  write(root, 'tracked.txt', 'modified\n');
  write(root, 'new.js', "console.log('NEW FILE CONTENT');\n");
  setupFeature(root, ['tracked.txt', 'new.js']);
  require('./helpers.js').git(root, ['add', 'tracked.txt']); // ← 关键前置

  assert.strictEqual(runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root], root).code, 0);
  assert.match(readDiff(root, 1), /NEW FILE CONTENT/, '第 1 轮就该含新文件内容');
});

test('F1 第 2 轮（add -N 已生效后）不许再把新文件丢掉', (t) => {
  const root = initRepo('freeze-round2-regression');
  t.after(() => rmrf(root));

  write(root, 'tracked.txt', 'modified\n');
  write(root, 'new.js', "console.log('NEW FILE CONTENT');\n");
  setupFeature(root, ['tracked.txt', 'new.js']);
  require('./helpers.js').git(root, ['add', 'tracked.txt']);

  assert.strictEqual(runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root], root).code, 0);
  assert.match(readDiff(root, 1), /NEW FILE CONTENT/);

  // git add -N 是一次性的：第 2 轮 ls-files --others 已经不再列出 new.js。
  // 若 mode 回落到 --staged，diff --cached 不显示 intent-to-add 条目，新文件就整个消失。
  assert.strictEqual(runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '2', '-Root', root], root).code, 0);
  assert.match(readDiff(root, 2), /NEW FILE CONTENT/, '第 2 轮丢了新文件 —— F1 的缺陷复发');
});

test('F1 -Verify 不许改动 index（只读契约）', (t) => {
  const root = initRepo('freeze-verify-readonly');
  t.after(() => rmrf(root));
  const { git } = require('./helpers.js');

  write(root, 'new.js', "console.log('x');\n");
  setupFeature(root, ['new.js']);
  // 故意不先冻结：直接 -Verify 应该既不写 index，也不该把 new.js 登记进去
  const before = git(root, ['status', '--porcelain']).stdout;
  runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root, '-Verify'], root);
  const after = git(root, ['status', '--porcelain']).stdout;
  assert.strictEqual(after, before, '-Verify 改动了 index：\n前: ' + before + '后: ' + after);
});

test('F1 -Verify 要能发现冻结之后新增的范围内文件', (t) => {
  const root = initRepo('freeze-verify-newfile');
  t.after(() => rmrf(root));

  write(root, 'a.js', "console.log('a');\n");
  setupFeature(root, ['a.js', 'b.js']);
  assert.strictEqual(runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root], root).code, 0);

  write(root, 'b.js', "console.log('b');\n"); // 审查期间新增
  const r = runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root, '-Verify'], root);
  assert.strictEqual(r.code, 1, '新增范围内文件应判 TargetMoved:\n' + r.out);
  assert.match(r.out, /TargetMoved/);
});

test('F1 范围外的未跟踪新文件仍然要被报成越界', (t) => {
  const root = initRepo('freeze-outofscope');
  t.after(() => rmrf(root));

  write(root, 'src/a.js', "console.log('a');\n");
  write(root, 'stray.js', "console.log('stray');\n");
  setupFeature(root, ['src/a.js']);

  assert.strictEqual(runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root], root).code, 0);
  const target = readTarget(root);
  assert.ok(target.outOfScope.indexOf('stray.js') >= 0,
    '范围外的未跟踪文件应进越界清单，实际: ' + JSON.stringify(target.outOfScope));
  assert.doesNotMatch(readDiff(root, 1), /stray/, '越界文件不该进审查目标本身');
});

/* I5（L2 审查发现）：项目根不是仓库根时（monorepo，或项目嵌在更大的仓库里），
   `ls-files` 的输出相对 cwd 而 `diff --name-only` 相对仓库根，两者被直接拼在一起比较 ——
   同一个文件会同时出现在「已纳入」和「越界」两个清单里，越界清单从此全是噪音。 */
test('I5 项目根嵌在更大的仓库里时，路径基准必须一致', (t) => {
  const { mkTmp, git } = require('./helpers.js');
  const outer = mkTmp('freeze-nested');
  t.after(() => rmrf(outer));

  git(outer, ['init', '-q', '.']);
  git(outer, ['config', 'user.email', 't@t.t']);
  git(outer, ['config', 'user.name', 't']);
  git(outer, ['config', 'core.autocrlf', 'false']);
  write(outer, 'root.txt', 'root\n');
  git(outer, ['add', 'root.txt']);
  git(outer, ['commit', '-qm', 'init']);

  const app = path.join(outer, 'app');
  write(outer, 'app/src/a.js', "console.log('a');\n");
  write(outer, 'app/.rd/features/demo/tasks.json', JSON.stringify({ tasks: [{ id: 'T1', files: ['src/a.js'] }] }));

  const r = runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', app], app);
  assert.strictEqual(r.code, 0, '嵌套仓库下冻结应成功:\n' + r.out);

  const target = JSON.parse(fs.readFileSync(path.join(app, '.rd/features/demo/review-target.json'), 'utf8'));
  const dupes = target.files.filter((f) => target.outOfScope.indexOf(f) >= 0);
  assert.deepStrictEqual(dupes, [], '同一个文件既是审查目标又是越界项：' + JSON.stringify(target));
  assert.ok(target.files.length > 0, '应该冻到 app/src/a.js，实际: ' + JSON.stringify(target.files));
});

/* 以下三条来自 L2 复审（NEW-2 / NEW-3 / NEW-4）。 */

test('NEW-2 -Verify 要发现审查期间新增的范围外文件（越界改动）', (t) => {
  const root = initRepo('freeze-outofscope-verify');
  t.after(() => rmrf(root));

  write(root, 'tracked.txt', 'v1\n');
  setupFeature(root, ['tracked.txt']);
  assert.strictEqual(runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root], root).code, 0);

  write(root, 'stray.js', "console.log('stray');\n"); // 审查期间新增范围外文件
  const r = runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root, '-Verify'], root);
  assert.strictEqual(r.code, 1, '新增范围外文件应判 TargetMoved:\n' + r.out);
  assert.match(r.out, /TargetMoved/);
});

test('NEW-2 冻结时已存在的范围外文件，审查期间深化它不算新越界（对照组）', (t) => {
  const root = initRepo('freeze-outofscope-steady');
  t.after(() => rmrf(root));

  write(root, 'tracked.txt', 'v1\n');
  write(root, 'stray.txt', 'v1\n'); // 冻结时就存在的范围外已跟踪文件
  setupFeature(root, ['tracked.txt']);
  assert.strictEqual(runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root], root).code, 0);

  write(root, 'stray.txt', 'v2\n'); // 深化它
  const r = runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root, '-Verify'], root);
  assert.strictEqual(r.code, 0, '既有越界项的深化不该误报 TargetMoved:\n' + r.out);
});

test('NEW-3 带 skip-worktree 标记的范围内文件改动要报出来', (t) => {
  const root = initRepo('freeze-skipworktree');
  t.after(() => rmrf(root));
  const { git } = require('./helpers.js');

  write(root, 'tracked.txt', 'orig\n');
  write(root, 'locked.txt', 'orig\n');
  git(root, ['add', 'tracked.txt', 'locked.txt']);
  git(root, ['commit', '-qm', 'init']);
  git(root, ['update-index', '--skip-worktree', 'locked.txt']);

  write(root, 'tracked.txt', 'v1\n');
  write(root, 'locked.txt', 'tampered\n'); // 标了 skip-worktree，git diff 看不见它
  setupFeature(root, ['tracked.txt', 'locked.txt']);

  const r = runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root], root);
  assert.strictEqual(r.code, 0, '冻结本身应成功:\n' + r.out);
  assert.match(r.out, /skip-worktree/, '应点名带标记的文件:\n' + r.out);
  assert.match(r.out, /locked\.txt/);
  // 正常缓存标记是 H，不许被误报成 masked（第 3 轮复审抓到的 regex /i 缺陷）
  assert.doesNotMatch(r.out, /tracked\.txt/, '正常文件不该出现在 masked 里:\n' + r.out);
});

test('NEW-4 中文文件名（非 ASCII 路径）要能正常冻结', (t) => {
  const root = initRepo('freeze-cjk');
  t.after(() => rmrf(root));

  write(root, 'src/中文-文件.js', "console.log('中文');\n");
  setupFeature(root, ['src/中文-文件.js']);

  const r = runScript('freeze-target.js', ['-Feature', 'demo', '-Round', '1', '-Root', root], root);
  assert.strictEqual(r.code, 0, '中文文件名应能冻结:\n' + r.out);
  assert.match(readDiff(root, 1), /中文-文件\.js/, 'diff 里应有中文文件名');
});
