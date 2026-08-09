'use strict';
/* F4：kind:"syntax" 语法门 —— 给不在编译器覆盖范围里的目录一条零成本下限。
   NEW-1：init-rd 的 gate 冒烟必须能识别 Windows 的无符号负退出码。 */

const { test } = require('node:test');
const assert = require('node:assert');
const { mkTmp, write, runScript, rmrf } = require('./helpers.js');

function gates(root, l1) {
  write(root, '.rd/gates.json', JSON.stringify({ l1 }, null, 2));
}

test('F4 语法门抓得到语法错误的文件', (t) => {
  const root = mkTmp('gate-syntax-bad');
  t.after(() => rmrf(root));
  write(root, 'public/good.js', "console.log('ok');\n");
  write(root, 'public/bad.js', 'function broken( { return 1 }\n');
  gates(root, [{ name: 'frontend-syntax', kind: 'syntax', dirs: ['public'] }]);

  const r = runScript('gate-l1.js', ['-Root', root], root);
  assert.strictEqual(r.code, 1, '应 FAIL');
  assert.match(r.out, /public\/bad\.js/, '应点名出错的文件');
});

test('F4 全部合法时通过', (t) => {
  const root = mkTmp('gate-syntax-ok');
  t.after(() => rmrf(root));
  write(root, 'public/a.js', "console.log('a');\n");
  write(root, 'public/b.js', 'export const x = 1;\n');
  gates(root, [{ name: 'frontend-syntax', kind: 'syntax', dirs: ['public'], ext: ['.js', '.mjs'] }]);

  const r = runScript('gate-l1.js', ['-Root', root], root);
  assert.strictEqual(r.code, 0, '应 PASS:\n' + r.out);
});

test('F4 目录名写错时判空过，不许报绿', (t) => {
  const root = mkTmp('gate-syntax-typo');
  t.after(() => rmrf(root));
  write(root, 'public/a.js', "console.log('a');\n");
  gates(root, [{ name: 'typo', kind: 'syntax', dirs: ['pubilc'] }]);

  const r = runScript('gate-l1.js', ['-Root', root], root);
  assert.strictEqual(r.code, 1, '一个文件都没查到却报 PASS = 空过');
  assert.match(r.out, /空过/);
});

test('F4 语法门不去碰 node_modules 等排除目录', (t) => {
  const root = mkTmp('gate-syntax-exclude');
  t.after(() => rmrf(root));
  write(root, 'src/a.js', "console.log('a');\n");
  write(root, 'src/node_modules/pkg/broken.js', 'function ( { \n');
  gates(root, [{ name: 'syntax', kind: 'syntax', dirs: ['src'] }]);

  const r = runScript('gate-l1.js', ['-Root', root], root);
  assert.strictEqual(r.code, 0, 'node_modules 里的语法错不该让门失败:\n' + r.out);
});

test('F4 既没有 cmd 也不是 syntax 的门必须被拒绝，不能静悄悄算通过', (t) => {
  const root = mkTmp('gate-empty');
  t.after(() => rmrf(root));
  gates(root, [{ name: 'empty-gate' }]);

  const r = runScript('gate-l1.js', ['-Root', root], root);
  assert.strictEqual(r.code, 2, '配置非法应退出 2');
  assert.match(r.out, /既没有 cmd 也不是/);
});

/* NEW-1：init-rd 的 gate 冒烟不许把「非 0 退出」说成「✓ 可执行」。

   退出码在 Windows 上有两种坏形态：
     · 无符号 32 位大数（4294963238 其实是 -4058）—— npm ENOENT 就是这个
     · cmd.exe 对「命令不存在」返回 1，且错误文案是系统代码页编码的
   第二种在文本层面根本判不准，所以只保证一件事：**非 0 一律要被标出来**。 */
test('NEW-1 init-rd 冒烟：不存在的命令不许被报成「可执行」', (t) => {
  const root = mkTmp('init-smoke-ghost');
  t.after(() => rmrf(root));
  gates(root, [{ name: 'ghost', cmd: 'this-command-does-not-exist-xyz --flag' }]);

  const r = runScript('init-rd.js', ['-Root', root], root);
  assert.match(r.out, /⚠ ghost:/, '应被标为需要处理，实际:\n' + r.out);
  assert.doesNotMatch(r.out, /✓ ghost/, '不该报成可执行');
});

test('NEW-1 init-rd 冒烟：无符号负退出码要被归一并判为跑不起来', (t) => {
  const root = mkTmp('init-smoke-unsigned');
  t.after(() => rmrf(root));
  // 直接造一个退出码为 -4058 的进程（Windows 上会被报成 4294963238）
  gates(root, [{ name: 'neg', cmd: `"${process.execPath}" -e "process.exit(-4058)"` }]);

  const r = runScript('init-rd.js', ['-Root', root], root);
  assert.match(r.out, /neg: 命令跑不起来/, '归一后应判为跑不起来，实际:\n' + r.out);
});

test('NEW-1 init-rd 冒烟：真正可用的命令仍报通过', (t) => {
  const root = mkTmp('init-smoke-ok');
  t.after(() => rmrf(root));
  gates(root, [{ name: 'fine', cmd: `"${process.execPath}" -e "process.exit(0)"` }]);

  const r = runScript('init-rd.js', ['-Root', root], root);
  assert.match(r.out, /✓ fine: 可执行且当前通过/, '实际:\n' + r.out);
});

