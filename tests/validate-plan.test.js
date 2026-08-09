'use strict';
/* F3：covers 里的每条 machine AC，必须被某个 task 的 verify -MustMatch 锚住。

   原始故障：T6 的 covers 含 AC-1+AC-8，verify 只锚 AC-1；T10 的 covers 含
   AC-2/3/4，verify 只锚 AC-2。`check-ac -MustMatch` 只卡它自己列出的锚点，
   所以 AC-8 / AC-3 / AC-4 的测试**悄悄消失也不会红**，而 validate-plan 照常放行。 */

const { test } = require('node:test');
const assert = require('node:assert');
const { mkTmp, write, runScript, rmrf } = require('./helpers.js');

const SPEC = [
  '# spec', '## 要解决什么', 'x', '## 范围', 'x', '## 关键约束', 'x', '## 已确认的决策', 'x',
  '<!-- RD-DONE stage=spec artifact=spec at=2026-01-01T00:00:00Z -->', '',
].join('\n');

function ac(id) {
  return {
    id, name: 'n-' + id, judge: 'machine', given: 'g', when: 'w', then: 't', evidence: 'log',
    checkIntent: '输入 x 期望 y，逐字段判等',
    check: `node .rd/bin/check-ac.js -Cmd "npm test" -MustMatch "${id}: ok"`,
  };
}

function setup(tasks, acIds) {
  const root = mkTmp('validate-plan');
  write(root, '.rd/gates.json', JSON.stringify({
    l1: [{ name: 'syntax', cmd: 'node --check src/a.js', coversAllSrc: true }],
  }));
  write(root, '.rd/features/demo/spec.md', SPEC);
  write(root, '.rd/features/demo/design.md', 'x\n');
  write(root, '.rd/features/demo/acceptance.json',
    JSON.stringify({ _complete: true, scenarios: acIds.map(ac) }, null, 2));
  write(root, '.rd/features/demo/tasks.json',
    JSON.stringify({ _complete: true, tasks }, null, 2));
  return root;
}

function task(id, covers, mustMatch) {
  return {
    id, layer: 1, files: [`src/${id}.js`], steps: ['do it'], covers,
    mutationTargets: [`src/${id}.js`],
    verify: `node .rd/bin/check-ac.js -Cmd "npm test" -MustMatch "${mustMatch}"`,
  };
}

function run(root) {
  return runScript('validate-plan.js', ['-Feature', 'demo', '-Stage', 'plan', '-Root', root], root);
}

test('F3 covers 声明了 AC 但没有任何 verify 锚住它 → 必须报错', (t) => {
  const root = setup([task('T6', ['AC-1', 'AC-8'], 'AC-1: ok')], ['AC-1', 'AC-8']);
  t.after(() => rmrf(root));

  const r = run(root);
  assert.notStrictEqual(r.code, 0, '应判不通过');
  assert.match(r.out, /AC-8 是 machine 判定、被 T6 的 covers 声明/,
    '应点名 AC-8 没有锚点，实际输出:\n' + r.out);
});

test('F3 锚点落在另一个 task 上时应放行（跨 task 聚合，不要求本 task 自锚）', (t) => {
  const root = setup([
    task('T6', ['AC-1', 'AC-8'], 'AC-1: ok'),
    task('T7', ['AC-2'], 'AC-8: ok;;AC-2: ok'),
  ], ['AC-1', 'AC-2', 'AC-8']);
  t.after(() => rmrf(root));

  const r = run(root);
  assert.doesNotMatch(r.out, /AC-8 是 machine 判定/,
    'AC-8 已被 T7 锚住，不该报错:\n' + r.out);
});

test('F3 AC-1 不许被 AC-10 的锚点冒充（整词匹配）', (t) => {
  const root = setup([
    task('T6', ['AC-1'], 'AC-10: ok'),
    task('T7', ['AC-10'], 'AC-10: ok'),
  ], ['AC-1', 'AC-10']);
  t.after(() => rmrf(root));

  const r = run(root);
  assert.match(r.out, /AC-1 是 machine 判定/,
    'AC-1 被 AC-10 冒充过关了:\n' + r.out);
});

test('F3 agent 判定的 AC 不要求 -MustMatch 锚点', (t) => {
  const root = mkTmp('validate-plan-agent');
  t.after(() => rmrf(root));
  write(root, '.rd/gates.json', JSON.stringify({
    l1: [{ name: 'syntax', cmd: 'node --check src/a.js', coversAllSrc: true }],
  }));
  write(root, '.rd/features/demo/spec.md', SPEC);
  write(root, '.rd/features/demo/design.md', 'x\n');
  write(root, '.rd/features/demo/acceptance.json', JSON.stringify({
    _complete: true,
    scenarios: [
      ac('AC-1'),
      { id: 'AC-2', name: 'ui', judge: 'agent', given: 'g', when: 'w', then: 't', evidence: 'screenshot' },
    ],
  }, null, 2));
  write(root, '.rd/features/demo/tasks.json', JSON.stringify({
    _complete: true, tasks: [task('T1', ['AC-1', 'AC-2'], 'AC-1: ok')],
  }, null, 2));

  const r = run(root);
  assert.doesNotMatch(r.out, /AC-2 是 machine 判定/,
    'agent 判定的 AC 不该被要求机器锚点:\n' + r.out);
});

/* 以下三条来自 L2 审查（N2 / N3 / N4）：extractMustMatch 的提取规则。 */
test('N2 -MustMatch 里的转义引号不许截断锚点', (t) => {
  const root = setup([{
    id: 'T1', layer: 1, files: ['src/T1.js'], steps: ['s'], covers: ['AC-8'],
    mutationTargets: ['src/T1.js'],
    verify: 'node .rd/bin/check-ac.js -Cmd "npm test" -MustMatch "say \\"AC-8\\" done"',
  }], ['AC-8']);
  t.after(() => rmrf(root));

  const r = run(root);
  assert.doesNotMatch(r.out, /AC-8 是 machine 判定/,
    '转义引号内的 AC-8 被截断丢失了:\n' + r.out);
});

test('N3 AC-1 不许被 AC-1a 这类字母后缀冒充', (t) => {
  const root = setup([
    { id: 'T1', layer: 1, files: ['src/T1.js'], steps: ['s'], covers: ['AC-1'], mutationTargets: ['src/T1.js'],
      verify: 'node .rd/bin/check-ac.js -Cmd "npm test" -MustMatch "AC-1a: ok"' },
  ], ['AC-1']);
  t.after(() => rmrf(root));

  const r = run(root);
  assert.match(r.out, /AC-1 是 machine 判定/, 'AC-1a 冒充了 AC-1:\n' + r.out);
});

test('N4 --no-MustMatch 这类选项不许被当成锚点', (t) => {
  const root = setup([
    { id: 'T1', layer: 1, files: ['src/T1.js'], steps: ['s'], covers: ['AC-9'], mutationTargets: ['src/T1.js'],
      verify: 'runner --no-MustMatch AC-9 -MustMatch "AC-1: ok"' },
  ], ['AC-9']);
  t.after(() => rmrf(root));

  const r = run(root);
  assert.match(r.out, /AC-9 是 machine 判定/,
    '一个显式关掉锚点的选项反而让 AC-9 过了校验:\n' + r.out);
});
