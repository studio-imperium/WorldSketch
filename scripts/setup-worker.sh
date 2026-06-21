#!/usr/bin/env bash
#
# Reproducible provisioning for a WorldSketch GPU worker (Ubuntu + NVIDIA, e.g. RunPod).
# Installs Go, the ML venv (gsplat + deps), ComfyUI + models, and builds the server.
#
# Idempotent: safe to re-run. Run it once on a PERSISTENT volume (RunPod /workspace)
# so the cost is paid a single time — fresh pods that mount the volume are ready instantly.
#
#   bash scripts/setup-worker.sh
#
# Override any of these via env, e.g.  CKPT_URL=... bash scripts/setup-worker.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="${WORKSPACE:-$(cd "$REPO_DIR/.." && pwd)}"
COMFY_DIR="${COMFY_DIR:-$WORKSPACE/ComfyUI}"
PERSIST_DIR="${PERSIST_DIR:-$WORKSPACE/.worldsketch-cache}"
GO_VERSION="${GO_VERSION:-1.22.12}"

# --- Model sources. The ControlNets are stable HF URLs; VERIFY the checkpoint URL
#     (DreamShaper is usually distributed via Civitai). If the checkpoint download
#     fails the script continues — just drop the .safetensors in models/checkpoints. ---
CKPT_URL="${CKPT_URL:-https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_pruned.safetensors}"
CANNY_URL="${CANNY_URL:-https://huggingface.co/lllyasviel/ControlNet-v1-1/resolve/main/control_v11p_sd15_canny.pth}"
DEPTH_URL="${DEPTH_URL:-https://huggingface.co/lllyasviel/ControlNet-v1-1/resolve/main/control_v11f1p_sd15_depth.pth}"

log() { printf '\n==> %s\n' "$*"; }

log "apt dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends git curl unzip ca-certificates build-essential python3-venv

log "Go ${GO_VERSION}"
if ! command -v go >/dev/null 2>&1 || ! go version 2>/dev/null | grep -q "go${GO_VERSION}"; then
	curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tgz
	rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz
fi
export PATH="/usr/local/go/bin:$PATH"

log "ML venv (torch inherited from the base image via --system-site-packages)"
python3 -m venv "$REPO_DIR/services/ml/.venv" --system-site-packages
"$REPO_DIR/services/ml/.venv/bin/pip" install --upgrade pip
"$REPO_DIR/services/ml/.venv/bin/pip" install -r "$REPO_DIR/services/ml/requirements.txt"

log "ComfyUI at ${COMFY_DIR}"
if [[ ! -d "$COMFY_DIR/.git" ]]; then
	git clone --depth 1 https://github.com/comfyanonymous/ComfyUI "$COMFY_DIR"
fi
python3 -m venv "$COMFY_DIR/.venv" --system-site-packages
"$COMFY_DIR/.venv/bin/pip" install --upgrade pip
"$COMFY_DIR/.venv/bin/pip" install -r "$COMFY_DIR/requirements.txt"

log "models"
mkdir -p "$COMFY_DIR/models/checkpoints" "$COMFY_DIR/models/controlnet"
MISSING=()
fetch() { # url dest required|optional
	if [[ -s "$2" ]]; then echo "have $(basename "$2")"; return 0; fi
	echo "fetch $(basename "$2")"
	if ! curl -fL --retry 3 "$1" -o "$2"; then
		rm -f "$2"
		echo "  !! could not download $(basename "$2") from $1"
		if [[ "$3" == "required" ]]; then MISSING+=("$(basename "$2")"); fi
	fi
	return 0
}
fetch "$CANNY_URL" "$COMFY_DIR/models/controlnet/control_v11p_sd15_canny.pth"    required
fetch "$DEPTH_URL" "$COMFY_DIR/models/controlnet/control_v11f1p_sd15_depth.pth"  optional
fetch "$CKPT_URL"  "$COMFY_DIR/models/checkpoints/DreamShaper_8_pruned.safetensors" required

log "build server"
( cd "$REPO_DIR/server" && go build -o worldsketch-server . )

mkdir -p "$PERSIST_DIR/torch_extensions"

ARCH="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 || true)"
cat <<EOF

────────────────────────────────────────────────────────
Setup complete.

  Start the worker:   bash $REPO_DIR/scripts/start-worker.sh
  Server:             http://<this-host>:8067
  GPU compute cap:    ${ARCH:-unknown (run: nvidia-smi --query-gpu=compute_cap --format=csv,noheader)}

Persistent gsplat build cache:  $PERSIST_DIR/torch_extensions
EOF
if (( ${#MISSING[@]} )); then
	echo
	echo "  WARNING: missing required model(s): ${MISSING[*]}"
	echo "  Drop them into $COMFY_DIR/models/{checkpoints,controlnet} before running."
fi
echo "────────────────────────────────────────────────────────"
