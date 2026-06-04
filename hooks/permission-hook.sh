#!/bin/bash
# Blocking CodeMap hook, used for two events:
#
#  - PreToolUse / AskUserQuestion : pause the question and let the user answer
#    from the hotel; the chosen answer is fed back via deny + additionalContext.
#  - PermissionRequest             : a tool needs the user's approval; let them
#    Allow/Deny from the hotel. PermissionRequest only fires when Claude WOULD
#    actually prompt, so auto/bypass mode and pre-allowed tools are untouched.
#
# Fail-open by design — DEFERS to Claude Code's native flow (never freezes the
# terminal) when there's no session id, the server is unreachable, no hotel
# client is watching (204), or nobody answers in time.
SERVER="http://localhost:5174"
LOG_FILE="/tmp/codemap-hook.log"

INPUT=$(cat)
EVENT=$(echo "$INPUT" | /usr/bin/jq -r '.hook_event_name // empty' 2>/dev/null)
AGENT_ID=$(echo "$INPUT" | /usr/bin/jq -r '.session_id // .conversation_id // empty' 2>/dev/null)
TOOL_USE_ID=$(echo "$INPUT" | /usr/bin/jq -r '.tool_use_id // empty' 2>/dev/null)
TOOL_NAME=$(echo "$INPUT" | /usr/bin/jq -r '.tool_name // empty' 2>/dev/null)

# Abbreviated tool input for the Allow/Deny modal (command / file / pattern).
TOOL_INPUT=$(echo "$INPUT" | /usr/bin/jq -r '
  .tool_input as $i
  | ($i.command // $i.file_path // $i.pattern // ($i | tostring)) // ""' 2>/dev/null | head -c 120)

# Full, untruncated plan markdown carried by an ExitPlanMode call, rendered in the
# hotel modal. Unlike TOOL_INPUT (a 120-char preview) this keeps the whole plan —
# a truncated JSON blob is exactly the bug this avoids.
PLAN=$(echo "$INPUT" | /usr/bin/jq -r '.tool_input.plan // empty' 2>/dev/null)

# Defer = let Claude Code's native flow apply. For PermissionRequest that means
# emitting nothing (the native dialog shows); for PreToolUse, an explicit defer.
defer() {
    if [ "$EVENT" != "PermissionRequest" ]; then
        echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"defer"}}'
    fi
    exit 0
}

[ -z "$AGENT_ID" ] && defer
/usr/bin/curl -s --max-time 0.3 "$SERVER/api/health" >/dev/null 2>&1 || defer

REQUEST_ID="${TOOL_USE_ID:-$AGENT_ID-$(date +%s%N)}"
KIND="question"
[ "$EVENT" = "PermissionRequest" ] && KIND="permission"

# Register the pending request. 204 => no hotel client => defer to the terminal.
PAYLOAD=$(/usr/bin/jq -nc --arg r "$REQUEST_ID" --arg k "$KIND" --arg tn "$TOOL_NAME" --arg ti "$TOOL_INPUT" --arg p "$PLAN" \
    '{requestId:$r, kind:$k, toolName:$tn, toolInput:$ti} + (if $p == "" then {} else {plan:$p} end)')
HTTP=$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
    -X POST "$SERVER/api/agent/$AGENT_ID/permission-request" \
    -H "Content-Type: application/json" -d "$PAYLOAD" 2>/dev/null)
[ "$HTTP" = "200" ] || defer

echo "$(date): [permission] waiting event=$EVENT kind=$KIND agent=${AGENT_ID:0:8} tool=$TOOL_NAME" >> "$LOG_FILE"

# Long-poll for the user's decision. Give the user real time to answer in the
# hotel (5 min) — well under Claude Code's 600s hook timeout. On timeout the hook
# defers to the native flow.
RESP=$(/usr/bin/curl -s --max-time 320 \
    "$SERVER/api/agent/$AGENT_ID/pending-permission?requestId=$REQUEST_ID&maxWaitMs=300000" 2>/dev/null)
OUTCOME=$(echo "$RESP" | /usr/bin/jq -r '.outcome // "timeout"' 2>/dev/null)

echo "$(date): [permission] outcome=$OUTCOME event=$EVENT agent=${AGENT_ID:0:8}" >> "$LOG_FILE"

if [ "$EVENT" = "PermissionRequest" ]; then
    # Allow/Deny a tool. Decision schema: hookSpecificOutput.decision.behavior.
    case "$OUTCOME" in
        allow)
            echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
            ;;
        deny)
            REASON=$(echo "$RESP" | /usr/bin/jq -r '.reason // "Refusé via CodeMap"' 2>/dev/null)
            /usr/bin/jq -nc --arg m "$REASON" '{hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:"deny",message:$m}}}'
            ;;
        *)
            defer
            ;;
    esac
else
    # AskUserQuestion answer flow (PreToolUse): deny the tool but inject the chosen
    # answer as context so the agent proceeds as if the user had answered.
    case "$OUTCOME" in
        answer)
            TEXT=$(echo "$RESP" | /usr/bin/jq -r '.text // ""' 2>/dev/null)
            /usr/bin/jq -nc --arg t "$TEXT" '{
                hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: ("Réponse fournie via CodeMap:\n" + $t),
                    additionalContext: ("The user answered via the CodeMap hotel instead of the AskUserQuestion prompt:\n" + $t)
                }
            }'
            ;;
        allow)
            echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
            ;;
        deny)
            REASON=$(echo "$RESP" | /usr/bin/jq -r '.reason // "Refusé via CodeMap"' 2>/dev/null)
            /usr/bin/jq -nc --arg r "$REASON" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
            ;;
        *)
            defer
            ;;
    esac
fi
exit 0
