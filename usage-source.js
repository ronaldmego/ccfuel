// Non-interactive readers for Claude Code's plan usage.
//
// Claude Code does not compute the numbers `/usage` prints: it asks the account for them
// (GET /api/oauth/usage) and caches the reply verbatim in ~/.claude.json under
// `cachedUsageUtilization`. Both carry the same JSON shape, so one mapper serves both.
//
// Reading them directly is what this file is for, and it is strictly better than driving the
// TUI: no PTY, no Claude Code session, no Remote Control entry, no plan quota spent, no 35 s
// timeout, no ANSI to parse, and no timezone to guess — `resets_at` is already an instant.
// The PTY path in claude-usage.js stays as the last-resort fallback for hosts where neither
// source can be read (see README, "Where the numbers come from").
//
// Credentials: the OAuth token is READ, never written, never logged, and never sent anywhere
// but the Anthropic API it already belongs to. `claude` refreshes it on its own schedule; an
// expired one simply fails over to the next source.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// The cached copy is only as fresh as the last Claude Code session that asked for it, so a
// stale one is worse than useless: it looks like a live reading. Booting `claude` does NOT
// refresh it (measured: 25 s of an idle session left the timestamp untouched) — only an
// actual /usage read does.
const CACHE_MAX_AGE_MS = parseInt(process.env.DASHBOARD_USAGE_CACHE_MAX_AGE_MIN || '30', 10) * 60 * 1000;

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const CLAUDE_JSON_PATH = path.join(os.homedir(), '.claude.json');
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * The account's OAuth access token, or null when it cannot be read.
 *
 * Linux/WSL keep it in ~/.claude/.credentials.json; macOS keeps it in the login Keychain,
 * which only answers while the keychain is unlocked — a headless Mac legitimately returns
 * null here and falls through to the next source.
 */
function readOAuthToken() {
  const fromFile = (raw) => {
    try {
      const creds = JSON.parse(raw)?.claudeAiOauth;
      if (!creds?.accessToken) return null;
      return { token: creds.accessToken, expiresAt: creds.expiresAt ?? null };
    } catch (_) { return null; }
  };

  try {
    return fromFile(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  } catch (_) { /* fall through to the Keychain */ }

  if (process.platform !== 'darwin') return null;
  try {
    const raw = execFileSync('security',
      ['find-generic-password', '-a', os.userInfo().username, '-w', '-s', KEYCHAIN_SERVICE],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return fromFile(raw);
  } catch (_) { return null; }
}

/** Hour of the day the instant falls on, in the zone the dashboard displays. */
function localHour(ms, tzOffset) {
  return new Date(ms + tzOffset * 60 * 60 * 1000).getUTCHours();
}

// The API returns `resets_at` with microsecond precision, and not always on the same side of
// the minute: `05:00:00.287494Z` on one read, `04:59:59.993000Z` on the next. Quota windows
// roll on whole minutes, so that tail is noise — and not harmless noise: at UTC−5,
// `04:59:59.993Z` is 23:59 of the *previous day*, which flips the printed label, the hour and
// the cycle range the dashboard draws (#59). Snapping to the nearest minute makes two reads
// of the same reset render identically, and matches what the /usage panel prints.
const MINUTE_MS = 60000;
function snapToMinute(ms) {
  return Math.round(ms / MINUTE_MS) * MINUTE_MS;
}

function mapSection(entry, tzOffset, now) {
  if (!entry || entry.utilization == null) {
    return { percent: null, resetsAtHour: null, resetsAt: null };
  }
  let resetsAt = null;
  let resetsAtHour = null;
  if (entry.resets_at) {
    const at = new Date(entry.resets_at);
    // A reset already in the past is a window that has just rolled; the next reading carries
    // the new one. Reporting it would render as a negative countdown, so drop it — the same
    // rule the PTY parser applies.
    if (!Number.isNaN(at.getTime()) && at.getTime() > now) {
      const ms = snapToMinute(at.getTime());
      resetsAt = new Date(ms).toISOString();
      resetsAtHour = localHour(ms, tzOffset);
    }
  }
  return { percent: Math.round(entry.utilization), resetsAtHour, resetsAt };
}

/**
 * Turn an /api/oauth/usage payload (or the identical `cachedUsageUtilization.utilization`
 * object) into the shape the rest of ccfuel consumes.
 *
 * @param {object} payload  the API response
 * @param {object} opts     { tzOffset, now, source }
 */
function mapUtilization(payload, { tzOffset, now = Date.now(), source = 'endpoint' } = {}) {
  const session = mapSection(payload?.five_hour, tzOffset, now);
  const weekAll = mapSection(payload?.seven_day, tzOffset, now);
  const weekSonnet = mapSection(payload?.seven_day_sonnet, tzOffset, now);

  return {
    // Same contract as the PTY parser: without a weekly percent there is no usable snapshot.
    success: weekAll.percent != null,
    source,
    timestamp: new Date(now).toISOString(),
    session: { ...session, percent: session.percent ?? 0 },
    weekAll,
    weekSonnet: { ...weekSonnet, percent: weekSonnet.percent ?? 0 },
    extraUsage: {
      enabled: payload?.extra_usage?.is_enabled === true,
      // The panel's "$N free" line has no equivalent in this payload (extra_usage carries a
      // paid budget, not a promotional grant), so the badge stays off on this path rather
      // than inventing a number. See LIMITATIONS.md.
      freeAvailable: 0
    }
  };
}

function failure(kind, message, source) {
  return {
    success: false,
    source,
    failureKind: kind,
    errorMessage: message,
    timestamp: new Date().toISOString(),
    session: { percent: 0, resetsAtHour: null, resetsAt: null },
    weekAll: { percent: null, resetsAtHour: null, resetsAt: null },
    weekSonnet: { percent: 0, resetsAtHour: null, resetsAt: null },
    extraUsage: { enabled: false, freeAvailable: 0 }
  };
}

/** Live read from the account. Costs no plan quota and starts no session. */
async function fetchUsageFromEndpoint({
  tzOffset,
  timeoutMs = 10000,
  url = USAGE_URL,
  credentials = null   // injectable so the tests can exercise this without a real account
} = {}) {
  const creds = credentials || readOAuthToken();
  if (!creds) {
    return failure('no-oauth-token',
      `No Claude Code OAuth token to read (looked in ${CREDENTIALS_PATH}`
      + (process.platform === 'darwin' ? ` and the "${KEYCHAIN_SERVICE}" Keychain item).` : ').')
      + ' Run `claude` and complete /login, or set DASHBOARD_USAGE_SOURCE=pty.',
      'endpoint');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    });
    if (!res.ok) {
      const expired = creds.expiresAt != null && creds.expiresAt < Date.now();
      return failure(res.status === 401 ? 'oauth-unauthorized' : 'endpoint-http-error',
        `${url} answered HTTP ${res.status}`
        + (expired ? ' (the stored token is past its expiry — open Claude Code once to refresh it).' : '.'),
        'endpoint');
    }
    const payload = await res.json();
    const mapped = mapUtilization(payload, { tzOffset, source: 'endpoint' });
    if (!mapped.success) {
      return failure('endpoint-no-weekly',
        'The usage endpoint answered without a seven_day utilization.', 'endpoint');
    }
    return mapped;
  } catch (e) {
    const aborted = e.name === 'AbortError';
    return failure(aborted ? 'endpoint-timeout' : 'endpoint-unreachable',
      aborted ? `No answer from ${url} within ${timeoutMs} ms.` : `${url}: ${e.message}`,
      'endpoint');
  }
}

