import { readFileSync } from 'fs';
import { resolve } from 'path';
import { config, cwdForProject } from './config.js';
import { addComment, deleteComment, getTask, updateComment } from './tt.js';
import { memoryOk, systemPressure } from './memguard.js';

const PROMPT_PATH = resolve(config.root, 'prompts/ai-agent.md');

function isAgentStartComment(c) {
  return c?.author === 'AI_Agent' && /tt-agent-worker:\s*старт/i.test(c?.text || '');
}

function visibleComments(task) {
  return (task?.comments || []).filter(c => !c.deleted);
}

function isHandoffComment(c) {
  const text = c?.text || '';
  return /^↪ Передано:/.test(text) || /^Агент, передаю/i.test(text);
}

function isWorkerErrorComment(c) {
  return /^⛔ tt-agent-worker ошибка:/.test(c?.text || '');
}

function isAgentDeliveryComment(c) {
  if (!c || c.deleted || c.author !== 'AI_Agent') return false;
  if (isAgentStartComment(c) || isHandoffComment(c) || isWorkerErrorComment(c)) return false;
  return true;
}

/** Reuse an existing start ping if the run was interrupted (worker restart). */
function findReusableStartComment(task) {
  const comments = visibleComments(task);
  if (comments.some(c => c.author === 'AI_Agent' && !isAgentStartComment(c) && !isHandoffComment(c))) {
    return null;
  }
  const starts = comments.filter(isAgentStartComment);
  return starts.length ? starts[starts.length - 1] : null;
}

function buildPrompt(payload, liveTask) {
  const base = readFileSync(PROMPT_PATH, 'utf8');
  const task = liveTask || payload.task || {};
  const blob = {
    event: payload.event,
    fired_at: payload.fired_at,
    from_assignee: payload.from_assignee,
    to_assignee: payload.to_assignee,
    task: {
      id: task.id || payload.task?.id,
      short_id: task.id ? String(task.id).split('-')[0] : payload.task?.short_id,
      project: task.project || payload.task?.project,
      title: task.title || payload.task?.title,
      description: task.description || payload.task?.description,
      status: task.status,
      assignee: task.assignee,
      points: task.points,
      tags: task.tags,
      comments: visibleComments(task).length
        ? visibleComments(task)
        : (payload.recent_comments || []).filter(c => !c.deleted),
    },
  };
  return `${base}\n\`\`\`json\n${JSON.stringify(blob, null, 2)}\n\`\`\`\n`;
}

function findNewComment(before, after) {
  const prevIds = new Set((before?.comments || []).map(c => c.id));
  return (after?.comments || []).find(c => !prevIds.has(c.id)) || null;
}

/** Soft-delete start ping; stamp composed_from/to on the agent's result comment. */
async function finalizeAgentRun(taskId, { startCommentId, startedAt }, { log = console.error } = {}) {
  if (!startCommentId || !startedAt) return;
  const finishedAt = new Date().toISOString();
  let resultComment = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const task = await getTask(taskId);
      resultComment = visibleComments(task)
        .filter(c => c.id !== startCommentId && isAgentDeliveryComment(c))
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0];
      if (resultComment) break;
    } catch (err) {
      log(`[runner] finalize get_task failed: ${err.message}`);
      return;
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 400));
  }
  if (!resultComment) return;
  try {
    await deleteComment(taskId, startCommentId);
  } catch (err) {
    log(`[runner] finalize delete start failed: ${err.message}`);
  }
  try {
    await updateComment(taskId, resultComment.id, {
      composed_from: startedAt,
      composed_to: finishedAt,
    });
  } catch (err) {
    log(`[runner] finalize update result failed: ${err.message}`);
  }
}

/**
 * One job. Agent.prompt auto-disposes. SDK imported lazily (idle RAM stays low).
 */
