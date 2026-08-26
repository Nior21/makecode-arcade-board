# tt-agent-worker

LAN relay: Task Tracker assigns **AI_Agent** → HTTP hook on localhost → **one** Cursor SDK local agent on the RPI (files on disk, model via Cursor API).

## Safety (Raspberry Pi)

| Guard | Default |
|-------|---------|
| Concurrent agents | **1** (hard) |
| Queue depth | **2** (reject with 429) |
| Dedupe | same task id not queued twice |
| MemAvailable gate | ~180 MiB before start |
| Cooldown | 3 s between jobs |
| Node heap | `--max-old-space-size=192` |
| PM2 restart | `max_memory_restart: 220M` |
| Listen | **127.0.0.1:9080** only |

## Setup

1. `cp .env.example .env` and set `CURSOR_API_KEY` from [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations).
2. `npm install` (if `sqlite3` build fails: `export npm_config_nodedir=$NVM_DIR/versions/node/$(node -v)`).
3. Start worker: `pm2 start ecosystem.config.cjs && pm2 save`
4. Point TT at the hook (already in `task-tracker/ecosystem.config.cjs`):
   - `TT_WEBHOOK_URL=http://127.0.0.1:9080/hook`
5. `pm2 restart task-tracker-http --update-env`

## Endpoints

- `GET /health` — queue + RAM
- `GET /status` — config snapshot
- `POST /hook` — TT webhook payload

## Dry run (no API key / no SDK)

```bash
TT_WORKER_DRY_RUN=1 pm2 restart tt-agent-worker --update-env
# or: npm run dry-run
curl -s -X POST http://127.0.0.1:9080/hook -H 'Content-Type: application/json' -d @- <<'EOF'
{"event":"assignee_to_agent","to_assignee":"AI_Agent","task":{"id":"00000000-0000-4000-8000-000000000099","short_id":"00000000","project":"yt-game","title":"dry"}}
EOF
```

## First real test

1. Put key in `.env`, clear `TT_WORKER_DRY_RUN`.
2. On the board: transfer a small `yt-game` task to **AI_Agent**.
3. Watch: `pm2 logs tt-agent-worker` and TT comments from `AI_Agent`.
