// MakeCode Arcade — web interface server
// Serves public/ (task-board) and proxies /api/tt → task-tracker on 3100.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { waitForFlash, probeMounts, writeStatus, STATUS_FILE } = require('./scripts/flash-wait.js');
const { createSupervisor } = require('./scripts/flash-supervisor.js');
const gh = require('./lib/github-sync.js');
const board = require('./lib/board-sync.js');
const cursorAuth = require('./lib/cursor-auth.js');
const remoteSupport = require('./lib/remote-support.js');

const PORT = process.env.MC_PORT || 3778;
const TT_BASE = process.env.TT_BASE_URL || 'http://127.0.0.1:3100';
const PUBLIC_DIR = path.join(__dirname, 'public');
const GAMES_DIR = path.join(__dirname, 'games');

function readDefaultHw() {
  if (process.env.MC_HW) return process.env.MC_HW;
  try {
    const mkc = JSON.parse(fs.readFileSync(path.join(__dirname, 'mkc.json'), 'utf8'));
    if (mkc.hw) return mkc.hw;
  } catch (_) {}
  return 'samd51';
}

const DEFAULT_HW = readDefaultHw();
const FLASH_SUPERVISOR_ENABLED = process.env.FLASH_SUPERVISOR !== '0';

// cursor-agent bundled in repo (Pull/Push sync); override via CURSOR_AGENT_DIR
const CURSOR_AGENT_DIR = process.env.CURSOR_AGENT_DIR || path.join(__dirname, 'cursor-agent');

// Supervisor for the tt-agent-worker. Used by the restart button.
const WORKER_SUPERVISOR = process.env.WORKER_SUPERVISOR
  || path.join(CURSOR_AGENT_DIR, 'tt-agent-worker', 'supervisor.sh');
const WORKER_BASE = (process.env.TT_WORKER_BASE || 'http://127.0.0.1:9080').replace(/\/$/, '');

// Full-stack restart targets (worker + TT + this web server).
const TT_DIR = process.env.TT_DIR || path.join(CURSOR_AGENT_DIR, 'task-tracker');
const TT_LOG = path.join(TT_DIR, 'logs', 'http.log');
const TT_PORT = parseInt(process.env.TT_PORT || '3100', 10);
let ttLastRestartAt = 0;

function tailFile(filePath, lines = 40) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const buf = fs.readFileSync(filePath, 'utf8');
    return buf.split('\n').slice(-lines).join('\n').trim();
  } catch (_) {
    return '';
  }
}

function runShell(script, timeout = 15000) {
  return new Promise((resolve) => {
    execFile('bash', ['-c', script], { timeout }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        error: err ? err.message : null,
      });
    });
  });
}

function waitForTTHealth(maxMs = 8000, intervalMs = 400) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      fetchTTHealth().then((h) => {
        if (h.ok || Date.now() - start >= maxMs) resolve(h);
        else setTimeout(tick, intervalMs);
      });
    };
    tick();
  });
}

function checkTTPort() {
  const port = TT_PORT;
  return runShell(
    `(ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep -q ':${port} ' && echo busy || echo free`,
  );
}

/** Free port 3100 — stale listeners survive pkill on Termux. */
function freeTTPort() {
  const port = TT_PORT;
  return runShell([
    `pkill -f '${TT_DIR.replace(/'/g, "'\\''")}/http-server.js' 2>/dev/null || true`,
    `pkill -f 'node http-server.js' 2>/dev/null || true`,
    `fuser -k ${port}/tcp 2>/dev/null || true`,
    `for pid in $(ss -tlnp 2>/dev/null | grep ':${port} ' | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p' | sort -u); do kill -9 "$pid" 2>/dev/null || true; done`,
    `sleep 1`,
    `(ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep -q ':${port} ' && echo busy || echo free`,
  ].join('; '));
}