export async function runAgentJob(job, { log = console.error } = {}) {
  const taskId = job.taskId;
  const shortId = job.shortId || String(taskId).slice(0, 8);
  const project = job.project || job.payload?.task?.project || 'yt-game';
  const cwd = cwdForProject(project);

  let liveTask = null;
  try {
    liveTask = await getTask(taskId);
  } catch (err) {
    log(`[runner] get_task failed: ${err.message}`);
  }

  if (liveTask && liveTask.assignee !== config.assignee) {
    const msg = `Пропуск: assignee сейчас «${liveTask.assignee}», не ${config.assignee}.`;
    log(`[runner] ${msg}`);
    try { await addComment(taskId, 'AI_Agent', msg); } catch (_) {}
    return { skipped: true, reason: 'assignee_changed' };
  }

  const pressure = systemPressure();
  const mem = memoryOk(config.minMemAvailableKb);
  const startedAt = new Date().toISOString();
  const startNote =
    `🤖 tt-agent-worker: старт (#${shortId})\n` +
    `cwd=\`${cwd}\` model=\`${config.model}\`\n` +
    `RAM avail≈${mem.memAvailableMiB}MiB load1=${pressure.load1}` +
    (config.dryRun || !config.apiKey ? `\n⚠️ dry-run/no API key — агент не запускался` : '');

  let startCommentId = null;
  const runMeta = { startCommentId: null, startedAt };
  const reusable = findReusableStartComment(liveTask);
  if (reusable?.id) {
    startCommentId = reusable.id;
    runMeta.startCommentId = startCommentId;
    runMeta.startedAt = reusable.composed_from || reusable.created_at || startedAt;
    log(`[runner] reuse start comment ${String(startCommentId).slice(0, 8)}`);
    try {
      await updateComment(taskId, startCommentId, {
        text: startNote,
        composed_from: runMeta.startedAt,
        composed_to: new Date().toISOString(),
      });
    } catch (err) {
      log(`[runner] refresh start comment failed: ${err.message}`);
    }
  } else {
    try {
      const beforeStart = liveTask || await getTask(taskId).catch(() => null);
      const afterStart = await addComment(taskId, 'AI_Agent', startNote, {
        composed_from: startedAt,
        composed_to: startedAt,
      });
      const startComment = findNewComment(beforeStart, afterStart);
      startCommentId = startComment?.id || null;
      runMeta.startCommentId = startCommentId;
    } catch (err) {
      log(`[runner] start comment failed: ${err.message}`);
    }
  }

  /** finalize must never fail the job — old workers could throw ReferenceError after a successful Agent.prompt. */
  const safeFinalize = async () => {
    try {
      await finalizeAgentRun(taskId, runMeta, { log });
    } catch (err) {
      log(`[runner] finalize failed (non-fatal): ${err?.message || err}`);
    }
  };

  if (config.dryRun) {
    log('[runner] DRY_RUN — skip Agent.prompt');
    await addComment(taskId, 'AI_Agent', 'DRY_RUN: webhook принят, Cursor SDK не вызывался.').catch(() => {});
    await safeFinalize();
    return { dryRun: true };
  }

  if (!config.apiKey) {
    const msg =
      'Нет CURSOR_API_KEY на RPI. Положите ключ в /home/pi/tt-agent-worker/.env и перезапустите tt-agent-worker.';
    log(`[runner] ${msg}`);
    await addComment(taskId, 'AI_Agent', `⛔ ${msg}`).catch(() => {});
    await safeFinalize();
    return { error: 'no_api_key' };
  }

  if (!mem.ok) {
    const msg = `Мало RAM (${mem.memAvailableMiB}MiB) — отложите задачу или освободите память.`;
    await addComment(taskId, 'AI_Agent', `⛔ ${msg}`).catch(() => {});
    await safeFinalize();
    throw new Error(msg);
  }

  const prompt = buildPrompt(job.payload || {}, liveTask);
  log(`[runner] Agent.prompt cwd=${cwd} model=${config.model}`);

  const { Agent, CursorAgentError } = await import('@cursor/sdk');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.runTimeoutMs);

  try {
    const result = await Promise.race([
      Agent.prompt(prompt, {
        apiKey: config.apiKey,
        model: { id: config.model },
        name: `TT ${shortId}`,
        local: {
          cwd,
          settingSources: [],
        },
        mcpServers: {
          'task-tracker': {
            type: 'http',
            url: config.ttMcpUrl,
          },
        },
      }),
      new Promise((_, reject) => {
        ac.signal.addEventListener('abort', () => {
          reject(new Error(`run timeout after ${config.runTimeoutMs}ms`));
        });
      }),
    ]);

    const status = result?.status || 'unknown';
    log(`[runner] finished status=${status}`);
    // Agent posts its own TT comment via MCP; skip auto-summary to avoid duplicates.
    return { status, result };
  } catch (err) {
    const msg = err instanceof CursorAgentError
      ? `startup: ${err.message} retryable=${err.isRetryable}`
      : String(err?.message || err);
    log(`[runner] fail: ${msg}`);
    await addComment(taskId, 'AI_Agent', `⛔ tt-agent-worker ошибка: ${msg}`).catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
    // finalize in finally — never treat post-run cleanup as Agent.prompt failure
    await safeFinalize();
  }
}
