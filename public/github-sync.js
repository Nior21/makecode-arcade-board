// GitHub sync UI — project picker in app header.
const MC_BOARD_PROJECT = 'makecode-arcade';

const MC = {
  activeSlug: localStorage.getItem('mc-active-game') || MC_BOARD_PROJECT,
  ghLogin: null,
  boardStatus: null,
  localGames: [],
  remoteProjects: [],
  projectsLoad: null,
  scanPoll: null,
  scanHint: '',
};

function mcApi(path, opts = {}) {
  return fetch(path, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    ...opts,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data.error || data.message || `HTTP ${r.status}`;
      throw new Error(String(msg));
    }
    return data;
  });
}

function mcSetGhError(text) {
  const el = document.getElementById('mc-gh-error');
  if (el) el.textContent = text || '';
}

function mcSetGhSession(st) {
  const el = document.getElementById('mc-gh-session');
  if (!el) return;
  el.classList.remove('connected', 'error');
  if (st?.connected && st.login) {
    el.textContent = `Вход выполнен: @${st.login}${st.source === 'env' ? ' (env)' : ''}`;
    el.classList.add('connected');
  } else if (st?.error) {
    el.textContent = st.error;
    el.classList.add('error');
  } else {
    el.textContent = 'Не авторизован — вставьте PAT или используйте Device Flow';
  }
}

function mcSetGhBusy(busy) {
  for (const id of ['mc-gh-save', 'mc-gh-device', 'mc-gh-logout']) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !!busy;
  }
}

function mcNotify(text) {
  if (typeof pushBoardNotif === 'function') pushBoardNotif(text, 'system');
  else console.log('[mc]', text);
}

function mcIsBoardProject(slug) {
  return slug === MC_BOARD_PROJECT;
}

function mcIsKnownProject(slug) {
  return mcIsBoardProject(slug) || MC.localGames.some((g) => g.slug === slug);
}

function mcSetActive(slug) {
  MC.activeSlug = slug;
  localStorage.setItem('mc-active-game', slug);
  mcRenderHeaderProject();
  if (typeof ttOnActiveProjectChange === 'function') ttOnActiveProjectChange();
}

function mcBoardLabel(version) {
  const ver = version || MC.boardStatus?.version || '';
  return ver ? `Система заявок ${ver}` : 'Система заявок';
}

function mcActiveGame() {
  if (mcIsBoardProject(MC.activeSlug)) {
    const ver = MC.boardStatus?.version;
    return { slug: MC_BOARD_PROJECT, name: mcBoardLabel(ver), isBoard: true, version: ver };
  }
  return MC.localGames.find((g) => g.slug === MC.activeSlug) || { slug: MC.activeSlug, name: MC.activeSlug };
}

function mcRenderHeaderProject() {
  const btn = document.getElementById('mc-project-btn');
  const game = mcActiveGame();
  if (btn) {
    const gh = MC.ghLogin ? ` · @${MC.ghLogin}` : '';
    btn.textContent = game.name || game.slug;
    btn.title = game.isBoard
      ? `Система заявок (${MC_BOARD_PROJECT})${gh}`
      : `games/${game.slug}${gh}`;
  }
  const ghSummary = document.getElementById('mc-gh-inline-summary');
  if (ghSummary) {
    ghSummary.textContent = MC.ghLogin ? `GitHub — @${MC.ghLogin}` : 'GitHub — войти';
  }
  const boardTitle = document.querySelector('.tt-board-header h2');
  if (boardTitle) {
    boardTitle.textContent = `📋 Задачи — ${game.name || game.slug}`;
  }
}

function mcSetBoardRepoError(text) {
  const el = document.getElementById('mc-board-repo-error');
  if (el) el.textContent = text || '';
}

function mcSetBoardRepoBusy(busy) {
  const btn = document.getElementById('mc-board-repo-save');
  if (btn) btn.disabled = !!busy;
}

function mcFormatBoardRepoSummary(linked) {
  if (linked?.owner && linked?.repo) return `Repo — ${linked.owner}/${linked.repo}`;
  return 'Система заявок — GitHub repo';
}

