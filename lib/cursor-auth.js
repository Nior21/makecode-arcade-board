// Локальное хранение Cursor API key (не попадает в git).
const fs = require('fs');
const path = require('path');

const AUTH_FILE = path.join(__dirname, '..', '.cursor-auth.json');
const WORKER_ENV = process.env.CURSOR_WORKER_ENV
  || '/storage/emulated/0/Projects/cursor-agent/tt-agent-worker/.env';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function maskKey(key) {
  const s = String(key || '');
  if (s.length <= 8) return s ? '••••' : '';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function getCursorKey() {
  if (process.env.CURSOR_API_KEY) return process.env.CURSOR_API_KEY.trim();
  const auth = readJson(AUTH_FILE, null);
  return auth?.apiKey?.trim() || '';
}

function getCursorStatus() {
  const envKey = !!process.env.CURSOR_API_KEY;
  const auth = readJson(AUTH_FILE, null);
  const key = getCursorKey();
  return {
    configured: !!key,
    masked: maskKey(key),
    source: envKey ? 'env' : (auth?.apiKey ? 'file' : null),
    workerEnv: WORKER_ENV,
    saved_at: auth?.saved_at || null,
  };
}

function upsertEnvVar(filePath, key, value) {
  let lines = [];
  if (fs.existsSync(filePath)) {
    lines = fs.readFileSync(filePath, 'utf8').split('\n');
  }
  const prefix = `${key}=`;
  let found = false;
  const out = lines.map((line) => {
    if (line.startsWith(prefix)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) out.push(`${key}=${value}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, out.filter((l, i, a) => !(i === a.length - 1 && l === '')).join('\n') + '\n', { mode: 0o600 });
}

function saveCursorKey(apiKey) {
  const trimmed = String(apiKey || '').trim();
  if (!trimmed) throw new Error('Введите Cursor API key');
  if (!/^crsr_/i.test(trimmed) && trimmed.length < 16) {
    throw new Error('Ключ не похож на Cursor API key (ожидается crsr_…)');
  }
  fs.writeFileSync(AUTH_FILE, JSON.stringify({
    apiKey: trimmed,
    saved_at: new Date().toISOString(),
  }, null, 2) + '\n', { mode: 0o600 });
  try {
    upsertEnvVar(WORKER_ENV, 'CURSOR_API_KEY', trimmed);
  } catch (err) {
    throw new Error(`Ключ сохранён локально, но не записан в worker .env: ${err.message}`);
  }
  return { ok: true, masked: maskKey(trimmed) };
}

function clearCursorKey() {
  try { fs.unlinkSync(AUTH_FILE); } catch (_) {}
  if (fs.existsSync(WORKER_ENV)) {
    const lines = fs.readFileSync(WORKER_ENV, 'utf8').split('\n').filter((l) => !l.startsWith('CURSOR_API_KEY='));
    fs.writeFileSync(WORKER_ENV, lines.join('\n').replace(/\n+$/, '') + '\n', { mode: 0o600 });
  }
  return { ok: true };
}

module.exports = {
  getCursorStatus,
  saveCursorKey,
  clearCursorKey,
};
