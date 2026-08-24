#!/bin/bash
# Создать новую игру из шаблона games/_template
# Использование: scripts/new-game.sh my-game-name
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SLUG="${1:-}"

if [[ -z "$SLUG" ]]; then
    echo "Использование: scripts/new-game.sh <slug>" >&2
    echo "Пример: scripts/new-game.sh catch-stars" >&2
    exit 1
fi

if [[ ! "$SLUG" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    echo "Slug: только a-z, 0-9 и дефис (например catch-stars)" >&2
    exit 1
fi

TEMPLATE="$ROOT/games/_template"
DEST="$ROOT/games/$SLUG"

if [[ -e "$DEST" ]]; then
    echo "Уже существует: $DEST" >&2
    exit 1
fi

cp -r "$TEMPLATE" "$DEST"
rm -rf "$DEST/built"

# Читаемое имя из slug: catch-stars → Catch Stars
NAME="$(echo "$SLUG" | sed 's/-/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2); print}')"

node -e "
const fs = require('fs');
const p = process.argv[1];
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.name = process.argv[2];
j.description = '';
fs.writeFileSync(p, JSON.stringify(j, null, 4) + '\n');
" "$DEST/pxt.json" "$NAME"

echo "Создана игра: games/$SLUG"
echo "Сборка: scripts/build.sh games/$SLUG"