/** One-shot TT start probe — captures stderr when detached spawn fails silently. */
function probeTTStart(timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(path.join(TT_DIR, 'http-server.js'))) {
      resolve({ ok: false, error: 'http-server.js missing', output: '' });
      return;
    }
    const safeDir = TT_DIR.replace(/'/g, "'\\''");
    const child = spawn('bash', ['-c', `cd '${safeDir}' && node http-server.js 2>&1`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({
        ok: /listening on port/i.test(output),
        output: output.slice(-1200),
        error: /listening on port/i.test(output) ? null : (output.trim() || 'no output'),
      });
    }, timeoutMs);
    child.on('exit', (code) => {
      finish({
        ok: false,
        output: output.slice(-1200),
        error: output.trim() || `exit ${code}`,
      });
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  // Prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function proxyToTT(req, res, pathname) {
  // pathname is like /api/tt/projects/... → forward to TT_BASE/api/projects/...
  // (task-board.js uses /api/tt as its base; TT's REST routes live under /api)
  const targetPath = pathname.replace(/^\/api\/tt/, '/api');
  const targetUrl = new URL(targetPath, TT_BASE);
  targetUrl.search = req.url.split('?')[1] || '';

  const headers = { ...req.headers };
  headers.host = new URL(TT_BASE).host;
  headers['content-type'] = headers['content-type'] || 'application/json';

  const proxyReq = http.request(targetUrl, {
    method: req.method,
    headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'task-tracker недоступен: ' + err.message }));
  });

  req.pipe(proxyReq);
}

function safeSlug(name) {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(name);
}

function safeHw(name) {
  return /^[a-z0-9_-]+$/i.test(name);
}

function listGames(req, res) {
  fs.readdir(GAMES_DIR, { withFileTypes: true }, (err, entries) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    const games = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
    const result = games.map((slug) => {
      const uf2Path = path.join(GAMES_DIR, slug, 'built', DEFAULT_HW, 'binary.uf2');
      let uf2 = null;
      try {
        const st = fs.statSync(uf2Path);
        uf2 = { hw: DEFAULT_HW, size: st.size, url: `/api/games/${slug}/uf2?hw=${DEFAULT_HW}` };
      } catch (_) {}
      return { slug, uf2 };
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ games: result, default_hw: DEFAULT_HW }));
  });
}

function serveGameUf2(req, res, slug, hw) {
  if (!safeSlug(slug) || !safeHw(hw)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Некорректный slug или hw' }));
    return;
  }
  const uf2Path = path.join(GAMES_DIR, slug, 'built', hw, 'binary.uf2');
  if (!uf2Path.startsWith(GAMES_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(uf2Path, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: 'UF2 не найден',
        hint: 'Сначала соберите игру: bash scripts/build.sh games/' + slug,
      }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${slug}.uf2"`,
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

let flashJob = null;
const flashSupervisor = createSupervisor({ hw: DEFAULT_HW, slug: process.env.MC_GAME || null });

function readFlashStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch (_) {
    return { waiting: false, result: null };
  }
}

function startFlashWait(slug, hw, timeoutSec) {
  if (flashJob) {
    return Promise.resolve({ ok: false, error: 'Уже ждём консоль', status: readFlashStatus() });
  }
  return new Promise((resolve) => {
    flashJob = { slug, hw, started: Date.now() };
    waitForFlash(slug, hw, timeoutSec)
      .then((result) => {
        flashJob = null;
        resolve({ ok: result.ok, result });
      })
      .catch((err) => {
        flashJob = null;
        resolve({ ok: false, error: err.message });
      });
  });
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function runSupervisor(args) {
  return new Promise((resolve) => {
    execFile('bash', [WORKER_SUPERVISOR, ...args], { timeout: 30000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        error: err ? err.message : null,
      });
    });
  });
}

function fetchWorkerHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${WORKER_BASE}/health`, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function fetchTTHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${TT_BASE}/api/projects`, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: body.slice(0, 200) });
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

