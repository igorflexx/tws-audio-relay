#!/usr/bin/env bash

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$PROJECT_DIR/.tws-audio-relay.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "TWS Audio Relay is not running."
  exit 0
fi

PID="$(cat "$PID_FILE")"

if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "Stopped TWS Audio Relay."
else
  echo "TWS Audio Relay was not running."
fi

rm -f "$PID_FILE"
