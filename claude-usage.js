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
      cwd: process.env.HOME + '/projects/token-dashboard',
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
  // Remove ANSI escape codes
  const clean = output
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\[[0-9;?]*[hlm]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
    .replace(/\s+/g, ' ');
  
  // Find percentages (XX% used pattern)
  const percentMatches = clean.match(/(\d+)%\s*used/gi) || [];
  const percents = percentMatches.map(m => parseInt(m.match(/\d+/)[0]));

  // Find reset times: "Resets 9pm", "Resets 10am", etc.
  // PTY garbles "Resets" into "Reses", "Reset", etc. so use lenient match
  const resetMatches = clean.match(/Res\w*\s*(\d{1,2})\s*(am|pm)/gi) || [];
  const resets = resetMatches.map(m => {
    const parts = m.match(/(\d{1,2})\s*(am|pm)/i);
    if (!parts) return null;
    let hour = parseInt(parts[1]);
    const ampm = parts[2].toLowerCase();
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    return hour;
  }).filter(h => h !== null);

  // Check extra usage
  const extraEnabled = /extra usage enabled/i.test(clean) && !/not enabled/i.test(clean);
  const extraMatch = clean.match(/\$(\d+)\s*free/i);

  return {
    success: percents.length >= 2,
    timestamp: new Date().toISOString(),
    session: {
      percent: percents[0] || 0,
      resetsAtHour: resets[0] ?? null
    },
    weekAll: {
      percent: percents[1] || 0,
      resetsAtHour: resets[1] ?? null
    },
    weekSonnet: {
      percent: percents[2] || 0,
      resetsAtHour: resets[2] ?? null
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
