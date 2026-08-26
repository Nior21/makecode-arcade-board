#!/usr/bin/env node
/**
 * task-tracker MCP Server
 *
 * Line-based JSON-RPC MCP-сервер для системы заявок/задач.
 * Хранение: плоские JSON-файлы в tasks/, индекс в index.json.
 *
 * Протокол: одна JSON-строка на строку stdin/stdout.
 * Инструменты:
 *   create_task   — создать задачу (авто-расчёт priority_score)
 *   get_task      — получить задачу по ID / #short / префиксу
 *   lookup        — найти задачу или комментарий по #short / UUID
 *   update_task   — обновить поля задачи (пересчёт priority_score)
 *   list_tasks    — список с фильтрацией, сортировка по priority_score
 *   search_tasks  — полнотекстовый поиск
 *   get_project_context — контекст проекта для LLM
 *   add_comment     — добавить комментарий
 *   update_comment  — изменить комментарий
 *   delete_comment  — удалить комментарий
 *   delete_task     — удалить задачу
 *   list_projects   — список проектов
 *   rank_tasks      — переранжировать задачи проекта
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = join(__dirname, 'tasks');
const INDEX_FILE = join(TASKS_DIR, 'index.json');
const LOG_FILE = join(__dirname, 'logs', 'mcp.log');

// ── Ensure directories ──────────────────────────────────────────────
if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });
if (!existsSync(join(__dirname, 'logs'))) mkdirSync(join(__dirname, 'logs'), { recursive: true });

// ── Logging ─────────────────────────────────────────────────────────
function log(...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const msg = `[${ts}] ${args.join(' ')}`;
  try { writeFileSync(LOG_FILE, msg + '\n', { flag: 'a' }); } catch (_) {}
}

// ── Priority score calculation ──────────────────────────────────────
// 0-100, higher = more urgent
// Factors:
//   - base priority: critical=40, high=30, medium=15, low=0
//   - status bonus: open=+10, in_progress=+5, done/cancelled=0
//   - tag bonus: +5 per tag from {bug,blocker,security,urgent,crash,deploy}
//   - description length bonus: +5 if desc > 100 chars (well-defined task)
//   - due_date urgency: if due_date < now → +20; if < 24h → +15; if < 72h → +5
//   - age bonus: +1 per day since created_at (up to +20)
function calcPriorityScore(task) {
  let score = 0;

  // Base priority
  const priorityMap = { critical: 40, high: 30, medium: 15, low: 0 };
  score += priorityMap[task.priority] || 15;

  // Status bonus
  const statusMap = { open: 10, in_progress: 5, done: 0, cancelled: 0 };
  score += statusMap[task.status] || 0;

  // Tag bonus
  const urgentTags = ['bug', 'blocker', 'security', 'urgent', 'crash', 'deploy', 'hotfix'];
  const tags = task.tags || [];
  for (const tag of tags) {
    if (urgentTags.includes(tag.toLowerCase())) score += 5;
  }

  // Description quality bonus
  if (task.description && task.description.length > 100) score += 5;

  // Due date urgency
  if (task.due_date) {
    const due = new Date(task.due_date).getTime();
    const now = Date.now();
    const diffMs = due - now;
    const diffHours = diffMs / 3600000;
    if (diffMs < 0) score += 20;           // overdue
    else if (diffHours < 24) score += 15;   // within 24h
    else if (diffHours < 72) score += 5;    // within 3 days
  }

  // Age bonus (1 point per day since creation, max 20)
  if (task.created_at) {
    const created = new Date(task.created_at).getTime();
    const daysOld = Math.floor((Date.now() - created) / 86400000);
    score += Math.min(daysOld, 20);
  }

  return Math.min(Math.max(Math.round(score), 0), 100);
}

// ── Index ───────────────────────────────────────────────────────────
function loadIndex() {
  if (!existsSync(INDEX_FILE)) return { tasks: [], projects: {} };
  try {
    return JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    return rebuildIndex();
  }
}

function saveIndex(index) {
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

function rebuildIndex() {
  const files = readdirSync(TASKS_DIR).filter(f => f.endsWith('.json') && f !== 'index.json');
  const tasks = [];
  const projects = {};

  for (const file of files) {
    try {
      const task = JSON.parse(readFileSync(join(TASKS_DIR, file), 'utf8'));
      tasks.push(task.id);
      if (task.project) {
        if (!projects[task.project]) projects[task.project] = [];
        projects[task.project].push(task.id);
      }
    } catch (_) {}
  }

  const index = { tasks, projects };
  saveIndex(index);
  return index;
}

// ── Task CRUD ───────────────────────────────────────────────────────
function taskFilePath(id) {
  return join(TASKS_DIR, `${id}.json`);
}

function createTask(fields) {
  const id = randomUUID();
  const now = new Date().toISOString();

  const task = {
    id,
    project: fields.project || 'default',
    title: fields.title || '',
    description: fields.description || '',
    role: fields.role || 'developer',
    assignee: fields.assignee || fields.role || 'Developer',
    status: fields.status || 'open',
    priority: fields.priority || 'medium',
    priority_score: 0,
    tags: fields.tags || [],
    location: fields.location || '',
    comments: fields.comments || [],
    participants: fields.participants || (fields.assignee ? [fields.assignee] : fields.role ? [fields.role] : []),
    created_by: fields.created_by || fields.assignee || null,
    qa_result: fields.qa_result || null,
    delivery_commit: fields.delivery_commit || null,
    points: Number.isFinite(Number(fields.points)) ? Math.max(1, Math.min(99, Number(fields.points))) : 1,
    points_awarded: fields.points_awarded ?? null,
    deleted: !!fields.deleted,
    deleted_at: fields.deleted_at || null,
    created_at: now,
    updated_at: now,
    due_date: fields.due_date || null,
  };

  // Auto-calculate priority_score
  task.priority_score = calcPriorityScore(task);

  writeFileSync(taskFilePath(id), JSON.stringify(task, null, 2));

  // Update index
  const index = loadIndex();
  index.tasks.push(id);
  if (task.project) {
    if (!index.projects[task.project]) index.projects[task.project] = [];
    index.projects[task.project].push(id);
  }
  saveIndex(index);

  log(`CREATE ${id} — ${task.project}/${task.title} (score:${task.priority_score})`);
  return task;
}

function getTask(id) {
  const file = taskFilePath(id);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Accept full UUID, `#8c9cb87e`, or unique prefix (with/without dashes). */
