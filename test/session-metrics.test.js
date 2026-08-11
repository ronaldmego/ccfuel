// Regression tests for per-session fuel metrics (issue #39).
// Dependency-free: `node test/session-metrics.test.js`. Pure functions only — no disk.

const assert = require('assert');
const { turnFuel, projectLabel, aggregate, DEFAULT_MIN_FUEL } = require('../session-metrics');

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// --- fuel formula -----------------------------------------------------------------
// The four counters are disjoint. The bug this guards against is treating cache reads as
// a subset of input_tokens and subtracting them, which goes negative on real data.
const realTurn = {
  input_tokens: 184,
  output_tokens: 168165,
  cache_creation_input_tokens: 446496,
  cache_read_input_tokens: 14170955
};

test('fuel sums what burns quota and ignores cache reads', () =>
  turnFuel(realTurn) === 184 + 168165 + 446496);

test('fuel is never negative when cache reads dominate', () =>
  turnFuel(realTurn) > 0);

test('a cache-read-only turn burns nothing', () =>
  turnFuel({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 9000000 }) === 0);

test('missing counters are treated as zero', () =>
  turnFuel({ output_tokens: 10 }) === 10);

test('a missing usage block is zero, not a crash', () =>
  turnFuel(null) === 0 && turnFuel(undefined) === 0);

// --- project labels ---------------------------------------------------------------
// Slugs here are placeholders. A transcript directory name carries the user's real home path
// and project names, so fixtures in a public repo use invented ones.
test('strips the linux home prefix', () =>
  projectLabel('-home-user-projects-alpha') === 'alpha');

test('strips the macOS home prefix', () =>
  projectLabel('-Users-user-projects-ccfuel') === 'ccfuel');

test('keeps nesting below projects/', () =>
  projectLabel('-home-user-projects-products-beta') === 'products-beta');

test('leaves a non-home path readable', () =>
  projectLabel('-tmp-scratch-eval') === 'tmp-scratch-eval');

test('the home directory itself is labelled', () =>
  projectLabel('-home-user') === 'home');

test('an empty slug does not blow up', () =>
  projectLabel('') === 'unknown' && projectLabel(null) === 'unknown');

test('an over-long label is truncated', () =>
  projectLabel('-home-u-projects-' + 'x'.repeat(80)).length === 48);

// --- aggregation ------------------------------------------------------------------
const s = (id, label, end, fuel, hours = 1, turns = 10) =>
  ({ id, label, project: label, start: end, end, fuel, hours, turns });

const sessions = [
  s('a', 'alpha', '2026-08-05T10:00:00Z', 300000),
  s('b', 'alpha', '2026-08-05T12:00:00Z', 100000),
  s('c', 'ccfuel', '2026-08-05T13:00:00Z', 100000),
  s('noise', 'ccfuel', '2026-08-05T14:00:00Z', 500),      // under the cut
  s('old', 'alpha', '2026-07-01T10:00:00Z', 900000)      // before the window
];

const agg = aggregate(sessions, { since: '2026-08-04T05:00:00Z', minFuel: DEFAULT_MIN_FUEL });

test('sessions outside the window are excluded', () =>
  agg.totals.sessionsSeen === 4);

test('sessions under the fuel cut are excluded', () =>
  agg.totals.sessions === 3 && agg.totals.sessionsBelowCut === 1);

test('fuel below the cut is reported, not silently dropped', () =>
  agg.totals.belowCutFuel === 500);

test('total fuel counts only what survived the cut', () =>
  agg.totals.fuel === 500000);

test('projects are ranked by fuel', () =>
  agg.byProject[0].label === 'alpha' && agg.byProject[1].label === 'ccfuel');

test('project share is a percentage of the window total', () =>
  agg.byProject[0].share === 80 && agg.byProject[1].share === 20);

test('project session counts are per project', () =>
  agg.byProject[0].sessions === 2 && agg.byProject[1].sessions === 1);

test('top sessions are ranked by fuel', () =>
  agg.topSessions[0].id === 'a' && agg.topSessions[0].share === 60);

test('topN caps the session list', () =>
  aggregate(sessions, { since: '2026-08-04T05:00:00Z', topN: 1 }).topSessions.length === 1);

test('an empty window yields zeroes rather than NaN', () => {
  const empty = aggregate([], { since: '2026-08-04T05:00:00Z' });
  return empty.totals.fuel === 0 && empty.byProject.length === 0 && empty.totals.sessions === 0;
});

test('no window bound means everything counts', () =>
  aggregate(sessions, {}).totals.sessionsSeen === 5);

let failed = 0;
for (const [name, fn] of cases) {
  try {
    assert.ok(fn(), name);
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.error('  FAIL ' + name);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
