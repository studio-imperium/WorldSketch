# WorldSketch — Architecture & Research

The long-form companion to the root [CLAUDE.md](../CLAUDE.md). This is where the
detail that goes stale lives, so the root file can stay short. Three sections:
**what's happening** (architecture), **how to spin it up** (run guide), and **the
research behind it** (why the pipeline is shaped this way). The phase-by-phase build
plans are in [generation-pipeline-plan.md](generation-pipeline-plan.md) and
[syncmvd-plan.md](syncmvd-plan.md).

---

## 1. What's happening

### The idea

WorldSketch turns a **rough primitive blockout** into a **playable Gaussian-splat
world**. You drop boxes / spheres / cylinders / cones in a browser to sketch a
scene, write a one-line prompt, and a GPU pipeline returns a trained `.splat` plus
collider geometry.

The key trick: the primitives do double duty.

- **As art direction** — their rendered silhouettes (canny edges) and depth maps are
  fed to a ControlNet so image generation paints *on top of* your blockout instead of
  hallucinating freely. The shapes you placed are where the detail lands.
- **As physics** — every primitive is exported verbatim as an analytic collider
  (`collisions.json`). No mesh cooking; box/sphere/cylinder/cone are trivial to test
  a capsule against, which is what makes a first-person walkable mode tractable.

### Component map

```
┌────────────────────────── BROWSER (authoring + playback) ──────────────────────────┐
│  client/index.html  ── Three.js editor: place/move/scale/rotate primitives          │
│  client/scripts/capture.js  ── renders 13 views (RGB + depth + camera) at 512²       │
│  client/scripts/api.js      ── POST scene + views → /api/generate, poll job          │
│  client/splat-viewer.html   ── gaussian-splats-3d viewer + collider wireframe        │
│  client/viewer.html         ── PLY point-cloud viewer + collider wireframe           │
└──────────────────────────────────────┬──────────────────────────────────────────────┘
                                        │  multipart POST /api/generate
                                        ▼
┌────────────────────────── server/  (Go coordinator, :8067) ──────────────────────────┐
│  main.go     HTTP: /api/generate, /api/jobs/<id>(/world.splat|world.ply|collisions…)  │
│  jobs.go     Store: queue, status, one-time result tokens, local vs remote dispatch   │
│  pipeline.go RunPipeline(): imagegen → depth → fusion → train  (one-shot worker path) │
│  comfy.go    RunComfy(): batched ControlNet img2img against local ComfyUI :8188       │
│  syncmvd.go  runImageGen() backend switch (ComfyUI default | SyncMVD via WS_IMAGEGEN) │
│  fusion.go   WritePLYFromViews(): unproject every view → colored point cloud          │
│  edges.go    WriteEdgeMap (Sobel canny) + WriteDepthControl (depth → CN hint)         │
│  depth.go / train.go   shell out to services/ml/{depth,train_splat}.py                │
│  primitive_cull.go     drop fused points unsupported by / off-color vs any primitive  │
│  collisions.go / bundle.go   serve colliders + a training-bundle zip                  │
│  runpod.go   delegate generation to a RunPod serverless endpoint                      │
└───────────────┬───────────────────────────────────────────────┬──────────────────────┘
        local pipeline                                  serverless dispatch
                │                                                 │
                ▼                                                 ▼
┌──── services/ml/ (Python GPU) ────┐         ┌──── services/runpod/ (worker) ────┐
│  train_splat.py  gsplat optimize  │         │  handler.py  stage inputs, keep    │
│  depth.py        Depth-Anything-V2│         │     ComfyUI warm, run the Go       │
│  syncmvd.py      multi-view diff. │         │     one-shot binary, PUT result    │
│  geometry.py     project/unproject│         │  Dockerfile  CUDA + Go + ComfyUI + │
│  test_geometry.py  math unit tests│         │     prebuilt gsplat wheel          │
└───────────────────────────────────┘         └────────────────────────────────────┘
```

### Three deployment shapes

The same code runs three ways; the difference is **where the GPU work happens**.

