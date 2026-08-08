#!/usr/bin/env node
/*
  enable-agent-teams —— 往 ~/.claude/settings.json 写入 Agent Teams 开关。

  Agent Teams 只服务 rd-build 的 A 档并行（队友共享任务列表、可互相通信），
  对应环境变量：
    env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"

  不开也能跑：rd-build 自动降级到 B 档并行子 agent，编排规则完全相同。
  rd-plan 的方案论证从来不用 Teams —— 它要的是互不通信的独立样本。

  两种用法：
    1) install.js -Apply 默认调用它（失败就跳过，不阻塞安装）
    2) 上面那次失败后，用户手动补一条：
         node scripts/enable-agent-teams.js

  幂等：已经是 "1" 就什么都不做。写之前先把原文件备份成 settings.json.bak-<时间戳>。
  只碰 env 里这一个键，settings.json 其余内容原样保留。

  用法：
    node scripts/enable-agent-teams.js
    node scripts/enable-agent-teams.js -DryRun
    node scripts/enable-agent-teams.js -ClaudeHome /custom/.claude

  退出码：0 = 成功（含已配置 / dry-run）；1 = 失败（信息在 stderr）。
*/
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ENV_KEY = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';
const ENV_VAL = '1';

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/*
  写入开关。永不抛异常 —— 调用方（install.js）要靠返回值决定是否跳过。

  返回 { ok, action, file, backup?, error? }
    action: 'already'  已经配好了，没动文件
            'created'  settings.json 原本不存在，新建
            'merged'   合并进已有的 settings.json
            'plan'     dryRun，只报告将要做什么
*/
function enableAgentTeams(opts) {
  const o = opts || {};
  const claudeHome = o.claudeHome || path.join(os.homedir(), '.claude');
  const file = path.join(claudeHome, 'settings.json');
  const result = { ok: false, action: null, file, backup: null, error: null };

  try {
    let raw = null;
    if (fs.existsSync(file)) raw = fs.readFileSync(file, 'utf8');

    let json = {};
    if (raw !== null && raw.trim() !== '') {
      // 解析失败就交给调用方跳过 —— 绝不拿一个空对象覆盖用户的配置
      json = JSON.parse(raw);
      if (json === null || typeof json !== 'object' || Array.isArray(json)) {
        result.error = `${file} 顶层不是一个 JSON 对象，不敢动它`;
        return result;
      }
    }

    if (json.env && typeof json.env === 'object' && !Array.isArray(json.env)
        && String(json.env[ENV_KEY]) === ENV_VAL) {
      result.ok = true;
      result.action = 'already';
      return result;
    }

    const action = raw === null ? 'created' : 'merged';
    if (o.dryRun) {
      result.ok = true;
      result.action = 'plan';
      result.plannedAction = action;
      return result;
    }

    if (json.env === undefined) json.env = {};
    if (typeof json.env !== 'object' || json.env === null || Array.isArray(json.env)) {
      result.error = `${file} 里的 env 不是一个对象，不敢动它`;
      return result;
    }

    // 有原文件就先备份，坏了能原样退回去
    if (raw !== null) {
      const bak = `${file}.bak-${ts()}`;
      fs.writeFileSync(bak, raw, 'utf8');
      result.backup = bak;
    }

    json.env[ENV_KEY] = ENV_VAL;
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');

    result.ok = true;
    result.action = action;
    return result;
  } catch (e) {
    result.error = e && e.message ? e.message : String(e);
    return result;
  }
}

module.exports = { enableAgentTeams, ENV_KEY, ENV_VAL };

// ---- 直接运行时的 CLI ----
if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^--?dryrun$/i.test(a)) { opts.dryRun = true; continue; }
    if (/^--?claudehome(=|$)/i.test(a)) {
      const eq = a.indexOf('=');
      opts.claudeHome = eq >= 0 ? a.slice(eq + 1) : argv[++i];
    }
  }

  const r = enableAgentTeams(opts);
  if (!r.ok) {
    process.stderr.write(`✗ 没能写入 ${ENV_KEY}：${r.error}\n`);
    process.stderr.write(`  请手动在 ${r.file} 的 env 对象里加上 "${ENV_KEY}": "${ENV_VAL}"\n`);
    process.exit(1);
  }

  const msg = {
    already: `✓ ${ENV_KEY} 已经是 "${ENV_VAL}"，无需改动`,
    created: `✓ 已新建 ${r.file} 并写入 ${ENV_KEY}="${ENV_VAL}"`,
    merged: `✓ 已把 ${ENV_KEY}="${ENV_VAL}" 合并进 ${r.file}`,
    plan: `[dry-run] 将 ${r.plannedAction === 'created' ? '新建' : '更新'} ${r.file}，写入 ${ENV_KEY}="${ENV_VAL}"`,
  }[r.action];
  process.stdout.write(msg + '\n');
  if (r.backup) process.stdout.write(`  原文件已备份 -> ${path.basename(r.backup)}\n`);
  if (r.action === 'created' || r.action === 'merged') {
    process.stdout.write('  重启 Claude Code 后生效。\n');
  }
  process.exit(0);
}
