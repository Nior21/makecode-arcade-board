// ============================================================
// Trust Island — Task board (Kanban) for map editor
// ============================================================

const TT = {
  /** TT-проект для задач интерфейса / системы заявок */
  boardProject: 'makecode-arcade',
  api: '/api/tt',
  roles: ['AI_Agent', 'Developer', 'QA_Engineer'],
  columns: [
    { key: 'open', label: 'Новое' },
    { key: 'in_progress', label: 'В работе' },
    { key: 'done', label: 'Готово' },
    { key: 'cancelled', label: 'Закрыта' },
  ],
  statusLabels: {
    open: 'Новое',
    in_progress: 'В работе',
    done: 'Готово',
    cancelled: 'Закрыта',
  },
  nextStatus: {
    open: 'in_progress',
    in_progress: 'done',
  },
  refreshMs: 15000,
  workerPollMs: 2500,
};

const TT_TIP_SEND = 'Отправить (Ctrl+Enter)';
const TT_TIP_TRANSFER = 'Передать (Alt+Enter)';
const TT_TIP_TRANSFER_SAME_ROLE =
  'Передать выбранной роли (сначала смените роль: 1–3 или Alt+1–3) · Alt+Enter';
const TT_ROLE_HOTKEY = { AI_Agent: '1', Developer: '2', QA_Engineer: '3' };

const ttState = {
  tasks: [],
  viewer: localStorage.getItem('tt-viewer') || 'QA_Engineer',
  listMode: localStorage.getItem('tt-list-mode') !== '0',
  detailTaskId: null,
  statusMenu: null,
  ctxMenu: null,
  ctxMenuCleanup: null,
  transferTaskId: null,
  transferMode: null,
  handoffTaskId: null,
  roleMenu: null,
  refreshTimer: null,
  workerPoll: null,
  stackPoll: null,
  stackOk: true,
  agentActiveTaskId: null,
  editingCommentId: null,
  commentEditDrafts: {},
  commentEditSelStart: null,
  commentEditSelEnd: null,
  manualEditing: false,
  showAll: localStorage.getItem('tt-show-all') === '1' || localStorage.getItem('tt-show-deleted') === '1',
  showTrash: localStorage.getItem('tt-show-trash') === '1',
  showCommentAll: localStorage.getItem('tt-show-comment-all') === '1',
  searchQuery: '',
  tagFilter: null, // display tag name for board filter / replay
  tagReplayIndex: 0,
  balances: {},
  motivationEvents: [],
  motivationShowAll: localStorage.getItem('tt-motivation-all') === '1',
  draftSubmitting: false,
  draft: {
    taskId: null,
    expanded: false,
    text: '',
    stars: 0,
    draftId: null,
    startedAt: null,
    selStart: null,
    selEnd: null,
  },
  tagRegistry: [],
  features: [],
  featurePickMode: null, // 'bug' | 'feature' | null
  featurePickSelected: new Set(),
  featurePickResolve: null,
  pendingTagDraft: [],
  projectList: [],
  readStateRoot: null,
  deviceOrigin: null,
  audioCtx: null,
  soundsEnabled: localStorage.getItem('tt-sounds') !== '0',
  popupHistoryDepth: 0,
  popupHistoryIgnore: 0,
  popupDismissWired: false,
};

const TT_READ_KEY = 'tt-read-state';
const TT_DEVICE_ORIGIN_KEY = 'tt-device-origin';

/** Прочитанность — единое состояние на устройстве (не зависит от роли tt-viewer). */
function ttLoadReadRoot() {
  if (ttState.readStateRoot) return ttState.readStateRoot;
  let root;
  try {
    root = JSON.parse(localStorage.getItem(TT_READ_KEY) || '{}');
  } catch {
    root = {};
  }
  if (TT.roles.some((role) => root[role]?.tasks || root[role]?.comments)) {
    const merged = { tasks: {}, comments: {} };
    for (const role of TT.roles) {
      const rs = root[role];
      if (!rs) continue;
      for (const [id, ts] of Object.entries(rs.tasks || {})) {
        if (!merged.tasks[id] || ts > merged.tasks[id]) merged.tasks[id] = ts;
      }
      for (const [id, ts] of Object.entries(rs.comments || {})) {
        if (!merged.comments[id] || ts > merged.comments[id]) merged.comments[id] = ts;
      }
    }
    root = merged;
    localStorage.setItem(TT_READ_KEY, JSON.stringify(root));
  }
  if (!root.tasks) root.tasks = {};
  if (!root.comments) root.comments = {};
  ttState.readStateRoot = root;
  return root;
}

function ttSaveReadState() {
  ttLoadReadRoot();
  localStorage.setItem(TT_READ_KEY, JSON.stringify(ttState.readStateRoot));
}

function ttDeviceOrigin() {
  if (ttState.deviceOrigin) return ttState.deviceOrigin;
  let origin;
  try {
    origin = JSON.parse(localStorage.getItem(TT_DEVICE_ORIGIN_KEY) || '{}');
  } catch {
    origin = {};
  }
  if (!origin.tasks) origin.tasks = {};
  if (!origin.comments) origin.comments = {};
  ttState.deviceOrigin = origin;
  return origin;
}

function ttSaveDeviceOrigin() {
  ttDeviceOrigin();
  localStorage.setItem(TT_DEVICE_ORIGIN_KEY, JSON.stringify(ttState.deviceOrigin));
}

function ttMarkDeviceTask(taskId) {
  if (!taskId) return;
  ttDeviceOrigin().tasks[taskId] = true;
  ttSaveDeviceOrigin();
}

function ttMarkDeviceComment(commentId) {
  if (!commentId) return;
  ttDeviceOrigin().comments[commentId] = true;
  ttSaveDeviceOrigin();
}

function ttIsDeviceTask(taskId) {
  return !!ttDeviceOrigin().tasks[taskId];
}

function ttIsDeviceComment(commentId) {
  return !!ttDeviceOrigin().comments[commentId];
}

function ttCommentNeedsUnreadTrack(comment) {
  if (!comment || comment.deleted) return false;
  if (ttIsAgentStartComment(comment)) return false;
  if (comment.author === 'AI_Agent') return true;
  return !ttIsDeviceComment(comment.id);
}

function ttGetTaskReadAt(taskId) {
  return ttLoadReadRoot().tasks[taskId] || null;
}

function ttCommentStamp(comment) {
  return comment?.updated_at || comment?.created_at || '';
}

function ttMarkTaskRead(task) {
  if (!task?.id) return;
  const s = ttLoadReadRoot();
  let taskStamp = task.updated_at || new Date().toISOString();
  for (const c of task.comments || []) {
    if (c.deleted) continue;
    const cts = ttCommentStamp(c) || taskStamp;
    if (cts > taskStamp) taskStamp = cts;
    s.comments[c.id] = cts;
  }
  s.tasks[task.id] = taskStamp;
  ttSaveReadState();
}

function ttMarkCommentRead(comment) {
  if (!comment?.id || comment.deleted) return;
  const s = ttLoadReadRoot();
  s.comments[comment.id] = comment.updated_at || comment.created_at || new Date().toISOString();
  ttSaveReadState();
}

function ttCommentUnread(comment, taskReadAt) {
  if (!ttCommentNeedsUnreadTrack(comment)) return false;
  const s = ttLoadReadRoot();
  const ts = ttCommentStamp(comment);
  if (!ts) return false;
  const commentRead = s.comments[comment.id];
  if (commentRead) return ts > commentRead;
  if (!taskReadAt) return true;
  return ts > taskReadAt;
}

const TT_HOVER_READ_MS = 1200;

function ttSyncUnreadDom(task) {
  if (!task?.id) return;
  const card = document.querySelector(`.tt-card[data-task-id="${CSS.escape(task.id)}"]`);
  if (card) card.classList.toggle('tt-unread', ttTaskUnread(task));
  if (ttState.detailTaskId !== task.id) return;
  const taskReadAt = ttGetTaskReadAt(task.id);
  document.querySelectorAll('#tt-detail-comments .tt-comment[data-comment-id]').forEach((block) => {
    const cid = block.dataset.commentId;
    const c = (task.comments || []).find((x) => x.id === cid);
    if (!c) return;
    block.classList.toggle('tt-unread', ttCommentUnread(c, taskReadAt));
  });
}

function ttMarkCommentReadAndSync(task, comment) {
  if (!task || !comment || comment.deleted) return;
  if (!ttCommentUnread(comment, ttGetTaskReadAt(task.id))) return;
  ttMarkCommentRead(comment);
  const taskReadAt = ttGetTaskReadAt(task.id);
  const allRead = !(task.comments || []).some(
    (c) => !c.deleted && ttCommentUnread(c, taskReadAt),
  );
  if (allRead) ttMarkTaskRead(task);
  ttSyncUnreadDom(task);
}

function ttBindCommentReadHandlers(block, task, comment) {
  if (!comment || comment.deleted || !ttCommentNeedsUnreadTrack(comment)) return;
  let hoverTimer = null;
  const clearHover = () => {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = null;
  };
  const markIfUnread = () => {
    const live = ttGetTask(task.id);
    const c = (live?.comments || []).find((x) => x.id === comment.id) || comment;
    ttMarkCommentReadAndSync(live || task, c);
  };
  block.addEventListener('click', (e) => {
    if (e.target.closest('button, a, textarea, .tt-comment-edit')) return;
    markIfUnread();
  });
  block.addEventListener('mouseenter', () => {
    clearHover();
    hoverTimer = setTimeout(markIfUnread, TT_HOVER_READ_MS);
  });
  block.addEventListener('mouseleave', clearHover);
  block.addEventListener('mouseup', () => {
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed && block.contains(sel.anchorNode)) markIfUnread();
  });
}

function ttTaskUnread(task) {
  if (!task?.id) return false;
  const readAt = ttGetTaskReadAt(task.id);
  if (!readAt) {
    if (ttIsDeviceTask(task.id)) {
      return (task.comments || []).some((c) => ttCommentUnread(c, null));
    }
    return (task.comments || []).some((c) => ttCommentNeedsUnreadTrack(c)) || !ttIsDeviceTask(task.id);
  }
  for (const c of task.comments || []) {
    if (ttCommentUnread(c, readAt)) return true;
  }
  return false;
}

function ttEnsureAudio() {
  if (!ttState.soundsEnabled) return null;
  if (!ttState.audioCtx) {
    try {
      ttState.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      return null;
    }
  }
  if (ttState.audioCtx.state === 'suspended') ttState.audioCtx.resume().catch(() => {});
  return ttState.audioCtx;
}

function ttPlaySound(kind) {
  const ctx = ttEnsureAudio();
  if (!ctx) return;
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0.07, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

  const tone = (freq, start, dur, type = 'sine') => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    osc.connect(gain);
    osc.start(start);
    osc.stop(start + dur);
  };

  if (kind === 'error') {
    tone(220, now, 0.22, 'square');
    tone(180, now + 0.12, 0.18, 'square');
    return;
  }
  if (kind === 'agent-done') {
    tone(523.25, now, 0.14);
    tone(659.25, now + 0.14, 0.14);
    tone(783.99, now + 0.28, 0.2);
    return;
  }
  tone(880, now, 0.1);
}

const TT_SYSTEM_TAGS = new Set(['manual', 'board', 'test-scenario', 'qa']);
const TT_DEFAULT_TAGS = ['Идея', 'Баг', 'Фича', 'Bug', 'Feature'];
const TT_TAG_RE = /#([^\s#]+)/g;

function ttIsSystemTag(tag) {
  const s = String(tag || '').toLowerCase();
  return TT_SYSTEM_TAGS.has(s) || s.startsWith('sheet-') || s.startsWith('feature:');
}

/** Junk harvested from QA titles like [QA-F9] / tag F9 — not real board labels. */
function ttIsJunkTag(tag) {
  const name = ttNormalizeTag(tag);
  if (!name) return true;
  if (ttIsSystemTag(name)) return false;
  // Sheet cell codes: F9, B2, E4, …
  if (/^[A-Za-z]\d{1,2}$/.test(name)) return true;
  // Broken parses
  if (name === '"' || name === "'" || name === '#') return true;
  return false;
}

