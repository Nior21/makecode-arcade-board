# Streamable HTTP Transport for MCP Servers

Универсальная инструкция по реализации Streamable HTTP транспорта для MCP-серверов. Подходит для любых языков и фреймворков.

## Что это

Streamable HTTP — транспортный протокол MCP, работающий поверх HTTP. В отличие от SSE-транспорта (который требует постоянного SSE-соединения), Streamable HTTP позволяет серверу выбирать: вернуть ответ сразу (JSON) или через SSE (для длительных операций).

## Эндпоинты

Все MCP-запросы идут на один endpoint — `/mcp`.

| Метод | Путь | Назначение |
|-------|------|------------|
| `GET` | `/mcp` | Открыть SSE-поток для получения сообщений от сервера |
| `POST` | `/mcp` | Отправить JSON-RPC запрос/нотификацию/ответ |
| `DELETE` | `/mcp` | Завершить сессию |
| `OPTIONS` | `/mcp` | CORS preflight |

## Заголовки

### Запрос (клиент → сервер)

| Заголовок | Описание | Пример |
|-----------|----------|--------|
| `Content-Type` | Всегда `application/json` для POST | `application/json` |
| `Accept` | Что клиент готов принять | `application/json, text/event-stream` |
| `Mcp-Session-Id` | ID сессии (после initialize) | `550e8400-e29b-41d4-a716-446655440000` |
| `MCP-Protocol-Version` | Версия протокола | `2025-03-26` |
| `Last-Event-ID` | Для возобновления SSE после разрыва | `evt-42-1712345678000` |

### Ответ (сервер → клиент)

| Заголовок | Описание | Когда |
|-----------|----------|-------|
| `Content-Type` | `application/json` или `text/event-stream` | Всегда |
| `Mcp-Session-Id` | ID созданной сессии | Только в ответе на `initialize` |

## Протокол работы

### 1. Инициализация (POST /mcp)

Клиент шлёт `initialize`:

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": {
      "name": "my-client",
      "version": "1.0.0"
    }
  }
}
```

Сервер отвечает:

```
HTTP/1.1 200 OK
Content-Type: application/json
Mcp-Session-Id: 550e8400-e29b-41d4-a716-446655440000

{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "protocolVersion": "2025-03-26",
    "capabilities": {
      "tools": {}
    },
    "serverInfo": {
      "name": "my-server",
      "version": "1.0.0"
    }
  }
}
```

**Важно:** `Mcp-Session-Id` — обязательный заголовок в ответе. Клиент будет слать его во всех последующих запросах.

### 2. Последующие запросы (POST /mcp)

Клиент шлёт запрос с заголовком `Mcp-Session-Id`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

Сервер отвечает:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [...]
  }
}
```

### 3. Нотификации (POST /mcp)

Если у запроса нет поля `id` — это нотификация. Сервер отвечает `202 Accepted` без тела.

Пример: `notifications/initialized` — клиент сообщает, что инициализация завершена.

### 4. SSE-поток (GET /mcp)

Клиент может открыть SSE-поток для получения асинхронных сообщений от сервера. Требует заголовок `Accept: text/event-stream` и `Mcp-Session-Id`.

Сервер отвечает:

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

:ok

```

Формат SSE-сообщений:

```
id: evt-1-1712345678000
data: {"jsonrpc":"2.0","id":2,"result":{...}}

```

### 5. Завершение сессии (DELETE /mcp)

Сервер отвечает `202 Accepted`, закрывает SSE-потоки и удаляет сессию.

## Обязательные требования к серверу

1. **Генерировать sessionId** (UUID v4) при каждом `initialize` и возвращать его в заголовке `Mcp-Session-Id`
2. **Хранить сессии** в памяти (Map<sessionId, sessionData>)
3. **Проверять Mcp-Session-Id** на всех запросах, кроме `initialize`
4. **Отвечать 202** на нотификации (id === undefined)
5. **Поддерживать CORS** — `Access-Control-Allow-Origin: *`
6. **protocolVersion** в ответе на `initialize` должна быть версией, которую сервер реально поддерживает (не эхо клиентской версии)

## Минимальная реализация на Node.js

```javascript
import { createServer } from 'http';
import { randomUUID } from 'crypto';

const PORT = 3100;
const sessions = new Map();
const sseStreams = new Map();

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (url.pathname !== '/mcp') { res.writeHead(404); res.end(); return; }

  const sessionId = req.headers['mcp-session-id'];

  // GET — SSE поток
  if (req.method === 'GET') {
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400); res.end('Session required'); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    if (!sseStreams.has(sessionId)) sseStreams.set(sessionId, new Set());
    sseStreams.get(sessionId).add(res);
    res.write(':ok\n\n');
    req.on('close', () => {
      const s = sseStreams.get(sessionId);
      if (s) { s.delete(res); if (!s.size) sseStreams.delete(sessionId); }
    });
    return;
  }

  // DELETE — завершить сессию
  if (req.method === 'DELETE') {
    if (sessionId && sessions.has(sessionId)) {
      sessions.delete(sessionId);
      const s = sseStreams.get(sessionId);
      if (s) { s.forEach(r => r.end()); sseStreams.delete(sessionId); }
      res.writeHead(202); res.end();
    } else { res.writeHead(404); res.end(); }
    return;
  }

  // POST — JSON-RPC
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch {
        res.writeHead(400); res.end('Invalid JSON'); return;
      }

      // Нотификация
      if (msg.id === undefined) { res.writeHead(202); res.end(); return; }

      // Initialize
      if (msg.method === 'initialize') {
        const newId = randomUUID();
        sessions.set(newId, { createdAt: new Date() });
        res.writeHead(200, { 'Content-Type': 'application/json',
          'Mcp-Session-Id': newId });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'my-server', version: '1.0.0' }
          }
        }));
        return;
      }

      // Остальные запросы
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(400); res.end('Session required'); return;
      }

      // ... обработка tools/list, tools/call и т.д.
      const response = { jsonrpc: '2.0', id: msg.id, result: {} };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
    return;
  }

  res.writeHead(405); res.end();
});

server.listen(PORT, '0.0.0.0');
```

## Тестирование

```bash
# 1. Initialize
SESSION=$(curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  -D - | grep -i 'mcp-session-id' | awk '{print $2}' | tr -d '\r')

echo "Session: $SESSION"

# 2. tools/list
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

## Известные проблемы

1. **protocolVersion** — сервер должен отвечать своей версией, а не эхом клиентской. Если клиент шлёт `2025-11-25`, а сервер отвечает `2025-03-26` — это нормально, клиент сам решает, принимать ли эту версию.
2. **Mcp-Session-Id** — обязателен. Без него клиент не сможет делать запросы после initialize.
3. **GET /mcp** — не все клиенты открывают SSE-поток. Это нормально, сервер должен работать и без него.
4. **CORS** — обязателен для браузерных клиентов. Для CLI-клиентов (как Qwen Code) тоже рекомендуется.
