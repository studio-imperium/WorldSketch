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

Run the Go server directly: `cd server && go run .` (port 8067) — it **auto-loads `.env`**
from the repo root (RunPod creds + tunables; already-set shell env wins), so RunPod activates
without `dev.sh`. But the worker still needs a public callback URL: serverless builds fail
until `WORLDSKETCH_PUBLIC_URL` is set, which `dev.sh` does via a cloudflare tunnel (or set it
in `.env`). One-shot worker mode: `worldsketch-server -job <dir>` runs the pipeline once on a
staged dir and exits.

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
  grows that plot. In the editor, **+ Add plot** lays a new ground tile at the nearest free
  cell (it spirals outward so plots never overlap). Each plot is a movable unit: with the
  pointer tool, click its (unfrozen) ground tile to select it, then drag to translate the
  whole plot — tile + every object sharing its `plotId` — so you reposition it before
  generating (frozen/generated plots stay put). You can lay out several plots up front (Add
  plot no longer requires building the first), then **choose what to build**: the **Plots
  panel** (`renderPlotsPanel`, shown once there's >1 plot) — click a row to focus that plot,
  **check** several for **Build selected**, per-row **Build/Rebuild** builds just one, and
  **Build all** builds them one at a time; the main Generate button builds the active plot. A
  **Match** dropdown picks a reference plot — builds then copy that plot's vibe + parent onto
  the targets (e.g. match Plot 1), skipping the prompt. **Clear** (`clearWorld`) is a hard reset
  (wipes scene + autosave). A build only registers (`plotJobIds[plotId]`) if it finishes
  `done` (a splat exists) — a failed build is surfaced, not silently added (else its splat would
  404 in the viewer); on load `reconcilePlotState` un-freezes any plot marked built but lacking a
  job. `GET /api/status` reports the backend (`mode`: `gpu`/`gpu_no_url`/`local`) and the editor
  shows it as a badge so a blank splat is explained. The world recomposes from every built plot's
  splat. **Each plot keeps its own vibe** (`plotPrompts[plotId]`, shown under its name in the
  panel): the vibe modal is scoped — a single build sets that plot's prompt; **Build all** keeps
  each plot's saved vibe and only fills the unset ones with the typed prompt (a blank prompt
  still falls back to the parent plot's, server-side). **Each plot is independent**:
  an expansion is a normal generation of just the new tile (framed on itself, inheriting the parent's
  prompt for style continuity). Objects built there are the new (non-`existing`) delta,
  masked per-view (`new_mask`); fusion keeps **only** those masked points (`WriteExpandedPLY`)
  so the plot's `world.ply`/`world.splat` contains only its own content. The parent plot is
  **never** read, merged, fetched, or retrained — the world is composed by stacking per-plot
  splats in the viewer. Fusion's keep-region is the new tile's tight AABB + margins
  (`expandCullBounds`), not the union of all tiles. **Runs on the RunPod worker** when
  configured: `buildRunpodInput` ships the per-view masks (no parent cloud); the worker
  one-shot (`pipeline.go`) fuses only the new tile into its own `world.ply`. **Needs a worker
  image rebuild** to take effect (`services/runpod/Dockerfile` bakes the code). The no-RunPod
  fallback (`runExpansion`) mirrors this with local ComfyUI generation (not inpaint;
  `inpaint.go`'s `RunComfyInpaint` is retained but no longer wired in). Style continuity is
  via shared seed/prompt/palette, not pixel-aligned. Design + research:
  [docs/world-expansion-plan.md](docs/world-expansion-plan.md).
- **Editor state survives reloads** (`client/scripts/renderer.js`): the scene (primitives,
  plots + `plotId` membership, per-plot build jobs `plotJobIds`, `activeOrigin`, `lastJobId`,
  last prompt, camera) autosaves to `localStorage` (`worldsketch_editor_v1`, debounced + on
  `beforeunload`); open with `?new` to start clean. On load the editor re-fetches
  `/api/jobs/<lastJobId>` and recomposes the world from every built plot's splat without
  regenerating. The server reconstructs a
  finished job from disk (`Store.Get` → `output/<id>/`, needs `scene.json` + `world.splat`)
  when it isn't in the in-memory job map, so recovery survives a coordinator restart too.
- **Image-gen backend** is selected by `WS_IMAGEGEN` (`syncmvd` → diffusers path,
  else ComfyUI). See `server/syncmvd.go`.
- **Tripo splat pipeline** (additive, flag-gated): `WS_PIPELINE=tripo` swaps the whole
  image-gen→depth→fusion→train chain for a single-image path — the server takes one captured
  isometric view (`WS_ISO_VIEW`, default `corner_fr_high`), restyles it via OpenAI
  `gpt-image-1` `/v1/images/edits` (needs `OPENAI_API_KEY`), POSTs the image to the synchronous
  TripoSplat API (`TRIPO_API_URL`, `/generate`, `output_format=splat`), and writes the returned
  `world.splat` directly. No depth/fusion/local-training/RunPod on this path; colliders are still
  served from scene primitives (the Tripo splat is in its own frame, so they may not align). The
  default pipeline is untouched when `WS_PIPELINE` is unset. Checked first in `Store.Run`. Tripo's
  raw output is kept as `world_raw.splat`; `normalizeSplat` then reorients it (Tripo is Y-down vs our
  Y-up viewer — `WS_TRIPO_FLIP=none|x|y|z`, default `x`) and fits it to the scene's XZ footprint
  resting on the ground (`WS_TRIPO_FIT`, default on) before writing `world.splat`. Code:
  `server/tripo.go`; knobs in `.env.example`.
- **Python interpreter**: `WORLDSKETCH_PYTHON`, else `services/ml/.venv`, else `python3`.
- **Secrets**: `RUNPOD_API_KEY` is read from env — the server **auto-loads `.env`** at startup
  (`loadDotEnv`, repo root; shell exports take precedence). Never commit it; `.env` is gitignored.
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
