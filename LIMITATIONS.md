# Known Limitations

Technical limitations of the dashboard and its data sources.

---

## Data Extraction: where the gauge comes from

The account-level percentages come from the first source that answers: the usage endpoint,
then Claude Code's cached copy of that same reply, then the `/usage` panel scraped from a PTY.

| Source | Viable? | Reason |
|-------------|---------|--------|
| `GET /api/oauth/usage` | Yes, default | The call Claude Code itself makes. Structured JSON, `resets_at` as an instant, ~0.7 s, no process spawned. Needs the local OAuth token |
| `~/.claude.json` → `cachedUsageUtilization` | Yes, when fresh | Claude Code's verbatim copy of the same payload. No credentials, no network — but only as fresh as the last session that opened `/usage`, so a stale one is refused rather than served |
| Claude `/usage` via PTY | Yes, last resort | Works with no token at all, at the cost of booting a CLI and screen-scraping a TUI. See the risks below |
| `claude usage` CLI subcommand | No | Does not exist — Claude interprets it as a chat prompt |
| OpenTelemetry | Partial | Exports tokens/costs per request, but NOT weekly quota % (the primary metric). Investigated 2026-03-01, not viable as replacement |

Note that the endpoint is not a documented public API: it is what the CLI uses, and it can
change without notice. That is precisely why the other two sources are kept behind it, and
why a reply without a weekly figure is reported as a failure instead of a `0%` reading.

### Risks of the PTY fallback

- **Fragile:** the whole read is screen-scraping a TUI. Claude CLI updates can change the
  panel's wording or layout and break `parseUsageOutput()`. The two waits that used to break on
  timing are event-driven now — the keystroke retries until its echo appears, and the fetch
  resolves when the parse succeeds — but the fetch is not timer-free: a 4 s delay before the
  first keystroke, a 1.5 s retry interval (which stops on the echo), a 400 ms pause after the
  echo, a 2 s settle after the first good parse, and a 35 s hard timeout. Those are bounded
  backstops and debounces rather than bets on how long the TUI needs, so a slower machine
  degrades instead of failing.
- **Costly per fetch:** ~6 s of process lifetime and ~327 MB RSS on the happy path — a whole
  CLI is booted to type one slash command.
