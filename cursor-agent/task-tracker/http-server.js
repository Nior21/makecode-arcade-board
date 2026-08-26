#!/usr/bin/env node
/**
 * task-tracker MCP HTTP Server (Streamable HTTP)
 * Запуск: TT_PORT=3100 node http-server.js
 */

import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  webhookConfig,
  buildAssigneeWebhookPayload,
  postWebhook,
  maybeNotifyAssigneeToAgent,
} from './lib/outbound-webhook.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.TT_PORT || '3100', 10);
const SUPPORTED_VERSION = '2025-03-26';
const LOG_FILE = join(__dirname, 'logs', 'http.log');
const TASKS_DIR = join(__dirname, 'tasks');
const INDEX_FILE = join(TASKS_DIR, 'index.json');
const MOTIVATION_DIR = join(__dirname, 'motivation');
const MOTIVATION_FILE = join(MOTIVATION_DIR, 'events.json');

// ── Logging ─────────────────────────────────────────────────────────
function log(...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const msg = `[${ts}] ${args.join(' ')}`;
  try {
    if (!existsSync(join(__dirname, 'logs'))) mkdirSync(join(__dirname, 'logs'), { recursive: true });
    writeFileSync(LOG_FILE, msg + '\n', { flag: 'a' });
  } catch (_) {}
  console.error(msg);
}

// ── Priority score calculation ──────────────────────────────────────
function calcPriorityScore(task) {
  let score = 0;
  const priorityMap = { critical: 40, high: 30, medium: 15, low: 0 };
  score += priorityMap[task.priority] || 15;
  const statusMap = { open: 10, in_progress: 5, done: 0, cancelled: 0 };
  score += statusMap[task.status] || 0;
  const urgentTags = ['bug', 'blocker', 'security', 'urgent', 'crash', 'deploy', 'hotfix'];
  const tags = task.tags || [];
  for (const tag of tags) {
    if (urgentTags.includes(tag.toLowerCase())) score += 5;
  }
  if (task.description && task.description.length > 100) score += 5;
  if (task.due_date) {
    const due = new Date(task.due_date).getTime();
    const now = Date.now();
    const diffMs = due - now;
    const diffHours = diffMs / 3600000;
    if (diffMs < 0) score += 20;
    else if (diffHours < 24) score += 15;
    else if (diffHours < 72) score += 5;
  }
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
    feature_ids: Array.isArray(fields.feature_ids) ? fields.feature_ids : [],
    deleted: !!fields.deleted,
    deleted_at: fields.deleted_at || null,
    created_at: now,
    updated_at: now,
    due_date: fields.due_date || null,
  };
  task.priority_score = calcPriorityScore(task);
  writeFileSync(taskFilePath(id), JSON.stringify(task, null, 2));
  const index = loadIndex();
  index.tasks.push(id);
  if (task.project) {
    if (!index.projects[task.project]) index.projects[task.project] = [];
    index.projects[task.project].push(id);
  }
  saveIndex(index);
  log(`CREATE ${id} — ${task.project}/${task.title} (score:${task.priority_score})`);
  maybeNotifyAssigneeToAgent({
    task,
    prevAssignee: null,
    actor: fields.actor || fields.created_by || null,
    isCreate: true,
  }, log);
  return task;
}

function normalizeTask(task) {
  if (!task) return task;
  let changed = false;
  if (task.comments?.length) {
    task.comments.forEach((c, i) => {
      if (!c.id) {
        c.id = `legacy-${i}-${task.id.slice(0, 8)}`;
        changed = true;
      }
    });
  }
  if (!task.participants?.length) {
    task.participants = task.assignee ? [task.assignee] : [];
    changed = true;
  } else if (task.assignee && !task.participants.includes(task.assignee)) {
    task.participants.push(task.assignee);
    changed = true;
  }
  if ((task.tags || []).includes('manual') && !task.created_by && task.assignee) {
    task.created_by = task.assignee;
    changed = true;
  }
  if (task.points == null) {
    task.points = 1;
    changed = true;
  }
  if (task.deleted == null) {
    task.deleted = false;
    changed = true;
  }
  if (changed) {
    task.updated_at = new Date().toISOString();
    writeFileSync(taskFilePath(task.id), JSON.stringify(task, null, 2));
  }
  return task;
}

