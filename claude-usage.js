// Claude Usage via CLI (non-interactive)
// Runs `claude usage` and parses the text output
// Falls back gracefully on auth errors

const { execSync } = require('child_process');
const fs = require('fs');

function getClaudeUsage(debug = false) {
  return new Promise((resolve) => {
    let output = '';
    let authError = false;

    try {
      output = execSync('claude usage 2>&1', {
        timeout: 30000,
        encoding: 'utf-8',
        env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' }
      });
    } catch (err) {
      output = err.stdout || err.stderr || err.message || '';
      if (debug) console.error('claude usage failed:', err.message);
    }

    if (debug) {
      console.log('Raw output:');
      console.log(output);
      fs.writeFileSync('/tmp/claude-usage-debug.log', output);
    }

    // Check for auth errors
    if (/401|authentication_error|expired|OAuth token has expired/i.test(output)) {
      authError = true;
      if (debug) console.log('Auth error detected');
    }

    const result = parseUsageOutput(output);
    result.authError = authError;
    if (authError) {
      result.errorMessage = 'OAuth token expired. Run: claude auth login';
    }

    resolve(result);
  });
}

function parseUsageOutput(output) {
  // Clean ANSI codes
  const clean = output
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ' ')
    .replace(/\x1b\[[0-9;?]*[hlm]/g, ' ')
    .replace(/\x1b\][^\x07]*\x07/g, ' ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
    .replace(/\s+/g, ' ');

  // --- Section-based parsing ---
  const sectionDefs = [
    { key: 'session',    regex: /current\s+session/i },
    { key: 'weekAll',    regex: /current\s+week\s*\(?\s*all/i },
    { key: 'weekSonnet', regex: /current\s+week\s*\(?\s*sonnet/i }
  ];

  const boundaries = [];
  for (const sd of sectionDefs) {
    const m = sd.regex.exec(clean);
    if (m) boundaries.push({ key: sd.key, index: m.index });
  }
  boundaries.sort((a, b) => a.index - b.index);

  const sectionTexts = {};
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].index;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].index : clean.length;
    sectionTexts[boundaries[i].key] = clean.slice(start, end);
  }

  function parseSection(text) {
    if (!text) return { percent: 0, resetsAtHour: null, resetsAt: null };

    const pctMatch = text.match(/(\d+)%\s*used/i);
    const percent = pctMatch ? parseInt(pctMatch[1]) : 0;

    const rstMatch = text.match(/Res\w*\s+(?:[\w,]*\s+)*?(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);

    let resetsAtHour = null;
    let resetsAt = null;

    if (rstMatch) {
      const monthStr = rstMatch[1];
      const dayStr = rstMatch[2];
      let hour = parseInt(rstMatch[3]);
      const minute = rstMatch[4] != null ? parseInt(rstMatch[4]) : 0;
      const ampm = rstMatch[5].toLowerCase();
      if (ampm === 'pm' && hour !== 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;

      resetsAtHour = hour;

      if (monthStr && dayStr) {
        const monthMap = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
        const month = monthMap[monthStr.toLowerCase().slice(0, 3)];
        const day = parseInt(dayStr);
        const year = new Date().getUTCFullYear();
        resetsAt = new Date(Date.UTC(year, month, day, hour + 5, minute, 0)).toISOString();
      } else {
        const now = new Date();
        const panamaMs = now.getTime() + (-5 * 60 * 60 * 1000);
        const panama = new Date(panamaMs);
        let resetDate = new Date(panama);
        resetDate.setUTCHours(hour, minute, 0, 0);
        if (panama >= resetDate) {
          resetDate.setUTCDate(resetDate.getUTCDate() + 1);
        }
        resetsAt = new Date(resetDate.getTime() + 5 * 60 * 60 * 1000).toISOString();
      }
    }

    return { percent, resetsAtHour, resetsAt };
  }

  const session = parseSection(sectionTexts.session);
  const weekAll = parseSection(sectionTexts.weekAll);
  const weekSonnet = parseSection(sectionTexts.weekSonnet);

  const extraEnabled = /extra usage enabled/i.test(clean) && !/not enabled/i.test(clean);
  const extraMatch = clean.match(/\$(\d+)\s*free/i);

  return {
    success: boundaries.length >= 2 && (session.percent > 0 || weekAll.percent > 0),
    timestamp: new Date().toISOString(),
    session: {
      percent: session.percent,
      resetsAtHour: session.resetsAtHour,
      resetsAt: session.resetsAt
    },
    weekAll: {
      percent: weekAll.percent,
      resetsAtHour: weekAll.resetsAtHour,
      resetsAt: weekAll.resetsAt
    },
    weekSonnet: {
      percent: weekSonnet.percent,
      resetsAtHour: weekSonnet.resetsAtHour,
      resetsAt: weekSonnet.resetsAt
    },
    extraUsage: {
      enabled: extraEnabled,
      freeAvailable: extraMatch ? parseInt(extraMatch[1]) : 0
    }
  };
}

module.exports = { getClaudeUsage };

if (require.main === module) {
  const debug = process.argv.includes('--debug');
  console.log('Testing Claude usage fetch...' + (debug ? ' (debug mode)' : ''));
  getClaudeUsage(debug)
    .then(result => {
      console.log('\n=== RESULT ===');
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error('Error:', err);
      process.exit(1);
    });
}