function fetchStackStatus() {
  return Promise.all([fetchTTHealth(), runSupervisor(['status']), fetchWorkerHealth()]).then(([tt, sup, health]) => {
    let worker = { running: false, pid: null };
    if (sup.ok && sup.stdout) {
      try { worker = JSON.parse(sup.stdout); } catch (_) {}
    }
    return {
      tt: { ok: !!tt.ok, error: tt.error || null },
      worker: {
        running: !!worker.running,
        pid: worker.pid || null,
        apiKey: health?.apiKey === true,
        activeTaskId: health?.queue?.active?.taskId || null,
      },
    };
  });
}

/** Start TT + worker if not already up (fresh clone often runs only node server.js). */
function ensureStackRunning() {
  if (process.env.MC_NO_AUTOSTART === '1') return Promise.resolve();
  // After web 🔄, give TT from the prior restartTT() time to bind before pkill again.
  return waitForTTHealth(5000).then((ttHealth) => fetchStackStatus().then((st) => {
    const jobs = [];
    if (!st.tt.ok && !ttHealth.ok) {
      console.log('[makecode-arcade] task-tracker offline — starting…');
      jobs.push(restartTT().then((r) => {
        console.log('[makecode-arcade]', r.ok ? r.stdout : (r.error || r.stdout || 'TT start failed'));
      }));
    }
    if (!st.worker.running) {
      console.log('[makecode-arcade] tt-agent-worker offline — starting…');
      jobs.push(
        runSupervisor(['start']),
        runSupervisor(['ensure-watch']),
      );
    }
    return Promise.all(jobs);
  })).catch((err) => {
    console.error('[makecode-arcade] autostart failed:', err.message);
  });
}

function collectTTDiagnostics() {
  return checkTTPort().then((portCheck) => ({
    ttDir: TT_DIR,
    ttDirExists: fs.existsSync(TT_DIR),
    httpServerExists: fs.existsSync(path.join(TT_DIR, 'http-server.js')),
    tasksDirExists: fs.existsSync(path.join(TT_DIR, 'tasks')),
    logTail: tailFile(TT_LOG, 50),
    portCheck: portCheck.stdout || portCheck.stderr,
    lastRestartAt: ttLastRestartAt || null,
  }));
}

