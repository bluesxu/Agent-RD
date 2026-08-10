#!/usr/bin/env node
/*
  verify —— Agent-RD 脚本的最小行为验证（自带、零依赖、Node 22+）。

  在临时目录里造一个 fixture 项目，逐个脚本跑真实命令，断言退出码和关键行为。
  不动仓库本身，只碰 os.tmpdir() 下的一次性目录。

  用法：
    node scripts/verify.js

  退出码：0 = 全部通过；1 = 有用例失败。
*/
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const isTty = process.stdout.isTTY;
const C = {
  red: (s) => (isTty ? '[31m' + s + '[0m' : s),
  green: (s) => (isTty ? '[32m' + s + '[0m' : s),
  yellow: (s) => (isTty ? '[33m' + s + '[0m' : s),
  cyan: (s) => (isTty ? '[36m' + s + '[0m' : s),
  dark: (s) => (isTty ? '[90m' + s + '[0m' : s),
};

const HERE = __dirname;
const ROOT = path.dirname(HERE); // Agent-RD 根

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(C.green('  ✓ ' + name));
  } else {
    fail++;
    failures.push(name + (extra ? ' — ' + extra : ''));
    console.log(C.red('  ✗ ' + name + (extra ? '  (' + extra + ')' : '')));
  }
}

// 跑一个本仓库脚本，返回 {code, out}
function run(script, argv, cwd) {
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...argv], {
    cwd: cwd || ROOT,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout ? r.stdout.toString('utf8') : '') + (r.stderr ? '\n' + r.stderr.toString('utf8') : '');
  return { code: r.status === null ? -1 : r.status, out };
}

// 跑任意 shell 命令
function sh(cmd, cwd) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
  return { code: r.status === null ? 1 : r.status, out: (r.stdout || '').toString() + (r.stderr || '').toString() };
}

function write(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, 'utf8'); }

// ---- 造一个一次性 fixture 项目 ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rd-verify-'));
console.log(C.cyan('fixture: ' + tmp));
console.log('');

