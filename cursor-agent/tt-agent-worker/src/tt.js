import { config } from './config.js';

async function ttFetch(path, opts = {}) {
  const url = config.ttBase + path;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`TT ${res.status} ${path}: ${(text || '').slice(0, 200)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function getTask(idOrShort) {
  return ttFetch(`/api/tasks/${encodeURIComponent(idOrShort)}`);
}

export async function addComment(taskId, author, text, meta = {}) {
  const body = { author, text };
  if (meta.composed_from) body.composed_from = meta.composed_from;
  if (meta.composed_to) body.composed_to = meta.composed_to;
  return ttFetch(`/api/tasks/${encodeURIComponent(taskId)}/comments`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateComment(taskId, commentId, updates = {}) {
  return ttFetch(`/api/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentId)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export async function deleteComment(taskId, commentId) {
  return ttFetch(`/api/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentId)}`, {
    method: 'DELETE',
  });
}

export async function patchTask(taskId, updates) {
  return ttFetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}
