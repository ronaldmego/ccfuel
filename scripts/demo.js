#!/usr/bin/env node
// `npm run demo` — serve the dashboard on synthetic data so it can be screenshotted or
// recorded without putting real usage on screen.
//
// THE FIXTURE GOES IN A FRESH TEMP DIRECTORY, AND `DASHBOARD_DATA_DIR` IS IGNORED ON PURPOSE.
// This used to default to `DASHBOARD_DATA_DIR || ./demo-data`, which made a documented
// configuration variable destructive: anyone with `DASHBOARD_DATA_DIR` exported for their real
// dashboard — exactly what the README tells them to do — lost their snapshots the first time
// they ran the demo. `buildFixture` writes `usage-curve.json`, `weekly-history.json`,
// `global-usage.json`, `resets-cache.json` and `session-metrics.json` unconditionally, so the
// real files were silently replaced with invented ones. Reproduced before the fix: a sentinel
// `weekly-history.json` came back with a different sha256 and fixture contents.
//
// So the rule is fail-closed and has no opt-out: `mkdtemp` under the OS temp dir, unique per
// run, unreachable from any configured path, removed on the way out. There is deliberately no
// flag to point the demo at a directory of your choosing — the demo is for looking at the UI,
// and nothing about that needs write access to real data.
//
// What this is not: a second product. The normal `node server.js` path is untouched; nothing
// here can make the real dashboard show an invented number, and nothing in the demo can reach
// real data. If you want the real thing, run the real thing.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildFixture } = require('./synthetic-fixture');

const PORT = process.env.DASHBOARD_PORT || '3401'; // not 3400: never collide with a real instance
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const TZ_OFFSET = parseInt(process.env.DASHBOARD_TIMEZONE || '-5', 10);

// Say it out loud rather than ignoring it silently — someone who set this deserves to know the
// demo is not touching it.
if (process.env.DASHBOARD_DATA_DIR) {
  console.log('ℹ️  DASHBOARD_DATA_DIR is set and is being ignored: the demo never writes outside');
  console.log('   its own temp directory. Your real snapshots are not touched.');
}

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfuel-demo-'));

let child = null;
let cleanedUp = false;

// Idempotent: called from normal exit, from either signal, and from a failed spawn.
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGTERM'); } catch (_) { /* already gone */ }
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch (e) {
    console.error(`⚠️  could not remove the demo fixture at ${DATA_DIR}: ${e.message}`);
  }
}

// SIGKILL cannot be handled, so `kill -9` on this process leaves both the temp directory and the
// child server behind — verified, not assumed. That is ordinary Unix behaviour and there is no
// handler that can beat it; what matters is that neither consequence can cost anyone data, since
// the fixture lives under the OS temp dir and no configured directory is ever written. Ctrl-C
// signals the whole process group, so the normal path is covered. After a deliberate `kill -9`,
// clean up with `pkill -f ccfuel/server.js` and remove the printed fixture path.
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });

let summary;
try {
  summary = buildFixture(DATA_DIR, { now: Date.now(), tzOffset: TZ_OFFSET });
} catch (e) {
  console.error(`❌ could not build the demo fixture: ${e.message}`);
  cleanup();
  process.exit(1);
}

console.log('🎬 ccfuel demo — synthetic data, nothing real is read or served');
console.log(`   fixture:  ${DATA_DIR} (temporary, removed on exit)`);
console.log(`   projects: ${summary.projects.join(', ')}`);
console.log(`   ${summary.snapshots} curve snapshots across ${summary.weeks} cycles, `
  + `${summary.sessionFiles} sessions`);
console.log(`   open:     http://${HOST}:${PORT}`);
console.log('   stop:     Ctrl-C\n');

child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DASHBOARD_DEMO: '1',
    // Overrides whatever the caller had exported: the server writes to the temp fixture only.
    DASHBOARD_DATA_DIR: DATA_DIR,
    DASHBOARD_PORT: String(PORT),
    DASHBOARD_HOST: HOST,
    // Belt and braces: demo mode already forces these to 0.
    DASHBOARD_COLLECT_INTERVAL_MIN: '0',
    DASHBOARD_SESSION_SCAN_INTERVAL_MIN: '0'
  }
});

child.on('error', (e) => {
  console.error(`❌ could not start the server: ${e.message}`);
  cleanup();
  process.exit(1);
});

child.on('exit', (code, signal) => {
  cleanup();
  process.exit(signal ? 1 : (code ?? 0));
});
