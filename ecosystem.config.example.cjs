// PM2 ecosystem template for running ccfuel in the background.
// Copy to `ecosystem.config.cjs` and adjust to your machine:
//   cp ecosystem.config.example.cjs ecosystem.config.cjs
//   pm2 start ecosystem.config.cjs
//
// All runtime config is read from the environment (see .env.example). The app
// binds to DASHBOARD_HOST (default 127.0.0.1) — only change it if you knowingly
// want to expose the dashboard on a private network (e.g. a VPN address).
module.exports = {
  apps: [{
    name: 'ccfuel',
    script: 'server.js',
    cwd: __dirname,
    // Defensive hygiene for the long-lived parent process:
    // recycle if memory creeps up, plus a daily restart in a low-traffic window.
    max_memory_restart: '250M',
    cron_restart: '0 4 * * *',
    env: {
      DASHBOARD_HOST: '127.0.0.1',
      DASHBOARD_PORT: 3400,
      // Server-side auto-collector cadence in minutes (0 disables it)
      DASHBOARD_COLLECT_INTERVAL_MIN: 10
    }
  }]
};
