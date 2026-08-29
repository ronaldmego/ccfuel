<p align="center">
  <img src="./assets/ccfuel-logo.svg" alt="ccfuel — Fuel gauge for Claude Code" width="440">
</p>

<p align="center">
  <a href="https://github.com/ronaldmego/ccfuel/actions/workflows/ci.yml"><img src="https://github.com/ronaldmego/ccfuel/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT"></a>
</p>

**Fuel gauge for Claude Code.** Read your weekly quota from Claude's own `/usage` gauge, then see **where the work went** — per project and per session — without raw token totals dominated by cache reads burying the signal.

> Stop guessing. Know how much Claude Code fuel you have left, and what took it.

## Why This Exists

Claude Code has a weekly limit. Burn it and you're locked out until reset. The CLI will tell
you *how much* is gone if you keep typing `/usage`; it will not tell you *what took it*, and
the raw token counts in your local transcripts are dominated by cache reads, which makes them
useless as an attribution signal (in my own corpus, ~96% of token volume — see below).

So ccfuel keeps two things apart, and the separation is the whole design:

| | Source | Answers | Status |
|---|---|---|---|
| **Official gauge** | The account's own usage figures, read the way Claude Code reads them | *How much* of the quota is gone | Authoritative — Anthropic's own number |
| **Local fuel proxy** | Your session transcripts | *Where* the non-cache work concentrated | A heuristic ccfuel computes. Not an Anthropic formula |

**What it tells you:**

- **How much fuel is left** — weekly % straight from Claude `/usage`
- **Your burn rate** — pace across the cycle, from `/usage` snapshots over time
- **When you'll run out** — projection from that measured pace
- **Where the non-cache work went** — fuel-proxy shares by project and by session

## The fuel proxy (and what it is not)

**Formula:** `fuel = outputTokens + inputTokens + cacheCreationTokens`

This is **ccfuel's own attribution proxy**, not a published Anthropic formula, and it is
deliberately not convertible into quota percent.

| Token counter | In the proxy? | Why |
|-----------|----------|-----|
| outputTokens | Yes | Generated content — never cached, always new work |
| inputTokens | Yes | Uncached context sent on this turn |
| cacheCreationTokens | Yes | Writing new content into the cache — new work, and priced *above* base input on the API |
| **cacheReadTokens** | **No** | Reused cached context. Dominates raw volume and drowns out the signal (~96% in the corpus below) |

**Why cache reads are excluded — carefully stated.** Reusing cached context is treated
favorably: Anthropic's usage-limit guidance says cached project content "doesn't count against
your limits when reused" and that "only new/uncached portions count against your limits", and
on the API cache reads bill at **0.1× the base input token price** rather than full price.
That is favorable treatment at a reduced rate, and Anthropic publishes **no formula** mapping
Claude Code's four transcript counters onto the weekly percentage. So the proxy leaves cache
reads out for exactly two stated reasons — favorable treatment, and dominant volume that buries
the signal. It makes no claim about what Claude Code charges you.

**Two units, never mixed.** Fuel-proxy tokens and quota percent are different units. The panel
reports **shares** ("this project took 35% of the non-cache tokens you burned"), never "this
session used N% of your week". Converting between them would need Anthropic's private
weighting, which is not published.

**The ~96% is an observation, not a constant.** Measured across 1,778 real sessions on the
maintainer's own machine. Your corpus will differ with how you work; nothing in the code
depends on the figure.

**Sources**

- Prompt caching pricing (cache reads at 0.1× base input): <https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing>
- Usage limits and cached content: <https://support.claude.com/en/articles/9797557-usage-limit-best-practices>

On the arithmetic: the four counters are **disjoint totals**, not nested. Writing the proxy as
`input - cacheRead` looks equivalent and is not — it mixes separate counters and goes negative
whenever cache reads dominate. Sum the terms; never subtract. See `TECHNICAL-NOTES.md` for the
full methodology.

## Screenshots

All three are **synthetic demo data** from `npm run demo` — not real usage. That is what the
orange banner across the top says, and it is pinned so it cannot scroll out of a capture.

![Overview](./screenshots/dashboard-overview.png)
*Overview — official `/usage` gauges, cumulative curve against previous cycles, burn rate, daily and hourly consumption, and the activity heatmap. Synthetic data.*

