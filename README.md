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

## Запуск

```bash
npm install
node server.js
```

Task Tracker должен быть доступен на `http://127.0.0.1:3100`.

## Cursor / AI worker

Cursor CLI устанавливается отдельно (`@cursor/sdk` в tt-agent-worker). Каждый пользователь указывает **свой** API key в popup проектов — ключ не синхронизируется через GitHub.
