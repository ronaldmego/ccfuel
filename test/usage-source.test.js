// The non-interactive usage sources. Dependency-free: `node test/usage-source.test.js`.
//
// These cover the path that replaced the PTY as the default reader (#55), plus the guard
// that stops the PTY fallback from ever submitting a prompt. Every percentage here is
// invented, and the endpoint case talks to a throwaway localhost server — nothing in this
// file needs a Claude account, a token, or the network.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { mapUtilization, fetchUsageFromEndpoint, readCachedUtilization, snapToMinute } = require('../usage-source');
const { isDoubledUsageInput } = require('../claude-usage');

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();

/** A payload shaped like /api/oauth/usage, with resets a fixed distance from `now`. */
function payload(now, { five = 41.4, seven = 58.6, sonnet = null, extra = false } = {}) {
  // Minute-aligned, so the assertions can compare instants exactly (the mapper snaps, see #59).
  const at = (offset) => iso(snapToMinute(now) + offset);
  return {
    five_hour: { utilization: five, resets_at: at(2 * HOUR) },
    seven_day: { utilization: seven, resets_at: at(50 * HOUR) },
    seven_day_sonnet: sonnet == null ? null : { utilization: sonnet, resets_at: at(50 * HOUR) },
    extra_usage: { is_enabled: extra }
  };
}

// --- mapping ----------------------------------------------------------------------------

test('maps the three gauges and rounds the percentages', () => {
  const now = Date.now();
  const r = mapUtilization(payload(now, { sonnet: 9.5 }), { tzOffset: -5, now });
  return r.success === true && r.source === 'endpoint'
    && r.session.percent === 41 && r.weekAll.percent === 59 && r.weekSonnet.percent === 10;
});

test('resetsAt is an instant, resetsAtHour is that instant in the display zone', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  const r = mapUtilization(payload(now), { tzOffset: -5, now });
  // now + 2h = 14:00 UTC = 09:00 at UTC-5.
  return r.session.resetsAt === iso(now + 2 * HOUR) && r.session.resetsAtHour === 9;
});

// #59: the API jitters either side of the boundary, and at UTC−5 a hair before midnight UTC
// belongs to the previous day. Both readings of the same reset must render identically.
test('sub-second jitter around the boundary does not flip the day or the hour', () => {
  const now = Date.UTC(2026, 7, 29, 12, 0, 0);
  const midnightUtc5 = Date.UTC(2026, 8, 1, 5, 0, 0);   // Sep 1, 12:00am at UTC-5
  const read = (resets_at) => mapUtilization(
    { seven_day: { utilization: 60, resets_at } }, { tzOffset: -5, now }).weekAll;

  const late = read(new Date(midnightUtc5 + 287).toISOString());
  const early = read(new Date(midnightUtc5 - 7).toISOString());

  return late.resetsAt === early.resetsAt
    && late.resetsAt === new Date(midnightUtc5).toISOString()
    && late.resetsAtHour === 0 && early.resetsAtHour === 0;
});

test('snapToMinute rounds to the nearest minute, both directions', () =>
  snapToMinute(Date.UTC(2026, 0, 1, 5, 0, 0, 287)) === Date.UTC(2026, 0, 1, 5, 0, 0)
  && snapToMinute(Date.UTC(2026, 0, 1, 4, 59, 59, 993)) === Date.UTC(2026, 0, 1, 5, 0, 0)
  && snapToMinute(Date.UTC(2026, 0, 1, 5, 0, 29, 0)) === Date.UTC(2026, 0, 1, 5, 0, 0)
  && snapToMinute(Date.UTC(2026, 0, 1, 5, 0, 31, 0)) === Date.UTC(2026, 0, 1, 5, 1, 0));

test('a reset already in the past is dropped rather than shown as a negative countdown', () => {
  const now = Date.now();
  const p = payload(now);
  p.five_hour.resets_at = iso(now - HOUR);
  const r = mapUtilization(p, { tzOffset: -5, now });
  return r.session.resetsAt === null && r.session.resetsAtHour === null && r.session.percent === 41;
});

test('no weekly percent means no usable snapshot (same contract as the PTY parser)', () => {
  const now = Date.now();
  const p = payload(now);
  p.seven_day = null;
  const r = mapUtilization(p, { tzOffset: -5, now });
  return r.success === false && r.weekAll.percent === null;
});

test('a real 0% is a reading, not a failure', () => {
  const now = Date.now();
  const r = mapUtilization(payload(now, { five: 0, seven: 0 }), { tzOffset: -5, now });
  return r.success === true && r.weekAll.percent === 0;
});

test('extra usage reflects is_enabled', () => {
  const now = Date.now();
  const on = mapUtilization(payload(now, { extra: true }), { tzOffset: -5, now });
  const off = mapUtilization(payload(now), { tzOffset: -5, now });
  return on.extraUsage.enabled === true && off.extraUsage.enabled === false;
});

// --- Claude Code's own cache ------------------------------------------------------------

function writeClaudeJson(fetchedAtMs, now) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccfuel-')), 'claude.json');
  fs.writeFileSync(file, JSON.stringify({
    cachedUsageUtilization: { fetchedAtMs, utilization: payload(now) }
  }));
  return file;
}

