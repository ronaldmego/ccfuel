# Known Limitations

Technical limitations of the dashboard and its data sources.

---

## Data Extraction: PTY Dependency (CRITICAL)

The dashboard's **sole data source** is the `/usage` slash command inside Claude Code, accessed via a PTY (pseudo-terminal) session using `node-pty`.

### Why PTY (not CLI, not API, not OTel)

| Alternative | Viable? | Reason |
|-------------|---------|--------|
| `claude usage` CLI subcommand | No | Does not exist — Claude interprets it as a chat prompt |
| Anthropic API | No | No endpoint for account quota % |
| OpenTelemetry | Partial | Exports tokens/costs per request, but NOT weekly quota % (the primary metric). Investigated 2026-03-01, not viable as replacement |
| Claude `/usage` via PTY | Yes | Only source of `weekAll.percent`, `session.percent`, `weekSonnet.percent` |

### Risks

- **Fragile:** PTY timing is empirical (4s init, 1.5s autocomplete wait). Claude CLI updates can break it.
- **Slow:** Each fetch takes ~20-25 seconds (spawn, init, command, parse, kill).
- **One at a time:** Cannot run multiple PTY sessions simultaneously (Claude detects and rejects).
- **Env-sensitive:** Must filter `CLAUDECODE` env var or Claude refuses to start.

### Mitigation

- 5-minute cache on successful fetches (avoids hammering PTY)
- 35-second timeout with graceful fallback
- **A failed/timed-out fetch keeps the last good cached value** — a transient PTY timeout never overwrites real usage with `0%` (see Historical bug below)
- Debug mode: `node claude-usage.js --debug` writes raw output to `/tmp/claude-usage-debug.log`

### Historical bug: transient PTY timeout read as 0% (#34)

**Symptom:** the dashboard intermittently showed `0% used` / `100% remaining` / `Reset unavailable` even though Claude's `/usage` reported real consumption.

**Cause:** a timed-out PTY fetch returns `success: false` with `0%`. In `fetchAndSnapshot()` (`server.js`), `globalUsageCache.data` was assigned **before** the `success` check, so a failed fetch overwrote the last good value with `0%`. Logs showed alternating `✅ Global usage updated: 37% week` / `✅ Global usage updated: 0% week`. The PTY parser itself was fine (`node claude-usage.js --debug` returned correct values), confirming the bug was in the caching layer, not the parser.

**Fix:** on `!usage.success`, keep the last good cached value and skip the snapshot, so transient failures can never surface as `0%` ([#34](https://github.com/ronaldmego/ccfuel/issues/34)).

> **For future reference:** if `0%`/`Reset unavailable` ever reappears, first run `node claude-usage.js --debug` — if it returns correct values, the parser is fine and the issue is in the server caching/refresh path, not the data engine.

---

## Timezone: Hardcoded UTC-5

The dashboard assumes **Panama (UTC-5)** as a fixed timezone. It does not use DST or detect the user's timezone.

| Aspect | Status |
|--------|--------|
| Weekly reset time | Interpreted as Panama time |
| "Spent Today" | Day calculated in Panama time |
| Hourly charts | Blocks grouped by Panama hour |
| Browser in other timezone | No impact — does not depend on browser timezone |

To use a different timezone, update `PANAMA_OFFSET` in `index.html` and the equivalent in `server.js`. See `TECHNICAL-NOTES.md` Timezone section for details.

### Historical bug: getTimezoneOffset

Before the fix, the frontend used `now.getTimezoneOffset()` from the browser to calculate Panama time. This made calculations depend on the browser's timezone and produced incorrect results if the browser was not in UTC. Fixed by using direct offset from UTC.

---

## Affected Metrics

| Metric | Source | Coverage |
|--------|--------|----------|
| Session % | Claude `/usage` via PTY | Complete — account-level |
| Weekly % (all models) | Claude `/usage` via PTY | Complete — includes all sources (CLI, web, API) |
| Weekly % (Sonnet) | Claude `/usage` via PTY | Complete — account-level |
| Daily/hourly consumption | Derived from % deltas between snapshots | Complete — based on official % |
| Per-session fuel ("What burned it") | Local session transcripts | Partial — see below |

---

## Per-session fuel: tokens are not quota percent

The "What burned it" panel has a **different source** from every other metric: the local JSONL
transcripts under `~/.claude/projects`, not `/usage`. That brings its own limits.

- **Tokens ≠ quota %.** Converting token counts into a quota percentage needs Anthropic's private
  weighting, so the panel reports **shares** ("this project took 60% of the tokens you burned"),
  never "this session used N% of your week". The two numbers are not comparable.
- **The counters are disjoint, not nested.** `input_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens` and `output_tokens` are separate totals. Fuel is therefore a **sum**
  of what burns quota (`output + input + cache_creation`) and excludes cache reads — which are
  ~96% of all tokens. Subtracting cache reads from input, as if they were a subset, produces
  negative fuel (measured at `-9.45e9` across 1778 sessions, negative in 40% of them).
- **Local host only.** Transcripts live on the machine that ran the session. A dashboard on one
  body sees only that body's sessions, while `/usage` is account-wide. The two will not reconcile.
- **A cut hides trivial sessions.** Sessions under `DASHBOARD_SESSION_MIN_FUEL` (default 10,000
  tokens) are excluded: measured over 1778 real sessions that discards 63% of the files —
  aborted starts and one-shot `claude -p` runs — while retaining 99.95% of all fuel. The panel
  states how many sessions and tokens the cut hid, so it never reads as "this is everything".
- **Privacy.** Transcripts contain full conversation text. The collector reads **only**
  `timestamp` and `message.usage.*`, and never persists or serves message content. Labels are the
  session id and project directory only.
- **Retention is the transcripts'.** There is no separate pruning — the window is whatever Claude
  Code has kept on disk.

---

## References

- PTY implementation: `claude-usage.js`
- Per-session fuel collector: `session-metrics.js`
- Timezone details: `TECHNICAL-NOTES.md`
- Anthropic Console: https://console.anthropic.com

---

*Timeless document — limitations only*
