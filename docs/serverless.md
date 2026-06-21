# Serverless generation (RunPod) — ephemeral, pay-per-job

For "a few generations/day," run the GPU pipeline on **RunPod Serverless** instead of a
24/7 box: scale 0→1 per job, pay only for the seconds it runs (~$10–15/mo vs ~$290/mo).
**No long-term storage** — the worker ships the artifact straight back to the coordinator,
which streams it to the player and discards it.

## Flow
```
Browser editor ── scene + 9 captured views ──▶ Coordinator (always-on CPU)
                                                  │  POST /run {scene, views, resultUrl}
                                                  ▼
                                          RunPod Serverless worker (per job, 0→1)
                                          ComfyUI → depth → fusion → gsplat → world.splat
                                                  │  PUT world.splat ──▶ resultUrl
                                                  ▼
Coordinator holds it transiently ── streams to player ── deletes (no storage)
(collisions.json the coordinator serves itself from the scene — no worker needed)
```

## What's built (worker side)
- **Go one-shot mode** — `worldsketch-server -job <dir>` runs the whole pipeline once and exits ([pipeline.go](../server/pipeline.go), [main.go](../server/main.go)). Reuses all existing pipeline code.
- **RunPod handler** — [services/runpod/handler.py](../services/runpod/handler.py): stages inputs, keeps ComfyUI warm across jobs, runs the one-shot binary, PUTs `world.splat` to the coordinator's `resultUrl` (or returns inline base64).
- **Worker image** — [services/runpod/Dockerfile](../services/runpod/Dockerfile): CUDA base + Go + ComfyUI + **prebuilt gsplat wheel** (no 10-min cold-start compile). Models come from a network volume, not baked in.

## RunPod setup (you do this once)
1. **Build & push the image** (context = repo root):
   ```bash
   docker build -f services/runpod/Dockerfile -t <user>/worldsketch-worker:latest .
   docker push <user>/worldsketch-worker:latest
   ```
   Match `BASE` + `GSPLAT_WHEEL_INDEX` to a current RunPod PyTorch image (torch+cuda must agree).
2. **Network volume** — create one, upload models to `models/checkpoints/DreamShaper_8_pruned.safetensors` and `models/controlnet/control_v11p_sd15_canny.pth` + `control_v11f1p_sd15_depth.pth`. The handler points ComfyUI at `/runpod-volume/models`.
3. **Serverless endpoint** — from the image, attach the volume, **min workers = 0** (pure pay-per-use), max 1–2. Note the **endpoint ID** + your **API key**.

## What's next (coordinator — not built yet)
The always-on CPU side. It's the existing Go server with the GPU work swapped for RunPod calls:
- `POST /api/generate` → mint a job id + one-time `resultUrl`, base64 the views, `POST` to `https://api.runpod.ai/v2/<endpoint>/run` with `{input:{scene,views,resultUrl}}`.
- `PUT /api/jobs/<id>/result` (the `resultUrl`) → receive `world.splat`, mark done.
- `GET /api/jobs/<id>` poll, `GET /api/jobs/<id>/world.splat` → stream + delete (TTL).
- `collisions.json` served from the scene as today.

Needs your **endpoint ID + API key** (env) and a **public URL** the worker can PUT back to (a cheap public CPU box; or ngrok if the coordinator runs on your Mac during dev).

## Notes / caveats
- **Untested live** — Go one-shot builds and the handler passes syntax; the Docker build, model-volume wiring, and a real RunPod run need your account to verify. Most likely fixups: exact base-image tag / wheel index, and the DreamShaper checkpoint source.
- **Cold start** ~30–90 s after idle (boot + model load); fine since gsplat training is minutes. Set min workers = 1 only if you want zero cold start.
- **Payload size** — 9 views base64'd is ~5–8 MB into `/run`; fine for async. Artifacts go back via `resultUrl` (not the job result, which is size-capped).
```