function mcPopulateBoardRepoInput() {
  const input = document.getElementById('mc-board-repo');
  const linked = MC.boardStatus?.linked;
  if (input && linked?.owner && linked?.repo) {
    input.value = `${linked.owner}/${linked.repo}`;
  }
  const summary = document.getElementById('mc-board-inline-summary');
  if (summary) summary.textContent = mcFormatBoardRepoSummary(linked);
}

async function mcRefreshBoardStatus() {
  try {
    MC.boardStatus = await mcApi('/api/board/status');
    mcRenderHeaderProject();
    mcPopulateBoardRepoInput();
    return MC.boardStatus;
  } catch (_) {
    MC.boardStatus = MC.boardStatus || { version: 'v.1.0.0' };
    return MC.boardStatus;
  }
}

async function mcRefreshCursorStatus() {
  try {
    const st = await mcApi('/api/cursor/status');
    mcSetCursorSession(st);
    return st;
  } catch (err) {
    mcSetCursorSession({ error: err.message });
    throw err;
  }
}

function mcSetCursorSession(st) {
  const el = document.getElementById('mc-cursor-session');
  if (!el) return;
  el.classList.remove('connected', 'error');
  if (st?.configured) {
    el.textContent = `Cursor key: ${st.masked || '••••'}`;
    el.classList.add('connected');
  } else if (st?.error) {
    el.textContent = st.error;
    el.classList.add('error');
  } else {
    el.textContent = 'Cursor API key не задан — нужен для AI_Agent';
  }
  const summary = document.getElementById('mc-cursor-inline-summary');
  if (summary) {
    summary.textContent = st?.configured ? `Cursor — ${st.masked || '••••'}` : 'Cursor — ключ';
  }
}

function mcSetCursorError(text) {
  const el = document.getElementById('mc-cursor-error');
  if (el) el.textContent = text || '';
}

function mcSetCursorBusy(busy) {
  for (const id of ['mc-cursor-save', 'mc-cursor-logout']) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !!busy;
  }
}

async function mcRefreshGhStatus() {
  try {
    const st = await mcApi('/api/github/status');
    MC.ghLogin = st.login;
    mcSetGhSession(st);
    mcRenderHeaderProject();
    return st;
  } catch (err) {
    mcSetGhSession({ error: err.message });
    mcRenderHeaderProject();
    mcNotify('⚠️ ' + err.message);
    throw err;
  }
}

function mcStopScanPoll() {
  if (MC.scanPoll) {
    clearInterval(MC.scanPoll);
    MC.scanPoll = null;
  }
}

function mcFormatScanHint(progress) {
  if (!progress?.running) return '';
  const total = progress.total || '?';
  const done = progress.done || 0;
  const found = progress.found || 0;
  return `Проверка GitHub: ${done}/${total}, найдено ${found}…`;
}

async function mcPollScanProgress() {
  try {
    const progress = await mcApi('/api/github/scan');
    MC.scanHint = mcFormatScanHint(progress);
    mcRenderProjectList({ loadingRemote: progress.running });
    if (!progress.running) {
      mcStopScanPoll();
      if (MC.projectsLoad) return;
      const remote = await mcApi('/api/github/projects');
      MC.remoteProjects = remote.projects || [];
      MC.scanHint = remote.cached ? '' : `Найдено ${MC.remoteProjects.length}`;
      mcRenderProjectList();
    }
  } catch (_) {}
}

function mcStartScanPoll() {
  mcStopScanPoll();
  mcPollScanProgress();
  MC.scanPoll = setInterval(mcPollScanProgress, 1500);
}

