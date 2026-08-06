// Regression tests for transcript scanning and the session-metrics cache (issue #42).
// Dependency-free: `node test/session-scan.test.js`.
//
// The defect: a single `message.id` appears in several JSONL rows (successive snapshots
// of the same message), and the scanner summed every row — inflating fuel 2.6x on real
// data (45,354 usage rows vs 21,351 unique ids).
//
// Fixtures carry ONLY the fields the collector is allowed to read (timestamp,
// message.id, message.usage) — never conversation content.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  scanTranscript,
  collectSessions,
  SCHEMA_VERSION
} = require('../session-metrics');

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// --- fixtures ---------------------------------------------------------------------

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfuel-42-'));
const PROJECT = path.join(ROOT, '-home-tester-projects-demo');
fs.mkdirSync(PROJECT, { recursive: true });

const usage = (out, inp = 0, cc = 0, cr = 0) => ({
  output_tokens: out,
  input_tokens: inp,
  cache_creation_input_tokens: cc,
  cache_read_input_tokens: cr
});

const row = (ts, id, u) => JSON.stringify(
  id === null
    ? { timestamp: ts, message: { usage: u } }
    : { timestamp: ts, message: { id, usage: u } }
);

function fixture(name, rows) {
  const file = path.join(PROJECT, name);
  fs.writeFileSync(file, rows.join('\n') + '\n');
  return file;
}

// Same id, byte-identical usage repeated — the classic snapshot duplicate.
const IDENTICAL = fixture('identical.jsonl', [
  row('2026-08-01T10:00:00Z', 'msg_a', usage(100, 10, 5, 900)),
  row('2026-08-01T10:00:01Z', 'msg_a', usage(100, 10, 5, 900)),
  row('2026-08-01T10:00:02Z', 'msg_a', usage(100, 10, 5, 900))
]);

// Same id, usage growing as the message streams. The final snapshot is the complete one.
const GROWING = fixture('growing.jsonl', [
  row('2026-08-01T11:00:00Z', 'msg_b', usage(10, 4, 1)),
  row('2026-08-01T11:00:01Z', 'msg_b', usage(50, 4, 1)),
  row('2026-08-01T11:00:02Z', 'msg_b', usage(200, 4, 1))
]);

// Distinct ids — nothing to collapse.
const DISTINCT = fixture('distinct.jsonl', [
  row('2026-08-01T12:00:00Z', 'msg_c', usage(10)),
  row('2026-08-01T12:00:01Z', 'msg_d', usage(20)),
  row('2026-08-01T12:00:02Z', 'msg_e', usage(30))
]);

// No id at all: these cannot be deduplicated and must NOT collapse into one another.
const NO_ID = fixture('no-id.jsonl', [
  row('2026-08-01T13:00:00Z', null, usage(7)),
  row('2026-08-01T13:00:01Z', null, usage(11)),
  row('2026-08-01T13:00:02Z', null, usage(13))
]);

// Mixed: duplicates, a distinct id, and id-less rows in the same transcript.
const MIXED = fixture('mixed.jsonl', [
  row('2026-08-01T14:00:00Z', 'msg_f', usage(100)),
  row('2026-08-01T14:00:01Z', 'msg_f', usage(100)),
  row('2026-08-01T14:00:02Z', 'msg_g', usage(50)),
  row('2026-08-01T14:00:03Z', null, usage(9)),
  row('2026-08-01T14:00:04Z', null, usage(9))
]);

// --- deduplication ----------------------------------------------------------------

test('identical repeated snapshots count as ONE message', async () => {
  const r = await scanTranscript(IDENTICAL);
  return r.turns === 1 && r.fuel === 115;   // 100 + 10 + 5, cache_read excluded
});

test('a growing snapshot keeps the final, complete block', async () => {
  const r = await scanTranscript(GROWING);
  return r.turns === 1 && r.fuel === 205;   // 200 + 4 + 1, not 10+50+200
});

test('the kept block is one whole row, never a mix of fields', async () => {
  // Fuel of 205 is only reachable from the last row as a unit. Any field-wise max/sum
  // across rows would land elsewhere (e.g. 260 for summed outputs).
  const r = await scanTranscript(GROWING);
  return r.fuel === 205;
});

test('distinct ids are all counted', async () => {
  const r = await scanTranscript(DISTINCT);
  return r.turns === 3 && r.fuel === 60;
});

test('rows without an id do not collapse into each other', async () => {
  const r = await scanTranscript(NO_ID);
  return r.turns === 3 && r.fuel === 31;    // 7 + 11 + 13, all three kept
});

test('mixed transcript: dedup by id, id-less rows kept apart', async () => {
  const r = await scanTranscript(MIXED);
  // msg_f once (100) + msg_g (50) + two id-less rows (9 + 9) = 168 over 4 messages
  return r.turns === 4 && r.fuel === 168;
});

test('the span still comes from every row, not only the deduplicated ones', async () => {
  const r = await scanTranscript(IDENTICAL);
  return r.start === '2026-08-01T10:00:00Z' && r.end === '2026-08-01T10:00:02Z';
});

// --- cache versioning -------------------------------------------------------------

test('the module exposes a schema version', () =>
  typeof SCHEMA_VERSION === 'number' && SCHEMA_VERSION >= 2);

test('a fresh scan stamps records with the current schema version', async () => {
  const { byFile } = await collectSessions(ROOT, {});
  return Object.values(byFile).every(r => r.v === SCHEMA_VERSION);
});

test('records of the current version are reused (mtime/size unchanged)', async () => {
  const first = await collectSessions(ROOT, {});
  const second = await collectSessions(ROOT, first.byFile);
  return second.scan.rescanned === 0 && second.scan.reused === first.scan.files;
});

test('records from an OLDER schema version are rejected and rescanned', async () => {
  const first = await collectSessions(ROOT, {});
  const stale = {};
  for (const [k, v] of Object.entries(first.byFile)) stale[k] = { ...v, v: SCHEMA_VERSION - 1 };
  const second = await collectSessions(ROOT, stale);
  return second.scan.reused === 0 && second.scan.rescanned === first.scan.files;
});

test('records with NO version field are rejected (pre-versioning cache)', async () => {
  const first = await collectSessions(ROOT, {});
  const legacy = {};
  for (const [k, v] of Object.entries(first.byFile)) {
    const copy = { ...v };
    delete copy.v;
    legacy[k] = copy;
  }
  const second = await collectSessions(ROOT, legacy);
  return second.scan.reused === 0 && second.scan.rescanned === first.scan.files;
});

test('a rejected stale cache produces corrected, deduplicated values', async () => {
  // The whole point of the version gate: an inflated record must not survive a deploy.
  const inflated = {};
  inflated[IDENTICAL] = {
    id: 'identical', project: 'x', label: 'x',
    mtimeMs: fs.statSync(IDENTICAL).mtimeMs, size: fs.statSync(IDENTICAL).size,
    start: '2026-08-01T10:00:00Z', end: '2026-08-01T10:00:02Z',
    hours: 0, turns: 3, fuel: 345, events: 3, v: SCHEMA_VERSION - 1
  };
  const { byFile } = await collectSessions(ROOT, inflated);
  return byFile[IDENTICAL].fuel === 115 && byFile[IDENTICAL].turns === 1;
});

// --- run ---------------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      assert.ok(await fn(), name);
      console.log('  ok   ' + name);
    } catch (e) {
      failed++;
      console.error('  FAIL ' + name);
    }
  }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