![Weekly](./screenshots/weekly-tab.png)
*Weekly — cycle progress, one cumulative curve per cycle, and weekly history: which cycles hit 100% and how many hours they spent locked out. Synthetic data.*

![What burned it](./screenshots/what-burned-it.png)
*What burned it — the local fuel **proxy**: shares by project and the heaviest sessions, from your transcripts rather than `/usage`. Project labels here (`demo-api`, `demo-web`, …) are invented; on a real instance they are your own project directories. Synthetic data.*

## Stack

```
Node.js + Express
Frontend: Vanilla HTML/CSS/JS + Chart.js (single index.html, no build step)
           served entirely from localhost — no CDN, no webfont, no outbound request
Data: the account's usage endpoint (PTY fallback) — periodic % snapshots
Process Manager: PM2 (optional)
```

## Prerequisites

- **Node.js 22 or newer.** Tested on 22 LTS, 24 LTS and 25 (see `engines` in `package.json`).
  Earlier lines are past end-of-life and are not tested.
- **Claude Code** installed, authenticated, and having trusted the folder the server runs in
  (see [Troubleshooting](#troubleshooting) — this one bites on first run).
- **A C++ toolchain, on Linux only.** `node-pty` is a native module. It publishes prebuilt
  binaries for macOS and Windows, so those install without a compiler; there is no Linux
  prebuild, so Linux compiles from source:

| OS | Needs build tools? |
|----|--------------------|
| macOS | No — prebuilt binary ships in the package |
| Windows | No — prebuilt binary ships in the package |
| Ubuntu/Debian | Yes — `sudo apt install build-essential python3` |

## Quick Start

Tested on macOS and Linux with Claude Code installed ([full matrix](LIMITATIONS.md#platform-support)). Reads `~/.claude/` logs automatically.

```bash
git clone https://github.com/ronaldmego/ccfuel.git
cd ccfuel

npm ci          # `npm ci` installs exactly the locked dependency set
node server.js
```

Open `http://localhost:3400`. The dashboard reads your local Claude Code transcripts and
asks the account for its usage figures the same way Claude Code does — `GET /api/oauth/usage`
with the OAuth token already on your machine. No Claude Code session is started for it.

**First run:** there is nothing to accept on the default path. If the token cannot be read
(a locked macOS Keychain, or no `~/.claude/.credentials.json`), ccfuel falls back to Claude
Code's own cached copy of the same reply, and then to driving `/usage` in a PTY. Only that
last path meets the folder-trust prompt, which swallows the keystrokes it types: run `claude`
once inside the ccfuel folder and accept, or point `DASHBOARD_CLAUDE_CWD` at a folder you
already trust. `/api/global-usage` names the source that answered and, on failure, what each
one said — see [Troubleshooting](#troubleshooting).

### Take a screenshot without showing your own numbers

```bash
npm run demo     # http://localhost:3401
```

Builds a synthetic fixture in a fresh temp directory and serves it with both collectors off —
no PTY spawn, no transcript read — behind a "synthetic data" banner. Useful for screenshots,
issue reports and demos.

The fixture directory is created per run under the OS temp dir and removed when the demo exits.
**`DASHBOARD_DATA_DIR` is deliberately ignored here**: the demo overwrites a fixed set of
filenames, so honouring it would let `npm run demo` destroy the snapshots of anyone who had
configured a real data directory. There is no flag to override that — looking at the UI does not
need write access to real data.

### Optional: PM2 for background running

```bash
cp ecosystem.config.example.cjs ecosystem.config.cjs
pm2 start ecosystem.config.cjs
```

### Optional: Custom configuration

Every setting is an environment variable. Nothing reads `.env` implicitly — pass it to Node
yourself:

```bash
cp .env.example .env
# edit .env, then:
node --env-file=.env server.js
```

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_HOST` | `127.0.0.1` | Bind address |
| `DASHBOARD_PORT` | `3400` | Server port |
| `DASHBOARD_TIMEZONE` | `-5` | UTC offset in hours (`-5` EST, `+1` CET, `0` UTC). No DST. Used by the server, the frontend and the `/usage` reset parser |
| `DASHBOARD_DATA_DIR` | `./data` | Where snapshots are written. Created on boot if missing |
| `DASHBOARD_COLLECT_INTERVAL_MIN` | `20` | Usage auto-collector cadence in minutes. `0` disables it |
| `DASHBOARD_USAGE_SOURCE` | `auto` | Where the gauge comes from: `auto` (endpoint → cache → PTY) or one pinned source — `endpoint`, `cache`, `pty` |
| `DASHBOARD_USAGE_CACHE_MAX_AGE_MIN` | `30` | How old Claude Code's cached usage may be before the `cache` source refuses to serve it as live |
| `DASHBOARD_CLAUDE_CWD` | *(inherit)* | Folder to spawn `claude` in. Set it to a folder Claude Code already trusts |
| `DASHBOARD_SESSION_SCAN_INTERVAL_MIN` | `30` | Transcript scan cadence in minutes. `0` disables the "What burned it" panel |
| `DASHBOARD_SESSION_MIN_FUEL` | `10000` | Sessions under this many fuel tokens are treated as noise |
| `DASHBOARD_TRANSCRIPTS_ROOT` | `~/.claude/projects` | Where session transcripts live |
| `DASHBOARD_DEMO` | *(off)* | `1` serves `DASHBOARD_DATA_DIR` as-is and collects nothing. Set by `npm run demo`; never set it on a real instance |

## Architecture

### Single machine (default)

```
usage endpoint  ─┐
~/.claude.json   ├─>  claude-usage.js  ──>  server.js  ──>  Dashboard
/usage via PTY  ─┘
```

- **usage-source.js** reads the account-level percentages without a Claude Code session: the usage endpoint first, then Claude Code's cached copy of the same reply
- **claude-usage.js** picks the first source that answers and keeps the PTY scrape as the last resort
- An in-process auto-collector in `server.js` fetches usage and saves a snapshot to `data/usage-curve.json` every `DASHBOARD_COLLECT_INTERVAL_MIN` minutes (default 20), independent of whether the dashboard is open. It primes once ~5s after boot, retries once inside a cycle on failure, and is guarded against overlapping fetches. Opening the dashboard or hitting `/api/global-usage` still triggers an on-demand refresh on top of the schedule.

### File Structure

```
ccfuel/
├── server.js           # Express server + collector
├── claude-usage.js     # Source chain (endpoint → cache → PTY) + the PTY scrape itself
├── usage-source.js     # The two non-interactive readers: usage endpoint and ~/.claude.json
├── reset-cycle.js      # Weekly reset cycle validation (guards weekId against misparses)
├── session-metrics.js  # Per-session fuel from local transcripts
├── public/
│   └── index.html      # Dashboard (all inline: HTML, CSS, JS)
├── scripts/
│   ├── demo.js               # `npm run demo` — serve synthetic data for screenshots
│   ├── synthetic-fixture.js  # the fixture generator (shared with the smoke test)
│   └── fix-pty-permissions.js # postinstall: restore node-pty's spawn-helper exec bit
├── test/               # Dependency-free tests + PTY and server smokes (npm test)
├── data/               # Local snapshots (gitignored, created at runtime)
│   ├── weekly-history.json   # Weekly efficiency snapshots
│   ├── usage-curve.json      # Periodic % snapshots
│   ├── resets-cache.json     # Last accepted reset per cycle (the weekId anchor)
│   └── session-metrics.json  # Per-session fuel + scan cache (mtime-keyed, schema-versioned)
├── TECHNICAL-NOTES.md  # Measurement methodology
├── LIMITATIONS.md      # Known limitations
└── package.json
```

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard HTML |
| `/api/refresh` | GET | Redirects to `/api/global-usage/refresh` |
| `/api/global-usage` | GET | Real global usage; `source` names where it came from |
| `/api/global-usage/refresh` | GET | Force refresh global usage |
| `/api/usage-curve` | GET | Periodic % snapshots (for weekly comparison) |
| `/api/usage-deltas` | GET | Derived consumption from % deltas (rate, projection, daily, hourly, heatmap, curves) |
| `/api/weekly-history` | GET | Weekly efficiency history |
| `/api/config` | GET | Configuration (timezone, demo flag) |
| `/api/session-metrics` | GET | Per-session fuel by project and heaviest sessions (`?window=cycle\|28d\|all`, `?top=N`) |
| `/api/session-metrics/refresh` | GET | Force a transcript rescan |

**Global Usage:** ~0.7 s on the endpoint path, with no process spawned; the PTY fallback is
~6 s on the happy path with a 35 s hard timeout. Cached 5 min. Returns `session%`,
`weekAll%`, `weekSonnet%`, `extraUsage` and `source`.

A read either succeeds or says why. `success: true` means the weekly percentage parsed — the
one field that is never defaulted, so a real `0%` is distinguishable from a failed read.
`success: false` carries a `failureKind` and a message — `no-oauth-token`,
`oauth-unauthorized`, `endpoint-http-error`, `endpoint-timeout`, `endpoint-unreachable`,
`cache-stale`, `cache-absent`, `cache-unreadable` from the non-interactive readers, and
`trust-prompt`, `login-required`, `timeout`, `exited-early` from the PTY — plus
`triedSources` when every source failed; a failed read never overwrites the last good value.
`session.percent` and `weekSonnet.percent` still default to `0` for backwards compatibility,
so a `0` from those two is not evidence of a real zero.

**Usage Curve:** Each successful global-usage fetch saves a snapshot to `data/usage-curve.json` (%, hour, cycle day). Auto-pruned to last 28 days.

### Dashboard Tabs

Two tabs. Everything on the Overview tab is one scrolling page, not separate views.

- **Overview** — *Official usage* (session %, weekly all, weekly Sonnet, straight from
  `/usage`) and the session/weekly gauges, source `/api/global-usage`. Then, derived from the
  % deltas between snapshots (source `/api/usage-deltas`): *Cumulative usage* per cycle hour
  against the previous cycles and an ideal pace, *Burn rate* with a depletion estimate, *Daily
  consumption* (14 days), *Hourly consumption* (48h) and the *Activity pattern* heatmap by
  weekday and hour. Last, *What burned it* — the **fuel proxy** by project and the heaviest
  sessions, computed from the local transcripts rather than read from `/usage`: the official
  gauge says *how much* is gone, this estimates *where the non-cache work concentrated*. It
  reports shares of the proxy, never quota percent — different units, not convertible (see
  `LIMITATIONS.md`). Source `/api/session-metrics`.
- **Weekly** — cycle progress for the current week, cumulative curves per cycle, and weekly
  history including when a cycle hit 100% and how long it was locked out. Source
  `/api/weekly-history` plus `curves` from `/api/usage-deltas`.

## Critical Components

### claude-usage.js — The Data Engine

`claude-usage.js` is the **single most critical file** in this project. It is the data
extraction layer — without it, the entire dashboard shows 0% on everything. The UI is just
presentation; this file is the engine.

#### How it works

`getClaudeUsage()` takes the first source that answers:

```
1. endpoint  GET /api/oauth/usage with the local OAuth token   ~0.7 s, no process spawned
2. cache     ~/.claude.json → cachedUsageUtilization           free, only while it is fresh
3. pty       spawn `claude`, type /usage, scrape the panel     ~6 s, 35 s hard timeout
```

Claude Code does not compute those percentages either: it asks the account for them and
caches the reply verbatim. Both non-interactive sources therefore carry the **same JSON
shape**, so one mapper serves both — and `resets_at` arrives as an instant, which is why
neither of them has to guess a timezone the way the panel scrape does.

`DASHBOARD_USAGE_SOURCE` pins one source when you need to test or diagnose a specific path.
Every result carries `source`; when all of them fail, `triedSources` says what each one said.

**The credential boundary:** the OAuth token is read (`~/.claude/.credentials.json`, or the
`Claude Code-credentials` Keychain item on macOS), never written, never logged, and sent
nowhere but the Anthropic API it already belongs to. `claude` refreshes it on its own
schedule; an expired one just fails over to the next source.

**The PTY path**, when it runs, spawns with no MCP servers (`--strict-mcp-config` plus an
empty `--mcp-config`): the session types a slash command and never calls a tool, but a
default spawn boots every MCP server the user has configured — on a host with Playwright MCP
that was a second process of ~162 MB per fetch, for nothing. It clears the input line before
every keystroke attempt and refuses to press Enter on anything but a bare `/usage`; see the
history below for what that guard is made of.

#### What it costs per fetch

| | endpoint | PTY fallback |
|---|---|---|
| wall time | ~0.7 s | ~6 s happy path, 35 s hard timeout |
| processes | none | one `claude`, ~327 MB RSS, ~9.7 s CPU |
| sessions | none | one Claude Code session per fetch |
| model calls | none — the request asks the account for its own figures | none, as long as nothing but `/usage` reaches the prompt |

PTY figures measured on a 12-core VPS with the collector at its default 20-minute interval.
The RAM is a spike, not a leak: the process is killed at the end of each fetch and the kill
reaps the child tree with it.

#### What can break it

| Risk | Detail |
|------|--------|
| Unreadable token | No `~/.claude/.credentials.json` and a locked Keychain give `failureKind: no-oauth-token`; a rotated or expired one gives `oauth-unauthorized`. Both fall through to the next source |
| Sub-second jitter in `resets_at` | The API returns the reset with microsecond precision, either side of the minute (`05:00:00.287Z`, then `04:59:59.993Z`). At a negative offset the second one is 23:59 of the previous day, which would flip the label, the hour and the cycle range between two reads of the same window. The mapper snaps the instant to the nearest minute ([#59](https://github.com/ronaldmego/ccfuel/issues/59)) |
| Endpoint shape changes | The mapper reads `five_hour`, `seven_day`, `seven_day_sonnet` and `extra_usage`. A reply without a weekly figure is reported as a failure, never as a `0%` reading |
| Stale cache | Claude Code's cached copy is only as fresh as the last session that read `/usage` — booting `claude` does not refresh it. Anything older than `DASHBOARD_USAGE_CACHE_MAX_AGE_MIN` is refused rather than served as if it were live |
| Claude CLI updates | Output format or slash command behavior may change on the PTY path. Timing changes are absorbed by the echo/parse gates |
| `CLAUDE*` env vars | Must be filtered out of the PTY spawn or Claude refuses to start (nested session detection) |
| Matching the TUI's **wording** | The early-exit condition must key off the *parse succeeding*, never off a specific string. A wording match that silently stops matching does not fail loudly — it degrades into "always hits the 35s timeout" while still returning correct data |
| Startup flags | `--bare` looks ideal and is not: it ignores OAuth and the keychain by design (API key only), which breaks the very subscription quota this reads. `--disable-slash-commands` disables the one thing the fetch does |
| Folder trust | Claude Code trusts folders one at a time and asks before working in an unknown one. That prompt eats the keystrokes. Detected by name (`failureKind: trust-prompt`) and never answered automatically — accepting a trust prompt is the user's decision, not a dashboard's |
| node-pty packaging | It is a Node-API addon, so one binary works across Node versions — no rebuild after a Node upgrade. The real trap is macOS: the published prebuild's `spawn-helper` is not executable, and every spawn then fails with `posix_spawnp failed.` A `postinstall` restores the bit; see `scripts/fix-pty-permissions.js` |

#### Rules before modifying

1. **Run `node claude-usage.js` first** — it prints the result and the `source` that produced it
2. **To exercise one path, pin it**: `DASHBOARD_USAGE_SOURCE=pty node claude-usage.js --debug`, with the raw PTY capture in `/tmp/claude-usage-debug.log`
3. **If the `/usage` panel changes**, only `parseUsageOutput()` needs updating; if the endpoint payload changes, only `mapUtilization()` does. The spawn logic and the source chain stay put
4. **Nothing typed into the PTY may ever reach the model.** The line is cleared before every attempt and Enter is refused unless the input is exactly `/usage` — keep both if you touch the typing
5. **Test from PM2 context too** — env vars differ between an interactive shell and PM2

#### History

- **Pre-2026-03-01:** Used `execSync('claude usage')` which was never a valid CLI command. Worked by accident until it stopped.
- **2026-03-01:** Rewritten to use node-pty with the interactive `/usage` slash command.
- **2026-08-08:** Cut from 35 s to ~6 s per fetch. Three findings worth keeping, because each
  one hid behind correct-looking output:
  - The early-exit condition required the string `extra usage`, which that account's panel
    never renders. So it never fired and **every** fetch ran the full 35 s timeout — while
    still returning the right numbers, because the timeout handler parses too. A cost bug
    with no symptom. The gate is now `parseUsageOutput().success`.
  - `/usage` was typed on a fixed 4 s timer. When the TUI had painted its banner but was not
    yet accepting input, the keystroke was swallowed with no error to react to, `/usage`
    never echoed, and the fetch burned 35 s on ~891 captured bytes. That was the recurring
    ~15 % failure — not an expired login. The fix is to retype until the echo appears.
  - The spawn loaded every configured MCP server (523 MB, two processes) to type one slash
    command it never used a tool for.
- **2026-08-29 ([#55](https://github.com/ronaldmego/ccfuel/issues/55)):** the retype fix above
  had a race with the 4 s timer: when the echo landed just before it, a second `/usage` was
  typed onto the same line. `/usage/usage` is not a slash command, so Enter submitted it as a
  **prompt** — a real agent turn, on the plan the gauge exists to watch, roughly a quarter of
  all fetches for three weeks. Two conclusions, both shipped:
  - a guard where the damage happens: the line is cleared before every keystroke, and Enter
    is refused on anything but a bare `/usage`. Whatever puts stray text on that line, it can
    no longer become a prompt;
  - and the honest fix, because the fragility was never in the timers but in driving a TUI at
    all: read the same figures Claude Code reads. `README`, `CONTRIBUTING` and
    `TECHNICAL-NOTES` all said there was no non-interactive way to get them. There is.

## Troubleshooting

The gauge is empty, or `/api/global-usage` returns `success: false`. Read `failureKind`:

| `failureKind` | What happened | Fix |
|---|---|---|
| `trust-prompt` | Claude Code is asking whether to trust the folder ccfuel spawned it in, and the prompt is eating the `/usage` keystrokes | Run `claude` once in that folder and accept, or set `DASHBOARD_CLAUDE_CWD` to a folder you already trust |
| `login-required` | Claude Code is not authenticated | Run `claude`, complete `/login`, retry |
| `timeout` | The panel never rendered within 35s | The raw buffer is in the server log; check whether `/usage` looks different from what `parseUsageOutput()` expects |
| `exited-early` | `claude` exited before the panel appeared | Usually a CLI error on startup — run `node claude-usage.js --debug` |

`Error: posix_spawnp failed.` on macOS means node-pty's `spawn-helper` lost its executable
bit. `npm ci` repairs it via `postinstall`; to check by hand, `npm test` reports the mode.

`Cannot find module 'node-pty'` means the install did not complete — re-run `npm ci`.

## Testing

```bash
npm test
```

Pure-function tests, the `/usage` parser against synthetic captures, a PTY spawn round-trip
(no Claude Code needed), and a real `node server.js` boot over the synthetic fixture. The last
two exist because a suite of pure functions plus `node --check` stayed green through both
failures that made the published Quick Start unusable — a missing dependency and a native
module that could not spawn. CI runs the whole thing on Linux and macOS, on Node 22 and 24.

## Documentation

| File | Contents |
|------|----------|
| `TECHNICAL-NOTES.md` | Measurement methodology: real fuel vs cache reads |
| `LIMITATIONS.md` | Known limitations (PTY dependency, timezone) |

## Design Philosophy

- **Zero build step** — No React, no webpack. Vanilla JS + Chart.js.
- **Local-first, literally** — the dashboard loads no remote resource. Chart.js is served from
  `node_modules` at `/vendor/chart.umd.js`; fonts fall back to system families. Opening the page
  makes no request to any other host. See `SECURITY.md`.
- **Three dependencies** — Express; `node-pty`, because there is no non-interactive way to read
  `/usage`; and `chart.js`, served locally rather than from a CDN so the page stays offline-clean
  and the version is pinned in the lockfile. All three are load-bearing; nothing else is.
- **Official numbers stay official** — the quota gauge is Anthropic's own `/usage` figure. The
  transcript-derived attribution is labelled a proxy everywhere it appears, and the two units are
  never mixed or converted.
- **Validated where it is tested** — macOS and Linux, Node 22 and 24 in CI. Windows is untested
  rather than supported; the honest matrix is in [`LIMITATIONS.md`](LIMITATIONS.md#platform-support).

## Note

This is a personal project, open for anyone who wants to try it. Requires a **Claude Pro or Max subscription** with Claude Code installed and authenticated. The dashboard reads local log files and the CLI's built-in usage display to automate what you'd otherwise check manually. It is not affiliated with or endorsed by Anthropic, and the fuel proxy is ccfuel's own heuristic — for the authoritative number, the `/usage` panel and Anthropic's own usage settings are the source.

## License

MIT

## Contributing

PRs welcome! Open an issue first for major changes.
