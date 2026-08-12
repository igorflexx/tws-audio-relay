#!/usr/bin/env bash

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}"
BUNDLED_NODE_BIN="$CACHE_ROOT/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
BUNDLED_PNPM_BIN="$CACHE_ROOT/codex-runtimes/codex-primary-runtime/dependencies/bin/pnpm"
PID_FILE="$PROJECT_DIR/.tws-audio-relay.pid"
LOG_FILE="$PROJECT_DIR/.tws-audio-relay.log"
PORT=4312

if [ -x "$BUNDLED_NODE_BIN" ]; then
  NODE_BIN="$BUNDLED_NODE_BIN"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  echo "Node.js was not found. Install Node.js 18+ or make 'node' available in PATH."
  exit 1
fi

INSTALLER_KIND=""
PNPM_BIN=""
NPM_BIN=""

if [ -x "$BUNDLED_PNPM_BIN" ]; then
  PNPM_BIN="$BUNDLED_PNPM_BIN"
  INSTALLER_KIND="pnpm"
elif command -v pnpm >/dev/null 2>&1; then
  PNPM_BIN="$(command -v pnpm)"
  INSTALLER_KIND="pnpm"
elif command -v corepack >/dev/null 2>&1; then
  PNPM_BIN="$(command -v corepack)"
  INSTALLER_KIND="corepack-pnpm"
elif command -v npm >/dev/null 2>&1; then
  NPM_BIN="$(command -v npm)"
  INSTALLER_KIND="npm"
fi

if [ ! -d "$PROJECT_DIR/node_modules/qrcode" ]; then
  echo "Installing dependencies..."
  case "$INSTALLER_KIND" in
    pnpm)
      "$PNPM_BIN" install --dir "$PROJECT_DIR"
      ;;
    corepack-pnpm)
      "$PNPM_BIN" pnpm install --dir "$PROJECT_DIR"
      ;;
    npm)
      cd "$PROJECT_DIR"
      "$NPM_BIN" install
      ;;
    *)
      echo "No package manager was found. Install pnpm or npm, or enable corepack."
      exit 1
      ;;
  esac
fi

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

if is_running; then
  echo "TWS Audio Relay is already running."
else
  rm -f "$PID_FILE"
  echo "Starting TWS Audio Relay..."
  SERVER_PID="$(
    /usr/bin/python3 - "$NODE_BIN" "$PROJECT_DIR" "$LOG_FILE" <<'PY'
import os
import subprocess
import sys

node_bin, project_dir, log_file = sys.argv[1:4]

with open(log_file, "ab", buffering=0) as logfile, open(os.devnull, "rb") as devnull:
    proc = subprocess.Popen(
        [node_bin, "server.mjs"],
        cwd=project_dir,
        stdin=devnull,
        stdout=logfile,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        close_fds=True,
    )

print(proc.pid)
PY
  )"
  echo "$SERVER_PID" >"$PID_FILE"
fi

for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "Server did not become ready. Check $LOG_FILE"
  exit 1
fi

open_url() {
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1 &
    return 0
  fi

  if command -v open >/dev/null 2>&1; then
    open "$1" >/dev/null 2>&1
    return 0
  fi

  return 1
}

echo "Opening TWS Audio Relay..."
open_url "http://localhost:$PORT" || true

echo ""
echo "Server is ready."
echo "Computer: http://localhost:$PORT"
echo "iPhone:   open the QR code from the page or the local Wi-Fi address shown there"
echo "Log:      $LOG_FILE"
echo ""
