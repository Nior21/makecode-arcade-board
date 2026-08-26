// Git sync for «Система заявок»: UI + cursor-agent engine (без games/, tasks/, секретов).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const gh = require('./github-sync.js');

const ROOT = path.join(__dirname, '..');
const LINK_FILE = path.join(ROOT, '.board-github.json');
const DEFAULT_VERSION = 'v.1.0.0';
const VERSION_RE = /^v\.(\d+)\.(\d+)\.(\d+)\b/i;

const BOARD_PATHS = [
  'public',
  'lib',
  'scripts',
  'cursor-agent',
  'server.js',
  'package.json',
  'package-lock.json',
  'mkc.json',
  '.gitignore',
  'README.md',
];

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

function runGitDetailed(cwd, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', `safe.directory=${cwd}`, ...args], {
      cwd,
      timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim();
      const errOut = String(stderr || '').trim();
      if (err) {
        reject(new Error(String(errOut || out || err.message).trim()));
        return;
      }
      resolve({ stdout: out, stderr: errOut });
    });
  });
}

const REDIRECT_RE = /warning:\s*redirecting to\s+(https?:\/\/[^\s]+)/i;

function extractRedirectUrl(stderr) {
  const m = String(stderr || '').match(REDIRECT_RE);
  return m ? m[1].replace(/\/+$/, '') : null;
}

/** Канонический HTTPS-URL без .git — совпадает с тем, куда GitHub редиректит. */
function boardRemoteUrl(link, token) {
  const base = `https://github.com/${link.owner}/${link.repo}`;
  if (!token) return base;
  return `https://x-access-token:${token}@${base.replace(/^https:\/\//, '')}`;
}

async function maybeFixRemoteRedirect(stderr, link, token) {
  const target = extractRedirectUrl(stderr);
  if (!target) return false;
  let fixed = target;
  if (token && fixed.includes('github.com/')) {
    fixed = fixed.replace(/^https:\/\//, `https://x-access-token:${token}@`);
  }
  await runGit(ROOT, ['remote', 'set-url', 'origin', fixed]);
  return true;
}

async function getAheadBehind(branch) {
  try {
    const ab = await runGit(ROOT, ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`]);
    const [behind, ahead] = ab.split(/\s+/).map(Number);
    return { behind: behind || 0, ahead: ahead || 0 };
  } catch (_) {
    return { behind: 0, ahead: 0 };
  }
}

function parseVersion(text) {
  const m = String(text || '').trim().match(VERSION_RE);
  if (!m) return null;
  return `v.${m[1]}.${m[2]}.${m[3]}`;
}

function bumpPatch(version) {
  return bumpVersion(version, 'patch');
}

function bumpMinor(version) {
  return bumpVersion(version, 'minor');
}

function bumpMajor(version) {
  return bumpVersion(version, 'major');
}

/** @param {'patch'|'minor'|'major'} level */
function bumpVersion(version, level = 'patch') {
  const m = String(version || '').match(VERSION_RE);
  if (!m) return DEFAULT_VERSION;
  let major = Number(m[1]);
  let minor = Number(m[2]);
  let patch = Number(m[3]);
  if (level === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (level === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `v.${major}.${minor}.${patch}`;
}

function taskShortRef(taskId) {
  const raw = String(taskId || '').trim();
  if (!raw) return '';
  return raw.split('-')[0];
}

function formatCommitMessage(version, body, taskId) {
  const ver = parseVersion(version) || DEFAULT_VERSION;
  const rest = String(body || 'sync').trim().replace(/^\s*v\.\d+\.\d+\.\d+\s*:?\s*/i, '');
  const ref = taskShortRef(taskId);
  const prefix = ref ? `#${ref} ` : '';
  return `${ver}: ${prefix}${rest || 'sync'}`;
}

async function readHeadMessage() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return null;
  try {
    return await runGit(ROOT, ['log', '-1', '--pretty=%s']);
  } catch (_) {
    return null;
  }
}

async function getCurrentVersion() {
  const msg = await readHeadMessage();
  return parseVersion(msg) || DEFAULT_VERSION;
}

async function getHeadSha() {
  if (!isGitRepo()) return null;
  try {
    return await runGit(ROOT, ['rev-parse', 'HEAD']);
  } catch (_) {
    return null;
  }
}

async function getShortSha() {
  if (!isGitRepo()) return null;
  try {
    return await runGit(ROOT, ['rev-parse', '--short', 'HEAD']);
  } catch (_) {
    return null;
  }
}

async function stageBoardPaths() {
  for (const rel of BOARD_PATHS) {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) await runGit(ROOT, ['add', '--', rel]);
  }
  return runGit(ROOT, ['status', '--porcelain', '--', ...BOARD_PATHS]);
}

function readBoardLink() {
  return readJson(LINK_FILE, null);
}

function writeBoardLink(link) {
  writeJson(LINK_FILE, link);
}

function isGitRepo() {
  return fs.existsSync(path.join(ROOT, '.git'));
}

async function ensureGitInit() {
  if (isGitRepo()) return;
  await runGit(ROOT, ['init', '-b', 'main']);
}

async function ensureInitialCommit() {
  await ensureGitInit();
  const head = await readHeadMessage().catch(() => null);
  if (head) return { created: false, message: head };
  for (const rel of BOARD_PATHS) {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) await runGit(ROOT, ['add', '--', rel]);
  }
  const msg = formatCommitMessage(DEFAULT_VERSION, 'initial shell', null);
  await runGit(ROOT, ['commit', '-m', msg]);
  return { created: true, message: msg };
}

