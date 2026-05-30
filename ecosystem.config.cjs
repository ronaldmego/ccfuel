module.exports = {
  apps: [{
    name: 'token-dashboard',
    script: 'server.js',
    cwd: '/home/adminmgo/projects/dashboards/claude-code-usage-dashboard',
    // Defensive hygiene for the long-lived parent process (#26):
    // recycle if RSS creeps up, plus a daily restart in the low-traffic window.
    // The auto-collector's overlap guard (globalUsageCache.fetching) means a
    // restart never leaves overlapping PTY sessions; boot re-primes ~5s later.
    max_memory_restart: '250M',
    cron_restart: '0 4 * * *',
    env: {
      DASHBOARD_HOST: '100.64.216.28',
      PORT: 3400,
      // Server-side auto-collector cadence in minutes (0 disables it)
      DASHBOARD_COLLECT_INTERVAL_MIN: 10
    }
  }]
};
