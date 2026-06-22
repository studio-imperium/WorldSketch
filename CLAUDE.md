# CLAUDE.md — WorldSketch

> Entry point for anyone (human or agent) working in this repo. Kept deliberately
> short. Deep detail lives in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the
> plan docs under [docs/](docs/). If something here is wrong, fix it in the same PR
> as the code change — treat this file like code.

## What WorldSketch is

A **block-out-to-world generator**. You build a rough scene in the browser out of
primitives (box / sphere / cylinder / cone), hit **Generate**, and a GPU pipeline
turns it into a **3D Gaussian splat world** (`world.splat`) plus **analytic
colliders** you can view/walk. The primitives are both the *art direction* (their
silhouettes + depth steer image generation) and the *physics* (each primitive is
exported verbatim as a collider).

The browser is **authoring + playback**. Everything from image generation to the
trained splat happens server-side on a CUDA box (or RunPod serverless).

## The pipeline (one sentence per stage)

```
scene.json + 9 captured views (RGB + depth + camera)
  → image generation   ComfyUI ControlNet img2img (canny+depth)  OR  SyncMVD
  → depth estimation   Depth-Anything-V2 per generated view
  → fusion             Go unprojects all views → colored point cloud (world.ply)
  → gsplat training    Python optimizes Gaussians → world.splat
  → colliders          scene primitives served verbatim as collisions.json
```

Stages and code owners: image-gen = `server/comfy.go` / `services/ml/syncmvd.py`;
depth = `services/ml/depth.py`; fusion = `server/fusion.go`; training =
`services/ml/train_splat.py`. The Go server orchestrates; Python does the GPU ML.

## Repo layout

| Path | What |
|---|---|
| `client/` | Three.js editor (`index.html`) + PLY viewer + splat viewer. No build step — static files served by the Go server. |
| `client/scripts/capture.js` | Renders the **13 views** the pipeline consumes. Camera math here MUST match `server/fusion.go`. |
| `server/` | Go coordinator + full pipeline (port **8067**). Serves the client, runs/queues jobs, serves artifacts. |
| `services/ml/` | Python GPU code: `train_splat.py` (gsplat), `depth.py`, `syncmvd.py`, `geometry.py` (projection math). |
| `services/runpod/` | Serverless worker: `handler.py` + `Dockerfile`. |
| `scripts/` | Dev + worker provisioning scripts. |
| `docs/` | Architecture + the SyncMVD / pipeline plans. |

## How to run it

There are three deployment shapes; pick by where the GPU is.

**A. Local dev with local ComfyUI** (Mac, ComfyUI on `:8188`):
```bash
./scripts/dev-legacy.sh        # starts ComfyUI (8188) + Go server (8067)
# open http://localhost:8067
```

**B. Serverless (RunPod) coordinator** — Go runs locally/cheap CPU, GPU work goes to RunPod:
```bash
cp .env.example .env           # fill RUNPOD_ENDPOINT_ID + RUNPOD_API_KEY
./scripts/dev.sh               # launches a cloudflare tunnel, sets WORLDSKETCH_PUBLIC_URL, runs Go
# open http://localhost:8067
```

**C. All-on-one GPU box** (worker runs the whole pipeline): see
[docs/worker-setup.md](docs/worker-setup.md) — `scripts/setup-worker.sh` then
`scripts/start-worker.sh`.

Run the Go server directly: `cd server && go run .` (port 8067). One-shot worker
mode: `worldsketch-server -job <dir>` runs the pipeline once on a staged dir and exits.

## Hard invariants (break these and the output silently degrades)

- **The 13 view names are a contract.** `front, back, left, right, top,
  corner_fl_high, corner_fr_high, corner_bl_high, corner_br_high,
  corner_fl_low, corner_fr_low, corner_bl_low, corner_br_low` — defined in `server/views.go` (`viewNames`),
  produced in `client/scripts/capture.js`, consumed in `fusion.go` and
  `geometry.py`. Change one, change all four.
- **Camera convention must match across capture / fusion / geometry.** Unprojection
  is `world = pos + fwd·depth + right·px + up·py` with `px,py` from `tan(fov·π/360)`
  and `aspect`. If headless rendering ever replaces browser capture, it must
  reproduce these poses exactly or fusion drifts. (`fusion.go pointsFromView`,
  `geometry.py unproject`.)
- **`gsplat==1.5.3` is pinned** and must match the Docker base image's torch+CUDA
  tuple (`services/ml/requirements.txt` ↔ `services/runpod/Dockerfile`
  `GSPLAT_WHEEL_INDEX`).
- **flash-attn must be purged** in the worker image — its kernels break
  `import diffusers` under torch 2.4. The Dockerfile removes it last + has a canary.

## Conventions & knobs

- **Tunable pipeline params** are env vars (`WS_STEPS`, `WS_CFG`, `WS_DENOISE`,
  `WS_DEDUPE`, `WS_SPARSE_*`, `WS_EXPAND_*`, …). Set them where the pipeline *runs*
  (RunPod env for serverless, `.env`/shell for local). No rebuild needed. See `.env.example`.
- **World expansion** (`server/expand.go` + `inpaint.go`): a scene with a `parent` job id
  grows that plot. In the editor, **+ Add plot** lays a new ground tile next to the current
  one; objects built there are the new (non-`existing`) delta, masked per-view (`new_mask`),
  inpainted to match the parent, and fused onto the parent `world.ply` (merged world; each
  plot is also its own job/splat). Fusion's keep-region is **scene-bounds-aware**
  (`sceneCullBounds`) so a tile offset from origin isn't culled — the client sends the union
  bounds of all tiles. Local-only for now; seam context is approximate (style continuity via
  shared seed/prompt/palette, not pixel-aligned). Design + research:
  [docs/world-expansion-plan.md](docs/world-expansion-plan.md).
- **Image-gen backend** is selected by `WS_IMAGEGEN` (`syncmvd` → diffusers path,
  else ComfyUI). See `server/syncmvd.go`.
- **Python interpreter**: `WORLDSKETCH_PYTHON`, else `services/ml/.venv`, else `python3`.
- **Secrets**: `RUNPOD_API_KEY` is read from env only — never commit it. `.env` is gitignored.
- **Generated output** (`server/output/`, build artifacts, venvs) is gitignored.

## Git / status

- Go module is `gausy` (legacy name), Go 1.22.12. Server binary: `worldsketch-server`.
- Default branch is `main`. Commit/push only when asked.

## Agent workflow (`.claude/`)

- **`/check`** — builds + vets + tests the Go server and runs the geometry math
  tests. Run it after changes to the pipeline.
- **Go files auto-format** on edit (`gofmt -w` via a PostToolUse hook) — don't
  hand-format Go.
- **Safe commands are pre-allowed** (`go build/test/vet`, `gofmt`, read-only `git`,
  the geometry test) so they don't prompt. See `.claude/settings.json`.
- New clone: `git config core.hooksPath scripts/hooks` to enable the pre-commit
  drift guard.

## Keeping this file fresh

This file + [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) are the durable docs. When
you change the pipeline, view contract, run scripts, or env knobs, **update them in
the same change**. A drift-guard hook may warn you at commit time (see
[docs/ARCHITECTURE.md#keeping-docs-fresh](docs/ARCHITECTURE.md#keeping-docs-fresh)).
