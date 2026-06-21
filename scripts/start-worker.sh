#!/usr/bin/env bash
#
# Start the WorldSketch GPU worker: ComfyUI (127.0.0.1:8188) + the Go server (:8067).
# The server runs the whole pipeline per job (images -> depth -> fusion -> gsplat -> .splat).
#
#   bash scripts/start-worker.sh
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="${WORKSPACE:-$(cd "$REPO_DIR/.." && pwd)}"
COMFY_DIR="${COMFY_DIR:-$WORKSPACE/ComfyUI}"
PERSIST_DIR="${PERSIST_DIR:-$WORKSPACE/.worldsketch-cache}"

# Persist gsplat's compiled CUDA extension and pin the GPU arch, so it compiles
# ONCE (~10 min) and every later start reuses the cached build instead of recompiling.
export TORCH_EXTENSIONS_DIR="${TORCH_EXTENSIONS_DIR:-$PERSIST_DIR/torch_extensions}"
mkdir -p "$TORCH_EXTENSIONS_DIR"
if [[ -z "${TORCH_CUDA_ARCH_LIST:-}" ]] && command -v nvidia-smi >/dev/null 2>&1; then
	export TORCH_CUDA_ARCH_LIST="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1)"
fi
echo "TORCH_CUDA_ARCH_LIST=${TORCH_CUDA_ARCH_LIST:-unset}  TORCH_EXTENSIONS_DIR=$TORCH_EXTENSIONS_DIR"

PIDS=()
cleanup() { for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

echo "==> ComfyUI on 127.0.0.1:8188"
( cd "$COMFY_DIR" && exec ./.venv/bin/python -s main.py --port 8188 ) &
PIDS+=("$!")

echo "    waiting for ComfyUI..."
until curl -fsS http://127.0.0.1:8188/system_stats >/dev/null 2>&1; do
	kill -0 "${PIDS[0]}" 2>/dev/null || { echo "ComfyUI exited during startup"; exit 1; }
	sleep 1
done
echo "    ComfyUI up."

echo "==> WorldSketch server on :8067  (serves the editor + runs jobs)"
cd "$REPO_DIR/server"
exec ./worldsketch-server
