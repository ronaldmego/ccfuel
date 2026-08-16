const express = require('express');
const path = require('path');
const fs = require('fs');
const { getClaudeUsage } = require('./claude-usage');
const { isPlausibleWeeklyReset } = require('./reset-cycle');
const sessionMetrics = require('./session-metrics');

const app = express();

const PORT = process.env.DASHBOARD_PORT || 3400;
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const TZ_OFFSET = parseInt(process.env.DASHBOARD_TIMEZONE || '-5', 10);

// Capture/smoke mode. Serves whatever is already in DATA_DIR and collects nothing: no PTY
// spawn, no transcript read. It exists so the UI can be screenshotted and so the server
// smoke test is deterministic — never to make the normal mode show invented numbers. The
// flag is echoed by /api/config and the dashboard paints a banner, so a capture taken in
// this mode cannot be mistaken for production data.
const DEMO = process.env.DASHBOARD_DEMO === '1';

// Snapshots live outside the code tree so a capture run, a test and the real dashboard can
// each keep their own. Created on boot: a fresh clone has no `data/`, and every writer here
// used to fail with ENOENT until someone made the directory by hand.
const DATA_DIR = process.env.DASHBOARD_DATA_DIR
  ? path.resolve(process.env.DASHBOARD_DATA_DIR)
  : path.join(__dirname, 'data');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error(`❌ Cannot create data directory ${DATA_DIR}: ${e.message}`);
  process.exit(1);
}

// Auto-collector cadence (minutes). 0 disables the in-process scheduler.
const COLLECT_INTERVAL_MIN = DEMO
  ? 0
  : parseInt(process.env.DASHBOARD_COLLECT_INTERVAL_MIN || '20', 10);
const WEEKLY_HISTORY_FILE = path.join(DATA_DIR, 'weekly-history.json');
const USAGE_CURVE_FILE = path.join(DATA_DIR, 'usage-curve.json');
// Only read in demo mode, where there is no PTY to produce a live gauge.
const GLOBAL_USAGE_FILE = path.join(DATA_DIR, 'global-usage.json');

// Per-session fuel from local transcripts (#39). Independent of the /usage collector:
// different source, different cadence, and it must never block a PTY fetch.
const SESSION_METRICS_FILE = path.join(DATA_DIR, 'session-metrics.json');
const TRANSCRIPTS_ROOT = process.env.DASHBOARD_TRANSCRIPTS_ROOT
  || path.join(require('os').homedir(), '.claude', 'projects');
const SESSION_SCAN_INTERVAL_MIN = DEMO
  ? 0
  : parseInt(process.env.DASHBOARD_SESSION_SCAN_INTERVAL_MIN || '30', 10);
const SESSION_MIN_FUEL = parseInt(
  process.env.DASHBOARD_SESSION_MIN_FUEL || String(sessionMetrics.DEFAULT_MIN_FUEL), 10);

// Cache for global usage (Claude /usage command)
let globalUsageCache = {
  data: null,
  lastUpdate: null,
  fetching: false
};

// Persisted reset dates — PTY parsing is unreliable, so we keep the last
// successfully parsed resetsAt values and reuse them when parsing fails.
const RESETS_CACHE_FILE = path.join(DATA_DIR, 'resets-cache.json');
let persistedResets = { session: null, weekAll: null, weekSonnet: null };
try {
  if (fs.existsSync(RESETS_CACHE_FILE)) {
    persistedResets = JSON.parse(fs.readFileSync(RESETS_CACHE_FILE, 'utf8'));
  }
} catch (e) { /* ignore */ }

function updatePersistedResets(usage) {
  let changed = false;
  // Only persist weekAll and weekSonnet resets — session reset parsing is unreliable
  // because ANSI cursor codes corrupt short times like "2am" (no month/day context to anchor)
  for (const key of ['weekAll', 'weekSonnet']) {
    const fresh = usage[key]?.resetsAt;

    if (fresh && isPlausibleWeeklyReset(fresh, persistedResets[key])) {
      persistedResets[key] = fresh;
      changed = true;
    } else if (persistedResets[key] && new Date(persistedResets[key]) > new Date()) {
      // Either the PTY failed to parse, or it parsed a value that contradicts the known
      // cycle. Both are unusable — keep the anchor and inject it so weekId stays stable.
      if (fresh) {
        console.warn(`⚠️  [reset] ${key} read ${fresh} but the cycle anchor is `
          + `${persistedResets[key]} — rejecting as a misparse (#37)`);
      }
      if (usage[key]) usage[key].resetsAt = persistedResets[key];
    } else if (fresh && usage[key]) {
      // Implausible read and no usable anchor: drop it rather than derive weekId from a
      // date we've already proven impossible — the resetsAtHour fallback is less wrong.
      console.warn(`⚠️  [reset] ${key} read ${fresh} is outside the weekly cycle and there `
        + 'is no valid anchor — discarding it (#37)');
      usage[key].resetsAt = null;
    }
  }
  // Clear session from persisted cache — it's unreliable
  if (persistedResets.session) {
    delete persistedResets.session;
    changed = true;
  }
  if (changed) {
    try { fs.writeFileSync(RESETS_CACHE_FILE, JSON.stringify(persistedResets, null, 2)); } catch (e) { /* ignore */ }
  }
}