/**
 * Claude Code's own cached copy of the same payload. No credentials, no network — but only
 * as fresh as the last session that read /usage, so anything older than the max age is
 * refused instead of served as if it were live.
 */
function readCachedUtilization({
  tzOffset,
  maxAgeMs = CACHE_MAX_AGE_MS,
  now = Date.now(),
  filePath = CLAUDE_JSON_PATH   // injectable for the tests
} = {}) {
  let cached;
  try {
    cached = JSON.parse(fs.readFileSync(filePath, 'utf8'))?.cachedUsageUtilization;
  } catch (e) {
    return failure('cache-unreadable', `${filePath}: ${e.message}`, 'cache');
  }
  if (!cached?.utilization || typeof cached.fetchedAtMs !== 'number') {
    return failure('cache-absent',
      `${filePath} carries no cachedUsageUtilization yet.`, 'cache');
  }
  const ageMs = now - cached.fetchedAtMs;
  if (ageMs > maxAgeMs) {
    return failure('cache-stale',
      `Claude Code's cached usage is ${Math.round(ageMs / 60000)} min old `
      + `(max ${Math.round(maxAgeMs / 60000)}).`, 'cache');
  }
  const mapped = mapUtilization(cached.utilization, { tzOffset, now, source: 'cache' });
  if (!mapped.success) {
    return failure('cache-no-weekly',
      'The cached utilization carries no seven_day percent.', 'cache');
  }
  // The reading is as old as the cache, not as old as this call.
  mapped.timestamp = new Date(cached.fetchedAtMs).toISOString();
  mapped.cacheAgeMs = ageMs;
  return mapped;
}

module.exports = {
  mapUtilization,
  snapToMinute,
  fetchUsageFromEndpoint,
  readCachedUtilization,
  readOAuthToken,
  USAGE_URL,
  CACHE_MAX_AGE_MS,
  CREDENTIALS_PATH,
  CLAUDE_JSON_PATH
};
