module.exports = {
  apps: [{
    name: 'token-dashboard',
    script: 'server.js',
    cwd: '/home/adminmgo/projects/dashboards/claude-code-usage-dashboard',
    env: {
      DASHBOARD_HOST: '100.64.216.28',
      PORT: 3400
    }
  }]
};
