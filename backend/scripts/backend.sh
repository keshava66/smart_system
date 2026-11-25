#!/usr/bin/env bash
# Start, stop and watch the SmartHub backend (uvicorn under scripts/supervise.py).
#
#   scripts/backend.sh start | stop | restart | status | ensure
#
# Settings are read from backend/.env.server when it exists, one per line:
#   PORT=8000  HOST=0.0.0.0  PYTHON_BIN=/full/path/venv/bin/python
#   TLS_CERT=/path/cert.pem  TLS_KEY=/path/key.pem
# Logs go to backend/logs/backend.log, rotated at 50 MB, 5 files kept.
#
# ensure  starts the backend if it is down, or restarts it if it has stopped
#         answering for 30 seconds; meant for cron:
#   @reboot     /full/path/backend/scripts/backend.sh start
#   */5 * * * * /full/path/backend/scripts/backend.sh ensure
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BACKEND_DIR"

if [[ -f .env.server ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.server
  set +a
fi

export PYTHON_BIN="${PYTHON_BIN:-$BACKEND_DIR/venv/bin/python}"
export PORT="${PORT:-8000}"
export LOG_FILE="${LOG_FILE:-$BACKEND_DIR/logs/backend.log}"
export PID_FILE="${PID_FILE:-$BACKEND_DIR/run/backend.pid}"
CHILD_PID_FILE="${PID_FILE%.pid}.child.pid"
OUT_FILE="$(dirname "$LOG_FILE")/backend.out"

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
START_TIMEOUT="${START_TIMEOUT:-180}"

scheme=http
[[ -n "${TLS_CERT:-}" ]] && scheme=https
health_host="${HOST:-127.0.0.1}"
[[ "$health_host" == "0.0.0.0" || "$health_host" == "::" ]] && health_host=127.0.0.1
HEALTH_URL="$scheme://$health_host:$PORT/health"

stamp() { date '+%Y-%m-%dT%H:%M:%S%z'; }

pid_matching() {
  local file=$1 pattern=$2 pid
  [[ -f "$file" ]] || return 1
  pid="$(<"$file")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q "$pattern" || return 1
  echo "$pid"
}

running_pid() { pid_matching "$PID_FILE" 'supervise\.py'; }

healthy() {
  # -k: the certificate is issued for the public host name, not 127.0.0.1.
  curl -fsk --max-time 10 -o /dev/null "$HEALTH_URL"
}

start() {
  local pid launched waited=0 orphan
  if pid="$(running_pid)"; then
    echo "Already running (pid $pid)"
    return 0
  fi
  if [[ ! -x "$PYTHON_BIN" ]]; then
    echo "Python not found at $PYTHON_BIN. Set PYTHON_BIN in $BACKEND_DIR/.env.server" >&2
    return 1
  fi
  if orphan="$(pid_matching "$CHILD_PID_FILE" 'uvicorn')"; then
    echo "Stopping leftover backend process $orphan" >&2
    kill -TERM "$orphan" 2>/dev/null || true
    sleep 5
    kill -KILL "$orphan" 2>/dev/null || true
  fi

  mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$PID_FILE")"
  rm -f "$PID_FILE" "$CHILD_PID_FILE"
  echo "$(stamp) starting" >>"$OUT_FILE"
  # 9>&-: the supervisor must not inherit the lock, or every later command waits on it.
  setsid "$PYTHON_BIN" scripts/supervise.py >>"$OUT_FILE" 2>&1 </dev/null 9>&- &
  launched=$!

  echo -n "Starting (the app can take a minute to load)"
  while (( waited < START_TIMEOUT )); do
    sleep 2
    waited=$((waited + 2))
    if healthy; then
      echo
      echo "Running (pid $launched) at $scheme://$(hostname -f 2>/dev/null || hostname):$PORT"
      return 0
    fi
    if ! kill -0 "$launched" 2>/dev/null; then
      break
    fi
    echo -n "."
  done
  echo

  if kill -0 "$launched" 2>/dev/null; then
    echo "Not answering at $HEALTH_URL after ${START_TIMEOUT}s. It is still starting or stuck; see $LOG_FILE" >&2
  else
    echo "Did not start. Recent output:" >&2
    tail -n 5 "$OUT_FILE" >&2 || true
    [[ -f "$LOG_FILE" ]] && tail -n 25 "$LOG_FILE" >&2
  fi
  return 1
}

stop() {
  local pid child
  if ! pid="$(running_pid)"; then
    echo "Not running"
    rm -f "$PID_FILE"
    return 0
  fi
  child="$(pid_matching "$CHILD_PID_FILE" 'uvicorn' || true)"
  kill -TERM "$pid"
  echo -n "Stopping (running jobs get up to 60s to finish)"
  for _ in $(seq 1 90); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo
      echo "Stopped"
      return 0
    fi
    echo -n "."
    sleep 1
  done
  echo
  echo "Still running after 90s, killing it" >&2
  kill -KILL "$pid" 2>/dev/null || true
  [[ -n "$child" ]] && kill -KILL "$child" 2>/dev/null
  rm -f "$PID_FILE" "$CHILD_PID_FILE"
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
  local pid age
  if pid="$(running_pid)"; then
    # Still inside its start-up window (for example right after a reboot): leave it.
    age="$(ps -o etimes= -p "$pid" | tr -d ' ')"
    if [[ -n "$age" ]] && (( age < START_TIMEOUT )); then
      return 0
    fi
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
exec 9>"$(dirname "$PID_FILE")/backend.lock"
if [[ "${1:-}" != "status" ]] && ! flock -w 300 9; then
  echo "Another backend.sh command is still running" >&2
  exit 1
fi

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop && start ;;
  status) status ;;
  ensure) ensure ;;
  *)
    echo "Usage: $0 start|stop|restart|status|ensure" >&2
    exit 2
    ;;
esac
