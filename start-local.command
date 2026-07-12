#!/bin/zsh

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="/Users/a1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
PNPM_BIN="/Users/a1/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pnpm"
PID_FILE="$PROJECT_DIR/.tws-audio-relay.pid"
LOG_FILE="$PROJECT_DIR/.tws-audio-relay.log"
PORT=4312

if [ ! -x "$NODE_BIN" ]; then
  echo "Bundled Node.js was not found."
  exit 1
fi

if [ ! -x "$PNPM_BIN" ]; then
  echo "Bundled pnpm was not found."
  exit 1
fi

if [ ! -d "$PROJECT_DIR/node_modules/qrcode" ]; then
  echo "Installing dependencies..."
  "$PNPM_BIN" install --dir "$PROJECT_DIR"
fi

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

if is_running; then
  echo "TWS Audio Relay is already running."
else
  echo "Starting TWS Audio Relay..."
  cd "$PROJECT_DIR"
  nohup "$NODE_BIN" "$PROJECT_DIR/server.mjs" >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
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

echo "Opening TWS Audio Relay..."
open "http://localhost:$PORT" >/dev/null 2>&1 || true

echo ""
echo "Server is ready."
echo "Computer: http://localhost:$PORT"
echo "iPhone:   open the QR code from the page or the local Wi-Fi address shown there"
echo "Log:      $LOG_FILE"
echo ""
