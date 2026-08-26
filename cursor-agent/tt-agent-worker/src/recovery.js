import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = resolve(__dirname, '..', 'queue-state.json');

/**
 * Persist the queue's active + queued jobs to disk so unfinished work survives
 * a worker restart (crash, hang, manual restart). The webhook payload is kept
 * so the job can be fully reconstructed and re-queued on boot.
 */
export function persistQueue({ active, queued }) {
  try {
    const data = {
      savedAt: new Date().toISOString(),
      active: active || null,
      queued: queued || [],
    };
    writeFileSync(STATE_FILE, JSON.stringify(data));
  } catch (err) {
    // Non-fatal: recovery is best-effort.
    console.error('[recovery] persist failed:', err.message);
  }
}

/**
 * Load any persisted jobs from a previous run. Returns { active, queued }.
 * The active job (if any) is returned in `queued` so it gets re-run, since it
 * was interrupted by the restart.
 */
export function loadQueue() {
  if (!existsSync(STATE_FILE)) return { active: null, queued: [] };
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const queued = Array.isArray(data.queued) ? data.queued : [];
    if (data.active) queued.unshift(data.active);
    return { active: null, queued };
  } catch (err) {
    console.error('[recovery] load failed:', err.message);
    return { active: null, queued: [] };
  }
}

/** Clear the persisted state (after a clean drain). */
export function clearQueue() {
  try {
    if (existsSync(STATE_FILE)) writeFileSync(STATE_FILE, JSON.stringify({ savedAt: new Date().toISOString(), active: null, queued: [] }));
  } catch (_) {}
}