test('a fresh cache is served, timestamped when Claude Code read it — not now', () => {
  const now = Date.now();
  const fetchedAtMs = now - 10 * 60000;
  const r = readCachedUtilization({ tzOffset: -5, now, filePath: writeClaudeJson(fetchedAtMs, now) });
  return r.success === true && r.source === 'cache'
    && r.timestamp === iso(fetchedAtMs) && r.cacheAgeMs === 10 * 60000;
});

test('a cache older than the max age is refused, not passed off as live', () => {
  const now = Date.now();
  const r = readCachedUtilization({
    tzOffset: -5, now, maxAgeMs: 30 * 60000, filePath: writeClaudeJson(now - 90 * 60000, now)
  });
  return r.success === false && r.failureKind === 'cache-stale' && /90 min old/.test(r.errorMessage);
});

test('a missing file fails by name instead of throwing', () => {
  const r = readCachedUtilization({ tzOffset: -5, filePath: path.join(os.tmpdir(), 'ccfuel-nope.json') });
  return r.success === false && r.failureKind === 'cache-unreadable';
});

test('a file without cachedUsageUtilization is reported as absent, not stale', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccfuel-')), 'claude.json');
  fs.writeFileSync(file, JSON.stringify({ numStartups: 3 }));
  const r = readCachedUtilization({ tzOffset: -5, filePath: file });
  return r.success === false && r.failureKind === 'cache-absent';
});

// --- the endpoint -----------------------------------------------------------------------

/** A throwaway server standing in for api.anthropic.com. */
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/api/oauth/usage`, close: () => server.close() });
    });
  });
}

const CREDS = { token: 'test-token-not-a-real-one', expiresAt: Date.now() + HOUR };

test('a 200 is mapped, tagged as the endpoint, and carries the bearer token', async () => {
  const now = Date.now();
  let auth = null;
  const s = await serve((req, res) => {
    auth = req.headers.authorization;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload(now)));
  });
  try {
    const r = await fetchUsageFromEndpoint({ tzOffset: -5, url: s.url, credentials: CREDS });
    return r.success === true && r.source === 'endpoint' && r.weekAll.percent === 59
      && auth === `Bearer ${CREDS.token}`;
  } finally { s.close(); }
});

test('a 401 is named as an auth failure, not a generic error', async () => {
  const s = await serve((req, res) => { res.writeHead(401); res.end('{}'); });
  try {
    const r = await fetchUsageFromEndpoint({ tzOffset: -5, url: s.url, credentials: CREDS });
    return r.success === false && r.failureKind === 'oauth-unauthorized';
  } finally { s.close(); }
});

test('an expired stored token says so in the message', async () => {
  const s = await serve((req, res) => { res.writeHead(401); res.end('{}'); });
  try {
    const r = await fetchUsageFromEndpoint({
      tzOffset: -5, url: s.url, credentials: { token: 'x', expiresAt: Date.now() - HOUR }
    });
    return r.success === false && /past its expiry/.test(r.errorMessage);
  } finally { s.close(); }
});

test('a hung endpoint gives up on its own timeout', async () => {
  const s = await serve(() => { /* never answers */ });
  try {
    const r = await fetchUsageFromEndpoint({ tzOffset: -5, url: s.url, credentials: CREDS, timeoutMs: 300 });
    return r.success === false && r.failureKind === 'endpoint-timeout';
  } finally { s.close(); }
});

test('a 200 without a weekly figure is a failure, not a 0% reading', async () => {
  const now = Date.now();
  const s = await serve((req, res) => {
    const p = payload(now); p.seven_day = null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(p));
  });
  try {
    const r = await fetchUsageFromEndpoint({ tzOffset: -5, url: s.url, credentials: CREDS });
    return r.success === false && r.failureKind === 'endpoint-no-weekly';
  } finally { s.close(); }
});

// --- the guard that keeps the PTY fallback from submitting a prompt (#55) ----------------

test('a single echoed /usage is not doubled', () =>
  isDoubledUsageInput('\x1b[1m ❯ /usage \x1b[0m') === false);

test('two concatenated /usage are caught — this is what got submitted as a prompt', () =>
  isDoubledUsageInput('❯ /usage/usage') === true);

test('the slash-command menu is not mistaken for a doubled input', () =>
  isDoubledUsageInput('/usage Show session cost, plan usage, and activity stats '
    + '/usage-credits Configure usage credits ❯ /usage') === false);

test('a doubled line that has since been cleared no longer blocks the fetch', () =>
  isDoubledUsageInput('❯ /usage/usage' + ' x'.repeat(500) + ' ❯ /usage') === false);

test('after a clear+retype the stale doubled text no longer counts', () =>
  isDoubledUsageInput('❯ /usage/usage \x1b[2K ❯ /usage') === false);

// --- run --------------------------------------------------------------------------------

(async () => {
  let passed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    let err = null;
    try { ok = (await fn()) === true; } catch (e) { err = e; }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}   ${name}${err ? `  — threw: ${err.message}` : ''}`);
    if (ok) passed++;
  }
  console.log(`\n${passed}/${cases.length} passed`);
  assert.strictEqual(passed, cases.length, 'usage source tests failed');
})();
