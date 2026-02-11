#!/bin/bash
# Push ccusage data from laptop to VPS token-dashboard
# Usage: bash push-usage.sh
# Cron:  */5 * * * * /path/to/push-usage.sh

VPS_URL="http://100.64.216.28:3400"
SOURCE="laptop"

BLOCKS=$(npx ccusage@latest blocks --json 2>/dev/null)
DAILY=$(npx ccusage@latest daily --json 2>/dev/null)

if [ -z "$BLOCKS" ] || [ -z "$DAILY" ]; then
  echo "Error: ccusage failed to produce output"
  exit 1
fi

RESPONSE=$(curl -s -X POST "$VPS_URL/api/external-usage" \
  -H 'Content-Type: application/json' \
  -d "{\"source\":\"$SOURCE\",\"blocks\":$BLOCKS,\"daily\":$DAILY}")

echo "$RESPONSE"
