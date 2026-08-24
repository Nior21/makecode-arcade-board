#!/bin/bash
# Ждёт подключения консоли (UF2 bootloader) и мгновенно прошивает игру.
# Использование: scripts/flash-wait.sh [game-slug] [hw] [timeout_sec]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Не даём телефону уснуть во время ожидания OTG.
termux-wake-lock 2>/dev/null || true
trap 'termux-wake-unlock 2>/dev/null || true' EXIT

exec node "$ROOT/scripts/flash-wait.js" "${1:-my-test}" "${2:-${HW:-samd51}}" "${3:-120}"