try {
  // ==== 1. init-rd ====
  console.log(C.cyan('【1】init-rd'));
  write(path.join(tmp, 'package.json'), JSON.stringify({ name: 'fix', version: '1.0.0' }, null, 2));
  write(path.join(tmp, 'index.js'), 'console.log("hi");\n');
  const init = run('init-rd.js', ['-Root', tmp], tmp);
  check('init-rd 退出码 0', init.code === 0, 'got ' + init.code);
  check('生成 .rd/gates.json', fs.existsSync(path.join(tmp, '.rd', 'gates.json')));
  check('生成 .rd/bin/check-ac.js', fs.existsSync(path.join(tmp, '.rd', 'bin', 'check-ac.js')));
  // 幂等：再跑一次不报错
  const init2 = run('init-rd.js', ['-Root', tmp], tmp);
  check('init-rd 幂等（二次运行不覆盖、退出码 0）', init2.code === 0, 'got ' + init2.code);

  // ==== 2. check-ac（用 vendored 副本，走真实路径）====
  console.log('');
  console.log(C.cyan('【2】check-ac（下发到 .rd/bin 的守卫）'));
  const guard = path.join(tmp, '.rd', 'bin', 'check-ac.js');
  const okAc = spawnSync(process.execPath, [guard, '-Cmd', 'echo AC-1 hit && echo 401', '-MustMatch', 'AC-1;;401'], { cwd: tmp, encoding: 'buffer' });
  check('锚点全中 → exit 0', okAc.status === 0, 'got ' + okAc.status);
  const vacuous = spawnSync(process.execPath, [guard, '-Cmd', 'echo nothing', '-MustMatch', 'AC-1;;AC-2'], { cwd: tmp, encoding: 'buffer' });
  check('空过（exit 0 但锚点 0 中）→ exit 1', vacuous.status === 1, 'got ' + vacuous.status);
  const cmdFail = spawnSync(process.execPath, [guard, '-Cmd', process.platform === 'win32' ? 'exit 5' : 'exit 5', '-MustMatch', 'x'], { cwd: tmp, encoding: 'buffer' });
  check('命令本身失败 → exit 1', cmdFail.status === 1, 'got ' + cmdFail.status);
  const noArgs = spawnSync(process.execPath, [guard], { cwd: tmp, encoding: 'buffer' });
  check('缺参数 → exit 2', noArgs.status === 2, 'got ' + noArgs.status);

  // ==== 3. check-artifacts 退出码 ====
  console.log('');
  console.log(C.cyan('【3】check-artifacts 退出码契约'));
  // 4：没有 .rd 的目录
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rd-nord-'));
  const ca4 = run('check-artifacts.js', ['-Root', emptyDir], emptyDir);
  check('无 .rd → exit 4', ca4.code === 4, 'got ' + ca4.code);
  // 有 .rd 但 feature 目录不存在
  const caNoFeat = run('check-artifacts.js', ['-Root', tmp, '-Feature', 'nonexistent'], tmp);
  check('feature 目录不存在 → exit 4', caNoFeat.code === 4, 'got ' + caNoFeat.code);
  // 造个 feature，什么都缺 → exit 1（产物缺失）
  write(path.join(tmp, '.rd', 'features', 'feat1', 'spec.md'), '# spec\n');
  const ca1 = run('check-artifacts.js', ['-Root', tmp, '-Feature', 'feat1'], tmp);
  check('产物缺失 → exit 1', ca1.code === 1, 'got ' + ca1.code);
  // inflight 非空 → exit 2
  write(path.join(tmp, '.rd', 'features', 'feat1', 'run.json'), JSON.stringify({
    stage: 'build', status: 'running',
    inflight: { stage: 'build', round: 1, startedAt: '2026-01-01', agents: [] },
    rounds: [],
  }, null, 2));
  const ca2 = run('check-artifacts.js', ['-Root', tmp, '-Feature', 'feat1'], tmp);
  check('inflight 非空 → exit 2', ca2.code === 2, 'got ' + ca2.code);
  // 清 inflight、补齐全套产物 → exit 0（无孤儿）
  // ⚠ 注意：check-artifacts 的 D-1 判据要求「尾标记 + 必填小节 + JSON _complete」，
  //   空壳文件（'x\n'）会被判成「只写了一半」。产物必须按现行规则写全。
  const RD_DONE = '<!-- RD-DONE at=2026-01-01T00:00:00Z -->';
  write(path.join(tmp, '.rd', 'features', 'feat1', 'run.json'), JSON.stringify({
    stage: 'keep', status: 'done', inflight: null,
    keep: { decided: [] }, rounds: [],
  }, null, 2));
  write(path.join(tmp, '.rd', 'features', 'feat1', 'dispatch.md'), '# 派发决策\n\n按 guarded 策略派发。\n\n' + RD_DONE + '\n');
  write(path.join(tmp, '.rd', 'features', 'feat1', 'spec.md'),
    '# 需求\n\n## 要解决什么\n把数据接进来。\n\n## 范围\n- 不做：无\n\n## 关键约束\n- 向后兼容\n\n## 已确认的决策\n- 用现成数据源\n\n' + RD_DONE + '\n');
  write(path.join(tmp, '.rd', 'features', 'feat1', 'acceptance.json'), JSON.stringify({ scenarios: [], _complete: true }));
  write(path.join(tmp, '.rd', 'features', 'feat1', 'design.md'),
    '# 方案\n\n## 选定方案\n方案 a\n\n## 技术选型\nNode\n\n## 影响面\n仅前端\n\n## 契约变化\n无\n\n## 被排除的方案\n方案 b\n\n' + RD_DONE + '\n');
  write(path.join(tmp, '.rd', 'features', 'feat1', 'tasks.json'), JSON.stringify({ tasks: [], _complete: true }));
  // 方案扇出：rd-plan 要求 ≥2 份完整方案，check-artifacts 的 plan 阶段与 validate-plan 都会点数
  write(path.join(tmp, '.rd', 'features', 'feat1', 'proposals', 'plan-a.md'),
    '# 方案 a\n\n## 方案\n加一个字段\n\n## 关键取舍\n轻量\n\n## 被排除的路\n重写\n\n## 风险\n无\n\n' + RD_DONE + '\n');
  write(path.join(tmp, '.rd', 'features', 'feat1', 'proposals', 'plan-b.md'),
    '# 方案 b\n\n## 方案\n新建服务\n\n## 关键取舍\n完整\n\n## 被排除的路\n加字段\n\n## 风险\n成本高\n\n' + RD_DONE + '\n');
  write(path.join(tmp, '.rd', 'features', 'feat1', 'reports', 'l1-round1.json'), JSON.stringify({ stage: 'l1', verdict: 'pass' }));
  write(path.join(tmp, '.rd', 'features', 'feat1', 'reports', 'l2-round1.md'),
    '# 审查\n\n## 审查结论\n通过\n\n## blocking\n无\n\n## important\n无\n\n## nit\n无\n\n' + RD_DONE + '\n');
  write(path.join(tmp, '.rd', 'features', 'feat1', 'reports', 'l2-round1.diff'), 'x\n');
  write(path.join(tmp, '.rd', 'features', 'feat1', 'reports', 'l3-round1.md'),
    '# 验收\n\n## 验收结论\n通过\n\n## 逐条\nAC 全过\n\n## 收尾附录\n已清理\n\n' + RD_DONE + '\n');
  // 跑过 L3 就必须留运行手册（check-artifacts 的 eval 阶段检查）
  write(path.join(tmp, '.rd', 'features', 'feat1', 'acceptance-runbook.md'), '# 运行手册\n\n怎么观察：浏览器打开页面。\n');
  write(path.join(tmp, '.rd', 'lessons', 'l1.md'), 'x\n');
  // run.json rounds 里要记 round 1，否则对账会报警 → 补 round 记录
  write(path.join(tmp, '.rd', 'features', 'feat1', 'run.json'), JSON.stringify({
    stage: 'keep', status: 'done', inflight: null, keep: { decided: [] },
    rounds: [{ round: 1, l1: 'pass', l2: 'pass', l3: 'pass' }],
  }, null, 2));
  const ca0 = run('check-artifacts.js', ['-Root', tmp, '-Feature', 'feat1'], tmp);
  check('产物齐全无孤儿 → exit 0', ca0.code === 0, 'got ' + ca0.code + '\n' + ca0.out);
  // 孤儿证据 → exit 3
  write(path.join(tmp, '.rd', 'features', 'feat1', 'reports', 'evidence', 'orphan.png'), 'x');
  // 清掉报告里对它的引用（不放任何 .md 引用 orphan.png）→ 应有孤儿
  const ca3 = run('check-artifacts.js', ['-Root', tmp, '-Feature', 'feat1'], tmp);
  check('孤儿证据 → exit 3', ca3.code === 3, 'got ' + ca3.code);
  fs.unlinkSync(path.join(tmp, '.rd', 'features', 'feat1', 'reports', 'evidence', 'orphan.png'));

  // ==== 4. gate-l1 ====
  console.log('');
  console.log(C.cyan('【4】gate-l1'));
  // 配一个必过的 gate
  write(path.join(tmp, '.rd', 'gates.json'), JSON.stringify({
    l1: [{ name: 'noop', cmd: process.platform === 'win32' ? 'echo ok' : 'echo ok', required: true }],
  }));
  const gpass = run('gate-l1.js', ['-Root', tmp], tmp);
  check('必过 gate → exit 0', gpass.code === 0, 'got ' + gpass.code + '\n' + gpass.out);
  // 必挂的 required gate
  write(path.join(tmp, '.rd', 'gates.json'), JSON.stringify({
    l1: [{ name: 'boom', cmd: process.platform === 'win32' ? 'exit 1' : 'exit 1', required: true }],
  }));
  const gfail = run('gate-l1.js', ['-Root', tmp], tmp);
  check('required 失败 → exit 1', gfail.code === 1, 'got ' + gfail.code);
  // 空过：命令成功但输出没有 mustMatch
  write(path.join(tmp, '.rd', 'gates.json'), JSON.stringify({
    l1: [{ name: 'vac', cmd: 'echo hello', required: true, mustMatch: 'REQUIRED_MARKER' }],
  }));
  const gvac = run('gate-l1.js', ['-Root', tmp], tmp);
  check('空过（exit 0 但无 mustMatch）→ exit 1', gvac.code === 1, 'got ' + gvac.code);
  // 配置缺失 → exit 2
  fs.unlinkSync(path.join(tmp, '.rd', 'gates.json'));
  const gno = run('gate-l1.js', ['-Root', tmp], tmp);
  check('gates.json 缺失 → exit 2', gno.code === 2, 'got ' + gno.code);

  // ==== 5. validate-plan ====
  console.log('');
  console.log(C.cyan('【5】validate-plan'));
  const feat = path.join(tmp, '.rd', 'features', 'feat1');
  // 先造一个「干净但 spec 阶段信息不全」的 spec，应 FAIL
  write(path.join(feat, 'spec.md'), '## 范围\n- 不做：无\n');
  write(path.join(feat, 'acceptance.json'), JSON.stringify({
    scenarios: [{ id: 'AC-1', name: 'x', given: 'g', when: 'w', then: 't', judge: 'machine' }],
  }));
  const vpSpecErr = run('validate-plan.js', ['-Root', tmp, '-Feature', 'feat1', '-Stage', 'spec'], tmp);
  check('machine AC 缺 checkIntent(spec) → exit 1', vpSpecErr.code === 1, 'got ' + vpSpecErr.code);
  // 补上 checkIntent → spec 应 PASS
  write(path.join(feat, 'acceptance.json'), JSON.stringify({
    scenarios: [{ id: 'AC-1', name: 'x', given: 'g', when: 'w', then: 't', judge: 'machine', checkIntent: '输入 I,期望输出 O,精确相等' }],
  }));
  const vpSpecOk = run('validate-plan.js', ['-Root', tmp, '-Feature', 'feat1', '-Stage', 'spec'], tmp);
  check('spec 阶段判据齐 → exit 0', vpSpecOk.code === 0, 'got ' + vpSpecOk.code + '\n' + vpSpecOk.out);
  // plan 阶段：机器判定 + 带过滤的 check 不走守卫 → 应 FAIL（且命中规则）
  write(path.join(feat, 'tasks.json'), JSON.stringify({
    tasks: [{ id: 'T1', layer: 1, files: ['index.js'], steps: ['do'], verify: 'echo ok', covers: ['AC-1'], mutationTargets: ['index.js'] }],
  }));
  write(path.join(feat, 'design.md'), 'x\n');
  write(path.join(tmp, '.rd', 'gates.json'), JSON.stringify({ l1: [{ name: 'noop', cmd: 'node --check index.js', required: true }] }));
  write(path.join(feat, 'acceptance.json'), JSON.stringify({
    scenarios: [{ id: 'AC-1', name: 'x', given: 'g', when: 'w', then: 't', judge: 'machine', checkIntent: 'I/O 判等', check: 'node --test --test-name-pattern=feat1\\sAC-1' }],
  }));
  const vpPlanGuard = run('validate-plan.js', ['-Root', tmp, '-Feature', 'feat1', '-Stage', 'plan'], tmp);
  check('过滤 check 未走守卫（plan) → exit 1', vpPlanGuard.code === 1, 'got ' + vpPlanGuard.code);
  check('  …报错点到 check-ac', /check-ac\.js/.test(vpPlanGuard.out));
  // 改成走守卫 → PASS。plan 阶段还有 F3 跨 task 聚合检查：machine 判定 AC
  // 必须被**某个 task 的 verify** 用 -MustMatch 锚住 —— acceptance.json 里 AC
  // 自带的 check -MustMatch 不算数（那是 L3 验收时才跑的，不是实现阶段守卫）。
  write(path.join(feat, 'acceptance.json'), JSON.stringify({
    scenarios: [{ id: 'AC-1', name: 'x', given: 'g', when: 'w', then: 't', judge: 'machine', checkIntent: 'I/O 判等', check: 'node .rd/bin/check-ac.js -Cmd "node --test --test-name-pattern=feat1\\sAC-1" -MustMatch "feat1 AC-1"' }],
  }));
  write(path.join(feat, 'tasks.json'), JSON.stringify({
    tasks: [{ id: 'T1', layer: 1, files: ['index.js'], steps: ['do'], verify: 'node .rd/bin/check-ac.js -Cmd "node --test --test-name-pattern=feat1\\sAC-1" -MustMatch "feat1 AC-1"', covers: ['AC-1'], mutationTargets: ['index.js'] }],
  }));
  const vpPlanOk = run('validate-plan.js', ['-Root', tmp, '-Feature', 'feat1', '-Stage', 'plan'], tmp);
  check('plan 阶段合规 → exit 0', vpPlanOk.code === 0, 'got ' + vpPlanOk.code + '\n' + vpPlanOk.out);

  // ==== 6. freeze-target（需要 git）====
  console.log('');
  console.log(C.cyan('【6】freeze-target'));
  const hasGit = sh('git --version', tmp).code === 0;
  if (!hasGit) {
    console.log(C.yellow('  ⚠ 无 git，跳过 freeze-target 用例'));
  } else {
    sh('git init -q', tmp);
    sh('git config user.email t@t.t', tmp);
    sh('git config user.name t', tmp);
    write(path.join(feat, 'tasks.json'), JSON.stringify({
      tasks: [{ id: 'T1', layer: 1, files: ['index.js'], steps: ['do'], verify: 'echo ok', covers: ['AC-1'], mutationTargets: ['index.js'] }],
    }));
    write(path.join(tmp, 'index.js'), 'console.log("v1");\n');
    sh('git add -A', tmp);
    sh('git commit -qm init', tmp);
    // 改动并冻结
    write(path.join(tmp, 'index.js'), 'console.log("v2");\n');
    sh('git add -A', tmp);
    const fz = run('freeze-target.js', ['-Root', tmp, '-Feature', 'feat1', '-Round', '1'], tmp);
    check('冻结 → exit 0', fz.code === 0, 'got ' + fz.code + '\n' + fz.out);
    check('生成 review-target.json', fs.existsSync(path.join(feat, 'review-target.json')));
    const fv = run('freeze-target.js', ['-Root', tmp, '-Feature', 'feat1', '-Round', '1', '-Verify'], tmp);
    check('未漂移 → exit 0', fv.code === 0, 'got ' + fv.code);
    // 改文件 → 漂移 → exit 1
    write(path.join(tmp, 'index.js'), 'console.log("v3 tampered");\n');
    sh('git add -A', tmp);
    const fdrift = run('freeze-target.js', ['-Root', tmp, '-Feature', 'feat1', '-Round', '1', '-Verify'], tmp);
    check('目标被改 → exit 1 (TargetMoved)', fdrift.code === 1, 'got ' + fdrift.code);
  }

  // ==== 7. install.js（dry-run 安全 + 真装到假 home）====
  console.log('');
  console.log(C.cyan('【7】install.js'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rd-home-'));
  const dry = spawnSync(process.execPath, [path.join(ROOT, 'install.js'), '-ClaudeHome', fakeHome], { cwd: ROOT, encoding: 'buffer' });
  check('dry-run → exit 0', dry.status === 0, 'got ' + dry.status);
  check('dry-run 不创建 skills/', !fs.existsSync(path.join(fakeHome, 'skills')));
  const apply = spawnSync(process.execPath, [path.join(ROOT, 'install.js'), '-Apply', '-ClaudeHome', fakeHome], { cwd: ROOT, encoding: 'buffer' });
  check('apply → exit 0', apply.status === 0, 'got ' + apply.status);
  // skill 数量与源目录一致（不写死个数，目录可能增减）
  const srcCount = fs.readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  const dstCount = fs.existsSync(path.join(fakeHome, 'skills')) ? fs.readdirSync(path.join(fakeHome, 'skills')).filter((d) => fs.statSync(path.join(fakeHome, 'skills', d)).isDirectory()).length : 0;
  check(`install 全部 ${srcCount} 个 skill`, srcCount > 0 && dstCount === srcCount, `src=${srcCount} dst=${dstCount}`);
  // install.js 不得碰任何配置文件 —— Agent Teams 开关归 enable-agent-teams.js（docs/install.md 步骤 2）
  check('install.js 不创建 settings.json', !fs.existsSync(path.join(fakeHome, 'settings.json')));

  // ==== 8. enable-agent-teams（写 settings.json 的那一条独立命令）====
  console.log('');
  console.log(C.cyan('【8】enable-agent-teams'));
  const eatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rd-eat-'));
  const settings = path.join(eatHome, 'settings.json');
  const eat = (argv) => spawnSync(process.execPath, [path.join(HERE, 'enable-agent-teams.js'), '-ClaudeHome', eatHome, ...argv], { cwd: ROOT, encoding: 'buffer' });
  const readSettings = () => JSON.parse(fs.readFileSync(settings, 'utf8'));
  const KEY = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';

  // dry-run 不落地
  const eatDry = eat(['-DryRun']);
  check('dry-run → exit 0', eatDry.status === 0, 'got ' + eatDry.status);
  check('dry-run 不创建 settings.json', !fs.existsSync(settings));
  // 无 settings.json → 新建
  const eatNew = eat([]);
  check('无 settings.json → exit 0 并新建', eatNew.status === 0 && fs.existsSync(settings), 'got ' + eatNew.status);
  check(`  …写入 env.${KEY}="1"`, readSettings().env[KEY] === '1');
  // 幂等：二次运行不产生备份（说明它根本没写）
  const eatAgain = eat([]);
  check('幂等 → exit 0', eatAgain.status === 0, 'got ' + eatAgain.status);
  check('  …已配置时不重复备份', fs.readdirSync(eatHome).filter((f) => f.startsWith('settings.json.bak-')).length === 0);
  // 合并进已有配置：其他顶层键和已有 env 字段都要活下来
  fs.writeFileSync(settings, JSON.stringify({ model: 'opus', env: { FOO: 'bar' }, permissions: { allow: ['Bash(ls)'] } }, null, 2), 'utf8');
  const eatMerge = eat([]);
  check('合并进已有配置 → exit 0', eatMerge.status === 0, 'got ' + eatMerge.status);
  const merged = readSettings();
  check('  …保留其他顶层键', merged.model === 'opus' && merged.permissions.allow[0] === 'Bash(ls)');
  check('  …保留已有 env 字段', merged.env.FOO === 'bar' && merged.env[KEY] === '1');
  check('  …写前备份了原文件', fs.readdirSync(eatHome).some((f) => f.startsWith('settings.json.bak-')));
  // 坏 JSON → exit 1，且绝不覆盖用户原文件（install 流程靠这个保证「跳过是安全的」）
  const junk = '{ "env": { /* 注释 */ } }';
  fs.writeFileSync(settings, junk, 'utf8');
  const eatBad = eat([]);
  check('settings.json 解析失败 → exit 1', eatBad.status === 1, 'got ' + eatBad.status);
  check('  …失败时不覆盖原文件', fs.readFileSync(settings, 'utf8') === junk);
  try { fs.rmSync(eatHome, { recursive: true, force: true }); } catch { /* ignore */ }
} finally {
  // 清理
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('');
console.log(C.cyan(`结果: ${pass} 通过 / ${fail} 失败`));
if (fail > 0) {
  console.log(C.red('失败用例：'));
  for (const f of failures) console.log(C.red('  - ' + f));
  process.exit(1);
}
console.log(C.green('全部通过 ✓'));
process.exit(0);