// Weekly history helpers — uses Claude's actual reset cycle
function getWeekCycleInfo() {
  const now = new Date();
  const localMs = now.getTime() + (TZ_OFFSET * 60 * 60 * 1000);
  const localNow = new Date(localMs);

  let nextReset;
  // Prefer the live read, then the persisted cycle anchor. Without the anchor, every
  // caller between boot and the first successful /usage fetch — the first curve snapshot,
  // the session-fuel cycle window — derives weekId from the crude hour heuristic below,
  // which lands days off. The anchor is already on disk; use it. See #37, #39.
  const weeklyResetsAt = globalUsageCache.data?.weekAll?.resetsAt
    || (persistedResets.weekAll && new Date(persistedResets.weekAll) > now ? persistedResets.weekAll : null);

  if (weeklyResetsAt) {
    nextReset = new Date(new Date(weeklyResetsAt).getTime() + (TZ_OFFSET * 60 * 60 * 1000));
  } else {
    // Fallback: estimate using reset hour (only accurate on day before reset)
    const resetHour = globalUsageCache.data?.weekAll?.resetsAtHour ?? 10;
    nextReset = new Date(localNow);
    nextReset.setUTCHours(resetHour, 0, 0, 0);
    if (localNow >= nextReset) {
      nextReset.setUTCDate(nextReset.getUTCDate() + 1);
    }
  }

  // Cycle start = next reset - 7 days
  const cycleStart = new Date(nextReset);
  cycleStart.setUTCDate(cycleStart.getUTCDate() - 7);

  const elapsedMs = localNow - cycleStart;
  const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
  const dayNum = Math.min(Math.ceil(elapsedDays), 7);

  return {
    dayNum,
    elapsedDays,
    // NOTE: cycleStartISO lives in the TZ_OFFSET-shifted space this function works in —
    // it is what weekId is cut from, not a real instant. Anything comparing against real
    // UTC timestamps (e.g. transcript times) must use cycleStartUTC instead.
    cycleStartISO: cycleStart.toISOString(),
    cycleStartUTC: new Date(cycleStart.getTime() - (TZ_OFFSET * 60 * 60 * 1000)).toISOString(),
    weekId: cycleStart.toISOString().split('T')[0]
  };
}

function getWeekDayNumber() {
  return getWeekCycleInfo().dayNum;
}

function getWeekStartDate() {
  return getWeekCycleInfo().weekId;
}

function saveWeeklySnapshot(weekPercent) {
  const weekId = getWeekStartDate();
  const dayNum = getWeekDayNumber();

  // Load or create history
  let history = [];
  if (fs.existsSync(WEEKLY_HISTORY_FILE)) {
    try { history = JSON.parse(fs.readFileSync(WEEKLY_HISTORY_FILE, 'utf8')); } catch (e) {}
  }

  const entry = {
    weekId,
    timestamp: new Date().toISOString(),
    weekPercent,
    dayNum
  };

  const existingIdx = history.findIndex(h => h.weekId === weekId);
  if (existingIdx >= 0) {
    const existing = history[existingIdx];
    // Never downgrade weekPercent — protects against post-reset overwrites
    if (weekPercent < existing.weekPercent) {
      console.log(`📊 Weekly snapshot SKIPPED: week ${weekId}, ${weekPercent}% < existing ${existing.weekPercent}% (protecting closing value)`);
      return;
    }
    history[existingIdx] = entry;
  } else {
    history.push(entry);
  }

  // Keep last 12 weeks
  history = history.sort((a, b) => b.weekId.localeCompare(a.weekId)).slice(0, 12);
  fs.writeFileSync(WEEKLY_HISTORY_FILE, JSON.stringify(history, null, 2));
  console.log(`📊 Weekly snapshot saved: week ${weekId}, ${weekPercent}%`);
}

