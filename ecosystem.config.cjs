module.exports = {
  apps: [{
    name: 'token-dashboard',
    script: 'server.js',
    cwd: '/home/adminmgo/projects/dashboards/claude-code-usage-dashboard',
    env: {
      DASHBOARD_HOST: '100.64.216.28',
      PORT: 3400,
      // Server-side auto-collector cadence in minutes (0 disables it)
      DASHBOARD_COLLECT_INTERVAL_MIN: 10
    }
  }]
};
