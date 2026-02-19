// Claude Usage via PTY
// Ejecuta claude, envía /usage, parsea el output

const pty = require('node-pty');
const os = require('os');
const fs = require('fs');

function getClaudeUsage(debug = false) {
  return new Promise((resolve, reject) => {
    let output = '';
    let resolved = false;
    
    // Spawn claude directly
    const ptyProcess = pty.spawn('claude', [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: __dirname,
      env: { ...process.env, TERM: 'xterm-256color' }
    });
    
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ptyProcess.kill();
        if (debug) {
          fs.writeFileSync('/tmp/claude-pty-debug.log', output);
          console.log('Debug: timeout reached, output saved to /tmp/claude-pty-debug.log');
        }
        resolve(parseUsageOutput(output));
      }
    }, 20000);

    ptyProcess.onData((data) => {
      output += data;
      if (debug) {
        process.stdout.write(data);
      }
    });
    
    ptyProcess.onExit(() => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        if (debug) {
          fs.writeFileSync('/tmp/claude-pty-debug.log', output);
        }
        resolve(parseUsageOutput(output));
      }
    });
    
    // Sequence of commands with proper timing
    setTimeout(() => {
      if (debug) console.log('\n[DEBUG] Sending /usage...');
      ptyProcess.write('/usage');
    }, 3000);
    
    setTimeout(() => {
      if (debug) console.log('\n[DEBUG] Pressing Enter to execute /usage...');
      ptyProcess.write('\r');
    }, 3500);
    
    setTimeout(() => {
      if (debug) console.log('\n[DEBUG] Sending ESC to close panel...');
      ptyProcess.write('\x1b');
    }, 8000);
    
    setTimeout(() => {
      if (debug) console.log('\n[DEBUG] Sending /exit...');
      ptyProcess.write('/exit\r');
    }, 9000);
  });
}

function parseUsageOutput(output) {
  // Remove ANSI escape codes — replace with spaces (not empty string)
  // because cursor movement codes like [1C] represent visual spacing.
  // Without this, "Resets[1C]Feb" becomes "ResetsFeb" instead of "Resets Feb".
  const clean = output
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ' ')
    .replace(/\x1b\[[0-9;?]*[hlm]/g, ' ')
    .replace(/\x1b\][^\x07]*\x07/g, ' ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
    .replace(/\s+/g, ' ');

  // --- Section-based parsing ---
  // Instead of matching resets globally by position (fragile — if one fails
  // to parse, all subsequent ones shift), we split the text by section headers
  // and parse each section independently.
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

  // Extract text for each section (from its header to the next header or end)
  const sectionTexts = {};
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].index;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].index : clean.length;
    sectionTexts[boundaries[i].key] = clean.slice(start, end);
  }

  // Parse percent and reset time from a section's text
  function parseSection(text) {
    if (!text) return { percent: 0, resetsAtHour: null, resetsAt: null };

    const pctMatch = text.match(/(\d+)%\s*used/i);
    const percent = pctMatch ? parseInt(pctMatch[1]) : 0;

    // Reset time regex — applied per-section
    // Minutes are optional: PTY sometimes rounds "4:59pm" → "5pm"
    const rstMatch = text.match(/Res\w*\s+(?:[\w,]*\s+)*?(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);

    let resetsAtHour = null;
    let resetsAt = null;

    if (rstMatch) {
      const monthStr = rstMatch[1]; // undefined if no date
      const dayStr = rstMatch[2];   // undefined if no date
      let hour = parseInt(rstMatch[3]);
      const minute = rstMatch[4] != null ? parseInt(rstMatch[4]) : 0;
      const ampm = rstMatch[5].toLowerCase();
      if (ampm === 'pm' && hour !== 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;

      resetsAtHour = hour;

      if (monthStr && dayStr) {
        // Full date provided — convert Panama time to UTC
        const monthMap = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
        const month = monthMap[monthStr.toLowerCase().slice(0, 3)];
        const day = parseInt(dayStr);
        const year = new Date().getUTCFullYear();
        // Panama is UTC-5, so add 5h to get UTC
        resetsAt = new Date(Date.UTC(year, month, day, hour + 5, minute, 0)).toISOString();
      } else {
        // No date — reset is today or tomorrow (compute from current time)
        const now = new Date();
        const panamaMs = now.getTime() + (-5 * 60 * 60 * 1000);
        const panama = new Date(panamaMs);
        let resetDate = new Date(panama);
        resetDate.setUTCHours(hour, minute, 0, 0);
        if (panama >= resetDate) {
          resetDate.setUTCDate(resetDate.getUTCDate() + 1);
        }
        // Convert panama-shifted back to real UTC
        resetsAt = new Date(resetDate.getTime() + 5 * 60 * 60 * 1000).toISOString();
      }
    }

    return { percent, resetsAtHour, resetsAt };
  }

  const session = parseSection(sectionTexts.session);
  const weekAll = parseSection(sectionTexts.weekAll);
  const weekSonnet = parseSection(sectionTexts.weekSonnet);

  // Check extra usage
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