function saveUsageCurveSnapshot(usage) {
  if (usage?.weekAll?.percent == null) return; // unparsed weekly % => not a real snapshot (#35)

  const weekPercent = usage.weekAll.percent;
  const sessionPercent = usage.session?.percent ?? null;
  const cycleInfo = getWeekCycleInfo();

  const snapshot = {
    timestamp: new Date().toISOString(),
    weekId: cycleInfo.weekId,
    weekPercent,
    sessionPercent,
    elapsedHours: Math.round(cycleInfo.elapsedDays * 24 * 100) / 100,
    dayNum: cycleInfo.dayNum
  };

  let data = { snapshots: [] };
  try {
    if (fs.existsSync(USAGE_CURVE_FILE)) {
      data = JSON.parse(fs.readFileSync(USAGE_CURVE_FILE, 'utf8'));
    }
  } catch (e) { /* start fresh */ }

  data.snapshots.push(snapshot);

  // Prune: keep last 28 days only
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 28);
  data.snapshots = data.snapshots.filter(s => new Date(s.timestamp) >= cutoff);

  fs.writeFileSync(USAGE_CURVE_FILE, JSON.stringify(data, null, 2));
  // Invalidate deltas cache so next request recomputes
  usageDeltasCache.lastUpdate = null;

  console.log(`📈 Usage curve snapshot: ${weekPercent}% week, ${sessionPercent}% session, day ${cycleInfo.dayNum}`);
}

// === Usage Deltas: derive consumption from % snapshots ===

let usageDeltasCache = { data: null, lastUpdate: null };

const DROP_THRESHOLD = 3;   // % drop within a week treated as anomalous (PTY jitter band)
const SUSTAIN_COUNT = 3;    // consecutive low readings (~30 min) => real level shift, not jitter

function filterAnomalies(snapshots) {
  const filtered = [];
  let lastValid = null;

  // A drop at `idx` is a transient glitch (single bad /usage read) if the depressed
  // level does NOT persist for SUSTAIN_COUNT same-week readings — it recovers near the
  // baseline soon. If it DOES persist, the weekPercent genuinely shifted down (the cycle
  // can be non-monotonic, e.g. a /usage reset/dip), so we re-baseline instead of freezing
  // at the prior peak and discarding the rest of the week. See issue #28.
  const isSustainedShift = (idx, baseline, weekId) => {
    let n = 0;
    for (let j = idx; j < snapshots.length && n < SUSTAIN_COUNT; j++) {
      const s = snapshots[j];
      if (s.weekId !== weekId) break;
      if (s.weekPercent >= baseline - DROP_THRESHOLD) return false; // recovered => jitter
      n++;
    }
    return n >= SUSTAIN_COUNT;
  };

  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];

    if (!lastValid) {
      if (s.weekPercent === 0) continue; // skip leading PTY-failure zeros
      filtered.push(s);
      lastValid = s;
      continue;
    }

    // weekId going backwards is always jitter
    if (s.weekId < lastValid.weekId) continue;

    // New week => cycle reset, always accept
    if (s.weekId !== lastValid.weekId) {
      filtered.push(s);
      lastValid = s;
      continue;
    }

    // Same week: guard anomalous drops (incl. PTY-failure 0%). Skip only if transient;
    // re-baseline (fall through) when the lower level is sustained.
    const drop = lastValid.weekPercent - s.weekPercent;
    if (drop > DROP_THRESHOLD || s.weekPercent === 0) {
      if (!isSustainedShift(i, lastValid.weekPercent, s.weekId)) continue;
    }

    filtered.push(s);
    lastValid = s;
  }

  return filtered;
}

function computeRawDeltas(cleaned) {
  const deltas = [];
  for (let i = 1; i < cleaned.length; i++) {
    const prev = cleaned[i - 1];
    const curr = cleaned[i];

    // Only compute deltas within same weekId
    if (curr.weekId !== prev.weekId) continue;

    const gapHours = (new Date(curr.timestamp) - new Date(prev.timestamp)) / (1000 * 60 * 60);

    // Ignore gaps > 4 hours
    if (gapHours > 4) continue;

    const delta = curr.weekPercent - prev.weekPercent;
    if (delta < 0) continue; // % should only increase within a week

    deltas.push({
      timestamp: curr.timestamp,
      weekId: curr.weekId,
      delta,
      gapHours,
      weekPercent: curr.weekPercent
    });
  }
  return deltas;
}

function getPanamaDateFromUTC(utcDate) {
  return new Date(utcDate.getTime() + (TZ_OFFSET * 3600000));
}

function aggregateToHourly(rawDeltas) {
  const buckets = {}; // key: "YYYY-MM-DD-HH"

  for (const d of rawDeltas) {
    const panama = getPanamaDateFromUTC(new Date(d.timestamp));
    const dateStr = panama.toISOString().split('T')[0];
    const hour = panama.getUTCHours();
    const key = `${dateStr}-${String(hour).padStart(2, '0')}`;

    if (!buckets[key]) {
      buckets[key] = { date: dateStr, hour, weekId: d.weekId, totalDelta: 0, count: 0 };
    }
    buckets[key].totalDelta += d.delta;
    buckets[key].count += 1;
  }

  return buckets;
}