function normalizeComments(task) {
  return normalizeTask(task);
}

function getTask(id) {
  const file = taskFilePath(id);
  if (!existsSync(file)) return null;
  try {
    return normalizeTask(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/** Task snapshot for AI agent / webhooks — hides soft-deleted comments. */
function taskForAgentContext(task) {
  if (!task) return task;
  const comments = (task.comments || []).filter(c => !c.deleted);
  return { ...task, comments };
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

/** Find comment by full/short id across all tasks (optionally scoped to project). */
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

/** Unified lookup: task or comment by #short / UUID. */
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
  const oldPoints = task.points;
  const prevAssignee = task.assignee;
  const mutable = ['title', 'description', 'status', 'priority', 'tags', 'due_date', 'role', 'location', 'assignee', 'qa_result', 'delivery_commit', 'participants', 'points', 'points_awarded', 'deleted', 'deleted_at', 'feature_ids'];
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
  if (updates.points !== undefined) {
    task.points = Math.max(1, Math.min(99, Number(updates.points) || 1));
  }
  task.updated_at = new Date().toISOString();
  task.priority_score = calcPriorityScore(task);
  writeFileSync(taskFilePath(id), JSON.stringify(task, null, 2));
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
  if (updates.points !== undefined && Number(oldPoints) !== Number(task.points)) {
    addMotivationEvent({
      project: task.project,
      type: 'task_estimate',
      user: updates.actor || task.assignee || 'Unknown',
      actor: updates.actor || task.assignee || 'Unknown',
      amount: 0,
      task_id: task.id,
      points: task.points,
      note: `План: ${oldPoints} → ${task.points}`,
    });
  }
  log(`UPDATE ${id} — ${task.status} (score:${task.priority_score})`);
  if (updates.assignee !== undefined) {
    maybeNotifyAssigneeToAgent({
      task,
      prevAssignee,
      actor: updates.actor || null,
      isCreate: false,
    }, log);
  }
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

function listTasks(filter = {}) {
  const index = loadIndex();
  let ids = [...index.tasks];
  if (filter.project) {
    ids = index.projects[filter.project] || [];
  }
  let tasks = ids.map(id => getTask(id)).filter(Boolean);
  if (filter.status) tasks = tasks.filter(t => t.status === filter.status);
  if (filter.priority) tasks = tasks.filter(t => t.priority === filter.priority);
  if (filter.role) tasks = tasks.filter(t => t.role === filter.role);
  if (filter.assignee) tasks = tasks.filter(t => t.assignee === filter.assignee);
  if (filter.created_after) tasks = tasks.filter(t => t.created_at >= filter.created_after);
  if (filter.created_before) tasks = tasks.filter(t => t.created_at <= filter.created_before);
  tasks.sort((a, b) => {
    const scoreDiff = (b.priority_score || 0) - (a.priority_score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
  const limit = filter.limit || 50;
  return tasks.slice(0, limit);
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
      task.title, task.description, task.project,
      (task.tags || []).join(' '), task.role, task.location, task.id,
      ...(task.comments || []).map(c => `${c.id} ${c.author} ${c.text}`),
    ].join(' ').toLowerCase();
    if (idHit || searchable.includes(q)) results.push(task);
  }
  results.sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0));
  return results.slice(0, 30);
}

function getProjectContext(projectName) {
  const index = loadIndex();
  const taskIds = index.projects[projectName] || [];
  const tasks = taskIds.map(id => getTask(id)).filter(Boolean);
  const total = tasks.length;
  const open = tasks.filter(t => t.status === 'open').length;
  const inProgress = tasks.filter(t => t.status === 'in_progress').length;
  const done = tasks.filter(t => t.status === 'done').length;
  const urgent = [...tasks]
    .filter(t => t.status !== 'done' && t.status !== 'cancelled')
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0))
    .slice(0, 10)
    .map(t => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, priority_score: t.priority_score, tags: t.tags }));
  const recent = [...tasks]
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .slice(0, 10)
    .map(t => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, priority_score: t.priority_score, updated_at: t.updated_at }));
  return {
    project: projectName,
    stats: { total, open, inProgress, done },
    urgent,
    recent,
    tasks: tasks.map(t => ({
      id: t.id, title: t.title, status: t.status, priority: t.priority,
      priority_score: t.priority_score, role: t.role, tags: t.tags, created_at: t.created_at
    }))
  };
}

