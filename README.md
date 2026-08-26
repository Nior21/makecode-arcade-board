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

### 2. Запуск

**Проще всего** — один процесс (TT и воркер поднимутся автоматически):

```bash
cd ~/storage/shared/Projects/makecode-arcade
bash scripts/start-all.sh
# или: node server.js
```

Браузер: `http://127.0.0.1:3778`

Отключить автозапуск TT/воркера: `MC_NO_AUTOSTART=1 node server.js`

<details><summary>Ручной запуск (3 процесса)</summary>

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

</details>

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

<details>
<summary>«Warning: redirecting to …» при git pull</summary>

Это **не ошибка**. Git сообщает, что URL в `remote.origin.url` не совпадает с каноническим адресом GitHub (часто `.git` в конце или лишний `/`), сервер делает HTTP-редирект, pull при этом проходит.

**Already up to date** — успех: локальная ветка уже содержит все коммиты с GitHub. Новых правок нет.

Если ожидали обновление — сравните `git log -1 --oneline` с [репозиторием](https://github.com/Nior21/makecode-arcade-board). После Pull нажмите **🔄** (перезапуск процессов).

Кнопка **Pull** в UI нормализует URL автоматически. Вручную: `git remote set-url origin https://github.com/Nior21/makecode-arcade-board`
</details>

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

## Диагностика (задачи не сохраняются)

1. **Частая причина:** запущен только `node server.js`, а TT (:3100) не работал. С v1.3.2+ TT и воркер стартуют автоматически; иначе нажмите **🔄** в шапке задач.
2. Проверка:
   ```bash
   curl -s http://127.0.0.1:3778/api/stack/status
   # tt.ok:true, worker.running:true
   curl -s http://127.0.0.1:3778/api/tt/projects
   ```
3. В UI — красный баннер «Task Tracker не запущен».
4. Логи: `cursor-agent/task-tracker/logs/http.log`, `cursor-agent/tt-agent-worker.log`.
5. Node для воркера: **≥ 20** (`node --version`). TT — обычный Node 18+.
6. После clone: `npm install` в корне **и** в `cursor-agent/tt-agent-worker/`.

## Удалённая помощь (Termux на телефоне коллеги)

### В UI (рекомендуется)

Popup **Проекты** → **Техподдержка — удалённый доступ**:

| Роль | Кнопка | Действие |
|------|--------|----------|
| Клиент (нужна помощь) | **Техподдержка** | Диагностика + подготовка SSH → ввести код от помощника |
| Помощник | **Помочь** | Сгенерировать 6-значный код → продиктовать клиенту → SSH по IP |

Код задаёт **помощник** (как Windows Quick Assist). Пароль SSH = этот код, сессия 30 мин. Отчёт: `.support/diagnostics-*.json`.

### Вручную (Termux)

```bash
pkg install -y openssh
passwd                    # пароль для входа по SSH
sshd                      # порт 8022
whoami && ip route get 1  # логин и IP
```

**В одной Wi‑Fi:** `ssh -p 8022 USER@IP_ТЕЛЕФОНА` с ноутбука.

**Через интернет (рекомендуется):** [Tailscale](https://tailscale.com) на обоих телефонах/ПК → `ssh -p 8022 user@100.x.x.x`.

На удалённой машине: `curl :3778/api/stack/status` + `bash scripts/start-all.sh`.

AI-агент в Cursor **не подключается** к чужому телефону напрямую — нужен SSH/Tailscale и человек, который выполнит команды (или вы сами по SSH).
