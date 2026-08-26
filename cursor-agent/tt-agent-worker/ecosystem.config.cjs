/**
 * PM2: pm2 start ecosystem.config.cjs && pm2 save
 * Health: curl -s http://127.0.0.1:9080/health
 */
module.exports = {
  apps: [
    {
      name: 'tt-agent-worker',
      script: 'src/server.js',
      cwd: __dirname,
      interpreter: '/home/pi/.nvm/versions/node/v20.20.2/bin/node',
      interpreter_args: '--max-old-space-size=192',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '220M',
      kill_timeout: 8000,
      env: {
        NODE_ENV: 'production',
        // Prefer secrets in .env (loaded by src/config.js). Optional overrides:
        // CURSOR_API_KEY: '',
        TT_WORKER_HOST: '127.0.0.1',
        TT_WORKER_PORT: '9080',
        TT_WORKER_MAX_QUEUE: '2',
        TT_WORKER_MIN_MEM_KB: '184320',
      },
    },
  ],
};
