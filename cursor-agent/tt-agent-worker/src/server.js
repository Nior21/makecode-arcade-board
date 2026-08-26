import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { config } from './config.js';
import { createQueue } from './queue.js';
import { runAgentJob } from './runner.js';
import { systemPressure } from './memguard.js';

function log(...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.error(`[${ts}]`, ...args);
}

const queue = createQueue({
  runJob: (job) => runAgentJob(job, { log }),
  log,
});

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function normalizeJob(payload) {
  const task = payload.task || {};
  const taskId = task.id || payload.task_id;
  if (!taskId) return null;
  const event = payload.event || 'assignee_to_agent';
  if (!['assignee_to_agent', 'task_created_for_agent'].includes(event)) {
    return { skip: true, reason: `ignored event ${event}` };
  }
  if (payload.to_assignee && payload.to_assignee !== config.assignee) {
    return { skip: true, reason: `to_assignee=${payload.to_assignee}` };
  }
  return {
    jobId: randomUUID(),
    taskId,
    shortId: task.short_id || String(taskId).split('-')[0],
    project: task.project || 'yt-game',
    payload,
    receivedAt: new Date().toISOString(),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${config.host}:${config.port}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    send(res, 200, {
      ok: true,
      dryRun: config.dryRun,
      apiKey: !!config.apiKey,
      model: config.model,
      queue: queue.status(),
      pressure: systemPressure(),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    send(res, 200, { queue: queue.status(), config: {
      host: config.host,
      port: config.port,
      maxQueue: config.maxQueue,
      minMemAvailableKb: config.minMemAvailableKb,
      runTimeoutMs: config.runTimeoutMs,
      watchdogTimeoutMs: config.watchdogTimeoutMs || config.runTimeoutMs,
      dryRun: config.dryRun,
      hasApiKey: !!config.apiKey,
    }});
    return;
  }

  if (req.method === 'POST' && url.pathname === '/hook') {
    try {
      const payload = await readJson(req);
      const job = normalizeJob(payload);
      if (!job) {
        send(res, 400, { ok: false, error: 'missing task.id' });
        return;
      }
      if (job.skip) {
        send(res, 200, { ok: true, skipped: true, reason: job.reason });
        return;
      }
      const result = queue.enqueue(job);
      send(res, result.accepted ? 202 : 429, {
        ok: result.accepted,
        reason: result.reason || null,
        jobId: result.accepted ? job.jobId : undefined,
        queue: result.status,
      });
    } catch (err) {
      send(res, 400, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  send(res, 404, { error: 'not found' });
});

server.listen(config.port, config.host, () => {
  log(`tt-agent-worker on http://${config.host}:${config.port}`);
  log(`dryRun=${config.dryRun} apiKey=${config.apiKey ? 'yes' : 'NO'} model=${config.model}`);
  log(`maxQueue=${config.maxQueue} minMemMiB≈${Math.round(config.minMemAvailableKb / 1024)}`);
  const p = systemPressure();
  log(`boot pressure: avail≈${Math.round(p.memAvailableKb / 1024)}MiB load1=${p.load1}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`shutting down (${sig})`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
