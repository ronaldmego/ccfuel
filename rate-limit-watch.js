// Rate-limit episodes on the usage endpoint, and the operator hook that hears about them (#66).
//
// The endpoint answers 429 per account, and the budget is shared with every Claude Code
// session on it, so ccfuel cannot prevent it — it can only say when it happens. A reading is
// the wrong unit for that: one throttled window can span several collector cycles, and an
// endpoint that flaps would announce every one of them. So readings fold into episodes: one
// event when the first throttled read arrives, one when the endpoint has been answering again
// for a full cooldown.
//
// The hook is a command, not a channel. ccfuel hands it the event as JSON on stdin and never
// learns where it goes — Telegram, mail, a log file — which keeps that channel's credentials
// out of this process entirely.

const { spawn } = require('child_process');

const RATE_LIMITED = 'endpoint-rate-limited';

/**
 * The endpoint's throttle as one reading saw it — `{ retryAfterSec }` — or null when the
 * endpoint was not rate-limited on that read. Looks both at a reading the endpoint produced
 * itself and at one another source produced after the endpoint fell through (`fallbackFrom`).
 */
function endpointThrottle(reading) {
  if (!reading) return null;
  if (reading.source === 'endpoint' && reading.failureKind === RATE_LIMITED) {
    return { retryAfterSec: reading.retryAfterSec ?? null };
  }
  const hit = (reading.fallbackFrom || [])
    .find(f => f.source === 'endpoint' && f.failureKind === RATE_LIMITED);
  return hit ? { retryAfterSec: hit.retryAfterSec ?? null } : null;
}

function createRateLimitWatch({ cooldownMs = 60 * 60 * 1000 } = {}) {
  let episode = null;   // { startedAt, lastLimitedAt, affectedReads }
  const iso = (ms) => new Date(ms).toISOString();

  /** Feed one reading; returns the event it causes, or null. */
  function observe(reading, now = Date.now()) {
    const throttle = endpointThrottle(reading);
    if (throttle) {
      if (episode) {
        episode.lastLimitedAt = now;
        episode.affectedReads += 1;
        return null;
      }
      episode = { startedAt: now, lastLimitedAt: now, affectedReads: 1 };
      return {
        event: 'rate-limit-start',
        startedAt: iso(now),
        retryAfterSec: throttle.retryAfterSec,
        // Who kept the gauge alive meanwhile: the cache, the PTY, or nobody.
        servedBy: reading.success ? reading.source : null
      };
    }

    // Only a reading the endpoint itself answered can end an episode. A PTY or cache success
    // says nothing about the endpoint, and neither does a 401 or a timeout.
    const endpointAnswered = reading?.success === true && reading.source === 'endpoint';
    if (episode && endpointAnswered && now - episode.lastLimitedAt >= cooldownMs) {
      const ended = {
        event: 'rate-limit-end',
        startedAt: iso(episode.startedAt),
        lastLimitedAt: iso(episode.lastLimitedAt),
        endedAt: iso(now),
        affectedReads: episode.affectedReads
      };
      episode = null;
      return ended;
    }
    return null;
  }

  return {
    observe,
    get episode() { return episode ? { ...episode } : null; }
  };
}

/**
 * Run the operator's hook with the event on stdin. Resolves — never rejects — with how it went,
 * so a broken hook costs a log line and nothing else. Past `timeoutMs` the hook's whole process
 * group is killed, not just the shell, so a stuck `curl` inside a script cannot outlive it.
 */
function runNotifyCommand(command, event, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // A shell, because the command comes from the operator's config as one string
      // (`/path/to/script --flag`), the way cron and PM2 take it.
      child = spawn(command, { shell: true, detached: true, stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { child.kill('SIGKILL'); }
    }, timeoutMs);
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, timedOut, stderr: stderr.trim() });
    });
    // A hook that never reads stdin may close it before the write lands; that is its right.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(event) + '\n');
  });
}

module.exports = { createRateLimitWatch, endpointThrottle, runNotifyCommand, RATE_LIMITED };