function normalizeIdRef(ref) {
  return String(ref || '').replace(/^#/, '').trim();
}

function resolveTaskId(ref) {
  const raw = normalizeIdRef(ref);
  if (!raw) return { id: null, matches: [] };
  if (getTask(raw)) return { id: raw, matches: [raw] };

  const needle = raw.toLowerCase();
  const compact = needle.replace(/-/g, '');
  const index = loadIndex();
  const matches = (index.tasks || []).filter(id => {
    const low = String(id).toLowerCase();
    return low === needle
      || low.startsWith(needle)
      || low.replace(/-/g, '').startsWith(compact);
  });
  if (matches.length === 1) return { id: matches[0], matches };
  return { id: null, matches };
}

function resolveTask(ref) {
  const { id, matches } = resolveTaskId(ref);
  if (!id) return { task: null, matches };
  return { task: getTask(id), matches };
}

function resolveComment(ref, { project } = {}) {
  const raw = normalizeIdRef(ref);
  if (!raw) return { task: null, comment: null, matches: [] };
  const needle = raw.toLowerCase();
  const compact = needle.replace(/-/g, '');
  const index = loadIndex();
  let ids = index.tasks || [];
  if (project && index.projects?.[project]) ids = index.projects[project];
  const matches = [];
  for (const tid of ids) {
    const task = getTask(tid);
    if (!task?.comments) continue;
    for (const c of task.comments) {
      if (!c?.id) continue;
      const low = String(c.id).toLowerCase();
      if (low === needle || low.startsWith(needle) || low.replace(/-/g, '').startsWith(compact)) {
        matches.push({ task_id: task.id, comment_id: c.id, task, comment: c });
      }
    }
  }
  if (matches.length === 1) {
    return { task: matches[0].task, comment: matches[0].comment, matches };
  }
  return { task: null, comment: null, matches };
}

function lookupByRef(ref, { project } = {}) {
  const raw = normalizeIdRef(ref);
  if (!raw) return { type: null, error: 'ref required' };

  const asTask = resolveTask(raw);
  if (asTask.task) {
    return { type: 'task', ref: raw, id: asTask.task.id, task: asTask.task };
  }

  const asComment = resolveComment(raw, { project });
  if (asComment.comment) {
    return {
      type: 'comment',
      ref: raw,
      id: asComment.comment.id,
      task_id: asComment.task.id,
      task: asComment.task,
      comment: asComment.comment,
    };
  }

  const candidates = [
    ...asTask.matches.map(id => ({ type: 'task', id })),
    ...asComment.matches.map(m => ({ type: 'comment', id: m.comment_id, task_id: m.task_id })),
  ];
  if (candidates.length) {
    return { type: null, error: 'ambiguous', ref: raw, candidates };
  }
  return { type: null, error: 'not found', ref: raw };
}

function updateTask(idOrRef, updates) {
  const { id } = resolveTaskId(idOrRef);
  if (!id) return null;
  const task = getTask(id);
  if (!task) return null;

  const oldProject = task.project;

  const prevAssignee = task.assignee;

  // Apply updates (whitelist of mutable fields)
  const mutable = ['title', 'description', 'status', 'priority', 'tags', 'due_date', 'role', 'location', 'assignee', 'qa_result', 'delivery_commit', 'participants', 'points', 'points_awarded', 'deleted', 'deleted_at'];
  for (const key of mutable) {
    if (updates[key] !== undefined) task[key] = updates[key];
  }
  if (updates.assignee !== undefined && updates.assignee !== prevAssignee && prevAssignee) {
    if (task.status !== 'cancelled') task.status = 'open';
    if (!task.comments) task.comments = [];
    const handoffAt = new Date().toISOString();
    task.comments.push({
      id: randomUUID(),
      author: updates.actor || prevAssignee || 'system',
      text: `↪ Передано: ${prevAssignee} → ${updates.assignee}`,
      stars: 0,
      created_at: handoffAt,
      updated_at: null,
      composed_from: handoffAt,
      composed_to: handoffAt,
    });
  }
  task.updated_at = new Date().toISOString();

  // Recalculate priority_score
  task.priority_score = calcPriorityScore(task);

  writeFileSync(taskFilePath(id), JSON.stringify(task, null, 2));

  // Update index if project changed
  if (updates.project && updates.project !== oldProject) {
    const index = loadIndex();
    if (index.projects[oldProject]) {
      index.projects[oldProject] = index.projects[oldProject].filter(t => t !== id);
      if (index.projects[oldProject].length === 0) delete index.projects[oldProject];
    }
    task.project = updates.project;
    if (!index.projects[task.project]) index.projects[task.project] = [];
    index.projects[task.project].push(id);
    saveIndex(index);
  }

  log(`UPDATE ${id} — ${task.status} (score:${task.priority_score})`);
  return task;
}

function deleteTask(idOrRef) {
  const { id } = resolveTaskId(idOrRef);
  if (!id) return null;
  const task = getTask(id);
  if (!task) return null;
  if (task.deleted) {
    const file = taskFilePath(id);
    if (existsSync(file)) unlinkSync(file);
    const index = loadIndex();
    index.tasks = index.tasks.filter(t => t !== id);
    if (task.project && index.projects[task.project]) {
      index.projects[task.project] = index.projects[task.project].filter(t => t !== id);
      if (index.projects[task.project].length === 0) delete index.projects[task.project];
    }
    saveIndex(index);
    log(`PURGE ${id} — ${task.title}`);
    return { ok: true, id, purged: true };
  }
  task.deleted = true;
  task.deleted_at = new Date().toISOString();
  task.status = 'cancelled';
  task.updated_at = task.deleted_at;
  task.priority_score = calcPriorityScore(task);
  writeFileSync(taskFilePath(id), JSON.stringify(task, null, 2));
  log(`TRASH ${id} — ${task.title}`);
  return task;
}

function addComment(taskIdOrRef, author, text, meta = {}) {
  const { id: taskId } = resolveTaskId(taskIdOrRef);
  if (!taskId) return null;
  const task = getTask(taskId);
  if (!task) return null;
  if (!task.comments) task.comments = [];
  const now = new Date().toISOString();
  const entry = {
    id: randomUUID(),
    author: author || 'Unknown',
    text: String(text || '').trim(),
    created_at: now,
    updated_at: null,
  };
  if (meta.composed_from) entry.composed_from = meta.composed_from;
  if (meta.composed_to) entry.composed_to = meta.composed_to;
  if (meta.commit_sha) entry.commit_sha = String(meta.commit_sha);
  if (meta.version) entry.version = String(meta.version);
  if (meta.bump) entry.bump = String(meta.bump);
  task.comments.push(entry);
  if (entry.commit_sha) {
    task.delivery_commit = {
      sha: entry.commit_sha,
      shortSha: String(meta.short_sha || meta.shortSha || entry.commit_sha).slice(0, 12),
      version: entry.version || null,
      bump: entry.bump || null,
      message: meta.commit_message || null,
      at: now,
    };
  }
  if (author) {
    if (!task.participants) task.participants = [];
    if (!task.participants.includes(author)) task.participants.push(author);
  }
  task.updated_at = now;
  writeFileSync(taskFilePath(taskId), JSON.stringify(task, null, 2));
  log(`COMMENT ${taskId} — ${author}`);
  return task;
}

function updateComment(taskIdOrRef, commentId, updates) {
  const { id: taskId } = resolveTaskId(taskIdOrRef);
  if (!taskId) return null;
  const task = getTask(taskId);
  if (!task?.comments) return null;
  const raw = normalizeIdRef(commentId);
  let comment = task.comments.find(c => c.id === commentId || c.id === raw);
  if (!comment && raw) {
    const needle = raw.toLowerCase();
    const hits = task.comments.filter(c => String(c.id).toLowerCase().startsWith(needle));
    comment = hits.length === 1 ? hits[0] : null;
  }
  if (!comment) return null;
  const now = new Date().toISOString();
  if (updates.text !== undefined) comment.text = String(updates.text || '').trim();
  if (updates.author !== undefined && updates.author !== comment.author) {
    if (!Array.isArray(comment.author_history)) comment.author_history = [];
    comment.author_history.push({
      from: comment.author,
      to: updates.author,
      actor: updates.actor || 'system',
      at: now,
    });
    comment.author = updates.author;
  }
  comment.updated_at = now;
  task.updated_at = comment.updated_at;
  writeFileSync(taskFilePath(taskId), JSON.stringify(task, null, 2));
  log(`COMMENT_EDIT ${taskId}/${comment.id}`);
  return task;
}

function deleteComment(taskIdOrRef, commentId) {
  const { id: taskId } = resolveTaskId(taskIdOrRef);
  if (!taskId) return null;
  const task = getTask(taskId);
  if (!task?.comments) return null;
  const raw = normalizeIdRef(commentId);
  let targetId = commentId;
  if (!task.comments.some(c => c.id === commentId)) {
    const needle = raw.toLowerCase();
    const hits = task.comments.filter(c => String(c.id).toLowerCase().startsWith(needle));
    if (hits.length !== 1) return null;
    targetId = hits[0].id;
  }
  const before = task.comments.length;
  task.comments = task.comments.filter(c => c.id !== targetId);
  if (task.comments.length === before) return null;
  task.updated_at = new Date().toISOString();
  writeFileSync(taskFilePath(taskId), JSON.stringify(task, null, 2));
  log(`COMMENT_DEL ${taskId}/${targetId}`);
  return task;
}

function listProjects() {
  const index = loadIndex();
  return Object.keys(index.projects || {}).sort();
}

function listTasks(filter = {}) {
  const index = loadIndex();
  let ids = [...index.tasks];

  // Filter by project
  if (filter.project) {
    ids = index.projects[filter.project] || [];
  }

  // Load all matching tasks
  let tasks = ids.map(id => getTask(id)).filter(Boolean);

  // Filter by status
  if (filter.status) {
    tasks = tasks.filter(t => t.status === filter.status);
  }

  // Filter by priority
  if (filter.priority) {
    tasks = tasks.filter(t => t.priority === filter.priority);
  }

  // Filter by role
  if (filter.role) {
    tasks = tasks.filter(t => t.role === filter.role);
  }

  if (filter.assignee) {
    tasks = tasks.filter(t => t.assignee === filter.assignee);
  }

  // Filter by date range
  if (filter.created_after) {
    tasks = tasks.filter(t => t.created_at >= filter.created_after);
  }
  if (filter.created_before) {
    tasks = tasks.filter(t => t.created_at <= filter.created_before);
  }

  // Sort by priority_score desc (most urgent first), then by created_at desc
  tasks.sort((a, b) => {
    const scoreDiff = (b.priority_score || 0) - (a.priority_score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });

  // Limit
  const limit = filter.limit || 50;
  tasks = tasks.slice(0, limit);

  return tasks;
}

function searchTasks(query) {
  const index = loadIndex();
  const raw = normalizeIdRef(query);
  const q = raw.toLowerCase();
  const compact = q.replace(/-/g, '');
  const results = [];

  for (const id of index.tasks) {
    const task = getTask(id);
    if (!task) continue;

    const idLow = String(task.id || '').toLowerCase();
    const idHit = idLow === q
      || idLow.startsWith(q)
      || idLow.replace(/-/g, '').startsWith(compact)
      || (task.comments || []).some(c => {
        const cid = String(c.id || '').toLowerCase();
        return cid === q || cid.startsWith(q) || cid.replace(/-/g, '').startsWith(compact);
      });

    const searchable = [
      task.title,
      task.description,
      task.project,
      (task.tags || []).join(' '),
      task.role,
      task.location,
      task.id,
      ...(task.comments || []).map(c => `${c.id} ${c.author} ${c.text}`),
    ].join(' ').toLowerCase();

    if (idHit || searchable.includes(q)) {
      results.push(task);
    }
  }

  // Sort by priority_score desc
  results.sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0));
  return results.slice(0, 30);
}

