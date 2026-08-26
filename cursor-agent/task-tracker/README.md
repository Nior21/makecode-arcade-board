# task-tracker — MCP-сервер системы заявок

Line-based JSON-RPC MCP-сервер для управления задачами/заявками по всем проектам.

## Архитектура

```
Qwen Code (MCP-клиент)
    │ JSON-RPC (stdin/stdout)
    ▼
mcp-server.js (Node.js)
    │
    ├── tasks/*.json       — каждая задача в отдельном файле
    ├── tasks/index.json   — индекс (список ID + проекты)
    └── logs/mcp.log       — лог операций
```

## Инструменты MCP

| Метод | Назначение |
|-------|-----------|
| `create_task` | Создать задачу (авто-расчёт priority_score) |
| `get_task` | Получить задачу по ID |
| `update_task` | Обновить поля (статус, приоритет, теги и т.д.) |
| `list_tasks` | Список с фильтрацией (проект, статус, приоритет, роль) |
| `search_tasks` | Полнотекстовый поиск |
| `get_project_context` | Контекст проекта для LLM (статистика, срочные, активность) |
| `rank_tasks` | Переранжировать все задачи проекта по priority_score |

## Приоритет (priority_score)

0–100, автоматический расчёт:
- Базовый приоритет: critical=40, high=30, medium=15, low=0
- Статус: open=+10, in_progress=+5
- Теги: bug/blocker/security/urgent/crash/deploy/hotfix = +5 каждый
- Дедлайн: просрочен = +20, <24ч = +15, <72ч = +5
- Возраст: +1/день (макс +20)

## Проекты

Текущие проекты в системе:
- `syslog-receiver` — приёмник syslog с веб-интерфейсом
- `task-tracker` — сама система заявок (самодокументируема)

## Деплой

Автоматический деплой на RPi через Qwen Code Stop Hook (единый orchestrator).

```bash
# Stop Hook запускает:
node /storage/emulated/0/Projects/syslog-receiver/scripts/deploy-orchestrator.js
```

Скрипт проверяет `git log rpi/master..HEAD` во всех проектах из `projects.json`.
Если есть неотправленные коммиты — пушит.

**RPi bare repo:** `/home/pi/task-tracker.git`
**post-receive hook:** перезапускает `task-tracker.service`

### Ручной пуш

```bash
git push rpi master --force
```

### Логи

`logs/deploy.log` — timestamped лог всех деплоев.

## Синонимы

"заявки", "TT", "task-tracker", "система заявок" — всё это одно и то же.
