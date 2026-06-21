# GPU worker setup (Phase A)

Runs the **whole pipeline on one CUDA box** — images → depth → fusion → gsplat → `.splat` — using the current ComfyUI stack (no SyncMVD yet). The browser still captures the views and uploads them; everything after that happens on the worker.

## One-time provisioning (on a persistent volume)
On a RunPod pod (PyTorch/CUDA base image) with a **persistent volume** mounted at `/workspace`:

```bash
cd /workspace
git clone <your-repo> WorldSketch        # or pull latest
cd WorldSketch
bash scripts/setup-worker.sh
```

This installs Go, the ML venv (gsplat + deps, torch inherited from the base image), ComfyUI + models, and builds the server. It's **idempotent** — re-run anytime. Because it lives on the persistent volume, a fresh pod that mounts the volume is ready without re-running it.

**Verify the checkpoint URL.** The ControlNets pull from stable Hugging Face URLs, but DreamShaper is usually distributed via Civitai — if its download fails, the script tells you, and you drop `DreamShaper_8_pruned.safetensors` into `ComfyUI/models/checkpoints/` manually (or pass `CKPT_URL=...`).

## Running it
```bash
bash scripts/start-worker.sh
```
Starts ComfyUI (127.0.0.1:8188) then the server (`:8067`). Open `http://<pod-host>:8067` — that serves the editor *and* runs jobs, so the browser's relative `/api/generate` calls hit the worker. Expose port 8067 on the pod.

The first generation pays gsplat's **~10-min CUDA compile once**; after that `TORCH_EXTENSIONS_DIR` (on the persistent volume) caches it, and `TORCH_CUDA_ARCH_LIST` is auto-pinned to the pod's GPU. Later starts skip the recompile.

## What changed in code
- `COMFY_WORKFLOW_DIR` env (optional) replaces the hardcoded Mac path for the editable UI workflow — unset on the worker, it's skipped.
- `WORLDSKETCH_PYTHON` env can override the ML venv python.
- Nothing in the pipeline logic changed: `Store.Run` already does comfy → depth → fusion → gsplat → `.splat` end-to-end; it just needs CUDA, which the worker has.

## Env knobs
| Var | Default | Purpose |
|---|---|---|
| `WORKSPACE` | parent of repo | base dir (RunPod: `/workspace`) |
| `COMFY_DIR` | `$WORKSPACE/ComfyUI` | ComfyUI install |
| `PERSIST_DIR` | `$WORKSPACE/.worldsketch-cache` | gsplat build cache (persistent) |
| `TORCH_CUDA_ARCH_LIST` | auto (nvidia-smi) | pin GPU arch so the build cache is stable |
| `CKPT_URL` / `CANNY_URL` / `DEPTH_URL` | see script | model download sources |

## Not yet (later phases)
- `.spz` output (Phase B), headless view rendering to drop browser capture (Phase C), first-person player (Phase D), SyncMVD image-gen (Phase E). See [generation-pipeline-plan.md](generation-pipeline-plan.md).

## Faster cold start (optional)
gsplat JIT-compiles on first use. To skip even the one-time compile, install a **prebuilt gsplat wheel** matching the base image's torch+CUDA (`pip install gsplat==1.5.3 --index-url https://docs.gsplat.studio/whl/pt<torch>cu<cuda>`) instead of the source build in `requirements.txt`.