async function gitDirty() {
  if (!isGitRepo()) return false;
  const status = await runGit(ROOT, ['status', '--porcelain', '--', ...BOARD_PATHS]);
  return !!status;
}

async function getRemoteSyncState(link) {
  if (!link?.owner || !link?.repo || !gh.getToken() || !isGitRepo()) {
    return { ahead: 0, behind: 0, remoteVersion: null, remoteSha: null, synced: true };
  }
  try {
    await ensureRemote();
    const branch = link.branch || 'main';
    const fetchOut = await runGitDetailed(ROOT, ['fetch', 'origin', branch]).catch(() => ({ stderr: '' }));
    await maybeFixRemoteRedirect(fetchOut.stderr || '', link, gh.getToken());
    const { ahead, behind } = await getAheadBehind(branch);
    let remoteVersion = null;
    let remoteSha = null;
    try {
      const remoteMsg = await runGit(ROOT, ['log', '-1', '--pretty=%s', `origin/${branch}`]);
      remoteVersion = parseVersion(remoteMsg);
      remoteSha = await runGit(ROOT, ['rev-parse', '--short', `origin/${branch}`]);
    } catch (_) {}
    return { ahead, behind, remoteVersion, remoteSha, synced: ahead === 0 && behind === 0 };
  } catch (_) {
    return { ahead: 0, behind: 0, remoteVersion: null, remoteSha: null, synced: true };
  }
}

async function getBoardStatus() {
  const linked = readBoardLink();
  const version = await getCurrentVersion();
  let dirty = false;
  try {
    dirty = await gitDirty();
  } catch (_) {}
  const sync = await getRemoteSyncState(linked);
  return {
    slug: 'makecode-arcade',
    name: 'Система заявок',
    version,
    isGit: isGitRepo(),
    dirty,
    linked: linked ? { owner: linked.owner, repo: linked.repo, branch: linked.branch || 'main' } : null,
    ...sync,
  };
}

async function ensureRemote() {
  const link = readBoardLink();
  if (!link?.owner || !link?.repo) {
    throw new Error('Репозиторий не привязан — укажите owner/repo в .board-github.json или через API /api/board/link');
  }
  const token = gh.getToken();
  if (!token) throw new Error('GitHub не авторизован');
  const remoteUrl = boardRemoteUrl(link, token);
  if (!isGitRepo()) await ensureGitInit();
  let remotes = '';
  try {
    remotes = await runGit(ROOT, ['remote']);
  } catch (_) {}
  if (!remotes.includes('origin')) {
    await runGit(ROOT, ['remote', 'add', 'origin', remoteUrl]);
  } else {
    await runGit(ROOT, ['remote', 'set-url', 'origin', remoteUrl]);
  }
  return link;
}

