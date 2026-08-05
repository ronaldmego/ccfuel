// Regression tests for the weekly reset cycle guard (issue #37).
// Dependency-free: `node test/reset-cycle.test.js`. Time is injected, so these are
// deterministic — they do not depend on when they run.

const assert = require('assert');
const { isPlausibleWeeklyReset } = require('../reset-cycle');

const H = 60 * 60 * 1000;
const D = 24 * H;
const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

// The anchor we hold: this cycle resets in 3 days.
const anchor = iso(NOW + 3 * D);

const cases = [
  ['same reset is credible',
    () => isPlausibleWeeklyReset(anchor, anchor, NOW) === true],

  // The bug this guards: a saturated PTY parses the reset one day off, which shifts
  // weekId and makes filterAnomalies accept an anomalous drop as a new cycle.
  ['a day-shifted read is rejected (the flicker)',
    () => isPlausibleWeeklyReset(iso(NOW + 2 * D), anchor, NOW) === false],
  ['a day-shifted read the other way is rejected',
    () => isPlausibleWeeklyReset(iso(NOW + 4 * D), anchor, NOW) === false],

  ['sub-tolerance jitter is absorbed',
    () => isPlausibleWeeklyReset(iso(NOW + 3 * D + H), anchor, NOW) === true],

  // A rollover is only ever read after the previous reset passed — /usage never reports
  // the next cycle while the current one is still ahead.
  ['a rollover read after the anchor expired re-anchors',
    () => isPlausibleWeeklyReset(iso(NOW + 6 * D), iso(NOW - H), NOW) === true],
  ['while the anchor holds, a full cycle ahead is impossible',
    () => isPlausibleWeeklyReset(iso(NOW + 10 * D), anchor, NOW) === false],

  ['a past reset is rejected',
    () => isPlausibleWeeklyReset(iso(NOW - D), anchor, NOW) === false],
  ['further out than one cycle is rejected',
    () => isPlausibleWeeklyReset(iso(NOW + 9 * D), anchor, NOW) === false],
  ['no anchor yet => the read bootstraps the cycle',
    () => isPlausibleWeeklyReset(anchor, null, NOW) === true],
  ['an expired anchor is re-anchored',
    () => isPlausibleWeeklyReset(anchor, iso(NOW - 30 * D), NOW) === true],
  ['an unparseable candidate is rejected',
    () => isPlausibleWeeklyReset('not-a-date', anchor, NOW) === false],
  ['a null candidate is rejected',
    () => isPlausibleWeeklyReset(null, anchor, NOW) === false],
];

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
