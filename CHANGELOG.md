# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
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
