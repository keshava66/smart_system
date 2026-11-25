#!/usr/bin/env bash
# Start, stop and watch the SmartHub frontend server (server.mjs).
#
#   scripts/frontend.sh start | stop | restart | reload | status | ensure
#
# Settings are read from frontend/.env.server when it exists, one per line:
#   PORT=3000  HOST=0.0.0.0  WORKERS=2  TLS_CERT=/path/cert.pem  TLS_KEY=/path/key.pem
#   NODE_BIN=/full/path/to/node  (needed under cron, which has a short PATH)
# Logs go to frontend/logs/frontend.log, rotated at 50 MB, 5 files kept.
#
# reload  restarts workers one at a time with no downtime (after a cert change).
# ensure  starts the server if it is down or not answering; meant for cron:
#   @reboot     /full/path/frontend/scripts/frontend.sh start
#   */5 * * * * /full/path/frontend/scripts/frontend.sh ensure
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

if [[ -f .env.server ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.server
  set +a
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
export PORT="${PORT:-3000}"
export LOG_FILE="${LOG_FILE:-$APP_DIR/logs/frontend.log}"
export PID_FILE="${PID_FILE:-$APP_DIR/run/frontend.pid}"
OUT_FILE="$(dirname "$LOG_FILE")/frontend.out"

# Without a terminal (cron's @reboot) there is no one to read the output, and
# cron would mail it to the local mailbox. Keep it in the .out log instead.
if [[ ! -t 1 && "${1:-}" != "status" ]]; then
  mkdir -p "$(dirname "$OUT_FILE")"
  exec >>"$OUT_FILE" 2>&1
  # ensure runs every 5 minutes and logs only when it acts.
  if [[ "${1:-}" != "ensure" ]]; then
    echo "$(date '+%Y-%m-%dT%H:%M:%S%z') $0 ${1:-}"
  fi
fi

scheme=http
[[ -n "${TLS_CERT:-}" ]] && scheme=https
health_host="${HOST:-127.0.0.1}"
[[ "$health_host" == "0.0.0.0" || "$health_host" == "::" ]] && health_host=127.0.0.1
HEALTH_URL="$scheme://$health_host:$PORT/healthz"

stamp() { date '+%Y-%m-%dT%H:%M:%S%z'; }

running_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(<"$PID_FILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q 'server\.mjs' || return 1
  echo "$pid"
}

healthy() {
  # -k: the certificate is issued for the public host name, not 127.0.0.1.
  curl -fsk --max-time 3 -o /dev/null "$HEALTH_URL"
}

start() {
  local pid
  if pid="$(running_pid)"; then
    echo "Already running (pid $pid)"
    return 0
  fi
  if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
    echo "node not found. Set NODE_BIN in $APP_DIR/.env.server" >&2
    return 1
  fi
  if [[ ! -f dist/index.html ]]; then
    echo "No build in $APP_DIR/dist. Run: npm run build" >&2
    return 1
  fi

  mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$PID_FILE")"
  rm -f "$PID_FILE"
  echo "$(stamp) starting" >>"$OUT_FILE"
  # 9>&-: the server must not inherit the lock, or every later command waits on it.
  setsid "$NODE_BIN" server.mjs >>"$OUT_FILE" 2>&1 </dev/null 9>&- &
  local launched=$!

  for _ in $(seq 1 30); do
    sleep 0.5
    if healthy; then
      echo "Running (pid $launched) at $scheme://$(hostname -f 2>/dev/null || hostname):$PORT"
      return 0
    fi
    kill -0 "$launched" 2>/dev/null || break
  done

  kill -TERM "$launched" 2>/dev/null || true
  echo "Did not start. Recent output:" >&2
  tail -n 15 "$OUT_FILE" >&2 || true
  [[ -f "$LOG_FILE" ]] && tail -n 15 "$LOG_FILE" >&2
  return 1
}

stop() {
  local pid
  if ! pid="$(running_pid)"; then
    echo "Not running"
    rm -f "$PID_FILE"
    return 0
  fi
  kill -TERM "$pid"
  for _ in $(seq 1 40); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Stopped"
      return 0
    fi
    sleep 0.5
  done
  echo "Still running after 20s, killing it" >&2
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
}

reload() {
  local pid
  if ! pid="$(running_pid)"; then
    echo "Not running" >&2
    return 1
  fi
  kill -USR2 "$pid"
  echo "Restarting workers one at a time (pid $pid). Progress: $LOG_FILE"
}

status() {
  local pid
  if ! pid="$(running_pid)"; then
    echo "Stopped"
    return 3
  fi
  if healthy; then
    echo "Running (pid $pid), healthy at $HEALTH_URL"
    return 0
  fi
  echo "Running (pid $pid) but not answering at $HEALTH_URL" >&2
  return 1
}

ensure() {
  if running_pid >/dev/null; then
    # A busy moment can delay one check; restart only after 30s of silence.
    for _ in 1 2 3; do
      healthy && return 0
      sleep 10
    done
    echo "$(stamp) ensure: not answering at $HEALTH_URL for 30s, restarting" >>"$OUT_FILE"
    stop >>"$OUT_FILE" 2>&1
  else
    echo "$(stamp) ensure: not running, starting" >>"$OUT_FILE"
  fi
  start >>"$OUT_FILE" 2>&1
}

# One command at a time: cron's ensure must not race a manual start or stop.
mkdir -p "$(dirname "$PID_FILE")"
exec 9>"$(dirname "$PID_FILE")/frontend.lock"
if [[ "${1:-}" != "status" ]] && ! flock -w 120 9; then
  echo "Another frontend.sh command is still running" >&2
  exit 1
fi

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop && start ;;
  reload) reload ;;
  status) status ;;
  ensure) ensure ;;
  *)
    echo "Usage: $0 start|stop|restart|reload|status|ensure" >&2
    exit 2
    ;;
esac