| Mode | Coordinator | Image-gen + gsplat | Use |
|---|---|---|---|
| **Legacy local** | Go on your Mac | local ComfyUI + local Python | dev on a CUDA-less/Apple box (gsplat needs CUDA, so this is mostly for the editor + fusion loop) |
| **Serverless** | Go on Mac/cheap CPU | RunPod endpoint, 0→1 per job | a few generations/day, pay-per-second |
| **All-on-GPU-box** | Go on the GPU pod | same box, local | a persistent worker, no result round-trip |

Selection is automatic: if `RUNPOD_ENDPOINT_ID` + `RUNPOD_API_KEY` are set,
`Store.Run` delegates to RunPod (`runRemote`); otherwise it runs the pipeline
in-process (`jobs.go`).

### The generation flow, end to end

1. **Capture (browser).** `capture.js` renders 9 cameras around the scene center
   `[0, 1.6, 0]`: 4 cardinal (`front/back/left/right` at y≈4.4, ±16), `top` (y=18),
   and 4 corners (y=12, ±11). Each is 512×512, FOV 50°, near 0.05 / far 48. For each
   view it captures an RGB pass (clear color `0xeef5f2`) and a **depth pass** via a
   custom shader that normalizes `(viewZ − near)/(far − near)` to `[0,1]`, plus a
   `camera.json` (position/forward/right/up/fov/aspect/near/far).
2. **Submit.** `api.js` POSTs scene JSON + the 27 files (`<name>_rgb/_depth/_camera`)
   as multipart to `/api/generate`. The server creates a job, writes
   `output/<id>/{scene.json, views/<name>/…}`, returns `{jobId}`, and the client polls
   `/api/jobs/<id>` every 500 ms.
3. **Image generation.** Default path `RunComfy` (`comfy.go`): for each view it writes
   a **canny edge** map (`WriteEdgeMap`, Sobel) and a **depth-control** hint
   (`WriteDepthControl`), uploads them to ComfyUI, and builds one **batched** workflow
   — all views stacked into a single `batch=N` latent and denoised in one KSampler
   call (img2img, ControlNet canny in series with ControlNet depth). Output:
   `generated_rgb.png` per view. Alternate path `WS_IMAGEGEN=syncmvd` → `syncmvd.py`.
4. **Depth estimation.** `depth.py` runs **Depth-Anything-V2-Small** on each
   `generated_rgb.png` → `generated_depth.png` (falls back to copying the primitive
   depth if it fails).
5. **Fusion.** `WritePLYFromViews` (`fusion.go`) unprojects every pixel of every view
   to world space using the camera + a depth blend (primitive depth as the coarse
   shape, generated depth fitted via least-squares for fine detail), then
   **dedupes**, **culls points not supported by any primitive / off-color vs the
   nearest primitive** (`primitive_cull.go`), and **culls sparse** points. Output:
   `world.ply` (colored point cloud) + a `point_filter.log`.
6. **gsplat training.** `train_splat.py` initializes Gaussians from `world.ply` and
   optimizes them against the 9 generated views with a masked L1 + D-SSIM loss (plus
   background-opacity, anisotropy, scale and opacity regularizers, and
   densify/prune). Output: `world.splat` (binary: mean / scale / color+opacity /
   quat per Gaussian).
7. **Serve.** `world.splat`, `world.ply`, a `training-bundle.zip`, a `preview.png`
   (the front view), and `collisions.json` (the scene primitives, served directly by
   `collisions.go` — no GPU needed) are exposed under `/api/jobs/<id>/…`. The splat
   viewer loads `world.splat` and composites collider wireframes on top.

In **serverless** mode steps 3–6 run on the RunPod worker (`handler.py` runs the Go
one-shot binary), which **PUTs `world.splat`** back to a one-time
`/api/jobs/<id>/result?token=…` callback; the coordinator only polls RunPod to
surface failures.

---

## 2. How to spin it up

### Prerequisites

