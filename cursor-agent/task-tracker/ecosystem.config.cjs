/**
 * PM2: pm2 start ecosystem.config.cjs && pm2 save
 * REST API: http://127.0.0.1:3100/api/...
 * Логи: pm2 logs task-tracker-http
 */
module.exports = {
  apps: [
    {
      name: 'task-tracker-http',
      script: 'http-server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      interpreter: '/usr/bin/node',
      watch: false,
      autorestart: true,
      max_memory_restart: '128M',
      env: {
        NODE_ENV: 'production',
        TT_PORT: 3100,
        TT_WEBHOOK_URL: 'http://127.0.0.1:9080/hook',
        TT_WEBHOOK_ASSIGNEE: 'AI_Agent',
        // TT_WEBHOOK_AUTH: 'Bearer ...',  // only if Cursor cloud webhook; not needed for LAN
        // TT_WEBHOOK_ENABLED: '0',
      },
    },
  ],
};
