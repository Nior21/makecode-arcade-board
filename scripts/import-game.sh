#!/bin/bash
# Импорт игры с arcade.makecode.com по share-ссылке
# Использование: scripts/import-game.sh <slug> <share-url>
# Пример: scripts/import-game.sh space-shooter "https://makecode.com/_iw2adpRK5FAH"
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SLUG="${1:-}"
URL="${2:-}"

if [[ -z "$SLUG" || -z "$URL" ]]; then
    echo "Использование: scripts/import-game.sh <slug> <share-url>" >&2
    echo "Share URL: Share → Publish в arcade.makecode.com" >&2
    exit 1
fi

if [[ ! "$SLUG" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    echo "Slug: только a-z, 0-9 и дефис" >&2
    exit 1
fi

DEST="$ROOT/games/$SLUG"
if [[ -e "$DEST" ]]; then
    echo "Уже существует: $DEST" >&2
    exit 1
fi

MKC="$ROOT/node_modules/makecode/makecode"
if [[ ! -f "$MKC" ]]; then
    echo "mkc не установлен. Запустите: npm install --no-bin-links" >&2
    exit 1
fi

mkdir -p "$DEST"
cd "$DEST"
node "$MKC" download "$URL"

# mkc.json для сборки (hw из корневого конфига)
if [[ ! -f mkc.json ]]; then
    if [[ -f "$ROOT/mkc.json" ]]; then
        cp "$ROOT/mkc.json" mkc.json
    else
        echo '{"hw":"stm32f401"}' > mkc.json
    fi
fi

NAME="$(echo "$SLUG" | sed 's/-/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2); print}')"
node -e "
const fs = require('fs');
const p = process.argv[1];
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
if (!j.name || j.name === 'my-project') j.name = process.argv[2];
fs.writeFileSync(p, JSON.stringify(j, null, 4) + '\n');
" pxt.json "$NAME"

echo "Импортировано: games/$SLUG"
echo "Сборка: scripts/build.sh games/$SLUG"