- **Anything typed into it is one keystroke away from being a prompt.** A retype race once
  left `/usage/usage` on the input line; that is not a slash command, so Enter submitted it
  and started a billed agent turn, ~26% of fetches for three weeks
  ([#55](https://github.com/ronaldmego/ccfuel/issues/55)). The line is now cleared before
  every attempt and Enter is refused on anything but a bare `/usage`, but the class of risk
  is inherent to driving a TUI — which is why this path is no longer the default.
- **One at a time:** Cannot run multiple PTY sessions simultaneously (Claude detects and rejects).
- **Env-sensitive:** all `CLAUDE*` env vars must be filtered or Claude refuses to start
  (nested-session detection).
- **Folder trust:** Claude Code trusts folders individually, and its trust prompt swallows the
  keystrokes. A fresh clone is by definition an untrusted folder, so on first run every fetch
  fails until the folder is accepted or `DASHBOARD_CLAUDE_CWD` points somewhere already
  trusted. ccfuel detects this state and reports it; it never answers the prompt.
- **Native module, macOS packaging:** node-pty 1.1.0 publishes its macOS prebuild with a
  non-executable `spawn-helper`, and every spawn then fails with `posix_spawnp failed.`
  regardless of Node version. Repaired by a `postinstall`
  (`scripts/fix-pty-permissions.js`); it will be removable once upstream ships the bit.

### Mitigation

- Three sources tried in order, so one failing does not blank the gauge; the answer carries
  `source`, and a total failure carries `triedSources` with what each one said
- 5-minute cache on successful fetches
- 35-second timeout with graceful fallback, plus one retry inside the same collector cycle
- **A failed/timed-out fetch keeps the last good cached value** — a transient PTY timeout never overwrites real usage with `0%` (see Historical bug below)
- Failures are named, not generic: `failureKind` is one of `no-oauth-token`,
  `oauth-unauthorized`, `endpoint-http-error`, `endpoint-timeout`, `endpoint-unreachable`,
  `cache-stale`, `cache-absent`, `cache-unreadable`, `trust-prompt`, `login-required`,
  `timeout`, `exited-early`. The first two are detected during boot and end the fetch
  immediately instead of spending the full 35 s on a state no retry can clear.
- Debug mode: `node claude-usage.js --debug` writes raw output to `/tmp/claude-usage-debug.log`

### The endpoint carries no "$N free" figure

The `/usage` panel prints a promotional "$N free" line that the endpoint payload has no field
for (`extra_usage` describes a paid budget, not a grant). On the endpoint and cache paths the
badge therefore stays off — `extraUsage.freeAvailable` is `0` — rather than showing a number
ccfuel would have to invent. `extraUsage.enabled` is read correctly on every path.

### Historical bug: transient PTY timeout read as 0% (#34)

**Symptom:** the dashboard intermittently showed `0% used` / `100% remaining` / `Reset unavailable` even though Claude's `/usage` reported real consumption.

**Cause:** a timed-out PTY fetch returns `success: false` with `0%`. In `fetchAndSnapshot()` (`server.js`), `globalUsageCache.data` was assigned **before** the `success` check, so a failed fetch overwrote the last good value with `0%`. Logs showed alternating `✅ Global usage updated: 37% week` / `✅ Global usage updated: 0% week`. The PTY parser itself was fine (`node claude-usage.js --debug` returned correct values), confirming the bug was in the caching layer, not the parser.

**Fix:** on `!usage.success`, keep the last good cached value and skip the snapshot, so transient failures can never surface as `0%` ([#34](https://github.com/ronaldmego/ccfuel/issues/34)).

> **For future reference:** if `0%`/`Reset unavailable` ever reappears, first run `node claude-usage.js --debug` — if it returns correct values, the parser is fine and the issue is in the server caching/refresh path, not the data engine.

---

## Timezone: one fixed offset, no DST

The dashboard works in a **single UTC offset**, set by `DASHBOARD_TIMEZONE` and defaulting to
`-5`. It never reads the browser's or the host's zone, and it has no DST handling — an offset,
not a timezone. In a DST region the derived day boundaries drift by an hour for part of the year.

| Aspect | Status |
|--------|--------|
| Weekly reset time | The `/usage` panel prints wall-clock with no zone; interpreted at the configured offset |
| Day boundaries ("spent today") | Cut at the configured offset |
| Hourly charts and heatmap | Bucketed by hour at the configured offset |
| Browser in another timezone | No impact — the frontend takes the offset from `/api/config` |
| DST | Not handled |

One setting covers all three layers: the server, the frontend (via `/api/config`) and the
`/usage` reset parser.

### Known edge: reset dates near the year boundary

The panel prints dated resets without a year (`Aug 18, 10am`), so the parser assumes the
current one. For the few days each year when the next reset falls after 31 December, that
yields a date in the past, which the parser discards rather than trusting. The effect is
bounded — the cycle keeps running off the persisted reset anchor and the `resetsAtHour`
fallback — but the dated reset is unavailable during that window.

### Historical bug: getTimezoneOffset

Before the fix, the frontend used `now.getTimezoneOffset()` from the browser to derive local time. This made calculations depend on the browser's timezone and produced incorrect results if the browser was not in UTC. Fixed by using the configured offset directly from UTC.

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

- **It is a proxy, not an official measurement.** `fuel = output + input + cache_creation` is
  **ccfuel's own heuristic** for attributing non-cache work, not a published Anthropic formula.
  Anthropic does not publish any mapping from Claude Code's four transcript counters onto the
  weekly quota percentage, so nothing here should be read as "this is what Claude Code charges
  you". The authoritative number is the `/usage` gauge, and only that.
- **Why cache reads are left out, precisely.** Reusing cached context is treated favorably:
  Anthropic's usage-limit guidance states that cached project content "doesn't count against
  your limits when reused" and that "only new/uncached portions count against your limits", and
  on the API cache reads are billed at **0.1× the base input token price** rather than full
  price ([caching pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing),
  [usage limits](https://support.claude.com/en/articles/9797557-usage-limit-best-practices)).
  That is favorable treatment at a reduced rate. The proxy excludes them for two stated reasons —
  that favorable treatment, and reused context dominating raw volume and burying the attribution
  signal. It makes no claim about what Claude Code charges.
- **Tokens ≠ quota %.** Converting proxy tokens into a quota percentage would need Anthropic's
  private weighting, so the panel reports **shares** ("this project took 60% of the non-cache
  tokens in the window"), never "this session used N% of your week". The two are different units
  and are never converted.
- **The counters are disjoint, not nested.** `input_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens` and `output_tokens` are separate totals. The proxy is therefore a
  **sum** of its three terms, not `input - cache_read`: subtracting them as if cache reads were a
  subset of input produces negative fuel (measured at `-9.45e9` across 1778 sessions, negative in
  40% of them).
- **The ~96% figure is an observation, not a constant.** Cache reads were ~96% of token volume
  across the maintainer's own 1778-session corpus on one machine. It will differ with how you
  work, and nothing in the code depends on it.
- **One message, many rows.** A message is written to the transcript repeatedly while it
  streams, each row a fuller snapshot under the same `message.id`. Fuel and turns count each
  `message.id` **once** — the last snapshot, taken as a whole row, never a field-wise merge.
  Summing rows instead inflated fuel ~2.6x (45,354 usage rows against 21,351 unique ids).
  Rows carrying usage but **no** `message.id` cannot be deduplicated, so each counts once:
  collapsing them would drop real consumption. There are none in the observed corpus.
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

---

## Platform support

Declared support is what is actually exercised, not what might work.

| | Status |
|---|---|
| Node.js | **22+** (`engines`). CI runs 22 and 24; 25 verified by hand. Older lines are EOL and untested |
| macOS | Supported. Verified end-to-end on macOS 26 / arm64 with Node 22, 24 and 25 |
| Linux | Supported. The deploy target; needs a C++ toolchain since node-pty has no Linux prebuild |
| Windows | **Untested.** node-pty ships a Windows prebuild and nothing in the code is POSIX-only, but no one has run it. Reports welcome |

The `/usage` fetch additionally needs Claude Code installed, authenticated, and the spawn
folder trusted. Everything except that fetch — the transcript panel, the derived charts, the
history — works without it.

---

## References

- PTY implementation: `claude-usage.js`
- Per-session fuel collector: `session-metrics.js`
- Timezone details: `TECHNICAL-NOTES.md`
- Claim contract check: `test/claims.test.js`
- Prompt caching pricing: https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing
- Usage limits and cached content: https://support.claude.com/en/articles/9797557-usage-limit-best-practices
- Anthropic Console: https://console.anthropic.com

---

*Timeless document — limitations only*
