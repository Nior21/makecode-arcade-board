import { config } from './config.js';
import { memoryOk, systemPressure } from './memguard.js';
import { persistQueue, loadQueue } from './recovery.js';
import { exitIfStale } from './reload.js';

/**
 * Single-flight FIFO queue. maxConcurrent is forced to 1 for RPI safety.
 */
export function createQueue({ runJob, log = console.error }) {
  const q = [];
  let active = null;
  let pumping = false;

  // Persist state whenever the queue changes, so unfinished work survives a
  // restart. Re-queue any jobs left over from a previous run.
  function save() {
    persistQueue({ active, queued: q });
  }

  const recovered = loadQueue();
  for (const job of recovered.queued) {
    if (job && job.taskId) {
      q.push(job);
      log(`[recovery] re-queued ${job.shortId || job.taskId}`);
    }
  }
  if (recovered.queued.length) {
    log(`[recovery] ${recovered.queued.length} job(s) restored from previous run`);
    setImmediate(pump);
  }

  // Watchdog: if the active job runs past the watchdog threshold, the Cursor
  // agent is almost certainly hung (futex-stuck on a network call). Force-exit
  // so the supervisor restarts us and the task is re-queued via recovery.
  const watchdogMs = config.watchdogTimeoutMs || config.runTimeoutMs;
  const watchdog = setInterval(() => {
    if (!active) return;
    const elapsedMs = Date.now() - new Date(active.startedAt).getTime();
    if (elapsedMs > watchdogMs) {
      log(`[watchdog] active job ${active.shortId || active.taskId} hung ${Math.round(elapsedMs / 1000)}s > threshold ${Math.round(watchdogMs / 1000)}s — force-exit`);
      process.exit(2);
    }
  }, 30_000);
  watchdog.unref();

  function status() {
    const pressure = systemPressure();
    return {
      active: active
        ? {
            jobId: active.jobId,
            taskId: active.taskId,
            shortId: active.shortId,
            startedAt: active.startedAt,
          }
        : null,
      queued: q.map(j => ({ jobId: j.jobId, taskId: j.taskId, shortId: j.shortId })),
      queueLength: q.length,
      maxQueue: config.maxQueue,
      pressure: {
        memAvailableMiB: Math.round(pressure.memAvailableKb / 1024),
        load1: pressure.load1,
      },
    };
  }

  function enqueue(job) {
    // Dedupe: same task already waiting or running
    if (active?.taskId === job.taskId) {
      return { accepted: false, reason: 'already_running', status: status() };
    }
    if (q.some(j => j.taskId === job.taskId)) {
      return { accepted: false, reason: 'already_queued', status: status() };
    }
    if (q.length >= config.maxQueue) {
      return { accepted: false, reason: 'queue_full', status: status() };
    }
    q.push(job);
    log(`[queue] + ${job.shortId || job.taskId} (len=${q.length})`);
    save();
    setImmediate(pump);
    return { accepted: true, status: status() };
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (q.length && !active) {
        const mem = memoryOk(config.minMemAvailableKb);
        if (!mem.ok) {
          log(`[queue] wait mem: available=${mem.memAvailableMiB}MiB < min=${Math.round(config.minMemAvailableKb / 1024)}MiB`);
          // Don't spin hot — retry later
          setTimeout(() => { pumping = false; pump(); }, 15_000);
          return;
        }
        const job = q.shift();
        active = { ...job, startedAt: new Date().toISOString() };
        log(`[queue] start ${job.shortId || job.taskId}`);
        save();
        try {
          await runJob(job);
        } catch (err) {
          log(`[queue] job error ${job.shortId}: ${err?.message || err}`);
        } finally {
          active = null;
          log(`[queue] done ${job.shortId || job.taskId}`);
          save();
          // Brief cooldown so OS can reclaim pages before next agent
          await sleep(3_000);
          // Pick up runner.js fixes from agent commits without manual 🔄
          exitIfStale(log);
        }
      }
    } finally {
      pumping = false;
      if (q.length && !active) setImmediate(pump);
    }
  }

  return { enqueue, status };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