function addComment(taskIdOrRef, author, text, meta = {}) {
  const { id: taskId } = resolveTaskId(taskIdOrRef);
  if (!taskId) return null;
  const task = getTask(taskId);
  if (!task) return null;
  if (!task.comments) task.comments = [];
  const now = new Date().toISOString();
  const stars = clampStars(meta.stars);
  const entry = {
    id: randomUUID(),
    author: author || 'Unknown',
    text: String(text || '').trim(),
    stars,
    created_at: now,
    updated_at: null,
    composed_from: meta.composed_from || now,
    composed_to: meta.composed_to || now,
  };
  if (meta.restored_from) entry.restored_from = meta.restored_from;
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
  task.updated_at = now;
  writeFileSync(taskFilePath(taskId), JSON.stringify(task, null, 2));
  if (stars > 0) {
    addMotivationEvent({
      project: task.project,
      type: 'comment_effort',
      user: entry.author,
      actor: entry.author,
      amount: stars,
      task_id: task.id,
      comment_id: entry.id,
      note: entry.text.slice(0, 80) || null,
    });
  }
  log(`COMMENT ${taskId} — ${author} stars=${stars}`);
  return task;
}

function updateComment(taskIdOrRef, commentId, updates) {
  const { id: taskId } = resolveTaskId(taskIdOrRef);
  if (!taskId) return null;
  const task = getTask(taskId);
  if (!task?.comments) return null;
  const comment = findCommentInTask(task, commentId);
  if (!comment) return null;

  const now = new Date().toISOString();
  const isRestore = !!updates.restored_from;
  const nextText = updates.text !== undefined ? String(updates.text || '').trim() : comment.text;
  const undelete = updates.deleted === false;
  const textChanges = updates.text !== undefined && nextText !== comment.text;
  const oldStars = clampStars(comment.stars);
  const starsChanging = updates.stars !== undefined;
  const nextStars = starsChanging ? clampStars(updates.stars) : oldStars;

  if (isRestore || textChanges || (undelete && comment.deleted) || (starsChanging && nextStars !== oldStars)) {
    if (!Array.isArray(comment.history)) comment.history = [];
    comment.history.push({
      text: comment.text,
      at: comment.updated_at || comment.created_at || now,
      restored_from: comment.restored_from || undefined,
      was_deleted: !!comment.deleted || undefined,
      stars: oldStars || undefined,
    });
    if (updates.text !== undefined) comment.text = nextText;
  }

  if (updates.author !== undefined) comment.author = updates.author;

  if (isRestore) {
    comment.restored_from = updates.restored_from;
  } else if (textChanges) {
    comment.restored_from = null;
  }

  if (undelete) {
    comment.deleted = false;
    comment.deleted_at = null;
  }

  if (starsChanging) comment.stars = nextStars;

  if (updates.composed_from !== undefined) comment.composed_from = updates.composed_from;
  if (updates.composed_to !== undefined) comment.composed_to = updates.composed_to;

  comment.updated_at = now;
  task.updated_at = now;
  writeFileSync(taskFilePath(taskId), JSON.stringify(task, null, 2));

  if (starsChanging && nextStars !== oldStars) {
    const delta = nextStars - oldStars;
    if (delta !== 0) {
      addMotivationEvent({
        project: task.project,
        type: delta > 0 ? 'comment_effort' : 'adjust',
        user: comment.author,
        actor: updates.actor || comment.author,
        amount: delta,
        task_id: task.id,
        comment_id: comment.id,
        note: `Звёзды комментария: ${oldStars} → ${nextStars}`,
      });
    }
  }

  log(`COMMENT_EDIT ${taskId}/${commentId}`);
  return task;
}

function findCommentInTask(task, commentIdOrRef) {
  if (!task?.comments) return null;
  const raw = normalizeIdRef(commentIdOrRef);
  if (!raw) return null;
  const exact = task.comments.find(c => c.id === commentIdOrRef || c.id === raw);
  if (exact) return exact;
  const needle = raw.toLowerCase();
  const compact = needle.replace(/-/g, '');
  const matches = task.comments.filter(c => {
    const low = String(c.id).toLowerCase();
    return low.startsWith(needle) || low.replace(/-/g, '').startsWith(compact);
  });
  return matches.length === 1 ? matches[0] : null;
}

