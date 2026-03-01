# Known Limitations

Technical limitations of the dashboard and its data sources.

---

## Data Source: ccusage

The dashboard uses **ccusage** to get Claude Code usage data.

| Aspect | Detail |
|--------|--------|
| **Tool** | ccusage (github.com/ryoppippi/ccusage) |
| **Author** | ryoppippi (community, NOT Anthropic) |
| **License** | MIT (open source) |
| **How it works** | Reads local JSONL files from `~/.claude/` |

---

## What ccusage Does NOT See

ccusage **only reads local Claude Code/CLI logs**. It does not capture:

| Source | Visible? | Reason |
|--------|----------|--------|
| Claude Code on this machine | Yes | Local logs in `~/.claude/` |
| Claude Code on remote machines | Yes (with sync) | Via push-usage.sh -> POST /api/external-usage |
| Claude.ai web | No | Does not generate local JSONL logs |
| Direct API calls | No | Do not go through Claude Code |
| Cursor, Continue, etc. | No | Third-party apps don't use Claude Code |

---

## Impact on the Dashboard

### Underestimated Tokens (non-integrated sources)

The token count reflects the local machine + any synced remote machines. It does not include Claude.ai web or direct API usage. The weekly % from Claude `/usage` DOES include everything.

---

## How to See Global Usage

To see **all** usage on your Anthropic account (regardless of source):

1. **Anthropic Console** (recommended)
   - URL: https://console.anthropic.com
   - Section: Usage
   - Shows everything: API, Claude.ai, any integration

2. **Sync logs from multiple machines** (advanced)
   - Set up `push-usage.sh` on each remote machine (see `LOCALSETUP.md`)
   - The dashboard merges all sources automatically

---

## Timezone: Hardcoded UTC-5

The dashboard assumes **Panama (UTC-5)** as a fixed timezone. It does not use DST or detect the user's timezone.

| Aspect | Status |
|--------|--------|
| Weekly reset time | Interpreted as Panama time |
| "Spent Today" | Day calculated in Panama time |
| Hourly charts | Blocks grouped by Panama hour |
| Browser in other timezone | No impact — does not depend on browser timezone |

To use a different timezone, update `PANAMA_OFFSET` in `index.html` and the equivalent in `server.js`.

### Historical bug: getTimezoneOffset

Before the fix, the frontend used `now.getTimezoneOffset()` from the browser to calculate Panama time. This made calculations depend on the browser's timezone and produced incorrect results if the browser was not in UTC. Fixed by using direct offset from UTC. See `TECHNICAL-NOTES.md` Timezone section for details.

---

## Affected Metrics

| Metric | Affected | Notes |
|--------|----------|-------|
| Weekly fuel (tokens) | Partial | Local + synced machines, excludes web/API |
| Weekly % (Claude /usage) | Complete | Source of truth, includes everything |
| Weekly efficiency | Complete | Based on Claude % |

---

## Recommendations

1. **Trust the Claude /usage %** as the source of truth for global usage
2. **ccusage real tokens** are complementary — they measure local + synced machines but not web/API
3. **Check Anthropic Console** if you need an exact breakdown by source

---

## References

- ccusage repo: https://github.com/ryoppippi/ccusage
- ccusage npm: https://www.npmjs.com/package/ccusage
- Anthropic Console: https://console.anthropic.com

---

*Timeless document — limitations only*

---

## Data Extraction: PTY Dependency (CRITICAL)

The dashboard's **sole data source** is the `/usage` slash command inside Claude Code, accessed via a PTY (pseudo-terminal) session using `node-pty`.

### Why PTY (not CLI, not API, not OTel)

| Alternative | Viable? | Reason |
|-------------|---------|--------|
| `claude usage` CLI subcommand | ❌ No | Does not exist — Claude interprets it as a chat prompt |
| Anthropic API | ❌ No | No endpoint for account quota % |
| OpenTelemetry | ❌ Partial | Exports tokens/costs per request, but NOT weekly quota % (the primary metric). Investigated 2026-03-01, not viable as replacement |
| Claude `/usage` via PTY | ✅ Yes | Only source of `weekAll.percent`, `session.percent`, `weekSonnet.percent` |

### Risks

- **Fragile:** PTY timing is empirical (4s init, 1.5s autocomplete wait). Claude CLI updates can break it.
- **Slow:** Each fetch takes ~20-25 seconds (spawn, init, command, parse, kill).
- **One at a time:** Cannot run multiple PTY sessions simultaneously (Claude detects and rejects).
- **Env-sensitive:** Must filter `CLAUDECODE` env var or Claude refuses to start.

### Mitigation

- 5-minute cache on successful fetches (avoids hammering PTY)
- 35-second timeout with graceful fallback
- Debug mode: `node claude-usage.js --debug` writes raw output to `/tmp/claude-usage-debug.log`