function ttNormalizeTag(tag) {
  return String(tag || '').replace(/^#/, '').trim();
}

function ttTagKey(tag) {
  return ttNormalizeTag(tag).toLowerCase();
}

function ttLoadTagRegistry() {
  try {
    const raw = JSON.parse(localStorage.getItem('tt-tag-registry') || '[]');
    const list = Array.isArray(raw) ? raw.map(ttNormalizeTag).filter(Boolean) : [];
    const merged = [...TT_DEFAULT_TAGS];
    for (const t of list) {
      if (ttIsSystemTag(t) || ttIsJunkTag(t)) continue;
      if (!merged.some(x => ttTagKey(x) === ttTagKey(t))) merged.push(t);
    }
    ttState.tagRegistry = merged;
  } catch {
    ttState.tagRegistry = [...TT_DEFAULT_TAGS];
  }
}

function ttSaveTagRegistry() {
  localStorage.setItem('tt-tag-registry', JSON.stringify(ttState.tagRegistry));
}

function ttEnsureTagInRegistry(tag) {
  const name = ttNormalizeTag(tag);
  if (!name || ttIsSystemTag(name) || ttIsJunkTag(name)) return;
  if (!ttState.tagRegistry.some(t => ttTagKey(t) === ttTagKey(name))) {
    ttState.tagRegistry.push(name);
    ttSaveTagRegistry();
  }
}

function ttPruneJunkFromRegistry() {
  const before = ttState.tagRegistry.length;
  ttState.tagRegistry = ttState.tagRegistry.filter(t => !ttIsSystemTag(t) && !ttIsJunkTag(t));
  // Keep defaults
  for (const d of TT_DEFAULT_TAGS) {
    if (!ttState.tagRegistry.some(t => ttTagKey(t) === ttTagKey(d))) {
      ttState.tagRegistry.unshift(d);
    }
  }
  if (ttState.tagRegistry.length !== before) ttSaveTagRegistry();
}

function ttHarvestTagsFromTasks() {
  ttPruneJunkFromRegistry();
  for (const task of ttState.tasks || []) {
    for (const t of ttParseTitleTags(task.title || '')) ttEnsureTagInRegistry(t);
    for (const t of task.tags || []) {
      if (!ttIsSystemTag(t) && !ttIsJunkTag(t)) ttEnsureTagInRegistry(t);
    }
  }
}

function ttParseTitleTags(title) {
  const out = [];
  const seen = new Set();
  String(title || '').replace(TT_TAG_RE, (_, raw) => {
    const name = ttNormalizeTag(raw);
    if (!name || seen.has(ttTagKey(name))) return '';
    seen.add(ttTagKey(name));
    out.push(name);
    return '';
  });
  return out;
}

function ttStripTitleTags(title) {
  return String(title || '')
    .replace(TT_TAG_RE, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function ttComposeTitle(plainTitle, tags) {
  const base = ttStripTitleTags(plainTitle || '');
  const parts = (tags || []).map(ttNormalizeTag).filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const t of parts) {
    const k = ttTagKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(t);
  }
  const hash = unique.map(t => `#${t}`).join(' ');
  return [base, hash].filter(Boolean).join(' ').trim();
}

function ttTaskDisplayTags(task) {
  const fromTitle = ttParseTitleTags(task?.title || '');
  const fromField = (task?.tags || [])
    .map(ttNormalizeTag)
    .filter(t => t && !ttIsSystemTag(t) && !ttIsJunkTag(t));
  const out = [];
  const seen = new Set();
  for (const t of [...fromTitle, ...fromField]) {
    if (ttIsJunkTag(t) || ttIsSystemTag(t)) continue;
    const k = ttTagKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

function ttTagColor(tag) {
  const s = ttTagKey(tag);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return {
    bg: `hsl(${hue} 55% 42%)`,
    border: `hsl(${hue} 50% 32%)`,
    fg: '#f8fafc',
  };
}

function ttIsBugTag(tag) {
  const k = ttTagKey(tag);
  return k === 'баг' || k === 'bug';
}

function ttIsFeatureTag(tag) {
  const k = ttTagKey(tag);
  return k === 'фича' || k === 'feature';
}

function ttLoadFeatures() {
  try {
    const raw = JSON.parse(localStorage.getItem('tt-features') || '[]');
    ttState.features = Array.isArray(raw) ? raw : [];
  } catch {
    ttState.features = [];
  }
  if (!ttState.features.length) {
    ttState.features = [
      { id: 'feat_root_game', name: 'Игра', parent_ids: [] },
      { id: 'feat_root_board', name: 'Канбан', parent_ids: [] },
      { id: 'feat_food', name: 'Сбор пищи', parent_ids: ['feat_root_game'] },
    ];
    ttSaveFeatures();
  }
}

function ttSaveFeatures() {
  localStorage.setItem('tt-features', JSON.stringify(ttState.features));
}

function ttNotify(text, type = 'system') {
  if (typeof pushBoardNotif === 'function') pushBoardNotif(text, type);
}

function ttNotifyCommentRequired(action) {
  const messages = {
    transfer: '💬 Для передачи другому исполнителю нужен комментарий в списке (отправьте через ➤)',
    close: '💬 Для закрытия задачи нужен комментарий в списке (отправьте через ➤)',
  };
  ttNotify(messages[action] || messages.transfer);
}

// ── Markdown (lightweight) ────────────────────────────────────────
function ttEscapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ttInlineMd(text) {
  let s = ttEscapeHtml(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

function ttMarkdownToHtml(md) {
  if (!md) return '<p class="tt-md-empty">(без описания)</p>';
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { i++; continue; }

    if (/^\|/.test(line) && i + 1 < lines.length && /^\|?\s*[-:| ]+\|/.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        const cells = lines[i].replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        if (!/^\s*[-:| ]+\s*$/.test(cells.join(''))) rows.push(cells);
        i++;
      }
      if (rows.length) {
        out.push('<table class="tt-md-table"><thead><tr>' +
          rows[0].map(c => `<th>${ttInlineMd(c)}</th>`).join('') + '</tr></thead><tbody>' +
          rows.slice(1).map(r => '<tr>' + r.map(c => `<td>${ttInlineMd(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>');
      }
      continue;
    }

    if (/^#{1,3}\s/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      out.push(`<h${level}>${ttInlineMd(line.replace(/^#+\s*/, ''))}</h${level}>`);
      i++;
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (/^[-*]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push(`<li>${ttInlineMd(lines[i].replace(/^[-*]\s*/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,3}\s/.test(lines[i]) &&
      !/^[-*]\s/.test(lines[i]) && !/^\|/.test(lines[i]) && !/^---+$/.test(lines[i].trim())) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${para.map((l) => ttInlineMd(l)).join('<br>')}</p>`);
  }

  return out.join('\n');
}

// ── API ───────────────────────────────────────────────────────────
function ttApi(path, opts = {}) {
  return fetch(`${TT.api}${path}`, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    ...opts,
  }).then(async (r) => {
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok) throw new Error(typeof data === 'object' ? (data.error || r.status) : text);
    return data;
  });
}

function ttScenarioTasks() {
  return ttState.tasks.filter(t => (t.tags || []).includes('test-scenario'));
}

function ttPassCounter() {
  const scenarios = ttScenarioTasks();
  const passed = scenarios.filter(t => t.status === 'cancelled').length;
  return { passed, total: scenarios.length };
}

function ttUpdatePassCounter() {
  const el = document.getElementById('tt-pass-counter');
  if (!el) return;
  const { passed, total } = ttPassCounter();
  el.textContent = `(${passed}/${total})`;
}

function ttTaskParticipants(task) {
  if (!task) return [];
  const p = Array.isArray(task.participants) ? [...task.participants] : [];
  if (task.assignee && !p.includes(task.assignee)) p.push(task.assignee);
  return p;
}

function ttEnsureParticipants(task, ...people) {
  return [...new Set([...ttTaskParticipants(task), ...people].filter(Boolean))];
}

function ttIsTaskOwner(task, viewer = ttState.viewer) {
  return task?.assignee === viewer;
}

/** Статус задачи для текущего зрителя (у assignee «готово» после передачи = «новое»). */
function ttViewerTaskStatus(task, viewer = ttState.viewer) {
  if (!task) return 'open';
  if (ttIsTaskOwner(task, viewer) && task.status === 'done') return 'open';
  return task.status;
}

const TT_HANDOFF_PREFIX = '↪ Передано:';

function ttIsHandoffComment(c) {
  return String(c?.text || '').trimStart().startsWith(TT_HANDOFF_PREFIX);
}

function ttParseHandoffComment(c) {
  const m = String(c?.text || '').trim().match(/^↪\s*Передано:\s*(.+?)\s*→\s*(.+)$/);
  if (!m) return null;
  return { from: m[1].trim(), to: m[2].trim() };
}

function ttEffectiveShowAll() {
  return ttState.showAll
    || !!ttNormalizeSearchQuery(ttState.searchQuery)
    || !!ttNormalizeTag(ttState.tagFilter);
}

function ttIsBoardRole(viewer = ttState.viewer) {
  return TT.roles.includes(viewer);
}

function ttRoleLabel(role) {
  return role || '—';
}

function ttUpdateHeaderRole() {
  const btn = document.getElementById('tt-header-role');
  if (!btn) return;
  btn.textContent = ttRoleLabel(ttState.viewer);
  btn.title = `Роль: ${ttState.viewer} — нажмите для смены`;
}

function ttCloseRoleMenu() {
  if (ttState.roleMenu) {
    ttState.roleMenu.remove();
    ttState.roleMenu = null;
  }
}

function ttOpenRoleMenu(anchorEl) {
  ttCloseRoleMenu();
  if (!anchorEl) return;
  const rect = anchorEl.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'tt-role-menu';
  menu.style.left = `${Math.max(8, rect.right - 160)}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  for (const role of TT.roles) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = role;
    btn.classList.toggle('is-current-role', role === ttState.viewer);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ttSetViewer(role);
      ttCloseRoleMenu();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  ttState.roleMenu = menu;
  const onPointerDown = (ev) => {
    if (menu.contains(ev.target) || anchorEl.contains(ev.target)) return;
    ttCloseRoleMenu();
    document.removeEventListener('pointerdown', onPointerDown, true);
  };
  setTimeout(() => document.addEventListener('pointerdown', onPointerDown, true), 0);
}

function ttSetViewer(role) {
  if (!TT.roles.includes(role) || ttState.viewer === role) {
    ttUpdateRoleSwitchButtons();
    return;
  }
  ttState.viewer = role;
  localStorage.setItem('tt-viewer', role);
  ttUpdateHeaderRole();
  ttUpdateRoleSwitchButtons();
  ttRenderBalanceBadge();
  ttRenderBoard();
  if (ttState.detailTaskId) ttRenderDetail(ttGetTask(ttState.detailTaskId));
  if (ttState.transferTaskId) ttUpdateTransferButtons(ttGetTask(ttState.transferTaskId));
}

function ttCanHandoffTask(task) {
  if (!task || task.status === 'cancelled') return false;
  if (ttState.detailTaskId === task.id || ttState.transferTaskId === task.id) return true;
  if (ttState.handoffTaskId === task.id) return true;
  return ttIsTaskOwner(task);
}

function ttIsTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

const TT_POPUP_LAYERS = [
  'mc-project-overlay',
  'tt-feature-overlay',
  'tt-create-overlay',
  'tt-transfer-overlay',
  'tt-motivation-overlay',
  'tt-detail-overlay',
  'tt-board-overlay',
];

function ttPopupIsOpen(id) {
  return document.getElementById(id)?.classList.contains('open') ?? false;
}

function ttPopupHistoryPush(layerId) {
  ttState.popupHistoryDepth = (ttState.popupHistoryDepth || 0) + 1;
  history.pushState({ ttPopupLayer: layerId }, '');
}

function ttPopupHistoryPop(fromPopstate) {
  if ((ttState.popupHistoryDepth || 0) <= 0) return;
  ttState.popupHistoryDepth--;
  if (!fromPopstate) {
    ttState.popupHistoryIgnore = (ttState.popupHistoryIgnore || 0) + 1;
    history.back();
  }
}

function ttPopupHistoryReset(fromPopstate) {
  const n = ttState.popupHistoryDepth || 0;
  if (n <= 0) return;
  ttState.popupHistoryDepth = 0;
  if (!fromPopstate) {
    ttState.popupHistoryIgnore = (ttState.popupHistoryIgnore || 0) + n;
    history.go(-n);
  }
}

function ttTopOpenPopupLayer() {
  for (const id of TT_POPUP_LAYERS) {
    if (ttPopupIsOpen(id)) return id;
  }
  return null;
}

function ttDismissFloatingMenus() {
  if (ttState.ctxMenu) {
    ttCloseCtxMenu();
    return true;
  }
  if (ttState.statusMenu) {
    ttCloseStatusMenu();
    return true;
  }
  if (ttState.roleMenu) {
    ttCloseRoleMenu();
    return true;
  }
  return false;
}

function ttDismissInlineOverlays() {
  if (ttState.editingCommentId) {
    ttState.editingCommentId = null;
    if (ttState.detailTaskId) ttRenderDetail(ttGetTask(ttState.detailTaskId));
    return true;
  }
  if (ttState.manualEditing) {
    ttSetManualEditMode(false);
    return true;
  }
  return false;
}

function ttClosePopupLayer(id, opts = {}) {
  switch (id) {
    case 'tt-transfer-overlay':
      ttCloseTransferPopup(opts);
      break;
    case 'tt-create-overlay':
      ttCloseCreateTask(opts);
      break;
    case 'tt-feature-overlay':
      ttCloseFeaturePicker([], opts);
      break;
    case 'tt-motivation-overlay':
      ttCloseMotivation(opts);
      break;
    case 'tt-detail-overlay':
      ttCloseDetail(opts);
      break;
    case 'tt-board-overlay':
      ttCloseBoard(opts);
      break;
    case 'mc-project-overlay':
      if (typeof mcCloseProjectPopup === 'function') mcCloseProjectPopup(opts);
      break;
    default:
      break;
  }
}

function ttDismissTopOverlay(opts = {}) {
  if (ttDismissFloatingMenus()) return true;
  if (ttDismissInlineOverlays()) return true;
  const id = ttTopOpenPopupLayer();
  if (!id) return false;
  ttClosePopupLayer(id, opts);
  return true;
}

function ttWirePopupDismiss() {
  if (ttState.popupDismissWired) return;
  ttState.popupDismissWired = true;

  window.addEventListener('popstate', () => {
    const ignore = ttState.popupHistoryIgnore || 0;
    if (ignore > 0) {
      ttState.popupHistoryIgnore = ignore - 1;
      return;
    }
    if ((ttState.popupHistoryDepth || 0) > 0) {
      ttState.popupHistoryDepth--;
    }
    ttDismissTopOverlay({ fromPopstate: true });
  });

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.repeat) return;
    if (e.key !== 'Escape') return;
    const hasPopup = !!ttTopOpenPopupLayer()
      || ttState.ctxMenu || ttState.statusMenu || ttState.roleMenu
      || ttState.manualEditing || ttState.editingCommentId;
    if (!hasPopup) return;
    e.preventDefault();
    ttDismissTopOverlay();
  });
}

function ttHandoffHotkeyRole(key) {
  const map = { 1: 'AI_Agent', 2: 'Developer', 3: 'QA_Engineer' };
  return map[key] || null;
}

function ttWireHandoffHotkeys() {
  if (ttState.handoffHotkeysWired) return;
  ttState.handoffHotkeysWired = true;
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.repeat) return;
    if (!ttState.detailTaskId && !ttState.transferTaskId) return;

    const roleFromDigit = ttHandoffHotkeyRole(Number(e.key));
    const altRole = e.altKey ? ttHandoffHotkeyRole(Number(e.key)) : null;
    const typing = ttIsTypingTarget(document.activeElement);

    if (altRole || (!typing && roleFromDigit)) {
      e.preventDefault();
      ttSetViewer(altRole || roleFromDigit);
      return;
    }
    if (e.altKey && e.key === 'Enter') {
      e.preventDefault();
      if (ttState.detailTaskId) ttDoTransfer(true);
      else if (ttState.transferTaskId) ttDoTransfer(false);
    }
  });
}

function ttBeginHandoff(taskId) {
  ttState.handoffTaskId = taskId;
}

function ttEndHandoff() {
  ttState.handoffTaskId = null;
}

/** TT-проект, выбранный в шапке (игра или makecode-arcade для UI). */
function ttActiveProject() {
  if (typeof MC !== 'undefined' && MC.activeSlug) return MC.activeSlug;
  return localStorage.getItem('mc-active-game') || TT.boardProject;
}

function ttMatchesProjectFilter(task) {
  return !!task && task.project === ttActiveProject();
}

function ttOnActiveProjectChange() {
  const openId = ttState.detailTaskId;
  if (openId) {
    const t = ttGetTask(openId);
    if (t && t.project !== ttActiveProject()) ttCloseDetail();
  }
  ttLoadProjectList().catch(() => {});
  ttLoadTasks().catch(() => {});
}

function ttProjectLabel(slug) {
  if (!slug) return '—';
  if (slug === TT.boardProject) return 'Система заявок';
  if (typeof MC !== 'undefined') {
    const game = MC.localGames?.find((g) => g.slug === slug);
    if (game?.name) return game.name;
  }
  return slug;
}

async function ttLoadProjectList() {
  try {
    const list = await ttApi('/projects');
    const merged = new Set(Array.isArray(list) ? list : []);
    merged.add(TT.boardProject);
    if (typeof MC !== 'undefined') {
      for (const g of MC.localGames || []) merged.add(g.slug);
    }
    ttState.projectList = [...merged].sort((a, b) =>
      ttProjectLabel(a).localeCompare(ttProjectLabel(b), 'ru'));
  } catch {
    ttState.projectList = [TT.boardProject, ttActiveProject()].filter((v, i, a) => a.indexOf(v) === i);
  }
}

function ttProjectMoveTargets(task) {
  if (!task) return [];
  const current = task.project || ttActiveProject();
  return (ttState.projectList.length ? ttState.projectList : [current])
    .filter((slug) => slug && slug !== current);
}

async function ttDoMoveProject(taskId, target) {
  const task = ttGetTask(taskId);
  if (!task || !target || target === task.project) return;
  if (!ttIsTaskOwner(task)) {
    ttNotify('Только текущий исполнитель может перенести задачу', 'system');
    return;
  }
  if (!confirm(`Перенести задачу в проект «${ttProjectLabel(target)}» (${target})?`)) return;
  try {
    const updated = await ttApi(`/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ project: target }),
    });
    if (updated.project !== ttActiveProject()) {
      ttState.tasks = ttState.tasks.filter((t) => t.id !== taskId);
      ttCloseDetail();
    } else {
      ttReplaceTask(updated);
      ttRenderDetail(updated);
    }
    ttUpdatePassCounter();
    ttRenderBoard();
    ttNotify(`↪ Перенесено в проект: ${ttProjectLabel(target)}`, 'system');
  } catch (err) {
    ttNotify('⚠️ ' + err.message, 'system');
  }
}

function ttColumnForTask(task, viewer = ttState.viewer) {
  if (!ttMatchesProjectFilter(task)) return null;

  if (ttEffectiveShowAll()) {
    if (task.deleted) return 'cancelled';
    const st = task.status || 'open';
    if (st === 'cancelled') return 'cancelled';
    return st;
  }

  if (task.deleted) return null;

  const viewerStatus = ttViewerTaskStatus(task, viewer);
  if (viewerStatus === 'done' || viewerStatus === 'cancelled') return null;
  if (task.status === 'cancelled') return null;

  if (!ttTaskParticipants(task).includes(viewer)) return null;
  if (!ttIsTaskOwner(task, viewer)) return null;

  return viewerStatus;
}

function ttTaskSearchText(task) {
  const shortId = String(task.id || '').replace(/^#/, '').slice(0, 8);
  return [
    task.title,
    task.description,
    task.assignee,
    task.created_by,
    task.id,
    shortId,
    `#${shortId}`,
    ...(task.tags || []),
    ...(task.comments || []).map(c => {
      const cid = String(c.id || '').replace(/^#/, '').slice(0, 8);
      return `${c.author} ${c.text} ${c.id} ${cid} #${cid}`;
    }),
  ].join('\n').toLowerCase();
}

function ttNormalizeSearchQuery(raw) {
  let q = String(raw || '').trim().toLowerCase();
  if (!q) return '';
  // Copied short ids always include '#'; match both forms.
  if (q.startsWith('#')) q = q.slice(1).trim();
  return q;
}

function ttMatchesSearch(task) {
  const q = ttNormalizeSearchQuery(ttState.searchQuery);
  if (!q) return true;
  const text = ttTaskSearchText(task);
  if (text.includes(q)) return true;
  if (text.includes(`#${q}`)) return true;
  return false;
}

function ttMatchesTagFilter(task) {
  const tag = ttNormalizeTag(ttState.tagFilter);
  if (!tag) return true;
  return ttTaskDisplayTags(task).some(t => ttTagKey(t) === ttTagKey(tag));
}

function ttVisibleTasks(viewer = ttState.viewer) {
  return ttState.tasks.filter(t => {
    if (!ttMatchesProjectFilter(t)) return false;
    if (!ttMatchesSearch(t)) return false;
    if (!ttMatchesTagFilter(t)) return false;
    if (t.deleted && !ttEffectiveShowAll()) return false;
    return ttColumnForTask(t, viewer) !== null;
  });
}

function ttTagFilteredTasks() {
  const tag = ttNormalizeTag(ttState.tagFilter);
  if (!tag) return [];
  return ttState.tasks.filter(t => {
    if (t.deleted && !ttState.showTrash) return false;
    return ttTaskDisplayTags(t).some(x => ttTagKey(x) === ttTagKey(tag));
  }).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

function ttSetTagFilter(tag, { open = true } = {}) {
  const name = ttNormalizeTag(tag);
  if (!name) {
    ttState.tagFilter = null;
    ttState.tagReplayIndex = 0;
    ttRenderTagFilterBar();
    ttRenderBoard();
    return;
  }
  ttState.tagFilter = name;
  const list = ttTagFilteredTasks();
  ttState.tagReplayIndex = 0;
  ttRenderTagFilterBar();
  ttRenderBoard();
  if (open && list.length) ttOpenDetail(list[0].id);
  ttNotify(`#${name} · ${list.length} задач`, 'system');
}

function ttClearTagFilter() {
  ttSetTagFilter(null);
}

function ttReplayTag(delta = 1) {
  const list = ttTagFilteredTasks();
  if (!list.length) {
    ttNotify('Нет задач с этим тегом', 'system');
    return;
  }
  let idx = list.findIndex(t => t.id === ttState.detailTaskId);
  if (idx < 0) idx = ttState.tagReplayIndex || 0;
  idx = (idx + delta + list.length) % list.length;
  ttState.tagReplayIndex = idx;
  ttRenderTagFilterBar();
  ttOpenDetail(list[idx].id);
}

function ttRenderTagFilterBar() {
  let bar = document.getElementById('tt-tag-filter-bar');
  if (!bar) {
    const body = document.getElementById('tt-board-body');
    if (!body) return;
    bar = document.createElement('div');
    bar.id = 'tt-tag-filter-bar';
    bar.className = 'tt-tag-filter-bar';
    body.insertBefore(bar, body.firstChild);
  }
  const tag = ttNormalizeTag(ttState.tagFilter);
  if (!tag) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  const list = ttTagFilteredTasks();
  let idx = list.findIndex(t => t.id === ttState.detailTaskId);
  if (idx < 0) idx = Math.min(ttState.tagReplayIndex || 0, Math.max(0, list.length - 1));
  bar.hidden = false;
  bar.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'tt-tag-filter-label';
  label.textContent = `#${tag}`;
  const count = document.createElement('span');
  count.className = 'tt-tag-filter-count';
  count.textContent = list.length ? `${idx + 1}/${list.length}` : '0';
  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'tt-icon-btn tt-icon-btn-subtle';
  prev.title = 'Предыдущая по тегу';
  prev.textContent = '◀';
  prev.disabled = list.length < 2;
  prev.addEventListener('click', () => ttReplayTag(-1));
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'tt-icon-btn tt-icon-btn-subtle';
  next.title = 'Следующая по тегу (replay)';
  next.textContent = '▶';
  next.disabled = list.length < 2;
  next.addEventListener('click', () => ttReplayTag(1));
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'tt-icon-btn tt-icon-btn-subtle';
  clear.title = 'Сбросить фильтр тега';
  clear.textContent = '✕';
  clear.addEventListener('click', () => ttClearTagFilter());
  bar.append(prev, label, count, next, clear);
}

function ttFormatPoints(task) {
  return String(Number(task?.points) || 1);
}

function ttFormatDateRange(fromIso, toIso) {
  const from = ttFormatDate(fromIso);
  if (!from) return '';
  if (!toIso || toIso === fromIso) return from;
  try {
    const a = new Date(fromIso);
    const b = new Date(toIso);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return from;
    const sameDay = a.toDateString() === b.toDateString();
    const pad = (n) => String(n).padStart(2, '0');
    const t = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (sameDay && t(a) !== t(b)) {
      const day = from.replace(/,.*$/, '');
      return `${day}, ${t(a)}-${t(b)}`;
    }
    if (sameDay) return from;
    return `${from} – ${ttFormatDate(toIso)}`;
  } catch {
    return from;
  }
}

function ttMotivationTypeLabel(type) {
  return ({
    task_estimate: 'План задачи',
    comment_effort: 'Трудозатраты',
    payout: 'Выплата',
    adjust: 'Корректировка',
  })[type] || type;
}

function ttIsAgentStartComment(c) {
  return c?.author === 'AI_Agent' && /tt-agent-worker:\s*старт/i.test(c?.text || '');
}

function ttRenderAgentStartCommentHtml(text) {
  const raw = String(text || '');
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const firstLine = lines[0] || '';
  const rest = lines.slice(1);
  let html = `<span class="tt-agent-start-label">${ttInlineMd(firstLine)}</span>`;
  if (rest.some((l) => l.trim())) {
    html += `<div class="tt-agent-start-meta">${rest.map((l) => ttInlineMd(l)).join('<br>')}</div>`;
  }
  html += '<div class="tt-agent-thinking" aria-hidden="true"><span></span><span></span><span></span></div>';
  return html;
}

function ttIsAgentWorkingTask(taskId) {
  return !!(taskId && ttState.agentActiveTaskId && taskId === ttState.agentActiveTaskId);
}

function ttApplyAgentWorkingUi() {
  const taskId = ttState.agentActiveTaskId;
  document.querySelectorAll('.tt-card[data-task-id]').forEach((card) => {
    card.classList.toggle('tt-agent-working', taskId && card.dataset.taskId === taskId);
  });
  const popup = document.getElementById('tt-detail-popup');
  if (popup) {
    popup.classList.toggle('tt-agent-working', taskId && ttState.detailTaskId === taskId);
  }
  document.querySelectorAll('#tt-detail-comments .tt-comment[data-agent-start="1"]').forEach((block) => {
    block.classList.toggle('tt-agent-start-active', taskId && ttState.detailTaskId === taskId);
  });
}

async function ttPollWorkerStatus() {
  try {
    const r = await fetch('/api/worker/status');
    const data = await r.json();
    const prev = ttState.agentActiveTaskId;
    const next = data.activeTaskId || null;
    if (next !== prev) {
      if (prev && !next) ttPlaySound('agent-done');
      ttState.agentActiveTaskId = next;
      ttApplyAgentWorkingUi();
    }
  } catch (_) {}
}

function ttRenderStackBanner(st) {
  const el = document.getElementById('tt-stack-banner');
  if (!el) return;
  const ttOk = st?.tt?.ok !== false;
  const workerOk = st?.worker?.running !== false;
  const webhookOk = st?.webhook?.enabled !== false;
  ttState.stackOk = ttOk && webhookOk;
  if (ttOk && workerOk && webhookOk) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  const parts = [];
  if (!ttOk) parts.push('Task Tracker (:3100) не запущен — задачи не сохраняются');
  if (!workerOk) parts.push('AI-воркер (:9080) не запущен');
  if (ttOk && workerOk && !webhookOk) parts.push('Webhook агента выключен — передача AI_Agent не запустит воркер (🔄)');
  el.textContent = parts.join(' · ') + '. Нажмите 🔄 или перезапустите node server.js';
  el.hidden = false;
}

async function ttPollStackStatus() {
  try {
    const r = await fetch('/api/stack/status');
    const data = await r.json();
    ttRenderStackBanner(data);
    return data;
  } catch (_) {
    ttRenderStackBanner({ tt: { ok: false }, worker: { running: false } });
    return null;
  }
}

function ttStartStackPoll() {
  if (ttState.stackPoll) return;
  ttPollStackStatus();
  ttState.stackPoll = setInterval(() => {
    ttPollStackStatus().catch(() => {});
  }, TT.workerPollMs);
}

function ttStartWorkerPoll() {
  if (ttState.workerPoll) return;
  ttPollWorkerStatus();
  ttState.workerPoll = setInterval(() => {
    ttPollWorkerStatus().catch(() => {});
  }, TT.workerPollMs);
}

function ttCardClass(task, viewer = ttState.viewer) {
  if (task?.deleted) return 'closed';
  const col = ttColumnForTask(task, viewer);
  if (col === 'cancelled') return 'closed';
  if (col === 'in_progress') return 'in-progress';
  if (col === 'done') return 'ready';
  return 'needs-work';
}

function ttMergeParticipants(task, updates) {
  const extra = [ttState.viewer, updates.assignee].filter(Boolean);
  return { ...updates, participants: ttEnsureParticipants(task, ...extra) };
}

function ttShortId(id) {
  return '#' + String(id || '').replace(/^#/, '').slice(0, 8);
}

function ttFormatCommentId(id, versionLabel) {
  const short = ttShortId(id);
  if (!short || short === '#') return '';
  return versionLabel ? `${versionLabel} · ${short}` : short;
}

function ttIsManualTask(task) {
  return (task?.tags || []).includes('manual');
}

function ttCanManageManualTask(task) {
  if (!ttIsManualTask(task)) return false;
  if (task?.created_by) return task.created_by === ttState.viewer;
  return task?.assignee === ttState.viewer;
}

function ttFormatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function ttGetTask(id) {
  return ttState.tasks.find(t => t.id === id);
}

function ttReplaceTask(updated) {
  const idx = ttState.tasks.findIndex(t => t.id === updated.id);
  if (idx >= 0) ttState.tasks[idx] = updated;
  else ttState.tasks.push(updated);
}

async function ttLoadTasks() {
  ttCaptureDraftFromDom();
  const editingId = ttState.editingCommentId;
  const editDraft = editingId ? ttState.commentEditDrafts[editingId] : null;
  const selStart = editingId ? ttState.commentEditSelStart : null;
  const selEnd = editingId ? ttState.commentEditSelEnd : null;
  const draftFocused = document.activeElement?.id === 'tt-comment-input';
  const bodyScroll = document.getElementById('tt-detail-body')?.scrollTop;

  ttState.tasks = await ttApi(`/projects/${encodeURIComponent(ttActiveProject())}/tasks`);
  ttHarvestTagsFromTasks();
  // User may have typed during the await — re-read live DOM before any restore.
  ttCaptureDraftFromDom();
  ttUpdatePassCounter();
  ttRenderBoard();
  ttLoadBalances().catch(() => {});
  if (ttState.detailTaskId) {
    ttRenderDetail(ttGetTask(ttState.detailTaskId), {
      preserveDraftFocus: draftFocused,
      bodyScroll,
    });
    if (editingId && editDraft != null) {
      ttState.commentEditDrafts[editingId] = editDraft;
      const ta = document.querySelector(`#tt-detail-comments .tt-comment[data-comment-id="${editingId}"] .tt-comment-edit`);
      if (ta) {
        ta.focus({ preventScroll: true });
        const start = selStart ?? ta.value.length;
        const end = selEnd ?? ta.value.length;
        try { ta.setSelectionRange(start, end); } catch (_) {}
      }
    }
  }
}

async function ttDeleteTask(id) {
  const updated = await ttApi(`/tasks/${id}`, { method: 'DELETE' });
  if (updated?.id) ttReplaceTask(updated);
  else ttState.tasks = ttState.tasks.filter(t => t.id !== id);
  ttUpdatePassCounter();
  ttRenderBoard();
}

async function ttCreateManualTask(title, description, points = 1, extraTags = []) {
  const titleTags = ttParseTitleTags(title);
  const selected = [...new Set([...titleTags, ...extraTags.map(ttNormalizeTag)].filter(Boolean))];
  selected.forEach(ttEnsureTagInRegistry);
  const payload = {
    project: ttActiveProject(),
    title: ttComposeTitle(ttStripTitleTags(title), selected),
    description: (description || '').trim(),
    assignee: ttState.viewer,
    role: ttState.viewer,
    status: 'open',
    priority: 'medium',
    points: Math.max(1, Math.min(99, Number(points) || 1)),
    tags: ['manual', 'board', ...selected],
    participants: [ttState.viewer],
    created_by: ttState.viewer,
  };
  const task = await ttApi('/tasks', { method: 'POST', body: JSON.stringify(payload) });
  ttReplaceTask(task);
  ttMarkDeviceTask(task.id);
  ttMarkTaskRead(task);
  ttUpdatePassCounter();
  ttRenderBoard();
  return task;
}

async function ttPatchTask(id, updates) {
  const task = ttGetTask(id);
  const payload = ttMergeParticipants(task, updates);
  const updated = await ttApi(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  ttReplaceTask(updated);
  ttUpdatePassCounter();
  ttRenderBoard();
  if (ttState.detailTaskId === id) ttRenderDetail(updated);
  return updated;
}

function ttSetManualEditMode(on) {
  ttState.manualEditing = !!on;
  const form = document.getElementById('tt-detail-edit-form');
  const desc = document.getElementById('tt-detail-desc');
  const detailTags = document.getElementById('tt-detail-tags');
  if (form) form.hidden = !on;
  if (desc) desc.style.display = on ? 'none' : '';
  if (detailTags) detailTags.hidden = !!on;
  if (on) {
    const task = ttGetTask(ttState.detailTaskId);
    ttState.pendingTagDraft = ttTaskDisplayTags(task);
    ttRenderTagPicker('tt-edit-tags', ttState.pendingTagDraft, {
      editable: true,
      onChange: (next) => { ttState.pendingTagDraft = next; },
    });
  }
}

function ttOpenCreateTask() {
  document.getElementById('tt-create-sub').textContent =
    `Исполнитель: ${ttState.viewer} · колонка «Новое»`;
  const titleEl = document.getElementById('tt-create-title');
  const descEl = document.getElementById('tt-create-desc');
  if (titleEl) titleEl.value = '';
  if (descEl) descEl.value = '';
  const pts = document.getElementById('tt-create-points');
  if (pts) pts.value = '1';
  ttState.pendingTagDraft = [];
  ttRenderTagPicker('tt-create-tags', ttState.pendingTagDraft, {
    editable: true,
    onChange: (next) => { ttState.pendingTagDraft = next; },
  });
  document.getElementById('tt-create-overlay').classList.add('open');
  ttPopupHistoryPush('tt-create-overlay');
  ttSyncGrowField(titleEl);
  ttSyncGrowField(descEl);
  setTimeout(() => titleEl?.focus(), 50);
}

function ttCloseCreateTask(opts = {}) {
  const wasOpen = ttPopupIsOpen('tt-create-overlay');
  document.getElementById('tt-create-overlay')?.classList.remove('open');
  if (wasOpen && !opts.skipHistory) ttPopupHistoryPop(opts.fromPopstate);
}

function ttSyncGrowField(el) {
  if (!el) return;
  el.style.height = '24px';
  el.style.height = `${Math.max(36, el.scrollHeight)}px`;
  el.style.overflow = 'hidden';
}

async function ttMaybeFeatureDialogs(tags, titleHint) {
  const hasBug = tags.some(ttIsBugTag);
  const hasFeature = tags.some(ttIsFeatureTag);
  let featureIds = [];
  if (hasBug) {
    const picked = await ttOpenFeaturePicker({
      mode: 'bug',
      title: 'К какой фиче относится баг?',
      sub: 'Выберите узел (можно корневой). Один клик — выбрать, повтор — снять.',
      multi: false,
    });
    if (picked?.length) featureIds = picked;
  }
  if (hasFeature) {
    const parents = await ttOpenFeaturePicker({
      mode: 'feature',
      title: 'Родитель(и) новой фичи',
      sub: 'Выберите связанные модули (можно несколько). Затем подтвердите.',
      multi: true,
    });
    const name = ttStripTitleTags(titleHint || '').slice(0, 80) || 'Новая фича';
    const node = {
      id: 'feat_' + Math.random().toString(36).slice(2, 10),
      name,
      parent_ids: parents || [],
    };
    ttState.features.push(node);
    ttSaveFeatures();
    featureIds = [...new Set([...featureIds, node.id])];
    ttNotify(`✓ Фича «${name}» добавлена в дерево`, 'system');
  }
  return featureIds;
}

async function ttSaveCreateTask() {
  const title = document.getElementById('tt-create-title')?.value?.trim();
  if (!title) {
    ttNotify('Укажите название задачи', 'system');
    return;
  }
  const desc = document.getElementById('tt-create-desc')?.value || '';
  const points = document.getElementById('tt-create-points')?.value || 1;
  const tags = [...new Set([...ttParseTitleTags(title), ...(ttState.pendingTagDraft || [])])];
  try {
    const featureIds = await ttMaybeFeatureDialogs(tags, title);
    const task = await ttCreateManualTask(title, desc, points, tags);
    if (featureIds.length) {
      await ttPatchTask(task.id, { feature_ids: featureIds });
    }
    ttCloseCreateTask();
    ttPlaySound('success');
    ttNotify('✓ Задача создана', 'system');
  } catch (err) {
    ttPlaySound('error');
    ttNotify('⚠️ ' + err.message, 'system');
  }
}

async function ttSaveManualEdit() {
  const task = ttGetTask(ttState.detailTaskId);
  if (!task || !ttCanManageManualTask(task)) return;
  const titleRaw = document.getElementById('tt-edit-title')?.value?.trim();
  if (!titleRaw) {
    ttNotify('Название не может быть пустым', 'system');
    return;
  }
  const description = document.getElementById('tt-edit-desc')?.value || '';
  const tags = [...new Set([...ttParseTitleTags(titleRaw), ...(ttState.pendingTagDraft || [])])];
  tags.forEach(ttEnsureTagInRegistry);
  const system = (task.tags || []).filter(ttIsSystemTag);
  const title = ttComposeTitle(ttStripTitleTags(titleRaw), tags);
  try {
    const featureIds = await ttMaybeFeatureDialogs(tags, titleRaw);
    await ttPatchTask(task.id, {
      title,
      description,
      tags: [...system, ...tags],
      ...(featureIds.length ? { feature_ids: featureIds } : {}),
    });
    ttSetManualEditMode(false);
    ttNotify('✓ Сохранено', 'system');
  } catch (err) {
    ttNotify('⚠️ ' + err.message, 'system');
  }
}

async function ttDeleteManualTask() {
  const task = ttGetTask(ttState.detailTaskId);
  if (!task || !ttCanManageManualTask(task)) return;
  if (!confirm(`Переместить задачу «${task.title}» в корзину?`)) return;
  try {
    await ttDeleteTask(task.id);
    ttCloseDetail();
    ttNotify('🗑 Задача в корзине', 'system');
  } catch (err) {
    ttNotify('⚠️ ' + err.message, 'system');
  }
}

async function ttAddComment(id, author, text, meta = {}) {
  const before = ttGetTask(id);
  const prevIds = new Set((before?.comments || []).map(c => c.id));
  const body = { author, text };
  if (meta.restored_from) body.restored_from = meta.restored_from;
  if (meta.stars != null) body.stars = meta.stars;
  if (meta.composed_from) body.composed_from = meta.composed_from;
  if (meta.composed_to) body.composed_to = meta.composed_to;
  const updated = await ttApi(`/tasks/${id}/comments`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const added = (updated.comments || []).find(c => !c.deleted && !prevIds.has(c.id));
  if (added) {
    ttMarkDeviceComment(added.id);
    ttMarkCommentRead(added);
  }
  ttReplaceTask(updated);
  ttRenderBoard();
  if (ttState.detailTaskId === id) ttRenderDetail(updated);
  ttLoadBalances().catch(() => {});
  ttPlaySound('success');
  return updated;
}

async function ttEditComment(taskId, commentId, text, meta = {}) {
  const body = { text };
  if (meta.restored_from) body.restored_from = meta.restored_from;
  if (meta.deleted === false) body.deleted = false;
  if (meta.stars != null) body.stars = meta.stars;
  if (meta.actor) body.actor = meta.actor;
  if (meta.author !== undefined) body.author = meta.author;
  const updated = await ttApi(`/tasks/${taskId}/comments/${commentId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  ttReplaceTask(updated);
  ttState.editingCommentId = null;
  delete ttState.commentEditDrafts[commentId];
  if (ttState.detailTaskId === taskId) ttRenderDetail(updated);
  ttLoadBalances().catch(() => {});
  return updated;
}

async function ttRemoveComment(taskId, commentId) {
  const updated = await ttApi(`/tasks/${taskId}/comments/${commentId}`, { method: 'DELETE' });
  ttReplaceTask(updated);
  if (ttState.detailTaskId === taskId) ttRenderDetail(updated);
  return updated;
}

async function ttRestoreCommentVersion(task, comment, versionIndex) {
  const versions = ttCommentVersionBlocks(comment, true);
  const ver = versions[versionIndex];
  if (!ver) return;
  const restored_from = {
    comment_id: comment.id,
    version: versionIndex + 1,
    at: ver.at || comment.created_at,
  };
  try {
    // Всегда в том же треде: vN+1, удалённый/старый остаётся в history
    await ttEditComment(task.id, comment.id, ver.text, {
      restored_from,
      deleted: false,
    });
    ttNotify('↩ Версия восстановлена', 'system');
  } catch (err) {
    ttNotify('⚠️ ' + err.message, 'system');
  }
}

function ttCopyToClipboard(text, okMsg) {
  const value = String(text || '');
  const done = () => ttNotify(okMsg || `📋 Скопировано ${value}`, 'system');
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(value).then(done).catch(() => {
      ttFallbackCopy(value);
      done();
    });
  }
  ttFallbackCopy(value);
  done();
  return Promise.resolve();
}

function ttFallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (_) {}
  ta.remove();
}

function ttWireCopyableCodes(root) {
  if (!root) return;
  root.querySelectorAll('code').forEach((code) => {
    if (code.dataset.copyWired) return;
    code.dataset.copyWired = '1';
    ttMakeCopyable(code, code.textContent || '');
  });
}

function ttApplyMonoToTextarea(ta) {
  if (!ta) return;
  const value = ta.value || '';
  let start = ta.selectionStart;
  let end = ta.selectionEnd;
  if (start === end) {
    start = 0;
    end = value.length;
  }
  const selected = value.slice(start, end);
  if (!selected) return;
  const wrapped = selected.startsWith('`') && selected.endsWith('`') && selected.length >= 2
    ? selected.slice(1, -1)
    : `\`${selected}\``;
  ta.value = value.slice(0, start) + wrapped + value.slice(end);
  const caret = start + wrapped.length;
  ta.focus();
  ta.setSelectionRange(caret, caret);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function ttOpenTextFormatCtxMenu(e, ta) {
  ttCloseCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'tt-ctx-menu open';
  const x = e.clientX || e.touches?.[0]?.clientX || 40;
  const y = e.clientY || e.touches?.[0]?.clientY || 40;
  menu.style.left = `${Math.min(x, window.innerWidth - 160)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 100)}px`;

  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      ttCloseCtxMenu();
      fn();
    });
    menu.appendChild(b);
  };
  mk('Моно', () => ttApplyMonoToTextarea(ta));

  document.body.appendChild(menu);
  ttState.ctxMenu = menu;
  const onPointerDown = (ev) => {
    if (!menu.contains(ev.target)) ttCloseCtxMenu();
  };
  const onKeyDown = (ev) => { if (ev.key === 'Escape') ttCloseCtxMenu(); };
  setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
  }, 0);
  ttState.ctxMenuCleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown);
  };
}

function ttBindMonoCtxMenu(ta) {
  if (!ta || ta.dataset.monoBound) return;
  ta.dataset.monoBound = '1';
  ta.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ttOpenTextFormatCtxMenu(e, ta);
  });
  let pressTimer = null;
  ta.addEventListener('touchstart', (e) => {
    pressTimer = setTimeout(() => ttOpenTextFormatCtxMenu(e, ta), 550);
  }, { passive: true });
  ta.addEventListener('touchend', () => { clearTimeout(pressTimer); });
  ta.addEventListener('touchmove', () => { clearTimeout(pressTimer); });
}

function ttMakeCopyable(el, value) {
  if (!el || value == null) return el;
  const text = String(value);
  el.classList.add('tt-copyable');
  el.title = `Копировать ${text}`;
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.dataset.copyValue = text;
  if (el.dataset.copyWired === '1') return el;
  el.dataset.copyWired = '1';
  const copy = (e) => {
    e.preventDefault();
    e.stopPropagation();
    ttCopyToClipboard(el.dataset.copyValue || '');
    el.classList.add('copied');
    setTimeout(() => el.classList.remove('copied'), 700);
  };
  el.addEventListener('click', copy);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') copy(e);
  });
  return el;
}

// ── Status / transfer flow ────────────────────────────────────────
function ttCloseStatusMenu() {
  if (ttState.statusMenu) {
    ttState.statusMenu.remove();
    ttState.statusMenu = null;
  }
}

function ttCloseCtxMenu() {
  if (ttState.ctxMenuCleanup) {
    ttState.ctxMenuCleanup();
    ttState.ctxMenuCleanup = null;
  }
  if (ttState.ctxMenu) {
    ttState.ctxMenu.remove();
    ttState.ctxMenu = null;
  }
  const legacy = document.getElementById('tt-ctx-menu');
  if (legacy) {
    legacy.classList.remove('open');
    legacy.replaceChildren();
  }
}

function ttGetCommentText(fromDetail) {
  const detailText = document.getElementById('tt-comment-input')?.value?.trim() || '';
  const popupText = document.getElementById('tt-transfer-comment')?.value?.trim() || '';
  return fromDetail ? (detailText || popupText) : (popupText || detailText);
}

function ttHasListComment(task) {
  return (task.comments || []).some(c => String(c.text || '').trim());
}

/** Комментарий для передачи/закрытия: новый из поля (опционально) или уже есть в списке задачи. */
async function ttEnsureCommentForAction(task, fromDetail) {
  const pending = ttGetCommentText(fromDetail);
  if (pending) {
    await ttAddComment(task.id, ttState.viewer, pending);
    return true;
  }
  return ttHasListComment(task);
}

function ttPromptCommentInDetail(taskId, reason) {
  ttNotify(`Добавьте комментарий в список (➤) — ${reason}`);
  ttCloseTransferPopup();
  ttOpenDetail(taskId);
  setTimeout(() => document.getElementById('tt-comment-input')?.focus(), 50);
}

function ttFocusDetailTransfer(task) {
  if (task && !ttHasListComment(task)) {
    ttNotifyCommentRequired('transfer');
  } else {
    ttNotify('Выберите роль и нажмите ➜ для передачи');
  }
  document.getElementById('tt-comment-input')?.focus();
  document.getElementById('tt-handoff-group')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function ttApplyStatus(task, status) {
  if (!ttIsTaskOwner(task)) return;
  if (status === 'done') {
    if (ttState.detailTaskId === task.id) {
      ttFocusDetailTransfer(task);
      return;
    }
    ttOpenTransferPopup(task.id, 'transfer');
    return;
  }
  if (status === 'cancelled') {
    if (ttState.detailTaskId === task.id) {
      ttDoClose(false);
      return;
    }
    ttOpenTransferPopup(task.id, 'close');
    return;
  }
  ttPatchTask(task.id, { status, assignee: ttState.viewer }).catch(err => {
    ttNotify('⚠️ ' + err.message, 'system');
  });
}

function ttAdvanceStatus(task) {
  if (!ttIsTaskOwner(task)) return;
  const next = TT.nextStatus[task.status];
  if (!next) return;
  if (next === 'done') {
    if (ttState.detailTaskId === task.id) {
      ttFocusDetailTransfer(task);
      return;
    }
    ttOpenTransferPopup(task.id, 'transfer');
    return;
  }
  ttPatchTask(task.id, { status: next, assignee: ttState.viewer }).catch(err => {
    ttNotify('⚠️ ' + err.message, 'system');
  });
}

function ttOpenStatusMenu(task, anchorEl) {
  ttCloseStatusMenu();
  const menu = document.createElement('div');
  menu.className = 'tt-status-select open';
  const rect = anchorEl.getBoundingClientRect();
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 4}px`;

  for (const col of TT.columns) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = col.label;
    btn.disabled = ttViewerTaskStatus(task) === col.key;
    btn.onclick = (e) => {
      e.stopPropagation();
      ttCloseStatusMenu();
      ttApplyStatus(task, col.key);
    };
    menu.appendChild(btn);
  }

  menu.addEventListener('click', e => e.stopPropagation());
  document.body.appendChild(menu);
  ttState.statusMenu = menu;
  setTimeout(() => document.addEventListener('click', ttCloseStatusMenu, { once: true }), 0);
}

function ttRenderBadge(task, container) {
  const owner = ttIsTaskOwner(task);
  const viewerStatus = ttViewerTaskStatus(task);
  const badge = document.createElement('span');
  badge.className = `tt-badge ${task.deleted ? 'cancelled' : (owner ? viewerStatus : (task.status === 'done' ? 'done' : 'cancelled'))}`;
  if (!owner && !task.deleted) badge.classList.add('tt-badge-passive');
  badge.onclick = e => e.stopPropagation();

  const label = document.createElement('span');
  label.className = 'tt-badge-label';
  if (task.deleted) {
    label.textContent = 'Корзина';
    label.title = 'Удалена · колонка Закрыта';
  } else if (owner) {
    label.textContent = TT.statusLabels[viewerStatus] || viewerStatus;
    label.title = 'Выбрать статус';
    label.onclick = (e) => {
      e.stopPropagation();
      ttOpenStatusMenu(task, label);
    };
  } else {
    label.textContent = TT.statusLabels[task.status] || task.status;
    label.title = `Сейчас у ${task.assignee || '—'}`;
    label.onclick = (e) => {
      e.stopPropagation();
      ttOpenDetail(task.id);
    };
  }
  badge.appendChild(label);

  if (!task.deleted && owner && TT.nextStatus[viewerStatus]) {
    const arrow = document.createElement('span');
    arrow.className = 'tt-badge-arrow';
    arrow.textContent = '▶';
    arrow.title = 'Следующий статус';
    arrow.onclick = (e) => {
      e.stopPropagation();
      ttAdvanceStatus(task);
    };
    badge.appendChild(arrow);
  }

  container.appendChild(badge);
  return badge;
}

function ttMakeTagEl(tag, { active = true, onClick, onContext } = {}) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'tt-tag ' + (active ? 'tt-tag-active' : 'tt-tag-inactive');
  el.textContent = `#${ttNormalizeTag(tag)}`;
  if (active) {
    const c = ttTagColor(tag);
    el.style.background = c.bg;
    el.style.borderColor = c.border;
    el.style.color = c.fg;
  }
  el.title = active ? `#${ttNormalizeTag(tag)}` : `Добавить #${ttNormalizeTag(tag)}`;
  if (onClick) el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(e); });
  if (onContext) {
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); onContext(e); });
    let pressTimer = null;
    el.addEventListener('touchstart', (e) => {
      pressTimer = setTimeout(() => onContext(e), 550);
    }, { passive: true });
    el.addEventListener('touchend', () => { clearTimeout(pressTimer); });
    el.addEventListener('touchmove', () => { clearTimeout(pressTimer); });
  }
  return el;
}

