// The synthetic fixture must not depend on the hour it is built at. `node test/fixture-clock.test.js`.
//
// WHY THIS EXISTS: server-smoke asserted "a burn rate and a projection are derived", and the
// server derives both from the deltas of the last 6 hours. The fixture shaped its burn by the
// *local hour* (busy 09-20, quiet otherwise), so a build started at 05:00 local left that
// window empty: rate 0, projection null, `main` red — on the same commit that was green at
// 22:00. A red that depends on the clock trains people to merge over red (#53).
//
// This is the cheap half of the guard: pure functions, no server boot. The end-to-end half is
// in server-smoke, which runs the real thing against whatever hour it happens to be.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildFixture } = require('../scripts/synthetic-fixture');

const HOUR = 3600000;
const TZ = -5;

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: ok === true, detail });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfuel-fixture-clock-'));
const base = Date.now();

// Every hour of the day, walked from now. Whatever the wall clock says when the suite runs,
// one of these 24 builds lands on the window that used to come out empty.
const empty = [];
for (let h = 0; h < 24; h++) {
  const fx = buildFixture(path.join(tmp, `h${h}`), { now: base + h * HOUR, tzOffset: TZ });
  if (!(fx.rateWindowDelta > 0)) empty.push(`+${h}h → ${fx.rateWindowDelta}pp`);
}
check('the rate window holds burn at every hour of the day',
  empty.length === 0, empty.join(', '));

// The header of synthetic-fixture.js claims byte-identical output for the same `now`. It is
// what makes the smoke assert against known numbers, so it gets checked rather than trusted.
buildFixture(path.join(tmp, 'twinA'), { now: base, tzOffset: TZ });
buildFixture(path.join(tmp, 'twinB'), { now: base, tzOffset: TZ });
const differing = fs.readdirSync(path.join(tmp, 'twinA')).filter(f =>
  !fs.readFileSync(path.join(tmp, 'twinA', f)).equals(fs.readFileSync(path.join(tmp, 'twinB', f))));
check('the same `now` produces byte-identical files', differing.length === 0, differing.join(','));

fs.rmSync(tmp, { recursive: true, force: true });

let passed = 0;
for (const r of results) {
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}   ${r.name}${!r.ok && r.detail ? `  — ${r.detail}` : ''}`);
  if (r.ok) passed++;
}
console.log(`\n${passed}/${results.length} passed`);
assert.strictEqual(passed, results.length, 'fixture clock test failed');