function deleteComment(taskIdOrRef, commentIdOrRef) {
  const { id: taskId } = resolveTaskId(taskIdOrRef);
  if (!taskId) return null;
  const task = getTask(taskId);
  const comment = findCommentInTask(task, commentIdOrRef);
  if (!comment) return null;
  const commentId = comment.id;
  const now = new Date().toISOString();
  if (comment.deleted) {
    task.comments = task.comments.filter(c => c.id !== commentId);
    task.updated_at = now;
    writeFileSync(taskFilePath(taskId), JSON.stringify(task, null, 2));
    log(`COMMENT_PURGE ${taskId}/${commentId}`);
    return task;
  }
  comment.deleted = true;
  comment.deleted_at = now;
  task.updated_at = now;
  writeFileSync(taskFilePath(taskId), JSON.stringify(task, null, 2));
  log(`COMMENT_TRASH ${taskId}/${commentId}`);
  return task;
}

function listProjects() {
  const index = loadIndex();
  return Object.keys(index.projects || {}).sort();
}

// ── Motivation ledger ───────────────────────────────────────────────
function ensureMotivationStore() {
  if (!existsSync(MOTIVATION_DIR)) mkdirSync(MOTIVATION_DIR, { recursive: true });
  if (!existsSync(MOTIVATION_FILE)) {
    writeFileSync(MOTIVATION_FILE, JSON.stringify({ events: [] }, null, 2));
  }
}

function loadMotivationEvents() {
  ensureMotivationStore();
  try {
    const data = JSON.parse(readFileSync(MOTIVATION_FILE, 'utf8'));
    return Array.isArray(data.events) ? data.events : [];
  } catch {
    return [];
  }
}

function saveMotivationEvents(events) {
  ensureMotivationStore();
  writeFileSync(MOTIVATION_FILE, JSON.stringify({ events }, null, 2));
}

function clampStars(n) {
  const v = Math.round(Number(n) || 0);
  return Math.max(0, Math.min(99, v));
}

function addMotivationEvent(fields) {
  const events = loadMotivationEvents();
  const now = new Date().toISOString();
  const type = String(fields.type || 'adjust');
  let amount = Math.round(Number(fields.amount) || 0);
  if (type === 'task_estimate') amount = 0;
  if (type === 'payout' && amount > 0) amount = -amount;
  const event = {
    id: randomUUID(),
    project: fields.project || 'default',
    type,
    user: fields.user || fields.actor || 'Unknown',
    actor: fields.actor || fields.user || 'Unknown',
    amount,
    task_id: fields.task_id || null,
    comment_id: fields.comment_id || null,
    note: fields.note ? String(fields.note).trim() : null,
    points: fields.points != null ? clampStars(fields.points) || Number(fields.points) : null,
    created_at: now,
  };
  events.push(event);
  saveMotivationEvents(events);
  log(`MOTIVATION ${event.type} ${event.user} ${event.amount}`);
  return event;
}

function listMotivationEvents(project, filter = {}) {
  let events = loadMotivationEvents().filter(e => e.project === project);
  if (filter.user) events = events.filter(e => e.user === filter.user);
  events.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return events;
}

function motivationBalances(project) {
  const balances = {};
  for (const e of loadMotivationEvents()) {
    if (e.project !== project) continue;
    if (!balances[e.user]) balances[e.user] = 0;
    balances[e.user] += Number(e.amount) || 0;
  }
  return balances;
}

/**
 * Idempotent credit for already-closed tasks:
 * each unique comment author on a cancelled (non-deleted) task gets
 * share of points_awarded||points (min 1) as adjust with [backfill] note.
 */
