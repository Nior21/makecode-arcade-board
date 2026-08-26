#!/usr/bin/env bash
# Start web UI + Task Tracker + AI worker (Termux / local dev).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[start-all] root=$ROOT"

if [ ! -d node_modules ]; then
  echo "[start-all] npm install (root)…"
  npm install --no-bin-links
fi

WORKER_DIR="$ROOT/cursor-agent/tt-agent-worker"
if [ ! -d "$WORKER_DIR/node_modules" ]; then
  echo "[start-all] npm install (tt-agent-worker)…"
  (cd "$WORKER_DIR" && npm install --no-bin-links)
fi

if [ ! -f "$WORKER_DIR/.env" ] && [ -f "$WORKER_DIR/.env.example" ]; then
  cp "$WORKER_DIR/.env.example" "$WORKER_DIR/.env"
  echo "[start-all] created $WORKER_DIR/.env — укажите CURSOR_API_KEY"
fi

# node server.js autostarts TT + worker; one process is enough for daily use.
echo "[start-all] node server.js (autostart TT :3100 + worker :9080)"
exec node server.js