function ttRenderTagPicker(containerId, selectedTags, { editable = false, onChange, showRegistry } = {}) {
  const host = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
  if (!host) return;
  host.innerHTML = '';
  const selected = (selectedTags || []).map(ttNormalizeTag);
  const selectedKeys = new Set(selected.map(ttTagKey));
  const registryVisible = showRegistry ?? editable;

  for (const tag of selected) {
    host.appendChild(ttMakeTagEl(tag, {
      active: true,
      onClick: editable ? () => {
        const next = selected.filter(t => ttTagKey(t) !== ttTagKey(tag));
        onChange?.(next);
        ttRenderTagPicker(host, next, { editable, onChange, showRegistry: registryVisible });
      } : undefined,
      onContext: (e) => ttOpenTagCtxMenu(e, tag, { selected, onChange, host, editable, showRegistry: registryVisible }),
    }));
  }

  if (registryVisible) {
    for (const tag of ttState.tagRegistry) {
      if (selectedKeys.has(ttTagKey(tag))) continue;
      host.appendChild(ttMakeTagEl(tag, {
        active: false,
        onClick: editable ? () => {
          const next = [...selected, ttNormalizeTag(tag)];
          onChange?.(next);
          ttRenderTagPicker(host, next, { editable, onChange, showRegistry: registryVisible });
        } : undefined,
        onContext: (e) => ttOpenTagCtxMenu(e, tag, { selected, onChange, host, editable, showRegistry: registryVisible }),
      }));
    }
  }

  if (editable) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'tt-tag-add';
    add.textContent = '+';
    add.title = 'Создать тег';
    add.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ttCreateTagPrompt({ selected, onChange, host, editable, showRegistry: registryVisible });
    });
    host.appendChild(add);
  }
}

