# task-tracker — Roadmap

> **Управление задачами ведётся через сам task-tracker MCP.**
> Этот файл — заглушка для истории и статуса проекта.

## Статус проекта

| Компонент | Статус |
|-----------|--------|
| MCP-сервер (JSON-RPC stdin/stdout) | ✅ Работает |
| CRUD задачи (create/get/update/list/search) | ✅ Работает |
| Приоритет (priority_score 0–100) | ✅ Работает |
| Контекст проекта для LLM | ✅ Работает |
| Ранжирование задач | ✅ Работает |
| Flat JSON storage (tasks/*.json + index.json) | ✅ Работает |
| Автодеплой на RPi (Stop Hook) | ✅ Работает |

## Деплой

Через единый orchestrator в syslog-receiver:
```
node /storage/emulated/0/Projects/syslog-receiver/scripts/deploy-orchestrator.js
```

RPi: `/home/pi/task-tracker.git` → post-receive → systemctl restart task-tracker

## Открытые заявки

См. `get_project_context` в MCP-инструментах task-tracker.
