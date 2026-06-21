#!/usr/bin/env bash
#
# One command to run the coordinator in serverless mode:
#   - loads .env (RUNPOD_ENDPOINT_ID, RUNPOD_API_KEY)
#   - launches a cloudflare tunnel and auto-captures its public URL
#   - starts the Go coordinator with WORLDSKETCH_PUBLIC_URL set to that URL
#   - kills the tunnel when you Ctrl+C
#
#   ./scripts/dev-serverless.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- load .env (KEY=value lines) ---
if [[ -f "$ROOT/.env" ]]; then
	set -a
	# shellcheck disable=SC1091
	source "$ROOT/.env"
	set +a
else
	echo "No .env found. Copy .env.example to .env and fill in your RunPod creds."
	exit 1
fi

if [[ -z "${RUNPOD_ENDPOINT_ID:-}" || -z "${RUNPOD_API_KEY:-}" ]]; then
	echo "RUNPOD_ENDPOINT_ID / RUNPOD_API_KEY missing in .env"
	exit 1
fi

command -v cloudflared >/dev/null || { echo "Install cloudflared: brew install cloudflared"; exit 1; }

# --- launch the tunnel and capture its public URL ---
CF_LOG="$(mktemp)"
cloudflared tunnel --url http://localhost:8067 >"$CF_LOG" 2>&1 &
CF_PID=$!
cleanup() { kill "$CF_PID" 2>/dev/null || true; rm -f "$CF_LOG"; }
trap cleanup EXIT INT TERM

echo "Starting cloudflare tunnel..."
URL=""
for _ in $(seq 1 30); do
	URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" | head -1 || true)"
	[[ -n "$URL" ]] && break
	kill -0 "$CF_PID" 2>/dev/null || { echo "cloudflared exited:"; cat "$CF_LOG"; exit 1; }
	sleep 1
done
if [[ -z "$URL" ]]; then
	echo "Could not find tunnel URL in cloudflared output:"
	cat "$CF_LOG"
	exit 1
fi
export WORLDSKETCH_PUBLIC_URL="$URL"
echo "Tunnel up: $URL"

# --- run the coordinator (foreground; tunnel dies with it via the trap) ---
cd "$ROOT/server"
exec go run .
