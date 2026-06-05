#!/bin/bash
# SessionStart hook — works with BOTH Claude Code AND any tool emitting a
# session-start event. Boots the CodeTown server (:5174) + Vite client (:5173)
# the moment a session opens, so the hotel is already up before the agent's
# first tool call.
#
# Why this exists: the file/thinking hooks also call ensure_codetown_server, but
# only on the first PreToolUse/PostToolUse. That makes the server appear lazily
# (and never, for a session opened before the hooks were wired). Starting it
# here on SessionStart removes that gap for every new session.

# Drain the SessionStart payload from stdin; we don't need any of its fields,
# but leaving it unread can hand the caller a broken pipe.
cat >/dev/null 2>&1

# CODETOWN_ROOT is derived from this script's own location, so it is correct no
# matter which project the session was opened in.
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODETOWN_ROOT="$(dirname "$HOOK_DIR")"
source "$HOOK_DIR/lib/ensure-server.sh"
ensure_codetown_server "$CODETOWN_ROOT"

# Always exit successfully so a slow/failed boot never blocks session startup.
exit 0
