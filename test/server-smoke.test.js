// Boots the real server and asserts its HTTP surface. `node test/server-smoke.test.js`.
//
// WHY A CHILD PROCESS AND NOT AN IMPORT: the failure this exists to catch is a *startup*
// failure. `npm ci` installed Express only, so `node server.js` died on
// `require('node-pty')` — while CI stayed green, because `node --check` never resolves a
// require and the rest of the suite only touches pure functions. Nothing short of actually
// running `node server.js` catches that class.
//
// It runs against the synthetic fixture in DASHBOARD_DEMO mode, in a temp data directory, so
// it is deterministic and it never reads ~/.claude or writes into the checkout's `data/`.

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { buildFixture } = require('../scripts/synthetic-fixture');

const SERVER = path.join(__dirname, '..', 'server.js');
const TZ = -5;

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: ok === true, detail });

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

/** Start server.js and wait until it answers, or reject with everything it printed. */
async function startServer(env, port) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env, DASHBOARD_PORT: String(port), DASHBOARD_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with code ${child.exitCode}\n--- output ---\n${log}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/config`);
      if (r.ok) return { child, log: () => log };
    } catch (_) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  try { child.kill('SIGKILL'); } catch (_) {}
  throw new Error(`server never answered on :${port}\n--- output ---\n${log}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    child.once('exit', resolve);
    try { child.kill('SIGTERM'); } catch (_) { resolve(); }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(); }, 3000);
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfuel-smoke-'));
  const dataDir = path.join(tmp, 'data');
  const emptyTranscripts = path.join(tmp, 'no-transcripts');
  fs.mkdirSync(emptyTranscripts, { recursive: true });

  const now = Date.now();
  const fx = buildFixture(dataDir, { now, tzOffset: TZ });

  // ---- part 1: demo-mode server over the synthetic fixture -----------------------------
  const port = await freePort();
  let started;
  try {
    started = await startServer({
      DASHBOARD_DEMO: '1',
      DASHBOARD_DATA_DIR: dataDir,
      DASHBOARD_TIMEZONE: String(TZ),
      DASHBOARD_TRANSCRIPTS_ROOT: emptyTranscripts
    }, port);
    check('server.js boots from a clean install (no MODULE_NOT_FOUND)', true);
  } catch (e) {
    check('server.js boots from a clean install (no MODULE_NOT_FOUND)', false, e.message);
    report();
    return;
  }

  const base = `http://127.0.0.1:${port}`;
  const get = async (p) => {
    const r = await fetch(base + p);
    return { status: r.status, body: await r.json() };
  };

  try {
    const html = await fetch(base + '/');
    const text = await html.text();
    check('GET / serves the dashboard', html.status === 200 && text.includes('ccfuel'));
    check('the demo banner markup is present for capture mode', text.includes('demo-banner'));

    const cfg = await get('/api/config');
    check('/api/config reports the configured offset and demo flag',
      cfg.body.tzOffset === TZ && cfg.body.demo === true,
      JSON.stringify(cfg.body));

    const gu = await get('/api/global-usage');
    check('/api/global-usage serves the fixture, flagged as demo',
      gu.status === 200 && gu.body.demo === true && gu.body.success === true
      && gu.body.weekAll.percent === fx.weekAllPercent,
      `weekAll=${gu.body?.weekAll?.percent} expected=${fx.weekAllPercent}`);
    check('/api/global-usage never serves the raw PTY buffer',
      !('rawClean' in gu.body));
    check('demo mode did not spawn a PTY fetch',
      !started.log().includes('Fetching global usage') && started.log().includes('DEMO MODE'));

    const sm = await get('/api/session-metrics');
    check('/api/session-metrics totals match the fixture above the cut',
      sm.body.totals.fuel === fx.fuelAboveCut && sm.body.totals.sessions === fx.sessionsAboveCut,
      `fuel=${sm.body.totals.fuel}/${fx.fuelAboveCut} sessions=${sm.body.totals.sessions}/${fx.sessionsAboveCut}`);
    check('the fuel cut is reported rather than silently dropped',
      sm.body.totals.belowCutFuel === fx.fuelBelowCut && sm.body.totals.sessionsBelowCut === 2,
      `belowCut=${sm.body.totals.belowCutFuel}/${fx.fuelBelowCut}`);
    check('project shares add up to ~100%',
      Math.abs(sm.body.byProject.reduce((a, p) => a + p.share, 0) - 100) < 0.5);

    // Privacy: the payload may only carry the aggregate fields. A regression that started
    // serving transcript content would show up here as an unexpected key.
    const allowed = new Set(['id', 'label', 'start', 'end', 'hours', 'turns', 'fuel', 'share']);
    const extraKeys = sm.body.topSessions.flatMap(s => Object.keys(s).filter(k => !allowed.has(k)));
    check('top sessions expose only aggregate fields (no message content)',
      extraKeys.length === 0, extraKeys.join(','));

    const deltas = await get('/api/usage-deltas');
    // Cross-check: the fixture derives its weekIds from the reset anchor with the same
    // formula the server uses. If either side drifts, this is where it shows.
    check('/api/usage-deltas agrees with the fixture on the current cycle',
      deltas.body.currentWeekId === fx.currentWeekId,
      `server=${deltas.body.currentWeekId} fixture=${fx.currentWeekId}`);
    check('/api/usage-deltas saw every snapshot',
      deltas.body.meta.total === fx.snapshots,
      `${deltas.body.meta.total}/${fx.snapshots}`);
    check('/api/usage-deltas produces daily, hourly and a 7x24 heatmap',
      deltas.body.daily.length > 0 && deltas.body.hourly.length > 0
      && deltas.body.heatmap.length === 7 && deltas.body.heatmap[0].length === 24);
    check('a burn rate and a projection are derived',
      deltas.body.currentRate.perHour > 0 && deltas.body.projection.hoursLeft !== null);

    const wh = await get('/api/weekly-history');
    check('/api/weekly-history returns every cycle in the fixture',
      wh.body.history.length === fx.weeks, `${wh.body.history.length}/${fx.weeks}`);
    // The fixture deliberately runs an older cycle out of quota, so the enrichment that
    // resolves "when did it hit 100%" and "how long was it locked out" is exercised too.
    const exhausted = wh.body.history.filter(h => h.weekPercent >= 100);
    check('a cycle that hit 100% reports when, and how many hours were lost',
      exhausted.length > 0
      && exhausted.every(h => h.hitsAt100Hours > 0 && h.offlineHours >= 0 && h.hitsAt100Day >= 1),
      `${exhausted.length} exhausted cycle(s): ${JSON.stringify(exhausted.map(h => [h.hitsAt100Hours, h.offlineHours]))}`);

    const refresh = await get('/api/session-metrics/refresh');
    check('demo mode refuses to rescan transcripts on demand',
      refresh.body.ok === false && refresh.body.demo === true);
  } finally {
    await stopServer(started.child);
  }

  // ---- part 2: a missing data directory is created, not an ENOENT -----------------------
  // The original symptom: a clean clone has no `data/`, so the first snapshot write failed
  // with "Failed to persist session metrics: ENOENT". Collectors are off here so the boot
  // stays offline; what is under test is the directory, not the fetch.
  const freshDir = path.join(tmp, 'nested', 'created', 'on', 'boot');
  const port2 = await freePort();
  let started2;
  try {
    started2 = await startServer({
      DASHBOARD_DATA_DIR: freshDir,
      DASHBOARD_COLLECT_INTERVAL_MIN: '0',
      DASHBOARD_SESSION_SCAN_INTERVAL_MIN: '0',
      DASHBOARD_TRANSCRIPTS_ROOT: emptyTranscripts
    }, port2);
    check('a missing data directory is created on boot (the ENOENT regression)',
      fs.existsSync(freshDir));
    check('the server is usable with an empty data directory',
      (await (await fetch(`http://127.0.0.1:${port2}/api/weekly-history`)).json()).history.length === 0);
    check('the collectors stay off when their cadence is 0',
      started2.log().includes('Auto-collector disabled')
      && started2.log().includes('Session scan disabled'));
  } catch (e) {
    check('a missing data directory is created on boot (the ENOENT regression)', false, e.message);
  } finally {
    await stopServer(started2 && started2.child);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  report();
}

function report() {
  let passed = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}   ${r.name}${!r.ok && r.detail ? `  — ${r.detail}` : ''}`);
    if (r.ok) passed++;
  }
  console.log(`\n${passed}/${results.length} passed`);
  assert.strictEqual(passed, results.length, 'server smoke failed');
}

main().catch(e => { console.error(e); process.exit(1); });