function getProjectContext(projectName) {
  const index = loadIndex();
  const taskIds = index.projects[projectName] || [];
  const tasks = taskIds.map(id => getTask(id)).filter(Boolean);

  // Stats
  const total = tasks.length;
  const open = tasks.filter(t => t.status === 'open').length;
  const inProgress = tasks.filter(t => t.status === 'in_progress').length;
  const done = tasks.filter(t => t.status === 'done').length;

  // Top urgent (sorted by priority_score)
  const urgent = [...tasks]
    .filter(t => t.status !== 'done' && t.status !== 'cancelled')
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0))
    .slice(0, 10)
    .map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      priority_score: t.priority_score,
      tags: t.tags,
    }));

  // Recent activity (last 10 updates)
  const recent = [...tasks]
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .slice(0, 10)
    .map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      priority_score: t.priority_score,
      updated_at: t.updated_at,
    }));

  return {
    project: projectName,
    stats: { total, open, inProgress, done },
    urgent,
    recent,
    tasks: tasks.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      priority_score: t.priority_score,
      role: t.role,
      tags: t.tags,
      created_at: t.created_at,
    })),
  };
}

function rankTasks(projectName) {
  const index = loadIndex();
  const taskIds = index.projects[projectName] || [];
  let updated = 0;

  for (const id of taskIds) {
    const task = getTask(id);
    if (!task) continue;
    const newScore = calcPriorityScore(task);
    if (task.priority_score !== newScore) {
      task.priority_score = newScore;
      task.updated_at = new Date().toISOString();
      writeFileSync(taskFilePath(id), JSON.stringify(task, null, 2));
      updated++;
    }
  }

  log(`RANK ${projectName} — ${updated} tasks updated`);
  return { project: projectName, updated };
}