async function mcLoadProjects(opts = {}) {
  const refresh = !!opts.refresh;
  if (MC.projectsLoad && !refresh) return MC.projectsLoad;

  MC.projectsLoad = (async () => {
    const [local, st] = await Promise.all([
      mcApi('/api/github/local'),
      mcApi('/api/github/status'),
      mcRefreshBoardStatus(),
    ]);
    MC.localGames = local.games || [];
    MC.ghLogin = st.login || null;
    if (st.connected) {
      const qs = refresh ? '?refresh=1' : '';
      const remote = await mcApi(`/api/github/projects${qs}`);
      MC.remoteProjects = remote.projects || [];
      if (remote.stale || refresh) mcStartScanPoll();
      else MC.scanHint = remote.cached ? '' : `Найдено ${MC.remoteProjects.length}`;
    } else {
      MC.remoteProjects = [];
      MC.scanHint = '';
      mcStopScanPoll();
    }
    if (!mcIsKnownProject(MC.activeSlug)) {
      mcSetActive(MC_BOARD_PROJECT);
    } else {
      mcRenderHeaderProject();
    }
    if (typeof ttLoadProjectList === 'function') ttLoadProjectList().catch(() => {});
  })();

  try {
    await MC.projectsLoad;
  } finally {
    MC.projectsLoad = null;
  }
}

function mcOpenProjectPopup() {
  document.getElementById('mc-project-overlay')?.classList.add('open');
  mcRenderProjectList({ loadingRemote: true });
  mcRefreshGhStatus().catch(() => {});
  mcRefreshCursorStatus().catch(() => {});
  mcLoadProjects()
    .then(() => mcRenderProjectList())
    .catch((e) => {
      mcRenderProjectList();
      mcNotify('⚠️ ' + e.message);
    });
}

function mcCloseProjectPopup() {
  document.getElementById('mc-project-overlay')?.classList.remove('open');
}

function mcRenderBoardProjectRow(host) {
  const st = MC.boardStatus || {};
  const ver = st.version ? ` · ${st.version}` : '';
  const linkHint = st.linked ? `${st.linked.owner}/${st.linked.repo}` : 'GitHub не привязан';
  const row = document.createElement('div');
  row.className = 'mc-project-row' + (mcIsBoardProject(MC.activeSlug) ? ' active' : '');
  row.innerHTML = `<span class="mc-project-name">${escapeHtml(mcBoardLabel(st.version))}</span><span class="mc-project-slug">${escapeHtml(MC_BOARD_PROJECT)}${escapeHtml(ver)} · ${escapeHtml(linkHint)}</span>`;
  const actions = document.createElement('div');
  actions.className = 'mc-project-actions';
  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'mc-btn';
  select.textContent = 'Выбрать';
  select.addEventListener('click', () => { mcSetActive(MC_BOARD_PROJECT); mcCloseProjectPopup(); });
  actions.appendChild(select);
  const linkBtn = document.createElement('button');
  linkBtn.type = 'button';
  linkBtn.className = 'mc-btn secondary';
  linkBtn.textContent = 'Repo';
  linkBtn.title = 'Показать поле репозитория';
  linkBtn.addEventListener('click', () => {
    const block = document.getElementById('mc-board-inline');
    if (block) {
      block.setAttribute('open', '');
      document.getElementById('mc-board-repo')?.focus();
    }
  });
  const pull = document.createElement('button');
  pull.type = 'button';
  pull.className = 'mc-btn secondary';
  pull.textContent = 'Pull';
  pull.addEventListener('click', () => mcDoBoardPull());
  const push = document.createElement('button');
  push.type = 'button';
  push.className = 'mc-btn secondary';
  push.textContent = 'Push';
  push.addEventListener('click', () => mcDoBoardPush());
  actions.append(linkBtn, pull, push);
  row.appendChild(actions);
  host.appendChild(row);
}

