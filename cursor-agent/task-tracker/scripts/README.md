# Скрипты task-tracker

## rpc.js — универсальный RPC-клиент

Единый инструмент для вызова MCP-методов task-tracker сервера.
Работает на Windows (cmd/PowerShell), Linux (RPi), Android (Termux).

### Быстрый старт

```bash
# Список всех инструментов
node scripts/rpc.js tools/list

# Создать задачу
node scripts/rpc.js tools/call create_task '{"title":"Купить молоко","priority":"high","project":"home"}'

# Получить задачу по ID (можно короткий #8c9cb87e)
node scripts/rpc.js tools/call get_task '{"id":"#8c9cb87e"}'

# Найти задачу или комментарий по #short / UUID
node scripts/rpc.js tools/call lookup '{"ref":"#8c9cb87e"}'
node scripts/rpc.js tools/call lookup '{"ref":"#a1b2c3d4","project":"yt-game"}'

# Обновить задачу
node scripts/rpc.js tools/call update_task '{"id":"uuid-here","updates":{"status":"done"}}'

# Список задач проекта
node scripts/rpc.js tools/call list_tasks '{"project":"home"}'

# Поиск по тексту
node scripts/rpc.js tools/call search_tasks '{"query":"молоко"}'

# Контекст проекта для LLM
node scripts/rpc.js tools/call get_project_context '{"project":"home"}'

# Переранжировать задачи проекта
node scripts/rpc.js tools/call rank_tasks '{"project":"home"}'
```

### Параметры

| Параметр | Описание |
|----------|----------|
| `--raw` | Вывод сырого JSON-RPC ответа (без парсинга) |
| `--session=UUID` | Использовать конкретную сессию |
| `--new-session` | Принудительно создать новую сессию |
| `--host=IP:PORT` | Другой хост (по умолч. `192.168.88.153:3100`) |
| `--debug` | Диагностика: платформа, среда, curl-команда, ответ |

### Переменные окружения

| Переменная | Описание |
|------------|----------|
| `TT_HOST` | Хост:порт (заменяет `--host`) |
| `TT_SESSION` | ID сессии (заменяет `--session`) |

### Как это работает (для LLM)

1. **Парсит аргументы** — определяет метод (`tools/list`, `tools/call`), имя инструмента, JSON-аргументы
2. **Определяет платформу и среду** — `detectOS()` (win32/linux/android), `detectShell()` (cmd/powershell/bash/...)
3. **Фикс PowerShell** — если среда `powershell`, curl вызывается как `curl.exe` (обходит встроенный алиас `Invoke-WebRequest`)
4. **Управление сессией** — при первом вызове делает `initialize`, получает `Mcp-Session-Id`, кэширует в `.rpc-cache/session.txt`. При повторных вызовах проверяет живучесть сессии через `ping`
5. **Формирует JSON-RPC** — пишет тело запроса во временный файл (решает проблемы с кавычками на разных платформах)
6. **Вызывает curl** — через `@file` (работает одинаково на cmd, PowerShell, bash)
7. **Парсит ответ** — для `tools/call` распаршивает вложенный JSON из `content[0].text`
8. **Очищает временные файлы** — удаляются сразу после получения ответа

### Диагностика ошибок

При ошибке запусти с `--debug`:

```bash
node scripts/rpc.js --debug tools/call create_task '{"title":"Тест"}'
```

Вывод в stderr:
```
[rpc:debug] Platform: win32
[rpc:debug] Shell: powershell
[rpc:debug] Curl command: curl.exe
[rpc:debug] Host: 192.168.88.153:3100
[rpc:debug] Method: tools/call
[rpc:debug] Tool: create_task
[rpc:debug] Args: {"title":"Тест"}
[rpc:debug] Request body file: ...\_body_xxx.json
[rpc:debug] Curl command: curl.exe -s -X POST ... -d @...
[rpc:debug] Response: {"jsonrpc":"2.0",...}
```

Если LLM при анализе ошибки видит `[rpc:debug]` — она сразу понимает, с какой платформой и средой столкнулась.

---

## deploy-and-verify.js — деплой + проверка

Автономная цепочка: push → ожидание деплоя → проверка лога → reconnect Qwen Code → тест всех 7 инструментов → cleanup.

### Использование

```bash
# Полный цикл
node scripts/deploy-and-verify.js

# Если push уже сделан
node scripts/deploy-and-verify.js --skip-push

# Без переподключения Qwen Code
node scripts/deploy-and-verify.js --skip-reconnect
```

### Что проверяет (12 проверок)

1. **Git push** — успешность `git push origin master --force`
2. **Деплой** — читает `/tmp/task-tracker-deploy.log` на RPi, ищет `SUCCESS: task-tracker is active`
3. **Версия файлов** — сравнивает `git rev-parse HEAD` локально и на RPi
4. **Reconnect** — вызывает `npx qwen mcp reconnect --all`
5. **tools/list** — проверяет наличие всех 7 инструментов
6. **create_task** — создаёт задачу, проверяет ID и title
7. **get_task** — получает задачу по ID
8. **update_task** — меняет статус, проверяет что применилось
9. **list_tasks** — фильтр по проекту, проверяет что задача в списке
10. **search_tasks** — поиск по тексту
11. **get_project_context** — контекст проекта
12. **rank_tasks** — переранжирование
13. **Cleanup** — удаление тестовой задачи с RPi

### Как это работает (для LLM)

Использует `rpc.js` для всех HTTP-запросов (ни одного прямого curl).
Каждый вызов `rpc()` передаёт JSON-аргументы через `@file` — временный файл,
который автоматически удаляется после получения ответа.
