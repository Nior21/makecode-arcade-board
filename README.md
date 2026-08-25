# Система заявок (makecode-arcade)

Веб-оболочка: доска задач (Task Tracker), выбор MakeCode-проектов, GitHub sync, автопрошивка консоли.

## Состав репозитория

- `public/` — UI (доска задач, popup проектов)
- `server.js` — HTTP-сервер (:3778)
- `lib/` — GitHub/board sync, без секретов
- `scripts/` — сборка игр, flash-wait

Игры (`games/`) и секреты (`.github-auth.json`, `.cursor-auth.json`) **не** входят в этот репозиторий — каждый разработчик хранит их локально.

## Версии

Коммиты начинаются с semver: `v.1.0.0: описание`. Версия в интерфейсе парсится из сообщения текущего коммита.

### Привязка работы агента к коммитам

Любая работа AI_Agent с изменением кода **заканчивается локальным коммитом**:

| Тип работы | bump | Пример |
|------------|------|--------|
| правки, багфиксы | `patch` | `#117d3d55 fix: …` |
| новая фича / доработка | `minor` | `#117d3d55 feat: …` |
| переписывание структуры | `major` | `#117d3d55 refactor!: …` |

```bash
curl -s -X POST http://127.0.0.1:3778/api/board/commit \
  -H 'Content-Type: application/json' \
  -d '{"bump":"minor","message":"feat: commit binding","taskId":"117d3d55"}'
```

Ответ: `{ version, sha, shortSha, commit, committed }`. Затем в TT: `update_task` → `delivery_commit`, в комментарии — sha и как проверить. Push — только по запросу (`"push": true` или кнопка Push в UI).

## Запуск

```bash
npm install
node server.js
```

Task Tracker должен быть доступен на `http://127.0.0.1:3100`.

## Cursor / AI worker

Cursor CLI устанавливается отдельно (`@cursor/sdk` в tt-agent-worker). Каждый пользователь указывает **свой** API key в popup проектов — ключ не синхронизируется через GitHub.
