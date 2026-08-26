#!/usr/bin/env node
/**
 * rpc.js — универсальный RPC-клиент для task-tracker MCP сервера.
 *
 * Решает проблемы:
 *   - кавычки в cmd.exe / PowerShell / bash / Termux
 *   - кодировка UTF-8 (всегда пишет/читает UTF-8 без BOM)
 *   - временные файлы (автоочистка)
 *   - session management (авто initialize + reuse)
 *   - определение платформы и среды запуска
 *
 * Использование:
 *   node scripts/rpc.js tools/list
 *   node scripts/rpc.js tools/call create_task '{"title":"Hello"}'
 *   node scripts/rpc.js --raw tools/list
 *   node scripts/rpc.js --session=SID tools/list
 *   node scripts/rpc.js --new-session tools/list
 *   node scripts/rpc.js --host=192.168.88.153:3100 tools/list
 *   node scripts/rpc.js --debug tools/list
 *
 * Переменные окружения:
 *   TT_HOST — хост:порт (по умолч. 192.168.88.153:3100)
 *   TT_SESSION — ID сессии (если не указан --session)
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { env } from 'process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', '.rpc-cache');
const SESSION_FILE = join(CACHE_DIR, 'session.txt');

// ═══════════════════════════════════════════════════════════════════
//  Платформа и среда запуска
// ═══════════════════════════════════════════════════════════════════

/**
 * Определяет ОС: 'win32' | 'linux' | 'android'
 *
 * Android определяется по наличию /data/data/ в пути (характерно для Termux).
 * Если Node.js не даёт process.platform === 'android', проверяем через
 * существование каталога.
 */
function detectOS() {
  const p = process.platform;
  if (p === 'win32') return 'win32';
  if (p === 'linux') {
    // Termux на Android
    try {
      execSync('uname -o', { encoding: 'utf8', timeout: 2000 })
        .trim()
        .toLowerCase()
        .includes('android');
      return 'android';
    } catch {
      // RPi / обычный Linux
      return 'linux';
    }
  }
  return p; // fallback
}

/**
 * Определяет среду (shell), в которой запущен скрипт:
 *   'cmd'        — cmd.exe (Windows)
 *   'powershell' — PowerShell / pwsh (Windows)
 *   'bash'       — bash (Linux, macOS, Termux)
 *   'sh'         — sh / dash (Linux)
 *   'unknown'    — не удалось определить
 */
function detectShell() {
  // PowerShell устанавливает $env:SHELL редко, но есть $env:PSModulePath
  if (process.platform === 'win32') {
    if (env.PSModulePath) {
      // PowerShell или pwsh
      return 'powershell';
    }
    // cmd.exe — нет PSModulePath, SHELL обычно не задан
    return 'cmd';
  }

  // Linux / macOS / Termux
  const shell = (env.SHELL || '').toLowerCase();
  if (shell.includes('bash')) return 'bash';
  if (shell.includes('zsh')) return 'zsh';
  if (shell.includes('sh')) return 'sh';
  if (shell.includes('fish')) return 'fish';

  // Termux без SHELL
  try {
    const sh = execSync('echo $0', { encoding: 'utf8', timeout: 1000 }).trim();
    if (sh.includes('bash')) return 'bash';
    if (sh.includes('sh')) return 'sh';
  } catch {}

  return 'unknown';
}

/**
 * Возвращает имя curl-команды для текущей среды.
 * В PowerShell `curl` — алиас на Invoke-WebRequest, нужен `curl.exe`.
 */
function curlCmd() {
  if (process.platform === 'win32' && detectShell() === 'powershell') {
    return 'curl.exe';
  }
  return 'curl';
}

const PLATFORM = detectOS();
const SHELL = detectShell();
const CURL = curlCmd();

// ═══════════════════════════════════════════════════════════════════
//  Парсинг аргументов
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_HOST = '192.168.88.153:3100';

const args = process.argv.slice(2);
let host = env.TT_HOST || DEFAULT_HOST;
let sessionId = env.TT_SESSION || null;
let forceNewSession = false;
let rawOutput = false;
let debugMode = false;
let positional = [];

for (const arg of args) {
  if (arg === '--raw') { rawOutput = true; continue; }
  if (arg === '--new-session') { forceNewSession = true; continue; }
  if (arg === '--debug') { debugMode = true; continue; }
  if (arg.startsWith('--session=')) { sessionId = arg.slice('--session='.length); continue; }
  if (arg.startsWith('--host=')) { host = arg.slice('--host='.length); continue; }
  positional.push(arg);
}

if (positional.length === 0) {
  console.error('Usage: node scripts/rpc.js [options] <method> [toolName] [jsonArgs]');
  console.error('  node scripts/rpc.js tools/list');
  console.error('  node scripts/rpc.js tools/call create_task \'{"title":"Hello"}\'');
  console.error('  node scripts/rpc.js --raw tools/list');
  console.error('  node scripts/rpc.js --new-session tools/list');
  console.error('  node scripts/rpc.js --session=UUID tools/list');
  console.error('  node scripts/rpc.js --host=192.168.88.153:3100 tools/list');
  console.error('  node scripts/rpc.js --debug tools/list');
  process.exit(1);
}

const method = positional[0];
const toolName = positional[1] || null;
let jsonArgs = positional[2] || '{}';

// Поддержка @file — чтение JSON из файла
if (jsonArgs.startsWith('@')) {
  const filePath = jsonArgs.slice(1);
  jsonArgs = readFileSync(filePath, 'utf8').trim();
}

