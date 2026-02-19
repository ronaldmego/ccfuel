# Multi-Machine Sync Setup

> **Optional.** Only needed if you run Claude Code on more than one machine and want to see combined usage in a single dashboard.

How to sync usage data from a remote machine (e.g., laptop) to the machine running the dashboard.

---

## How It Works

Each machine running Claude Code generates logs in `~/.claude/`. The script `push-usage.sh` runs ccusage locally on the remote machine, packages the data (blocks + daily) as JSON, and POSTs it to the dashboard via `POST /api/external-usage`. The dashboard automatically combines local + remote data.

```
Remote machine                  Dashboard server
~/.claude/*.jsonl
    |
    v
ccusage (blocks+daily)
    |
    v
push-usage.sh
    |
    |--POST /api/external-usage-->  data/external/<source>.json
    |                                    |
    |                                    v
    |                              Dashboard (merged view)
```

---

## Sync Methods

### 1. Claude Code Hook (recommended)

Runs automatically at the end of every Claude Code session.

**Configuration:** `~/.claude/settings.json` on the remote machine

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$HOME/path/to/scripts/push-usage.sh\"",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

- **Empty matcher** = runs for all sessions (any project)
- **Timeout 120s** = enough for ccusage + upload
- No duplicates: the dashboard overwrites the source file each time

### 2. Scheduled Task (backup)

Run the same script on a schedule as a safety net.

**Linux/macOS (cron):**

```bash
# Run daily at 11pm
0 23 * * * bash /path/to/scripts/push-usage.sh
```

**Windows (Task Scheduler):**

| Field | Value |
|-------|-------|
| Task name | `PushCcusageToServer` |
| Schedule | 23:00 daily |
| Runs | `bash push-usage.sh` |

```bash
# Check status (Git Bash)
MSYS_NO_PATHCONV=1 schtasks /query /tn "PushCcusageToServer"

# Run manually
MSYS_NO_PATHCONV=1 schtasks /run /tn "PushCcusageToServer"
```

Note: `MSYS_NO_PATHCONV=1` is needed in Git Bash to prevent path conversion of `/tn`.

### 3. Manual

```bash
bash /path/to/scripts/push-usage.sh
```

---

## Script: push-usage.sh

**Location:** `scripts/push-usage.sh`

Flow:
1. Runs `npx ccusage@latest blocks --json` and `daily --json`
2. Saves to temp files (avoids "argument list too long")
3. Builds JSON payload via Node.js
4. POSTs to `http://<DASHBOARD_URL>/api/external-usage` (set `DASHBOARD_URL` env var in the script)
5. Logs to `$TEMP/push-usage.log`

**Requirements:** Node.js, npx, curl, network access to the dashboard server.

---

## Troubleshooting

```bash
# Check last push log
cat "$TEMP/push-usage.log"

# Manual test
bash /path/to/scripts/push-usage.sh

# Verify data on dashboard server
curl -s http://localhost:3400/api/external-usage | node -e "
  let d='';process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const j=JSON.parse(d);
    Object.keys(j.sources||{}).forEach(s => {
      const src=j.sources[s];
      console.log(s+': updated '+src.lastUpdate+', daily entries: '+src.daily.daily.length);
    });
  });
"

# Verify hook is configured (on remote machine)
cat ~/.claude/settings.json | node -e "
  let d='';process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const j=JSON.parse(d);
    const h=j.hooks?.SessionEnd;
    console.log('SessionEnd hooks:', h ? h.length : 'NONE');
  });
"
```

---

*Timeless document — setup instructions only*
