#!/usr/bin/env bash
#
# Build + push the WorldSketch RunPod GPU worker image (the one that runs ComfyUI/syncmvd
# + gsplat + the Go one-shot pipeline). Run this whenever the worker-side code changes
# (services/runpod/handler.py, server/*.go) — e.g. after the world-expansion wiring, which
# needs a fresh image before "+ Add plot" generations work.
#
# Usage:
#   docker login                                   # one-time, to your registry
#   IMAGE=<registry>/worldsketch-worker:latest ./scripts/build-worker.sh
#   # or: ./scripts/build-worker.sh <registry>/worldsketch-worker:latest
#
# Then point RunPod endpoint 8908ibcqxgjs0p at $IMAGE (RunPod dashboard → endpoint →
# edit → container image), or via the rp/runpodctl CLI.
#
# The worker runs on amd64 NVIDIA hosts, so we build for linux/amd64 explicitly (works
# from an arm64 Mac via buildx emulation, just slower). buildx builds AND pushes in one
# step so a half-built local image is never left lying around.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${1:-${IMAGE:-}}"

if [[ -z "$IMAGE" ]]; then
	echo "Set the target image, e.g.:" >&2
	echo "  IMAGE=docker.io/youruser/worldsketch-worker:latest $0" >&2
	exit 1
fi

command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }
docker buildx version >/dev/null 2>&1 || { echo "docker buildx required (Docker Desktop ships it)" >&2; exit 1; }

echo "Building $IMAGE for linux/amd64 (context: $ROOT) and pushing..."
docker buildx build \
	--platform linux/amd64 \
	-f "$ROOT/services/runpod/Dockerfile" \
	-t "$IMAGE" \
	--push \
	"$ROOT"

cat <<EOF

────────────────────────────────────────────────────────
Pushed: $IMAGE

Next: point the RunPod serverless endpoint at it, then a new "+ Add plot" → Generate
runs the expansion (parent cloud pulled via the tunnel, new tile fused on).

  RunPod dashboard → Serverless → endpoint 8908ibcqxgjs0p → Edit → Container Image
  (or: runpodctl update endpoint ... --imageName "$IMAGE")
────────────────────────────────────────────────────────
EOF