// ── MCP Protocol ────────────────────────────────────────────────────
function handleRequest(req) {
  const { id, method, params } = req;

  try {
    let result;

    switch (method) {
      case 'create_task': {
        if (!params || !params.title) {
          return { id, error: { code: -32602, message: 'title is required' } };
        }
        result = createTask(params);
        break;
      }

      case 'get_task': {
        if (!params || !params.id) {
          return { id, error: { code: -32602, message: 'id is required' } };
        }
        const resolved = resolveTask(params.id);
        if (!resolved.task) {
          const msg = resolved.matches.length
            ? `Ambiguous id ${params.id}`
            : `Task ${params.id} not found`;
          return { id, error: { code: -32601, message: msg } };
        }
        result = resolved.task;
        break;
      }

      case 'lookup': {
        if (!params || !(params.ref || params.id)) {
          return { id, error: { code: -32602, message: 'ref is required' } };
        }
        result = lookupByRef(params.ref || params.id, { project: params.project });
        if (result.error === 'not found' || result.error === 'ambiguous' || result.error === 'ref required') {
          return { id, error: { code: -32601, message: result.error } };
        }
        break;
      }

      case 'update_task': {
        if (!params || !params.id) {
          return { id, error: { code: -32602, message: 'id is required' } };
        }
        const updated = updateTask(params.id, params.updates || {});
        if (!updated) {
          return { id, error: { code: -32601, message: `Task ${params.id} not found` } };
        }
        result = updated;
        break;
      }

      case 'list_tasks': {
        result = listTasks(params || {});
        break;
      }

      case 'search_tasks': {
        if (!params || !params.query) {
          return { id, error: { code: -32602, message: 'query is required' } };
        }
        result = searchTasks(params.query);
        break;
      }

      case 'get_project_context': {
        if (!params || !params.project) {
          return { id, error: { code: -32602, message: 'project is required' } };
        }
        result = getProjectContext(params.project);
        break;
      }

      case 'rank_tasks': {
        if (!params || !params.project) {
          return { id, error: { code: -32602, message: 'project is required' } };
        }
        result = rankTasks(params.project);
        break;
      }

      case 'add_comment': {
        if (!params || !params.id) {
          return { id, error: { code: -32602, message: 'id is required' } };
        }
        if (!params.text) {
          return { id, error: { code: -32602, message: 'text is required' } };
        }
        const commented = addComment(params.id, params.author, params.text, {
          composed_from: params.composed_from,
          composed_to: params.composed_to,
          commit_sha: params.commit_sha,
          short_sha: params.short_sha,
          version: params.version,
          bump: params.bump,
          commit_message: params.commit_message,
        });
        if (!commented) {
          return { id, error: { code: -32601, message: `Task ${params.id} not found` } };
        }
        result = commented;
        break;
      }

      case 'update_comment': {
        if (!params?.id || !params?.comment_id) {
          return { id, error: { code: -32602, message: 'id and comment_id are required' } };
        }
        const updated = updateComment(params.id, params.comment_id, params);
        if (!updated) {
          return { id, error: { code: -32601, message: 'Task or comment not found' } };
        }
        result = updated;
        break;
      }

      case 'delete_comment': {
        if (!params?.id || !params?.comment_id) {
          return { id, error: { code: -32602, message: 'id and comment_id are required' } };
        }
        const updated = deleteComment(params.id, params.comment_id);
        if (!updated) {
          return { id, error: { code: -32601, message: 'Task or comment not found' } };
        }
        result = updated;
        break;
      }

      case 'delete_task': {
        if (!params?.id) {
          return { id, error: { code: -32602, message: 'id is required' } };
        }
        const deleted = deleteTask(params.id);
        if (!deleted) {
          return { id, error: { code: -32601, message: `Task ${params.id} not found` } };
        }
        result = deleted;
        break;
      }

      case 'list_projects': {
        result = listProjects();
        break;
      }

      case 'tools/list': {
        result = {
          tools: [
            {
              name: 'create_task',
              description: 'Создать новую задачу',
              inputSchema: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Заголовок задачи' },
                  description: { type: 'string', description: 'Описание задачи' },
                  priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Приоритет' },
                  status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'], description: 'Статус' },
                  project: { type: 'string', description: 'Проект' },
                  assignee: { type: 'string', description: 'Исполнитель' },
                  tags: { type: 'array', items: { type: 'string' }, description: 'Теги' },
                  due_date: { type: 'string', description: 'Срок (ISO date)' }
                },
                required: ['title']
              }
            },
            {
              name: 'get_task',
              description: 'Получить задачу по ID (UUID, #short или уникальный префикс)',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'ID задачи: UUID / #8c9cb87e / префикс' }
                },
                required: ['id']
              }
            },
            {
              name: 'lookup',
              description: 'Найти задачу или комментарий по #short / UUID / префиксу',
              inputSchema: {
                type: 'object',
                properties: {
                  ref: { type: 'string', description: 'Ссылка: #8c9cb87e или UUID задачи/комментария' },
                  project: { type: 'string', description: 'Опционально сузить поиск комментария' }
                },
                required: ['ref']
              }
            },
            {
              name: 'update_task',
              description: 'Обновить задачу',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'ID задачи (UUID / #short / префикс)' },
                  updates: {
                    type: 'object',
                    description: 'Поля для обновления',
                    properties: {
                      title: { type: 'string' },
                      description: { type: 'string' },
                      priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
                      status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] },
                      project: { type: 'string' },
                      assignee: { type: 'string' },
                      tags: { type: 'array', items: { type: 'string' } },
                      due_date: { type: 'string' },
                      delivery_commit: {
                        type: 'object',
                        description: 'Последний коммит агента: { sha, shortSha, version, bump, message, at }',
                      },
                    }
                  }
                },
                required: ['id']
              }
            },
            {
              name: 'list_tasks',
              description: 'Список задач с фильтрацией',
              inputSchema: {
                type: 'object',
                properties: {
                  project: { type: 'string', description: 'Фильтр по проекту' },
                  status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'], description: 'Фильтр по статусу' },
                  priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Фильтр по приоритету' },
                  assignee: { type: 'string', description: 'Фильтр по исполнителю' },
                  limit: { type: 'number', description: 'Лимит записей' }
                }
              }
            },
            {
              name: 'search_tasks',
              description: 'Полнотекстовый поиск по задачам',
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: 'Поисковый запрос' }
                },
                required: ['query']
              }
            },
            {
              name: 'get_project_context',
              description: 'Контекст проекта для LLM',
              inputSchema: {
                type: 'object',
                properties: {
                  project: { type: 'string', description: 'Название проекта' }
                },
                required: ['project']
              }
            },
            {
              name: 'rank_tasks',
              description: 'Переранжировать задачи проекта по priority_score',
              inputSchema: {
                type: 'object',
                properties: {
                  project: { type: 'string', description: 'Название проекта' }
                },
                required: ['project']
              }
            },
            {
              name: 'add_comment',
              description: 'Добавить комментарий к задаче (author: AI_Agent, Developer, QA_Engineer)',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'ID задачи' },
                  author: { type: 'string', description: 'Автор комментария' },
                  text: { type: 'string', description: 'Текст комментария' },
                  commit_sha: { type: 'string', description: 'Полный или короткий SHA коммита (опционально)' },
                  short_sha: { type: 'string', description: 'Короткий SHA для UI' },
                  version: { type: 'string', description: 'Semver, напр. v.1.0.1' },
                  bump: { type: 'string', enum: ['patch', 'minor', 'major'], description: 'Уровень semver-bump' },
                  commit_message: { type: 'string', description: 'Полное сообщение коммита' },
                },
                required: ['id', 'text']
              }
            },
            {
              name: 'update_comment',
              description: 'Изменить комментарий',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'ID задачи' },
                  comment_id: { type: 'string', description: 'ID комментария' },
                  text: { type: 'string', description: 'Новый текст' },
                  author: { type: 'string', description: 'Новый автор' }
                },
                required: ['id', 'comment_id']
              }
            },
            {
              name: 'delete_comment',
              description: 'Удалить комментарий',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'ID задачи' },
                  comment_id: { type: 'string', description: 'ID комментария' }
                },
                required: ['id', 'comment_id']
              }
            },
            {
              name: 'delete_task',
              description: 'Удалить задачу',
              inputSchema: {
                type: 'object',
                properties: { id: { type: 'string', description: 'ID задачи' } },
                required: ['id']
              }
            },
            {
              name: 'list_projects',
              description: 'Список имён проектов',
              inputSchema: { type: 'object', properties: {} }
            }
          ]
        };
        break;
      }

      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        switch (toolName) {
          case 'create_task':
            result = createTask(toolArgs);
            break;
          case 'get_task': {
            const resolved = resolveTask(toolArgs.id);
            result = resolved.task;
            if (!result) {
              const msg = resolved.matches.length
                ? `Ambiguous id ${toolArgs.id}`
                : `Task ${toolArgs.id} not found`;
              return { id, error: { code: -32601, message: msg } };
            }
            break;
          }
          case 'lookup': {
            result = lookupByRef(toolArgs.ref || toolArgs.id, { project: toolArgs.project });
            if (result.error === 'not found') {
              return { id, error: { code: -32601, message: `Not found: ${toolArgs.ref || toolArgs.id}` } };
            }
            if (result.error === 'ambiguous') {
              return { id, error: { code: -32602, message: `Ambiguous ref: ${toolArgs.ref || toolArgs.id}` } };
            }
            break;
          }
          case 'update_task':
            result = updateTask(toolArgs.id, toolArgs.updates || {});
            if (!result) {
              return { id, error: { code: -32601, message: `Task ${toolArgs.id} not found` } };
            }
            break;
          case 'list_tasks':
            result = listTasks(toolArgs);
            break;
          case 'search_tasks':
            result = searchTasks(toolArgs.query);
            break;
          case 'get_project_context':
            result = getProjectContext(toolArgs.project);
            break;
          case 'rank_tasks':
            result = rankTasks(toolArgs.project);
            break;
          case 'add_comment': {
            const commented = addComment(toolArgs.id, toolArgs.author, toolArgs.text, {
              composed_from: toolArgs.composed_from,
              composed_to: toolArgs.composed_to,
              commit_sha: toolArgs.commit_sha,
              short_sha: toolArgs.short_sha,
              version: toolArgs.version,
              bump: toolArgs.bump,
              commit_message: toolArgs.commit_message,
            });
            if (!commented) {
              return { id, error: { code: -32601, message: `Task ${toolArgs.id} not found` } };
            }
            result = commented;
            break;
          }
          case 'update_comment': {
            const updated = updateComment(toolArgs.id, toolArgs.comment_id, toolArgs);
            if (!updated) {
              return { id, error: { code: -32601, message: 'Task or comment not found' } };
            }
            result = updated;
            break;
          }
          case 'delete_comment': {
            const updated = deleteComment(toolArgs.id, toolArgs.comment_id);
            if (!updated) {
              return { id, error: { code: -32601, message: 'Task or comment not found' } };
            }
            result = updated;
            break;
          }
          case 'delete_task': {
            const deleted = deleteTask(toolArgs.id);
            if (!deleted) {
              return { id, error: { code: -32601, message: `Task ${toolArgs.id} not found` } };
            }
            result = deleted;
            break;
          }
          case 'list_projects':
            result = listProjects();
            break;
          default:
            return { id, error: { code: -32601, message: `Unknown tool: ${toolName}` } };
        }
        break;
      }

      default:
        return { id, error: { code: -32601, message: `Unknown method: ${method}` } };
    }

    return { id, result };
  } catch (err) {
    log(`ERROR ${method}: ${err.message}`);
    return { id, error: { code: -32603, message: err.message } };
  }
}

// ── Exports (for HTTP wrapper) ──────────────────────────────────────
export { handleRequest };

// ── Main loop ───────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });

log('MCP server started');

rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;

  try {
    const req = JSON.parse(line);
    const res = handleRequest(req);
    console.log(JSON.stringify(res));
  } catch (err) {
    log(`PARSE ERROR: ${err.message} — input: ${line.slice(0, 200)}`);
    console.log(JSON.stringify({ id: null, error: { code: -32700, message: 'Parse error' } }));
  }
});

process.on('SIGTERM', () => {
  log('MCP server stopped');
  process.exit(0);
});
