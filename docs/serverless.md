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

## Coordinator (built)
The existing Go server, with generation delegated to RunPod when these env vars are set
(otherwise it runs the pipeline locally as before):

| Env | Purpose |
|---|---|
| `RUNPOD_ENDPOINT_ID` | your serverless endpoint id |
| `RUNPOD_API_KEY` | RunPod API key (read from env only — never committed) |
| `WORLDSKETCH_PUBLIC_URL` | externally reachable base URL the worker PUTs results to |

Flow ([runpod.go](../server/runpod.go), [jobs.go](../server/jobs.go)): `POST /api/generate` → base64 the
views → `POST .../run` with `{scene, views, resultUrl}` → poll `.../status` for failures →
the worker `PUT`s `world.splat` to `/api/jobs/<id>/result?token=…` → job marked done →
browser polls `/api/jobs/<id>` → `GET …/world.splat`. `collisions.json` is served from the
scene by the coordinator (no worker round-trip).

### Run it (dev, from your Mac)
The worker needs a public URL to PUT results back, so tunnel the coordinator with ngrok:
```bash
# terminal 1 — public tunnel to the coordinator's :8067
ngrok http 8067            # note the https URL

# terminal 2 — the coordinator
cd server
export RUNPOD_ENDPOINT_ID=<your endpoint id>
export RUNPOD_API_KEY=<your key>          # never commit this
export WORLDSKETCH_PUBLIC_URL=https://<subdomain>.ngrok.app
go run .
```
Open `http://localhost:8067`, build a scene, hit **Generate Splat**. The browser talks to
localhost; only the worker's result callback uses the ngrok URL. In prod, run the coordinator
on a cheap public CPU box and set `WORLDSKETCH_PUBLIC_URL` to its address (no tunnel needed).

## Notes / caveats
- **Untested live** — Go one-shot builds and the handler passes syntax; the Docker build, model-volume wiring, and a real RunPod run need your account to verify. Most likely fixups: exact base-image tag / wheel index, and the DreamShaper checkpoint source.
- **Cold start** ~30–90 s after idle (boot + model load); fine since gsplat training is minutes. Set min workers = 1 only if you want zero cold start.
- **Payload size** — 9 views base64'd is ~5–8 MB into `/run`; fine for async. Artifacts go back via `resultUrl` (not the job result, which is size-capped).
```
