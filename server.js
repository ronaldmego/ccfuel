const express = require('express');
const path = require('path');
const fs = require('fs');
const { getClaudeUsage } = require('./claude-usage');

const app = express();

const PORT = process.env.DASHBOARD_PORT || 3400;
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const TZ_OFFSET = parseInt(process.env.DASHBOARD_TIMEZONE || '-5', 10);
// Auto-collector cadence (minutes). 0 disables the in-process scheduler.
const COLLECT_INTERVAL_MIN = parseInt(process.env.DASHBOARD_COLLECT_INTERVAL_MIN || '10', 10);
const WEEKLY_HISTORY_FILE = path.join(__dirname, 'data', 'weekly-history.json');
const USAGE_CURVE_FILE = path.join(__dirname, 'data', 'usage-curve.json');

// Cache for global usage (Claude /usage command)
let globalUsageCache = {
  data: null,
  lastUpdate: null,
  fetching: false
};

// Persisted reset dates — PTY parsing is unreliable, so we keep the last
// successfully parsed resetsAt values and reuse them when parsing fails.
const RESETS_CACHE_FILE = path.join(__dirname, 'data', 'resets-cache.json');
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
    if (usage[key]?.resetsAt) {
      persistedResets[key] = usage[key].resetsAt;
      changed = true;
    } else if (persistedResets[key] && new Date(persistedResets[key]) > new Date()) {
      // PTY failed to parse, but persisted value is still in the future — inject it
      if (usage[key]) usage[key].resetsAt = persistedResets[key];
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
  const weeklyResetsAt = globalUsageCache.data?.weekAll?.resetsAt;

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
    cycleStartISO: cycleStart.toISOString(),
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

// API endpoints

app.get('/api/refresh', (req, res) => {
  res.redirect('/api/global-usage/refresh');
});

// Global Usage API (Claude /usage via PTY)
app.get('/api/global-usage', async (req, res) => {
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

    res.json({
      ...usage,
      cached: false
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
  globalUsageCache.lastUpdate = null;
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
  res.json({ tzOffset: TZ_OFFSET });
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

// === Collection core (shared by the HTTP endpoint and the auto-collector) ===

// Fetch /usage via PTY, refresh the cache, and persist snapshots.
// Throws on PTY/spawn failure so callers can decide how to report it.
// Callers MUST hold the `globalUsageCache.fetching` guard to avoid overlapping
// PTY spawns (set it before calling, clear it in a finally block).
async function fetchAndSnapshot() {
  const usage = await getClaudeUsage(false);

  // A timed-out / unparseable fetch comes back as success:false with 0% — never
  // let that overwrite a good cached value (it would make the dashboard read 0%
  // / "100% remaining" until the next good fetch). Keep the last good value.
  if (!usage.success) {
    console.warn('⚠️  /usage fetch returned no parseable data:', usage.errorMessage || 'unknown reason',
      '— keeping last good value');
    return globalUsageCache.data || usage;
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
    await fetchAndSnapshot();
  } catch (e) {
    console.error('❌ Auto-collector failed:', e.message);
  } finally {
    globalUsageCache.fetching = false;
  }
}

// Start server
app.listen(PORT, HOST, () => {
  console.log(`🚀 Token Dashboard running at http://${HOST}:${PORT}`);

  if (COLLECT_INTERVAL_MIN > 0) {
    console.log(`📡 Auto-collector enabled: every ${COLLECT_INTERVAL_MIN} min (set DASHBOARD_COLLECT_INTERVAL_MIN=0 to disable)`);
    // Prime the data shortly after boot so panels populate without waiting a full interval
    setTimeout(scheduledCollect, 5000);
    setInterval(scheduledCollect, COLLECT_INTERVAL_MIN * 60 * 1000);
  } else {
    console.log('📡 Auto-collector disabled (DASHBOARD_COLLECT_INTERVAL_MIN=0)');
  }
});
