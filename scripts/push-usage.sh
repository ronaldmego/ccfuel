#!/bin/bash
# Push ccusage data from this machine to a remote dashboard server
# Usage: DASHBOARD_URL=http://your-server:3400 bash push-usage.sh
# Hook:  Runs automatically via Claude Code SessionEnd hook
# Cron:  crontab or Task Scheduler as backup

DASHBOARD_URL="${DASHBOARD_URL:-${VPS_URL:-http://localhost:3400}}"
SOURCE="laptop"
TMPDIR="${TEMP:-${TMP:-/tmp}}"
PAYLOAD="$TMPDIR/ccusage-payload.json"
LOGFILE="$TMPDIR/push-usage.log"

log() { echo "$(date '+%H:%M:%S') $1" >> "$LOGFILE"; }

log "Starting push-usage..."

# Generate ccusage data
npx ccusage@latest blocks --json 2>/dev/null > "$TMPDIR/ccusage-blocks.json"
npx ccusage@latest daily --json 2>/dev/null > "$TMPDIR/ccusage-daily.json"

if [ ! -s "$TMPDIR/ccusage-blocks.json" ] || [ ! -s "$TMPDIR/ccusage-daily.json" ]; then
  log "Error: ccusage failed to produce output"
  exit 1
fi

# Build payload via node (avoids argument-too-long on large datasets)
node -e "
const fs=require('fs'),p=require('path'),t=process.env.TEMP||process.env.TMP||'/tmp';
const b=JSON.parse(fs.readFileSync(p.join(t,'ccusage-blocks.json'),'utf8'));
const d=JSON.parse(fs.readFileSync(p.join(t,'ccusage-daily.json'),'utf8'));
fs.writeFileSync(p.join(t,'ccusage-payload.json'),JSON.stringify({source:'$SOURCE',blocks:b,daily:d}));
"

if [ ! -s "$PAYLOAD" ]; then
  log "Error: failed to build payload"
  exit 1
fi

RESPONSE=$(curl -s -X POST "$DASHBOARD_URL/api/external-usage" \
  -H 'Content-Type: application/json' \
  -d @"$PAYLOAD")

log "Response: $RESPONSE"
echo "$RESPONSE"