function ttOpenTagCtxMenu(e, tag, ctx) {
  ttCloseCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'tt-ctx-menu open';
  const x = e.clientX || e.touches?.[0]?.clientX || 40;
  const y = e.clientY || e.touches?.[0]?.clientY || 40;
  menu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 160)}px`;

  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ttCloseCtxMenu();
      await fn();
    });
    menu.appendChild(b);
  };

  mk('Перейти', () => {
    ttSetTagFilter(tag, { open: true });
  });
  mk('Создать новый', () => ttCreateTagPrompt(ctx));
  mk('Копировать', async () => {
    const base = ttNormalizeTag(tag);
    let n = 2;
    let name = `${base}_${n}`;
    while (ttState.tagRegistry.some(t => ttTagKey(t) === ttTagKey(name))) {
      n += 1;
      name = `${base}_${n}`;
    }
    ttEnsureTagInRegistry(name);
    await ttAddTagToMatchingTasks(base, name);
    ttNotify(`✓ Скопирован тег #${name}`, 'system');
    ttRefreshTagUi(ctx);
  });
  mk('Переименовать', async () => {
    const next = prompt('Новое имя тега (без # и пробелов)', ttNormalizeTag(tag));
    if (!next) return;
    const name = ttNormalizeTag(next).replace(/\s+/g, '_');
    if (!name) return;
    await ttRenameTagEverywhere(ttNormalizeTag(tag), name);
    ttNotify(`✓ Тег переименован в #${name}`, 'system');
    ttRefreshTagUi(ctx);
  });
  mk('Удалить', async () => {
    if (!confirm(`Удалить тег #${ttNormalizeTag(tag)} у всех задач?`)) return;
    await ttDeleteTagEverywhere(ttNormalizeTag(tag));
    ttNotify('✓ Тег удалён', 'system');
    ttRefreshTagUi(ctx);
  });

  document.body.appendChild(menu);
  ttState.ctxMenu = menu;
  const onPointerDown = (ev) => {
    if (!menu.contains(ev.target)) ttCloseCtxMenu();
  };
  const onKeyDown = (ev) => { if (ev.key === 'Escape') ttCloseCtxMenu(); };
  setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
  }, 0);
  ttState.ctxMenuCleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown);
  };
}

function ttRefreshTagUi(ctx) {
  if (ctx?.host && ctx.onChange) {
    ttRenderTagPicker(ctx.host, ctx.selected || ttState.pendingTagDraft, {
      editable: !!ctx.editable,
      onChange: ctx.onChange,
    });
  }
  ttRenderBoard();
  if (ttState.detailTaskId) ttRenderDetail(ttGetTask(ttState.detailTaskId));
}