- **Go 1.22.12** (module is named `gausy` for legacy reasons).
- For local image-gen: **ComfyUI** on `127.0.0.1:8188` with `DreamShaper_8_pruned`
  + `control_v11p_sd15_canny` and (optionally) `control_v11f1p_sd15_depth`.
- For gsplat training: a **CUDA GPU** + the ML venv (`services/ml/requirements.txt`,
  `gsplat==1.5.3`). Apple/CPU boxes can run the editor + fusion but not training.
- For serverless: a **RunPod** account, a serverless endpoint built from
  `services/runpod/Dockerfile`, and a **network volume** holding the models under
  `models/checkpoints` + `models/controlnet`.

### Mode A — legacy local (editor + local ComfyUI)

```bash
./scripts/dev-legacy.sh        # starts ComfyUI (:8188) if needed + Go server (:8067)
# editor:  http://localhost:8067
# comfy:   http://127.0.0.1:8188
```
Or run pieces by hand: `cd server && go run .` (serves `../client` + the API on 8067).

### Mode B — serverless coordinator (RunPod for GPU)

```bash
cp .env.example .env           # set RUNPOD_ENDPOINT_ID + RUNPOD_API_KEY
brew install cloudflared       # one-time
./scripts/dev.sh               # tunnels :8067, sets WORLDSKETCH_PUBLIC_URL, runs Go
```
The worker needs a **public URL** to PUT results back — that's what the cloudflare
tunnel (or, per [serverless.md](serverless.md), ngrok) provides. In prod, run the
coordinator on a public CPU box and set `WORLDSKETCH_PUBLIC_URL` directly (no tunnel).

Building/pushing the worker image and wiring the model volume is a one-time RunPod
setup — see [serverless.md](serverless.md).

### Mode C — everything on one GPU box

```bash
# on a RunPod pod with a persistent volume at /workspace:
bash scripts/setup-worker.sh   # installs Go, ML venv, ComfyUI + models, builds server (idempotent)
bash scripts/start-worker.sh   # ComfyUI (:8188) + server (:8067)
```
Full details + env knobs in [worker-setup.md](worker-setup.md). First generation
pays gsplat's one-time ~10-min CUDA compile (cached on the persistent volume after).

### Tunable knobs (no rebuild — env only)

Set these *where the pipeline runs* (RunPod endpoint env for serverless, `.env`/shell
locally). Defaults in `.env.example` and read in `server/config.go`.

| Var | Default | Effect |
|---|---|---|
| `WS_STEPS` / `WS_CFG` / `WS_DENOISE` | 7 / 6.5 / 0.5 | KSampler steps / guidance / img2img strength |
| `WS_IMAGE_ONLY` / `WS_IMAGE_ONLY_VIEW` | 0 / front | stop after image generation; when enabled, only generate this single view |
| `WS_RETRAIN_ONLY` | 0 | worker mode used by retrain uploads; skips image generation, depth, and fusion, then trains from an existing bundle/job dir |
| `WS_CANNY_STRENGTH` / `WS_DEPTH_STRENGTH` | 0.9 / 0.6 | ControlNet conditioning strengths |
| `WS_FUSION_STRIDE` | 1 | pixel stride for fusing each generated view (higher = faster/sparser) |
| `WS_DEDUPE` | 0.015 | point-cloud dedupe radius (smaller = denser) |
| `WS_SPARSE_VOXEL` / `WS_SPARSE_MIN_NEIGHBORS` | 0.1 / 4 | sparse-point cull (lower neighbors = keep more) |
| `WS_POINT_CLOUD_ONLY` | 0 | stop after fused `world.ply`; skips gsplat training |
| `WS_PRIMITIVE_CULL` | 1 | primitive support/color culling toggle; set `0` to keep points even when not near primitives |
| `WS_PRIMITIVE_SUPPORT_MARGIN` | 0.1 | primitive shape-cull margin in world units (higher = keep points farther outside primitive surfaces) |
| `WS_COLOR_CULL_THRESHOLD` | 0.8 | how aggressively to drop off-color points |
| `WS_SPLAT_STEPS` / `WS_SPLAT_SIZE` | 3000 / 512 | gsplat optimization steps / render target resolution |
| `WS_SPLAT_MAX_POINTS` | 0 | gaussian budget; 0 means no growth beyond fused PLY count |
| `WS_SPLAT_MAX_SCALE` / `WS_SPLAT_DENSIFY_FRAC` | 0.07 / 0.1 | gaussian size cap / clone fraction during densification |
| `WS_SPLAT_REFINE_EVERY` / `WS_SPLAT_DENSIFY_STOP_FRAC` | 100 / 0.6 | densify-prune cadence / when cloning stops |
| `WS_IMAGEGEN` | (ComfyUI) | `syncmvd` switches to the diffusers path |
| `WS_EXPAND_DENOISE` / `WS_EXPAND_MASK_GROW` | 0.8 / 6 | expansion: img2img strength inside the new-object mask / px the mask is dilated for seam blending |
| `WORLDSKETCH_PYTHON` | venv → `python3` | python interpreter for the ML scripts |

