#!/usr/bin/env bash
# tt-agent-worker supervisor
# Manages the worker process lifecycle: start / stop / restart / status.
# Used by the web interface restart button and by the watchdog.
#
# Usage:
#   supervisor.sh start     — start worker if not running
#   supervisor.sh stop      — stop worker (SIGTERM, then SIGKILL after grace)
#   supervisor.sh restart   — stop + start
#   supervisor.sh status    — print JSON status (pid, running, log tail)
#   supervisor.sh watch     — loop: keep worker alive, restart on crash/hang
#
# The worker is started detached (setsid) so it survives this script's exit.

set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
# Keep the log in the parent dir to match the existing manual-start convention.
LOG="$(dirname "$DIR")/tt-agent-worker.log"
PIDFILE="$DIR/tt-agent-worker.pid"
QUEUE_STATE="$DIR/queue-state.json"
NODE_BIN="$(command -v node || echo node)"
WORKER_CMD=(node --max-old-space-size=192 src/server.js)
# Grace while Agent.prompt holds the worker (avoid restart loops + duplicate starts).
BUSY_GRACE_SEC="${TT_WORKER_BUSY_GRACE_SEC:-1800}"

# How long to wait for a graceful stop before SIGKILL.
STOP_GRACE=8

log() { echo "[supervisor $(date '+%F %T')] $*" >> "$LOG"; }

pid_of() {
  if [ -f "$PIDFILE" ]; then
    local pid
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi
  # Fallback: find the actual node process (not the bash wrapper).
  # Match the node binary path + args, excluding the bash -c wrapper.
  pgrep -f "node --max-old-space-size=192 src/server.js" 2>/dev/null \
    | while read -r p; do
        if [ "$(readlink -f "/proc/$p/exe" 2>/dev/null)" = "$(readlink -f "$NODE_BIN" 2>/dev/null)" ]; then
          echo "$p"
          break
        fi
      done | head -n1 || true
}

is_running() {
  local pid
  pid="$(pid_of)"
  [ -n "$pid" ]
}

# True when queue-state.json shows a recent active job (worker likely busy, not hung).
worker_recently_busy() {
  [ -f "$QUEUE_STATE" ] || return 1
  "$NODE_BIN" -e "
    const fs=require('fs');
    try {
      const d=JSON.parse(fs.readFileSync('$QUEUE_STATE','utf8'));
      const a=d.active;
      if(!a||!a.startedAt) process.exit(1);
      const age=(Date.now()-new Date(a.startedAt).getTime())/1000;
      process.exit(age<$BUSY_GRACE_SEC?0:1);
    } catch { process.exit(1); }
  " 2>/dev/null
}

start() {
  if is_running; then
    echo "already running (pid $(pid_of))"
    return 0
  fi
  log "starting worker"
  # setsid detaches so the worker keeps running after this script exits.
  ( cd "$DIR" && setsid "$NODE_BIN" --max-old-space-size=192 src/server.js >> "$LOG" 2>&1 & echo $! > "$PIDFILE" )
  # Wait up to ~5s for the HTTP port to come up.
  for _ in $(seq 1 25); do
    if curl -sf -m 1 "http://127.0.0.1:9080/health" >/dev/null 2>&1; then
      log "worker up (pid $(pid_of))"
      echo "started (pid $(pid_of))"
      return 0
    fi
    sleep 0.2
  done
  log "worker did not become healthy within 5s"
  echo "started but not healthy yet (pid $(pid_of))"
  return 0
}

stop() {
  local pid
  pid="$(pid_of)"
  if [ -z "$pid" ]; then
    echo "not running"
    rm -f "$PIDFILE"
    return 0
  fi
  log "stopping worker (pid $pid)"
  kill -TERM "$pid" 2>/dev/null || true
  # Wait for graceful exit, then SIGKILL.
  for _ in $(seq 1 "$STOP_GRACE"); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PIDFILE"
      log "worker stopped (pid $pid)"
      echo "stopped"
      return 0
    fi
    sleep 1
  done
  log "worker did not exit gracefully, SIGKILL (pid $pid)"
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PIDFILE"
  echo "stopped (killed)"
  return 0
}

restart() {
  stop
  sleep 1
  start
}

status() {
  local pid running
  pid="$(pid_of)"
  running="false"
  [ -n "$pid" ] && running="true"
  local tail_log=""
  if [ -f "$LOG" ]; then
    tail_log="$(tail -n 5 "$LOG" 2>/dev/null || true)"
  fi
  printf '{"running":%s,"pid":%s,"log_tail":%s}\n' \
    "$running" \
    "$([ -n "$pid" ] && echo "$pid" || echo null)" \
    "$(printf '%s' "$tail_log" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '""')"
}

# Watch loop: keep the worker alive. If it dies, restart. If it hangs
# (no /health response), kill and restart. Runs forever.
watch() {
  log "watch loop started"
  while true; do
    if ! is_running; then
      log "worker not running — restarting"
      start
    elif ! curl -sf -m 8 "http://127.0.0.1:9080/health" >/dev/null 2>&1; then
      if worker_recently_busy; then
        log "worker health timeout but active job < ${BUSY_GRACE_SEC}s — skip kill"
      else
        log "worker unresponsive — killing and restarting"
        stop
        sleep 1
        start
      fi
    fi
    sleep 10
  done
}

# Start the watch loop as a detached background process (if not already running).
# This is what keeps the worker alive across crashes/hangs.
ensure_watch() {
  if pgrep -f "supervisor.sh watch" >/dev/null 2>&1; then
    echo "watch already running"
    return 0
  fi
  log "starting detached watch loop"
  ( setsid bash "$0" watch >> "$LOG" 2>&1 & )
  echo "watch started"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) restart ;;
  status) status ;;
  watch) watch ;;
  ensure-watch) ensure_watch ;;
  *) echo "usage: $0 {start|stop|restart|status|watch|ensure-watch}" >&2; exit 1 ;;
esac