function aggregateToDays(hourlyBuckets) {
  const days = {}; // key: "YYYY-MM-DD"

  for (const b of Object.values(hourlyBuckets)) {
    if (!days[b.date]) {
      days[b.date] = { date: b.date, weekId: b.weekId, totalDelta: 0, hours: 0 };
    }
    days[b.date].totalDelta += b.totalDelta;
    days[b.date].hours += 1;
  }

  // Sort by date and return last 14 days
  return Object.values(days)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-14);
}

function computeCurrentRate(hourlyBuckets) {
  // Get last 6 hours of data
  const now = getPanamaDateFromUTC(new Date());
  const sixHoursAgo = new Date(now.getTime() - 6 * 3600000);

  let totalDelta = 0;
  let hoursWithData = 0;

  for (const b of Object.values(hourlyBuckets)) {
    const bucketTime = new Date(`${b.date}T${String(b.hour).padStart(2, '0')}:00:00Z`);
    if (bucketTime >= sixHoursAgo && bucketTime <= now) {
      totalDelta += b.totalDelta;
      hoursWithData++;
    }
  }

  if (hoursWithData === 0) return { perHour: 0, perDay: 0, hoursUsed: 0 };

  const perHour = totalDelta / hoursWithData;
  return {
    perHour: Math.round(perHour * 100) / 100,
    perDay: Math.round(perHour * 24 * 100) / 100,
    hoursUsed: hoursWithData
  };
}

function computeProjection(currentRate, snapshots) {
  if (currentRate.perHour <= 0 || snapshots.length === 0) {
    return { hoursLeft: null, date: null, daysLeft: null };
  }

  // Get latest valid snapshot
  const latest = snapshots[snapshots.length - 1];
  const remaining = 100 - latest.weekPercent;

  if (remaining <= 0) {
    return { hoursLeft: 0, date: new Date().toISOString(), daysLeft: 0 };
  }

  const hoursLeft = remaining / currentRate.perHour;
  const exhaustionDate = new Date(Date.now() + hoursLeft * 3600000);

  return {
    hoursLeft: Math.round(hoursLeft * 10) / 10,
    daysLeft: Math.round((hoursLeft / 24) * 10) / 10,
    date: exhaustionDate.toISOString(),
    currentPercent: latest.weekPercent
  };
}

function buildDeltaHeatmap(hourlyBuckets) {
  // Average intensity by real day-of-week (0=dom..6=sab) x hour (0-23)
  // Aggregates ALL available data across weeks
  const totals = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const counts = Array.from({ length: 7 }, () => new Array(24).fill(0));

  for (const b of Object.values(hourlyBuckets)) {
    const bucketDate = new Date(b.date + 'T00:00:00Z');
    const dow = bucketDate.getUTCDay(); // 0=sun, 1=mon, ...
    totals[dow][b.hour] += b.totalDelta;
    counts[dow][b.hour] += 1;
  }

  // Compute averages
  const matrix = Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 24 }, (_, h) =>
      counts[d][h] > 0 ? Math.round((totals[d][h] / counts[d][h]) * 1000) / 1000 : 0
    )
  );

  // Count how many weeks contributed
  const weekIds = new Set(Object.values(hourlyBuckets).map(b => b.weekId));

  return { matrix, weeksCount: weekIds.size };
}

function buildCumulativeCurves(cleaned) {
  // Group snapshots by weekId
  const byWeek = {};
  for (const s of cleaned) {
    if (!byWeek[s.weekId]) byWeek[s.weekId] = [];
    byWeek[s.weekId].push(s);
  }

  // Get ALL weekIds sorted (up to ~4 weeks, limited by 28-day retention)
  const weekIds = Object.keys(byWeek).sort();
  const recentIds = weekIds;

  const curves = {};
  for (const wid of recentIds) {
    const snaps = byWeek[wid];
    // Convert to {elapsedHours, weekPercent} with forward-fill
    const points = snaps.map(s => ({
      elapsedHours: s.elapsedHours,
      weekPercent: s.weekPercent
    }));
    curves[wid] = points;
  }

  return curves;
}