### Tests

```bash
cd server && go test ./...            # fusion / runpod / cull / comfy-batch tests
python services/ml/test_geometry.py   # projection round-trip + voxel-sync (pure numpy)
```

---

## 3. The research behind it

WorldSketch is an applied stack of three research areas: **controllable multi-view
image generation**, **multi-view depth fusion**, and **3D Gaussian splatting**. The
design choices below are the load-bearing ones.

### 3a. Why ControlNet img2img on primitive renders

Generating a coherent 3D scene from text alone gives you views that don't agree.
Conditioning each view on the **primitive render** (img2img init) + its **canny
silhouette** + its **depth map** (depth ControlNet) pins geometry to the blockout you
drew, so the diffusion mostly adds *material/texture* rather than moving surfaces.
Doing it as a single **batched** diffusion keeps the GPU saturated vs. per-view round-trips.
The base prompt deliberately asks for *shadowless, diffuse, overcast* lighting — baked
directional shadows fuse into the splat as dark splotches, so flat lighting fuses
cleaner.

### 3b. The consistency problem → SyncMVD

Even with depth-CN, the views are diffused **independently**, so the same surface
can get different texture across views → ghosting / floaters when fused. **SyncMVD**
(synchronized multi-view diffusion) addresses this by making the views *share one
appearance through the known 3D geometry during denoising*: at each step, decode the
predicted clean latents, **unproject** them onto a shared voxel grid, **average** the
overlapping views, **reproject** the consensus back into each view, and blend it in —
tapering off in the last ~30% of steps so late steps still add per-view detail.