function ttCreateTagPrompt(ctx) {
  const raw = prompt('Имя нового тега (без # и пробелов)', 'Идея');
  if (!raw) return;
  const name = ttNormalizeTag(raw).replace(/\s+/g, '_');
  if (!name) return;
  ttEnsureTagInRegistry(name);
  const selected = [...(ctx?.selected || ttState.pendingTagDraft || [])];
  if (!selected.some(t => ttTagKey(t) === ttTagKey(name))) selected.push(name);
  ctx?.onChange?.(selected);
  ttState.pendingTagDraft = selected;
  ttRefreshTagUi({ ...ctx, selected });
}

async function ttRenameTagEverywhere(from, to) {
  ttEnsureTagInRegistry(to);
  ttState.tagRegistry = ttState.tagRegistry
    .map(t => (ttTagKey(t) === ttTagKey(from) ? to : t))
    .filter((t, i, arr) => arr.findIndex(x => ttTagKey(x) === ttTagKey(t)) === i);
  ttSaveTagRegistry();
  for (const task of ttState.tasks || []) {
    const tags = ttTaskDisplayTags(task);
    if (!tags.some(t => ttTagKey(t) === ttTagKey(from))) continue;
    const nextTags = tags.map(t => (ttTagKey(t) === ttTagKey(from) ? to : t));
    const system = (task.tags || []).filter(ttIsSystemTag);
    const title = ttComposeTitle(ttStripTitleTags(task.title), nextTags);
    await ttPatchTask(task.id, { title, tags: [...system, ...nextTags] });
  }
}

async function ttDeleteTagEverywhere(name) {
  ttState.tagRegistry = ttState.tagRegistry.filter(t => ttTagKey(t) !== ttTagKey(name));
  ttSaveTagRegistry();
  for (const task of ttState.tasks || []) {
    const tags = ttTaskDisplayTags(task);
    if (!tags.some(t => ttTagKey(t) === ttTagKey(name))) continue;
    const nextTags = tags.filter(t => ttTagKey(t) !== ttTagKey(name));
    const system = (task.tags || []).filter(ttIsSystemTag);
    const title = ttComposeTitle(ttStripTitleTags(task.title), nextTags);
    await ttPatchTask(task.id, { title, tags: [...system, ...nextTags] });
  }
}

async function ttAddTagToMatchingTasks(from, to) {
  ttEnsureTagInRegistry(to);
  for (const task of ttState.tasks || []) {
    const tags = ttTaskDisplayTags(task);
    if (!tags.some(t => ttTagKey(t) === ttTagKey(from))) continue;
    if (tags.some(t => ttTagKey(t) === ttTagKey(to))) continue;
    const nextTags = [...tags, to];
    const system = (task.tags || []).filter(ttIsSystemTag);
    const title = ttComposeTitle(ttStripTitleTags(task.title), nextTags);
    await ttPatchTask(task.id, { title, tags: [...system, ...nextTags] });
  }
}

function ttFeatureChildrenMap() {
  const byParent = new Map();
  for (const f of ttState.features) {
    const parents = f.parent_ids?.length ? f.parent_ids : [null];
    for (const p of parents) {
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(f);
    }
  }
  return byParent;
}

function ttOpenFeaturePicker({ mode, title, sub, multi }) {
  return new Promise((resolve) => {
    ttState.featurePickMode = mode;
    ttState.featurePickSelected = new Set();
    ttState.featurePickResolve = resolve;
    document.getElementById('tt-feature-title').textContent = title;
    document.getElementById('tt-feature-sub').textContent = sub;
    const search = document.getElementById('tt-feature-search');
    if (search) search.value = '';
    ttRenderFeatureTree(multi);
    document.getElementById('tt-feature-overlay')?.classList.add('open');
    ttPopupHistoryPush('tt-feature-overlay');
  });
}

function ttCloseFeaturePicker(result, opts = {}) {
  const wasOpen = ttPopupIsOpen('tt-feature-overlay');
  document.getElementById('tt-feature-overlay')?.classList.remove('open');
  const resolve = ttState.featurePickResolve;
  ttState.featurePickResolve = null;
  ttState.featurePickMode = null;
  resolve?.(result || []);
  if (wasOpen && !opts.skipHistory) ttPopupHistoryPop(opts.fromPopstate);
}

function ttRenderFeatureTree(multi) {
  const host = document.getElementById('tt-feature-tree');
  if (!host) return;
  host.innerHTML = '';
  const q = (document.getElementById('tt-feature-search')?.value || '').trim().toLowerCase();
  const byParent = ttFeatureChildrenMap();
  const renderLevel = (parentId, depth) => {
    const nodes = byParent.get(parentId) || [];
    for (const node of nodes) {
      if (q && !String(node.name).toLowerCase().includes(q) && !ttFeatureSubtreeMatch(node.id, q, byParent)) {
        // still show if ancestor path needed — skip leaf miss
        if (!ttFeatureHasMatchInBranch(node.id, q, byParent)) continue;
      }
      const row = document.createElement('div');
      row.className = 'tt-feature-node' + (ttState.featurePickSelected.has(node.id) ? ' selected' : '');
      row.style.paddingLeft = `${8 + depth * 14}px`;
      row.innerHTML = `<span class="pad">${'·'.repeat(Math.min(depth, 3))}</span>${ttEscapeHtml(node.name)} <span style="color:#64748b;font-size:10px">${ttShortId(node.id)}</span>`;
      row.addEventListener('click', () => {
        if (multi) {
          if (ttState.featurePickSelected.has(node.id)) ttState.featurePickSelected.delete(node.id);
          else ttState.featurePickSelected.add(node.id);
        } else {
          ttState.featurePickSelected = new Set([node.id]);
        }
        ttRenderFeatureTree(multi);
      });
      host.appendChild(row);
      renderLevel(node.id, depth + 1);
    }
  };
  renderLevel(null, 0);
  if (!host.childNodes.length) {
    host.innerHTML = '<div class="tt-empty">Фич пока нет — создайте через задачу с #Фича</div>';
  }
}

function ttFeatureSubtreeMatch(id, q, byParent) {
  return ttFeatureHasMatchInBranch(id, q, byParent);
}

function ttFeatureHasMatchInBranch(id, q, byParent) {
  const node = ttState.features.find(f => f.id === id);
  if (node && String(node.name).toLowerCase().includes(q)) return true;
  for (const child of byParent.get(id) || []) {
    if (ttFeatureHasMatchInBranch(child.id, q, byParent)) return true;
  }
  return false;
}

function ttRenderCard(task) {
  const card = document.createElement('div');
  card.className = `tt-card ${ttCardClass(task)}`;
  card.dataset.taskId = task.id;
  if (ttTaskUnread(task)) card.classList.add('tt-unread');
  if (!ttIsTaskOwner(task)) card.classList.add('tt-card-watch');
  if (task.deleted) card.classList.add('deleted');
  if (ttEffectiveShowAll() && task.assignee && task.assignee !== ttState.viewer) {
    card.classList.add('tt-card-other');
  }
  if (ttIsAgentWorkingTask(task.id)) card.classList.add('tt-agent-working');

  const titleWrap = document.createElement('div');
  titleWrap.className = 'tt-card-title-wrap';
  const title = document.createElement('div');
  title.className = 'tt-card-title';
  title.textContent = ttStripTitleTags(task.title) || task.title;
  title.title = 'Открыть подробности';
  titleWrap.appendChild(title);
  const tags = ttTaskDisplayTags(task);
  if (tags.length) {
    const row = document.createElement('div');
    row.className = 'tt-tag-row tt-card-tags';
    for (const tag of tags) {
      row.appendChild(ttMakeTagEl(tag, {
        active: true,
        onContext: (e) => ttOpenTagCtxMenu(e, tag, { selected: tags, editable: false }),
      }));
    }
    titleWrap.appendChild(row);
  }
  card.appendChild(titleWrap);

  const meta = document.createElement('div');
  meta.className = 'tt-card-meta';

  const assignee = document.createElement('span');
  assignee.className = 'tt-assignee';
  assignee.textContent = task.assignee || '—';
  meta.appendChild(assignee);

  const tid = document.createElement('span');
  tid.className = 'tt-task-id';
  tid.textContent = ttShortId(task.id);
  ttMakeCopyable(tid, ttShortId(task.id));
  meta.appendChild(tid);

  const pts = document.createElement('span');
  pts.className = 'tt-points';
  pts.title = 'Баллы';
  pts.textContent = `⭐${ttFormatPoints(task)}`;
  meta.appendChild(pts);

  const spacer = document.createElement('span');
  spacer.className = 'tt-card-meta-spacer';
  meta.appendChild(spacer);

  ttRenderBadge(task, meta);
  card.appendChild(meta);

  card.onclick = (e) => {
    if (e.target.closest('.tt-badge, .tt-tag, .tt-copyable')) return;
    ttOpenDetail(task.id);
  };
  return card;
}

