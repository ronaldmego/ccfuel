# 📊 Claude Code Usage Dashboard

Real fuel monitoring for Claude Code. Track the tokens that **actually burn your weekly quota**, ignoring cache reads (~96% of volume) that cost nothing.

> Stop guessing. Know exactly how much Claude Code fuel you have left.

## Why This Exists

Claude Code has a weekly token limit. Burn it all and you're locked out until reset. But ~96% of reported tokens are **cache reads** — they don't count against your quota. This dashboard separates signal from noise.

**What it tells you:**

- 🔥 **How much fuel is left** — Real weekly % (direct from Claude `/usage`)
- 📈 **Your burn rate** — Weekly pace with alerts if you're running hot
- 📅 **When you'll run out** — Projected depletion day
- 💰 **Daily real cost** — Actual tokens, not inflated with cache reads

## What It Measures (and What It Doesn't)

| Token Type | Counted? | Why |
|-----------|----------|-----|
| outputTokens | ✅ Yes | What Claude generates — costs quota |
| inputTokens | ✅ Yes | New context — costs quota |
| cacheCreationTokens | ✅ Yes | First cache write — costs quota |
| **cacheReadTokens** | ❌ **No** | ~96% of volume, free or near-free |

**Formula:** `realTokens = totalTokens - cacheReadTokens`

See `TECHNICAL-NOTES.md` for the full methodology.

## Screenshots

_Coming soon_

## Stack

```
Node.js + Express
Frontend: Vanilla HTML/CSS/JS + Chart.js (single index.html, no build step)
Data: ccusage (parses JSONL logs) + Claude /usage (via PTY)
Process Manager: PM2 (optional)
```

## Quick Start

```bash
# Clone
git clone https://github.com/ronaldmego/claude-code-usage-dashboard.git
cd claude-code-usage-dashboard

# Install
npm install

# Configure
cp .env.example .env
# Edit .env — set host, port, and path to Claude logs

# Run
node server.js
# Or with PM2:
pm2 start server.js --name token-dashboard
```

Open `http://localhost:3400` in your browser.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_HOST` | `127.0.0.1` | Bind address |
| `DASHBOARD_PORT` | `3400` | Server port |
| `CLAUDE_LOGS_DIR` | `~/.claude` | Path to Claude Code JSONL logs |

## Architecture

```
Local machine (~/.claude/*.jsonl)  ──▶  ccusage  ──▶  server.js  ──▶  Dashboard
                                                          ▲
Remote machines (push-usage.sh)  ──POST /api/external-usage──┘
                                                          │
Claude Code (/usage PTY)  ──▶  claude-usage.js  ──────────┘
```

- **Local**: ccusage parses JSONL logs every 5 min
- **Remote**: `push-usage.sh` runs ccusage locally and POSTs data to the dashboard
- **Claude /usage**: PTY wrapper runs the real command to get account-level %

## Multi-Machine Sync

See `LOCALSETUP.md` for setting up automatic sync from laptop/other machines.

## Documentation

| File | Contents |
|------|----------|
| `CLAUDE.md` | Guide for Claude Code (philosophy, architecture, commands) |
| `TECHNICAL-NOTES.md` | Measurement methodology: real fuel vs cache reads |
| `LOCALSETUP.md` | Laptop → server sync setup |
| `LIMITATIONS.md` | Known data source limitations |
| `CHANGELOG.md` | Version history |

## Design Philosophy

- **Zero build step** — No React, no webpack. Vanilla JS + Chart.js.
- **Single dependency** — Express. That's it.
- **Real metrics only** — Cache reads are noise. We filter them out.
- **Multi-machine** — Works with multiple Claude Code installations pushing data to one dashboard.

## License

MIT

## Contributing

PRs welcome! Open an issue first for major changes.
