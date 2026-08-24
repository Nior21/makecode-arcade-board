// GitHub sync for MakeCode Arcade projects (LAN server, no extra deps).
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const AUTH_FILE = path.join(__dirname, '..', '.github-auth.json');
const PROJECTS_FILE = path.join(__dirname, '..', '.github-projects.json');
const PROJECTS_CACHE_FILE = path.join(__dirname, '..', '.github-projects-cache.json');
const GAMES_DIR = path.join(__dirname, '..', 'games');
const PROJECTS_CACHE_TTL_MS = Number(process.env.GITHUB_PROJECTS_CACHE_TTL_MS || 60 * 60 * 1000);
const SCAN_CONCURRENCY = Number(process.env.GITHUB_SCAN_CONCURRENCY || 6);

let scanPromise = null;
let scanProgress = { running: false, done: 0, total: 0, found: 0, error: null, started_at: null };

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const auth = readJson(AUTH_FILE, null);
  return auth?.token || null;
}

function getAuthStatus() {
  const envToken = !!process.env.GITHUB_TOKEN;
  const auth = readJson(AUTH_FILE, null);
  const token = getToken();
  return {
    connected: !!token,
    login: auth?.login || null,
    source: envToken ? 'env' : (auth?.token ? 'file' : null),
    client_id: process.env.GITHUB_CLIENT_ID || null,
  };
}

function formatGhError(statusCode, parsed, raw) {
  const msg = parsed?.message || parsed?.error_description || parsed?.error;
  if (statusCode === 401) {
    return msg && msg !== 'Bad credentials'
      ? `GitHub: ${msg}`
      : 'Неверный или просроченный токен (401)';
  }
  if (statusCode === 403) {
    if (parsed?.message?.includes('rate limit')) return 'GitHub: превышен лимит запросов, подождите';
    return msg ? `GitHub: ${msg}` : 'GitHub: доступ запрещён (403)';
  }
  if (statusCode === 404) return msg ? `GitHub: ${msg}` : 'GitHub: ресурс не найден (404)';
  if (msg) return String(msg);
  if (raw && !String(raw).startsWith('<')) return String(raw).slice(0, 200);
  return `GitHub HTTP ${statusCode}`;
}

