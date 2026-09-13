// Rate-limit episodes and the notify hook (#66). Dependency-free: `node test/rate-limit-watch.test.js`.
//
// Nothing here needs a Claude account or the network: the endpoint is a throwaway localhost
// server, the source chain runs on injected readers, and the hook is a one-line shell command.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { fetchUsageFromEndpoint, parseRetryAfter } = require('../usage-source');
const { getClaudeUsage } = require('../claude-usage');
const { createRateLimitWatch, endpointThrottle, runNotifyCommand } = require('../rate-limit-watch');

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();

// Readings shaped like getClaudeUsage() output.
const ok = (source) => ({ success: true, source, weekAll: { percent: 50 } });
const throttledBehind = (source, retryAfterSec = 618) => ({
  ...ok(source),
  fallbackFrom: [{ source: 'endpoint', failureKind: 'endpoint-rate-limited', retryAfterSec }]
});
const endpointFailedBehindPty = (failureKind) => ({
  ...ok('pty'), fallbackFrom: [{ source: 'endpoint', failureKind }]
});
const watch = () => createRateLimitWatch({ cooldownMs: 60 * MIN });

// --- the 429 itself ---------------------------------------------------------------------

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/api/oauth/usage`, close: () => server.close() });
    });
  });
}

const CREDS = { token: 'test-token-not-a-real-one', expiresAt: Date.now() + 60 * MIN };

test('a 429 is named as a rate limit and carries Retry-After', async () => {
  const s = await serve((req, res) => { res.writeHead(429, { 'Retry-After': '618' }); res.end('{}'); });
  try {
    const r = await fetchUsageFromEndpoint({ tzOffset: -5, url: s.url, credentials: CREDS });
    return r.success === false && r.failureKind === 'endpoint-rate-limited'
      && r.retryAfterSec === 618 && /429/.test(r.errorMessage);
  } finally { s.close(); }
});

test('a 429 without Retry-After is still a rate limit', async () => {
  const s = await serve((req, res) => { res.writeHead(429); res.end('{}'); });
  try {
    const r = await fetchUsageFromEndpoint({ tzOffset: -5, url: s.url, credentials: CREDS });
    return r.failureKind === 'endpoint-rate-limited' && r.retryAfterSec === null;
  } finally { s.close(); }
});

test('any other HTTP error stays endpoint-http-error', async () => {
  const s = await serve((req, res) => { res.writeHead(503); res.end('{}'); });
  try {
    const r = await fetchUsageFromEndpoint({ tzOffset: -5, url: s.url, credentials: CREDS });
    return r.failureKind === 'endpoint-http-error' && r.retryAfterSec === undefined;
  } finally { s.close(); }
});

test('Retry-After is read as seconds or as an HTTP date', () => {
  const now = Date.UTC(2026, 8, 13, 12, 0, 0);
  return parseRetryAfter('618') === 618
    && parseRetryAfter(new Date(now + 120000).toUTCString(), now) === 120
    && parseRetryAfter('soon') === null && parseRetryAfter(null) === null;
});

// --- the chain says what it fell through ------------------------------------------------

const failed = (source, failureKind, extra = {}) =>
  ({ success: false, source, failureKind, errorMessage: failureKind, ...extra });

test('a PTY success behind a throttled endpoint says so in fallbackFrom', async () => {
  const r = await getClaudeUsage(false, { source: 'auto', readers: {
    endpoint: async () => failed('endpoint', 'endpoint-rate-limited', { retryAfterSec: 618 }),
    cache: () => failed('cache', 'cache-stale'),
    pty: async () => ok('pty')
  } });
  return r.success === true && r.source === 'pty' && r.fallbackFrom.length === 2
    && r.fallbackFrom[0].failureKind === 'endpoint-rate-limited'
    && r.fallbackFrom[0].retryAfterSec === 618
    && endpointThrottle(r)?.retryAfterSec === 618;
});

test('a first-source success carries no fallbackFrom', async () => {
  const r = await getClaudeUsage(false, { source: 'auto', readers: {
    endpoint: async () => ok('endpoint'),
    cache: () => { throw new Error('must not be read'); },
    pty: async () => { throw new Error('must not be spawned'); }
  } });
  return r.success === true && r.fallbackFrom === undefined && endpointThrottle(r) === null;
});

test('a total failure behind a throttled endpoint is still seen as throttled', async () => {
  const r = await getClaudeUsage(false, { source: 'auto', readers: {
    endpoint: async () => failed('endpoint', 'endpoint-rate-limited', { retryAfterSec: 60 }),
    cache: () => failed('cache', 'cache-stale'),
    pty: async () => failed('pty', 'timeout')
  } });
  return r.success === false && r.failureKind === 'timeout'
    && endpointThrottle(r)?.retryAfterSec === 60;
});

// --- episodes ---------------------------------------------------------------------------

test('the first throttled read opens an episode and says who kept the gauge alive', () => {
  const e = watch().observe(throttledBehind('pty'), 0);
  return e?.event === 'rate-limit-start' && e.startedAt === iso(0)
    && e.retryAfterSec === 618 && e.servedBy === 'pty';
});

test('a throttled read nobody could cover reports servedBy null', () => {
  const r = { ...failed('pty', 'timeout'),
    fallbackFrom: [{ source: 'endpoint', failureKind: 'endpoint-rate-limited' }] };
  const e = watch().observe(r, 0);
  return e?.event === 'rate-limit-start' && e.servedBy === null && e.retryAfterSec === null;
});

test('more throttled reads inside the episode stay quiet', () => {
  const w = watch();
  w.observe(throttledBehind('pty'), 0);
  return w.observe(throttledBehind('pty'), 30 * MIN) === null && w.episode.affectedReads === 2;
});

test('a PTY or cache success does not close the episode — only the endpoint can', () => {
  const w = watch();
  w.observe(throttledBehind('pty'), 0);
  return w.observe(ok('pty'), 120 * MIN) === null
    && w.observe(ok('cache'), 150 * MIN) === null && w.episode !== null;
});

test('an endpoint that answers before the cooldown does not close it yet', () => {
  const w = watch();
  w.observe(throttledBehind('pty'), 0);
  return w.observe(ok('endpoint'), 30 * MIN) === null && w.episode !== null;
});

test('the episode closes once the endpoint has answered for a full cooldown', () => {
  const w = watch();
  w.observe(throttledBehind('pty'), 0);
  w.observe(throttledBehind('pty'), 30 * MIN);
  const e = w.observe(ok('endpoint'), 90 * MIN);
  return e?.event === 'rate-limit-end' && e.affectedReads === 2 && e.startedAt === iso(0)
    && e.lastLimitedAt === iso(30 * MIN) && e.endedAt === iso(90 * MIN) && w.episode === null;
});

test('a flapping endpoint is one episode: one start, one end', () => {
  const w = watch();
  const feed = [
    [throttledBehind('pty'), 0], [ok('endpoint'), 30], [throttledBehind('pty'), 60],
    [ok('endpoint'), 90], [ok('endpoint'), 120]
  ];
  const events = feed.map(([r, m]) => w.observe(r, m * MIN)).filter(Boolean).map(e => e.event);
  return JSON.stringify(events) === '["rate-limit-start","rate-limit-end"]';
});

test('a 401 or a timeout on the endpoint neither opens nor closes an episode', () => {
  const w = watch();
  const quietStart = w.observe(endpointFailedBehindPty('oauth-unauthorized'), 0) === null
    && w.episode === null;
  w.observe(throttledBehind('pty'), 10 * MIN);
  const quietEnd = w.observe(endpointFailedBehindPty('endpoint-timeout'), 200 * MIN) === null
    && w.episode !== null;
  return quietStart && quietEnd;
});

test('after an episode closes, the next throttled read announces again', () => {
  const w = watch();
  w.observe(throttledBehind('pty'), 0);
  w.observe(ok('endpoint'), 60 * MIN);
  return w.observe(throttledBehind('cache'), 200 * MIN)?.event === 'rate-limit-start';
});

// --- the hook ---------------------------------------------------------------------------

test('the hook gets the event as JSON on stdin', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccfuel-')), 'event.json');
  const event = { event: 'rate-limit-start', startedAt: iso(0), host: 'test-host' };
  const r = await runNotifyCommand(`cat > ${JSON.stringify(file)}`, event);
  const got = JSON.parse(fs.readFileSync(file, 'utf8'));
  return r.ok === true && got.event === 'rate-limit-start' && got.host === 'test-host';
});

test('a failing hook resolves with its exit code instead of throwing', async () => {
  const r = await runNotifyCommand('echo boom >&2; exit 3', { event: 'test' });
  return r.ok === false && r.code === 3 && r.stderr === 'boom';
});

test('a hung hook is killed at its timeout, children included', async () => {
  const t0 = Date.now();
  const r = await runNotifyCommand('sleep 5; true', { event: 'test' }, { timeoutMs: 300 });
  return r.ok === false && r.timedOut === true && Date.now() - t0 < 3000;
});

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
  assert.strictEqual(passed, cases.length, 'rate-limit watch tests failed');
})();
