import { readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function maxMtimeMs(dir) {
  let max = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.js')) continue;
    try {
      max = Math.max(max, statSync(join(dir, name)).mtimeMs);
    } catch {
      /* skip */
    }
  }
  return max;
}

/** Latest mtime of src/*.js at worker boot — used to detect deploy without restart. */
export const workerSrcMtimeAtBoot = maxMtimeMs(SRC_DIR);

export function workerSourceStale() {
  return maxMtimeMs(SRC_DIR) > workerSrcMtimeAtBoot;
}

/** Exit cleanly so supervisor.sh watch starts a fresh Node process with new code. */
export function exitIfStale(log = console.error) {
  if (!workerSourceStale()) return false;
  log('[reload] worker src updated since boot — exiting for supervisor restart');
  process.exit(0);
}