function ttRenderBoard() {
  const kanban = document.getElementById('tt-kanban');
  const listView = document.getElementById('tt-list-view');
  if (!kanban || !listView) return;

  ttRenderTagFilterBar();
  kanban.innerHTML = '';
  listView.innerHTML = '';

  const viewerTasks = ttVisibleTasks(ttState.viewer);

  for (const col of TT.columns) {
    if (!ttEffectiveShowAll() && (col.key === 'done' || col.key === 'cancelled')) continue;
    const colEl = document.createElement('div');
    colEl.className = 'tt-col';
    const items = viewerTasks.filter(t => ttColumnForTask(t) === col.key);
    const head = document.createElement('div');
    head.className = 'tt-col-head';
    head.appendChild(document.createTextNode(col.label));
    if (col.key === 'open') {
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'tt-col-add-btn';
      addBtn.title = 'Новая задача';
      addBtn.textContent = '＋';
      addBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        ttOpenCreateTask();
      });
      head.appendChild(addBtn);
    }
    const headSpacer = document.createElement('span');
    headSpacer.style.flex = '1';
    head.appendChild(headSpacer);
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(items.length);
    head.appendChild(count);
    colEl.appendChild(head);
    const body = document.createElement('div');
    body.className = 'tt-col-body';
    if (!items.length) {
      body.innerHTML = '<div class="tt-empty">—</div>';
    } else {
      for (const task of items) body.appendChild(ttRenderCard(task));
    }
    colEl.appendChild(body);
    kanban.appendChild(colEl);
  }

  const sorted = [...viewerTasks].sort((a, b) => {
    const colOrder = { in_progress: 0, open: 1, done: 2, cancelled: 3 };
    return (colOrder[ttColumnForTask(a)] ?? 9) - (colOrder[ttColumnForTask(b)] ?? 9);
  });
  if (!sorted.length) {
    const q = (ttState.searchQuery || '').trim();
    const tag = ttNormalizeTag(ttState.tagFilter);
    listView.innerHTML = `<div class="tt-empty">${
      tag ? `Нет задач с тегом #${ttEscapeHtml(tag)}`
        : q ? 'Ничего не найдено'
          : 'Нет задач для выбранного исполнителя'
    }</div>`;
  } else {
    for (const task of sorted) listView.appendChild(ttRenderCard(task));
  }

  ttApplyAgentWorkingUi();
}

function ttRenderPointsBar(task) {
  const bar = document.getElementById('tt-points-bar');
  const host = document.getElementById('tt-points-stars');
  if (!bar || !host) return;
  const owner = ttIsTaskOwner(task);
  bar.hidden = !owner;
  if (!owner) return;
  const value = Math.max(1, Math.min(99, Number(task?.points) || 1));
  host.dataset.pointsValue = String(value);
  ttRenderStarsControl(host, value, {
    editable: true,
    min: 1,
    onChange: async (next) => {
      const points = Math.max(1, Math.min(99, next));
      try {
        await ttPatchTask(task.id, { points, actor: ttState.viewer });
      } catch (err) {
        ttNotify('⚠️ ' + err.message, 'system');
      }
    },
  });
}

async function ttSavePoints(task) {
  if (!task || !ttIsTaskOwner(task)) return;
  const host = document.getElementById('tt-points-stars');
  const planned = Math.max(1, Math.min(99, Number(host?.dataset.pointsValue) || Number(task.points) || 1));
  try {
    await ttPatchTask(task.id, { points: planned, actor: ttState.viewer });
  } catch (err) {
    ttNotify('⚠️ ' + err.message, 'system');
  }
}

function ttRenderHandoffLine(c) {
  const el = document.createElement('div');
  el.className = 'tt-handoff-line';
  const parsed = ttParseHandoffComment(c);
  const when = ttFormatDate(c.created_at);
  el.textContent = parsed
    ? `Задача передана: ${parsed.from} → ${parsed.to}${when ? ` · ${when}` : ''}`
    : (c.text || '');
  return el;
}

function ttCommentVersionBlocks(comment, showAll) {
  const versions = [];
  if (showAll && Array.isArray(comment.history) && comment.history.length) {
    for (let i = 0; i < comment.history.length; i++) {
      const h = comment.history[i];
      versions.push({
        text: h.text,
        at: h.at,
        stale: true,
        deleted: !!h.was_deleted,
        label: `v${i + 1}`,
        restored_from: h.restored_from || null,
        versionIndex: i,
      });
    }
  }
  const currentIdx = versions.length;
  versions.push({
    text: comment.text,
    at: comment.updated_at || comment.created_at,
    stale: false,
    deleted: !!comment.deleted,
    label: showAll ? `v${currentIdx + 1}` : null,
    restored_from: comment.restored_from || null,
    versionIndex: currentIdx,
  });
  return versions;
}

function ttRenderRestoredNote(restoredFrom) {
  if (!restoredFrom) return null;
  const el = document.createElement('span');
  el.className = 'tt-comment-restored';
  const srcId = restoredFrom.comment_id ? ttShortId(restoredFrom.comment_id) : '';
  const v = restoredFrom.version ? `v${restoredFrom.version}` : '';
  const when = restoredFrom.at ? ttFormatDate(restoredFrom.at) : '';
  el.textContent = `↩ из ${[v, srcId, when].filter(Boolean).join(' · ')}`;
  el.title = restoredFrom.comment_id || '';
  return el;
}

function ttRenderCommentVersionEl(task, c, ver, isLast, showAll) {
  const row = document.createElement('div');
  row.className = 'tt-comment-version' + (ver.stale || ver.deleted ? ' stale' : '') + (ver.deleted ? ' deleted' : '');

  const meta = document.createElement('div');
  meta.className = 'tt-comment-version-meta';

  const left = document.createElement('div');
  left.className = 'tt-comment-meta-left';
  const author = document.createElement('div');
  author.className = 'tt-comment-author';
  author.textContent = c.author || 'Unknown';
  left.appendChild(author);

  if (!ver.stale) {
    const starVal = Number(c.stars) || 0;
    const canEditStars = !c.deleted && c.author === ttState.viewer;
    if (starVal > 0 || canEditStars) {
      const starsWrap = document.createElement('div');
      starsWrap.className = 'tt-comment-stars';
      ttRenderStarsControl(starsWrap, starVal, {
        editable: canEditStars,
        onChange: async (next) => {
          try {
            await ttEditComment(task.id, c.id, c.text, { stars: next, actor: ttState.viewer });
          } catch (err) {
            ttNotify('⚠️ ' + err.message, 'system');
          }
        },
      });
      left.appendChild(starsWrap);
    }
  }
  meta.appendChild(left);

  const right = document.createElement('div');
  right.className = 'tt-comment-meta-right';
  if (showAll) {
    const ids = document.createElement('div');
    ids.className = 'tt-comment-ids';
    ids.textContent = ttFormatCommentId(c.id, ver.label);
    ttMakeCopyable(ids, ttShortId(c.id));
    right.appendChild(ids);
  }
  const time = document.createElement('div');
  time.className = 'tt-comment-time';
  const when = (!ver.stale && (c.composed_from || c.composed_to))
    ? ttFormatDateRange(c.composed_from || c.created_at, c.composed_to || c.updated_at || c.created_at)
    : ttFormatDate(ver.at);
  time.textContent = when + (ver.deleted ? ' · удалено' : '');
  right.appendChild(time);
  meta.appendChild(right);
  row.appendChild(meta);

  if (!ver.stale && !ver.deleted && !c.deleted && isLast && ttIsBoardRole()) {
    ttBindCommentAuthorCtxMenu(meta, task, c);
  }

  const text = document.createElement('div');
  text.className = 'tt-comment-text tt-md';
  text.innerHTML = (!ver.stale && ttIsAgentStartComment(c))
    ? ttRenderAgentStartCommentHtml(ver.text)
    : ttMarkdownToHtml(ver.text);
  ttWireCopyableCodes(text);
  row.appendChild(text);

  const foot = document.createElement('div');
  foot.className = 'tt-comment-foot';
  const footRight = document.createElement('div');
  footRight.className = 'tt-comment-foot-right';
  if (showAll && ver.restored_from) {
    const note = ttRenderRestoredNote(ver.restored_from);
    if (note) footRight.appendChild(note);
  }
  if (showAll && (ver.stale || ver.deleted)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tt-restore-btn';
    btn.innerHTML = '<span aria-hidden="true">↩</span> восстановить';
    btn.title = ver.deleted ? 'Восстановить удалённый комментарий' : 'Восстановить эту версию';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ttRestoreCommentVersion(task, c, ver.versionIndex);
    });
    footRight.appendChild(btn);
  }
  if (footRight.childNodes.length) {
    foot.appendChild(footRight);
    row.appendChild(foot);
  }

  if (!isLast) {
    const sep = document.createElement('div');
    sep.className = 'tt-comment-version-sep';
    row.appendChild(sep);
  }
  return row;
}

function ttRenderComments(task) {
  const commentsEl = document.getElementById('tt-detail-comments');
  if (!commentsEl) return;
  commentsEl.innerHTML = '';

  const head = document.getElementById('tt-comments-head');
  if (head && !head.querySelector('#tt-show-comment-all')) {
    const label = document.createElement('label');
    label.className = 'tt-show-all-toggle';
    label.title = 'Показать удалённые комментарии и историю правок';
    label.innerHTML = '<span class="tt-switch"><input type="checkbox" id="tt-show-comment-all"><span class="tt-switch-slider"></span></span> все';
    head.appendChild(label);
    const cb = label.querySelector('input');
    cb.checked = ttState.showCommentAll;
    cb.onchange = () => {
      ttState.showCommentAll = cb.checked;
      localStorage.setItem('tt-show-comment-all', cb.checked ? '1' : '0');
      ttRenderComments(ttGetTask(ttState.detailTaskId) || task);
    };
  } else {
    const cb = document.getElementById('tt-show-comment-all');
    if (cb) cb.checked = ttState.showCommentAll;
  }

  const showAll = ttState.showCommentAll;
  const comments = (task.comments || [])
    .filter(c => showAll || !c.deleted)
    .slice()
    .sort((a, b) => {
      const ta = a.composed_from || a.created_at || '';
      const tb = b.composed_from || b.created_at || '';
      return ta.localeCompare(tb);
    });
  if (!comments.length) {
    commentsEl.innerHTML = '<div class="tt-empty">Комментариев пока нет</div>';
  } else {
    const taskReadAt = ttGetTaskReadAt(task.id);
    let latestStartId = null;
    if (ttIsAgentWorkingTask(task.id)) {
      for (let i = comments.length - 1; i >= 0; i--) {
        const c = comments[i];
        if (!c.deleted && ttIsAgentStartComment(c)) {
          latestStartId = c.id;
          break;
        }
      }
    }
    for (const c of comments) {
      if (ttIsHandoffComment(c)) {
        commentsEl.appendChild(ttRenderHandoffLine(c));
        continue;
      }
      const block = document.createElement('div');
      block.className = 'tt-comment' + (c.deleted ? ' deleted' : '');
      block.dataset.commentId = c.id;
      if (ttCommentUnread(c, taskReadAt)) block.classList.add('tt-unread');
      if (c.id === latestStartId) {
        block.dataset.agentStart = '1';
        if (ttIsAgentWorkingTask(task.id)) block.classList.add('tt-agent-start-active');
      }

      if (ttState.editingCommentId === c.id && !c.deleted) {
        const draft = ttState.commentEditDrafts[c.id];
        const text = draft !== undefined ? draft : (c.text || '');
        block.innerHTML =
          `<div class="tt-comment-author">${ttEscapeHtml(c.author || 'Unknown')}</div>` +
          `<textarea class="tt-comment-edit">${ttEscapeHtml(text)}</textarea>` +
          `<div class="tt-comment-edit-actions">` +
          `<button type="button" class="tt-btn" data-save="${c.id}">Сохранить</button>` +
          `<button type="button" class="tt-btn secondary" data-cancel-edit="${c.id}">Отмена</button>` +
          `</div>`;
        const ta = block.querySelector('.tt-comment-edit');
        ta?.addEventListener('input', () => {
          ttState.commentEditDrafts[c.id] = ta.value;
          ttState.commentEditSelStart = ta.selectionStart;
          ttState.commentEditSelEnd = ta.selectionEnd;
        });
        ta?.addEventListener('keyup', () => {
          ttState.commentEditSelStart = ta.selectionStart;
          ttState.commentEditSelEnd = ta.selectionEnd;
        });
        ta?.addEventListener('mouseup', () => {
          ttState.commentEditSelStart = ta.selectionStart;
          ttState.commentEditSelEnd = ta.selectionEnd;
        });
        ttBindMonoCtxMenu(ta);
        const authorEl = block.querySelector('.tt-comment-author');
        if (authorEl) ttBindCommentAuthorCtxMenu(authorEl, task, c);
        requestAnimationFrame(() => {
          if (!ta) return;
          const s = ttState.commentEditSelStart;
          const e = ttState.commentEditSelEnd;
          if (s != null && e != null) {
            try { ta.setSelectionRange(s, e); } catch (_) {}
          }
          ta.focus();
        });
      } else {
        const versions = ttCommentVersionBlocks(c, showAll);
        versions.forEach((ver, idx) => {
          block.appendChild(ttRenderCommentVersionEl(task, c, ver, idx === versions.length - 1, showAll));
        });
        if (!c.deleted) {
          block.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            ttOpenCommentCtxMenu(e, task, c);
          });
          ttBindCommentReadHandlers(block, task, c);
        }
      }
      commentsEl.appendChild(block);
    }
  }

  commentsEl.querySelector('[data-save]')?.addEventListener('click', async (e) => {
    const id = e.target.dataset.save;
    const ta = commentsEl.querySelector('.tt-comment-edit');
    const text = ta?.value?.trim();
    if (!text) return;
    try {
      await ttEditComment(task.id, id, text);
    } catch (err) {
      ttNotify('⚠️ ' + err.message, 'system');
    }
  });
  commentsEl.querySelector('[data-cancel-edit]')?.addEventListener('click', (e) => {
    const id = e.target.dataset.cancelEdit;
    ttState.editingCommentId = null;
    delete ttState.commentEditDrafts[id];
    ttRenderComments(task);
  });
}

function ttRenderDetailMeta(task, owner) {
  const el = document.getElementById('tt-detail-meta');
  if (!el) return;
  el.innerHTML = '';
  const projectSlug = task.project || ttActiveProject();
  const projectSpan = document.createElement('span');
  projectSpan.className = 'tt-detail-project';
  projectSpan.title = projectSlug;
  projectSpan.textContent = ttProjectLabel(projectSlug);
  el.appendChild(projectSpan);
  el.appendChild(document.createTextNode(` (${projectSlug}) · ${task.assignee || '—'} · `));
  const idSpan = document.createElement('span');
  idSpan.className = 'tt-task-id';
  idSpan.textContent = ttShortId(task.id);
  ttMakeCopyable(idSpan, ttShortId(task.id));
  el.appendChild(idSpan);
  const col = ttColumnForTask(task);
  const colLabel = TT.statusLabels[col] || col;
  const rest = owner
    ? ` · ${colLabel} · ⭐${ttFormatPoints(task)}`
    : ` · наблюдение (${TT.statusLabels[task.status] || task.status}) · ⭐${ttFormatPoints(task)}`;
  el.appendChild(document.createTextNode(rest));
  if (task.delivery_commit?.sha || task.delivery_commit?.shortSha) {
    const dc = task.delivery_commit;
    const sha = dc.shortSha || String(dc.sha || '').slice(0, 7);
    const ver = dc.version ? ` · ${dc.version}` : '';
    el.appendChild(document.createTextNode(` · commit ${sha}${ver}`));
  }
}

function ttRenderDetail(task, opts = {}) {
  if (!task) return;
  const owner = ttIsTaskOwner(task);
  const canHandoff = ttCanHandoffTask(task);
  const canManage = ttCanManageManualTask(task);
  const preserveDraftFocus = !!opts.preserveDraftFocus;
  const bodyScroll = opts.bodyScroll;

  ttSetManualEditMode(ttState.manualEditing);
  document.getElementById('tt-detail-title').textContent = ttStripTitleTags(task.title) || task.title;
  const detailTags = document.getElementById('tt-detail-tags');
  if (detailTags && !ttState.manualEditing) {
    ttRenderTagPicker(detailTags, ttTaskDisplayTags(task), {
      editable: false,
      onChange: null,
    });
  }
  ttRenderDetailMeta(task, owner);

  ttRenderPointsBar(task);

  const desc = document.getElementById('tt-detail-desc');
  desc.innerHTML = ttMarkdownToHtml(task.description);
  ttWireCopyableCodes(desc);

  const badgeSlot = document.getElementById('tt-detail-badge-slot');
  if (badgeSlot) {
    badgeSlot.innerHTML = '';
    ttRenderBadge(task, badgeSlot);
  }

  ttRenderComments(task);
  ttUpdateTransferButtons(task);

  const manualActions = document.getElementById('tt-detail-manual-actions');
  if (manualActions) manualActions.hidden = !canManage;

  const composer = document.getElementById('tt-detail-composer');
  const transferGroup = document.getElementById('tt-handoff-group');
  const closeRow = document.querySelector('#tt-detail-popup .tt-action-row');
  if (composer) composer.hidden = false;
  if (transferGroup) transferGroup.style.display = '';
  if (closeRow) closeRow.style.display = canHandoff ? '' : 'none';
  if (ttState.draft.taskId !== task.id) {
    ttResetDraft(true);
    ttState.draft.taskId = task.id;
    ttState.draft.expanded = true;
  }
  if (preserveDraftFocus && ttDraftInputFocused()) {
    const authorCollapsed = document.getElementById('tt-draft-author-collapsed');
    if (authorCollapsed) authorCollapsed.textContent = ttState.viewer;
    const author = document.getElementById('tt-draft-author');
    if (author) author.textContent = ttState.viewer;
    const card = document.getElementById('tt-detail-composer');
    const body = document.getElementById('tt-draft-body');
    const collapsed = document.getElementById('tt-draft-collapsed');
    if (card) card.dataset.collapsed = '0';
    if (body) body.hidden = false;
    if (collapsed) collapsed.hidden = true;
  } else {
    ttState.draft.expanded = true;
    ttApplyDraftToComposer({ restoreFocus: false, preventScroll: true });
  }

  const body = document.getElementById('tt-detail-body');
  if (body && bodyScroll != null && Number.isFinite(bodyScroll)) {
    body.scrollTop = bodyScroll;
  }

  const popup = document.getElementById('tt-detail-popup');
  if (popup) popup.classList.toggle('tt-agent-working', ttIsAgentWorkingTask(task.id));
}

function ttUpdateRoleSwitchButtons() {
  document.querySelectorAll('.tt-role-switch').forEach(btn => {
    const role = btn.dataset.role;
    btn.classList.toggle('is-current-role', role === ttState.viewer);
    const digit = TT_ROLE_HOTKEY[role];
    btn.title = digit
      ? `Выбрать ${role} (Alt+${digit})`
      : `Выбрать ${role}`;
  });
}

function ttUpdateTransferButtons(task) {
  const canHandoff = ttCanHandoffTask(task);
  ttUpdateRoleSwitchButtons();
  const sameRole = !!task && ttState.viewer === task.assignee;
  document.querySelectorAll('.tt-transfer-go').forEach(btn => {
    btn.disabled = !ttState.viewer;
    btn.title = sameRole ? TT_TIP_TRANSFER_SAME_ROLE : TT_TIP_TRANSFER;
  });
  const closeBtn = document.getElementById('tt-close-task-btn');
  if (closeBtn) closeBtn.disabled = !canHandoff;
}

function ttOpenDetailHeadCtxMenu(e, task) {
  if (!task || !ttIsTaskOwner(task)) return;
  ttCloseCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'tt-ctx-menu open';
  const x = e.clientX || e.touches?.[0]?.clientX || 40;
  const y = e.clientY || e.touches?.[0]?.clientY || 40;
  menu.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 200)}px`;

  const label = document.createElement('div');
  label.className = 'tt-ctx-label';
  label.textContent = 'Перенести в проект…';
  menu.appendChild(label);

  const targets = ttProjectMoveTargets(task);
  if (!targets.length) {
    const empty = document.createElement('button');
    empty.type = 'button';
    empty.disabled = true;
    empty.textContent = 'Нет других проектов';
    menu.appendChild(empty);
  } else {
    for (const slug of targets) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = `${ttProjectLabel(slug)} (${slug})`;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        ttCloseCtxMenu();
        ttDoMoveProject(task.id, slug).catch(() => {});
      });
      menu.appendChild(btn);
    }
  }

  document.body.appendChild(menu);
  ttState.ctxMenu = menu;
  const onPointerDown = (ev) => {
    if (menu.contains(ev.target)) return;
    ttCloseCtxMenu();
  };
  const onKeyDown = (ev) => {
    if (ev.key === 'Escape') ttCloseCtxMenu();
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
  }, 0);
  ttState.ctxMenuCleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown);
  };
}

function ttBindDetailHeadCtxMenu() {
  const head = document.querySelector('.tt-detail-head');
  if (!head || head.dataset.ctxBound) return;
  head.dataset.ctxBound = '1';
  const open = (e) => {
    if (e.target.closest('.tt-close-btn, .tt-ghost-btn, button, a, input, textarea, select')) return;
    const task = ttGetTask(ttState.detailTaskId);
    if (!task) return;
    e.preventDefault();
    e.stopPropagation();
    ttOpenDetailHeadCtxMenu(e, task);
  };
  head.addEventListener('contextmenu', open);
  let pressTimer = null;
  head.addEventListener('touchstart', (e) => {
    if (e.target.closest('.tt-close-btn, .tt-ghost-btn, button, a, input, textarea, select')) return;
    pressTimer = setTimeout(() => {
      const task = ttGetTask(ttState.detailTaskId);
      if (!task) return;
      ttOpenDetailHeadCtxMenu(e, task);
    }, 550);
  }, { passive: true });
  head.addEventListener('touchend', () => { clearTimeout(pressTimer); });
  head.addEventListener('touchmove', () => { clearTimeout(pressTimer); });
}

function ttBindCommentAuthorCtxMenu(el, task, comment) {
  if (!el || el.dataset.authorCtxBound) return;
  el.dataset.authorCtxBound = '1';
  const open = (e) => {
    e.preventDefault();
    e.stopPropagation();
    ttOpenCommentAuthorCtxMenu(e, task, comment);
  };
  el.addEventListener('contextmenu', open);
  let pressTimer = null;
  el.addEventListener('touchstart', (e) => {
    pressTimer = setTimeout(() => open(e), 550);
  }, { passive: true });
  el.addEventListener('touchend', () => { clearTimeout(pressTimer); });
  el.addEventListener('touchmove', () => { clearTimeout(pressTimer); });
}

function ttOpenCommentAuthorPickMenu(e, task, comment) {
  ttCloseCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'tt-ctx-menu open';
  const x = e.clientX || e.touches?.[0]?.clientX || 40;
  const y = e.clientY || e.touches?.[0]?.clientY || 40;
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 200)}px`;

  const label = document.createElement('div');
  label.className = 'tt-ctx-label';
  label.textContent = 'Выберите автора…';
  menu.appendChild(label);

  for (const role of TT.roles) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = ttRoleLabel(role);
    if (role === comment.author) {
      btn.disabled = true;
      btn.title = 'Текущий автор';
    } else {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        ttCloseCtxMenu();
        try {
          await ttEditComment(task.id, comment.id, comment.text, {
            author: role,
            actor: ttState.viewer,
          });
          ttNotify(`✓ Автор: ${ttRoleLabel(role)}`, 'system');
        } catch (err) {
          ttNotify('⚠️ ' + err.message, 'system');
        }
      });
    }
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  ttState.ctxMenu = menu;
  const onPointerDown = (ev) => {
    if (menu.contains(ev.target)) return;
    ttCloseCtxMenu();
  };
  const onKeyDown = (ev) => {
    if (ev.key === 'Escape') ttCloseCtxMenu();
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
  }, 0);
  ttState.ctxMenuCleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown);
  };
}

function ttOpenCommentAuthorCtxMenu(e, task, comment) {
  if (!comment || comment.deleted || !ttIsBoardRole()) return;
  ttCloseCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'tt-ctx-menu open';
  const x = e.clientX || e.touches?.[0]?.clientX || 40;
  const y = e.clientY || e.touches?.[0]?.clientY || 40;
  menu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 120)}px`;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Поменять автора';
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    ttOpenCommentAuthorPickMenu(ev, task, comment);
  });
  menu.appendChild(btn);

  document.body.appendChild(menu);
  ttState.ctxMenu = menu;
  const onPointerDown = (ev) => {
    if (menu.contains(ev.target)) return;
    ttCloseCtxMenu();
  };
  const onKeyDown = (ev) => {
    if (ev.key === 'Escape') ttCloseCtxMenu();
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
  }, 0);
  ttState.ctxMenuCleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown);
  };
}

