# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Changed
- **README screenshots regenerated from synthetic demo data.** The published ones showed the maintainer's real quota percentages and predated the current UI copy. All three now come from `npm run demo`, each carrying the "synthetic data" banner — which is now pinned to the top of the viewport, so it cannot scroll out of a capture or out of a screen recording. Added a dedicated `what-burned-it.png` for the fuel-proxy panel, which the old set did not show at all ([#47](https://github.com/ronaldmego/ccfuel/issues/47))
- **The dashboard no longer loads anything from the internet, which is what `SECURITY.md` already promised.** The page pulled IBM Plex from `fonts.googleapis.com` / `fonts.gstatic.com` and Chart.js from `cdn.jsdelivr.net`, so "no third-party calls beyond running your local `claude` binary" was false — every load announced itself to two CDNs, and the Chart.js tag was **unpinned** (`npm/chart.js`), meaning a third party chose which code ran in the page. `chart.js` is now a pinned dependency served from `node_modules` at `/vendor/chart.umd.js`; the font stacks keep their named families and fall through to system fonts, with no webfont fetched and no binary vendored into the repo. Enforced by `test/claims.test.js` (no remote resource in any runtime tag, Chart.js loaded from the local route, dependency declared) and `test/server-smoke.test.js` (the route serves the real runtime). `SECURITY.md` now also states plainly what *does* touch the network: the npm registry at install time, and the `claude` binary's own traffic ([#47](https://github.com/ronaldmego/ccfuel/issues/47))
- Replaced "Works anywhere" with the validated matrix — macOS and Linux, Node 22 and 24 in CI, Windows untested — which is what `LIMITATIONS.md` already said. Dependency count corrected to three ([#47](https://github.com/ronaldmego/ccfuel/issues/47))
- **Corrected what the project claims about quota, and separated the official gauge from the local proxy.** The docs and UI said cache reads "cost nothing", "don't count against your quota", and that ccfuel tracks the tokens that "actually burn your weekly quota". None of that is supportable: Anthropic's caching pricing bills cache reads at **0.1× the base input token price** (favorable, at a reduced rate), and while the usage-limit guidance does say cached *project* content "doesn't count against your limits when reused", Anthropic publishes **no formula** mapping Claude Code's four transcript counters onto the weekly percentage. The framing is now explicit throughout: `/usage` is the official source of quota percentage; `fuel = output + input + cache_creation` is **ccfuel's own proxy** for where the non-cache work concentrated; the two are different units and are never converted; cache reads are excluded for two stated reasons (favorable treatment, and dominant volume that buries the signal); and the ~96% figure is labelled an observation of the maintainer's 1,778-session corpus rather than a constant. Both sources are cited in README, LIMITATIONS and TECHNICAL-NOTES. No algorithm changed ([#47](https://github.com/ronaldmego/ccfuel/issues/47))
- `test/claims.test.js` enforces the above on the publication surface — README, LIMITATIONS, TECHNICAL-NOTES, `package.json`, the dashboard HTML and the three modules — failing on absolute phrasing and on a bare ~96% with no corpus attribution, and requiring the proxy disclaimer plus both source links in the README. An unsupported claim is cheap to reintroduce in a doc edit and expensive to publish ([#47](https://github.com/ronaldmego/ccfuel/issues/47))

### Fixed
- **`npm ci` from a clean clone produced an app that could not start.** `node-pty` was required by the code and present in the lockfile but missing from `package.json`, so `npm ci` pruned it, exited `0`, and `node server.js` died with `MODULE_NOT_FOUND`. The lockfile also still carried the pre-rename package name. Both reconciled, and `engines` now declares the supported Node range ([#47](https://github.com/ronaldmego/ccfuel/issues/47))
- **`posix_spawnp failed.` on macOS.** node-pty 1.1.0 publishes its macOS prebuild with a non-executable `spawn-helper`, which the native layer must exec to set up the terminal. Every spawn failed, on Node 22, 24 and 25 alike — it was never a Node compatibility problem, and never about locating the `claude` binary (`pty.spawn('/bin/echo')` failed identically). A `postinstall` restores the bit; Linux was unaffected because it has no prebuild and compiles from source ([#47](https://github.com/ronaldmego/ccfuel/issues/47))
- **First snapshot on a fresh clone failed with `ENOENT`** — nothing created `data/`. It is now created on boot, and its location is configurable via `DASHBOARD_DATA_DIR` ([#47](https://github.com/ronaldmego/ccfuel/issues/47))
- **The `/usage` reset parser no longer hardcodes UTC-5.** It takes `DASHBOARD_TIMEZONE` like the rest of the app, so a user outside that offset no longer gets reset instants shifted by hours — which fed `weekId` and could land the cycle window a day off ([#47](https://github.com/ronaldmego/ccfuel/issues/47))
- Dependency advisories cleared: `npm audit` reports 0 vulnerabilities (was 1 high + 3 moderate, via `express`, `qs`, `body-parser` and `path-to-regexp`) ([#47](https://github.com/ronaldmego/ccfuel/issues/47))

### Added
- **A trust prompt and a login wall are now named failures instead of a silent 35-second timeout.** Claude Code trusts folders one at a time, and its trust prompt swallows the keystrokes ccfuel types — so on a fresh clone, which is by definition untrusted, every fetch timed out with nothing to diagnose. `/api/global-usage` now reports a `failureKind` (`trust-prompt`, `login-required`, `timeout`, `exited-early`) and both boot states end the fetch immediately with an actionable message. The prompts are detected, never answered: accepting one is the user's decision. `DASHBOARD_CLAUDE_CWD` points the spawn at a folder that is already trusted ([#47](https://github.com/ronaldmego/ccfuel/issues/47))
- **Tests that can fail when the app cannot start.** A PTY spawn round-trip (no Claude Code needed) and a real `node server.js` boot over a synthetic fixture, plus the first tests for `parseUsageOutput()` — the data engine had none. CI now runs on macOS as well as Linux, on Node 22 and 24, and audits: the previous Linux-only, pure-function-only pipeline stayed green through every failure above ([#47](https://github.com/ronaldmego/ccfuel/issues/47))
- **`npm run demo`** — serves the dashboard on a synthetic fixture with both collectors off (no PTY spawn, no transcript read) behind a "synthetic data" banner, so the UI can be screenshotted without publishing your own numbers. Same fixture the server smoke test asserts against. `node server.js` is unchanged ([#47](https://github.com/ronaldmego/ccfuel/issues/47))

### Changed
- `/usage` collection is **~6x cheaper**: 35 s → ~6 s of process lifetime per fetch, 523 MB → 327 MB, two processes → one. Three causes, each of which produced correct data and so left no symptom to chase: the early-exit condition required a string (`extra usage`) the panel does not render, so every fetch silently ran to the 35 s timeout and was rescued by the timeout's own parse; `/usage` was typed on a fixed 4 s timer and was swallowed whenever the TUI had not finished booting, which was the recurring ~15% of fetches that returned nothing; and the spawn booted every configured MCP server to type a slash command that never calls a tool. The exit condition is now the parse succeeding, the keystroke retries until its echo appears, and the spawn runs with `--strict-mcp-config` and an empty MCP config ([#44](https://github.com/ronaldmego/ccfuel/issues/44))

### Added
- A failed fetch now retries once inside the same collector cycle instead of waiting a full interval, and dumps the raw `/usage` buffer when the parse fails on timeout — previously the only failure that actually recurred was also the only one that left no evidence ([#44](https://github.com/ronaldmego/ccfuel/issues/44))
- Diagnostic logging for a **sustained** weekly-% drop within a cycle (physically impossible for a cumulative unless the cycle reset): when `weekAll%` falls >15pp below the last good value, the raw `/usage` text and both `resetsAt` anchors are logged, so the residual mid-cycle-cliff mode can be diagnosed from evidence (reset-at-an-unexpected-day vs inflated-prior-read vs mis-parsed section). The raw blob is debug-only — never cached, served, or persisted ([#37](https://github.com/ronaldmego/ccfuel/issues/37))

### Fixed
- Cumulative usage chart showed a false mid-cycle valley (the "This week" series crashing to ~0% and re-climbing). Root cause was in the capture layer, not the chart: a `/usage` read starved by parallel `claude -p` sessions comes back without a parseable weekly `% used`, which the parser defaulted to `0`, and the `success` gate (which only required session **or** week `> 0`) let it through — persisting a spurious `weekPercent: 0` mid-cycle. The parser now returns `null` for an unparseable percent (distinct from a real `0%`), `success` requires the weekly % to have parsed, and the snapshot is skipped otherwise; the starved raw read is logged so the residual failure mode (low mis-parsed values / possible non-Monday reset) can be diagnosed from evidence. Anomaly filtering (#28) is unchanged ([#35](https://github.com/ronaldmego/ccfuel/issues/35))
- Dashboard intermittently showed `0% used` / `100% remaining` when usage existed: a timed-out `/usage` fetch (`success: false`, `0%`) was cached over the last good value. Failed fetches now keep the last good value and skip snapshots ([#34](https://github.com/ronaldmego/ccfuel/issues/34))

### Changed
- **Public OSS prep** — renamed to **ccfuel**, translated the UI to English, added an own fuel-gauge logo (trademark-safe), sanitized internal references, and added CONTRIBUTING / SECURITY / issue & PR templates and a minimal CI ([#32](https://github.com/ronaldmego/ccfuel/issues/32))

## 2026-06-16

### Changed
- Redesigned the UI to a light corporate/executive theme: light background, white surfaces, navy accents, IBM Plex typography (Sans + tabular Mono), SVG line icons instead of emoji, and professional copy. Removed the misleading linear "depletion projection" card, keeping only measured data ([#30](https://github.com/ronaldmego/ccfuel/issues/30))

## 2026-05-30

### Fixed
- "Current rate" and the 48h chart froze on a non-monotonic week. `filterAnomalies()` now distinguishes transient jitter from a sustained level shift via lookahead, instead of anchoring on a peak and discarding later snapshots ([#28](https://github.com/ronaldmego/ccfuel/issues/28))

### Added
- PM2 restart policy (`max_memory_restart` + daily `cron_restart`) — defensive hygiene for the long-lived parent process ([#26](https://github.com/ronaldmego/ccfuel/issues/26))

## 2026-05-26

### Added
- Server-side automatic collector (in-process scheduler) so usage snapshots keep recording even when no browser has the dashboard open ([#24](https://github.com/ronaldmego/ccfuel/issues/24))

## 2026-04-21

### Fixed
- Weekly history painted fixed +7d end dates and marked the "current" row by array index; it now resolves the real cycle boundaries and current week ([#23](https://github.com/ronaldmego/ccfuel/issues/23))

## 2026-03-31

### Fixed
- Dashboard didn't load over Tailscale (server was bound to `127.0.0.1`); the bind host is now configurable via `DASHBOARD_HOST`

## 2026-03-01

### Fixed
- **Critical:** rewrote `claude-usage.js` from a bogus `execSync('claude usage')` to `node-pty` driving the interactive `/usage` slash command — the real data engine ([#18](https://github.com/ronaldmego/ccfuel/issues/18), [#19](https://github.com/ronaldmego/ccfuel/pull/19))

## 2026-02-26

### Changed
- Dashboard reworked to be fully based on `%` deltas from `/usage` snapshots (dropped the external `ccusage` dependency)

## 2026-02-21

### Fixed
- Dashboard intermittently showed 0% on everything ([#12](https://github.com/ronaldmego/ccfuel/issues/12))

## 2026-02-17

### Fixed
- Session reset showed the weekly reset date instead of the session reset ([#1](https://github.com/ronaldmego/ccfuel/issues/1))
