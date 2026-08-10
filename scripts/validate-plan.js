#!/usr/bin/env node
/*
  validate-plan —— 校验 acceptance.json / tasks.json 的机械规则。

  这道门是无人化的前提。它拦下的是后面自动流程无论如何都发现不了的那类错误：
    - 验收标准判定不了  -> 验收层永远无法判断"做完了没有"
    - 同层文件重叠      -> 并行 Builder 互相覆盖，diff 里看不出来
    - AC 没被任何 task 覆盖 -> 悄悄漏掉一整块需求

  用法：
    node validate-plan.js -Feature user-login -Stage spec
    node validate-plan.js -Feature user-login -Stage plan

  退出码：0 = PASS；1 = FAIL；2 = 上次被中断在半路（前置 check-artifacts 硬拦）。
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
  const args = { Stage: 'plan' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = a.match(/^--?([A-Za-z]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = m[2];
    if (val === undefined && i + 1 < argv.length && !/^--?/.test(argv[i + 1])) val = argv[++i];
    if (key === 'feature') args.Feature = val;
    else if (key === 'stage') args.Stage = val;
    else if (key === 'root') args.Root = val;
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));
const Feature = args.Feature || '';
const Stage = args.Stage === 'spec' ? 'spec' : 'plan';
const Root = args.Root || process.cwd();

if (!Feature) {
  out(C.red('缺少 -Feature'));
  process.exit(2);
}

const errors = [];
const warnings = [];
const addErr = (m) => errors.push(m);
const addWarn = (m) => warnings.push(m);

function asList(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : [v];
}
function isBlank(s) { return s === null || s === undefined || String(s).trim() === ''; }

const dir = path.join(Root, '.rd', 'features', Feature);
const acPath = path.join(dir, 'acceptance.json');
const taskPath = path.join(dir, 'tasks.json');
const specPath = path.join(dir, 'spec.md');

// ---------- 前置：上次是不是被中断在半路 ----------
// 寄生到「流程上绕不过去」的路上：validate-plan 不过就不许派 agent。
// 只硬拦 inflight（退出码 2），产物缺失（1）在流程中段是正常的，一律阻塞会天天误报。
const checkArt = path.join(__dirname, 'check-artifacts.js');
if (fs.existsSync(checkArt)) {
  let caCode = 0;
  let caOut = '';
  try {
    const r = spawnSync(process.execPath, [checkArt, '-Root', Root, '-Feature', Feature], { cwd: Root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    caCode = r.status === null ? 0 : r.status;
    caOut = r.stdout ? r.stdout.toString('utf8') : '';
  } catch (e) {
    caCode = 0; caOut = '';
  }
  if (caCode === 2) {
    out(caOut);
    out(C.red('=== validate-plan 中止：上次运行被中断在半路 ==='));
    out(C.red('  先按上面的 inflight 收尾，把 run.json 的 inflight 清成 null，再回来规划。'));
    out(C.dark('  在没收尾的状态下继续规划，会基于一份不知道真假的进度做决策。'));
    process.exit(2);
  }
  if (caCode === 3) {
    addWarn('存在孤儿证据（evidence/ 下有文件没被任何报告引用）。跑 check-artifacts.js 看清单 —— 要么在报告里认领，要么删掉。无主证据会被后人误当成有效依据。');
  }

  // ---------- 方案扇出点数（只在 -Stage plan）----------
  /*
    rd-plan 要求 2~3 个 agent 独立出方案。实跑里派了 3 个，A 中断后内容归零、
    B/C 正常返回，仲裁拿 2 份照常做完 —— 而且当时不知道自己少了一份。
    「仲裁前先点数」写在 SKILL.md 里是一句自觉要求，没有守卫；
    寄生到 validate-plan 上它才真的拦得住：这里不过，就不许进 rd-build。
  */
  if (Stage === 'plan') {
    try {
      const rj = spawnSync(process.execPath, [checkArt, '-Root', Root, '-Feature', Feature, '-Json'], { cwd: Root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const info = JSON.parse(rj.stdout);
      const done = info.proposalsComplete || 0;
      const total = asList(info.proposals).length;
      const lost = asList(info.proposalsLost);
      if (total === 0) {
        addErr('proposals/ 下一份方案都没有。方案必须落盘到 .rd/features/' + Feature + '/proposals/plan-{a,b,c}.md —— 只存在于返回消息里的方案，中断即归零，事后连「本该有几份」都无从查证。');
      } else if (done < 2) {
        addErr(`proposals/ 只有 ${done} 份完整方案（共 ${total} 份文件）。rd-plan 要求 2~3 份独立方案：不足 2 份时「被排除的方案」写不出来，仲裁等于走过场。先补派，不要跳过。`);
      }
      for (const x of lost) {
        addErr('方案丢失：' + x + '。先重派一次；重派仍失败才允许降级，且必须在 design.md 的「未决风险」里写明少了哪一份。降级本身可以接受，降级得悄无声息不行。');
      }
      for (const p of asList(info.proposals)) {
        if (p.state !== 'ok') {
          addErr(`proposals/${p.name} 只写了一半：${asList(p.why).join('；')}`);
        }
      }

      /*
        提示词差异化：三份提示词完全一样时，换三个模型也只是换三种措辞。
        提示词本身没法事后检查，但派发时登记的「切入角度」可以 ——
        缺角度、或角度雷同，都说明这次扇出没有真的差异化。
        ⚠️ 这里只抓得住【字面重复】。角度写得不同但实质是一回事，机器分辨不了，
        那一层只能靠 design.md 的「被排除的方案」是否真有分量来反推。
      */
      const runP = path.join(dir, 'run.json');
      if (fs.existsSync(runP)) {
        let fanout = null;
        try { fanout = JSON.parse(fs.readFileSync(runP, 'utf8')).planFanout; } catch (e) { fanout = null; }
        const dispatched = asList(fanout && fanout.dispatched);
        if (dispatched.length > 0) {
          const norm = (s) => String(s === null || s === undefined ? '' : s)
            .toLowerCase().replace(/[\s，。、；;,.!！?？"'"'`]/g, '');
          const seen = new Map();
          for (const d of dispatched) {
            const who = d.name || d.reportPath || '?';
            const key = norm(d.angle);
            if (key === '') {
              addErr(`planFanout 里 ${who} 没写 angle（切入角度）。三份提示词不许完全一样 —— 角度是差异所在，不登记就无从检查这次扇出到底有没有差异化。`);
              continue;
            }
            if (seen.has(key)) {
              addErr(`planFanout 里 ${who} 的 angle 与 ${seen.get(key)} 字面重复（「${d.angle}」）。同一个角度派两遍，拿回来的是同一份方案的两种措辞。`);
            } else {
              seen.set(key, who);
            }
          }
        }
      }
    } catch (e) {
      addWarn('方案扇出点数没跑成（' + e.message + '）—— 请手动跑 check-artifacts.js -Json 核对 proposalsComplete。');
    }
  }
}

// ---------- spec.md ----------
if (!fs.existsSync(specPath)) {
  addErr('缺少 spec.md');
} else {
  const spec = fs.readFileSync(specPath, 'utf8');
  if (!/^##\s*范围/m.test(spec)) {
    addErr('spec.md 缺少「## 范围」一节');
  } else if (!/^##\s*范围.*?[-*+]\s*[*_`]*\s*不做\s*[*_`]*\s*[:：]\s*\S/ms.test(spec)) {
    // 容忍 markdown 强调与不同列表符号：「- 不做：」「- **不做**：」「* `不做`:」都算数。
    addErr('spec.md 的「范围」里「不做」为空。没有边界的需求，agent 一定会越界。');
  }

  // spec.md 里不该留「未决风险」「怎么确认算对了」这类给方案者看的提示清单（验收层验收者会读全文）。
  const internalPath = path.join(dir, 'spec-internal.md');
  const leaky = [];
  if (/^##\s*未决风险/m.test(spec)) leaky.push('未决风险');
  if (/^#{2,3}.*怎么确认算对/m.test(spec)) leaky.push('怎么确认算对了');
  if (leaky.length > 0 && !fs.existsSync(internalPath)) {
    addWarn(`spec.md 里还留着「${leaky.join('」「')}」。这几节是给出方案的人看的，不是给验收者看的 —— 验收层验收者会读 spec.md 全文，读到它们等于拿到一份提示清单，之后它的「场外观察」就不再是自己撞见的了。把它们移到同目录的 spec-internal.md（验收层禁读、方案 agent 必读）。`);
  }
}

// ---------- acceptance.json ----------
let ac = null;
if (!fs.existsSync(acPath)) {
  addErr('缺少 acceptance.json');
} else {
  try {
    ac = JSON.parse(fs.readFileSync(acPath, 'utf8'));
  } catch (e) {
    addErr('acceptance.json 不是合法 JSON: ' + e.message);
  }
}

const acIds = [];
const machineChecks = {};
if (ac !== null) {
  const scenarios = asList(ac.scenarios);
  if (scenarios.length === 0) {
    addErr('acceptance.json 没有任何 scenario');
  }

  const seen = {};
  for (const s of scenarios) {
    const id = s.id;
    if (isBlank(id)) { addErr('有 scenario 缺少 id'); continue; }
    if (seen[id]) { addErr(`${id} 重复`); } else { seen[id] = true; }
    acIds.push(id);

    for (const f of ['name', 'given', 'when', 'then']) {
      if (isBlank(s[f])) addErr(`${id} 缺少 ${f}`);
    }

    const judge = s.judge;
    if (judge !== 'machine' && judge !== 'agent') {
      addErr(`${id} 的 judge 必须是 machine 或 agent（当前: '${judge}'）`);
      continue;
    }

    if (judge === 'machine') {

      // 【A9】业务梳理只讨论业务 —— 阶段 0 要判据，阶段 1 才要命令。
      const techTokens = [
        'node ', 'node.', 'npm ', 'npx ', 'yarn ', 'pnpm ', 'deno ', 'bun ',
        'pytest', 'python ', 'pip ', 'poetry', 'tox ',
        'cargo ', 'go test', 'go build', 'dotnet ', 'mvn ', 'gradle ',
        'jest', 'mocha', 'vitest', 'rspec', 'phpunit', 'junit',
        'tsc ', '--test-name-pattern', 'powershell', 'bash ',
      ];
      const intent = String(s.checkIntent === undefined || s.checkIntent === null ? '' : s.checkIntent);

      if (isBlank(intent)) {
        if (Stage === 'spec') {
          addErr(`${id} judge=machine 但没有 checkIntent。阶段 0 要的是【判据】不是【命令】：说清输入是什么、期望输出是什么、用什么判等（精确相等 / 相对误差 / 区间）。说不清就不是验收标准，是愿望 —— 回去继续拷问。`);
        } else {
          addWarn(`${id} 没有 checkIntent。阶段 0 应当先写下判据（输入 / 期望输出 / 判等方式），阶段 1 再具化成命令。缺了它，无法判断当前这条 check 是不是忠实地实现了原本的判据。`);
        }
      } else {
        let badTok = null;
        const low = intent.toLowerCase();
        for (const tk of techTokens) {
          if (low.indexOf(tk.toLowerCase()) >= 0) { badTok = tk.trim(); break; }
        }
        if (badTok !== null) {
          addErr(`${id} 的 checkIntent 里出现了技术栈名词「${badTok}」。**业务梳理只讨论业务** —— 技术选型是阶段 1 的事，阶段 1 还要派 2~3 个 agent 独立出方案再仲裁。在阶段 0 写下工具名，等于开会之前就把结论写在纸上。把它改写成与语言无关的判据：输入是什么、期望输出是什么、用什么判等。`);
        }
      }

      // 阶段 0 不要求 check —— 具体命令是阶段 1 技术选定之后的产物。
      if (isBlank(s.check)) {
        if (Stage !== 'spec') {
          addErr(`${id} judge=machine 但没有 check 命令。阶段 1 必须把 checkIntent 具化成选定技术栈的可执行命令，否则 测试层/验收层无从判定。`);
        }
      } else {
        // 带过滤条件的 check 必须走 check-ac 守卫（过滤匹配不到用例时运行器也返回 0）。
        const filterFlags = ['--test-name-pattern', '-t ', '--grep', '-k ', '--filter', '-run '];
        let usesFilter = false;
        const checkLow = String(s.check).toLowerCase();
        for (const ff of filterFlags) {
          if (checkLow.indexOf(ff.toLowerCase()) >= 0) usesFilter = true;
        }
        if (usesFilter && !/check-ac\.js/.test(s.check)) {
          addErr(`${id} 的 check 带了用例过滤条件，但没走 check-ac.js 守卫。过滤匹配不到任何用例时运行器也返回 0 —— 这条 AC 的测试没写时 check 照样绿。改成: node .rd/bin/check-ac.js -Cmd "<原命令>" -MustMatch "<本 AC 的测试名>"`);
        }

        // check 里禁止嵌套转义引号 \" —— 不可移植。
        if (String(s.check).indexOf('\\"') >= 0) {
          addErr(`${id} 的 check 含嵌套转义引号 \\" —— 不可移植，sh 下过、cmd 下会因引号错配得到假 FAIL。改用 --flag=value 形式，空格用正则 \\s 代替，例如: -Cmd "node --test .rd/features/<feature>/tests/*.test.ts --test-name-pattern=<feature>\\s${id}" -MustMatch "<feature> ${id}"`);
        }

        const key = String(s.check).trim();
        if (machineChecks[key]) {
          addErr(`${id} 的 check 与 ${machineChecks[key]} 完全相同（"${key}"）。同一条命令无法区分是哪条 AC 失败 —— 收窄到只跑这条 AC 对应的用例。`);
        } else {
          machineChecks[key] = id;
        }
      }
    } else {
      // judge=agent：必须声明观察通道
      if (isBlank(s.observe)) {
        addErr(`${id} judge=agent 但没有 observe。必须写清楚用产品对外暴露的哪个接口去观察（HTTP 端点 / 页面 / CLI 命令 / 落盘文件）。写不出来说明这条黑盒不可验证，应改成 machine 或重新设计。`);
      }
      // 必须声明「在什么条件下比对才算数」
      if (isBlank(s.preconditions)) {
        addErr(`${id} judge=agent 但没有 preconditions。必须写清楚「在什么条件下比对才算数」—— 那些不满足就会让整条判定失效、但 given/when/then 里没地方写的前提（对照的是哪个数据源/环境/版本、服务跑在哪、外部工具的哪个具体配置）。缺了它，验收者会产出一份形式无懈可击、结论完全错误的报告。`);
      }

      const ev = asList(s.evidence);
      if (ev.length === 0) {
        addErr(`${id} judge=agent 但 evidence 为空。拿不出证据的通过不算通过。`);
      } else {
        const allowed = ['screenshot', 'recording', 'http-trace', 'log', 'file-content'];
        for (const e of ev) {
          if (allowed.indexOf(e) < 0) addErr(`${id} 的 evidence '${e}' 不在允许值内: ${allowed.join(', ')}`);
        }
      }
      // 防 overfit: agent 场景的 then 不该出现实现细节
      if (/[A-Za-z_][A-Za-z0-9_]*\.(ts|tsx|js|jsx|py|go|rs|java|cs)\b/.test(String(s.then))) {
        addErr(`${id} judge=agent，但 then 里出现了文件名。用用户能观察到的现象来写，否则 rd-eval 会 overfit 到实现上。`);
      }
      if (/\b(function|返回值|调用|handler|Handler)\b/.test(String(s.then))) {
        addWarn(`${id} 的 then 疑似含实现细节，检查一下是不是能改写成用户可观察的描述`);
      }
    }
  }
}

// ---------- tasks.json ----------
if (Stage === 'plan') {
  let tk = null;
  if (!fs.existsSync(taskPath)) {
    addErr('缺少 tasks.json');
  } else {
    try {
      tk = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    } catch (e) {
      addErr('tasks.json 不是合法 JSON: ' + e.message);
    }
  }

  if (!fs.existsSync(path.join(dir, 'design.md'))) addErr('缺少 design.md');

  if (tk !== null) {
    const tasks = asList(tk.tasks);
    if (tasks.length === 0) addErr('tasks.json 没有任何 task');

    const byId = {};
    const covered = {};

    for (const t of tasks) {
      const id = t.id;
      if (isBlank(id)) { addErr('有 task 缺少 id'); continue; }
      if (byId[id]) addErr(`task ${id} 重复`);
      byId[id] = t;

      if (t.layer === null || t.layer === undefined || parseInt(t.layer, 10) < 1) addErr(`${id} 的 layer 必须是 >=1 的整数`);
      if (asList(t.files).length === 0) addErr(`${id} 的 files 为空`);
      if (asList(t.steps).length === 0) addErr(`${id} 的 steps 为空`);
      if (isBlank(t.selfCheck)) addErr(`${id} 缺少 selfCheck 命令`);
      if (asList(t.covers).length === 0) addErr(`${id} 的 covers 为空，说明它不对任何验收标准负责`);

      for (const c of asList(t.covers)) {
        covered[c] = true;
        if (acIds.indexOf(c) < 0) addErr(`${id} 的 covers 引用了不存在的 ${c}`);
      }

      // 【A13-①】任务书里出现「实测得到的期望值」—— Builder 就不是算出来的，是抄回来的。
      const obsMarkers = ['实测', '期望值', '跑出来', '实际得到', '实际测得', 'measured', 'observed value'];
      for (const step of asList(t.steps)) {
        const s = String(step);
        let hit = null;
        const sLow = s.toLowerCase();
        for (const mk of obsMarkers) {
          if (sLow.indexOf(mk.toLowerCase()) >= 0) { hit = mk; break; }
        }
        if (hit === null) continue;
        if (!/\d/.test(s)) continue;
        // 给了推导依据的放行：能自己复算就不算「抄答案」
        if (/代数|推导|公式|定义为|由.{0,8}得出|=\s*P_|IEEE|浮点/.test(s)) continue;
        const short = s.length > 48 ? s.substring(0, 48) + '…' : s;
        addWarn(`${id} 的 steps 里有一条带「${hit}」+ 具体数值：「${short}」。这类值是编排者跑出来的，Builder 只会抄不会算，下游的『独立验证』因此是被诱导的。要么补上推导依据（能复算就不算抄），要么把它移出任务书 —— 期望值属于 acceptance.json（做成什么样算对），不属于 tasks.json（怎么做）。`);
      }
    }

    // 依赖检查
    for (const t of tasks) {
      const layer = parseInt(t.layer, 10);
      const deps = asList(t.depends_on);
      if (layer > 1 && deps.length === 0) {
        addWarn(`${t.id} 在 layer ${layer} 但没有 depends_on，确认它真的依赖上一层`);
      }
      for (const d of deps) {
        if (!byId[d]) {
          addErr(`${t.id} 依赖了不存在的 ${d}`);
        } else if (parseInt(byId[d].layer, 10) >= layer) {
          addErr(`${t.id} (layer ${layer}) 依赖 ${d} (layer ${byId[d].layer})，依赖必须指向更低的 layer`);
        }
      }
    }

    // 同层文件重叠 —— 并行安全的核心
    const layers = Array.from(new Set(tasks.map((t) => parseInt(t.layer, 10)))).sort((a, b) => a - b);
    for (const L of layers) {
      const inLayer = tasks.filter((t) => parseInt(t.layer, 10) === L);
      for (let i = 0; i < inLayer.length; i++) {
        for (let j = i + 1; j < inLayer.length; j++) {
          const a = inLayer[i];
          const b = inLayer[j];
          const fa = asList(a.files).map((f) => String(f).replace(/\\/g, '/').toLowerCase());
          const fb = asList(b.files).map((f) => String(f).replace(/\\/g, '/').toLowerCase());
          const dup = fa.filter((x) => fb.indexOf(x) >= 0);
          if (dup.length > 0) {
            addErr(`layer ${L} 内 ${a.id} 与 ${b.id} 的 files 重叠: ${dup.join(', ')} —— 并行 Builder 会互相覆盖，而这类冲突审查抓不出来`);
          }
        }
      }
    }

    // AC 覆盖
    for (const id of acIds) {
      if (!covered[id]) {
        addErr(`${id} 没有被任何 task 覆盖`);
      }
    }

    // gates.json 的门是否覆盖了 tasks.json 声明的全部源文件。
    // ⚠ 测试层（gate-test）已不再自动执行 gates.json —— 语法/类型自检下沉 Builder 完成门，
    //   machine AC 测试由测试层直接跑 acceptance.json 的 check。此处只保留「覆盖记录」的核对，
    //   防止切 DAG 时声明了根本没被任何门/测试碰到的源文件。
    const gatesPath = path.join(Root, '.rd', 'gates.json');
    if (!fs.existsSync(gatesPath)) {
      addErr('缺少 .rd/gates.json —— 项目级门面覆盖无从核对（语法/类型自检已下沉 Builder，此文件仅作覆盖记录）');
    } else {
      try {
        const gatesCfg = JSON.parse(fs.readFileSync(gatesPath, 'utf8'));
        const l1arr = asList(gatesCfg.l1);

        /* 历史遗留：kind:"syntax" 的门已随语法门下沉 Builder 而退役，但存量配置里可能还在 ——
           不认识它的话：只配语法门时 cmds 为空串，会被误报「l1 为空」；
           混配时它覆盖的源文件也不算数，会被误报「只覆盖了 0/N 个源文件」。
           两种都是**让一份正确的配置过不了门**，比漏报更劝退。
           语法门声明的 dirs 视同对该目录下所有文件的覆盖。 */
        const syntaxGates = l1arr.filter((g) => g.kind === 'syntax');
        const syntaxDirs = [];
        for (const g of syntaxGates) {
          for (const d of asList(g.dirs)) syntaxDirs.push(String(d).replace(/\\/g, '/').replace(/\/+$/, ''));
        }
        const cmds = l1arr.filter((g) => g.kind !== 'syntax').map((g) => g.cmd).join(' ; ');
        const declaresAll = l1arr.filter((g) => g.coversAllSrc === true).length > 0;

        if (isBlank(cmds) && syntaxGates.length === 0) {
          addErr('gates.json 的 l1 为空');
        } else if (declaresAll) {
          // 有 gate 声明了 coversAllSrc，跳过文件级覆盖检查
        } else {
          const srcFiles = [];
          for (const t of tasks) {
            for (const f of asList(t.files)) {
              const n = String(f).replace(/\\/g, '/');
              if (!/(^|\/)tests?\//.test(n)) srcFiles.push(n);
            }
          }
          const srcUniq = Array.from(new Set(srcFiles)).sort();

          const cmdsNorm = cmds.replace(/\\/g, '/');
          // 语法门按目录覆盖：dirs 里任一目录是该源文件的前缀，就算被覆盖。
          const underSyntaxDir = (sf) => syntaxDirs.some((d) => d !== '' && (sf === d || sf.indexOf(d + '/') === 0));
          const literal = srcUniq.filter((sf) => cmdsNorm.indexOf(sf) >= 0 || underSyntaxDir(sf));
          const hasGlob = /\*/.test(cmds);

          if (!hasGlob && literal.length < srcUniq.length) {
            const missing = srcUniq.filter((sf) => literal.indexOf(sf) < 0);
            addErr(`gates.json 的 l1 只逐字覆盖了 ${literal.length}/${srcUniq.length} 个源文件，且没有通配。未覆盖: ${missing.join(', ')} —— 这些文件的语法/类型错误测试层抓不到，只能靠测试恰好 import 到它们时才炸出来`);
          } else if (!hasGlob && srcUniq.length > 1 && literal.length === srcUniq.length) {
            addWarn(`gates.json 逐字列出了全部 ${srcUniq.length} 个源文件。新增文件时容易漏，建议改成通配`);
          }
        }
      } catch (e) {
        addErr('gates.json 不是合法 JSON: ' + e.message);
      }
    }

    // ---------- contracts.json：跨层契约先行（改动三）----------
    // 下游任务依赖「契约已定义」而非「上游 task 已 done」—— 契约是并行的前提。
    // 校验：存在 + _complete + 每条契约字段合法 + 每个跨层依赖被某条契约覆盖。
    const crossLayer = [];
    for (const t of tasks) {
      const layer = parseInt(t.layer, 10);
      for (const d of asList(t.depends_on)) {
        const up = byId[d];
        if (up && parseInt(up.layer, 10) < layer) crossLayer.push({ up: d, down: t.id });
      }
    }
    const contractsPath = path.join(dir, 'contracts.json');
    const hasCrossLayer = crossLayer.length > 0;
    if (hasCrossLayer && !fs.existsSync(contractsPath)) {
      addErr('有跨层依赖但缺 contracts.json —— 下游 task 依赖「上游 task 已 done」等于串行等实现。先把跨任务接口冻结成契约（模板 templates/contracts.json），再谈并行。');
    } else if (fs.existsSync(contractsPath)) {
      let ccfg = null;
      try { ccfg = JSON.parse(fs.readFileSync(contractsPath, 'utf8')); }
      catch (e) { addErr('contracts.json 不是合法 JSON: ' + e.message); }
      if (ccfg !== null) {
        if (ccfg._complete !== true) addErr('contracts.json 缺 "_complete": true —— 按 D-1 视为未写完');
        const cList = asList(ccfg.contracts);
        if (cList.length === 0 && hasCrossLayer) addErr('contracts.json 的 contracts 为空，但有跨层依赖待覆盖');
        const cSeen = {};
        const edges = new Set();
        for (const c of cList) {
          const cid = c.id;
          if (isBlank(cid)) { addErr('有契约缺 id'); continue; }
          if (cSeen[cid]) addErr(`契约 ${cid} 重复`); else cSeen[cid] = true;
          if (['type-signature', 'api-shape', 'dom-id', 'config', 'protocol'].indexOf(c.kind) < 0) {
            addErr(`契约 ${cid} 的 kind "${c.kind}" 不在合法集合 {type-signature, api-shape, dom-id, config, protocol}`);
          }
          if (isBlank(c.pattern)) addErr(`契约 ${cid} 缺 pattern（机械抽检字面量）`);
          if (asList(c.files).length === 0) addErr(`契约 ${cid} 缺 files`);
          for (const p of asList(c.producers)) if (!byId[p]) addErr(`契约 ${cid} 的 producer ${p} 不是合法 task id`);
          for (const p of asList(c.consumers)) if (!byId[p]) addErr(`契约 ${cid} 的 consumer ${p} 不是合法 task id`);
          for (const pr of asList(c.producers)) {
            for (const cs of asList(c.consumers)) edges.add(pr + '->' + cs);
          }
        }
        for (const x of crossLayer) {
          if (!edges.has(x.up + '->' + x.down)) {
            addErr(`跨层依赖 ${x.up} → ${x.down} 没有被任何契约覆盖 —— 契约先行要覆盖每条跨层依赖，否则这条边还是实现依赖`);
          }
        }
      }
    }
  }
}

// ---------- 输出 ----------
out('');
out(C.cyan(`=== validate-plan [${Stage}] ${Feature} ===`));

if (warnings.length > 0) {
  out('');
  for (const w of warnings) out(C.yellow('  WARN  ' + w));
}

if (errors.length > 0) {
  out('');
  for (const e of errors) out(C.red('  ERR   ' + e));
  out('');
  out(C.red(`=== FAIL (${errors.length} 项) —— 修完再往下走，不要手动跳过 ===`));
  out('');
  process.exit(1);
}

out('');
if (Stage === 'spec') {
  const m = asList(ac.scenarios).filter((s) => s.judge === 'machine').length;
  const a = asList(ac.scenarios).filter((s) => s.judge === 'agent').length;
  out(C.green(`=== PASS —— ${acIds.length} 条验收标准全部可判定 (machine ${m} / agent ${a}) ===`));
} else {
  out(C.green('=== PASS —— DAG 合法、同层无文件冲突、AC 全覆盖 ==='));
}
out('');
process.exit(0);
