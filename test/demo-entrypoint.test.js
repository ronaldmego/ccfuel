// The `npm run demo` entrypoint, exercised as a user runs it. `node test/demo-entrypoint.test.js`.
//
// WHY THIS EXISTS: the demo used to resolve its fixture directory as
// `DASHBOARD_DATA_DIR || ./demo-data`, and `buildFixture` overwrites a known set of filenames
// inside whatever it is handed. So a user with `DASHBOARD_DATA_DIR` exported for their real
// dashboard — which is what the README tells them to do — silently lost their snapshots the
// first time they ran the demo. Reproduced: a sentinel `weekly-history.json` came back with a
// different sha256 and fixture contents in it.
//
// The existing server smoke could not catch that, and the reason is worth keeping in mind:
// it calls `buildFixture(tmp)` directly, so it tests the library and never the entrypoint that
// chooses the directory. The bug lived entirely in that choice. This test therefore spawns
// `scripts/demo.js` as a child process — the real thing, with a hostile environment — and
// asserts on the filesystem afterwards.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEMO = path.join(__dirname, '..', 'scripts', 'demo.js');

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: ok === true, detail });

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Poll until the demo answers /api/config, or give up. */
async function waitForDemo(port, proc, log, deadlineMs = 25000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`demo exited early (${proc.exitCode})\n${log()}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/config`);
      if (r.ok) return await r.json();
    } catch (_) { /* not up yet */ }
    await sleep(150);
  }
  throw new Error(`demo never answered on :${port}\n${log()}`);
}

async function portClosed(port, deadlineMs = 8000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/config`);
    } catch (_) {
      return true; // refused => nothing listening
    }
    await sleep(150);
  }
  return false;
}

/**
 * Run the demo with a hostile environment and stop it with `signal`.
 * Returns everything needed to assert on afterwards.
 */
async function runDemo(signal) {
  // A directory standing in for the user's real snapshots, with DASHBOARD_DATA_DIR pointed at
  // it — the exact configuration that used to be destructive.
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfuel-real-'));
  const sentinels = {
    'weekly-history.json': JSON.stringify(
      [{ weekId: '2019-01-07', timestamp: '2019-01-14T10:00:00.000Z', weekPercent: 91, dayNum: 7 }]),
    'usage-curve.json': JSON.stringify({ snapshots: [{ timestamp: '2019-01-07T00:00:00.000Z', weekId: '2019-01-07', weekPercent: 12, sessionPercent: 3, elapsedHours: 1, dayNum: 1 }] }),
    'session-metrics.json': JSON.stringify({ version: 2, updatedAt: '2019-01-07T00:00:00.000Z', byFile: {}, scan: null }),
    'resets-cache.json': JSON.stringify({ weekAll: '2019-01-14T15:00:00.000Z' }),
    'global-usage.json': JSON.stringify({ success: true, sentinel: true }),
    'DO-NOT-TOUCH.txt': 'a file the demo has no business writing to\n'
  };
  for (const [name, body] of Object.entries(sentinels)) {
    fs.writeFileSync(path.join(realDir, name), body);
  }
  const before = Object.fromEntries(
    Object.keys(sentinels).map(n => [n, sha(path.join(realDir, n))]));

  // A transcripts root carrying a label that must never surface: if the demo scanned real
  // transcripts, this project name would appear in /api/session-metrics.
  const transcripts = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfuel-tx-'));
  const txProject = path.join(transcripts, '-home-sentinel-projects-MUST-NOT-APPEAR');
  fs.mkdirSync(txProject, { recursive: true });
  fs.writeFileSync(path.join(txProject, 'sentinel-session.jsonl'),
    JSON.stringify({ timestamp: '2026-08-01T10:00:00Z', message: { id: 'sentinel_msg', usage: { output_tokens: 999999, input_tokens: 999999 } } }) + '\n');

  const port = await freePort();
  let log = '';
  const proc = spawn(process.execPath, [DEMO], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DASHBOARD_DATA_DIR: realDir,          // the hostile bit
      DASHBOARD_TRANSCRIPTS_ROOT: transcripts,
      DASHBOARD_PORT: String(port),
      DASHBOARD_HOST: '127.0.0.1'
    }
  });
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });

  const config = await waitForDemo(port, proc, () => log);

  // Everything the running demo can tell us, before it is stopped.
  const sessionMetrics = await (await fetch(`http://127.0.0.1:${port}/api/session-metrics`)).json();
  const globalUsage = await (await fetch(`http://127.0.0.1:${port}/api/global-usage`)).json();
  const refresh = await (await fetch(`http://127.0.0.1:${port}/api/session-metrics/refresh`)).json();

  const fixtureMatch = log.match(/fixture:\s+(\S+)/);
  const fixtureDir = fixtureMatch ? fixtureMatch[1] : null;
  const fixtureExistedWhileRunning = fixtureDir ? fs.existsSync(fixtureDir) : false;

  // Stop it the way a user would, and wait for the parent to actually go.
  const exited = new Promise(resolve => proc.once('exit', (code, sig) => resolve({ code, sig })));
  proc.kill(signal);
  const stopped = await Promise.race([exited, sleep(10000).then(() => null)]);
  await sleep(400); // let the exit handler finish removing the directory

  const after = Object.fromEntries(
    Object.keys(sentinels).map(n => {
      const p = path.join(realDir, n);
      return [n, fs.existsSync(p) ? sha(p) : 'MISSING'];
    }));

  const result = {
    realDir, transcripts, port, log, config, sessionMetrics, globalUsage, refresh,
    fixtureDir, fixtureExistedWhileRunning, before, after, stopped,
    extraFilesInRealDir: fs.readdirSync(realDir).filter(f => !(f in sentinels)),
    fixtureGoneAfterExit: fixtureDir ? !fs.existsSync(fixtureDir) : false,
    portFreed: await portClosed(port)
  };

  fs.rmSync(realDir, { recursive: true, force: true });
  fs.rmSync(transcripts, { recursive: true, force: true });
  return result;
}

