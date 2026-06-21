#!/usr/bin/env bash
set -euo pipefail

mkdir -p /Users/wqm/ComfyUI-Shared/models/checkpoints

curl -L --fail --retry 3 \
	-o /Users/wqm/ComfyUI-Shared/models/checkpoints/stable_zero123_c.ckpt \
	https://huggingface.co/stabilityai/stable-zero123/resolve/main/stable_zero123_c.ckpt

echo "Downloaded stable_zero123_c.ckpt. Restart ComfyUI so it appears in CheckpointLoaderSimple."
