#!/bin/zsh

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$PROJECT_DIR/.tws-audio-relay.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "TWS Audio Relay is not running."
  exit 0
fi

PID="$(cat "$PID_FILE")"

if [ -z "$PID" ]; then
  rm -f "$PID_FILE"
  echo "Removed empty PID file."
  exit 0
fi

if kill -0 "$PID" 2>/dev/null; then
  echo "Stopping TWS Audio Relay..."
  kill "$PID"

  for _ in {1..20}; do
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done

  if kill -0 "$PID" 2>/dev/null; then
    echo "Process did not stop gracefully. Sending SIGKILL..."
    kill -9 "$PID" 2>/dev/null || true
  fi
else
  echo "Stored process is not running anymore."
fi

rm -f "$PID_FILE"
echo "TWS Audio Relay stopped."
