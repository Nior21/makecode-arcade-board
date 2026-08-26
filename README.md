# Система заявок (makecode-arcade)

Веб-оболочка + движок Task Tracker и AI-воркер. Один репозиторий — один `git clone` / Pull.

## Состав репозитория

| Путь | Синхронизация | Описание |
|------|---------------|----------|
| `public/`, `server.js`, `lib/`, `scripts/` | GitHub | UI, HTTP-сервер (:3778) |
| `cursor-agent/task-tracker/` | GitHub | TT-бэкенд (:3100), MCP |
| `cursor-agent/tt-agent-worker/` | GitHub | AI-агент (:9080) |
| `cursor-agent/task-tracker/tasks/` | **локально** | Заявки — у каждого свои |
| `games/` | **локально** | MakeCode-проекты |
| `.github-auth.json`, `.cursor-auth.json`, `.env` | **локально** | Секреты |

## Развёртывание на телефоне (Termux)

### 1. Один раз
```bash
termux-setup-storage
pkg update && pkg install -y nodejs git
mkdir -p ~/storage/shared/Projects && cd ~/storage/shared/Projects
git clone https://github.com/Nior21/makecode-arcade-board.git makecode-arcade
cd makecode-arcade
npm install --no-bin-links
cd cursor-agent/tt-agent-worker && npm install --no-bin-links
cp .env.example .env   # свой CURSOR_API_KEY
```

### 2. Запуск (3 процесса)
```bash
# TT
cd ~/storage/shared/Projects/makecode-arcade/cursor-agent/task-tracker
node http-server.js &

# AI-воркер
cd ~/storage/shared/Projects/makecode-arcade/cursor-agent/tt-agent-worker
./supervisor.sh start

# Веб-интерфейс
cd ~/storage/shared/Projects/makecode-arcade
node server.js &
```

Браузер: `http://127.0.0.1:3778`

### 3. Авторизация (popup проектов)
- **GitHub PAT** — Pull/Push движка
- **Cursor API key** — AI_Agent (если нужен)

## Обновление движка

**У вас (автор правок):** Push в UI или `POST /api/board/push`

**У коллеги:**
1. Popup → «Система заявок» → **Pull**
2. Кнопка **🔄** (перезапуск TT + воркер + веб-сервер)
3. Версия в шапке совпадает с вашей

```bash
curl -X POST http://127.0.0.1:3778/api/board/pull
curl http://127.0.0.1:3778/api/board/status
```

## Миграция со старой схемы (cursor-agent рядом с репо)

Если заявки лежали в `../cursor-agent/task-tracker/tasks/`:
```bash
cp -a ../cursor-agent/task-tracker/tasks/. cursor-agent/task-tracker/tasks/
cp ../cursor-agent/task-tracker/.env cursor-agent/task-tracker/.env 2>/dev/null || true
cp ../cursor-agent/tt-agent-worker/.env cursor-agent/tt-agent-worker/.env 2>/dev/null || true
```
Затем перезапуск 🔄. Старый каталог можно удалить после проверки.

## Версии

Коммиты: `v.1.0.0: описание`. Версия в UI — из сообщения HEAD.

### Привязка работы агента к коммитам

| Тип работы | bump |
|------------|------|
| правки, багфиксы | `patch` |
| новая фича | `minor` |
| переписывание структуры | `major` |

```bash
curl -s -X POST http://127.0.0.1:3778/api/board/commit \
  -H 'Content-Type: application/json' \
  -d '{"bump":"minor","message":"feat: …","taskId":"117d3d55"}'
```

Push — только по запросу (`"push": true` или кнопка Push).
