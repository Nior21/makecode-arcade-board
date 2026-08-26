import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
/** Board repo root (makecode-arcade-board clone). */
const BOARD_ROOT = resolve(ROOT, '../..');

function loadDotEnv() {
  const p = resolve(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadDotEnv();

const PROJECT_CWDS = {
  'cursor-agent': resolve(BOARD_ROOT, 'cursor-agent'),
  'makecode-arcade': BOARD_ROOT,
};

export const config = {
  root: ROOT,
  host: process.env.TT_WORKER_HOST || '127.0.0.1',
  port: parseInt(process.env.TT_WORKER_PORT || '9080', 10),
  ttBase: (process.env.TT_BASE_URL || 'http://127.0.0.1:3100').replace(/\/$/, ''),
  ttMcpUrl: process.env.TT_MCP_URL || 'http://127.0.0.1:3100/mcp',
  assignee: process.env.TT_WEBHOOK_ASSIGNEE || 'AI_Agent',
  apiKey: (process.env.CURSOR_API_KEY || '').trim(),
  model: process.env.CURSOR_MODEL || 'composer-2.5',
  dryRun: process.env.TT_WORKER_DRY_RUN === '1' || process.env.TT_WORKER_DRY_RUN === 'true',
  /** Hard cap: never more than one Cursor agent at a time. */
  maxConcurrent: 1,
  /** Waiting jobs beyond this are rejected (protect RAM). */
  maxQueue: Math.max(1, parseInt(process.env.TT_WORKER_MAX_QUEUE || '2', 10) || 2),
  /** Skip starting a run if MemAvailable below this (kB). Default ~180 MiB. */
  minMemAvailableKb: Math.max(64 * 1024, parseInt(process.env.TT_WORKER_MIN_MEM_KB || String(180 * 1024), 10) || 180 * 1024),
  /** Soft run timeout — best-effort cancel. */
  runTimeoutMs: Math.max(60_000, parseInt(process.env.TT_WORKER_TIMEOUT_MS || String(25 * 60 * 1000), 10) || 25 * 60 * 1000),
  /** Watchdog force-exit threshold. Defaults to runTimeoutMs; can be set lower
   *  to detect a hung agent sooner. If the active job runs past this, the
   *  worker force-exits so the supervisor restarts it. */
  watchdogTimeoutMs: Math.max(60_000, parseInt(process.env.TT_WORKER_WATCHDOG_MS || '', 10) || 0) || null,
  projectCwds: { ...PROJECT_CWDS, ...(parseJsonMap(process.env.TT_WORKER_PROJECT_CWDS)) },
  defaultCwd: process.env.TT_WORKER_DEFAULT_CWD || BOARD_ROOT,
  boardRoot: BOARD_ROOT,
};

function parseJsonMap(raw) {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

export function cwdForProject(project) {
  const key = String(project || '').trim();
  if (config.projectCwds[key]) return config.projectCwds[key];
  const gameDir = resolve(BOARD_ROOT, 'games', key);
  if (existsSync(gameDir)) return gameDir;
  return config.defaultCwd;
}