async function pullBoard() {
  await ensureInitialCommit();
  const link = await ensureRemote();
  const token = gh.getToken();
  const branch = link.branch || 'main';
  const shaBefore = await getHeadSha();
  const versionBefore = await getCurrentVersion();

  let fetchOut = await runGitDetailed(ROOT, ['fetch', 'origin', branch]);
  await maybeFixRemoteRedirect(fetchOut.stderr, link, token);

  const { behind, ahead } = await getAheadBehind(branch);
  let remoteVersion = null;
  try {
    const remoteMsg = await runGit(ROOT, ['log', '-1', '--pretty=%s', `origin/${branch}`]);
    remoteVersion = parseVersion(remoteMsg);
  } catch (_) {}

  await runGit(ROOT, ['checkout', branch]).catch(async () => {
    await runGit(ROOT, ['checkout', '-B', branch]);
  });

  if (behind === 0) {
    return {
      message: 'Already up to date',
      version: versionBefore,
      updated: false,
      behind: 0,
      ahead,
      sha: shaBefore,
      ...(ahead > 0 ? { hint: `Локально ${versionBefore}, на GitHub ${remoteVersion || '?'} — ${ahead} комм. не запушено` } : {}),
    };
  }

  await runGit(ROOT, ['merge', '--ff-only', `origin/${branch}`]);
  return {
    message: 'pull ok',
    version: await getCurrentVersion(),
    updated: true,
    behind: 0,
    ahead,
    sha: await getHeadSha(),
    previousVersion: versionBefore,
    commitsPulled: behind,
  };
}

/**
 * Локальный коммит оболочки с semver-bump.
 * @param {{ bump?: 'patch'|'minor'|'major', message?: string, taskId?: string, push?: boolean }} opts
 */
async function commitBoard(opts = {}) {
  await ensureInitialCommit();
  const bump = ['patch', 'minor', 'major'].includes(opts.bump) ? opts.bump : 'patch';
  const current = await getCurrentVersion();
  const next = bumpVersion(current, bump);
  const msg = formatCommitMessage(next, opts.message, opts.taskId);
  // Доставка агента (taskId) — push по умолчанию; явный push:false — только локально.
  const shouldPush = opts.push === true || (opts.push !== false && !!opts.taskId);
  const status = await stageBoardPaths();
  if (!status) {
    const sha = await getHeadSha();
    const shortSha = await getShortSha();
    let pushed = false;
    let pushError = null;
    if (shouldPush) {
      try {
        const link = await ensureRemote();
        const branch = link.branch || 'main';
        await runGit(ROOT, ['push', '-u', 'origin', `HEAD:${branch}`]);
        pushed = true;
      } catch (err) {
        pushError = err.message;
      }
    }
    return {
      message: pushed ? 'push ok' : pushError ? 'push failed' : 'Нет изменений',
      version: current,
      commit: await readHeadMessage(),
      sha,
      shortSha,
      bump,
      committed: false,
      pushed,
      ...(pushError ? { pushError } : {}),
    };
  }
  await runGit(ROOT, ['commit', '-m', msg]);
  const sha = await getHeadSha();
  const shortSha = await getShortSha();
  let pushed = false;
  let pushError = null;
  if (shouldPush) {
    try {
      const link = await ensureRemote();
      const branch = link.branch || 'main';
      await runGit(ROOT, ['push', '-u', 'origin', `HEAD:${branch}`]);
      pushed = true;
    } catch (err) {
      pushError = err.message;
    }
  }
  return {
    message: pushed ? 'commit+push ok' : pushError ? 'commit ok, push failed' : 'commit ok',
    version: next,
    commit: msg,
    sha,
    shortSha,
    bump,
    committed: true,
    pushed,
    ...(pushError ? { pushError } : {}),
  };
}

async function pushBoard(bodyMessage) {
  return commitBoard({ bump: 'patch', message: bodyMessage, push: true });
}

function parseRepoRef(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\/github\.com\//i, '');
  s = s.replace(/\.git$/i, '');
  s = s.replace(/\/+$/, '');
  const m = s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function linkBoard({ owner, repo, branch, repoFull, full_name }) {
  const parsed = parseRepoRef(repoFull || full_name) || parseRepoRef(owner && repo ? `${owner}/${repo}` : null);
  const o = parsed?.owner || (owner ? String(owner).trim() : '');
  const r = parsed?.repo || (repo ? String(repo).trim() : '');
  if (!o || !r) throw new Error('Нужны owner и repo (формат: owner/repo)');
  const link = { owner: o, repo: r, branch: branch || 'main' };
  writeBoardLink(link);
  return { ok: true, linked: link };
}

module.exports = {
  DEFAULT_VERSION,
  parseVersion,
  bumpPatch,
  bumpMinor,
  bumpMajor,
  bumpVersion,
  formatCommitMessage,
  getCurrentVersion,
  getHeadSha,
  getShortSha,
  getBoardStatus,
  ensureInitialCommit,
  commitBoard,
  pullBoard,
  pushBoard,
  linkBoard,
  parseRepoRef,
  readBoardLink,
};
