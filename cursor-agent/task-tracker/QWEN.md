# task-tracker

MCP-сервер системы заявок. Line-based JSON-RPC через stdin/stdout, HTTP-обёртка на порту 3100.

## Инструменты для работы с сервером

### rpc.js — универсальный RPC-клиент

`scripts/rpc.js` — единый инструмент для вызова MCP-методов task-tracker.
Работает на Windows (cmd/PowerShell), Linux (RPi), Android (Termux).

```bash
node scripts/rpc.js tools/list
node scripts/rpc.js tools/call create_task '{"title":"Задача","project":"default"}'
node scripts/rpc.js --debug tools/list   # диагностика
```

Подробнее: `scripts/README.md`

### deploy-and-verify.js — деплой + проверка

`scripts/deploy-and-verify.js` — полная цепочка после git push:
проверка лога, совпадение коммитов, reconnect Qwen Code, тест всех 7 инструментов, cleanup.

```bash
node scripts/deploy-and-verify.js          # полный цикл
node scripts/deploy-and-verify.js --skip-push  # если push уже сделан
```

**Важно:** после каждого push запускать `node scripts/deploy-and-verify.js --skip-push`.

## Известные проблемы и решения

### 1. `list_tasks` / `getProjectContext` падает с `localeCompare of undefined`

**Симптом:** `Cannot read properties of undefined (reading 'localeCompare')`

**Причина:** У некоторых задач отсутствует поле `created_at` или `updated_at` (старые задачи, созданные до добавления этих полей). Сортировка через `.localeCompare()` падает на `undefined`.

**Решение (код):** Везде, где используется `.localeCompare()`, добавить fallback на пустую строку:
```js
(b.created_at || '').localeCompare(a.created_at || '')
```

**Решение (данные):** На RPI выполнить backfill для задач без `created_at`:
```bash
cd /home/pi/task-tracker
for f in tasks/*.json; do
  [ "$(basename "$f")" = "index.json" ] && continue
  has_created=$(jq 'has("created_at") and .created_at != null' "$f")
  if [ "$has_created" = "false" ]; then
    file_date=$(stat -c "%y" "$f" | cut -d. -f1 | sed 's/ /T/' | sed 's/$/Z/')
    tmp=$(mktemp)
    jq --arg dt "$file_date" '.created_at = $dt | .updated_at = (.updated_at // $dt)' "$f" > "$tmp" && mv "$tmp" "$f"
  fi
done
```

### 2. Сервис systemd не стартует (порт занят / не тот ExecStart)

**Симптом:** `systemctl status task-tracker` показывает `inactive (dead)`, порт 3100 не слушается, хотя старый процесс висит.

**Причины:**
- Старый процесс `http-server.js` (запущенный вручную) висит и держит порт 3100 — systemd не может стартовать
- `ExecStart` в unit-файле указывает на `mcp-server.js` (stdin/stdout), а не на `http-server.js` (HTTP)

**Решение:**
```bash
# Убить старый процесс
sudo kill <pid>

# Поправить unit (если нужно)
sudo sed -i 's|mcp-server.js|http-server.js|' /etc/systemd/system/task-tracker.service
sudo systemctl daemon-reload

# Перезапустить
sudo systemctl restart task-tracker
```

**Профилактика:** После деплоя через post-receive проверять, что сервис действительно активен:
```bash
systemctl is-active task-tracker || sudo systemctl restart task-tracker
```

### 3. Философия: не падать, а работать настолько, насколько возможно

Любая ошибка не должна ронять сервис. Если данных нет — использовать разумные значения по умолчанию (пустая строка, 0, null). Если сервис не может стартовать — логировать причину, а не просто падать.
