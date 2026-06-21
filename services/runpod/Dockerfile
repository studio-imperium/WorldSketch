# WorldSketch serverless GPU worker (RunPod). Build with context = repo root:
#   docker build -f services/runpod/Dockerfile -t <user>/worldsketch-worker:latest .
#
# Pick a BASE that matches GSPLAT_WHEEL_INDEX (torch + cuda must line up), e.g.
# torch 2.4 + cuda 12.4  ->  .../whl/pt24cu124
ARG BASE=runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04
FROM ${BASE}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates build-essential unzip \
    && rm -rf /var/lib/apt/lists/*

# Go toolchain (builds the one-shot pipeline binary)
ARG GO_VERSION=1.22.12
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -C /usr/local -xz
ENV PATH=/usr/local/go/bin:$PATH

# Python deps. The PREBUILT gsplat wheel is the key bit: it ships compiled CUDA
# kernels so there's NO ~10-minute JIT compile on cold start. Falls back to source.
ARG GSPLAT_WHEEL_INDEX=https://docs.gsplat.studio/whl/pt24cu124
# Use the diffusers that matches the base image's (modern) transformers — pinning
# diffusers old made it incompatible with transformers 5.x. flash-attn is removed below.
RUN pip install --no-cache-dir pillow numpy diffusers accelerate runpod
RUN pip install --no-cache-dir gsplat==1.5.3 --index-url "${GSPLAT_WHEEL_INDEX}" \
    || pip install --no-cache-dir gsplat==1.5.3

# ComfyUI (models are mounted from a RunPod network volume at runtime, not baked)
RUN git clone --depth 1 https://github.com/comfyanonymous/ComfyUI /workspace/ComfyUI \
    && pip install --no-cache-dir -r /workspace/ComfyUI/requirements.txt
ENV COMFY_DIR=/workspace/ComfyUI

# Purge flash-attn LAST — after every pip install, so nothing (ComfyUI's reqs, etc.)
# can pull it back. Its FA3 kernels declare string type-annotations ('float | None')
# that torch 2.4's torch.library.infer_schema can't parse, which crashes
# `import diffusers...controlnet`. SD1.5 uses sdpa attention and doesn't need it.
RUN pip uninstall -y flash-attn flash_attn flash-attn-3 flash_attn_3 flash-attn-interface 2>/dev/null || true
RUN python3 - <<'PY'
import pathlib
import site
import sysconfig

roots = set(site.getsitepackages())
purelib = sysconfig.get_paths().get("purelib")
if purelib:
    roots.add(purelib)

names = (
    "flash_attn",
    "flash_attn_3",
    "flash_attn_interface.py",
    "flash_attn-",
    "flash_attn_",
    "flash-attn-",
)
for root in sorted(roots):
    path = pathlib.Path(root)
    if not path.exists():
        continue
    for child in path.iterdir():
        if any(child.name.startswith(name) for name in names):
            print(f"[build] removing {child}")
            if child.is_dir():
                import shutil
                shutil.rmtree(child)
            else:
                child.unlink()
PY
# Canary: fail the BUILD (visible in 20 min) rather than a run (visible in 40) if the
# diffusers controlnet import still can't load.
RUN python3 - <<'PY'
import importlib.util
for name in ("flash_attn", "flash_attn_3", "flash_attn_interface"):
    print(f"[build] {name} spec: {importlib.util.find_spec(name)}")
import diffusers.models.controlnets.controlnet
print("[build] diffusers controlnet import OK")
PY

# App: build the server, and point it at the system python (where torch+gsplat live)
COPY . /workspace/WorldSketch
RUN cd /workspace/WorldSketch/server && go build -o worldsketch-server .
ENV WORLDSKETCH_REPO=/workspace/WorldSketch
ENV WORLDSKETCH_PYTHON=python3

CMD ["python3", "/workspace/WorldSketch/services/runpod/handler.py"]
