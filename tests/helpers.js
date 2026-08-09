'use strict';
/* 测试用的一次性仓库夹具。

   这些测试验的是脚本对**真实 git 仓库**的行为，不是纯函数 ——
   F1 那个缺陷（git diff 看不见未跟踪文件）在任何 mock 上都复现不出来，
   只有真的建一个仓库、真的放几个未跟踪文件才会暴露。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(REPO_ROOT, 'scripts');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentrd-' + prefix + '-'));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

function git(root, argv) {
  const r = spawnSync('git', argv, { cwd: root, encoding: 'utf8' });
  return { code: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// 建一个有一次提交的干净仓库。刻意关掉 autocrlf，免得行尾转换搅进 diff 断言。
function initRepo(prefix) {
  const root = mkTmp(prefix);
  git(root, ['init', '-q', '.']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['config', 'core.autocrlf', 'false']);
  write(root, '.gitignore', 'node_modules/\n');
  write(root, 'tracked.txt', 'original\n');
  git(root, ['add', '.gitignore', 'tracked.txt']);
  git(root, ['commit', '-qm', 'init']);
  return root;
}

// 跑仓库里的某个脚本，返回 {code, out}（stdout+stderr 合并，便于断言提示语）
function runScript(name, argv, cwd) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, name), ...argv], {
    cwd, encoding: 'utf8', env: Object.assign({}, process.env, { FORCE_COLOR: '0' }),
  });
  return { code: r.status === null ? 1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 清理失败不该让测试变红 */ }
}

module.exports = { REPO_ROOT, SCRIPTS, mkTmp, write, git, initRepo, runScript, rmrf };
