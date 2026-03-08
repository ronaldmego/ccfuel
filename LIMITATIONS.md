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
- Debug mode: `node claude-usage.js --debug` writes raw output to `/tmp/claude-usage-debug.log`

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

---

## References

- PTY implementation: `claude-usage.js`
- Timezone details: `TECHNICAL-NOTES.md`
- Anthropic Console: https://console.anthropic.com

---

*Timeless document — limitations only*
