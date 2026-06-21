# Plan: Synchronized Multi-View Diffusion (SyncMVD) for WorldSketch

## Problem
Each of the 9 views is currently diffused **independently** in ComfyUI (img2img + canny/depth ControlNet). Depth-CN *constrains* geometry but nothing makes the views *agree on appearance*, so the same surface gets different texture/colour across views → ghosting/blur/floaters when `fusion.go` fuses them and gsplat trains on them.

## Goal
Make all views share one appearance by synchronizing them through the known 3D geometry during denoising, so they line up. We already have everything SyncMVD needs: per-view **cameras** (`camera.json`), per-view **depth** (`primitive_depth.png`), analytic **primitive geometry**, and the unprojection math in `fusion.go`.

## Guiding principle: measure before building
SyncMVD is a multi-day build. Don't invest until (a) we've confirmed the cheap depth-CN win, and (b) we have a number that says whether SyncMVD actually helps. So Phase 0 (validate + metric) ships first and is independently useful.

---

## Phase 0 — Validate depth-CN + build the consistency metric  *(½–1 day)*

**0a. Validate the depth ControlNet run.**
- Generate one scene; eyeball a `views/<name>/primitive_depth_control.png`: object should be brighter where closer (MiDaS polarity). If inverted, fix `WriteDepthControl` in `edges.go`.
- Confirm the batched ControlNet applies the right hint per view (check each `generated_rgb.png` matches its own silhouette, not view 0's). If wrong, split ControlNet per batch element.
- Confirm `control_v11f1p_sd15_depth.pth` is installed (else it silently falls back to canny-only).

**0b. Reprojection-consistency metric** — `services/ml/consistency.py`.
- For each ordered view pair (A, B): warp A's `generated_rgb` into B's frame using A's depth + both cameras, then compare to B's `generated_rgb` on the co-visible region.
- Math (mirror of `fusion.go pointsFromView`): unproject each pixel of A to world via
  `world = posA + fwdA*depth + rightA*px + upA*py` (with `px,py` from `tan=tan(fov·π/360)`, `aspect`),
  then project into B with the inverse: `depthB = dot(world-posB, fwdB)`, `px=dot(·,rightB)`, `py=dot(·,upB)`, back to pixel coords.
- Occlusion check: keep only pixels whose reprojected `depthB` matches B's `primitive_depth` (within tolerance) — i.e. actually visible in B.
- Score: masked L1 + (1−SSIM) over the co-visible region, averaged over all pairs → one scalar **consistency score** (lower = better aligned).
- **Deliverable:** a number on the *current* (independent + depth-CN) outputs = the baseline SyncMVD must beat.

**Exit criteria:** depth-CN produces correct per-view depth hints; consistency metric runs on a job dir and prints a baseline score.

---

## Phase 1 — SyncMVD scaffold (standalone diffusers script)  *(1 day)*
Why diffusers not ComfyUI: per-step cross-view ops are awkward in a node graph; we need a custom sampling loop.

- New `services/ml/syncmvd.py`, invoked like `train_splat.py` (a `RunSyncMVD(dir)` in Go can replace/alternate with `RunComfy`).
- Load **DreamShaper8** via `StableDiffusionControlNetImg2ImgPipeline.from_single_file(...)` + **MultiControlNet** (canny `control_v11p_sd15_canny`, depth `control_v11f1p_sd15_depth`). Match current params: cfg 6.5, the existing prompts, canny 0.9 / depth 0.6.
- Read the same per-view files the ComfyUI path uses (`primitive_rgb`, `primitive_edges`, `primitive_depth_control`, `camera.json`).
- Init N latents: VAE-encode each `primitive_rgb`, add noise to the **denoise=0.3** start point (img2img). Batch dim = N views.

**Exit criteria:** the script reproduces *independent* batched img2img (no sync yet) and writes 9 `generated_rgb.png` — i.e. a diffusers drop-in for `RunComfy`, same quality. Run the Phase-0 metric on it → should ≈ ComfyUI baseline (sanity check the port).

---

## Phase 2 — Geometry bridge (unproject / aggregate / reproject)  *(1–1.5 days)*
Port the projection math to a small reusable module `services/ml/geometry.py` (shared with `consistency.py`).

- **Shared surface representation:** start with the **point cloud / voxel grid** (closest to `fusion.go`, no UV unwrap). Each texel = a voxel of world space at the fusion `dedupe` resolution (~0.025).
- `unproject(view_img, depth, camera) -> (world_pts, colors, valid_mask)` — pixels → world points (reuse Phase-0 math).
- `aggregate(list_of_view_contributions) -> texel_colors` — per voxel, weighted average across the views that see it. Weight by view-facing (`dot(surface_normal, view_dir)`) and/or visibility confidence.
- `reproject(texel_colors, camera) -> view_img` — render the shared cloud back into each view (splat/z-buffer), producing a per-view "consensus" image + coverage mask.

**Exit criteria:** unit test on synthetic data — unproject→aggregate→reproject round-trips a known texture across the 9 cameras with low error; visualize the consensus image per view.

---

## Phase 3 — Synchronized sampling loop  *(1–2 days, the core)*
Replace `pipeline.__call__` with a custom loop. Per timestep t:
1. Batched UNet over N latents w/ MultiControlNet → predicted noise → **x̂₀** (predicted clean latent) per view.
2. **Decode** x̂₀ → RGB per view (handles the 8× latent/pixel mismatch accurately; the main cost).
3. **Unproject** all N decoded x̂₀ onto the shared cloud → **aggregate** → one consistent surface.
4. **Reproject** into each view → per-view consensus RGB.
5. **Blend** consensus back into each x̂₀ with factor λ_t (full replace early, taper to ~0 late so late steps add per-view fine detail without re-blurring).
6. **Re-encode** + take the scheduler step (DDIM/Euler) to t−1.

Key hyperparameters:
- **Sync schedule:** sync every step early, stop syncing in the last ~30% of steps (consensus → detail). Biggest quality lever.
- **λ_t blend ramp.**
- **Steps/denoise:** SyncMVD wants more steps than the current 5 to have room to converge — test e.g. 20–30 steps. Open question (see risks): does sync let us *raise* denoise (more realism) while keeping consistency? Worth an ablation.
- **Cost control:** decode/encode every step is expensive; option to sync every k steps.

**Exit criteria:** loop runs end-to-end on a real job, writes 9 `generated_rgb.png`; consistency score **beats the Phase-0 baseline** by a clear margin.

---

## Phase 4 — Pipeline integration  *(½ day)*
- Output the 9 consistent `generated_rgb.png` into the view dirs exactly like ComfyUI → `fusion.go` + `train_splat.py` unchanged.
- Go side: `RunSyncMVD(dir, scenePrompt)` parallel to `RunComfy`, selected by env/flag (e.g. `WORLDSKETCH_GEN=syncmvd`). Keep ComfyUI as the default/fallback.

## Phase 5 — Evaluate  *(½ day)*
- Consistency score: SyncMVD vs (independent) vs (independent + depth-CN).
- Downstream: train the splat on each; compare floater/blur qualitatively + the gsplat loss curve.
- **Success = lower consistency score AND visibly fewer floaters/sharper splat than depth-CN alone.**

---

## Key decisions
| Decision | Default | Alternative |
|---|---|---|
| Shared representation | Point cloud / voxel grid (matches fusion) | UV texture atlas (sharper, needs per-primitive UVs) |
| Sync space | Decode x̂₀ → RGB, sync, re-encode (accurate) | Latent-space sync (fast, fuzzy from 8× downsample) |
| Sync schedule | Every step, taper last 30% | Every k steps (cheaper) |
| Generator | DreamShaper8 via `from_single_file` | Keep, but confirm it loads in diffusers |

## Risks
- **Latent↔pixel mismatch** (the main gotcha): decode/encode per step is correct but slow; latent-space sync is cheap but geometrically fuzzy. Start accurate, optimize later.
- **DreamShaper8 in diffusers**: `from_single_file` + matching the canny/depth CN weights; verify outputs match the ComfyUI look before trusting the metric.
- **Low denoise (0.3) leaves few steps to sync** — may need more steps / higher denoise; tension with the consistency we already get cheaply from low denoise.
- **Perf**: N=9 × 512² × decode/encode × ~25 steps on the 4090 — feasible but slower than the ComfyUI batch; sync-every-k is the relief valve.
- **Occlusion/visibility errors** in reprojection create seams — needs a solid depth-test tolerance and coverage masking.

## Recommended order
**Phase 0 first, always** (validate depth-CN + ship the metric — independently useful, and it may show depth-CN already closes most of the gap). Then 1→5. Phase 2's geometry module is shared with Phase 0's metric, so building 0b cleanly pays off the whole plan.

## Effort
~4–6 focused days total: Phase 0 (~1) + Phases 1–5 (~3–5). Phase 3 is the hard part; everything else is plumbing you mostly already have.
