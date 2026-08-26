#!/usr/bin/env node
/**
 * deploy.js — Push-based deploy for task-tracker
 *
 * Runs from Qwen Code Stop hook. Outputs deploy details to stdout.
 * Full history goes to logs/deploy.log.
 *
 * Exit codes:
 *   0 — nothing to deploy or deploy succeeded
 *   1 — deploy failed
 */

import { execSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const LOG_DIR = join(PROJECT_DIR, 'logs');
const LOG_FILE = join(LOG_DIR, 'deploy.log');

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

function logToFile(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
}

function run(cmd) {
  try {
    return execSync(cmd, { cwd: PROJECT_DIR, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch (e) {
    return { error: e.stderr?.trim() || e.message };
  }
}

function getChangedFiles() {
  try {
    const files = execSync('git diff --cached --name-only', { cwd: PROJECT_DIR, encoding: 'utf8' }).trim();
    return files ? files.split('\n') : [];
  } catch (_) {
    return [];
  }
}

function main() {
  logToFile('=== Deploy check started ===');

  const status = run('git status --porcelain');
  if (!status || status === '') {
    logToFile('No changes to deploy');
    console.log('✅ deploy-tt: nothing to deploy');
    return;
  }

  logToFile('Changes detected, committing...');
  status.split('\n').forEach(line => logToFile(`  ${line}`));

  const commitResult = run('git add -A && git commit -m "auto-deploy $(date +%Y-%m-%d_%H:%M:%S)"');
  if (commitResult.error) {
    logToFile(`Commit failed: ${commitResult.error}`);
    console.log('❌ deploy-tt: commit failed');
    process.exit(1);
  }
  logToFile(`Committed: ${commitResult.split('\n')[0]}`);

  const commitHash = run('git rev-parse --short HEAD');
  const changedFiles = getChangedFiles();

  const pushResult = run('git push rpi master --force');
  if (pushResult.error) {
    logToFile(`Push failed: ${pushResult.error}`);
    console.log('❌ deploy-tt: push failed');
    process.exit(1);
  }
  logToFile('Push successful');

  const lines = [`✅ deploy-tt: deployed (${commitHash})`];
  if (changedFiles.length > 0) {
    lines.push(`   Файлы (${changedFiles.length}): ${changedFiles.join(', ')}`);
  }
  console.log(lines.join('\n'));
}

main();
