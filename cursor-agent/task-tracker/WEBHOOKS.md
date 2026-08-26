# Outbound webhooks (Cursor Automations)

When a task is **assigned to `AI_Agent`** (transfer on the board, `PATCH`, MCP `update_task`) or **created** already with that assignee, Task Tracker POSTs JSON to `TT_WEBHOOK_URL`.

## Env (PM2 `ecosystem.config.cjs` or shell)

| Variable | Meaning |
|----------|---------|
| `TT_WEBHOOK_URL` | Target URL (Cursor Automations webhook **or** a LAN relay) |
| `TT_WEBHOOK_AUTH` | Full `Authorization` value, e.g. `Bearer crsr_…` |
| `TT_WEBHOOK_ASSIGNEE` | Role that triggers the hook (default `AI_Agent`) |
| `TT_WEBHOOK_TIMEOUT_MS` | Timeout (default `8000`) |
| `TT_WEBHOOK_ENABLED` | Set `0` to disable without clearing the URL |

## Events

| `event` | When |
|---------|------|
| `assignee_to_agent` | `assignee` changed **to** the trigger role |
| `task_created_for_agent` | New task created with that assignee |

Re-saving the same assignee does **not** re-fire. Webhook failures do **not** fail the task update.

## Diagnostics

```bash
curl -s http://127.0.0.1:3100/api/webhooks/status
curl -s -X POST http://127.0.0.1:3100/api/webhooks/test \
  -H 'Content-Type: application/json' \
  -d '{"dry_run":true}'
```

With URL configured, omit `dry_run` (or set `false`) to send a real POST.

## Cursor Automations note

Cursor’s webhook URL is normally a **cloud** endpoint. The RPI must be able to **POST outbound** to that host. The cloud agent then needs a path back to Task Tracker MCP on the LAN (dashboard MCP URL reachable from Cursor, Tailscale, etc.). For a fully offline LAN, point `TT_WEBHOOK_URL` at a **local relay** that starts a local agent instead of Cursor cloud Automations.
