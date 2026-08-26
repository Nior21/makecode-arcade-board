/**
 * Outbound webhooks for Cursor Automations (and local relays).
 *
 * Env:
 *   TT_WEBHOOK_URL          — POST target (Cursor webhook URL or LAN relay)
 *   TT_WEBHOOK_AUTH         — full Authorization header value, e.g. "Bearer crsr_..."
 *   TT_WEBHOOK_ASSIGNEE     — trigger when assignee becomes this (default: AI_Agent)
 *   TT_WEBHOOK_TIMEOUT_MS   — request timeout (default 8000)
 *   TT_WEBHOOK_ENABLED      — "0" to disable even if URL is set
 *
 * Config is also loaded from a `.env` file in the task-tracker root at module
 * load, so TT picks up the webhook config even when started without env vars.
 * Shell env vars take precedence over `.env` values.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function loadDotEnv() {
  const p = resolve(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadDotEnv();

/** Create task-tracker/.env from .env.example on first run (fresh clone). */
function ensureTTEnvFile() {
  const envPath = resolve(ROOT, '.env');
  if (existsSync(envPath)) return { created: false };
  const examplePath = resolve(ROOT, '.env.example');
  const content = existsSync(examplePath)
    ? readFileSync(examplePath, 'utf8')
    : `TT_WEBHOOK_URL=${DEFAULT_WEBHOOK_URL}\nTT_WEBHOOK_ASSIGNEE=AI_Agent\n`;
  writeFileSync(envPath, content);
  loadDotEnv();
  return { created: true };
}

const DEFAULT_WEBHOOK_URL = 'http://127.0.0.1:9080/hook';

function webhookConfig() {
  const url = String(process.env.TT_WEBHOOK_URL || DEFAULT_WEBHOOK_URL).trim();
  const enabled = process.env.TT_WEBHOOK_ENABLED !== '0' && !!url;
  return {
    enabled,
    url,
    auth: String(process.env.TT_WEBHOOK_AUTH || '').trim(),
    assignee: String(process.env.TT_WEBHOOK_ASSIGNEE || 'AI_Agent').trim() || 'AI_Agent',
    timeoutMs: Math.max(1000, parseInt(process.env.TT_WEBHOOK_TIMEOUT_MS || '8000', 10) || 8000),
  };
}

function taskShortId(task) {
  const id = String(task?.id || '');
  return id.includes('-') ? id.split('-')[0] : id.slice(0, 8);
}

/** Compact payload for Cursor Automations — agent reads this as trigger context. */
function buildAssigneeWebhookPayload({ event, task, fromAssignee, toAssignee, actor }) {
  const comments = (Array.isArray(task.comments) ? task.comments : []).filter(c => !c.deleted);
  const recent = comments.slice(-8).map(c => ({
    id: c.id,
    author: c.author,
    text: c.text,
    created_at: c.created_at,
  }));
  return {
    source: 'task-tracker',
    event, // assignee_to_agent | task_created_for_agent
    fired_at: new Date().toISOString(),
    actor: actor || null,
    from_assignee: fromAssignee ?? null,
    to_assignee: toAssignee,
    task: {
      id: task.id,
      short_id: taskShortId(task),
      project: task.project,
      title: task.title,
      description: task.description || '',
      status: task.status,
      priority: task.priority,
      assignee: task.assignee,
      role: task.role,
      points: task.points,
      tags: task.tags || [],
      location: task.location || '',
      feature_ids: task.feature_ids || [],
      updated_at: task.updated_at,
      created_at: task.created_at,
    },
    recent_comments: recent,
    instructions_hint:
      'You are AI_Agent. Load full task via TT MCP (get_task / lookup by short_id). ' +
      'Read description + all comments. Implement in the project workspace. ' +
      'Reply with add_comment as author AI_Agent. When done for QA, assign QA_Engineer and leave a verification note.',
  };
}

/**
 * Fire-and-forget POST. Never throws to callers.
 * @returns {Promise<{ok:boolean, status?:number, error?:string, skipped?:boolean}>}
 */
async function postWebhook(payload, log = console.error) {
  const cfg = webhookConfig();
  if (!cfg.enabled) {
    return { ok: false, skipped: true, error: 'webhook disabled or TT_WEBHOOK_URL empty' };
  }

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (cfg.auth) headers.Authorization = cfg.auth;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      log(`WEBHOOK HTTP ${res.status} — ${(text || '').slice(0, 200)}`);
      return { ok: false, status: res.status, error: text.slice(0, 500) };
    }
    log(`WEBHOOK ok ${res.status} event=${payload.event} task=${payload.task?.short_id || payload.task?.id}`);
    return { ok: true, status: res.status };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'timeout' : String(err?.message || err);
    log(`WEBHOOK fail — ${msg}`);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call after create/update when assignee may have become the agent role.
 * Non-blocking.
 */
function maybeNotifyAssigneeToAgent({ task, prevAssignee, actor, isCreate }, log) {
  const cfg = webhookConfig();
  if (!cfg.enabled) return;

  const to = String(task?.assignee || '');
  const from = prevAssignee == null ? null : String(prevAssignee);
  if (to !== cfg.assignee) return;
  // Only on transition onto the agent (or create already assigned).
  if (!isCreate && from === to) return;

  const event = isCreate ? 'task_created_for_agent' : 'assignee_to_agent';
  const payload = buildAssigneeWebhookPayload({
    event,
    task,
    fromAssignee: from,
    toAssignee: to,
    actor,
  });

  // Don't block PATCH/create on webhook latency.
  Promise.resolve()
    .then(() => postWebhook(payload, log))
    .catch(err => log?.(`WEBHOOK unexpected — ${err}`));
}

export {
  webhookConfig,
  buildAssigneeWebhookPayload,
  postWebhook,
  maybeNotifyAssigneeToAgent,
  ensureTTEnvFile,
  DEFAULT_WEBHOOK_URL,
};
