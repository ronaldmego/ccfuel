// Synthetic dataset for capture mode and the server smoke test.
//
// One generator, two consumers, on purpose:
//   - `npm run demo` serves it so the UI can be screenshotted without exposing real usage;
//   - test/server-smoke.test.js serves the same shapes so the HTTP surface is asserted
//     against known numbers instead of whatever happens to be on the developer's disk.
//
// Everything here is invented. Labels are `demo-*`, percentages are round made-up figures,
// and no file is ever read from ~/.claude — a capture taken from this cannot leak a project
// name, a path or a real quota number. Given the same `now` it produces byte-identical
// output (seeded PRNG, no Math.random), which is what makes the smoke deterministic.

const fs = require('fs');
const path = require('path');
const sessionMetrics = require('../session-metrics');

const HOUR = 3600000;
const DAY = 24 * HOUR;

// Small deterministic PRNG (mulberry32) — shapes the burn so the charts and heatmap have
// texture, without making the fixture depend on Math.random.
function prng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Mirror of `getWeekCycleInfo()` in server.js, for the one thing the fixture cannot invent:
 * the cycle boundaries the server will derive from the reset anchor. If these two ever
 * disagree the smoke fails on `currentWeekId`, which is the point of duplicating it here.
 */
function cycleInfoFor(atMs, resetsAtMs, tzOffset) {
  const localNow = atMs + tzOffset * HOUR;
  const nextResetLocal = resetsAtMs + tzOffset * HOUR;

  // Walk back in whole cycles until the reset is the one that closes the cycle holding atMs.
  let cycleEnd = nextResetLocal;
  let cyclesAgo = 0;
  while (cycleEnd - 7 * DAY > localNow) { cycleEnd -= 7 * DAY; cyclesAgo++; }
  const cycleStart = cycleEnd - 7 * DAY;

  const elapsedDays = (localNow - cycleStart) / DAY;
  return {
    weekId: new Date(cycleStart).toISOString().split('T')[0],
    elapsedHours: Math.round((elapsedDays * 24) * 100) / 100,
    dayNum: Math.min(Math.ceil(elapsedDays), 7),
    cyclesAgo
  };
}

const PROJECTS = [
  { label: 'demo-api', weight: 0.42 },
  { label: 'demo-web', weight: 0.28 },
  { label: 'demo-infra', weight: 0.19 },
  { label: 'demo-notebooks', weight: 0.11 }
];

/**
 * Build the whole `data/` payload.
 *
 * @param {string} dir   destination directory (created if missing)
 * @param {object} opts
 * @param {number} opts.now       epoch ms treated as "current time"
 * @param {number} opts.tzOffset  UTC offset the server will run with
 * @returns {object} the numbers a caller can assert against
 */
