const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getClaudeUsage } = require('./claude-usage');

const app = express();

const PORT = 3400;
const HOST = '100.64.216.28'; // Tailscale IP
const EXTERNAL_DIR = path.join(__dirname, 'data', 'external');

// Cache for global usage (Claude /usage command)
let globalUsageCache = {
  data: null,
  lastUpdate: null,
  fetching: false
};

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
    globalUsageCache.data = usage;
    globalUsageCache.lastUpdate = new Date().toISOString();
    
    console.log('✅ Global usage updated:', usage.weekAll?.percent + '% week');
    
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

// Start server
app.listen(PORT, HOST, async () => {
  console.log(`🚀 Token Dashboard running at http://${HOST}:${PORT}`);
  console.log('📊 Fetching initial data...');
  await updateCache();
  
  // Update every 5 minutes
  setInterval(updateCache, 5 * 60 * 1000);
});