/* B4（L2 审查发现）：validate-plan 原先不认识 kind:"syntax" ——
   只配语法门时会误报「l1 为空」，混配时语法门覆盖的源文件也不算数。
   两种都是让一份正确的配置过不了门。 */
test('B4 validate-plan 认识 kind:"syntax"，不再误报 l1 为空', (t) => {
  const root = mkTmp('validate-syntax-gate');
  t.after(() => rmrf(root));
  const SPEC = ['# spec', '## 要解决什么', 'x', '## 范围', 'x', '## 关键约束', 'x',
    '## 已确认的决策', 'x', '<!-- RD-DONE stage=spec artifact=spec at=2026-01-01T00:00:00Z -->', ''].join('\n');
  write(root, '.rd/gates.json', JSON.stringify({
    l1: [{ name: 'syntax', kind: 'syntax', dirs: ['src'] }],
  }));
  write(root, '.rd/features/demo/spec.md', SPEC);
  write(root, '.rd/features/demo/design.md', 'x\n');
  write(root, '.rd/features/demo/acceptance.json', JSON.stringify({
    _complete: true,
    scenarios: [{
      id: 'AC-1', name: 'a', judge: 'machine', given: 'g', when: 'w', then: 't', evidence: 'log',
      checkIntent: '输入 x 期望 y', check: 'node .rd/bin/check-ac.js -Cmd "npm test" -MustMatch "AC-1: ok"',
    }],
  }));
  write(root, '.rd/features/demo/tasks.json', JSON.stringify({
    _complete: true,
    tasks: [{
      id: 'T1', layer: 1, files: ['src/a.js'], steps: ['s'], covers: ['AC-1'],
      mutationTargets: ['src/a.js'],
      verify: 'node .rd/bin/check-ac.js -Cmd "npm test" -MustMatch "AC-1: ok"',
    }],
  }));

  const r = runScript('validate-plan.js', ['-Feature', 'demo', '-Stage', 'plan', '-Root', root], root);
  assert.doesNotMatch(r.out, /l1 为空/, '不该误报 l1 为空:\n' + r.out);
  assert.doesNotMatch(r.out, /只逐字覆盖了/, '语法门的 dirs 应算作对 src/ 下源文件的覆盖:\n' + r.out);
});

/* I2（L2 审查发现）：排除清单按 basename 在每一层匹配，`src/build/` 这种
   真源码目录被整体跳过，而空过防护只在「一个文件都没有」时触发 ——
   少查一半文件照样报 PASS。默认排除因此收窄到 node_modules / .git。 */
test('I2 名叫 build/ 的真源码目录不许被静默跳过', (t) => {
  const root = mkTmp('gate-syntax-builddir');
  t.after(() => rmrf(root));
  write(root, 'src/sub/ok.js', "console.log('ok');\n");
  write(root, 'src/build/broken.js', 'function broken( { \n');
  gates(root, [{ name: 'syn', kind: 'syntax', dirs: ['src'] }]);

  const r = runScript('gate-l1.js', ['-Root', root], root);
  assert.strictEqual(r.code, 1, 'src/build/ 里的语法错误被漏检了:\n' + r.out);
  assert.match(r.out, /build\/broken\.js/);
});

test('I2 node_modules 仍然在任意深度被排除', (t) => {
  const root = mkTmp('gate-syntax-nm-deep');
  t.after(() => rmrf(root));
  write(root, 'src/a.js', "console.log('a');\n");
  write(root, 'src/deep/node_modules/pkg/broken.js', 'function ( { \n');
  gates(root, [{ name: 'syn', kind: 'syntax', dirs: ['src'] }]);

  const r = runScript('gate-l1.js', ['-Root', root], root);
  assert.strictEqual(r.code, 0, 'node_modules 应在任意深度被排除:\n' + r.out);
});

/* N8（L2 审查发现）：空过防护不许被 required:false 关掉。
   required:false 的语义是「没通过可以放行」，不是「没检查到东西也可以放行」。 */
test('N8 required:false 关不掉空过防护', (t) => {
  const root = mkTmp('gate-syntax-emptypass-notrequired');
  t.after(() => rmrf(root));
  write(root, 'src/a.js', "console.log('a');\n");
  gates(root, [{ name: 'typo', kind: 'syntax', dirs: ['nope'], required: false }]);

  const r = runScript('gate-l1.js', ['-Root', root], root);
  assert.strictEqual(r.code, 1, 'required:false 不该让空过拿到 PASS:\n' + r.out);
});

/* NEW-1（L2 复审发现）：ESM 保留字（var await = 1 等）在 vm.Script 里能过、
   node --check 对 .mjs 会拒绝 —— 曾让语法门对 ESM 文件静默假绿。 */
test('NEW-1 ESM 文件的保留字错误必须 FAIL（防 vm 快路径假绿回归）', (t) => {
  const root = mkTmp('gate-esm-reserved');
  t.after(() => rmrf(root));
  write(root, 'public/t.mjs', 'var await = 1;\n');
  write(root, 'public/ok.js', "console.log('fine');\n");
  gates(root, [{ name: 'syn', kind: 'syntax', dirs: ['public'] }]);

  const r = runScript('gate-l1.js', ['-Root', root], root);
  assert.strictEqual(r.code, 1, 'ESM 保留字错误被放行（假绿）:\n' + r.out);
  assert.match(r.out, /t\.mjs/);
});
