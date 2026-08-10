'use strict';
/* 真实仓库级 skill 结构测试（T10 收口）。

   这些测试对**真实仓库**的 skills/ 跑 -SkillLint，断言 exit 0。
   它们是唯一能拦住「以后有人改坏 skill 结构」的测试 ——
   在仓外手改一个 SKILL.md、把 references/ 搬丢、漏登记策略加载清单，
   npm test 和 43 条既有测试都不会红，只有这个文件会。

   ⚠️ 因此：任何对 skills/ 或 docs/authoring.md 的结构性改动，
   都要保证这里仍然全绿。改坏了在这里看原因，不要删掉这条测试。
*/

const { test } = require('node:test');
const assert = require('node:assert');
const { REPO_ROOT, runScript } = require('./helpers');

test('SkillLint 真实仓库全绿（无孤儿 / 无断链 / 钩子合格 / 加载清单齐全 / 冻结表对账）', () => {
  const r = runScript('check-artifacts.js', ['-SkillLint'], REPO_ROOT);
  assert.strictEqual(r.code, 0, 'SkillLint 应全绿:\n' + r.out);
  assert.ok(r.out.indexOf('=== SkillLint PASS') >= 0, '应以 PASS 收尾:\n' + r.out);
  assert.doesNotMatch(r.out, /SkillLint FAIL/, '不应出现 FAIL:\n' + r.out);
});

test('每个策略文件都有「本策略的加载清单」且两个子清单都非空（AC-6）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const strategiesDir = path.join(REPO_ROOT, 'skills', 'rd', 'strategies');
  const names = ['direct', 'guarded', 'full', 'refactor-safe', 'diagnose', 'research-only', 'review-only'];
  for (const name of names) {
    const txt = fs.readFileSync(path.join(strategiesDir, name + '.md'), 'utf8');
    assert.ok(/^##\s*本策略的加载清单/m.test(txt), `${name}.md 缺「本策略的加载清单」小节（AC-6）`);
    // 子清单必须出现在该小节之后，且两者都非空
    const loadSection = txt.split(/^##\s*本策略的加载清单/m)[1] || '';
    assert.ok(/\*\*会用到\*\*/.test(loadSection), `${name}.md 加载清单缺「会用到」`);
    assert.ok(/\*\*永不加载\*\*/.test(loadSection), `${name}.md 加载清单缺「永不加载」`);
    assert.ok(/会用到[\s\S]*\*\*会用到\*\*\s*\n+\s*[-•]/.test(loadSection) || /\*\*会用到\*\*\s*\n+\s*[-•]/.test(loadSection), `${name}.md 「会用到」子清单为空`);
    assert.ok(/\*\*永不加载\*\*\s*\n+\s*[-•]/.test(loadSection), `${name}.md 「永不加载」子清单为空`);
  }
});

test('-Sections 打印 O-2 条件名与 O-5 回执字段（给写报告的人看）', () => {
  const r = runScript('check-artifacts.js', ['-Sections'], REPO_ROOT);
  assert.strictEqual(r.code, 0);
  for (const s of ['contract-break', 'guard-evasion', 'unhandled-failure-path', 'stale-doc', 'filesChanged', 'verifyOutput', 'mutationsSurvived']) {
    assert.ok(r.out.indexOf(s) >= 0, `-Sections 应打印 ${s}:\n` + r.out);
  }
});

test('O-2/O-5 冻结表与脚本常量逐字一致（A18 双路复算）', () => {
  // -SkillLint 全量模式会跑 checkContractAlignment：脚本常量 vs docs/authoring.md 围栏块
  const r = runScript('check-artifacts.js', ['-SkillLint'], REPO_ROOT);
  assert.strictEqual(r.code, 0, '冻结表对账应通过:\n' + r.out);
});

test('AC-7 守恒检查真的能抓到搬丢的硬约束（-Baseline，I1 修复的回归测试）', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { mkTmp, write, rmrf } = require('./helpers');

  // 造一个 fixture 基线：demo 主文件有一条硬约束
  const base = mkTmp('lint-base');
  write(base, 'skills/demo/SKILL.md', '# demo\n\n⛔ 不许在没采基线的情况下开工\n');
  // 当前版本：这条约束被搬走 / 改写 → 守恒必须判红
  const cur = mkTmp('lint-cur');
  write(cur, 'skills/demo/SKILL.md', '# demo\n\n主文件没有那条约束了。\n');

  const bad = runScript('check-artifacts.js', ['-SkillLint', '-Skill', 'demo', '-Baseline', base], cur);
  assert.strictEqual(bad.code, 1, '约束被搬走时 -Baseline 必须 exit 1（守恒要能判失败）:\n' + bad.out);
  assert.ok(bad.out.indexOf('AC-7 守恒') >= 0, '应点名 AC-7 守恒:\n' + bad.out);

  // 当前版本：约束仍在 → 守恒必须判绿
  write(cur, 'skills/demo/SKILL.md', '# demo\n\n⛔ 不许在没采基线的情况下开工\n');
  const good = runScript('check-artifacts.js', ['-SkillLint', '-Skill', 'demo', '-Baseline', base], cur);
  assert.strictEqual(good.code, 0, '约束保留时 -Baseline 应 exit 0:\n' + good.out);

  rmrf(base); rmrf(cur);
});
