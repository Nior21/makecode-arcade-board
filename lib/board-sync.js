// Git sync for «Система заявок» shell (public/, server, scripts — без games/ и секретов).
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

async function getBoardStatus() {
  const linked = readBoardLink();
  const version = await getCurrentVersion();
  let dirty = false;
  try {
    dirty = await gitDirty();
  } catch (_) {}
  return {
    slug: 'makecode-arcade',
    name: 'Система заявок',
    version,
    isGit: isGitRepo(),
    dirty,
    linked: linked ? { owner: linked.owner, repo: linked.repo, branch: linked.branch || 'main' } : null,
  };
}

async function ensureRemote() {
  const link = readBoardLink();
  if (!link?.owner || !link?.repo) {
    throw new Error('Репозиторий не привязан — укажите owner/repo в .board-github.json или через API /api/board/link');
  }
  const token = gh.getToken();
  if (!token) throw new Error('GitHub не авторизован');
  const remoteUrl = `https://x-access-token:${token}@github.com/${link.owner}/${link.repo}.git`;
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
  const branch = link.branch || 'main';
  await runGit(ROOT, ['fetch', 'origin', branch]);
  await runGit(ROOT, ['checkout', branch]).catch(async () => {
    await runGit(ROOT, ['checkout', '-B', branch]);
  });
  await runGit(ROOT, ['pull', '--ff-only', 'origin', branch]);
  return { message: 'pull ok', version: await getCurrentVersion() };
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
  const status = await stageBoardPaths();
  if (!status) {
    const sha = await getHeadSha();
    const shortSha = await getShortSha();
    let pushed = false;
    let pushError = null;
    if (opts.push) {
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
  if (opts.push) {
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
