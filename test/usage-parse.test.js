// Regression tests for the /usage parser. Dependency-free: `node test/usage-parse.test.js`.
//
// `claude-usage.js` is the data engine — without it every panel reads 0% — and until now it
// had no test at all: CI exercised the pure helpers and syntax-checked this file. The
// captures below are synthetic, with invented percentages: the real panel carries the
// account's actual quota figures and has no business in a public fixture.
//
// Dates are computed relative to the run, never hardcoded, so nothing here expires.

const assert = require('assert');
const { parseUsageOutput, stripAnsi, BLOCKERS } = require('../claude-usage');

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAY = 86400000;

/** A date a few days out, as the panel would print it ("Aug 18"). */
function futureDate(daysAhead) {
  const d = new Date(Date.now() + daysAhead * DAY);
  return { monthIdx: d.getUTCMonth(), day: d.getUTCDate(), label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` };
}

/**
 * What the parser should produce for a dated reset, following its own rules: the year is
 * taken from *now*, and a resulting instant that is already past is discarded (null).
 * Around the new year those two rules collide — see LIMITATIONS.md — and this mirrors that
 * instead of pretending it does not happen.
 */
function expectedDatedReset({ monthIdx, day }, hour24, tzOffset) {
  const ms = Date.UTC(new Date().getUTCFullYear(), monthIdx, day, hour24 - tzOffset, 0, 0);
  return ms <= Date.now() ? null : new Date(ms).toISOString();
}

// A capture shaped like the real panel: box drawing, ANSI cursor/colour noise, and the three
// sections. Percentages are made up.
function capture({ sessionPct = '37', weekAllPct = '62', weekSonnetPct = '21',
                   weekResetLabel = null, sessionReset = '5pm' } = {}) {
  const wr = weekResetLabel ? `Resets ${weekResetLabel}, 10am` : 'Resets 10am';
  return [
    '\x1b[?25l\x1b[?1049h\x1b[1;36m',
    '  Claude Code   /usage \x1b[0m',
    '\x1b[2K ────────────────────────────────────────',
    `\x1b[38;5;245m Current session \x1b[0m  ████████░░░░░░  ${sessionPct}% used   Resets ${sessionReset}`,
    `\x1b[38;5;245m Current week (all models) \x1b[0m  ██████░░░░░░░░  ${weekAllPct}% used   ${wr}`,
    `\x1b[38;5;245m Current week (Sonnet only) \x1b[0m  ██░░░░░░░░░░░░  ${weekSonnetPct}% used   ${wr}`,
    '\x1b[?25h'
  ].join('\r\n');
}

// --- happy path -------------------------------------------------------------------------

test('a full panel parses all three sections', () => {
  const r = parseUsageOutput(capture(), -5);
  return r.success === true
    && r.session.percent === 37
    && r.weekAll.percent === 62
    && r.weekSonnet.percent === 21;
});

test('extraUsage is reported as disabled when the panel does not mention it', () => {
  const r = parseUsageOutput(capture(), -5);
  return r.extraUsage.enabled === false && r.extraUsage.freeAvailable === 0;
});

test('rawClean is ANSI-stripped and bounded (debug only, never persisted)', () => {
  const r = parseUsageOutput(capture(), -5);
  return typeof r.rawClean === 'string'
    && r.rawClean.length <= 1500
    && !r.rawClean.includes('\x1b');
});

// --- the #35 distinction: a real 0% is not a failed read ---------------------------------

test('a real 0% weekly parses as 0 and still succeeds', () => {
  const r = parseUsageOutput(capture({ weekAllPct: '0' }), -5);
  return r.success === true && r.weekAll.percent === 0;
});

test('an unparseable weekly percent is null and fails the read', () => {
  const broken = capture().replace(/62% used/, '--% used');
  const r = parseUsageOutput(broken, -5);
  return r.success === false && r.weekAll.percent === null;
});

// The two gauges that keep a `?? 0` default for backwards compatibility. Worth pinning: it
// means "0%" from these two is not evidence of a real zero, unlike weekAll.
test('session and sonnet fall back to 0 when their section is missing (documented quirk)', () => {
  const r = parseUsageOutput(
    ' Current week (all models)  62% used  Resets 10am '
    + ' Current week (Sonnet only)  21% used  Resets 10am ', -5);
  return r.session.percent === 0 && r.success === true;
});

// --- section isolation ------------------------------------------------------------------

test('a mangled session section does not shift the weekly values', () => {
  const mangled = capture().replace(/37% used   Resets 5pm/, '?? used   Resets ??');
  const r = parseUsageOutput(mangled, -5);
  return r.weekAll.percent === 62 && r.weekSonnet.percent === 21;
});

// --- timezone: the offset is configuration, not a constant ------------------------------

test('a dated reset is lifted to UTC using the configured offset (-5)', () => {
  const d = futureDate(5);
  const r = parseUsageOutput(capture({ weekResetLabel: d.label }), -5);
  return r.weekAll.resetsAt === expectedDatedReset(d, 10, -5);
});

test('the same panel with a +2 offset yields a different instant', () => {
  const d = futureDate(5);
  const minus5 = parseUsageOutput(capture({ weekResetLabel: d.label }), -5).weekAll.resetsAt;
  const plus2 = parseUsageOutput(capture({ weekResetLabel: d.label }), 2).weekAll.resetsAt;
  if (minus5 === null || plus2 === null) return true; // year-rollover window; see LIMITATIONS
  return new Date(minus5) - new Date(plus2) === 7 * 3600000;
});

test('the reset hour is kept in 24h form (5pm -> 17)', () => {
  const r = parseUsageOutput(capture({ sessionReset: '5pm' }), -5);
  return r.session.resetsAtHour === 17;
});

test('midnight and noon convert correctly (12am -> 0, 12pm -> 12)', () => {
  const am = parseUsageOutput(capture({ sessionReset: '12am' }), -5).session.resetsAtHour;
  const pm = parseUsageOutput(capture({ sessionReset: '12pm' }), -5).session.resetsAtHour;
  return am === 0 && pm === 12;
});

test('a bare hour with no date resolves to the next occurrence in the configured zone', () => {
  const tz = -5;
  const r = parseUsageOutput(capture({ sessionReset: '2am' }), tz);
  if (!r.session.resetsAt) return false;
  const at = new Date(r.session.resetsAt);
  const localHour = new Date(at.getTime() + tz * 3600000).getUTCHours();
  return at.getTime() > Date.now() && localHour === 2;
});

test('minutes are preserved when the panel prints them (4:59pm)', () => {
  const r = parseUsageOutput(capture({ sessionReset: '4:59pm' }), -5);
  return r.session.resetsAtHour === 16 && new Date(r.session.resetsAt).getUTCMinutes() === 59;
});

// --- failure shapes ---------------------------------------------------------------------

test('empty output fails cleanly instead of throwing', () => {
  const r = parseUsageOutput('', -5);
  return r.success === false && r.weekAll.percent === null;
});

test('unrelated terminal noise fails cleanly', () => {
  const r = parseUsageOutput('\x1b[2J\x1b[H some banner text with no panel at all', -5);
  return r.success === false;
});

test('one section alone is not enough to call the read a success', () => {
  const r = parseUsageOutput(' Current session  40% used  Resets 5pm ', -5);
  return r.success === false;
});

// --- blockers: the two boot states that used to look like a plain timeout ---------------

const TRUST_SCREEN = '\x1b[?25l ──────────── Accessing workspace: /tmp/example \r\n'
  + ' Quick safety check: Is this a project you created or one you trust? \r\n'
  + ' ❯ 1. Yes, I trust this folder   2. No, exit \r\n';

test('the trust prompt is recognised as a blocker', () => {
  const b = BLOCKERS.find(x => x.kind === 'trust-prompt');
  return !!b && b.test.test(stripAnsi(TRUST_SCREEN));
});

test('the trust screen carries no parseable usage, so the read is a failure', () => {
  const r = parseUsageOutput(TRUST_SCREEN, -5);
  return r.success === false;
});

test('a login wall is recognised as a distinct blocker', () => {
  const b = BLOCKERS.find(x => x.kind === 'login-required');
  return !!b && b.test.test(stripAnsi('\x1b[31m Not logged in · Please run /login \x1b[0m'));
});

test('a normal panel trips no blocker', () => {
  const clean = stripAnsi(capture());
  return BLOCKERS.every(b => !b.test.test(clean));
});

// --- ANSI stripping ---------------------------------------------------------------------

// Escapes become spaces rather than being deleted, so the result is collapsed but not
// trimmed. The regexes downstream all tolerate surrounding whitespace.
test('stripAnsi removes escapes and collapses whitespace', () => {
  const out = stripAnsi('\x1b[1;36mA\x1b[0m\r\n\r\n   B\x1b]0;title\x07C');
  return !out.includes('\x1b') && out === ' A B C' && out.trim() === 'A B C';
});

// --- run --------------------------------------------------------------------------------

let passed = 0;
for (const [name, fn] of cases) {
  let ok = false;
  let err = null;
  try { ok = fn() === true; } catch (e) { err = e; }
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}   ${name}${err ? `  — threw: ${err.message}` : ''}`);
  if (ok) passed++;
}
console.log(`\n${passed}/${cases.length} passed`);
assert.strictEqual(passed, cases.length, 'usage parser tests failed');