async function main() {
  // --- SIGINT: the Ctrl-C path the README tells people to use ---------------------------
  const r = await runDemo('SIGINT');

  check('the demo comes up and reports demo mode', r.config && r.config.demo === true,
    JSON.stringify(r.config));

  // The blocker itself.
  const untouched = Object.keys(r.before).filter(n => r.before[n] === r.after[n]);
  const changed = Object.keys(r.before).filter(n => r.before[n] !== r.after[n]);
  check('every sentinel file in DASHBOARD_DATA_DIR is byte-identical afterwards',
    changed.length === 0,
    changed.length ? `modified: ${changed.map(n => `${n} (${r.after[n] === 'MISSING' ? 'deleted' : 'rewritten'})`).join(', ')}`
                   : `${untouched.length} files intact`);
  check('the demo wrote nothing new into DASHBOARD_DATA_DIR',
    r.extraFilesInRealDir.length === 0, r.extraFilesInRealDir.join(', '));

  // Where it actually served from.
  check('the fixture lives in its own temp directory, not the configured one',
    !!r.fixtureDir
    && path.resolve(r.fixtureDir) !== path.resolve(r.realDir)
    && !path.resolve(r.fixtureDir).startsWith(path.resolve(r.realDir) + path.sep)
    && path.resolve(r.fixtureDir).startsWith(path.resolve(os.tmpdir()))
    && /ccfuel-demo-/.test(r.fixtureDir),
    `fixture=${r.fixtureDir} real=${r.realDir}`);
  check('it says out loud that DASHBOARD_DATA_DIR is being ignored',
    /DASHBOARD_DATA_DIR is set and is being ignored/.test(r.log));
  check('the fixture existed while the demo was running', r.fixtureExistedWhileRunning);

  // No PTY, no transcripts.
  check('no PTY fetch was attempted',
    !/Fetching global usage|Auto-collector running|usage fetch/i.test(r.log)
    && /Auto-collector disabled/.test(r.log),
    'log must show the collector disabled and no fetch');
  check('the gauge is served from the fixture, flagged as demo',
    r.globalUsage.demo === true && r.globalUsage.success === true);
  check('transcripts were never scanned',
    /Session scan disabled/.test(r.log)
    && !JSON.stringify(r.sessionMetrics).includes('MUST-NOT-APPEAR')
    && !r.log.includes('MUST-NOT-APPEAR'),
    'the sentinel transcript label must appear nowhere');
  check('an on-demand rescan is refused in demo mode',
    r.refresh.ok === false && r.refresh.demo === true);
  check('the panel shows the synthetic projects',
    (r.sessionMetrics.byProject || []).length > 0
    && r.sessionMetrics.byProject.every(p => p.label.startsWith('demo-')),
    (r.sessionMetrics.byProject || []).map(p => p.label).join(','));

  // Lifecycle.
  check('SIGINT removes the temp fixture', r.fixtureGoneAfterExit, r.fixtureDir);
  check('SIGINT leaves no orphan server holding the port', r.portFreed);
  check('the parent exits on SIGINT rather than hanging', r.stopped !== null,
    JSON.stringify(r.stopped));

  // --- SIGTERM: same guarantees on the other signal ------------------------------------
  const t = await runDemo('SIGTERM');
  const tChanged = Object.keys(t.before).filter(n => t.before[n] !== t.after[n]);
  check('SIGTERM run also leaves DASHBOARD_DATA_DIR untouched', tChanged.length === 0,
    tChanged.join(', '));
  check('SIGTERM removes the temp fixture', t.fixtureGoneAfterExit, t.fixtureDir);
  check('SIGTERM leaves no orphan server holding the port', t.portFreed);

  report();
}

function report() {
  let passed = 0;
  for (const x of results) {
    console.log(`  ${x.ok ? 'ok  ' : 'FAIL'}   ${x.name}${x.detail && !x.ok ? `  — ${x.detail}` : ''}`);
    if (x.ok) passed++;
  }
  console.log(`\n${passed}/${results.length} passed`);
  assert.strictEqual(passed, results.length, 'demo entrypoint test failed');
}

main().catch(e => { console.error(e); process.exit(1); });