function computeUsageDeltas() {
  // Load snapshots
  let data = { snapshots: [] };
  try {
    if (fs.existsSync(USAGE_CURVE_FILE)) {
      data = JSON.parse(fs.readFileSync(USAGE_CURVE_FILE, 'utf8'));
    }
  } catch (e) { /* empty */ }

  const totalSnapshots = data.snapshots.length;
  if (totalSnapshots === 0) {
    return { error: 'No snapshots available', meta: { total: 0, valid: 0, filtered: 0 } };
  }

  // Step 1: Filter anomalies
  const cleaned = filterAnomalies(data.snapshots);

  // Step 2: Raw deltas
  const rawDeltas = computeRawDeltas(cleaned);

  // Step 3: Aggregate to hourly
  const hourlyBuckets = aggregateToHourly(rawDeltas);

  // Step 4: Daily aggregation
  const daily = aggregateToDays(hourlyBuckets);

  // Step 5: Current rate
  const currentRate = computeCurrentRate(hourlyBuckets);

  // Step 6: Projection
  const projection = computeProjection(currentRate, cleaned);

  // Step 7: Heatmap — average intensity by day-of-week x hour (all weeks)
  const currentWeekId = cleaned.length > 0 ? cleaned[cleaned.length - 1].weekId : null;
  const heatmapResult = buildDeltaHeatmap(hourlyBuckets);
  const heatmap = heatmapResult.matrix;
  const heatmapWeeks = heatmapResult.weeksCount;

  // Step 8: Hourly data for last 48h chart
  const now = getPanamaDateFromUTC(new Date());
  const fortyEightAgo = new Date(now.getTime() - 48 * 3600000);
  const hourly = Object.values(hourlyBuckets)
    .filter(b => {
      const t = new Date(`${b.date}T${String(b.hour).padStart(2, '0')}:00:00Z`);
      return t >= fortyEightAgo;
    })
    .sort((a, b) => {
      const ka = `${a.date}-${String(a.hour).padStart(2, '0')}`;
      const kb = `${b.date}-${String(b.hour).padStart(2, '0')}`;
      return ka.localeCompare(kb);
    })
    .map(b => ({
      date: b.date,
      hour: b.hour,
      label: `${b.date.slice(5)} ${String(b.hour).padStart(2, '0')}h`,
      delta: Math.round(b.totalDelta * 100) / 100
    }));

  // Step 9: Cumulative curves for week comparison (Patrones tab)
  const curves = buildCumulativeCurves(cleaned);

  return {
    daily,
    hourly,
    currentRate,
    projection,
    heatmap,
    heatmapWeeks,
    currentWeekId,
    curves,
    meta: {
      total: totalSnapshots,
      valid: cleaned.length,
      filtered: totalSnapshots - cleaned.length,
      rawDeltas: rawDeltas.length
    }
  };
}