// ═══════════════════════════════════════════════════════════════════
//  Debug-вывод
// ═══════════════════════════════════════════════════════════════════

function debug(...msgs) {
  if (debugMode) console.error('[rpc:debug]', ...msgs);
}

if (debugMode) {
  debug('Platform:', PLATFORM);
  debug('Shell:', SHELL);
  debug('Curl command:', CURL);
  debug('Host:', host);
  debug('Session ID:', sessionId || '(not set)');
  debug('Method:', method);
  debug('Tool:', toolName || '(none)');
  debug('Args:', jsonArgs);
}

// ═══════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════

function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function tmpFile(suffix) {
  ensureCacheDir();
  return join(CACHE_DIR, `_${suffix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
}

function loadCachedSession() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    return readFileSync(SESSION_FILE, 'utf8').trim();
  } catch { return null; }
}

function saveCachedSession(sid) {
  ensureCacheDir();
  writeFileSync(SESSION_FILE, sid, 'utf8');
}

function rpc(body) {
  const bodyFile = tmpFile('body');
  writeFileSync(bodyFile, JSON.stringify(body), 'utf8');
  debug('Request body file:', bodyFile);

  try {
    let cmd = `${CURL} -s -X POST http://${host}/mcp -H "Content-Type: application/json" -H "Accept: application/json"`;
    if (sessionId) cmd += ` -H "Mcp-Session-Id: ${sessionId}"`;
    cmd += ` -d @${bodyFile}`;
    debug('Curl command:', cmd);
    const out = execSync(cmd, { encoding: 'utf8', timeout: 15000, shell: process.platform === 'win32' ? 'cmd.exe' : true });
    debug('Response:', out.slice(0, 200));
    return JSON.parse(out);
  } finally {
    try { unlinkSync(bodyFile); } catch (_) {}
  }
}

function getSession() {
  if (sessionId) return sessionId;

  if (!forceNewSession) {
    const cached = loadCachedSession();
    if (cached) {
      debug('Cached session:', cached);
      // Проверяем, жива ли ещё сессия — делаем ping
      try {
        const res = rpc({ jsonrpc: '2.0', id: 0, method: 'ping', params: {} });
        if (res && !res.error) {
          sessionId = cached;
          return sessionId;
        }
      } catch (_) {}
      debug('Cached session dead, creating new one');
      // Сессия мертва — удаляем кэш и создаём новую
      try { unlinkSync(SESSION_FILE); } catch (_) {}
    }
  }

  const initFile = tmpFile('init');
  const initBody = {
    jsonrpc: '2.0', id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'rpc-client', version: '1.0' }
    }
  };
  writeFileSync(initFile, JSON.stringify(initBody), 'utf8');
  debug('Init file:', initFile);

  try {
    const raw = execSync(
      `${CURL} -s -X POST http://${host}/mcp -H "Content-Type: application/json" -H "Accept: application/json" -d @${initFile} -D -`,
      { encoding: 'utf8', timeout: 10000, shell: process.platform === 'win32' ? 'cmd.exe' : true }
    );
    const m = raw.match(/Mcp-Session-Id:\s*(\S+)/i);
    if (!m) throw new Error('No Mcp-Session-Id in response');
    sessionId = m[1];
    debug('New session:', sessionId);
    saveCachedSession(sessionId);
    return sessionId;
  } finally {
    try { unlinkSync(initFile); } catch (_) {}
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Build request
// ═══════════════════════════════════════════════════════════════════

function buildRequest() {
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
  }

  if (method === 'tools/call') {
    if (!toolName) throw new Error('tools/call requires tool name as 2nd argument');
    let args;
    try { args = JSON.parse(jsonArgs); } catch { args = {}; }
    return { jsonrpc: '2.0', id: Math.floor(Math.random() * 100000), method: 'tools/call', params: { name: toolName, arguments: args } };
  }

  // Прямой JSON-RPC (для initialize, ping и т.д.)
  try { return JSON.parse(method); } catch {}
  throw new Error(`Unknown method: ${method}. Use tools/list, tools/call, or raw JSON-RPC.`);
}

// ═══════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════

function main() {
  const req = buildRequest();

  // Для initialize не нужна сессия
  if (req.method === 'initialize') {
    const res = rpc(req);
    if (rawOutput) {
      console.log(JSON.stringify(res));
    } else {
      console.log(JSON.stringify(res, null, 2));
    }
    return;
  }

  // Для остальных — получаем сессию
  getSession();
  const res = rpc(req);

  if (rawOutput) {
    console.log(JSON.stringify(res));
    return;
  }

  // Красивый вывод
  if (res.error) {
    console.error(`Error [${res.error.code}]: ${res.error.message}`);
    process.exit(1);
  }

  if (res.result?.content?.[0]?.text) {
    // tools/call — парсим вложенный JSON
    try {
      const inner = JSON.parse(res.result.content[0].text);
      console.log(JSON.stringify(inner, null, 2));
    } catch {
      console.log(res.result.content[0].text);
    }
  } else if (res.result?.tools) {
    // tools/list
    console.log(`Tools (${res.result.tools.length}):`);
    for (const t of res.result.tools) {
      console.log(`  ${t.name} — ${t.description}`);
    }
  } else {
    console.log(JSON.stringify(res.result || res, null, 2));
  }
}

try {
  main();
} catch (e) {
  console.error(`Fatal: ${e.message}`);
  if (debugMode) console.error('[rpc:debug] Stack:', e.stack);
  process.exit(1);
}
