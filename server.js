const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getClaudeUsage } = require('./claude-usage');

const app = express();

const PORT = process.env.DASHBOARD_PORT || 3400;
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const EXTERNAL_DIR = path.join(__dirname, 'data', 'external');
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
  for (const key of ['session', 'weekAll', 'weekSonnet']) {
    if (usage[key]?.resetsAt) {
      persistedResets[key] = usage[key].resetsAt;
      changed = true;
    } else if (persistedResets[key] && new Date(persistedResets[key]) > new Date()) {
      // PTY failed to parse, but persisted value is still in the future — inject it
      if (usage[key]) usage[key].resetsAt = persistedResets[key];
    }
  }
  if (changed) {
    try { fs.writeFileSync(RESETS_CACHE_FILE, JSON.stringify(persistedResets, null, 2)); } catch (e) { /* ignore */ }
  }
}

// Cache for ccusage data
let cachedData = {
  blocks: null,
  daily: null,
  lastUpdate: null
};

// Run ccusage and parse JSON
function runCcusage(command) {
  return new Promise((resolve, reject) => {
    exec(`npx ccusage@latest ${command} --json 2>/dev/null`, {
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
    }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        const data = JSON.parse(stdout);
        resolve(data);
      } catch (e) {
        reject(new Error('Failed to parse ccusage output'));
      }
    });
  });
}

// Update cache
async function updateCache() {
  try {
    console.log('📊 Updating ccusage data...');
    const [blocks, daily] = await Promise.all([
      runCcusage('blocks'),
      runCcusage('daily')
    ]);
    cachedData = {
      blocks,
      daily,
      lastUpdate: new Date().toISOString()
    };
    console.log('✅ Cache updated at', cachedData.lastUpdate);
  } catch (error) {
    console.error('❌ Failed to update cache:', error.message);
  }
}

// Weekly history helpers — uses Claude's actual reset cycle
function getWeekCycleInfo() {
  // Panama time (UTC-5)
  const now = new Date();
  const panamaMs = now.getTime() + (-5 * 60 * 60 * 1000);
  const panama = new Date(panamaMs);

  let nextReset;
  const weeklyResetsAt = globalUsageCache.data?.weekAll?.resetsAt;

  if (weeklyResetsAt) {
    // Use actual reset date from Claude /usage (convert UTC to panama-shifted)
    nextReset = new Date(new Date(weeklyResetsAt).getTime() + (-5 * 60 * 60 * 1000));
  } else {
    // Fallback: estimate using reset hour (only accurate on day before reset)
    const resetHour = globalUsageCache.data?.weekAll?.resetsAtHour ?? 10;
    nextReset = new Date(panama);
    nextReset.setUTCHours(resetHour, 0, 0, 0);
    if (panama >= nextReset) {
      nextReset.setUTCDate(nextReset.getUTCDate() + 1);
    }
  }

  // Cycle start = next reset - 7 days
  const cycleStart = new Date(nextReset);
  cycleStart.setUTCDate(cycleStart.getUTCDate() - 7);

  const elapsedMs = panama - cycleStart;
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

function getWeekTokensFromBlocks(blocksData, weekStartISO) {
  if (!blocksData?.blocks) return 0;
  return blocksData.blocks
    .filter(b => !b.isGap && b.startTime >= weekStartISO)
    .reduce((sum, b) => {
      const cacheRead = b.tokenCounts?.cacheReadInputTokens || b.cacheReadInputTokens || 0;
      return sum + ((b.totalTokens || 0) - cacheRead);
    }, 0);
}

function saveWeeklySnapshot(weekPercent) {
  const weekId = getWeekStartDate();
  const dayNum = getWeekDayNumber();
  const weekStartISO = weekId + 'T00:00:00.000Z';

  // Combined tokens from VPS + external sources
  const vpsTokens = getWeekTokensFromBlocks(cachedData.blocks, weekStartISO);

  let extTokens = 0;
  if (fs.existsSync(EXTERNAL_DIR)) {
    for (const file of fs.readdirSync(EXTERNAL_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(EXTERNAL_DIR, file), 'utf8'));
        extTokens += getWeekTokensFromBlocks(data.blocks, weekStartISO);
      } catch (e) { /* skip corrupt files */ }
    }
  }

  const combinedTokens = vpsTokens + extTokens;
  const estimatedAllocation = weekPercent > 0
    ? Math.round(combinedTokens / (weekPercent / 100))
    : 0;

  // Load or create history
  let history = [];
  if (fs.existsSync(WEEKLY_HISTORY_FILE)) {
    try { history = JSON.parse(fs.readFileSync(WEEKLY_HISTORY_FILE, 'utf8')); } catch (e) {}
  }

  const entry = {
    weekId,
    timestamp: new Date().toISOString(),
    weekPercent,
    vpsTokens,
    extTokens,
    combinedTokens,
    estimatedAllocation,
    dayNum
  };

  const existingIdx = history.findIndex(h => h.weekId === weekId);
  if (existingIdx >= 0) {
    const existing = history[existingIdx];
    // Never downgrade weekPercent — protects against post-reset overwrites
    // After a weekly reset, Claude returns 0-2% but weekId may still point to the old week
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
  console.log(`📊 Weekly snapshot saved: week ${weekId}, ${weekPercent}%, ${(combinedTokens/1e6).toFixed(1)}M tokens`);
}

