// Remote support UI — Quick Assist style (helper dictates code → client authorizes SSH).
const MC_SUPPORT = {
  clientPoll: null,
  helperCode: null,
  helperExpiresAt: null,
};

function mcSupportApi(path, opts = {}) {
  return fetch(path, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    ...opts,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || data.message || `HTTP ${r.status}`);
    return data;
  });
}

function mcSupportEsc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mcSupportFmtSec(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m} мин ${s} с` : `${s} с`;
}

function mcSupportSetError(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text || '';
}

function mcSupportIssuesHtml(issues) {
  if (!issues?.length) return '<p class="mc-gh-hint" style="color:#86efac">Критичных проблем не найдено.</p>';
  return `<ul class="mc-support-issues">${issues.map((i) => `<li>${mcSupportEsc(i)}</li>`).join('')}</ul>`;
}

function mcSupportRenderDiagnostics(box, diag) {
  if (!box || !diag) return;
  const addrs = (diag.addresses || []).length
    ? diag.addresses.map((a) => `<code>${mcSupportEsc(a)}</code>`).join(', ')
    : 'не определены (нужен Wi‑Fi или Tailscale)';
  box.innerHTML = `
    <div class="mc-gh-status-line">Версия: ${mcSupportEsc(diag.boardVersion || '—')} · Node ${mcSupportEsc(diag.node || '—')}</div>
    <p class="mc-gh-hint">TT: ${diag.stack?.tt?.ok ? '✓' : '✗'} · Worker: ${diag.stack?.worker?.running ? '✓' : '✗'} · SSH: ${diag.ssh?.listening ? '✓' : '✗'}</p>
    ${mcSupportIssuesHtml(diag.issues)}
    <p class="mc-gh-hint">IP: ${addrs}</p>`;
}

function mcSupportStopClientPoll() {
  if (MC_SUPPORT.clientPoll) {
    clearInterval(MC_SUPPORT.clientPoll);
    MC_SUPPORT.clientPoll = null;
  }
}

async function mcSupportRefreshClientStatus() {
  try {
    const st = await mcSupportApi('/api/support/client/status');
    const statusEl = document.getElementById('mc-support-client-status');
    const authBlock = document.getElementById('mc-support-client-auth');
    const activeBlock = document.getElementById('mc-support-client-active');
    if (!st.active) {
      if (statusEl) statusEl.textContent = 'Сессия не активна';
      authBlock?.removeAttribute('hidden');
      activeBlock?.setAttribute('hidden', '');
      mcSupportStopClientPoll();
      return;
    }
    if (st.phase === 'authorized' && st.ssh) {
      authBlock?.setAttribute('hidden', '');
      activeBlock?.removeAttribute('hidden');
      const addrs = (st.ssh.addresses || []).join(', ') || '—';
      if (statusEl) {
        statusEl.innerHTML = `Ожидаем подключение · осталось ${mcSupportFmtSec(st.expiresInSec)}<br>
          <code>ssh -p ${st.ssh.port} ${mcSupportEsc(st.ssh.user)}@IP</code> · пароль = код`;
      }
      const activeEl = document.getElementById('mc-support-client-active-info');
      if (activeEl) {
        activeEl.innerHTML = `<p class="mc-gh-hint">Логин: <strong>${mcSupportEsc(st.ssh.user)}</strong> · порт: <strong>${st.ssh.port}</strong></p>
          <p class="mc-gh-hint">IP для помощника: ${(st.ssh.addresses || []).map((a) => `<code>${mcSupportEsc(a)}</code>`).join(', ') || 'не определён'}</p>
          <p class="mc-gh-hint">Диагностика: <code>.support/${mcSupportEsc(st.diagnosticsFile || '')}</code></p>`;
      }
    } else {
      authBlock?.removeAttribute('hidden');
      activeBlock?.setAttribute('hidden', '');
      if (statusEl) statusEl.textContent = `Диагностика готова · введите код · ${mcSupportFmtSec(st.expiresInSec)}`;
      mcSupportRenderDiagnostics(document.getElementById('mc-support-client-diag'), st.diagnostics);
    }
  } catch (_) {}
}

async function mcSupportStartClient() {
  mcSupportSetError('mc-support-client-error', '');
  const btn = document.getElementById('mc-support-client-start');
  if (btn) btn.disabled = true;
  try {
    const r = await mcSupportApi('/api/support/client/start', { method: 'POST', body: '{}' });
    document.getElementById('mc-support-client-panel')?.removeAttribute('hidden');
    mcSupportRenderDiagnostics(document.getElementById('mc-support-client-diag'), r.diagnostics);
    const statusEl = document.getElementById('mc-support-client-status');
    if (statusEl) statusEl.textContent = 'Введите 6-значный код от помощника';
    mcSupportStopClientPoll();
    MC_SUPPORT.clientPoll = setInterval(mcSupportRefreshClientStatus, 3000);
    if (typeof mcNotify === 'function') mcNotify('Диагностика выполнена — ждём код');
  } catch (err) {
    mcSupportSetError('mc-support-client-error', err.message);
    if (typeof mcNotify === 'function') mcNotify('⚠️ ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function mcSupportAuthorizeClient() {
  const input = document.getElementById('mc-support-client-code');
  const code = input?.value?.trim();
  mcSupportSetError('mc-support-client-error', '');
  if (!code || code.replace(/\D/g, '').length !== 6) {
    mcSupportSetError('mc-support-client-error', 'Введите 6 цифр');
    return;
  }
  const btn = document.getElementById('mc-support-client-submit');
  if (btn) btn.disabled = true;
  try {
    const r = await mcSupportApi('/api/support/client/authorize', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    if (input) input.value = '';
    await mcSupportRefreshClientStatus();
    if (typeof mcNotify === 'function') mcNotify('✓ SSH готов — сообщите IP помощнику');
    return r;
  } catch (err) {
    mcSupportSetError('mc-support-client-error', err.message);
    if (typeof mcNotify === 'function') mcNotify('⚠️ ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function mcSupportStopClient() {
  try {
    await mcSupportApi('/api/support/client/stop', { method: 'POST', body: '{}' });
    mcSupportStopClientPoll();
    document.getElementById('mc-support-client-panel')?.setAttribute('hidden', '');
    if (typeof mcNotify === 'function') mcNotify('Сессия техподдержки завершена');
  } catch (err) {
    if (typeof mcNotify === 'function') mcNotify('⚠️ ' + err.message);
  }
}

async function mcSupportRerunDiag() {
  try {
    const r = await mcSupportApi('/api/support/client/diagnostics', { method: 'POST', body: '{}' });
    mcSupportRenderDiagnostics(document.getElementById('mc-support-client-diag'), r.diagnostics);
    if (typeof mcNotify === 'function') mcNotify('Диагностика обновлена');
  } catch (err) {
    if (typeof mcNotify === 'function') mcNotify('⚠️ ' + err.message);
  }
}

async function mcSupportStartHelper() {
  mcSupportSetError('mc-support-helper-error', '');
  const btn = document.getElementById('mc-support-helper-start');
  if (btn) btn.disabled = true;
  try {
    const r = await mcSupportApi('/api/support/helper/start', { method: 'POST', body: '{}' });
    MC_SUPPORT.helperCode = r.code;
    MC_SUPPORT.helperExpiresAt = r.expiresAt;
    document.getElementById('mc-support-helper-panel')?.removeAttribute('hidden');
    const codeEl = document.getElementById('mc-support-helper-code');
    if (codeEl) {
      codeEl.textContent = r.code;
      codeEl.dataset.code = r.code;
    }
    const hint = document.getElementById('mc-support-helper-hint');
    if (hint) {
      hint.innerHTML = (r.instructions || []).map((line) => `<p class="mc-gh-hint">${mcSupportEsc(line)}</p>`).join('');
    }
    if (typeof mcNotify === 'function') mcNotify(`Код: ${r.code} — продиктуйте клиенту`);
  } catch (err) {
    mcSupportSetError('mc-support-helper-error', err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function mcSupportBuildSsh() {
  const code = MC_SUPPORT.helperCode || document.getElementById('mc-support-helper-code')?.dataset.code;
  const host = document.getElementById('mc-support-helper-host')?.value?.trim();
  const user = document.getElementById('mc-support-helper-user')?.value?.trim() || 'u0_a123';
  mcSupportSetError('mc-support-helper-error', '');
  if (!code) {
    mcSupportSetError('mc-support-helper-error', 'Сначала нажмите «Помочь»');
    return;
  }
  if (!host) {
    mcSupportSetError('mc-support-helper-error', 'Введите IP клиента');
    return;
  }
  try {
    const r = await mcSupportApi('/api/support/helper/connect', {
      method: 'POST',
      body: JSON.stringify({ code, host, user }),
    });
    const out = document.getElementById('mc-support-helper-cmd');
    if (out) {
      out.innerHTML = `<p class="mc-gh-hint">Команда (скопируйте в Termux/ПК):</p>
        <div class="mc-support-code-box"><code>${mcSupportEsc(r.ssh.command)}</code></div>
        <p class="mc-gh-hint">Пароль при подключении: <strong>${mcSupportEsc(r.ssh.password)}</strong></p>
        <p class="mc-gh-hint">${mcSupportEsc(r.ssh.hint)}</p>`;
    }
  } catch (err) {
    mcSupportSetError('mc-support-helper-error', err.message);
  }
}

function mcSupportInit() {
  document.getElementById('mc-support-client-start')?.addEventListener('click', mcSupportStartClient);
  document.getElementById('mc-support-client-submit')?.addEventListener('click', mcSupportAuthorizeClient);
  document.getElementById('mc-support-client-stop')?.addEventListener('click', mcSupportStopClient);
  document.getElementById('mc-support-client-rediag')?.addEventListener('click', mcSupportRerunDiag);
  document.getElementById('mc-support-helper-start')?.addEventListener('click', mcSupportStartHelper);
  document.getElementById('mc-support-helper-connect')?.addEventListener('click', mcSupportBuildSsh);
  document.getElementById('mc-support-client-code')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') mcSupportAuthorizeClient();
  });
  mcSupportRefreshClientStatus();
}
