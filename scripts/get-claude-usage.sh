#!/bin/bash
# Script para obtener /usage de Claude Code
# Usa 'script' para crear PTY y capturar output

LOGFILE="/tmp/claude-usage-output.log"
FIFO="/tmp/claude-usage-fifo"
DEBUG_LOG="/tmp/claude-usage-debug.log"

cleanup() {
    rm -f "$FIFO" 2>/dev/null
    pkill -f "script.*claude-usage" 2>/dev/null || true
}
trap cleanup EXIT

# Remove old fifo if exists
rm -f "$FIFO" 2>/dev/null

# Create named pipe for input
mkfifo "$FIFO" || exit 1

# Run claude with script in background
cd ~/projects/token-dashboard
script -q "$LOGFILE" -c "claude" < "$FIFO" 2>/dev/null &
SCRIPT_PID=$!

# Send commands with delays
{
    sleep 3      # Wait for claude to load
    printf '/usage\n'
    sleep 3      # Wait for usage data to load
    printf '\x1b'  # ESC to close usage panel
    sleep 1
    printf '/exit\n'
    sleep 1
} > "$FIFO" &

# Wait for script with timeout
timeout 20 wait $SCRIPT_PID 2>/dev/null || {
    kill $SCRIPT_PID 2>/dev/null
    kill %1 2>/dev/null
}

# Parse the log file
if [ -f "$LOGFILE" ]; then
    # Save debug copy
    cp "$LOGFILE" "$DEBUG_LOG" 2>/dev/null
    
    # Remove ANSI codes and clean up
    CLEAN=$(cat "$LOGFILE" | \
        sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' | \
        sed 's/\x1b\[[0-9;]*m//g' | \
        tr -cd '[:print:]\n' | \
        tr -s ' \n')
    
    # Extract percentages - look for patterns like "14% used" or "38% used"
    # The usage output shows: XX% used multiple times
    PERCENTS=$(echo "$CLEAN" | grep -oE '[0-9]+%[[:space:]]*used' | grep -oE '^[0-9]+' | head -3)
    
    # Read into variables
    SESSION_PCT=$(echo "$PERCENTS" | sed -n '1p')
    WEEK_ALL_PCT=$(echo "$PERCENTS" | sed -n '2p')
    WEEK_SONNET_PCT=$(echo "$PERCENTS" | sed -n '3p')
    
    # Default to 0 if empty
    SESSION_PCT=${SESSION_PCT:-0}
    WEEK_ALL_PCT=${WEEK_ALL_PCT:-0}
    WEEK_SONNET_PCT=${WEEK_SONNET_PCT:-0}
    
    # Check extra usage status
    EXTRA_ENABLED="false"
    if echo "$CLEAN" | grep -qi "extra usage enabled"; then
        EXTRA_ENABLED="true"
    fi
    
    # Output JSON
    cat << EOF
{
  "success": true,
  "timestamp": "$(date -Iseconds)",
  "session": {
    "percent": $SESSION_PCT
  },
  "weekAll": {
    "percent": $WEEK_ALL_PCT
  },
  "weekSonnet": {
    "percent": $WEEK_SONNET_PCT
  },
  "extraUsageEnabled": $EXTRA_ENABLED
}
EOF
else
    echo '{"success": false, "error": "Failed to capture output"}'
fi
