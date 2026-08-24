#!/bin/bash
# Сборка игры MakeCode Arcade → binary.uf2
# Использование: scripts/build.sh [путь-к-игре] [hw]
#   scripts/build.sh                      → games/_template, hw из mkc.json или samd51
#   scripts/build.sh games/my-game rp2040
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GAME="${1:-games/_template}"
if [[ "$GAME" != /* ]]; then
    GAME="$ROOT/$GAME"
fi

HW="${2:-${HW:-samd51}}"

if [[ ! -f "$GAME/pxt.json" ]]; then
    echo "Ошибка: не найден pxt.json в $GAME" >&2
    exit 1
fi

MKC="$ROOT/node_modules/makecode/makecode"
if [[ ! -f "$MKC" ]]; then
    echo "mkc не установлен. Запустите: npm install --no-bin-links" >&2
    exit 1
fi

cd "$GAME"
if [[ -n "$HW" ]]; then
    node "$MKC" build --hw "$HW"
else
    node "$MKC" build
fi

# Сообщить супервизору о новой сборке (если server.js запущен).
SLUG="$(basename "$GAME")"
curl -sf -X POST "http://127.0.0.1:${MC_PORT:-3778}/api/flash/supervisor/recheck" >/dev/null 2>&1 || true
echo "Build OK: $GAME (hw=${HW:-default})"
