#!/usr/bin/env bash
set -euo pipefail

cd /Users/wqm/ComfyUI-Installs/ComfyUI

./ComfyUI/.venv/bin/python3 -s ComfyUI/main.py \
	--feature-flag show_signin_button=true \
	--enable-manager \
	--extra-model-paths-config "/Users/wqm/Library/Application Support/Comfy Desktop/shared_model_paths.yaml" \
	--input-directory /Users/wqm/ComfyUI-Shared/input \
	--output-directory /Users/wqm/ComfyUI-Shared/output \
	--force-fp32 \
	--fp32-vae \
	--cpu-vae \
	--force-upcast-attention
