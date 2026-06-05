#!/bin/bash
# Cursor stop hook - captures agent completion status
# Called when a Cursor agent completes, aborts, or errors

SERVER_URL="http://localhost:5174/api/thinking"
LOG_FILE="/tmp/codetown-hook.log"

# Read JSON from stdin
INPUT=$(cat)

# Extract conversation_id (Cursor's agent identifier)
AGENT_ID=$(echo "$INPUT" | /usr/bin/jq -r '.conversation_id // empty' 2>/dev/null)

if [ -z "$AGENT_ID" ]; then
    echo "$(date): STOP SKIP - no conversation_id" >> "$LOG_FILE"
    exit 0
fi

# Extract status: completed, aborted, or error
STATUS=$(echo "$INPUT" | /usr/bin/jq -r '.status // empty' 2>/dev/null)

# Extract loop_count if available
LOOP_COUNT=$(echo "$INPUT" | /usr/bin/jq -r '.loop_count // empty' 2>/dev/null)

# Log for debugging
echo "$(date): [cursor] STOP agent=${AGENT_ID:0:8} status=$STATUS loops=$LOOP_COUNT" >> "$LOG_FILE"

# Build JSON payload
JSON_PAYLOAD="{\"type\":\"agent-stop\",\"agentId\":\"$AGENT_ID\",\"source\":\"cursor\",\"timestamp\":$(date +%s000)"

if [ -n "$STATUS" ]; then
    JSON_PAYLOAD="$JSON_PAYLOAD,\"status\":\"$STATUS\""
fi
if [ -n "$LOOP_COUNT" ] && [ "$LOOP_COUNT" != "null" ]; then
    JSON_PAYLOAD="$JSON_PAYLOAD,\"loopCount\":$LOOP_COUNT"
fi

JSON_PAYLOAD="$JSON_PAYLOAD}"

# Send event to server (non-blocking with timeout)
/usr/bin/curl -s -X POST "$SERVER_URL" \
    -H "Content-Type: application/json" \
    -d "$JSON_PAYLOAD" \
    --connect-timeout 1 \
    --max-time 2 \
    >/dev/null 2>&1 &

exit 0
