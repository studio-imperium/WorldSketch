#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDS=()

cleanup() {
	for pid in "${PIDS[@]}"; do
		kill "$pid" 2>/dev/null || true
	done
}

running() {
	lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

trap cleanup EXIT INT TERM

if running 8188; then
	echo "ComfyUI already running on 8188"
else
	echo "Starting ComfyUI on 8188"
	"$ROOT/scripts/start-comfy-stable.sh" &
	PIDS+=("$!")
fi

if running 8067; then
	echo "WorldSketch already running on 8067"
else
	echo "Starting WorldSketch on 8067"
	(cd "$ROOT/server" && go run .) &
	PIDS+=("$!")
fi

echo
echo "WorldSketch: http://localhost:8067"
echo "ComfyUI:     http://127.0.0.1:8188"
echo
echo "Press Ctrl+C to stop processes started by this script."

wait
