#!/usr/bin/env bash
# Dev process manager for the Learning Digest service layer + web library.
#
# Usage:
#   scripts/dev.sh start    start api / worker / web (skips ports already in use)
#   scripts/dev.sh stop     stop the processes this script started
#   scripts/dev.sh status   show what is running on which port
#   scripts/dev.sh logs     tail the three service logs
#   scripts/dev.sh restart  stop + start
#
# Overrides: API_PORT (default 8787), WEB_PORT (default 8080),
# LD_WORKER_TOKEN (default dev-worker-token, set on BOTH api and worker),
# LD_WORKER_PROVIDER (stub | qwen | local), plus any LD_* env you export
# is passed through to the child processes. The chosen ports are
# remembered in $LD_DEV_RUN_DIR/ports.env so stop/status match start.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${LD_DEV_RUN_DIR:-/tmp/learning-digest-dev}"
LOG_DIR="$RUN_DIR/logs"
API_PORT="${API_PORT:-8787}"
WEB_PORT="${WEB_PORT:-8080}"
WORKER_TOKEN="${LD_WORKER_TOKEN:-dev-worker-token}"
mkdir -p "$LOG_DIR"

remember_ports() {
  printf 'API_PORT=%s\nWEB_PORT=%s\n' "$API_PORT" "$WEB_PORT" > "$RUN_DIR/ports.env"
}

resolved_ports() {
  if [ -f "$RUN_DIR/ports.env" ]; then
    # shellcheck disable=SC1091
    . "$RUN_DIR/ports.env"
  fi
}

port_busy() { lsof -ti ":$1" >/dev/null 2>&1; }

pid_alive() {
  local file="$1"
  [ -f "$file" ] || return 1
  local pid stat
  pid="$(cat "$file" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  # A zombie (defunct) passes kill -0 but is dead for our purposes.
  stat="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ')"
  [ -n "$stat" ] && [ "${stat:0:1}" != "Z" ]
}

wait_for_port() { # port: wait up to ~4s for a listener (api/web health)
  local port="$1" i
  for i in 1 2 3 4 5 6 7 8; do
    port_busy "$port" && return 0
    sleep 0.5
  done
  return 1
}

start_one() { # name, pidfile, logfile, cwd, listen_port("" for none), url, command...
  local name="$1" pidfile="$2" logfile="$3" cwd="$4" port="$5" url="$6"
  shift 6
  if pid_alive "$pidfile" && { [ -z "$port" ] || port_busy "$port"; }; then
    echo "[$name] already running (pid $(cat "$pidfile"))"
    echo "[$name] $url"
    return 0
  fi
  rm -f "$pidfile"
  ( cd "$cwd" && "$@" > "$logfile" 2>&1 & echo $! > "$pidfile" )
  if [ -n "$port" ]; then
    if wait_for_port "$port" && pid_alive "$pidfile"; then
      echo "[$name] started (pid $(cat "$pidfile"))"
      echo "[$name] $url"
      return 0
    fi
    echo "[$name] FAILED to listen on :$port within 4s, see $logfile"
    stop_one "$pidfile"
    rm -f "$pidfile"
    return 1
  fi
  # No listening port to probe (worker): a live, non-zombie pid is success.
  sleep 0.5
  if pid_alive "$pidfile"; then
    echo "[$name] started (pid $(cat "$pidfile"))"
    echo "[$name] $url"
  else
    echo "[$name] FAILED to start, see $logfile"
    rm -f "$pidfile"
  fi
}