function buildFixture(dir, { now, tzOffset = -5 } = {}) {
  if (now == null) throw new Error('buildFixture requires an explicit `now`');
  fs.mkdirSync(dir, { recursive: true });

  // The gauge anchor. Two days out, so the current cycle is mid-flight and every window
  // (cycle / 48h / 14d) has data in it.
  const resetsAtMs = now + 2 * DAY;
  const current = cycleInfoFor(now, resetsAtMs, tzOffset);

  // --- usage curve: 30-minute snapshots over three whole cycles plus the current one -----
  // Monotonic within a cycle (a drop >3pp is treated as an anomaly and filtered), heavier
  // during local working hours so the heatmap is not a flat block.
  //
  // Starting on a cycle boundary rather than "N days ago" matters for the capture: a partial
  // oldest cycle shows up in Weekly history as a finished 7/7 week at a low percentage, which
  // reads as a bug to anyone watching. ~0.55pp per active half-hour lands a full cycle in the
  // 80s, so the history has range in it instead of a column of 100s.
  const rand = prng(0x9E3779B9);
  const snapshots = [];
  const perCyclePeak = {}; // weekId -> last percent emitted
  const STEP = 30 * 60 * 1000;
  const START = resetsAtMs - 4 * 7 * DAY;

  for (let t = START; t <= now; t += STEP) {
    const info = cycleInfoFor(t, resetsAtMs, tzOffset);
    const localHour = new Date(t + tzOffset * HOUR).getUTCHours();

    // Older cycles burn hotter, so the oldest one runs the quota out before its reset. That
    // is the state worth showing — the history row then reports when 100% was hit and how
    // many hours were spent locked out, which is the whole argument for watching the gauge.
    const heat = 1 + 0.16 * info.cyclesAgo;
    const active = localHour >= 9 && localHour < 20;
    const burst = active ? (0.2 + rand() * 0.7) * heat : rand() * 0.04;

    const prev = perCyclePeak[info.weekId] ?? 2; // never start at 0: leading zeros are skipped
    const next = Math.min(100, prev + burst);
    perCyclePeak[info.weekId] = next;

    snapshots.push({
      timestamp: new Date(t).toISOString(),
      weekId: info.weekId,
      weekPercent: Math.round(next),
      sessionPercent: active ? Math.round(20 + rand() * 70) : Math.round(rand() * 15),
      elapsedHours: info.elapsedHours,
      dayNum: info.dayNum
    });
  }

  fs.writeFileSync(path.join(dir, 'usage-curve.json'),
    JSON.stringify({ snapshots }, null, 2));

  // --- weekly history: the closing value of each cycle in the curve -----------------
  const closing = {};
  for (const s of snapshots) closing[s.weekId] = s;
  const history = Object.values(closing)
    .map(s => ({
      weekId: s.weekId,
      timestamp: s.timestamp,
      weekPercent: s.weekPercent,
      dayNum: s.dayNum
    }))
    .sort((a, b) => b.weekId.localeCompare(a.weekId));

  fs.writeFileSync(path.join(dir, 'weekly-history.json'), JSON.stringify(history, null, 2));

  // --- live gauge fixture (demo mode only reads this) -------------------------------
  const currentPercent = Math.round(perCyclePeak[current.weekId]);
  const globalUsage = {
    success: true,
    timestamp: new Date(now).toISOString(),
    session: {
      percent: 41,
      resetsAtHour: new Date(now + 3 * HOUR + tzOffset * HOUR).getUTCHours(),
      resetsAt: new Date(now + 3 * HOUR).toISOString()
    },
    weekAll: {
      percent: currentPercent,
      resetsAtHour: new Date(resetsAtMs + tzOffset * HOUR).getUTCHours(),
      resetsAt: new Date(resetsAtMs).toISOString()
    },
    weekSonnet: {
      percent: Math.max(0, Math.round(currentPercent * 0.35)),
      resetsAtHour: new Date(resetsAtMs + tzOffset * HOUR).getUTCHours(),
      resetsAt: new Date(resetsAtMs).toISOString()
    },
    extraUsage: { enabled: false, freeAvailable: 0 }
  };
  fs.writeFileSync(path.join(dir, 'global-usage.json'), JSON.stringify(globalUsage, null, 2));

  // The reset anchor the server would have persisted, so the cycle window is right from the
  // first request instead of falling back to the reset-hour heuristic.
  fs.writeFileSync(path.join(dir, 'resets-cache.json'), JSON.stringify({
    weekAll: globalUsage.weekAll.resetsAt,
    weekSonnet: globalUsage.weekSonnet.resetsAt
  }, null, 2));

  // --- per-session fuel ("What burned it") ------------------------------------------
  // Records carry exactly the fields the real collector produces — no message text, because
  // the real collector never reads any. Two sessions sit under the fuel cut so the panel's
  // "hidden by the cut" line has something to report.
  const sessionRand = prng(0x85EBCA6B);
  const byFile = {};
  let aboveCutFuel = 0, aboveCutCount = 0, belowCutFuel = 0;

  const mkSession = (i, label, endMs, fuel, hours) => {
    const id = `demo-session-${String(i).padStart(2, '0')}`;
    const file = path.join('/demo/transcripts', `-demo-${label}`, `${id}.jsonl`);
    byFile[file] = {
      v: sessionMetrics.SCHEMA_VERSION,
      id,
      project: `-demo-${label}`,
      label,
      mtimeMs: endMs,
      size: 1024 * (i + 1),
      start: new Date(endMs - hours * HOUR).toISOString(),
      end: new Date(endMs).toISOString(),
      hours: Math.round(hours * 100) / 100,
      turns: 12 + i * 3,
      events: 400 + i * 25,
      fuel
    };
    if (fuel >= sessionMetrics.DEFAULT_MIN_FUEL) { aboveCutFuel += fuel; aboveCutCount++; }
    else belowCutFuel += fuel;
  };

  let idx = 0;
  for (const p of PROJECTS) {
    const sessions = 3;
    for (let k = 0; k < sessions; k++) {
      // Spread inside the current cycle — which started 5 days ago, since the reset anchor
      // is 2 days out — so `window=cycle` (the panel's default) holds all of them.
      const endMs = now - Math.floor(sessionRand() * 4 * DAY) - k * HOUR;
      const fuel = Math.round(p.weight * (900000 + sessionRand() * 1500000) / sessions);
      mkSession(idx++, p.label, endMs, fuel, 0.8 + sessionRand() * 6);
    }
  }
  // Below the cut: an aborted start and a one-shot run.
  mkSession(idx++, 'demo-scratch', now - 6 * HOUR, 1800, 0.05);
  mkSession(idx++, 'demo-scratch', now - 30 * HOUR, 4200, 0.12);

  fs.writeFileSync(path.join(dir, 'session-metrics.json'), JSON.stringify({
    version: sessionMetrics.SCHEMA_VERSION,
    updatedAt: new Date(now).toISOString(),
    byFile,
    scan: {
      files: Object.keys(byFile).length,
      rescanned: Object.keys(byFile).length,
      reused: 0,
      durationMs: 1234
    }
  }));

  return {
    dir,
    tzOffset,
    now,
    currentWeekId: current.weekId,
    weekAllPercent: currentPercent,
    sessionPercent: globalUsage.session.percent,
    snapshots: snapshots.length,
    weeks: history.length,
    sessionFiles: Object.keys(byFile).length,
    sessionsAboveCut: aboveCutCount,
    fuelAboveCut: aboveCutFuel,
    fuelBelowCut: belowCutFuel,
    projects: PROJECTS.map(p => p.label)
  };
}

module.exports = { buildFixture, cycleInfoFor };
