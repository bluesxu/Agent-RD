'use strict';
/* F2：outOfFlowActions 的字段名不符 schema 时，必须降级成「格式问题」，
   不能渲染成 `? undefined → undefined [无裁决]` 再计进「自作主张」。

   原始故障：编排者按直觉写了 { when, what, actor, detail }，
   脚本把它报成流程违规，查了很久才发现只是字段名不对。
   F7：必填小节表要能被打印出来，让写报告的人和检查报告的人看同一张表。 */

const { test } = require('node:test');
const assert = require('node:assert');
const { mkTmp, write, runScript, rmrf } = require('./helpers.js');

function setup(outOfFlowActions) {
  const root = mkTmp('check-artifacts');
  write(root, '.rd/features/demo/run.json', JSON.stringify({
    feature: 'demo', stage: 'build', inflight: null,
    rounds: [], outOfFlowActions,
  }, null, 2));
  return root;
}

function run(root) {
  return runScript('check-artifacts.js', ['-Feature', 'demo', '-Root', root], root);
}

test('F2 字段名不符 schema → 报成格式问题并列出实际字段名', (t) => {
  const root = setup([{ when: 'r2', what: 'kill', actor: 'me', detail: 'x' }]);
  t.after(() => rmrf(root));

  const r = run(root);
  assert.match(r.out, /字段名对不上 schema/, '应识别为格式问题:\n' + r.out);
  assert.match(r.out, /when, what, actor, detail/, '应列出实际见到的字段名');
  assert.doesNotMatch(r.out, /undefined → undefined/, '不许渲染成 undefined');
});

test('F2 真正的违规（缺 userDecision）仍要报成自作主张', (t) => {
  const root = setup([{ action: 'kill-agent', target: 'l3-eval-r2', reason: 'x', ifNotDone: 'y' }]);
  t.after(() => rmrf(root));

  const r = run(root);
  assert.match(r.out, /自作主张/, '缺用户裁决应报违规:\n' + r.out);
  assert.doesNotMatch(r.out, /字段名对不上 schema/, '这条字段名是对的，不该报格式问题');
});

test('F2 字段齐全的合法条目不该触发任何告警', (t) => {
  const root = setup([{
    action: 'kill-agent', target: 'l3-eval-r2', reason: '前提作废',
    ifNotDone: '会跑满预算后判 blocked，结论相同但多花约 3 万 token',
    userDecision: 'approved', ts: '2026-08-09T00:00:00Z',
  }]);
  t.after(() => rmrf(root));

  const r = run(root);
  assert.doesNotMatch(r.out, /自作主张/, '合法条目不该报违规:\n' + r.out);
  assert.doesNotMatch(r.out, /字段名对不上 schema/, '合法条目不该报格式问题');
});

/* N5（L2 审查发现）：「字段名不符」和「action 取值未定义」必须分开计数与分开播报。
   混在一个计数器里会汇总成「N 条流程外动作**字段名**不符 schema」，
   而字段名其实完全正确 —— 又变回 F2 要消灭的那种误导。 */
test('F2 未定义的 action 取值要被单独指出，不混进「字段名不符」', (t) => {
  const root = setup([{
    action: 'reboot-universe', target: 'x', reason: 'r', ifNotDone: 'n', userDecision: 'approved',
  }]);
  t.after(() => rmrf(root));

  const r = run(root);
  assert.match(r.out, /action 取值未定义|action 取值/, '未知 action 应被指出:\n' + r.out);
  assert.match(r.out, /reboot-universe/, '应点名那个取值');
  assert.doesNotMatch(r.out, /条流程外动作字段名不符 schema/,
    '字段名是对的，不该计进「字段名不符」:\n' + r.out);
});

test('F7 -Sections 能打印必填小节表', () => {
  const r = runScript('check-artifacts.js', ['-Sections'], process.cwd());
  assert.strictEqual(r.code, 0);
  for (const s of ['审查结论', 'blocking', '验收结论', '逐条', '收尾附录', '选定方案']) {
    assert.ok(r.out.indexOf(s) >= 0, `必填小节表应含「${s}」:\n` + r.out);
  }
});

test('check-artifacts 的证伪自检本身要通过', () => {
  const r = runScript('check-artifacts.js', ['-SelfTest'], process.cwd());
  assert.strictEqual(r.code, 0, '自检失败说明收尾检测点没有判别力:\n' + r.out);
});

test('runbook 跑过 L3 却没留下运行手册 → 要被点名', (t) => {
  const root = mkTmp('check-runbook');
  t.after(() => rmrf(root));
  const L3 = ['## 验收结论', '通过 1 / 失败 0，共 1 条', '## 逐条', '### AC-1 ok', '## 收尾附录',
    '隔离审计: 无', '<!-- RD-DONE stage=eval artifact=l3-round1 at=2026-01-01T00:00:00Z -->', ''].join('\n');
  write(root, '.rd/features/demo/reports/l3-round1.md', L3);

  const r = runScript('check-artifacts.js', ['-Feature', 'demo', '-Root', root], root);
  assert.match(r.out, /acceptance-runbook\.md/, '应点名缺少运行手册:\n' + r.out);
});

test('runbook 存在时不再报缺失', (t) => {
  const root = mkTmp('check-runbook-ok');
  t.after(() => rmrf(root));
  const L3 = ['## 验收结论', '通过 1 / 失败 0，共 1 条', '## 逐条', '### AC-1 ok', '## 收尾附录',
    '隔离审计: 无', '<!-- RD-DONE stage=eval artifact=l3-round1 at=2026-01-01T00:00:00Z -->', ''].join('\n');
  write(root, '.rd/features/demo/reports/l3-round1.md', L3);
  write(root, '.rd/features/demo/acceptance-runbook.md', '# runbook\n驱动契约: curl\n');

  const r = runScript('check-artifacts.js', ['-Feature', 'demo', '-Root', root], root);
  assert.doesNotMatch(r.out, /acceptance-runbook\.md\s+←/, '手册已存在，不该再报缺失:\n' + r.out);
});