function ttOpenCommentCtxMenu(e, task, comment) {
  ttCloseCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'tt-ctx-menu open';
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - 160)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - 120)}px`;

  const canEdit = comment.author === ttState.viewer;
  const items = [
    { label: 'Копировать', action: () => navigator.clipboard?.writeText(comment.text) },
  ];
  if (canEdit) {
    items.push({ label: 'Редактировать', action: () => {
      ttState.editingCommentId = comment.id;
      if (ttState.commentEditDrafts[comment.id] === undefined) {
        ttState.commentEditDrafts[comment.id] = comment.text || '';
      }
      ttRenderComments(task);
    }});
    items.push({ label: 'Удалить', danger: true, action: async () => {
      if (!confirm('Удалить комментарий? Он попадёт в корзину (чекбокс «все» в шапке комментариев).')) return;
      try {
        await ttRemoveComment(task.id, comment.id);
      } catch (err) {
        ttNotify('⚠️ ' + err.message, 'system');
      }
    }});
  }

  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.label;
    if (item.danger) btn.classList.add('danger');
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      ttCloseCtxMenu();
      Promise.resolve(item.action()).catch(() => {});
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  ttState.ctxMenu = menu;

  const onPointerDown = (ev) => {
    if (menu.contains(ev.target)) return;
    ttCloseCtxMenu();
  };
  const onKeyDown = (ev) => {
    if (ev.key === 'Escape') ttCloseCtxMenu();
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
  }, 0);
  ttState.ctxMenuCleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown);
  };
}

function ttOpenDetail(taskId) {
  if (ttState.draft.taskId && ttState.draft.taskId !== taskId) {
    ttCaptureDraftFromDom();
  }
  ttState.detailTaskId = taskId;
  ttState.editingCommentId = null;
  ttState.manualEditing = false;
  const task = ttGetTask(taskId);
  if (task && task.status !== 'cancelled') ttBeginHandoff(taskId);
  if (ttState.draft.taskId !== taskId) {
    ttResetDraft(true);
    ttState.draft.taskId = taskId;
    ttState.draft.expanded = true;
  }
  if (task) ttMarkTaskRead(task);
  ttRenderDetail(task);
  if (task) ttRenderBoard();
  document.getElementById('tt-detail-overlay').classList.add('open');
  ttPopupHistoryPush('tt-detail-overlay');
}

function ttCloseDetail(opts = {}) {
  ttCaptureDraftFromDom();
  ttState.detailTaskId = null;
  ttState.editingCommentId = null;
  ttState.manualEditing = false;
  ttEndHandoff();
  ttSetManualEditMode(false);
  ttCloseCtxMenu();
  const wasOpen = ttPopupIsOpen('tt-detail-overlay');
  document.getElementById('tt-detail-overlay')?.classList.remove('open');
  if (wasOpen && !opts.skipHistory) ttPopupHistoryPop(opts.fromPopstate);
}

function ttOpenTransferPopup(taskId, mode) {
  const task = ttGetTask(taskId);
  if (!task) return;
  if (!ttHasListComment(task)) ttNotifyCommentRequired(mode === 'close' ? 'close' : 'transfer');
  ttBeginHandoff(taskId);
  ttState.transferTaskId = taskId;
  ttState.transferMode = mode;

  const title = document.getElementById('tt-transfer-title');
  const sub = document.getElementById('tt-transfer-sub');
  if (mode === 'close') {
    title.textContent = 'Закрыть задачу?';
    sub.textContent = 'Нужен хотя бы один комментарий в списке задачи. Поле ввода в popup — только если хотите добавить ещё один.';
  } else {
    title.textContent = 'Передать задачу';
    sub.textContent = task.title;
  }

  const ta = document.getElementById('tt-transfer-comment');
  const detailTa = document.getElementById('tt-comment-input');
  if (ta) {
    ta.value = detailTa?.value?.trim() || '';
    ta.style.height = '';
    ta.scrollTop = 0;
  }
  ttSyncComposer(document.getElementById('tt-transfer-composer'));
  ttUpdateTransferButtons(task);

  const handoffGroup = document.getElementById('tt-handoff-popup-group');
  if (handoffGroup) handoffGroup.style.display = mode === 'close' ? 'none' : '';
  document.getElementById('tt-quick-close-btn').style.display = '';

  document.getElementById('tt-transfer-overlay').classList.add('open');
  ttPopupHistoryPush('tt-transfer-overlay');
}

function ttCloseTransferPopup(opts = {}) {
  ttState.transferTaskId = null;
  ttState.transferMode = null;
  if (!ttState.detailTaskId) ttEndHandoff();
  const wasOpen = ttPopupIsOpen('tt-transfer-overlay');
  document.getElementById('tt-transfer-overlay')?.classList.remove('open');
  if (wasOpen && !opts.skipHistory) ttPopupHistoryPop(opts.fromPopstate);
}

async function ttDoTransfer(fromDetail = false) {
  const assignee = ttState.viewer;
  const taskId = fromDetail ? ttState.detailTaskId : ttState.transferTaskId;
  const task = ttGetTask(taskId);
  if (!taskId || !task) return;
  if (!assignee || assignee === task.assignee) {
    ttNotify('Выберите другую роль и нажмите ➜', 'system');
    return;
  }
  try {
    const hasComment = await ttEnsureCommentForAction(task, fromDetail);
    if (!hasComment) {
      if (fromDetail) {
        ttNotify('Добавьте комментарий в список (➤) перед передачей', 'system');
        document.getElementById('tt-comment-input')?.focus();
      } else {
        ttPromptCommentInDetail(taskId, 'перед передачей');
      }
      return;
    }
    await ttPatchTask(taskId, { status: 'open', assignee });
    document.getElementById('tt-transfer-comment').value = '';
    document.getElementById('tt-comment-input').value = '';
    ttResetDraft(true);
    ttRenderDraftCard();
    ttSyncComposer(document.getElementById('tt-transfer-composer'));
    ttEndHandoff();
    ttCloseTransferPopup();
    if (fromDetail || ttState.detailTaskId === taskId) {
      ttRenderDetail(ttGetTask(taskId));
    }
    ttNotify(`↪ Передано: ${assignee}`, 'system');
  } catch (err) {
    ttNotify('⚠️ ' + err.message, 'system');
  }
}

function ttReadPointsPatch(task) {
  const host = document.getElementById('tt-points-stars');
  const patch = {};
  const fromHost = host?.dataset.pointsValue != null ? Number(host.dataset.pointsValue) : null;
  if (fromHost != null && Number.isFinite(fromHost)) {
    patch.points = Math.max(1, Math.min(99, fromHost || 1));
  } else if (task?.points) {
    patch.points = task.points;
  }
  if (patch.points) patch.actor = ttState.viewer;
  return patch;
}

async function ttDoClose(fromPopup) {
  const taskId = fromPopup ? ttState.transferTaskId : ttState.detailTaskId;
  const task = ttGetTask(taskId);
  if (!taskId || !task || !ttCanHandoffTask(task)) return;
  try {
    const hasComment = await ttEnsureCommentForAction(task, !fromPopup);
    if (!hasComment) {
      if (fromPopup) {
        ttPromptCommentInDetail(taskId, 'перед закрытием');
      } else {
        ttNotify('Добавьте комментарий в список (➤) перед закрытием', 'system');
        document.getElementById('tt-comment-input')?.focus();
      }
      return;
    }
    await ttPatchTask(taskId, { status: 'cancelled', assignee: ttState.viewer, ...ttReadPointsPatch(task) });
    ttEndHandoff();
    if (fromPopup) {
      document.getElementById('tt-transfer-comment').value = '';
      ttCloseTransferPopup();
    } else {
      ttResetDraft(true);
      ttRenderDraftCard();
    }
    ttNotify('✓ Задача закрыта', 'system');
  } catch (err) {
    ttNotify('⚠️ ' + err.message, 'system');
  }
}

// ── Stars control ─────────────────────────────────────────────────
function ttRenderStarsControl(container, stars, { editable = false, onChange, min = 0 } = {}) {
  container.innerHTML = '';
  const lo = Math.max(0, Math.min(99, Number(min) || 0));
  const value = Math.max(lo, Math.min(99, Number(stars) || 0));
  if (editable) {
    const dec = document.createElement('button');
    dec.type = 'button';
    dec.className = 'tt-star-btn';
    dec.textContent = '−';
    dec.title = 'Меньше';
    dec.onclick = (e) => { e.stopPropagation(); onChange?.(Math.max(lo, value - 1)); };
    container.appendChild(dec);
  }
  const count = document.createElement('span');
  count.className = 'tt-star-count';
  count.textContent = String(value);
  count.hidden = value <= 1;
  container.appendChild(count);
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'tt-star-btn tt-star-main' + (value > 0 ? ' active' : '');
  main.textContent = value > 0 ? '★' : '☆';
  main.title = lo > 0 ? 'Плановые баллы' : 'Трудозатраты';
  if (editable) {
    main.onclick = (e) => {
      e.stopPropagation();
      if (value === lo) onChange?.(Math.max(lo, 1));
      else if (lo === 0) onChange?.(0);
      else onChange?.(lo);
    };
  } else {
    main.disabled = true;
    main.style.cursor = 'default';
  }
  container.appendChild(main);
  if (editable) {
    const inc = document.createElement('button');
    inc.type = 'button';
    inc.className = 'tt-star-btn';
    inc.textContent = '+';
    inc.title = 'Больше';
    inc.onclick = (e) => { e.stopPropagation(); onChange?.(Math.min(99, value + 1)); };
    container.appendChild(inc);
  }
}

// ── Draft composer card ───────────────────────────────────────────
function ttNewDraftId() {
  return 'd_' + Math.random().toString(36).slice(2, 10);
}

function ttDraftInputFocused() {
  return document.activeElement?.id === 'tt-comment-input';
}

function ttCaptureDraftFromDom() {
  const ta = document.getElementById('tt-comment-input');
  if (!ta || !ttState.detailTaskId) return;
  if (ttState.draft.taskId && ttState.draft.taskId !== ttState.detailTaskId) return;
  ttState.draft.taskId = ttState.detailTaskId;
  ttState.draft.text = ta.value;
  if (document.activeElement === ta || ttState.draft.expanded) {
    ttState.draft.selStart = ta.selectionStart;
    ttState.draft.selEnd = ta.selectionEnd;
  }
  const card = document.getElementById('tt-detail-composer');
  ttState.draft.expanded = card?.dataset.collapsed === '0';
}

function ttApplyDraftToComposer({ restoreFocus = false, preventScroll = false } = {}) {
  const d = ttState.draft;
  if (!ttState.detailTaskId) return;
  if (d.taskId && d.taskId !== ttState.detailTaskId) return;
  const wasFocused = ttDraftInputFocused();
  ttRenderDraftCard({ skipStarsIfSame: true });
  const ta = document.getElementById('tt-comment-input');
  if (!ta) return;
  if (d.text != null && ta.value !== d.text) ta.value = d.text;
  ttSyncDraftComposer({ scroll: false });
  if ((restoreFocus || wasFocused) && d.expanded) {
    const start = d.selStart ?? ta.value.length;
    const end = d.selEnd ?? start;
    const apply = () => {
      try {
        ta.focus({ preventScroll: !!preventScroll });
        ta.setSelectionRange(start, end);
      } catch (_) {}
    };
    apply();
    requestAnimationFrame(apply);
  }
}

function ttRestoreDraftToDom(sel) {
  if (sel) {
    if (sel.start != null) ttState.draft.selStart = sel.start;
    if (sel.end != null) ttState.draft.selEnd = sel.end;
  }
  ttApplyDraftToComposer({ restoreFocus: !!ttState.draft.expanded, preventScroll: true });
}

function ttResetDraft(keepTask = true) {
  ttState.draft = {
    taskId: keepTask ? ttState.detailTaskId : null,
    expanded: false,
    text: '',
    stars: 0,
    draftId: ttNewDraftId(),
    startedAt: null,
    selStart: null,
    selEnd: null,
  };
}

function ttExpandDraft() {
  const d = ttState.draft;
  d.taskId = ttState.detailTaskId;
  d.expanded = true;
  if (!d.draftId) d.draftId = ttNewDraftId();
  if (!d.startedAt) d.startedAt = new Date().toISOString();
  ttRenderDraftCard();
  const ta = document.getElementById('tt-comment-input');
  if (ta && d.text != null) ta.value = d.text;
  ttSyncDraftComposer({ scroll: true });
  ta?.focus({ preventScroll: false });
}

function ttRenderDraftCard({ skipStarsIfSame = false } = {}) {
  const card = document.getElementById('tt-detail-composer');
  const body = document.getElementById('tt-draft-body');
  const collapsed = document.getElementById('tt-draft-collapsed');
  if (!card || !body) return;
  const d = ttState.draft;
  const expanded = !!d.expanded && d.taskId === ttState.detailTaskId;
  card.dataset.collapsed = expanded ? '0' : '1';
  body.hidden = !expanded;
  if (collapsed) collapsed.hidden = expanded;

  const authorCollapsed = document.getElementById('tt-draft-author-collapsed');
  if (authorCollapsed) authorCollapsed.textContent = ttState.viewer || '—';

  if (!expanded) return;

  const author = document.getElementById('tt-draft-author');
  const time = document.getElementById('tt-draft-time');
  const idEl = document.getElementById('tt-draft-id');
  if (author) author.textContent = ttState.viewer || '—';
  if (time) time.textContent = ttFormatDate(d.startedAt || new Date().toISOString());
  if (idEl) {
    idEl.textContent = ttShortId(d.draftId || '');
    ttMakeCopyable(idEl, ttShortId(d.draftId || ''));
  }
  const starsHost = document.getElementById('tt-draft-stars');
  if (starsHost) {
    const same = skipStarsIfSame && starsHost.dataset.starsValue === String(d.stars || 0);
    if (!same) {
      starsHost.dataset.starsValue = String(d.stars || 0);
      ttRenderStarsControl(starsHost, d.stars || 0, {
        editable: true,
        onChange: (next) => {
          ttCaptureDraftFromDom();
          ttState.draft.stars = next;
          ttRenderDraftCard();
          ttApplyDraftToComposer({ restoreFocus: true, preventScroll: true });
        },
      });
    }
  }
}

function ttSetComposerSendEnabled(send, enabled) {
  if (!send) return;
  send.removeAttribute('disabled');
  send.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  send.classList.toggle('visible', enabled);
}

function ttComposerSendEnabled(send) {
  return send?.getAttribute('aria-disabled') !== 'true';
}

function ttWireComposerSend(btn, onSend) {
  if (!btn || btn.dataset.sendWired) return;
  btn.dataset.sendWired = '1';
  btn.title = TT_TIP_SEND;
  let lastAt = 0;
  const fire = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!ttComposerSendEnabled(btn)) return;
    const now = Date.now();
    if (now - lastAt < 400) return;
    lastAt = now;
    onSend();
  };
  btn.addEventListener('click', fire);
}

function ttSyncDraftComposer({ scroll = false } = {}) {
  const ta = document.getElementById('tt-comment-input');
  const send = document.getElementById('tt-composer-send');
  if (!ta || !send) return;
  const hasText = !!ta.value.trim();
  ttSetComposerSendEnabled(send, hasText);
  const prev = ta.style.height;
  ta.style.height = '24px';
  const next = `${Math.max(24, ta.scrollHeight)}px`;
  if (prev !== next) ta.style.height = next;
  else ta.style.height = prev;
  ta.style.overflow = 'hidden';
  if (scroll) {
    const body = document.getElementById('tt-detail-body');
    if (body) body.scrollTop = body.scrollHeight;
  }
}

function ttWireDraftComposer() {
  const card = document.getElementById('tt-detail-composer');
  if (!card || card.dataset.wired) return;
  card.dataset.wired = '1';

  const open = () => {
    if (card.dataset.collapsed === '1') ttExpandDraft();
  };
  document.getElementById('tt-draft-plus')?.addEventListener('click', (e) => {
    e.preventDefault();
    open();
  });
  card.addEventListener('click', (e) => {
    if (card.dataset.collapsed === '1' && !e.target.closest('button,textarea,a')) open();
  });

  const ta = document.getElementById('tt-comment-input');
  ta?.addEventListener('input', () => {
    ttState.draft.text = ta.value;
    ttState.draft.selStart = ta.selectionStart;
    ttState.draft.selEnd = ta.selectionEnd;
    if (!ttState.draft.startedAt) ttState.draft.startedAt = new Date().toISOString();
    ttSyncDraftComposer({ scroll: false });
  });
  ta?.addEventListener('keyup', () => {
    ttState.draft.selStart = ta.selectionStart;
    ttState.draft.selEnd = ta.selectionEnd;
  });
  ta?.addEventListener('mouseup', () => {
    ttState.draft.selStart = ta.selectionStart;
    ttState.draft.selEnd = ta.selectionEnd;
  });
  ta?.addEventListener('select', () => {
    ttState.draft.selStart = ta.selectionStart;
    ttState.draft.selEnd = ta.selectionEnd;
  });
  ta?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (ta.value.trim()) ttSubmitDraftComment();
    }
  });
  const sendBtn = document.getElementById('tt-composer-send');
  ttWireComposerSend(sendBtn, () => {
    const input = document.getElementById('tt-comment-input');
    if (input?.value?.trim()) ttSubmitDraftComment();
  });
}

async function ttSubmitDraftComment() {
  if (ttState.draftSubmitting) return;
  const task = ttGetTask(ttState.detailTaskId);
  if (!task) return;
  const ta = document.getElementById('tt-comment-input');
  const text = ta?.value?.trim();
  if (!text) return;
  const from = ttState.draft.startedAt || new Date().toISOString();
  const to = new Date().toISOString();
  const stars = Math.max(0, Math.min(99, Number(ttState.draft.stars) || 0));
  ttState.draftSubmitting = true;
  try {
    await ttAddComment(task.id, ttState.viewer, text, {
      stars,
      composed_from: from,
      composed_to: to,
    });
    ttResetDraft(true);
    ttRenderDraftCard();
    if (ta) ta.value = '';
    ttSyncDraftComposer({ scroll: true });
  } catch (err) {
    ttPlaySound('error');
    ttNotify('⚠️ ' + err.message, 'system');
  } finally {
    ttState.draftSubmitting = false;
  }
}

// ── Motivation ledger UI ──────────────────────────────────────────
async function ttLoadBalances() {
  try {
    ttState.balances = await ttApi(`/projects/${encodeURIComponent(ttActiveProject())}/motivation/balances`);
  } catch {
    ttState.balances = {};
  }
  ttRenderBalanceBadge();
}

function ttRenderBalanceBadge() {
  const btn = document.getElementById('tt-balance-badge');
  if (!btn) return;
  const n = Number(ttState.balances[ttState.viewer]) || 0;
  btn.textContent = `⭐ ${n}`;
  btn.title = `Накоплено у ${ttState.viewer}`;
}

async function ttOpenMotivation() {
  const overlay = document.getElementById('tt-motivation-overlay');
  if (!overlay) return;
  const allCb = document.getElementById('tt-motivation-all');
  if (allCb) allCb.checked = ttState.motivationShowAll;
  overlay.classList.add('open');
  ttPopupHistoryPush('tt-motivation-overlay');
  await ttRefreshMotivationTable();
}

function ttCloseMotivation(opts = {}) {
  const wasOpen = ttPopupIsOpen('tt-motivation-overlay');
  document.getElementById('tt-motivation-overlay')?.classList.remove('open');
  if (wasOpen && !opts.skipHistory) ttPopupHistoryPop(opts.fromPopstate);
}

async function ttRefreshMotivationTable() {
  const user = ttState.motivationShowAll ? '' : `?user=${encodeURIComponent(ttState.viewer)}`;
  try {
    ttState.motivationEvents = await ttApi(`/projects/${encodeURIComponent(ttActiveProject())}/motivation${user}`);
  } catch (err) {
    ttNotify('⚠️ ' + err.message, 'system');
    ttState.motivationEvents = [];
  }
  await ttLoadBalances();
  const line = document.getElementById('tt-motivation-balance-line');
  if (line) {
    const n = Number(ttState.balances[ttState.viewer]) || 0;
    line.textContent = ttState.motivationShowAll
      ? `Балансы: ${Object.entries(ttState.balances).map(([k, v]) => `${k} ⭐${v}`).join(' · ') || '—'}`
      : `Баланс ${ttState.viewer}: ⭐ ${n}`;
  }
  const tbody = document.getElementById('tt-motivation-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!ttState.motivationEvents.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="tt-empty">Событий пока нет</td></tr>';
    return;
  }
  for (const e of ttState.motivationEvents) {
    const tr = document.createElement('tr');
    const amt = Number(e.amount) || 0;
    const amtClass = amt > 0 ? 'pos' : amt < 0 ? 'neg' : '';
    const note = e.note || (e.task_id ? ttShortId(e.task_id) : '—');
    tr.innerHTML =
      `<td>${ttEscapeHtml(ttFormatDate(e.created_at))}</td>` +
      `<td>${ttEscapeHtml(ttMotivationTypeLabel(e.type))}</td>` +
      `<td class="${amtClass}">${amt > 0 ? '+' : ''}${amt}</td>` +
      `<td>${ttEscapeHtml(e.user || '—')}</td>` +
      `<td>${ttEscapeHtml(e.actor || '—')}</td>` +
      `<td>${ttEscapeHtml(note)}</td>`;
    tbody.appendChild(tr);
  }
}

async function ttDoPayout() {
  const raw = prompt('Сколько звёзд получить / выдать?', '1');
  if (raw == null) return;
  const n = Math.max(1, Math.min(999, Math.round(Number(raw) || 0)));
  if (!n) return;
  try {
    await ttApi(`/projects/${encodeURIComponent(ttActiveProject())}/motivation`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'payout',
        user: ttState.viewer,
        actor: ttState.viewer,
        amount: -n,
        note: 'Выплата / получение',
      }),
    });
    ttNotify(`⭐ Выплата −${n}`, 'system');
    await ttRefreshMotivationTable();
  } catch (err) {
    ttNotify('⚠️ ' + err.message, 'system');
  }
}

async function ttDoBackfillClosed() {
  if (!confirm('Зачислить звёзды за уже закрытые задачи? Повторный запуск не дублирует записи.')) return;
  try {
    const result = await ttApi(`/projects/${encodeURIComponent(ttActiveProject())}/motivation/backfill`, {
      method: 'POST',
      body: JSON.stringify({ actor: ttState.viewer }),
    });
    const n = Number(result?.created) || 0;
    ttNotify(n ? `⭐ Зачислено записей: ${n}` : '⭐ Новых записей нет (уже зачислено)', 'system');
    await ttRefreshMotivationTable();
  } catch (err) {
    ttNotify('⚠️ ' + err.message, 'system');
  }
}

// ── Telegram-style composer (transfer popup) ───────────────────────
function ttSyncComposer(root) {
  if (!root) return;
  const ta = root.querySelector('textarea');
  const send = root.querySelector('.tt-composer-send');
  if (!ta || !send) return;
  const hasText = !!ta.value.trim();
  ttSetComposerSendEnabled(send, hasText);
  // Same grow behavior as task draft composer — long comments stay readable.
  const maxH = Math.max(160, Math.floor(window.innerHeight * 0.55));
  const minH = 24;
  ta.style.height = `${minH}px`;
  const next = Math.min(Math.max(ta.scrollHeight, minH), maxH);
  ta.style.height = `${next}px`;
  ta.style.overflowY = ta.scrollHeight > maxH + 2 ? 'auto' : 'hidden';
  ta.scrollTop = 0;
}

function ttWireComposer(root, onSend) {
  if (!root || root.dataset.wired) return;
  root.dataset.wired = '1';
  const ta = root.querySelector('textarea');
  const send = root.querySelector('.tt-composer-send');
  ta?.addEventListener('input', () => ttSyncComposer(root));
  ta?.addEventListener('focus', () => ttSyncComposer(root));
  ta?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (ta.value.trim()) onSend();
    }
  });
  ttWireComposerSend(send, () => {
    if (ta?.value?.trim()) onSend();
  });
  ttSyncComposer(root);
}

function ttOpenBoard() {
  document.getElementById('tt-board-overlay')?.classList.add('open');
  ttPopupHistoryPush('tt-board-overlay');
  setNotifBoardMode?.(true);
  ttLoadTasks().catch(err => {
    console.error('[task-board]', err);
    ttNotify('⚠️ Task-tracker недоступен');
  });
}

function ttCloseBoard(opts = {}) {
  const wasOpen = ttPopupIsOpen('tt-board-overlay');
  document.getElementById('tt-board-overlay')?.classList.remove('open');
  setNotifBoardMode?.(false);
  ttCloseRoleMenu();
  ttCloseDetail({ skipHistory: true });
  ttCloseTransferPopup({ skipHistory: true });
  ttCloseCreateTask({ skipHistory: true });
  ttCloseMotivation({ skipHistory: true });
  ttCloseFeaturePicker([], { skipHistory: true });
  ttCloseStatusMenu();
  ttCloseCtxMenu();
  if (wasOpen && !opts.skipHistory) ttPopupHistoryReset(opts.fromPopstate);
}

function ttToggleBoard() {
  const overlay = document.getElementById('tt-board-overlay');
  if (overlay?.classList.contains('open')) ttCloseBoard();
  else ttOpenBoard();
}

function ttStartAutoRefresh() {
  if (ttState.refreshTimer) return;
  ttState.refreshTimer = setInterval(() => {
    ttLoadTasks().catch(() => {});
  }, TT.refreshMs);
}

function ttInitTaskBoard() {
  ttWirePopupDismiss();
  ttLoadReadRoot();
  ttDeviceOrigin();
  const unlockAudio = () => {
    ttEnsureAudio();
    document.removeEventListener('pointerdown', unlockAudio, true);
  };
  document.addEventListener('pointerdown', unlockAudio, true);
  ttUpdateHeaderRole();
  ttUpdateRoleSwitchButtons();
  document.getElementById('tt-header-role')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (ttState.roleMenu) ttCloseRoleMenu();
    else ttOpenRoleMenu(e.currentTarget);
  });

  document.getElementById('tt-board-close')?.addEventListener('click', ttCloseBoard);
  document.getElementById('tt-board-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'tt-board-overlay') ttCloseBoard();
  });

  const params = new URLSearchParams(window.location.search);
  if (!isEditorMode(params)) return;

  ttLoadTagRegistry();
  ttLoadFeatures();
  ttLoadProjectList().catch(() => {});

  document.getElementById('tt-editor-wrap')?.classList.add('visible');
  ttStartAutoRefresh();
  ttStartWorkerPoll();
  ttStartStackPoll();
  ttLoadTasks().catch(() => {});

  const showAllCb = document.getElementById('tt-show-all');
  const searchInput = document.getElementById('tt-board-search');
  if (showAllCb) {
    showAllCb.checked = ttState.showAll;
    showAllCb.onchange = () => {
      ttState.showAll = showAllCb.checked;
      localStorage.setItem('tt-show-all', showAllCb.checked ? '1' : '0');
      ttRenderBoard();
    };
  }
  if (searchInput) {
    searchInput.value = ttState.searchQuery || '';
    searchInput.oninput = () => {
      ttState.searchQuery = searchInput.value;
      ttRenderBoard();
    };
  }
  ttUpdateHeaderRole();

  ttBindMonoCtxMenu(document.getElementById('tt-comment-input'));
  ttBindMonoCtxMenu(document.getElementById('tt-edit-desc'));
  ttBindMonoCtxMenu(document.getElementById('tt-create-desc'));
  ttBindMonoCtxMenu(document.getElementById('tt-transfer-comment'));

  document.getElementById('tt-create-task-btn-list')?.addEventListener('click', ttOpenCreateTask);
  document.getElementById('tt-create-close')?.addEventListener('click', ttCloseCreateTask);
  document.getElementById('tt-create-cancel')?.addEventListener('click', ttCloseCreateTask);
  document.getElementById('tt-create-save')?.addEventListener('click', () => ttSaveCreateTask());
  document.getElementById('tt-create-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'tt-create-overlay') ttCloseCreateTask();
  });
  document.getElementById('tt-create-title')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      ttSaveCreateTask();
    }
  });
  document.getElementById('tt-create-title')?.addEventListener('input', (e) => ttSyncGrowField(e.target));
  document.getElementById('tt-create-desc')?.addEventListener('input', (e) => ttSyncGrowField(e.target));

  document.getElementById('tt-edit-task-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const task = ttGetTask(ttState.detailTaskId);
    if (!task || !ttCanManageManualTask(task)) return;
    document.getElementById('tt-edit-title').value = ttStripTitleTags(task.title) || task.title;
    document.getElementById('tt-edit-desc').value = task.description || '';
    ttSetManualEditMode(true);
    document.getElementById('tt-edit-title')?.focus();
  });
  document.getElementById('tt-delete-task-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ttDeleteManualTask();
  });
  document.getElementById('tt-edit-cancel-btn')?.addEventListener('click', () => ttSetManualEditMode(false));
  document.getElementById('tt-edit-save-btn')?.addEventListener('click', () => ttSaveManualEdit());

  document.getElementById('tt-feature-close')?.addEventListener('click', () => ttCloseFeaturePicker([]));
  document.getElementById('tt-feature-cancel')?.addEventListener('click', () => ttCloseFeaturePicker([]));
  document.getElementById('tt-feature-confirm')?.addEventListener('click', () => {
    ttCloseFeaturePicker([...ttState.featurePickSelected]);
  });
  document.getElementById('tt-feature-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'tt-feature-overlay') ttCloseFeaturePicker([]);
  });
  document.getElementById('tt-feature-search')?.addEventListener('input', () => {
    ttRenderFeatureTree(ttState.featurePickMode === 'feature');
  });

  document.getElementById('tt-detail-close')?.addEventListener('click', ttCloseDetail);
  ttBindDetailHeadCtxMenu();
  document.getElementById('tt-transfer-close')?.addEventListener('click', ttCloseTransferPopup);
  document.getElementById('tt-transfer-cancel')?.addEventListener('click', ttCloseTransferPopup);

  document.getElementById('tt-detail-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'tt-detail-overlay') ttCloseDetail();
  });
  document.getElementById('tt-transfer-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'tt-transfer-overlay') ttCloseTransferPopup();
  });
  document.getElementById('tt-motivation-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'tt-motivation-overlay') ttCloseMotivation();
  });
  document.getElementById('tt-motivation-close')?.addEventListener('click', ttCloseMotivation);
  document.getElementById('tt-balance-badge')?.addEventListener('click', () => ttOpenMotivation());
  document.getElementById('tt-motivation-payout')?.addEventListener('click', () => ttDoPayout());
  document.getElementById('tt-motivation-backfill')?.addEventListener('click', () => ttDoBackfillClosed());
  document.getElementById('tt-motivation-all')?.addEventListener('change', (e) => {
    ttState.motivationShowAll = !!e.target.checked;
    localStorage.setItem('tt-motivation-all', e.target.checked ? '1' : '0');
    ttRefreshMotivationTable();
  });

  function ttApplyListMode() {
    document.getElementById('tt-board-body')?.classList.toggle('list-mode', ttState.listMode);
    const toolbar = document.getElementById('tt-list-toolbar');
    if (toolbar) toolbar.hidden = !ttState.listMode;
    const btn = document.getElementById('tt-view-toggle');
    if (btn) btn.textContent = ttState.listMode ? '⊞ Канбан' : '☰ Список';
  }
  ttApplyListMode();

  document.getElementById('tt-view-toggle')?.addEventListener('click', () => {
    ttState.listMode = !ttState.listMode;
    localStorage.setItem('tt-list-mode', ttState.listMode ? '1' : '0');
    ttApplyListMode();
  });

  // Restart everything (worker + TT + web server) if something hangs.
  document.getElementById('tt-worker-restart')?.addEventListener('click', async () => {
    const btn = document.getElementById('tt-worker-restart');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '⏳';
    ttNotify('Перезапуск всего (воркер + ТТ + веб-сервер)…', 'system');
    try {
      const r = await fetch('/api/worker/restart', { method: 'POST' });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok) {
        ttNotify('✅ Перезапуск запущен, веб-сервер перезагружается…', 'success');
      } else {
        ttNotify('⚠️ Ошибка перезапуска: ' + (data.output || data.error || r.status), 'error');
      }
    } catch (err) {
      // The web server kills itself during the restart, so the fetch may abort
      // mid-flight. That's expected — the restart is still in progress.
      ttNotify('🔄 Перезапуск запущен, веб-сервер перезагружается…', 'system');
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄';
      // Give the web server a moment to come back, then refresh status.
      setTimeout(() => {
        ttPollWorkerStatus().catch(() => {});
        ttPollStackStatus().catch(() => {});
      }, 4000);
    }
  });

  ttWireDraftComposer();
  ttWireHandoffHotkeys();
  ttWireComposer(document.getElementById('tt-transfer-composer'), () => {
    ttNotify('Выберите роль и нажмите ➜ или закройте задачу', 'system');
  });
  ttLoadBalances().catch(() => {});

  document.getElementById('tt-detail-popup')?.addEventListener('click', (e) => {
    const roleBtn = e.target.closest('.tt-role-switch');
    if (roleBtn) {
      e.preventDefault();
      e.stopPropagation();
      ttSetViewer(roleBtn.dataset.role);
      return;
    }
    if (e.target.closest('.tt-transfer-go')) {
      const goBtn = e.target.closest('.tt-transfer-go');
      if (goBtn?.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      ttDoTransfer(true);
      return;
    }
    if (e.target.closest('#tt-close-task-btn')) {
      e.preventDefault();
      e.stopPropagation();
      ttDoClose(false);
    }
  });

  document.getElementById('tt-transfer-popup')?.addEventListener('click', (e) => {
    const roleBtn = e.target.closest('.tt-role-switch');
    if (roleBtn) {
      e.preventDefault();
      e.stopPropagation();
      ttSetViewer(roleBtn.dataset.role);
      return;
    }
    if (e.target.closest('.tt-transfer-go')) {
      const goBtn = e.target.closest('.tt-transfer-go');
      if (goBtn?.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      ttDoTransfer(false);
    }
  });

  document.getElementById('tt-quick-close-btn')?.addEventListener('click', () => ttDoClose(true));

  document.getElementById('tt-composer-attach')?.addEventListener('click', () => {
    ttNotify('📎 Вложения — в следующей версии', 'system');
  });
}
