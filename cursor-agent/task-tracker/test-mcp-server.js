#!/usr/bin/env node
/**
 * Тестовый MCP-сервер для проверки Streamable HTTP на RPi
 * Запуск: TT_PORT=3102 node test-mcp-server.js
 */

import { createServer } from 'http';
import { randomUUID } from 'crypto';

const PORT = parseInt(process.env.TT_PORT || '3102', 10);
const SUPPORTED_VERSION = '2025-03-26';

const sessions = new Map();
const sseStreams = new Map();

let eventIdCounter = 0;
function generateEventId() {
  return `evt-${++eventIdCounter}-${Date.now()}`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname !== '/mcp') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const sessionId = req.headers['mcp-session-id'];

  // GET /mcp — SSE
  if (req.method === 'GET') {
    const accept = req.headers['accept'] || '';
    if (!accept.includes('text/event-stream')) {
      res.writeHead(406);
      res.end('Not Acceptable');
      return;
    }
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400);
      res.end('Session required');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    if (!sseStreams.has(sessionId)) sseStreams.set(sessionId, new Set());
    sseStreams.get(sessionId).add(res);
    res.write(':ok\n\n');
    req.on('close', () => {
      const s = sseStreams.get(sessionId);
      if (s) { s.delete(res); if (!s.size) sseStreams.delete(sessionId); }
    });
    return;
  }

  // DELETE /mcp
  if (req.method === 'DELETE') {
    if (sessionId && sessions.has(sessionId)) {
      sessions.delete(sessionId);
      const s = sseStreams.get(sessionId);
      if (s) { s.forEach(r => r.end()); sseStreams.delete(sessionId); }
      res.writeHead(202);
      res.end();
    } else {
      res.writeHead(404);
      res.end('Session not found');
    }
    return;
  }

  // POST /mcp
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch {
        res.writeHead(400);
        res.end('Invalid JSON-RPC');
        return;
      }

      // Initialize
      if (msg.method === 'initialize') {
        const newId = randomUUID();
        sessions.set(newId, { createdAt: new Date() });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': newId
        });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: {
            protocolVersion: SUPPORTED_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'test-rpi', version: '1.0.0' }
          }
        }));
        console.error(`[${new Date().toISOString()}] INIT session=${newId}`);
        return;
      }

      // Notification — не требует сессии
      if (msg.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }

      // Остальные запросы — требуют сессию
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(400);
        res.end('Session required');
        return;
      }

      let response;
      switch (msg.method) {
        case 'ping':
          response = { jsonrpc: '2.0', id: msg.id, result: {} };
          break;
        case 'tools/list':
          response = {
            jsonrpc: '2.0', id: msg.id,
            result: {
              tools: [{
                name: 'hello',
                description: 'Тестовый инструмент',
                inputSchema: {
                  type: 'object',
                  properties: { name: { type: 'string', description: 'Имя' } },
                  required: ['name']
                }
              }]
            }
          };
          break;
        case 'tools/call':
          response = {
            jsonrpc: '2.0', id: msg.id,
            result: {
              content: [{ type: 'text', text: `Привет, ${msg.params?.arguments?.name || 'мир'}!` }]
            }
          };
          break;
        default:
          response = {
            jsonrpc: '2.0', id: msg.id,
            error: { code: -32601, message: `Unknown: ${msg.method}` }
          };
      }

      console.error(`[${new Date().toISOString()}] ${msg.method} id=${msg.id}`);
      const json = JSON.stringify(response);
      const accept = req.headers['accept'] || '';
      if (accept.includes('text/event-stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`id: ${generateEventId()}\ndata: ${json}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(json);
      }
    });
    return;
  }

  res.writeHead(405);
  res.end('Method Not Allowed');
});

server.listen(PORT, '0.0.0.0', () => {
  console.error(`Test MCP server listening on port ${PORT}`);
});