function mcRenderProjectList(opts = {}) {
  const boardHost = document.getElementById('mc-board-list');
  const localHost = document.getElementById('mc-local-list');
  const remoteHost = document.getElementById('mc-remote-list');
  if (!localHost || !remoteHost) return;

  if (boardHost) {
    boardHost.innerHTML = '';
    mcRenderBoardProjectRow(boardHost);
  }

  localHost.innerHTML = '';
  for (const g of MC.localGames) {
    const row = document.createElement('div');
    row.className = 'mc-project-row' + (g.slug === MC.activeSlug ? ' active' : '');
    row.innerHTML = `<span class="mc-project-name">${escapeHtml(g.name)}</span><span class="mc-project-slug">${escapeHtml(g.slug)}</span>`;
    const actions = document.createElement('div');
    actions.className = 'mc-project-actions';
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'mc-btn';
    select.textContent = 'Выбрать';
    select.addEventListener('click', () => { mcSetActive(g.slug); mcCloseProjectPopup(); });
    actions.appendChild(select);
    if (g.isGit || g.linked) {
      const pull = document.createElement('button');
      pull.type = 'button';
      pull.className = 'mc-btn secondary';
      pull.textContent = 'Pull';
      pull.addEventListener('click', () => mcDoPull(g.slug));
      const push = document.createElement('button');
      push.type = 'button';
      push.className = 'mc-btn secondary';
      push.textContent = 'Push';
      push.addEventListener('click', () => mcDoPush(g.slug));
      actions.append(pull, push);
    }
    row.appendChild(actions);
    localHost.appendChild(row);
  }
  if (!MC.localGames.length) {
    localHost.innerHTML = '<div class="mc-empty">Локальных игр нет</div>';
  }

  if (opts.loadingRemote) {
    remoteHost.innerHTML = `<div class="mc-empty">${escapeHtml(MC.scanHint || 'Загрузка GitHub-репозиториев…')}</div>`;
    return;
  }

  remoteHost.innerHTML = '';
  for (const p of MC.remoteProjects) {
    const cloned = MC.localGames.some((g) => g.linked && g.linked.owner === p.owner && g.linked.repo === p.repo && (g.linked.path || '') === (p.path || ''));
    const row = document.createElement('div');
    row.className = 'mc-project-row';
    const label = p.path ? `${p.full_name}/${p.path}` : p.full_name;
    row.innerHTML = `<span class="mc-project-name">${escapeHtml(p.name)}</span><span class="mc-project-slug">${escapeHtml(label)}</span>`;
    const actions = document.createElement('div');
    actions.className = 'mc-project-actions';
    if (!cloned) {
      const cloneBtn = document.createElement('button');
      cloneBtn.type = 'button';
      cloneBtn.className = 'mc-btn';
      cloneBtn.textContent = 'Clone';
      cloneBtn.addEventListener('click', () => mcDoClone(p));
      actions.appendChild(cloneBtn);
    } else {
      const tag = document.createElement('span');
      tag.className = 'mc-tag';
      tag.textContent = 'склонирован';
      actions.appendChild(tag);
    }
    row.appendChild(actions);
    remoteHost.appendChild(row);
  }
  if (!MC.remoteProjects.length) {
    const hint = MC.scanHint
      || (MC.ghLogin
        ? 'MakeCode-репозитории не найдены (нет pxt.json в ваших репо на GitHub)'
        : 'MakeCode-репозитории не найдены (нужен вход в GitHub)');
    remoteHost.innerHTML = `<div class="mc-empty">${escapeHtml(hint)}</div>`;
  }
}

async function mcDoClone(project) {
  try {
    mcNotify(`Клонирование ${project.full_name}…`);
    const slug = prompt('Slug для games/', mcSuggestSlug(project));
    if (!slug) return;
    const result = await mcApi('/api/github/clone', {
      method: 'POST',
      body: JSON.stringify({ ...project, slug }),
    });
    mcNotify(`✓ Клонировано: games/${result.slug}`);
    await mcLoadProjects();
    mcSetActive(result.slug);
    mcRenderProjectList();
  } catch (err) {
    mcNotify('⚠️ ' + err.message);
  }
}

async function mcDoBoardPull() {
  try {
    mcNotify('Pull Система заявок…');
    const result = await mcApi('/api/board/pull', { method: 'POST', body: '{}' });
    mcNotify(`✓ ${result.message} (${result.version || ''})`);
    await mcRefreshBoardStatus();
    mcRenderProjectList();
  } catch (err) {
    mcNotify('⚠️ ' + err.message);
  }
}

async function mcDoBoardPush() {
  try {
    const note = prompt('Комментарий к коммиту (версия добавится автоматически):', 'sync');
    if (note === null) return;
    mcNotify('Push Система заявок…');
    const result = await mcApi('/api/board/push', { method: 'POST', body: JSON.stringify({ message: note }) });
    mcNotify(`✓ ${result.message}${result.commit ? ': ' + result.commit : ''}`);
    await mcRefreshBoardStatus();
    mcRenderProjectList();
  } catch (err) {
    mcNotify('⚠️ ' + err.message);
  }
}