// Parse JSON bodies
app.use(express.json({ limit: '10mb' }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Chart.js, served from the npm dependency instead of a CDN. The dashboard used to load it from
// cdn.jsdelivr.net — unpinned — which contradicted SECURITY.md's "no third-party calls" and let a
// third party decide what code ran in the page. Version comes from package-lock.json; no minified
// blob is committed to the repo.
//
// The path is resolved off the package entry because chart.js 4's `exports` map refuses deep
// subpath requires (`chart.js/dist/chart.umd.js` and even `chart.js/package.json` throw
// ERR_PACKAGE_PATH_NOT_EXPORTED), so require.resolve cannot reach the UMD build directly.
const CHART_UMD = (() => {
  try {
    return path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.js');
  } catch (e) {
    return null;
  }
})();

app.get('/vendor/chart.umd.js', (req, res) => {
  if (!CHART_UMD || !fs.existsSync(CHART_UMD)) {
    // Every chart on the page is dead without this, so say so plainly rather than 404.
    return res.status(503)
      .type('text/plain')
      .send('chart.js is not installed — run `npm ci`. The dashboard renders no charts without it.');
  }
  res.type('application/javascript').sendFile(CHART_UMD);
});

// API endpoints

app.get('/api/refresh', (req, res) => {
  res.redirect('/api/global-usage/refresh');
});

// Global Usage API (Claude /usage via PTY)
app.get('/api/global-usage', async (req, res) => {
  // Capture mode: serve the fixture on disk and never spawn a PTY. Flagged in the payload
  // so no consumer — the dashboard included — can read it as a live gauge.
  if (DEMO) {
    if (!globalUsageCache.data) {
      return res.status(503).json({
        success: false,
        demo: true,
        failureKind: 'demo-fixture-missing',
        error: `Demo mode is on but ${path.basename(GLOBAL_USAGE_FILE)} is not in ${DATA_DIR}`
      });
    }
    return res.json({ ...globalUsageCache.data, demo: true, cached: true });
  }

  // Return cached if fresh (less than 5 minutes old)
  const cacheAge = globalUsageCache.lastUpdate 
    ? (Date.now() - new Date(globalUsageCache.lastUpdate).getTime()) / 1000 / 60
    : Infinity;
  
  if (cacheAge < 5 && globalUsageCache.data) {
    return res.json({
      ...globalUsageCache.data,
      cached: true,
      cacheAge: Math.round(cacheAge * 10) / 10
    });
  }
  
  // Prevent concurrent fetches
  if (globalUsageCache.fetching) {
    // Spreading an empty cache used to yield a body with neither numbers nor a reason,
    // which the dashboard could only render as "Error: Unknown" (#49). Nothing is wrong
    // in that state: the first fetch after a restart is simply still running, and it
    // takes ~6s. Say that, so the caller waits instead of reporting a failure.
    if (!globalUsageCache.data) {
      return res.json({
        success: false,
        fetching: true,
        failureKind: 'fetch-in-flight',
        errorMessage: 'First /usage fetch is still running — no value cached yet'
      });
    }
    return res.json({
      ...globalUsageCache.data,
      cached: true,
      fetching: true
    });
  }

  try {
    globalUsageCache.fetching = true;
    console.log('🔄 Fetching global usage from Claude...');

    const usage = await fetchAndSnapshot();

    // A stale fallback IS the cached value — the fetch behind it failed. Saying
    // `cached: false` there would date a number that nobody just measured.
    res.json({
      ...usage,
      cached: usage.stale === true
    });
  } catch (error) {
    console.error('❌ Failed to fetch global usage:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      cached: globalUsageCache.data ? true : false,
      data: globalUsageCache.data
    });
  } finally {
    globalUsageCache.fetching = false;
  }
});

app.get('/api/global-usage/refresh', async (req, res) => {
  // Force refresh global usage
  if (!DEMO) globalUsageCache.lastUpdate = null;
  res.redirect('/api/global-usage');
});

// Usage Curve API (periodic % snapshots for week-over-week comparison)
app.get('/api/usage-curve', (req, res) => {
  let data = { snapshots: [] };
  if (fs.existsSync(USAGE_CURVE_FILE)) {
    try { data = JSON.parse(fs.readFileSync(USAGE_CURVE_FILE, 'utf8')); } catch (e) {}
  }
  res.json(data);
});

// Usage Deltas API (derived consumption from % snapshots)
app.get('/api/usage-deltas', (req, res) => {
  const cacheAge = usageDeltasCache.lastUpdate
    ? (Date.now() - new Date(usageDeltasCache.lastUpdate).getTime()) / 1000 / 60
    : Infinity;

  if (cacheAge < 5 && usageDeltasCache.data) {
    return res.json({ ...usageDeltasCache.data, cached: true });
  }

  try {
    const result = computeUsageDeltas();
    usageDeltasCache.data = result;
    usageDeltasCache.lastUpdate = new Date().toISOString();
    res.json(result);
  } catch (e) {
    console.error('Failed to compute usage deltas:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Config API (expose settings to frontend)
app.get('/api/config', (req, res) => {
  res.json({ tzOffset: TZ_OFFSET, demo: DEMO });
});

// Weekly History API — enriched with "time to 100%" from curve snapshots
app.get('/api/weekly-history', (req, res) => {
  let history = [];
  if (fs.existsSync(WEEKLY_HISTORY_FILE)) {
    try { history = JSON.parse(fs.readFileSync(WEEKLY_HISTORY_FILE, 'utf8')); } catch (e) {}
  }

  // Enrich: for weeks that hit 100%, find when they first reached it
  let curveData = { snapshots: [] };
  try {
    if (fs.existsSync(USAGE_CURVE_FILE)) {
      curveData = JSON.parse(fs.readFileSync(USAGE_CURVE_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }

  for (const entry of history) {
    if (entry.weekPercent >= 100) {
      const firstAt100 = curveData.snapshots.find(
        s => s.weekId === entry.weekId && s.weekPercent >= 100
      );
      if (firstAt100) {
        const hitsAt = Math.round(firstAt100.elapsedHours * 10) / 10;
        const hitsDay = Math.ceil(hitsAt / 24);
        const offlineHours = Math.max(0, 168 - hitsAt);
        entry.hitsAt100Hours = hitsAt;
        entry.hitsAt100Day = hitsDay;
        entry.offlineHours = Math.round(offlineHours * 10) / 10;
      }
    }
  }

  res.json({ history });
});

// === Per-session fuel from transcripts (#39) ===

// Kept on disk so a restart doesn't force a cold pass (~670 MB / ~45 s over ~1800
// sessions). Subsequent passes reuse every record whose file mtime and size are unchanged.
let sessionMetricsState = { updatedAt: null, byFile: {}, scan: null };
let sessionScanRunning = false;

try {
  if (fs.existsSync(SESSION_METRICS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(SESSION_METRICS_FILE, 'utf8'));
    if (saved && saved.byFile) {
      // Refuse a cache written by an older algorithm. Records are reused by mtime+size,
      // and neither changes when the code does, so an inflated pre-#42 cache would
      // otherwise survive every deploy. Dropping it forces one cold rescan.
      if (saved.version === sessionMetrics.SCHEMA_VERSION) {
        sessionMetricsState = saved;
      } else {
        console.warn(`⚠️  [sessions] cache schema v${saved.version ?? '1 (unversioned)'} `
          + `≠ v${sessionMetrics.SCHEMA_VERSION} — discarding it, a cold rescan follows (#42)`);
      }
    }
  }
} catch (e) { /* start fresh */ }

async function scanSessionMetrics() {
  if (sessionScanRunning) {
    console.log('⏭️  Session scan skipped: one is already running');
    return sessionMetricsState;
  }
  sessionScanRunning = true;
  try {
    const result = await sessionMetrics.collectSessions(TRANSCRIPTS_ROOT, sessionMetricsState.byFile);
    sessionMetricsState = {
      version: sessionMetrics.SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      byFile: result.byFile,
      scan: result.scan
    };
    try {
      fs.writeFileSync(SESSION_METRICS_FILE, JSON.stringify(sessionMetricsState));
    } catch (e) {
      console.error('Failed to persist session metrics:', e.message);
    }
    console.log(`🧾 Session scan: ${result.scan.files} sessions `
      + `(${result.scan.rescanned} re-read, ${result.scan.reused} cached) `
      + `in ${(result.scan.durationMs / 1000).toFixed(1)}s`);
  } catch (e) {
    console.error('❌ Session scan failed:', e.message);
  } finally {
    sessionScanRunning = false;
  }
  return sessionMetricsState;
}

// What burned the quota: fuel by project and the heaviest sessions.
// window=cycle (default, current weekly cycle) | 28d | all
app.get('/api/session-metrics', (req, res) => {
  const sessions = Object.values(sessionMetricsState.byFile || {});
  const window = req.query.window || 'cycle';

  let since = null;
  if (window === 'cycle') {
    since = getWeekCycleInfo().cycleStartUTC;
  } else if (window === '28d') {
    since = new Date(Date.now() - 28 * 24 * 3600 * 1000).toISOString();
  }

  const agg = sessionMetrics.aggregate(sessions, {
    since,
    minFuel: SESSION_MIN_FUEL,
    topN: parseInt(req.query.top || '15', 10)
  });

  res.json({
    ...agg,
    windowKey: window,
    updatedAt: sessionMetricsState.updatedAt,
    scanning: sessionScanRunning,
    scan: sessionMetricsState.scan
  });
});

app.get('/api/session-metrics/refresh', async (req, res) => {
  // Capture mode never reads transcripts, not even on demand: the fixture is the whole
  // dataset, and a rescan here would pull in real sessions behind the demo banner.
  if (DEMO) {
    return res.json({ ok: false, demo: true, reason: 'transcript scanning is off in demo mode' });
  }
  await scanSessionMetrics();
  res.json({ ok: true, updatedAt: sessionMetricsState.updatedAt, scan: sessionMetricsState.scan });
});

// === Collection core (shared by the HTTP endpoint and the auto-collector) ===

// Fetch /usage via PTY, refresh the cache, and persist snapshots.
// Throws on PTY/spawn failure so callers can decide how to report it.
// Callers MUST hold the `globalUsageCache.fetching` guard to avoid overlapping
// PTY spawns (set it before calling, clear it in a finally block).
async function fetchAndSnapshot({ retryOnFailure = false } = {}) {
  let usage = await getClaudeUsage(false);

  // One retry inside the same cycle. Without it a failed fetch waits the full
  // collector interval, so the panel can read up to 2x the interval stale — and
  // spacing the interval out would make each failure hurt proportionally more.
  // Scheduler only: an HTTP caller should not wait through a second 35s timeout.
  if (!usage.success && retryOnFailure) {
    console.warn('🔁 /usage fetch failed — retrying once in this cycle');
    usage = await getClaudeUsage(false);
  }

  // A timed-out / unparseable fetch comes back as success:false with 0% — never
  // let that overwrite a good cached value (it would make the dashboard read 0%
  // / "100% remaining" until the next good fetch). Keep the last good value.
  if (!usage.success) {
    // Dump the raw text on the way out. The instrumentation below only fires on a
    // weekly-% drop, which happened once; THIS is the failure that actually recurs,
    // and until now it left nothing but the message — so a timeout could not be told
    // apart from an expired /login, a trust dialog eating the keystrokes, or a panel
    // that never loaded. Those need different fixes.
    console.warn('⚠️  /usage fetch returned no parseable data:', usage.errorMessage || 'unknown reason',
      '— keeping last good value. Raw /usage:\n'
      + (usage.rawClean || '(raw unavailable)'));
    delete usage.rawClean; // never cache or serve it — this path can return `usage` itself

    // Keeping the last good value is right; serving it unmarked is not. Without this the
    // caller cannot tell a number measured seconds ago from one frozen since the fetcher
    // started failing, and the errorMessage #48 just produced dies in this log line.
    if (globalUsageCache.data) {
      return {
        ...globalUsageCache.data,
        stale: true,
        failureKind: usage.failureKind,
        errorMessage: usage.errorMessage
      };
    }
    return usage;
  }

  // Instrumentation: a sustained drop in the weekly % is physically impossible for a
  // cumulative unless the cycle reset. Within-session data can't tell a real
  // reset-at-an-unexpected-day from an inflated prior read or a mis-parsed section,
  // so capture the raw /usage text (incl. both resetsAt anchors) to diagnose the next
  // occurrence from evidence instead of inference. See the follow-up issue.
  const prevWeek = globalUsageCache.data?.weekAll;
  if (prevWeek?.percent != null && usage.weekAll?.percent != null
      && usage.weekAll.percent < prevWeek.percent - 15) {
    console.warn(`⚠️  [drop] weekAll ${prevWeek.percent}% → ${usage.weekAll.percent}% `
      + `| prevReset=${prevWeek.resetsAt} newReset=${usage.weekAll.resetsAt} `
      + `(same reset ⇒ suspect; changed+later ⇒ real reset). Raw /usage:\n`
      + (usage.rawClean || '(raw unavailable)'));
  }
  delete usage.rawClean; // debug-only — never cache or serve it

  updatePersistedResets(usage);
  globalUsageCache.data = usage;
  globalUsageCache.lastUpdate = new Date().toISOString();

  console.log('✅ Global usage updated:', usage.weekAll?.percent + '% week',
    usage.weekAll?.resetsAt ? '(resetsAt: ' + usage.weekAll.resetsAt + ')' : '(resetsAt: persisted)');

  // Auto-snapshot weekly efficiency + usage curve
  if (usage.weekAll?.percent != null) {
    try { saveWeeklySnapshot(usage.weekAll.percent); } catch (e) {
      console.error('Failed to save weekly snapshot:', e.message);
    }
    try { saveUsageCurveSnapshot(usage); } catch (e) {
      console.error('Failed to save usage curve snapshot:', e.message);
    }
  }

  return usage;
}

// In-process scheduled collection. Skips (does not queue) if a fetch is already
// running, so we never spawn overlapping `claude` PTY sessions.
async function scheduledCollect() {
  if (globalUsageCache.fetching) {
    console.log('⏭️  Auto-collector skipped: a fetch is already in progress');
    return;
  }
  try {
    globalUsageCache.fetching = true;
    console.log(`⏰ Auto-collector running (every ${COLLECT_INTERVAL_MIN} min)...`);
    await fetchAndSnapshot({ retryOnFailure: true });
  } catch (e) {
    console.error('❌ Auto-collector failed:', e.message);
  } finally {
    globalUsageCache.fetching = false;
  }
}

// Capture mode has no live source, so the gauge comes from a fixture written to DATA_DIR
// beforehand (see scripts/demo.js). Loaded once at boot; nothing refreshes it.
if (DEMO) {
  try {
    if (fs.existsSync(GLOBAL_USAGE_FILE)) {
      globalUsageCache.data = JSON.parse(fs.readFileSync(GLOBAL_USAGE_FILE, 'utf8'));
      globalUsageCache.lastUpdate = new Date().toISOString();
    }
  } catch (e) {
    console.error(`❌ Demo fixture ${GLOBAL_USAGE_FILE} is unreadable: ${e.message}`);
  }
}

// Start server
app.listen(PORT, HOST, () => {
  console.log(`🚀 ccfuel running at http://${HOST}:${PORT}`);
  console.log(`💾 Data directory: ${DATA_DIR}`);

  // Loud at boot rather than as four blank canvases in the browser.
  if (!CHART_UMD || !fs.existsSync(CHART_UMD)) {
    console.warn('⚠️  chart.js not found in node_modules — /vendor/chart.umd.js will 503 and no '
      + 'chart will render. Run `npm ci`.');
  }

  if (DEMO) {
    console.log('🎬 DEMO MODE — serving synthetic fixtures. No PTY spawn, no transcript read.');
  }

  if (COLLECT_INTERVAL_MIN > 0) {
    console.log(`📡 Auto-collector enabled: every ${COLLECT_INTERVAL_MIN} min (set DASHBOARD_COLLECT_INTERVAL_MIN=0 to disable)`);
    // Prime the data shortly after boot so panels populate without waiting a full interval
    setTimeout(scheduledCollect, 5000);
    setInterval(scheduledCollect, COLLECT_INTERVAL_MIN * 60 * 1000);
  } else {
    console.log('📡 Auto-collector disabled (DASHBOARD_COLLECT_INTERVAL_MIN=0)');
  }

  if (SESSION_SCAN_INTERVAL_MIN > 0) {
    console.log(`🧾 Session scan enabled: every ${SESSION_SCAN_INTERVAL_MIN} min `
      + `(min fuel ${SESSION_MIN_FUEL.toLocaleString()} tokens, root ${TRANSCRIPTS_ROOT})`);
    // Deliberately after the /usage prime: a cold pass is I/O heavy and the live gauge
    // is the more time-sensitive of the two.
    setTimeout(scanSessionMetrics, 30000);
    setInterval(scanSessionMetrics, SESSION_SCAN_INTERVAL_MIN * 60 * 1000);
  } else {
    console.log('🧾 Session scan disabled (DASHBOARD_SESSION_SCAN_INTERVAL_MIN=0)');
  }
});
