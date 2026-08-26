// Remote tech support (Quick Assist–style): helper generates code, client authorizes SSH.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SUPPORT_DIR = path.join(ROOT, '.support');
const SESSION_TTL_MS = 30 * 60 * 1000;
const SSH_PORT = 8022;

let clientSession = null;
let helperSessions = new Map();
let clientTimer = null;
let helperTimers = new Map();

function runShell(script, timeout = 25000) {
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

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizeCode(raw) {
  return String(raw || '').replace(/\D/g, '').slice(0, 6);
}

function clearClientTimer() {
  if (clientTimer) {
    clearTimeout(clientTimer);
    clientTimer = null;
  }
}

function scheduleClientExpiry() {
  clearClientTimer();
  if (!clientSession) return;
  const left = clientSession.expiresAt - Date.now();
  if (left <= 0) {
    stopClientSession('expired');
    return;
  }
  clientTimer = setTimeout(() => stopClientSession('expired'), left);
}

function clearHelperTimer(code) {
  const t = helperTimers.get(code);
  if (t) {
    clearTimeout(t);
    helperTimers.delete(code);
  }
}

function scheduleHelperExpiry(code) {
  clearHelperTimer(code);
  const sess = helperSessions.get(code);
  if (!sess) return;
  const left = sess.expiresAt - Date.now();
  if (left <= 0) {
    helperSessions.delete(code);
    return;
  }
  helperTimers.set(code, setTimeout(() => {
    helperSessions.delete(code);
    helperTimers.delete(code);
  }, left));
}

async function tailFile(filePath, lines = 40) {
  if (!fs.existsSync(filePath)) return '';
  return runShell(`tail -n ${lines} '${filePath.replace(/'/g, "'\\''")}' 2>/dev/null || true`);
}

function portListening(port) {
  return runShell(
    `if (ss -tln 2>/dev/null || netstat -tln 2>/dev/null || true) | grep -q ':${port}'; then echo yes; elif timeout 1 bash -c 'echo >/dev/tcp/127.0.0.1/${port}' 2>/dev/null; then echo yes; else echo no; fi`,
  );
}

async function collectDiagnostics(getStackStatus) {
  const stack = typeof getStackStatus === 'function' ? await getStackStatus() : null;
  const [nodeVer, uname, ips, sshInstalled, sshListen, boardVer] = await Promise.all([
    runShell('node --version 2>/dev/null || echo unknown'),
    runShell('uname -a 2>/dev/null || true'),
    runShell([
      `ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1`,
      `ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}'`,
      `ifconfig 2>/dev/null | awk '/inet / && $2!="127.0.0.1"{print $2}' | sed 's/addr://'`,
      `getprop dhcp.wlan0.ipaddress 2>/dev/null`,
    ].join('; ')),
    runShell('command -v sshd >/dev/null && echo yes || echo no'),
    portListening(SSH_PORT),
    runShell(`cat '${path.join(ROOT, 'package.json').replace(/'/g, "'\\''")}' 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{console.log(JSON.parse(s).version||'')}catch{}})"`),
  ]);

  const ttLog = await tailFile(path.join(ROOT, 'cursor-agent/task-tracker/logs/http.log'));
  const workerLog = await tailFile(path.join(ROOT, 'cursor-agent/tt-agent-worker.log'));
  const webLog = await tailFile(path.join(ROOT, 'server.log'));

  const ipList = [...new Set(ips.stdout.split(/\s+/).filter(Boolean))];

  return {
    at: new Date().toISOString(),
    hostname: os.hostname(),
    platform: os.platform(),
    user: process.env.USER || process.env.LOGNAME || null,
    node: nodeVer.stdout.split('\n')[0] || null,
    uname: uname.stdout || null,
    boardVersion: boardVer.stdout || null,
    stack,
    ssh: {
      installed: sshInstalled.stdout.includes('yes'),
      listening: sshListen.stdout.trim() === 'yes',
      port: SSH_PORT,
    },
    addresses: ipList,
    logs: {
      tt: ttLog.stdout,
      worker: workerLog.stdout,
      web: webLog.stdout,
    },
    mem: { freeMb: Math.round(os.freemem() / 1024 / 1024), totalMb: Math.round(os.totalmem() / 1024 / 1024) },
  };
}

function saveDiagnostics(report) {
  fs.mkdirSync(SUPPORT_DIR, { recursive: true });
  const name = `diagnostics-${Date.now()}.json`;
  const filePath = path.join(SUPPORT_DIR, name);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return { file: name, path: filePath };
}

async function ensureSshReady() {
  const steps = [];
  let install = await runShell('command -v sshd >/dev/null 2>&1 && echo ok || echo missing');
  if (install.stdout !== 'ok') {
    install = await runShell('pkg install -y openssh 2>&1 || apt-get install -y openssh-server 2>&1 || true');
    steps.push({ step: 'install_openssh', ok: install.ok, detail: (install.stdout || install.stderr).slice(0, 500) });
  }
  const keys = await runShell('test -f "$PREFIX/etc/ssh/ssh_host_rsa_key" && echo ok || echo missing');
  if (keys.stdout !== 'ok') {
    const gen = await runShell('ssh-keygen -A 2>&1 || true');
    steps.push({ step: 'ssh_host_keys', ok: /generating|already exists|done/i.test(gen.stdout + gen.stderr), detail: (gen.stdout || gen.stderr).slice(0, 300) });
  }
  let listen = await portListening(SSH_PORT);
  if (listen.stdout.trim() !== 'yes') {
    const start = await runShell('sshd 2>&1 || /data/data/com.termux/files/usr/bin/sshd 2>&1 || true');
    steps.push({ step: 'start_sshd', ok: start.ok, detail: (start.stdout || start.stderr).slice(0, 300) });
    await runShell('sleep 1');
    listen = await portListening(SSH_PORT);
  }
  const user = await runShell('whoami');
  return {
    ok: listen.stdout.trim() === 'yes',
    user: user.stdout || 'user',
    port: SSH_PORT,
    steps,
  };
}

async function setTempPassword(user, password) {
  const safeUser = String(user).replace(/[^a-zA-Z0-9_-]/g, '');
  const safePass = String(password).replace(/'/g, "'\\''");
  const script = [
    `if command -v chpasswd >/dev/null 2>&1; then`,
    `  printf '%s:%s\\n' '${safeUser}' '${safePass}' | chpasswd 2>&1`,
    `else`,
    `  (printf '%s\\n%s\\n' '${safePass}' '${safePass}') | passwd '${safeUser}' 2>&1`,
    `fi`,
  ].join('\n');
  return runShell(script);
}

async function startClientMode(getStackStatus, repairTT) {
  stopClientSession('replaced');
  let diagnostics = await collectDiagnostics(getStackStatus);
  if (!diagnostics.stack?.tt?.ok && typeof repairTT === 'function') {
    const repair = await repairTT({ force: true });
    diagnostics = await collectDiagnostics(getStackStatus);
    diagnostics.ttRepair = {
      ok: !!repair.ok,
      detail: repair.error || repair.stdout || null,
      probe: repair.probe || null,
      logTail: repair.logTail || null,
    };
  }
  const saved = saveDiagnostics(diagnostics);
  const sshPrep = await ensureSshReady();

  clientSession = {
    mode: 'client',
    phase: 'awaiting_code',
    startedAt: new Date().toISOString(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    diagnostics,
    diagnosticsFile: saved.file,
    sshPrep,
  };
  scheduleClientExpiry();

  return {
    ok: true,
    phase: clientSession.phase,
    expiresAt: clientSession.expiresAt,
    diagnostics: summarizeDiagnostics(diagnostics),
    diagnosticsFile: saved.file,
    sshPrep,
  };
}

function summarizeDiagnostics(d) {
  const issues = [];
  if (!d.stack?.tt?.ok) issues.push('Task Tracker (:3100) не отвечает');
  if (!d.stack?.worker?.running) issues.push('tt-agent-worker не запущен');
  if (!d.ssh?.installed) issues.push('openssh не установлен');
  if (!d.ssh?.listening) issues.push(`sshd не слушает порт ${SSH_PORT}`);
  if (d.ttRepair && !d.ttRepair.ok) {
    const hint = d.ttRepair.probe || d.ttRepair.detail || d.ttRepair.logTail;
    if (hint) issues.push(`TT repair: ${String(hint).slice(0, 200)}`);
  }
  const ttLogTail = d.logs?.tt ? String(d.logs.tt).trim().split('\n').slice(-3).join(' | ') : '';
  return {
    at: d.at,
    boardVersion: d.boardVersion,
    node: d.node,
    stack: d.stack,
    ssh: d.ssh,
    addresses: d.addresses,
    issues,
    mem: d.mem,
    ttRepair: d.ttRepair || null,
    ttLogTail: ttLogTail || null,
  };
}

async function authorizeClient(code, getStackStatus, repairTT) {
  const normalized = normalizeCode(code);
  if (normalized.length !== 6) {
    return { ok: false, error: 'Код должен состоять из 6 цифр' };
  }
  if (!clientSession || clientSession.phase === 'stopped') {
    const started = await startClientMode(getStackStatus, repairTT);
    if (!started.ok) return started;
  }

  const sshPrep = await ensureSshReady();
  if (!sshPrep.ok) {
    return { ok: false, error: 'Не удалось запустить sshd на порту ' + SSH_PORT, sshPrep };
  }

  const passResult = await setTempPassword(sshPrep.user, normalized);
  if (!passResult.ok && !/updated successfully|password updated|all authentication tokens updated/i.test(passResult.stdout + passResult.stderr)) {
    return {
      ok: false,
      error: 'Не удалось установить временный пароль SSH. Задайте пароль вручную: passwd',
      detail: (passResult.stdout || passResult.stderr).slice(0, 400),
    };
  }

  const diagnostics = clientSession?.diagnostics || await collectDiagnostics(getStackStatus);
  clientSession = {
    mode: 'client',
    phase: 'authorized',
    code: normalized,
    startedAt: clientSession?.startedAt || new Date().toISOString(),
    authorizedAt: new Date().toISOString(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    diagnostics,
    diagnosticsFile: clientSession?.diagnosticsFile,
    ssh: {
      user: sshPrep.user,
      port: SSH_PORT,
      addresses: diagnostics.addresses || [],
    },
  };
  scheduleClientExpiry();

  return {
    ok: true,
    phase: 'authorized',
    expiresAt: clientSession.expiresAt,
    ssh: clientSession.ssh,
    diagnostics: summarizeDiagnostics(diagnostics),
    diagnosticsFile: clientSession.diagnosticsFile,
    message: 'SSH готов. Сообщите IP адрес помощнику — пароль = код, который он продиктовал.',
  };
}

function stopClientSession(reason = 'stopped') {
  clearClientTimer();
  const prev = clientSession;
  clientSession = prev ? { ...prev, phase: 'stopped', stoppedAt: new Date().toISOString(), stopReason: reason } : null;
  setTimeout(() => {
    if (clientSession?.phase === 'stopped') clientSession = null;
  }, 5000);
  return { ok: true, reason, stoppedAt: new Date().toISOString() };
}

function getClientStatus() {
  if (!clientSession) return { active: false };
  return {
    active: clientSession.phase !== 'stopped',
    phase: clientSession.phase,
    expiresAt: clientSession.expiresAt,
    expiresInSec: Math.max(0, Math.round((clientSession.expiresAt - Date.now()) / 1000)),
    ssh: clientSession.ssh || null,
    diagnosticsFile: clientSession.diagnosticsFile || null,
    diagnostics: clientSession.diagnostics ? summarizeDiagnostics(clientSession.diagnostics) : null,
  };
}

function startHelperSession() {
  let code = generateCode();
  while (helperSessions.has(code)) code = generateCode();

  const sess = {
    code,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  helperSessions.set(code, sess);
  scheduleHelperExpiry(code);

  return {
    ok: true,
    code,
    expiresAt: sess.expiresAt,
    expiresInSec: Math.round(SESSION_TTL_MS / 1000),
    instructions: [
      'Продиктуйте код человеку на удалённом устройстве.',
      'На его телефоне: Проекты → Система заявок → Техподдержка → ввести код.',
      'После подтверждения подключайтесь по SSH (пароль = этот код).',
    ],
  };
}

function getHelperSession(code) {
  const normalized = normalizeCode(code);
  const sess = helperSessions.get(normalized);
  if (!sess) return { ok: false, error: 'Код не найден или истёк' };
  return {
    ok: true,
    code: normalized,
    expiresAt: sess.expiresAt,
    expiresInSec: Math.max(0, Math.round((sess.expiresAt - Date.now()) / 1000)),
    sshTemplate: `ssh -p ${SSH_PORT} USER@CLIENT_IP`,
    note: 'USER и CLIENT_IP сообщит клиент после ввода кода',
  };
}

function buildSshCommand(user, host, code) {
  const u = String(user || 'user').replace(/"/g, '');
  const h = String(host || 'CLIENT_IP').replace(/"/g, '');
  return {
    command: `ssh -p ${SSH_PORT} ${u}@${h}`,
    password: code,
    hint: 'При первом подключении подтвердите fingerprint. Пароль = 6-значный код.',
  };
}

async function rerunDiagnostics(getStackStatus, repairTT) {
  let diagnostics = await collectDiagnostics(getStackStatus);
  if (!diagnostics.stack?.tt?.ok && typeof repairTT === 'function') {
    const repair = await repairTT({ force: true });
    diagnostics = await collectDiagnostics(getStackStatus);
    diagnostics.ttRepair = {
      ok: !!repair.ok,
      detail: repair.error || repair.stdout || null,
      probe: repair.probe || null,
      logTail: repair.logTail || null,
    };
  }
  const saved = saveDiagnostics(diagnostics);
  if (clientSession && clientSession.phase !== 'stopped') {
    clientSession.diagnostics = diagnostics;
    clientSession.diagnosticsFile = saved.file;
  }
  return { ok: true, diagnostics: summarizeDiagnostics(diagnostics), diagnosticsFile: saved.file };
}

module.exports = {
  startClientMode,
  authorizeClient,
  stopClientSession,
  getClientStatus,
  startHelperSession,
  getHelperSession,
  buildSshCommand,
  rerunDiagnostics,
  collectDiagnostics,
};
