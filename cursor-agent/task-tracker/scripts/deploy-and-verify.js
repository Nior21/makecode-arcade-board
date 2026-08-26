#!/usr/bin/env node
/**
 * deploy-and-verify.js
 *
 * Автономная цепочка: push → ждёт деплой → проверяет лог → reconnect → тестирует все 7 команд.
 * Использует rpc.js для всех HTTP-запросов (единый инструмент, без проблем с кавычками).
 *
 * Использование:
 *   node scripts/deploy-and-verify.js
 *   node scripts/deploy-and-verify.js --skip-push   # если push уже сделан
 *   node scripts/deploy-and-verify.js --skip-reconnect  # не переподключать Qwen Code
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RPC = `node ${join(__dirname, 'rpc.js')}`;

const RPI = 'pi@192.168.88.153';

const args = process.argv.slice(2);
const SKIP_PUSH = args.includes('--skip-push');
const SKIP_RECONNECT = args.includes('--skip-reconnect');

let passed = 0;
let failed = 0;

function ok(msg) {
  console.log(`  ✓ ${msg}`);
  passed++;
}

function fail(msg, detail) {
  console.log(`  ✗ ${msg}`);
  if (detail) console.log(`    ${detail}`);
  failed++;
}

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', timeout: 30000, ...opts });
}

function ssh(cmd) {
  return run(`ssh ${RPI} "${cmd.replace(/"/g, '\\"')}"`);
}

function rpc(method, toolName, args) {
  let cmd = `${RPC} ${method}`;
  if (toolName) cmd += ` ${toolName}`;
  if (args !== undefined) {
    const tmpFile = join(__dirname, `_rpc_args_${Date.now()}.json`);
    writeFileSync(tmpFile, JSON.stringify(args), 'utf8');
    cmd += ` @${tmpFile}`;
    try {
      const out = run(cmd);
      return JSON.parse(out);
    } finally {
      try { unlinkSync(tmpFile); } catch (_) {}
    }
  } else {
    const out = run(cmd);
    return JSON.parse(out);
  }
}

function rpcRaw(method, toolName, args) {
  let cmd = `${RPC} --raw ${method}`;
  if (toolName) cmd += ` ${toolName}`;
  if (args !== undefined) {
    const tmpFile = join(__dirname, `_rpc_args_${Date.now()}.json`);
    writeFileSync(tmpFile, JSON.stringify(args), 'utf8');
    cmd += ` @${tmpFile}`;
    try {
      const out = run(cmd);
      return JSON.parse(out);
    } finally {
      try { unlinkSync(tmpFile); } catch (_) {}
    }
  } else {
    const out = run(cmd);
    return JSON.parse(out);
  }
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== Deploy & Verify ===\n');

  // 1. Push
  if (!SKIP_PUSH) {
    console.log('1. Git push...');
    try {
      const out = run('git push origin master --force');
      if (out.includes('master -> master')) {
        ok('push successful');
      } else {
        fail('push — unexpected output');
        console.log(out);
      }
    } catch (e) {
      fail('push failed', e.message);
    }
  } else {
    console.log('1. Git push — SKIPPED');
  }

  // 2. Wait for deploy + check log
  console.log('2. Wait for deploy...');
  await new Promise(r => setTimeout(r, 3000));

  try {
    const log = ssh('tail -3 /tmp/task-tracker-deploy.log');
    if (log.includes('SUCCESS: task-tracker is active')) {
      ok('deploy successful (service active)');
    } else {
      fail('deploy — service not active', log);
    }
  } catch (e) {
    fail('deploy — cannot read log', e.message);
  }

  // 3. Check file version
  console.log('3. Check deployed files...');
  try {
    const localHash = run('git rev-parse HEAD').trim();
    const remoteHash = ssh('git --git-dir=/home/pi/task-tracker.git rev-parse HEAD').trim();
    if (localHash === remoteHash) {
      ok(`files match (${localHash.slice(0, 7)})`);
    } else {
      fail(`files mismatch: local=${localHash.slice(0, 7)} remote=${remoteHash.slice(0, 7)}`);
    }
  } catch (e) {
    fail('cannot check file version', e.message);
  }

  // 4. Reconnect Qwen Code
  if (!SKIP_RECONNECT) {
    console.log('4. Reconnect Qwen Code...');
    try {
      const out = run('npx qwen mcp reconnect --all');
      if (out.includes('Reconnected successfully')) {
        ok('reconnect successful');
      } else {
        fail('reconnect — unexpected output', out);
      }
    } catch (e) {
      fail('reconnect failed', e.message);
    }
  } else {
    console.log('4. Reconnect Qwen Code — SKIPPED');
  }

  // 5. Test all 7 tools
  console.log('5. Test all tools...');

  // 5a. tools/list
  try {
    const res = rpcRaw('tools/list');
    const tools = res.result?.tools || [];
    const names = tools.map(t => t.name).sort();
    const expected = ['create_task', 'get_project_context', 'get_task', 'list_tasks', 'rank_tasks', 'search_tasks', 'update_task'];
    if (JSON.stringify(names) === JSON.stringify(expected)) {
      ok(`tools/list — ${tools.length} tools`);
    } else {
      fail('tools/list — wrong tools', `got: ${names.join(', ')}`);
    }
  } catch (e) {
    fail('tools/list failed', e.message);
  }

  // 5b. create_task
  let taskId;
  try {
    const task = rpc('tools/call', 'create_task', {
      title: 'Verify test task',
      description: 'Created by deploy-and-verify.js',
      priority: 'high',
      project: 'verify'
    });
    taskId = task.id;
    if (taskId && task.title === 'Verify test task') {
      ok(`create_task — ${taskId.slice(0, 8)}...`);
    } else {
      fail('create_task — unexpected result', JSON.stringify(task));
    }
  } catch (e) {
    fail('create_task failed', e.message);
  }

  // 5c. get_task
  if (taskId) {
    try {
      const task = rpc('tools/call', 'get_task', { id: taskId });
      if (task.id === taskId) {
        ok('get_task — found');
      } else {
        fail('get_task — wrong id');
      }
    } catch (e) {
      fail('get_task failed', e.message);
    }
  }

  // 5d. update_task
  if (taskId) {
    try {
      const task = rpc('tools/call', 'update_task', { id: taskId, updates: { status: 'in_progress' } });
      if (task.status === 'in_progress') {
        ok('update_task — status changed');
      } else {
        fail('update_task — status not changed', JSON.stringify(task));
      }
    } catch (e) {
      fail('update_task failed', e.message);
    }
  }

  // 5e. list_tasks
  try {
    const tasks = rpc('tools/call', 'list_tasks', { project: 'verify' });
    if (Array.isArray(tasks) && tasks.length >= 1) {
      ok(`list_tasks — ${tasks.length} tasks`);
    } else {
      fail('list_tasks — unexpected result', JSON.stringify(tasks));
    }
  } catch (e) {
    fail('list_tasks failed', e.message);
  }

  // 5f. search_tasks
  try {
    const tasks = rpc('tools/call', 'search_tasks', { query: 'Verify' });
    if (Array.isArray(tasks) && tasks.length >= 1) {
      ok('search_tasks — found');
    } else {
      fail('search_tasks — not found', JSON.stringify(tasks));
    }
  } catch (e) {
    fail('search_tasks failed', e.message);
  }

  // 5g. get_project_context
  try {
    const ctx = rpc('tools/call', 'get_project_context', { project: 'verify' });
    if (ctx.project === 'verify' && ctx.stats) {
      ok('get_project_context — ok');
    } else {
      fail('get_project_context — unexpected', JSON.stringify(ctx));
    }
  } catch (e) {
    fail('get_project_context failed', e.message);
  }

  // 5h. rank_tasks
  try {
    const result = rpc('tools/call', 'rank_tasks', { project: 'verify' });
    if (result.project === 'verify' && typeof result.updated === 'number') {
      ok('rank_tasks — ok');
    } else {
      fail('rank_tasks — unexpected', JSON.stringify(result));
    }
  } catch (e) {
    fail('rank_tasks failed', e.message);
  }

  // Cleanup: delete test task
  if (taskId) {
    try {
      ssh(`rm -f /home/pi/task-tracker/tasks/${taskId}.json`);
      ssh(`cat > /tmp/cleanup-task.js << 'SCRIPT'
const {readFileSync,writeFileSync,existsSync}=require('fs');
const f='/home/pi/task-tracker/tasks/index.json';
if(existsSync(f)){
  const i=JSON.parse(readFileSync(f,'utf8'));
  i.tasks=i.tasks.filter(t=>t!=='${taskId}');
  Object.keys(i.projects).forEach(p=>{
    i.projects[p]=i.projects[p].filter(t=>t!=='${taskId}');
    if(!i.projects[p].length) delete i.projects[p];
  });
  writeFileSync(f,JSON.stringify(i,null,2));
}
SCRIPT
node /tmp/cleanup-task.js`);
      ok('cleanup — test task removed');
    } catch (_) {}
  }

  printSummary();
}

function printSummary() {
  const total = passed + failed;
  console.log(`\n─── ${total} checks: ${passed} passed, ${failed} failed ───\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