Status: `services/ml/syncmvd.py` implements both a Phase-1 per-view path
(`run_per_view`, a diffusers drop-in for ComfyUI) and a Phase-3 synced loop
(`run_synced`, latent-space voxel sync via `geometry.py`'s `VoxelSync`). The
guiding principle in [syncmvd-plan.md](syncmvd-plan.md) is **measure before
building**: validate the cheap depth-CN win and a reprojection-consistency metric
first; only invest in full SyncMVD if the number says depth-CN isn't enough.

### 3c. Fusion math (the projection contract)

`fusion.go` unprojects each pixel to world space:
```
depth = near + nd·(far − near)
px = (2·(x+0.5)/w − 1) · aspect · tan(fov·π/360) · depth
py = (1 − 2·(y+0.5)/h)         · tan(fov·π/360) · depth
world = pos + fwd·depth + right·px + up·py
```
`nd` blends the **primitive depth** (coarse, trusted shape) with a least-squares-fit
**generated depth** for fine surface detail (`detailDepth` / `depthFit`). This exact
math is mirrored in `geometry.py` (`unproject`/`project`) so the consistency metric
and SyncMVD agree with fusion — `test_geometry.py` validates the round-trip against
analytic ground truth. **Any new view renderer must reproduce these poses exactly**,
or every downstream stage drifts. After unprojection, points are deduped and culled
against the primitives (a point only survives if it's near *and* color-matches some
primitive) — this is what kills floaters before they ever reach gsplat.

### 3d. gsplat training

`train_splat.py` initializes Gaussians from the fused point cloud and optimizes
means/scales/quats/colors/opacity against the 9 generated views. Notable choices:
masked **L1 + D-SSIM** on the foreground silhouette (mask eroded to drop translucent
halos), a **background-opacity penalty** so floaters can't hide in unsupervised sky,
**anisotropy regularization** to suppress needle spikes, and periodic
**densify/prune**. The point-cloud init (rather than random) plus the primitive cull
is what lets it converge in ~3000 steps. The worker uses a **prebuilt gsplat wheel**
to skip the ~10-min cold-start CUDA compile.

### 3e. Roadmap (from the plan docs)

The north star is **walk inside your sketch**:
- **A — consolidate on the GPU box** (done): whole pipeline on one CUDA worker.
- **B — `.spz` output**: emit Niantic's compressed splat format alongside `.splat`.
- **C — headless rendering**: move the 9-view capture off the browser so the client
  sends *only* scene JSON (must match `capture.js`'s camera/depth exactly).
- **D — first-person player**: splat renderer + kinematic capsule controller doing
  collision against the analytic colliders. The biggest single build; the payoff.
- **E — SyncMVD** (optional quality): swap image-gen if depth-CN consistency isn't enough.

A parallel track is **growing a world plot-by-plot instead of regenerating it**: each
expansion is an *independent* generation of just the new tile (`WriteExpandedPLY` fuses
only the new objects' masked points into the new plot's own `world.ply`/`world.splat`).
The existing plot is never re-fused or re-trained — the world is composed by stacking
per-plot splats in the viewer, with style continuity from the shared prompt/seed. Design +
the model-optimisation levers it shares with SyncMVD/gsplat:
[world-expansion-plan.md](world-expansion-plan.md).

Full rationale, effort estimates, and ordering: [generation-pipeline-plan.md](generation-pipeline-plan.md).

---

## Keeping docs fresh

The honest version of "never stale," based on current Claude Code guidance
([best practices](https://code.claude.com/docs/en/best-practices),
[CLAUDE.md best practices](https://techsy.io/en/blog/claude-md-best-practices)):

1. **Treat docs like code.** CLAUDE.md + this file are updated *in the same PR* as the
   change that invalidates them, and reviewed there. There is no substitute for this.
2. **Keep CLAUDE.md lean** (< ~200 lines). Past ~80 lines rules start getting dropped;
   past ~200 they're ignored in bulk. That's *why* the deep detail lives here, not in
   CLAUDE.md — a short curated entry point stays accurate; a giant auto-generated dump
   rots and gets ignored.
3. **Hooks enforce; they don't write prose.** Auto-regenerating docs with an LLM on
   every change burns tokens and ships unreviewed drift/hallucination. The right
   mechanism is a **drift guard**: a hook that *warns* when source changes without
   docs changing, so a human/agent updates them deliberately. Two practical options:
   - **Git `pre-commit` hook** — if a commit touches `server/`, `services/`, or
     `client/scripts/` but not `CLAUDE.md`/`docs/`, print a reminder (or block).
     Enforced at commit time, works regardless of editor.
   - **Claude Code `Stop`/`PostToolUse` hook** (in `.claude/settings.json`) — after
     edits to source, inject a reminder to refresh the docs. In-session, agent-facing.

**What's wired up here (both, as reminders):**

- **Git pre-commit** — `scripts/hooks/pre-commit`. Warns (never blocks) when a commit
  touches `server/`, `services/`, `client/scripts/`, or `scripts/` without touching
  `CLAUDE.md`/`docs/`. Enable it in a fresh clone with:
  ```bash
  git config core.hooksPath scripts/hooks
  ```
  (`core.hooksPath` is local config, so each clone runs this once.)
- **Claude Code hook** — `.claude/settings.json` runs `.claude/hooks/doc-reminder.py`
  as a `PostToolUse` (Edit|Write) hook. After you edit source it injects a one-line
  reminder into the agent's context to refresh the docs; editing the docs themselves
  triggers nothing.

Neither rewrites these files for you — by design.