start() {
  remember_ports
  if port_busy "$API_PORT"; then
    echo "[api] port $API_PORT already in use, assume it is the API: http://127.0.0.1:$API_PORT"
  else
    start_one api "$RUN_DIR/api.pid" "$LOG_DIR/api.log" "$ROOT/apps/api" "$API_PORT" \
      "http://127.0.0.1:$API_PORT (GET /v1/me 返回 401 = 正常)" \
      env PORT="$API_PORT" LD_API_WORKER_TOKEN="$WORKER_TOKEN" \
      uv run python -m app.main
  fi
  if ! port_busy "$API_PORT"; then
    echo "[worker] api port $API_PORT is free, skip starting worker (start api first)"
  else
    start_one worker "$RUN_DIR/worker.pid" "$LOG_DIR/worker.log" "$ROOT/apps/worker" "" \
      "pull 模式,无监听端口: 从 http://127.0.0.1:$API_PORT 领任务(provider: ${LD_WORKER_PROVIDER:-stub})" \
      env LD_WORKER_API_BASE="http://127.0.0.1:$API_PORT" \
      LD_WORKER_TOKEN="$WORKER_TOKEN" \
      uv run python -m worker.main
  fi
  if port_busy "$WEB_PORT"; then
    echo "[web] port $WEB_PORT already in use, assume it is the Web 学习库: http://127.0.0.1:$WEB_PORT"
  else
    start_one web "$RUN_DIR/web.pid" "$LOG_DIR/web.log" "$ROOT/apps/web" "$WEB_PORT" \
      "http://127.0.0.1:$WEB_PORT (登录/学习库入口)" \
      env PORT="$WEB_PORT" LD_API_UPSTREAM="http://127.0.0.1:$API_PORT" \
      npm start
  fi
}

stop_one() { # pidfile: kill the tracked pid AND two levels of children
              # (uv -> python, npm -> sh -> node survive a plain parent kill)
  local pidfile="$1"
  local pid
  pid="$(cat "$pidfile" 2>/dev/null)"
  [ -n "$pid" ] || return 0
  local child grandchild
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    for grandchild in $(pgrep -P "$child" 2>/dev/null); do
      kill "$grandchild" 2>/dev/null || true
    done
    kill "$child" 2>/dev/null || true
  done
  kill "$pid" 2>/dev/null || true
  sleep 0.4
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    for grandchild in $(pgrep -P "$child" 2>/dev/null); do
      kill -9 "$grandchild" 2>/dev/null || true
    done
    kill -9 "$child" 2>/dev/null || true
  done
  kill -9 "$pid" 2>/dev/null || true
}

stop() {
  resolved_ports
  for name in web worker api; do
    local pidfile="$RUN_DIR/$name.pid"
    if [ -f "$pidfile" ]; then
      echo "[$name] stopping (pid $(cat "$pidfile"))"
      stop_one "$pidfile"
    fi
    rm -f "$pidfile"
  done
  for port in "$WEB_PORT" "$API_PORT"; do
    if port_busy "$port"; then
      echo "[warn] port $port still in use by a process this script did not start"
      echo "       stop it with:  lsof -ti :$port | xargs kill"
    fi
  done
}

status() {
  resolved_ports
  echo "api    :$API_PORT  $(port_busy "$API_PORT" && echo "RUNNING(运行中) http://127.0.0.1:$API_PORT" || echo "DOWN(未运行)")"
  echo "web    :$WEB_PORT  $(port_busy "$WEB_PORT" && echo "RUNNING(运行中) http://127.0.0.1:$WEB_PORT (学习库入口)" || echo "DOWN(未运行)")"
  echo "worker : $(pid_alive "$RUN_DIR/worker.pid" && echo "RUNNING(运行中) pulls from http://127.0.0.1:$API_PORT" || echo "DOWN(未运行)")"
  echo "logs   : $LOG_DIR/"
  echo "outbox : $ROOT/apps/api/data/outbox.jsonl (验证码,取最后一行)"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  logs) resolved_ports; tail -n 20 -f "$LOG_DIR/api.log" "$LOG_DIR/worker.log" "$LOG_DIR/web.log" ;;
  restart) stop; start ;;
  *) sed -n '2,16p' "${BASH_SOURCE[0]}" ;;
esac
