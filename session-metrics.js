// Per-session fuel metrics from Claude Code transcripts (issue #39).
//
// The /usage gauge answers "how much of my quota is gone". It cannot answer "what
// burned it" — that lives in the local session transcripts, one JSONL per session at
// ~/.claude/projects/<project-slug>/<session-id>.jsonl.
//
// PRIVACY (blocking constraint for an OSS tool): transcripts contain the full
// conversation. This collector reads ONLY `timestamp` and `message.usage.*`, and never
// persists or serves message text. Nothing here should ever be relaxed to "just grab the
// first user message for a label" — the session id and project slug are the only labels.
//
// FUEL: the four token counters in the Anthropic API are DISJOINT, not nested.
// `cache_read_input_tokens` is not a subset of `input_tokens`, so the quota-burning
// total is a SUM of what costs, never `input - cache_read` (that mixes disjoint counters
// and goes negative — measured at -9.45e9 across 1778 real sessions, negative in 40% of
// them). Cache reads are ~96% of all tokens and are excluded because they don't burn
// quota; cache *creation* does.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Sessions under this many fuel tokens are noise: aborted starts and one-shot `claude -p`
// invocations. Measured over 1778 real sessions, this cut discards 63% of the files and
// still retains 99.95% of all fuel.
const DEFAULT_MIN_FUEL = 10000;

/** Quota-burning tokens for one assistant turn's `usage` block. */
function turnFuel(usage) {
  if (!usage) return 0;
  return (usage.output_tokens || 0)
    + (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0);
}

/**
 * Human-readable label for a transcript directory slug.
 * Claude Code mangles the project path into the directory name ('/' -> '-'), which is not
 * losslessly reversible, so this trims the noisy prefixes rather than trying to rebuild
 * the path. It also keeps local filesystem layout out of the UI.
 */
function projectLabel(slug) {
  if (!slug) return 'unknown';
  let s = String(slug)
    .replace(/^-home-[^-]+-?/, '')   // -home-<user>-...
    .replace(/^-Users-[^-]+-?/, '')  // macOS
    .replace(/^-+/, '');
  s = s.replace(/^projects-/, '');
  if (!s) return 'home';
  return s.length > 48 ? s.slice(0, 47) + '…' : s;
}

/**
 * Scan one transcript. Returns null when the file carries no timestamp at all.
 * Streams line by line — transcripts reach hundreds of MB in aggregate.
 */
async function scanTranscript(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity
  });

  let start = null, end = null, turns = 0, fuel = 0, events = 0;

  for await (const line of rl) {
    if (!line) continue;
    events++;

    // Cheap regex first: parsing every line as JSON over ~670 MB is wasteful.
    const tm = line.match(/"timestamp":"([^"]+)"/);
    if (tm) {
      if (!start || tm[1] < start) start = tm[1];
      if (!end || tm[1] > end) end = tm[1];
    }

    if (line.indexOf('"usage"') === -1) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch (_) { continue; }
    const usage = parsed && parsed.message && parsed.message.usage;
    if (!usage) continue;
    turns++;
    fuel += turnFuel(usage);
  }

  if (!start) return null;

  return {
    start,
    end,
    hours: Math.round(((Date.parse(end) - Date.parse(start)) / 3600000) * 100) / 100,
    turns,
    events,
    fuel
  };
}

/**
 * Walk the transcript root, reusing cached records for files whose mtime and size are
 * unchanged. A cold pass over ~1800 sessions reads ~670 MB and takes ~45 s, so the
 * incremental path is what makes this cheap enough to run on a schedule.
 */
async function collectSessions(root, previous = {}) {
  const byFile = {};
  let rescanned = 0, reused = 0;
  const startedAt = Date.now();

  let projectDirs;
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch (_) {
    return { sessions: [], scan: { files: 0, rescanned: 0, reused: 0, durationMs: 0 } };
  }

  for (const dir of projectDirs) {
    const projectPath = path.join(root, dir.name);
    let files;
    try { files = fs.readdirSync(projectPath); } catch (_) { continue; }

    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(projectPath, name);

      let stat;
      try { stat = fs.statSync(file); } catch (_) { continue; }

      const cached = previous[file];
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        byFile[file] = cached;
        reused++;
        continue;
      }

      let record;
      try { record = await scanTranscript(file); } catch (_) { continue; }
      rescanned++;
      if (!record) continue;

      byFile[file] = {
        id: name.replace(/\.jsonl$/, ''),
        project: dir.name,
        label: projectLabel(dir.name),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        ...record
      };
    }
  }

  return {
    sessions: Object.values(byFile),
    byFile,
    scan: {
      files: Object.keys(byFile).length,
      rescanned,
      reused,
      durationMs: Date.now() - startedAt
    }
  };
}

/**
 * Aggregate sessions into the "what burned it" view.
 * `since`/`until` are ISO strings; a session counts when it *ended* inside the window,
 * which keeps a long-running session attributed to the cycle it finished in rather than
 * splitting it across two.
 */
function aggregate(sessions, { since = null, until = null, minFuel = DEFAULT_MIN_FUEL, topN = 15 } = {}) {
  const sinceMs = since ? Date.parse(since) : -Infinity;
  const untilMs = until ? Date.parse(until) : Infinity;

  const inWindow = sessions.filter(s => {
    const endMs = Date.parse(s.end);
    return endMs >= sinceMs && endMs <= untilMs;
  });

  const kept = inWindow.filter(s => s.fuel >= minFuel);
  const totalFuel = kept.reduce((a, s) => a + s.fuel, 0);
  // Fuel below the cut, reported so the panel never silently hides consumption.
  const belowCutFuel = inWindow.reduce((a, s) => a + s.fuel, 0) - totalFuel;

  const projects = {};
  for (const s of kept) {
    if (!projects[s.label]) projects[s.label] = { label: s.label, fuel: 0, sessions: 0, hours: 0 };
    projects[s.label].fuel += s.fuel;
    projects[s.label].sessions++;
    projects[s.label].hours += s.hours;
  }

  const byProject = Object.values(projects)
    .map(p => ({
      ...p,
      hours: Math.round(p.hours * 10) / 10,
      share: totalFuel ? Math.round((1000 * p.fuel) / totalFuel) / 10 : 0
    }))
    .sort((a, b) => b.fuel - a.fuel);

  const topSessions = kept
    .slice()
    .sort((a, b) => b.fuel - a.fuel)
    .slice(0, topN)
    .map(s => ({
      id: s.id,
      label: s.label,
      start: s.start,
      end: s.end,
      hours: s.hours,
      turns: s.turns,
      fuel: s.fuel,
      share: totalFuel ? Math.round((1000 * s.fuel) / totalFuel) / 10 : 0
    }));

  return {
    window: { since, until },
    minFuel,
    totals: {
      fuel: totalFuel,
      sessions: kept.length,
      sessionsSeen: inWindow.length,
      sessionsBelowCut: inWindow.length - kept.length,
      belowCutFuel
    },
    byProject,
    topSessions
  };
}

module.exports = {
  DEFAULT_MIN_FUEL,
  turnFuel,
  projectLabel,
  scanTranscript,
  collectSessions,
  aggregate
};