function saveUsageCurveSnapshot(usage) {
  if (!usage?.weekAll?.percent == null) return;

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
  console.log(`📈 Usage curve snapshot: ${weekPercent}% week, ${sessionPercent}% session, day ${cycleInfo.dayNum}`);
}

// Parse JSON bodies
app.use(express.json({ limit: '10mb' }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// API endpoints
app.get('/api/data', (req, res) => {
  res.json(cachedData);
});

app.get('/api/refresh', async (req, res) => {
  await updateCache();
  res.json({ status: 'ok', lastUpdate: cachedData.lastUpdate });
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
    
    const usage = await getClaudeUsage(false);
    updatePersistedResets(usage);
    globalUsageCache.data = usage;
    globalUsageCache.lastUpdate = new Date().toISOString();

    console.log('✅ Global usage updated:', usage.weekAll?.percent + '% week',
      usage.weekAll?.resetsAt ? '(resetsAt: ' + usage.weekAll.resetsAt + ')' : '(resetsAt: persisted)');

    // Auto-snapshot weekly efficiency
    if (usage.weekAll?.percent != null) {
      try { saveWeeklySnapshot(usage.weekAll.percent); } catch (e) {
        console.error('Failed to save weekly snapshot:', e.message);
      }
      try { saveUsageCurveSnapshot(usage); } catch (e) {
        console.error('Failed to save usage curve snapshot:', e.message);
      }
    }

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

// External Usage API (receive data from laptop/other sources)
app.post('/api/external-usage', (req, res) => {
  const { source, blocks, daily } = req.body;

  if (!source || typeof source !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "source" field' });
  }
  if (!blocks || !daily) {
    return res.status(400).json({ error: 'Missing "blocks" or "daily" data' });
  }

  const safeName = source.replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = path.join(EXTERNAL_DIR, `${safeName}.json`);
  const payload = {
    source: safeName,
    blocks,
    daily,
    lastUpdate: new Date().toISOString()
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  console.log(`📥 External usage received from "${safeName}"`);
  res.json({ status: 'ok', source: safeName, lastUpdate: payload.lastUpdate });
});

app.get('/api/external-usage', (req, res) => {
  const sources = {};

  if (fs.existsSync(EXTERNAL_DIR)) {
    const files = fs.readdirSync(EXTERNAL_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(EXTERNAL_DIR, file), 'utf8'));
        sources[data.source] = {
          blocks: data.blocks,
          daily: data.daily,
          lastUpdate: data.lastUpdate
        };
      } catch (e) {
        console.error(`Failed to read external file ${file}:`, e.message);
      }
    }
  }

  res.json({ sources });
});

// Usage Curve API (periodic % snapshots for week-over-week comparison)
app.get('/api/usage-curve', (req, res) => {
  let data = { snapshots: [] };
  if (fs.existsSync(USAGE_CURVE_FILE)) {
    try { data = JSON.parse(fs.readFileSync(USAGE_CURVE_FILE, 'utf8')); } catch (e) {}
  }
  res.json(data);
});

// Weekly History API
app.get('/api/weekly-history', (req, res) => {
  let history = [];
  if (fs.existsSync(WEEKLY_HISTORY_FILE)) {
    try { history = JSON.parse(fs.readFileSync(WEEKLY_HISTORY_FILE, 'utf8')); } catch (e) {}
  }
  res.json({ history });
});

// Start server
app.listen(PORT, HOST, async () => {
  console.log(`🚀 Token Dashboard running at http://${HOST}:${PORT}`);
  console.log('📊 Fetching initial data...');
  await updateCache();
  
  // Update every 5 minutes
  setInterval(updateCache, 5 * 60 * 1000);
});