// Restart the task-tracker (TT, port 3100): kill stale listeners, start fresh, verify health.
function restartTT({ force } = {}) {
  if (!fs.existsSync(TT_DIR)) {
    return Promise.resolve({ ok: false, error: `TT_DIR not found: ${TT_DIR}` });
  }
  if (!fs.existsSync(path.join(TT_DIR, 'http-server.js'))) {
    return Promise.resolve({ ok: false, error: `http-server.js missing in ${TT_DIR}` });
  }

  const sinceRestart = Date.now() - ttLastRestartAt;
  if (!force && sinceRestart < 8000 && sinceRestart > 0) {
    return waitForTTHealth(8000 - sinceRestart).then((h) => ({
      ok: !!h.ok,
      stdout: h.ok ? 'TT already up' : 'TT still starting…',
      error: h.ok ? null : (h.error || 'timeout'),
    }));
  }

  ttLastRestartAt = Date.now();
  fs.mkdirSync(path.join(TT_DIR, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(TT_DIR, 'tasks'), { recursive: true });

  const safeDir = TT_DIR.replace(/'/g, "'\\''");
  const safeLog = TT_LOG.replace(/'/g, "'\\''");

  return freeTTPort().then(() => new Promise((resolve) => {
    const child = spawn('bash', ['-c', `cd '${safeDir}' && exec node http-server.js >> '${safeLog}' 2>&1`], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const spawnPid = child.pid;
    waitForTTHealth(10000).then(async (health) => {
      if (health.ok) {
        resolve({
          ok: true,
          stdout: `TT restarted (spawn pid ${spawnPid})`,
          error: null,
        });
        return;
      }
      const portBusy = (await checkTTPort()).stdout === 'busy';
      if (portBusy) {
        const retry = await waitForTTHealth(4000);
        if (retry.ok) {
          resolve({
            ok: true,
            stdout: `TT up (spawn pid ${spawnPid}, slow bind)`,
            error: null,
          });
          return;
        }
        resolve({
          ok: false,
          stdout: `TT spawn pid ${spawnPid}`,
          error: retry.error || 'port :3100 busy but TT health check failed',
          logTail: tailFile(TT_LOG, 30),
        });
        return;
      }
      probeTTStart(3500).then((probe) => {
        resolve({
          ok: false,
          stdout: `TT spawn pid ${spawnPid}`,
          error: health.error || probe.error || 'TT did not respond on :3100',
          probe: probe.output || null,
          logTail: tailFile(TT_LOG, 30),
        });
      });
    });
  }));
}

// Restart this web server itself. Must be called AFTER the HTTP response has
// been sent. Spawns a detached process that kills the current server (its own
// parent) and starts a fresh `node server.js` from the project dir.
function spawnWebServerRestart() {
  const script = [
    `sleep 1`,
    `kill -TERM ${process.pid} 2>/dev/null || true`,
    `sleep 1`,
    `kill -KILL ${process.pid} 2>/dev/null || true`,
    `cd '${__dirname}' && node server.js >> server.log 2>&1 &`,
  ].join('; ');
  const child = spawn('bash', ['-c', script], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];

  // Worker restart / status — used by the task-board restart button.
  if (pathname === '/api/worker/restart' && req.method === 'POST') {
    // Full-stack restart: worker + TT + this web server. Restart the worker
    // and TT first so the response can report their status, then send the
    // response and restart the web server itself in the background.
    Promise.all([
      runSupervisor(['restart']),
      runSupervisor(['ensure-watch']),
      restartTT({ force: true }),
    ]).then(([r, w, tt]) => {
      res.writeHead(r.ok && tt.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: r.ok,
        output: r.stdout || r.stderr || r.error,
        watch: w.stdout || w.stderr || w.error,
        tt: tt.stdout || tt.stderr || tt.error,
        ttOk: !!tt.ok,
        ttDetail: tt.error || null,
        web: 'restarting',
      }));
      // Restart the web server itself after the response is flushed.
      spawnWebServerRestart();
    });
    return;
  }
  if (pathname === '/api/stack/status' && req.method === 'GET') {
    fetchStackStatus().then((st) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(st));
    });
    return;
  }
  if (pathname === '/api/stack/diagnostics' && req.method === 'GET') {
    Promise.all([fetchStackStatus(), collectTTDiagnostics()]).then(async ([stack, ttInfo]) => {
      let probe = null;
      if (!stack.tt.ok) {
        probe = await probeTTStart(2500);
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ stack, tt: ttInfo, probe }));
    });
    return;
  }
  if (pathname === '/api/stack/repair-tt' && req.method === 'POST') {
    restartTT({ force: true }).then((result) => {
      res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (pathname === '/api/worker/status' && req.method === 'GET') {
    Promise.all([runSupervisor(['status']), fetchWorkerHealth()]).then(([r, health]) => {
      let data = { running: false, pid: null, log_tail: '' };
      if (r.ok && r.stdout) {
        try { data = JSON.parse(r.stdout); } catch (_) {}
      }
      const active = health?.queue?.active || null;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: r.ok,
        ...data,
        activeTaskId: active?.taskId || null,
        activeShortId: active?.shortId || null,
        activeStartedAt: active?.startedAt || null,
        error: r.error,
      }));
    });
    return;
  }

  if (pathname.startsWith('/api/tt')) {
    proxyToTT(req, res, pathname);
    return;
  }

  // GitHub: авторизация и синхронизация MakeCode-проектов.
  if (pathname === '/api/github/status' && req.method === 'GET') {
    gh.verifyAuthStatus().then((st) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(st));
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ connected: false, error: err.message }));
    });
    return;
  }
  if (pathname === '/api/github/token' && req.method === 'POST') {
    parseJsonBody(req).then(async (body) => {
      const result = await gh.saveToken(body.token);
      gh.warmProjectsCache();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }
  if (pathname === '/api/github/logout' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(gh.clearAuth()));
    return;
  }
  if (pathname === '/api/github/device/start' && req.method === 'POST') {
    gh.startDeviceFlow().then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }
  if (pathname === '/api/github/device/poll' && req.method === 'POST') {
    parseJsonBody(req).then(async (body) => {
      const result = await gh.pollDeviceFlow(body.device_code);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }
  if (pathname === '/api/github/projects' && req.method === 'GET') {
    const refresh = new URL(req.url, 'http://localhost').searchParams.get('refresh') === '1';
    gh.listMakecodeRepos({ refresh }).then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    }).catch((err) => {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }
  if (pathname === '/api/github/scan' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(gh.getScanProgress()));
    return;
  }
  if (pathname === '/api/github/local' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ games: gh.listLocalGames() }));
    return;
  }
  if (pathname === '/api/github/clone' && req.method === 'POST') {
    parseJsonBody(req).then(async (body) => {
      const result = await gh.cloneProject(body);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }
  if (pathname === '/api/github/pull' && req.method === 'POST') {
    parseJsonBody(req).then(async (body) => {
      const result = await gh.pullProject(body.slug || body.game);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }
  if (pathname === '/api/github/push' && req.method === 'POST') {
    parseJsonBody(req).then(async (body) => {
      const result = await gh.pushProject(body.slug || body.game, body.message);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // Система заявок — git sync оболочки (semver v.X.Y.Z в коммитах).
  if (pathname === '/api/board/status' && req.method === 'GET') {
    board.getBoardStatus().then((st) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(st));
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }
  if (pathname === '/api/board/link' && req.method === 'POST') {
    parseJsonBody(req).then((body) => {
      const result = board.linkBoard(body);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }
  if (pathname === '/api/board/pull' && req.method === 'POST') {
    board.pullBoard().then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }
  if (pathname === '/api/board/push' && req.method === 'POST') {
    parseJsonBody(req).then(async (body) => {
      const result = await board.pushBoard(body.message);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }
  // Agent commit: semver bump (patch|minor|major) + optional push. taskId → #short в сообщении.
  if (pathname === '/api/board/commit' && req.method === 'POST') {
    parseJsonBody(req).then(async (body) => {
      const result = await board.commitBoard({
        bump: body.bump || 'patch',
        message: body.message || body.body,
        taskId: body.taskId || body.task_id,
        push: !!body.push,
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // Cursor API key — локально, не в git.
  if (pathname === '/api/cursor/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(cursorAuth.getCursorStatus()));
    return;
  }
  if (pathname === '/api/cursor/token' && req.method === 'POST') {
    parseJsonBody(req).then((body) => {
      const result = cursorAuth.saveCursorKey(body.token || body.apiKey);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }
  if (pathname === '/api/cursor/logout' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(cursorAuth.clearCursorKey()));
    return;
  }

  // Техподдержка (Quick Assist): клиент вводит код от помощника → временный SSH.
  if (pathname === '/api/support/client/start' && req.method === 'POST') {
    remoteSupport.startClientMode(fetchStackStatus, restartTT).then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }
  if (pathname === '/api/support/client/authorize' && req.method === 'POST') {
    parseJsonBody(req).then(async (body) => {
      const result = await remoteSupport.authorizeClient(body.code, fetchStackStatus, restartTT);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }
  if (pathname === '/api/support/client/stop' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(remoteSupport.stopClientSession('user')));
    return;
  }
  if (pathname === '/api/support/client/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(remoteSupport.getClientStatus()));
    return;
  }
  if (pathname === '/api/support/client/diagnostics' && req.method === 'POST') {
    remoteSupport.rerunDiagnostics(fetchStackStatus, restartTT).then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }
  if (pathname === '/api/support/helper/start' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(remoteSupport.startHelperSession()));
    return;
  }
  if (pathname === '/api/support/helper/connect' && req.method === 'POST') {
    parseJsonBody(req).then((body) => {
      const sess = remoteSupport.getHelperSession(body.code);
      if (!sess.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(sess));
        return;
      }
      const ssh = remoteSupport.buildSshCommand(body.user, body.host, sess.code);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, ...sess, ssh }));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // Список игр и скачивание UF2 по LAN (обход ненадёжного USB OTG на Android).
  if (pathname === '/api/games' && req.method === 'GET') {
    listGames(req, res);
    return;
  }
  const uf2Match = pathname.match(/^\/api\/games\/([^/]+)\/uf2$/);
  if (uf2Match && req.method === 'GET') {
    const hw = new URL(req.url, 'http://localhost').searchParams.get('hw') || DEFAULT_HW;
    serveGameUf2(req, res, decodeURIComponent(uf2Match[1]), hw);
    return;
  }

  // Автопрошивка: ждём OTG-консоль и копируем UF2 за миллисекунды после монтирования.
  if (pathname === '/api/flash/probe' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(probeMounts()));
    return;
  }
  if (pathname === '/api/flash/status' && req.method === 'GET') {
    const status = readFlashStatus();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      active: !!flashJob,
      supervisor: flashSupervisor.getState(),
      ...status,
    }));
    return;
  }
  if (pathname === '/api/flash/supervisor' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(flashSupervisor.getState()));
    return;
  }
  if (pathname === '/api/flash/supervisor/recheck' && req.method === 'POST') {
    flashSupervisor.forceRecheck().then((st) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(st));
    });
    return;
  }
  if (pathname === '/api/flash/pending' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      hw: DEFAULT_HW,
      pending: flashSupervisor.listAllPending(),
      supervisor: flashSupervisor.getState(),
    }));
    return;
  }
  if (pathname === '/api/flash/wait' && req.method === 'POST') {
    parseJsonBody(req).then((body) => {
      const slug = body.game || body.slug || 'my-test';
      const hw = body.hw || DEFAULT_HW;
      const timeout = Number(body.timeout || 120);
      if (!safeSlug(slug)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Некорректный slug' }));
        return;
      }
      if (flashJob) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Уже ждём консоль', status: readFlashStatus() }));
        return;
      }
      res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        message: 'Жду консоль. Подключите OTG и reset → bootloader.',
        game: slug,
        hw,
        timeout,
        poll_url: '/api/flash/status',
      }));
      startFlashWait(slug, hw, timeout);
    }).catch(() => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Некорректный JSON' }));
    });
    return;
  }
  if (pathname === '/api/flash/wait' && req.method === 'GET') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const slug = q.get('game') || q.get('slug') || 'my-test';
    const hw = q.get('hw') || DEFAULT_HW;
    const timeout = Number(q.get('timeout') || 120);
    if (!safeSlug(slug)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Некорректный slug' }));
      return;
    }
    if (flashJob) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Уже ждём консоль', status: readFlashStatus() }));
      return;
    }
    startFlashWait(slug, hw, timeout).then((result) => {
      res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[makecode-arcade] web server on http://0.0.0.0:${PORT}`);
  console.log(`[makecode-arcade] proxying /api/tt → ${TT_BASE}`);
  if (FLASH_SUPERVISOR_ENABLED) {
    flashSupervisor.start();
    console.log(`[makecode-arcade] flash supervisor: auto hw=${DEFAULT_HW}`);
  }
  gh.warmProjectsCache();
  ensureStackRunning();
});