function ghHttpRequest(hostname, method, apiPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname,
      path: apiPath,
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'makecode-arcade-sync',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { raw: data }; }
        if (res.statusCode >= 400) {
          reject(new Error(formatGhError(res.statusCode, parsed, data)));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', (err) => {
      reject(new Error(`Сеть GitHub: ${err.message}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** OAuth / Device Flow — только github.com */
function ghOAuthRequest(method, apiPath, body) {
  return ghHttpRequest('github.com', method, apiPath, body, null);
}

/** REST API — только api.github.com */
function ghApiRequest(method, apiPath, body, token) {
  return ghHttpRequest('api.github.com', method, apiPath, body, token);
}

function ghApi(method, apiPath, body, token) {
  const tok = token || getToken();
  if (!tok) return Promise.reject(new Error('GitHub не авторизован'));
  return ghApiRequest(method, apiPath, body, tok);
}

async function verifyAuthStatus() {
  const base = getAuthStatus();
  if (!base.connected) {
    return { ...base, connected: false, login: null, error: null, verified: true };
  }
  try {
    const user = await ghApiRequest('GET', '/user', null, getToken());
    const auth = readJson(AUTH_FILE, null);
    if (auth?.token && user.login && auth.login !== user.login) {
      writeJson(AUTH_FILE, { ...auth, login: user.login });
    }
    return {
      ...base,
      connected: true,
      login: user.login || base.login,
      error: null,
      verified: true,
    };
  } catch (err) {
    if (base.source === 'file') clearAuth();
    return {
      ...base,
      connected: false,
      login: null,
      error: err.message,
      verified: true,
    };
  }
}

async function saveToken(token, meta = {}) {
  const trimmed = String(token || '').trim();
  if (!trimmed) throw new Error('Введите Personal Access Token');
  if (!/^(gh[pousr]_|[0-9a-f]{40})/i.test(trimmed)) {
    throw new Error('Токен не похож на GitHub PAT (ожидается ghp_…, github_pat_… и т.п.)');
  }
  let login = meta.login || null;
  if (!login) {
    const user = await ghApiRequest('GET', '/user', null, trimmed);
    login = user.login;
    if (!login) throw new Error('GitHub не вернул имя пользователя');
  }
  try {
    writeJson(AUTH_FILE, {
      token: trimmed,
      login,
      scopes: meta.scopes || null,
      saved_at: new Date().toISOString(),
    });
  } catch (err) {
    throw new Error(`Не удалось сохранить токен: ${err.message}`);
  }
  return { ok: true, login };
}

function clearAuth() {
  try { fs.unlinkSync(AUTH_FILE); } catch (_) {}
  return { ok: true };
}

async function startDeviceFlow() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    throw new Error('GITHUB_CLIENT_ID не задан (OAuth App с Device Flow)');
  }
  const data = await ghOAuthRequest('POST', '/login/device/code', {
    client_id: clientId,
    scope: 'repo',
  });
  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    expires_in: data.expires_in,
    interval: data.interval || 5,
  };
}

async function pollDeviceFlow(deviceCode) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) throw new Error('GITHUB_CLIENT_ID не задан');
  const data = await ghOAuthRequest('POST', '/login/oauth/access_token', {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (data.error) {
    if (data.error === 'authorization_pending' || data.error === 'slow_down') {
      return { pending: true, interval: data.interval || 5 };
    }
    throw new Error(data.error_description || data.error);
  }
  return saveToken(data.access_token, { scopes: data.scope || 'repo' });
}

function isMakecodeArcadePxt(pxt) {
  if (!pxt || typeof pxt !== 'object') return false;
  if (!Array.isArray(pxt.files)) return false;
  const deps = pxt.dependencies || {};
  if (deps.device) return true;
  const tv = pxt.targetVersions || {};
  if (String(tv.commits || '').includes('pxt-arcade')) return true;
  if (tv.target || tv.tag || tv.branch) return true;
  for (const v of Object.values(deps)) {
    if (String(v).includes('arcade') || String(v).includes('pxt-')) return true;
  }
  return pxt.preferredEditor === 'blocksprj' || pxt.preferredEditor === 'tsprj';
}

async function fetchRawFile(owner, repo, filePath, ref) {
  const token = getToken();
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const encPath = filePath.split('/').map(encodeURIComponent).join('/');
  let data;
  try {
    data = await ghApi('GET', `/repos/${owner}/${repo}/contents/${encPath}${q}`, null, token);
  } catch (err) {
    if (/404|not found/i.test(err.message)) return null;
    throw err;
  }
  if (Array.isArray(data) || !data.content) return null;
  const text = Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

async function listDir(owner, repo, dirPath) {
  const token = getToken();
  const pathPart = dirPath ? `/${dirPath.split('/').map(encodeURIComponent).join('/')}` : '';
  let data;
  try {
    data = await ghApi('GET', `/repos/${owner}/${repo}/contents${pathPart}`, null, token);
  } catch (err) {
    if (/404|not found/i.test(err.message)) return [];
    throw err;
  }
  return Array.isArray(data) ? data : [];
}

async function findMakecodePaths(owner, repo) {
  const hits = [];
  const rootPxt = await fetchRawFile(owner, repo, 'pxt.json');
  if (isMakecodeArcadePxt(rootPxt)) {
    hits.push({ path: '', name: rootPxt.name || repo });
    return hits;
  }
  const rootEntries = await listDir(owner, repo, '');
  for (const entry of rootEntries) {
    if (entry.type !== 'dir' || entry.name.startsWith('.')) continue;
    const pxt = await fetchRawFile(owner, repo, `${entry.name}/pxt.json`);
    if (isMakecodeArcadePxt(pxt)) {
      hits.push({ path: entry.name, name: pxt.name || entry.name });
    }
  }
  return hits;
}

function readProjectsCache() {
  const cached = readJson(PROJECTS_CACHE_FILE, null);
  if (!cached || !Array.isArray(cached.projects)) return null;
  return cached;
}

function writeProjectsCache(login, projects) {
  writeJson(PROJECTS_CACHE_FILE, {
    login,
    projects,
    cached_at: new Date().toISOString(),
  });
}

function isProjectsCacheFresh(cached) {
  if (!cached?.cached_at) return false;
  const age = Date.now() - Date.parse(cached.cached_at);
  return Number.isFinite(age) && age >= 0 && age < PROJECTS_CACHE_TTL_MS;
}

async function mapPool(items, concurrency, fn) {
  if (!items.length) return [];
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next;
      next += 1;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

function getScanProgress() {
  return { ...scanProgress };
}

async function listAllUserRepos(token) {
  const out = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await ghApi(
      'GET',
      `/user/repos?per_page=100&sort=updated&page=${page}`,
      null,
      token,
    );
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

async function scanMakecodeRepos() {
  const token = getToken();
  if (!token) throw new Error('GitHub не авторизован');

  scanProgress = {
    running: true,
    done: 0,
    total: 0,
    found: 0,
    error: null,
    started_at: new Date().toISOString(),
  };

  try {
    const user = await ghApiRequest('GET', '/user', null, token);
    const login = user.login || getAuthStatus().login;
    const repos = await listAllUserRepos(token);
    scanProgress.total = repos.length;

    const chunks = await mapPool(repos, SCAN_CONCURRENCY, async (repo) => {
      const hits = [];
      try {
        const paths = await findMakecodePaths(repo.owner.login, repo.name);
        for (const hit of paths) {
          hits.push({
            owner: repo.owner.login,
            repo: repo.name,
            full_name: repo.full_name,
            path: hit.path,
            name: hit.name,
            html_url: repo.html_url,
            updated_at: repo.updated_at,
            default_branch: repo.default_branch || 'main',
          });
        }
      } catch (_) {
        // skip inaccessible repos
      } finally {
        scanProgress.done += 1;
        scanProgress.found += hits.length;
      }
      return hits;
    });

    const out = chunks.flat();
    out.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    writeProjectsCache(login, out);
    return { login, projects: out, cached: false, scanned_at: new Date().toISOString() };
  } catch (err) {
    scanProgress.error = err.message;
    throw err;
  } finally {
    scanProgress.running = false;
  }
}

async function listMakecodeRepos(options = {}) {
  const refresh = !!options.refresh;
  const cached = readProjectsCache();

  if (!refresh && cached && isProjectsCacheFresh(cached)) {
    return {
      login: cached.login,
      projects: cached.projects,
      cached: true,
      scanned_at: cached.cached_at,
    };
  }

  if (!refresh && cached?.projects?.length && !scanPromise) {
    scanMakecodeRepos().catch(() => {});
    return {
      login: cached.login,
      projects: cached.projects,
      cached: true,
      stale: true,
      scanned_at: cached.cached_at,
    };
  }

  if (scanPromise && !refresh) {
    return scanPromise;
  }

  scanPromise = scanMakecodeRepos().finally(() => {
    scanPromise = null;
  });
  return scanPromise;
}

function warmProjectsCache() {
  if (!getToken() || scanPromise) return;
  scanPromise = scanMakecodeRepos().finally(() => {
    scanPromise = null;
  });
}

function readProjectsMap() {
  return readJson(PROJECTS_FILE, {});
}

function writeProjectsMap(map) {
  writeJson(PROJECTS_FILE, map);
}

function safeSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'game';
}

function runGit(cwd, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', `safe.directory=${cwd}`, ...args], {
      cwd,
      timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(String(stderr || stdout || err.message).trim()));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function gameDir(slug) {
  const dir = path.join(GAMES_DIR, slug);
  if (!dir.startsWith(GAMES_DIR)) throw new Error('Некорректный slug');
  return dir;
}

async function cloneProject({ owner, repo, path: subPath, slug }) {
  const token = getToken();
  const destSlug = slug || safeSlug(subPath ? `${repo}-${subPath}` : repo);
  const dest = gameDir(destSlug);
  if (fs.existsSync(dest)) throw new Error(`Каталог games/${destSlug} уже существует`);

  const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await runGit(GAMES_DIR, ['clone', '--depth', '1', cloneUrl, destSlug]);

  if (subPath) {
    // sparse: move subfolder contents up if needed — for monorepos keep subpath note in map
    writeProjectsMap({
      ...readProjectsMap(),
      [destSlug]: { owner, repo, path: subPath, branch: 'main' },
    });
  } else {
    writeProjectsMap({
      ...readProjectsMap(),
      [destSlug]: { owner, repo, path: '', branch: 'main' },
    });
  }

  // Ensure mkc.json exists
  const mkcPath = path.join(dest, 'mkc.json');
  if (!fs.existsSync(mkcPath)) {
    const rootMkc = path.join(__dirname, '..', 'mkc.json');
    if (fs.existsSync(rootMkc)) fs.copyFileSync(rootMkc, mkcPath);
  }

  return { slug: destSlug, path: dest };
}

async function pullProject(slug) {
  const dest = gameDir(slug);
  if (!fs.existsSync(dest)) throw new Error(`Игра games/${slug} не найдена`);
  if (!fs.existsSync(path.join(dest, '.git'))) {
    throw new Error(`games/${slug} не git-репозиторий — сначала Clone из GitHub`);
  }
  await runGit(dest, ['pull', '--ff-only']);
  return { slug, message: 'pull ok' };
}

async function pushProject(slug, message) {
  const dest = gameDir(slug);
  if (!fs.existsSync(dest)) throw new Error(`Игра games/${slug} не найдена`);
  const msg = String(message || `sync ${slug} ${new Date().toISOString()}`).slice(0, 200);

  if (!fs.existsSync(path.join(dest, '.git'))) {
    const map = readProjectsMap()[slug];
    if (!map) throw new Error(`Нет привязки GitHub для games/${slug}`);
    const token = getToken();
    const cloneUrl = `https://x-access-token:${token}@github.com/${map.owner}/${map.repo}.git`;
    await runGit(dest, ['init']);
    await runGit(dest, ['remote', 'add', 'origin', cloneUrl]);
    await runGit(dest, ['checkout', '-B', map.branch || 'main']);
  }

  await runGit(dest, ['add', '-A']);
  const status = await runGit(dest, ['status', '--porcelain']);
  if (!status) return { slug, message: 'Нет изменений' };
  await runGit(dest, ['commit', '-m', msg]);
  await runGit(dest, ['push', '-u', 'origin', 'HEAD']);
  return { slug, message: 'push ok' };
}

function listLocalGames() {
  if (!fs.existsSync(GAMES_DIR)) return [];
  return fs.readdirSync(GAMES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== '_template')
    .map((e) => {
      const slug = e.name;
      const pxtPath = path.join(GAMES_DIR, slug, 'pxt.json');
      let name = slug;
      try {
        const pxt = JSON.parse(fs.readFileSync(pxtPath, 'utf8'));
        if (pxt.name) name = pxt.name;
      } catch (_) {}
      const linked = readProjectsMap()[slug] || null;
      const isGit = fs.existsSync(path.join(GAMES_DIR, slug, '.git'));
      return { slug, name, linked, isGit };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

module.exports = {
  getToken,
  getAuthStatus,
  verifyAuthStatus,
  saveToken,
  clearAuth,
  startDeviceFlow,
  pollDeviceFlow,
  listMakecodeRepos,
  getScanProgress,
  warmProjectsCache,
  cloneProject,
  pullProject,
  pushProject,
  listLocalGames,
  isMakecodeArcadePxt,
};
