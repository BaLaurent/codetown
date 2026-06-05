#!/bin/bash
# Ensures both the CodeTown server (:5174) and the Vite client (:5173) are
# running, launching whichever is down, detached. Each is guarded by a port
# check + its own flock so only one hook wins the cold-start race and an
# already-running instance is never double-started. Best-effort: never blocks.
#
# Crash-loop guard: `tsx watch` does NOT restart its child after a crash (it
# idles), so recovery comes from THIS script re-spawning on the next hook event.
# But every hook event firing a fresh spawn while a service crash-loops once
# piled up ~46 detached supervisors fighting over the port. So each spawn is
# rate-limited by an exponential backoff persisted to a state file and consulted
# UNDER the flock — the only way independent, short-lived hook processes can
# agree to space their retries instead of each starting its own.
#
# Note: the backoff caps the spawn *rate*, not the lifetime *total* — a service
# that crash-loops forever still leaks ~1 supervisor/minute at the 60s ceiling.
# Reaping dead supervisors is a separate concern, deliberately not done here.

# Spawn one detached service behind a port check, a flock, and an exponential
# backoff. Args:
#   $1 name (for logs)   $2 health URL          $3 lock file path
#   $4 service log file   $5 max wait half-secs   $6.. spawn command
_ensure_service() {
  local name="$1" health="$2" lock="$3" log="$4" tries="$5"
  shift 5
  local backoff="${lock%.lock}.backoff"

  # Fast path: already up. Clear the failure counter so a LATER crash retries
  # immediately instead of inheriting a stale backoff window.
  if /usr/bin/curl -s --connect-timeout 1 --max-time 1 "$health" >/dev/null 2>&1; then
    rm -f "$backoff"
    return 0
  fi

  (
    flock -n 9 || exit 0   # another hook is already mid cold-start
    # Re-check under the lock — it may have come up while we blocked.
    if /usr/bin/curl -s --connect-timeout 1 --max-time 1 "$health" >/dev/null 2>&1; then
      rm -f "$backoff"
      exit 0
    fi

    # State file holds "<consecutive-failures> <last-attempt-epoch>".
    local now failures=0 last=0 delay=0
    now=$(date +%s)
    if [ -r "$backoff" ]; then
      read -r failures last < "$backoff" 2>/dev/null || true
      case "$failures" in ''|*[!0-9]*) failures=0;; esac
      case "$last"     in ''|*[!0-9]*) last=0;; esac
    fi

    # Required gap since the last attempt: 2^failures, capped at 60s (0 on the
    # first try). `failures` is stored capped at 6, so `1 << failures` never
    # exceeds 64 and can never overflow bash's signed 64-bit shift (which would
    # wrap to a negative/tiny delay and silently re-open the spawn floodgate).
    if [ "$failures" -gt 0 ]; then
      delay=$(( 1 << failures ))
      [ "$delay" -gt 60 ] && delay=60
    fi
    if [ $(( now - last )) -lt "$delay" ]; then
      exit 0   # still inside the backoff window from a recent failed attempt
    fi

    # Record THIS attempt before spawning so concurrent/next hooks honour it.
    echo "$(( failures + 1 > 6 ? 6 : failures + 1 )) $now" > "$backoff"

    # 9>&- : close the inherited flock fd in the detached child. Otherwise the
    # npm/tsx-watch tree keeps fd 9 open for its whole life, the lock is never
    # released after this subshell exits, and every future `flock -n 9` fails —
    # recovery deadlocks (the bug fixed in commit 46ad99e).
    "$@" >"$log" 2>&1 9>&- &

    # Wait briefly; on success clear the backoff, else leave it bumped so the
    # next attempt waits longer. Breaks early, so a healthy start costs ~one
    # check rather than the whole window.
    local i
    for (( i = 0; i < tries; i++ )); do
      sleep 0.5
      if /usr/bin/curl -s --connect-timeout 1 --max-time 1 "$health" >/dev/null 2>&1; then
        rm -f "$backoff"
        break
      fi
    done
  ) 9>"$lock"
}

ensure_codetown_server() {
  local codetown_root="$1"   # absolute path to the codetown repo (contains package.json)

  # Server (:5174) — required to capture agent/activity events, so wait a few
  # seconds for it to come up since the events that follow this hook need it.
  _ensure_service "CodeTown server" "http://localhost:5174/api/health" \
    "/tmp/codetown-server.lock" "/tmp/codetown-server.log" 10 \
    nohup npm --prefix "$codetown_root" run dev:server

  # Client / Vite (:5173) — the visualisation itself. Nothing downstream depends
  # on it, so its wait is short (just enough to confirm the spawn and reset the
  # backoff); a fast Vite start breaks out in one check.
  _ensure_service "Vite client" "http://localhost:5173/" \
    "/tmp/codetown-client.lock" "/tmp/codetown-client.log" 6 \
    nohup npm --prefix "$codetown_root" run dev:client
}
