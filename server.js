// MakeCode Arcade — web interface server
// Serves public/ (task-board) and proxies /api/tt → task-tracker on 3100.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { waitForFlash, probeMounts, writeStatus, STATUS_FILE } = require('./scripts/flash-wait.js');
const { createSupervisor } = require('./scripts/flash-supervisor.js');
const gh = require('./lib/github-sync.js');
const board = require('./lib/board-sync.js');
const cursorAuth = require('./lib/cursor-auth.js');

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

// Supervisor for the tt-agent-worker. Used by the restart button.
const WORKER_SUPERVISOR = process.env.WORKER_SUPERVISOR
  || '/storage/emulated/0/Projects/cursor-agent/tt-agent-worker/supervisor.sh';

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

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];

  // Worker restart / status — used by the task-board restart button.
  if (pathname === '/api/worker/restart' && req.method === 'POST') {
    // Restart the worker, then make sure the detached watch loop is running so
    // it stays alive across future crashes/hangs.
    Promise.all([runSupervisor(['restart']), runSupervisor(['ensure-watch'])]).then(([r, w]) => {
      res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: r.ok, output: r.stdout || r.stderr || r.error, watch: w.stdout || w.stderr || w.error }));
    });
    return;
  }
  if (pathname === '/api/worker/status' && req.method === 'GET') {
    runSupervisor(['status']).then((r) => {
      let data = { running: false, pid: null, log_tail: '' };
      if (r.ok && r.stdout) {
        try { data = JSON.parse(r.stdout); } catch (_) {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: r.ok, ...data, error: r.error }));
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
});
