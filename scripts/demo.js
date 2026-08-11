#!/usr/bin/env node
// `npm run demo` — serve the dashboard on synthetic data so it can be screenshotted or
// recorded without putting real usage on screen.
//
// What this is: a throwaway fixture in `demo-data/` (gitignored) plus the normal server with
// DASHBOARD_DEMO=1, which turns both collectors off — no `claude` PTY spawn, no read of
// ~/.claude/projects — and makes /api/config report `demo: true` so the dashboard paints a
// banner across the top.
//
// What this is not: a second product. The normal `node server.js` path is untouched; nothing
// here can make the real dashboard show an invented number, and nothing in the demo can
// reach real data. If you want the real thing, run the real thing.

const { spawn } = require('child_process');
const path = require('path');
const { buildFixture } = require('./synthetic-fixture');

const DATA_DIR = process.env.DASHBOARD_DATA_DIR || path.join(__dirname, '..', 'demo-data');
const PORT = process.env.DASHBOARD_PORT || '3401'; // not 3400: never collide with a real instance
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const TZ_OFFSET = parseInt(process.env.DASHBOARD_TIMEZONE || '-5', 10);

const summary = buildFixture(DATA_DIR, { now: Date.now(), tzOffset: TZ_OFFSET });

console.log('🎬 ccfuel demo — synthetic data, nothing real is read or served');
console.log(`   fixture:  ${DATA_DIR}`);
console.log(`   projects: ${summary.projects.join(', ')}`);
console.log(`   ${summary.snapshots} curve snapshots across ${summary.weeks} cycles, `
  + `${summary.sessionFiles} sessions`);
console.log(`   open:     http://${HOST}:${PORT}`);
console.log('   stop:     Ctrl-C\n');

const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DASHBOARD_DEMO: '1',
    DASHBOARD_DATA_DIR: DATA_DIR,
    DASHBOARD_PORT: String(PORT),
    DASHBOARD_HOST: HOST,
    // Belt and braces: demo mode already forces these to 0.
    DASHBOARD_COLLECT_INTERVAL_MIN: '0',
    DASHBOARD_SESSION_SCAN_INTERVAL_MIN: '0'
  }
});

const stop = () => { try { child.kill('SIGTERM'); } catch (_) {} };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', code => process.exit(code ?? 0));