function backfillClosedTaskCredits(project, actor = 'system') {
  const events = loadMotivationEvents();
  const existing = new Set(
    events
      .filter(e => e.project === project && e.type === 'adjust' && String(e.note || '').startsWith('[backfill]'))
      .map(e => `${e.task_id}::${e.user}`)
  );
  const tasks = listTasks({ project, limit: 500 });
  const created = [];
  for (const task of tasks) {
    if (task.deleted || task.status !== 'cancelled') continue;
    const authors = [...new Set(
      (task.comments || [])
        .filter(c => c && !c.deleted && c.author)
        .map(c => c.author)
    )];
    if (!authors.length && task.assignee) authors.push(task.assignee);
    if (!authors.length) continue;
    const credit = Math.max(
      1,
      Math.round(Number(task.points_awarded != null ? task.points_awarded : task.points) || 1)
    );
    const share = Math.max(1, Math.round(credit / authors.length));
    for (const user of authors) {
      const key = `${task.id}::${user}`;
      if (existing.has(key)) continue;
      const event = addMotivationEvent({
        project,
        type: 'adjust',
        user,
        actor: actor || 'system',
        amount: share,
        task_id: task.id,
        note: `[backfill] Закрытая задача: ${String(task.title || '').slice(0, 60)}`,
      });
      existing.add(key);
      created.push(event);
    }
  }
  return { created: created.length, events: created, balances: motivationBalances(project) };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function handleRestApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] === 'api' && parts[1] === 'projects' && parts.length === 2 && req.method === 'GET') {
    sendJson(res, 200, listProjects());
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'projects' && parts[2] && parts[3] === 'tasks' && req.method === 'GET' && parts.length === 4) {
    sendJson(res, 200, listTasks({ project: parts[2], limit: 200 }));
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'projects' && parts[2] && parts[3] === 'motivation' && parts[4] === 'balances' && req.method === 'GET' && parts.length === 5) {
    sendJson(res, 200, motivationBalances(parts[2]));
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'projects' && parts[2] && parts[3] === 'motivation' && parts[4] === 'backfill' && req.method === 'POST' && parts.length === 5) {
    readJsonBody(req).then(body => {
      const result = backfillClosedTaskCredits(parts[2], body.actor || 'system');
      sendJson(res, 200, result);
    }).catch(() => sendJson(res, 400, { error: 'invalid json' }));
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'projects' && parts[2] && parts[3] === 'motivation' && req.method === 'GET' && parts.length === 4) {
    const user = url.searchParams.get('user') || undefined;
    sendJson(res, 200, listMotivationEvents(parts[2], { user }));
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'projects' && parts[2] && parts[3] === 'motivation' && req.method === 'POST' && parts.length === 4) {
    readJsonBody(req).then(body => {
      if (!body.type) { sendJson(res, 400, { error: 'type required' }); return; }
      const event = addMotivationEvent({ ...body, project: parts[2] });
      sendJson(res, 201, event);
    }).catch(() => sendJson(res, 400, { error: 'invalid json' }));
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'lookup' && req.method === 'GET' && parts.length === 2) {
    const ref = url.searchParams.get('ref') || url.searchParams.get('q') || url.searchParams.get('id') || '';
    const project = url.searchParams.get('project') || undefined;
    const result = lookupByRef(ref, { project });
    sendJson(res, result.error === 'not found' ? 404 : result.error === 'ambiguous' ? 409 : 200, result);
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'tasks' && parts[2] && req.method === 'GET' && parts.length === 3) {
    const resolved = resolveTask(parts[2]);
    if (!resolved.task) {
      sendJson(res, resolved.matches.length ? 409 : 404, {
        error: resolved.matches.length ? 'ambiguous id' : 'not found',
        matches: resolved.matches,
      });
      return true;
    }
    sendJson(res, 200, resolved.task);
    return true;
  }

  // Webhook diagnostics (no secrets leaked)
  if (parts[0] === 'api' && parts[1] === 'webhooks' && parts[2] === 'status' && req.method === 'GET' && parts.length === 3) {
    const cfg = webhookConfig();
    sendJson(res, 200, {
      enabled: cfg.enabled,
      configured: !!cfg.url,
      url_host: cfg.url ? (() => { try { return new URL(cfg.url).host; } catch { return '(invalid url)'; } })() : null,
      assignee_trigger: cfg.assignee,
      auth_configured: !!cfg.auth,
      timeout_ms: cfg.timeoutMs,
    });
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'webhooks' && parts[2] === 'test' && req.method === 'POST' && parts.length === 3) {
    readJsonBody(req).then(async (body) => {
      const cfg = webhookConfig();
      const sample = {
        id: body.task_id || '00000000-0000-4000-8000-000000000001',
        project: body.project || 'yt-game',
        title: body.title || 'Webhook dry-run',
        description: body.description || 'Test payload from POST /api/webhooks/test',
        status: 'open',
        priority: 'medium',
        assignee: cfg.assignee,
        role: 'Developer',
        points: 1,
        tags: ['webhook-test'],
        comments: [{ id: 'c-test', author: 'Developer', text: 'ping', created_at: new Date().toISOString() }],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const payload = buildAssigneeWebhookPayload({
        event: 'assignee_to_agent',
        task: sample,
        fromAssignee: 'QA_Engineer',
        toAssignee: cfg.assignee,
        actor: body.actor || 'webhook-test',
      });
      if (body.dry_run || !cfg.enabled) {
        sendJson(res, 200, { dry_run: true, enabled: cfg.enabled, payload });
        return;
      }
      const result = await postWebhook(payload, log);
      sendJson(res, result.ok ? 200 : 502, { dry_run: false, result, payload });
    }).catch(() => sendJson(res, 400, { error: 'invalid json' }));
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'tasks' && req.method === 'POST' && parts.length === 2) {
    readJsonBody(req).then(body => {
      if (!body.title) { sendJson(res, 400, { error: 'title required' }); return; }
      sendJson(res, 201, createTask(body));
    }).catch(() => sendJson(res, 400, { error: 'invalid json' }));
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'tasks' && parts[2] && req.method === 'PATCH' && parts.length === 3) {
    readJsonBody(req).then(body => {
      const updated = updateTask(parts[2], body);
      if (!updated) { sendJson(res, 404, { error: 'not found' }); return; }
      sendJson(res, 200, updated);
    }).catch(() => sendJson(res, 400, { error: 'invalid json' }));
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'tasks' && parts[2] && req.method === 'DELETE' && parts.length === 3) {
    const result = deleteTask(parts[2]);
    if (!result) { sendJson(res, 404, { error: 'not found' }); return; }
    sendJson(res, 200, result);
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'tasks' && parts[2] && parts[3] === 'comments' && req.method === 'POST' && parts.length === 4) {
    readJsonBody(req).then(body => {
      if (!body.text) { sendJson(res, 400, { error: 'text required' }); return; }
      const task = addComment(parts[2], body.author, body.text, {
        restored_from: body.restored_from || null,
        stars: body.stars,
        composed_from: body.composed_from,
        composed_to: body.composed_to,
        commit_sha: body.commit_sha,
        short_sha: body.short_sha,
        version: body.version,
        bump: body.bump,
        commit_message: body.commit_message,
      });
      if (!task) { sendJson(res, 404, { error: 'not found' }); return; }
      sendJson(res, 200, task);
    }).catch(() => sendJson(res, 400, { error: 'invalid json' }));
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'tasks' && parts[2] && parts[3] === 'comments' && parts[4] && req.method === 'PATCH' && parts.length === 5) {
    readJsonBody(req).then(body => {
      const task = updateComment(parts[2], parts[4], body);
      if (!task) { sendJson(res, 404, { error: 'not found' }); return; }
      sendJson(res, 200, task);
    }).catch(() => sendJson(res, 400, { error: 'invalid json' }));
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'tasks' && parts[2] && parts[3] === 'comments' && parts[4] && req.method === 'DELETE' && parts.length === 5) {
    const task = deleteComment(parts[2], parts[4]);
    if (!task) { sendJson(res, 404, { error: 'not found' }); return; }
    sendJson(res, 200, task);
    return true;
  }

  return false;
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

const sessions = new Map();
const sseStreams = new Map();

let eventIdCounter = 0;
function generateEventId() {
  return `evt-${++eventIdCounter}-${Date.now()}`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (handleRestApi(req, res, url)) return;

  if (url.pathname !== '/mcp') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const sessionId = req.headers['mcp-session-id'];

  // GET /mcp — SSE
  if (req.method === 'GET') {
    const accept = req.headers['accept'] || '';
    if (!accept.includes('text/event-stream')) {
      res.writeHead(406);
      res.end('Not Acceptable');
      return;
    }
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400);
      res.end('Session required');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    if (!sseStreams.has(sessionId)) sseStreams.set(sessionId, new Set());
    sseStreams.get(sessionId).add(res);
    res.write(':ok\n\n');
    req.on('close', () => {
      const s = sseStreams.get(sessionId);
      if (s) { s.delete(res); if (!s.size) sseStreams.delete(sessionId); }
    });
    return;
  }

  // DELETE /mcp
  if (req.method === 'DELETE') {
    if (sessionId && sessions.has(sessionId)) {
      sessions.delete(sessionId);
      const s = sseStreams.get(sessionId);
      if (s) { s.forEach(r => r.end()); sseStreams.delete(sessionId); }
      res.writeHead(202);
      res.end();
    } else {
      res.writeHead(404);
      res.end('Session not found');
    }
    return;
  }

  // POST /mcp
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch {
        res.writeHead(400);
        res.end('Invalid JSON-RPC');
        return;
      }

      // Initialize
      if (msg.method === 'initialize') {
        const newId = randomUUID();
        sessions.set(newId, { createdAt: new Date() });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': newId
        });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: {
            protocolVersion: SUPPORTED_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'task-tracker', version: '1.0.0' }
          }
        }));
        log(`INIT session=${newId}`);
        return;
      }

      // Notification — не требует сессии
      if (msg.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }

      // Остальные запросы — требуют сессию
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(400);
        res.end('Session required');
        return;
      }

      let response;
      switch (msg.method) {
        case 'ping':
          response = { jsonrpc: '2.0', id: msg.id, result: {} };
          break;
        case 'tools/list':
          response = {
            jsonrpc: '2.0', id: msg.id,
            result: {
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
                  description: 'Получить задачу по ID (полный UUID, короткий префикс или #8c9cb87e)',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      id: {
                        type: 'string',
                        description: 'ID задачи: UUID, короткий хештег (#8c9cb87e) или уникальный префикс',
                      },
                    },
                    required: ['id'],
                  },
                },
                {
                  name: 'lookup',
                  description: 'Найти задачу или комментарий по #short / UUID / уникальному префиксу',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      ref: {
                        type: 'string',
                        description: 'Ссылка: #8c9cb87e, UUID задачи или комментария',
                      },
                      project: { type: 'string', description: 'Опционально сузить поиск комментария по проекту' },
                    },
                    required: ['ref'],
                  },
                },
                {
                  name: 'update_task',
                  description: 'Обновить задачу',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      id: {
                        type: 'string',
                        description: 'ID задачи (UUID / #short / префикс)',
                      },
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
                  description: 'Полнотекстовый поиск по задачам (включая короткий id)',
                  inputSchema: {
                    type: 'object',
                    properties: { query: { type: 'string', description: 'Поисковый запрос' } },
                    required: ['query']
                  }
                },
                {
                  name: 'get_project_context',
                  description: 'Контекст проекта для LLM',
                  inputSchema: {
                    type: 'object',
                    properties: { project: { type: 'string', description: 'Название проекта' } },
                    required: ['project']
                  }
                },
                {
                  name: 'rank_tasks',
                  description: 'Переранжировать задачи проекта по priority_score',
                  inputSchema: {
                    type: 'object',
                    properties: { project: { type: 'string', description: 'Название проекта' } },
                    required: ['project']
                  }
                },
                {
                  name: 'add_comment',
                  description: 'Добавить комментарий (author: AI_Agent, Developer, QA_Engineer)',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', description: 'ID задачи' },
                      author: { type: 'string', description: 'Автор' },
                      text: { type: 'string', description: 'Текст' },
                      commit_sha: { type: 'string', description: 'SHA коммита' },
                      short_sha: { type: 'string', description: 'Короткий SHA' },
                      version: { type: 'string', description: 'Semver v.X.Y.Z' },
                      bump: { type: 'string', enum: ['patch', 'minor', 'major'] },
                      commit_message: { type: 'string', description: 'Сообщение коммита' },
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
                      text: { type: 'string' },
                      author: { type: 'string' }
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
                  description: 'Список проектов',
                  inputSchema: { type: 'object', properties: {} }
                }
              ]
            }
          };
          break;
        case 'tools/call': {
          const toolName = msg.params?.name;
          const args = msg.params?.arguments || {};
          let result;
          try {
            switch (toolName) {
              case 'create_task':
                if (!args.title) throw new Error('title is required');
                result = createTask(args);
                break;
              case 'get_task': {
                if (!args.id) throw new Error('id is required');
                const resolved = resolveTask(args.id);
                if (!resolved.task) {
                  if (resolved.matches.length) throw new Error(`Ambiguous id ${args.id}: ${resolved.matches.join(', ')}`);
                  throw new Error(`Task ${args.id} not found`);
                }
                result = taskForAgentContext(resolved.task);
                break;
              }
              case 'lookup': {
                if (!args.ref && !args.id) throw new Error('ref is required');
                result = lookupByRef(args.ref || args.id, { project: args.project });
                if (result.error === 'not found') throw new Error(`Not found: ${args.ref || args.id}`);
                if (result.error === 'ambiguous') throw new Error(`Ambiguous ref: ${(result.candidates || []).map(c => c.id).join(', ')}`);
                if (result.task) result = { ...result, task: taskForAgentContext(result.task) };
                break;
              }
              case 'update_task': {
                if (!args.id) throw new Error('id is required');
                const updated = updateTask(args.id, args.updates || {});
                if (!updated) throw new Error(`Task ${args.id} not found`);
                result = updated;
                break;
              }
              case 'list_tasks':
                result = listTasks(args);
                break;
              case 'search_tasks':
                if (!args.query) throw new Error('query is required');
                result = searchTasks(args.query);
                break;
              case 'get_project_context':
                if (!args.project) throw new Error('project is required');
                result = getProjectContext(args.project);
                break;
              case 'rank_tasks':
                if (!args.project) throw new Error('project is required');
                result = rankTasks(args.project);
                break;
              case 'add_comment': {
                if (!args.id) throw new Error('id is required');
                if (!args.text) throw new Error('text is required');
                const commented = addComment(args.id, args.author, args.text, {
                  composed_from: args.composed_from,
                  composed_to: args.composed_to,
                  commit_sha: args.commit_sha,
                  short_sha: args.short_sha,
                  version: args.version,
                  bump: args.bump,
                  commit_message: args.commit_message,
                });
                if (!commented) throw new Error(`Task ${args.id} not found`);
                result = commented;
                break;
              }
              case 'update_comment': {
                if (!args.id || !args.comment_id) throw new Error('id and comment_id are required');
                const updated = updateComment(args.id, args.comment_id, args);
                if (!updated) throw new Error('Task or comment not found');
                result = updated;
                break;
              }
              case 'delete_comment': {
                if (!args.id || !args.comment_id) throw new Error('id and comment_id are required');
                const updated = deleteComment(args.id, args.comment_id);
                if (!updated) throw new Error('Task or comment not found');
                result = updated;
                break;
              }
              case 'delete_task': {
                if (!args.id) throw new Error('id is required');
                const deleted = deleteTask(args.id);
                if (!deleted) throw new Error(`Task ${args.id} not found`);
                result = deleted;
                break;
              }
              case 'list_projects':
                result = listProjects();
                break;
              default:
                response = {
                  jsonrpc: '2.0', id: msg.id,
                  error: { code: -32601, message: `Unknown tool: ${toolName}` }
                };
                break;
            }
          } catch (err) {
            response = {
              jsonrpc: '2.0', id: msg.id,
              error: { code: -32603, message: err.message }
            };
          }
          if (!response) {
            response = {
              jsonrpc: '2.0', id: msg.id,
              result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
            };
          }
          break;
        }
        default:
          response = {
            jsonrpc: '2.0', id: msg.id,
            error: { code: -32601, message: `Unknown: ${msg.method}` }
          };
      }

      log(`${msg.method} id=${msg.id}`);
      const json = JSON.stringify(response);
      const accept = req.headers['accept'] || '';
      if (accept.includes('text/event-stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`id: ${generateEventId()}\ndata: ${json}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(json);
      }
    });
    return;
  }

  res.writeHead(405);
  res.end('Method Not Allowed');
});

if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });

server.listen(PORT, '0.0.0.0', () => {
  log(`HTTP MCP server listening on port ${PORT}`);
});