async function mcSaveBoardRepo() {
  const input = document.getElementById('mc-board-repo');
  const raw = input?.value?.trim();
  mcSetBoardRepoError('');
  if (!raw) {
    mcSetBoardRepoError('Укажите owner/repo');
    return;
  }
  const parsed = parseRepoRefClient(raw);
  if (!parsed) {
    mcSetBoardRepoError('Формат: owner/repo');
    return;
  }
  mcSetBoardRepoBusy(true);
  try {
    await mcApi('/api/board/link', {
      method: 'POST',
      body: JSON.stringify({ owner: parsed.owner, repo: parsed.repo, repoFull: raw }),
    });
    mcNotify(`✓ Привязано: ${parsed.owner}/${parsed.repo}`);
    await mcRefreshBoardStatus();
    mcRenderProjectList();
  } catch (err) {
    mcSetBoardRepoError(err.message);
    mcNotify('⚠️ ' + err.message);
  } finally {
    mcSetBoardRepoBusy(false);
  }
}

function parseRepoRefClient(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\/github\.com\//i, '');
  s = s.replace(/\.git$/i, '');
  s = s.replace(/\/+$/, '');
  const m = s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

async function mcLinkBoardRepo() {
  document.getElementById('mc-board-inline')?.setAttribute('open', '');
  const input = document.getElementById('mc-board-repo');
  if (input) input.focus();
  else await mcSaveBoardRepo();
}

async function mcSaveCursorKey() {
  const input = document.getElementById('mc-cursor-token');
  const token = input?.value?.trim();
  mcSetCursorError('');
  if (!token) {
    mcSetCursorError('Введите Cursor API key');
    return;
  }
  mcSetCursorBusy(true);
  try {
    const r = await mcApi('/api/cursor/token', { method: 'POST', body: JSON.stringify({ token }) });
    mcNotify(`✓ Cursor key: ${r.masked || 'saved'}`);
    if (input) input.value = '';
    await mcRefreshCursorStatus();
  } catch (err) {
    mcSetCursorError(err.message);
    mcNotify('⚠️ ' + err.message);
  } finally {
    mcSetCursorBusy(false);
  }
}

async function mcLogoutCursor() {
  mcSetCursorError('');
  mcSetCursorBusy(true);
  try {
    await mcApi('/api/cursor/logout', { method: 'POST', body: '{}' });
    await mcRefreshCursorStatus();
    mcNotify('Cursor key удалён');
  } catch (err) {
    mcSetCursorError(err.message);
    mcNotify('⚠️ ' + err.message);
  } finally {
    mcSetCursorBusy(false);
  }
}

async function mcDoPull(slug) {
  try {
    mcNotify(`Pull games/${slug}…`);
    const result = await mcApi('/api/github/pull', { method: 'POST', body: JSON.stringify({ slug }) });
    mcNotify(`✓ ${result.message}`);
    await mcLoadProjects();
    mcRenderProjectList();
  } catch (err) {
    mcNotify('⚠️ ' + err.message);
  }
}

async function mcDoPush(slug) {
  try {
    mcNotify(`Push games/${slug}…`);
    const result = await mcApi('/api/github/push', { method: 'POST', body: JSON.stringify({ slug }) });
    mcNotify(`✓ ${result.message}`);
  } catch (err) {
    mcNotify('⚠️ ' + err.message);
  }
}

function mcSuggestSlug(project) {
  const base = project.path || project.repo;
  return String(base).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mcOpenGhAuthPopup() {
  document.getElementById('mc-gh-inline')?.setAttribute('open', '');
  mcSetGhError('');
  mcRefreshGhStatus().catch(() => {});
}

function mcCloseGhAuthPopup() {
  mcSetGhError('');
}

async function mcSavePat() {
  const input = document.getElementById('mc-gh-token');
  const token = input?.value?.trim();
  mcSetGhError('');
  if (!token) {
    mcSetGhError('Вставьте Personal Access Token');
    return;
  }
  mcSetGhBusy(true);
  try {
    const r = await mcApi('/api/github/token', { method: 'POST', body: JSON.stringify({ token }) });
    mcNotify(`✓ GitHub: @${r.login}`);
    if (input) input.value = '';
    await mcRefreshGhStatus();
    await mcLoadProjects();
    mcRenderProjectList();
    mcCloseGhAuthPopup();
  } catch (err) {
    mcSetGhError(err.message);
    mcNotify('⚠️ ' + err.message);
  } finally {
    mcSetGhBusy(false);
  }
}

async function mcStartDeviceFlow() {
  const hint = document.getElementById('mc-gh-device-hint');
  mcSetGhError('');
  mcSetGhBusy(true);
  try {
    const data = await mcApi('/api/github/device/start', { method: 'POST', body: '{}' });
    if (hint) {
      hint.innerHTML = `Откройте <a href="${data.verification_uri}" target="_blank" rel="noopener">${data.verification_uri}</a> и введите код: <strong>${data.user_code}</strong>`;
    }
    const deadline = Date.now() + (data.expires_in || 900) * 1000;
    let interval = (data.interval || 5) * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      let poll;
      try {
        poll = await mcApi('/api/github/device/poll', {
          method: 'POST',
          body: JSON.stringify({ device_code: data.device_code }),
        });
      } catch (err) {
        if (/authorization_pending|slow_down/i.test(err.message)) {
          continue;
        }
        throw err;
      }
      if (poll.pending) {
        interval = Math.max(interval, (poll.interval || 5) * 1000);
        continue;
      }
      mcNotify(`✓ GitHub: @${poll.login}`);
      if (hint) hint.textContent = '';
      await mcRefreshGhStatus();
      await mcLoadProjects();
      mcRenderProjectList();
      mcCloseGhAuthPopup();
      return;
    }
    mcSetGhError('Время авторизации истекло');
    mcNotify('Время авторизации истекло');
  } catch (err) {
    mcSetGhError(err.message);
    mcNotify('⚠️ ' + err.message);
    if (hint) hint.textContent = err.message;
  } finally {
    mcSetGhBusy(false);
  }
}

async function mcLogoutGh() {
  mcSetGhError('');
  mcSetGhBusy(true);
  try {
    await mcApi('/api/github/logout', { method: 'POST', body: '{}' });
    MC.ghLogin = null;
    MC.remoteProjects = [];
    await mcRefreshGhStatus();
    mcRenderProjectList();
    mcNotify('GitHub: выход');
  } catch (err) {
    mcSetGhError(err.message);
    mcNotify('⚠️ ' + err.message);
  } finally {
    mcSetGhBusy(false);
  }
}

function mcInitGithubSync() {
  document.getElementById('mc-project-btn')?.addEventListener('click', mcOpenProjectPopup);
  document.getElementById('mc-project-close')?.addEventListener('click', mcCloseProjectPopup);
  document.getElementById('mc-project-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'mc-project-overlay') mcCloseProjectPopup();
  });
  document.getElementById('mc-gh-save')?.addEventListener('click', mcSavePat);
  document.getElementById('mc-gh-device')?.addEventListener('click', mcStartDeviceFlow);
  document.getElementById('mc-gh-logout')?.addEventListener('click', mcLogoutGh);
  document.getElementById('mc-cursor-save')?.addEventListener('click', mcSaveCursorKey);
  document.getElementById('mc-cursor-logout')?.addEventListener('click', mcLogoutCursor);
  document.getElementById('mc-board-repo-save')?.addEventListener('click', mcSaveBoardRepo);
  document.getElementById('mc-board-repo')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') mcSaveBoardRepo();
  });
  document.getElementById('mc-project-refresh')?.addEventListener('click', () => {
    mcRenderProjectList({ loadingRemote: true });
    mcLoadProjects({ refresh: true })
      .then(() => mcRenderProjectList())
      .catch((e) => {
        mcRenderProjectList();
        mcNotify('⚠️ ' + e.message);
      });
  });

  mcRefreshGhStatus();
  mcRefreshBoardStatus().catch(() => {});
  mcRefreshCursorStatus().catch(() => {});
  mcLoadProjects().catch(() => {});
  mcRenderHeaderProject();
}
