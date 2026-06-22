# Plan: Context-aware world expansion ("decorate to match the existing plot")

The third plan doc, alongside [generation-pipeline-plan.md](generation-pipeline-plan.md)
(get to a playable world) and [syncmvd-plan.md](syncmvd-plan.md) (make the 13 views of
*one* generation agree). This one is about a different axis of consistency: making a
**second generation agree with the first** so a world can grow.

## Problem

Today a scene is a **one-shot**: place primitives → Generate → one `world.splat` +
colliders. There is no notion of "add more and keep it." If you regenerate after
adding a tree, the whole world is re-diffused from scratch with a fresh seed, so the
parts you already liked drift — different palette, different lighting, different
texture on the same rock. You can't *grow* a plot.

What we want, in the user's words: **another plot that uses the existing context of
the existing plot, so that when you add more objects it decorates those objects using
the existing plot — matches it.** Add a lamppost to a generated alley and it should
come out lit and weathered like the alley, dropped into the *same* world, not a new one.

## The idea

Treat the first generation as **frozen context** and only generate the **delta**.

```
plot 1 (done)          add primitives          plot 2 = plot 1 + decorated delta
  world.splat   ─────►  mark new objects  ─────►  inpaint ONLY the new pixels,
  generated views                                 conditioned on the frozen
  world.ply                                       surrounding plot-1 pixels
```

The load-bearing trick is the same one the whole project already leans on: **the
primitives are the geometry contract.** Because we know exactly where the new objects
are in every view (we render their silhouettes + depth), we can build a per-view
**mask** of "what is new," and:

1. **Image-gen** runs as a **masked img2img / inpaint**: the base image per view is
   plot 1's `generated_rgb` (the decorated world) with the new primitives' flat
   blockout colour composited into the masked region; we denoise **only the masked
   region**. The surrounding frozen pixels drive ControlNet + the latent, so the
   diffusion paints the new object to match the existing palette, lighting, and
   material — for free, because the context literally *is* the existing world.
2. **Fusion** unprojects **only the new (masked) pixels** into points and **merges**
   them with plot 1's `world.ply`. The existing point cloud is untouched, so the part
   you already liked is byte-for-byte stable.
3. **Training** initialises from the merged cloud and optimises against the inpainted
   views (which show existing **and** new), so gsplat converges the whole expanded
   world coherently. (A warm-start variant — freeze plot-1 Gaussians, only optimise
   the new region — is the model-optimisation lever in §"Optimising the model".)

Net: existing world preserved exactly; new objects decorated to match; one merged
`world.splat` + colliders out.

## Why this beats the obvious alternatives

| Approach | Why not (for "match the existing plot") |
|---|---|
| Re-run the full pipeline with the bigger scene | Fresh seed + independent diffusion → the existing world re-rolls and drifts. No continuity. |
| Reuse the seed + prompt only | Cheap, partial. Same neighbourhood, but the new object still doesn't *see* the existing surfaces, so palette/lighting only loosely match. Good as a fallback, not the mechanism. |
| IP-Adapter / style-reference only | Transfers global style but not local context (the new object won't pick up the specific moss/brick next to it). Useful **add-on** (see risks), not the core. |
| **Masked inpaint on the frozen plot-1 views** (this plan) | The new object is generated *inside* the real surrounding pixels → local + global match, and the existing world is provably preserved (we never denoise it). |

## Data model changes

Minimal, additive, backward-compatible (all fields `omitempty`):

```go
// scene.go
type Scene struct {
    ...
    Parent string `json:"parent,omitempty"` // job id of the plot we're expanding
}
type Primitive struct {
    ...
    Existing bool `json:"existing,omitempty"` // already decorated by the parent plot
}
```

- `Parent == ""` → today's one-shot path, unchanged.
- `Parent != ""` → expansion path. Primitives with `Existing: true` came from the
  parent and are frozen; the rest are the delta to decorate.

The client also sends, per view, a **new-object mask** (`<name>_mask`): white where a
*new* primitive is visible, black elsewhere — the exact region to inpaint and to fuse.

## Pipeline changes (server)

New file `expand.go` + `inpaint.go`; the existing files are reused as-is.

1. **`prepareExpansionView`** (`expand.go`) — per view, composite
   `context_rgb = mask ? primitive_rgb : parent/generated_rgb`. This is the inpaint
   base: decorated world everywhere, flat blockout colour where the new object goes.
   If a view's mask is empty (the new object isn't visible from that camera), skip
   generation and just copy the parent's `generated_rgb` through.
2. **`inpaintViewWorkflow`** (`inpaint.go`) — a ComfyUI workflow that does
   `VAEEncode(context_rgb) → SetLatentNoiseMask(new_mask) → KSampler(denoise=WS_EXPAND_DENOISE)`.
   `SetLatentNoiseMask` (not `VAEEncodeForInpaint`) so denoise strength still applies
   and the frozen region is preserved exactly while the masked region respects the
   blockout colour as init. Canny + depth ControlNet from the **new** scene pin the new
   object's silhouette/geometry. Per-view (not batched) for slice 1 — each view has a
   different mask, and core ComfyUI has no clean batched-mask node; batching is a
   documented follow-up.
3. **`WriteExpandedPLY`** (`expand.go`) — unproject only masked pixels → dedupe → cull
   against the **new** primitives only → sparse-cull → **append to the parent's
   `world.ply`** → write merged. Falls back to new-only if the parent ply is absent
   (e.g. a serverless parent that only returned `.splat`).
4. **Training** — unchanged for slice 1 (retrain the merged cloud against the inpainted
   views). Warm-start is the optimisation in the next section.

Routing: `Store.Run` branches to `runExpansion` when `scene.Parent != ""`. Slice 1
runs expansion **locally** even if RunPod is configured (the worker doesn't yet have
the parent artifacts); that's a documented serverless follow-up.

New env knobs (read where the pipeline runs, like the rest — `config.go`):

| Var | Default | Effect |
|---|---|---|
| `WS_EXPAND_DENOISE` | 0.8 | img2img strength inside the new-object mask (higher than the 0.5 base — the masked region is a full repaint, the frozen region is untouched regardless) |
| `WS_EXPAND_MASK_GROW` | 6 | px to dilate the mask so the new object blends into its seam instead of leaving a hard edge |

## Shipped v1 — adjacent-plot tiling ("Add plot")

The first interpretation built was object-level inpaint *within* one plot. The shipped
UX is the one the user actually wanted: **extend the world with adjacent tiles.**

- **+ Add plot** (editor) lays a fresh 20×20 ground tile next to the current plot
  (directions cycle E/S/W/N), frames the camera on it, and freezes the previous plot
  (locked + dimmed). Objects you build on the new tile are the delta.
- **Generate** then runs the expansion: it frames + masks the new tile, sends `parent`
  + the union `bounds` of all tiles, inpaints the tile's content, and fuses it onto the
  parent `world.ply` (one merged world; each plot is also its own job/splat → "both"
  outputs from the design Q).
- **Server enabler:** fusion's keep-box was a hardcoded ±16, which would discard any tile
  offset from origin. It's now `sceneCullBounds(scene)` — the authored bounds + margin —
  so the keep-region grows with the world. (`TestSceneCullBounds`.)
- **Vibe matching today** is style continuity — shared fixed seed, the parent's prompt
  (reused when the expansion submit is blank), and the palette you reuse — plus the
  parent edge being visible at the seam. It is **not** a pixel-seamless continuation:
  because adjacent tiles need their own camera framing, the parent's generated views
  don't pixel-align as frozen context the way same-frame object inpaint does. True
  seam continuity (render the parent splat into the new cameras for aligned context) is
  the next quality step.

## Shipped v2 — expansion runs on the RunPod worker

v1 ran expansion locally (ComfyUI inpaint), which is dead weight on a GPU-less Mac. v2
routes it through the same serverless path as normal generation:

- **Coordinator** (`jobs.go`): when RunPod is configured, expansion goes to `runRemote`
  (not the local ComfyUI path, which is now only the no-RunPod fallback).
- **Payload** (`runpod.go buildRunpodInput`): each view carries its `new_mask`, and the
  job carries the parent's `world.ply` (base64, `parentPly`) + the parent's prompt.
- **Worker** (`services/runpod/handler.py`): stages the masks + `parent/world.ply`, runs
  the Go one-shot.
- **Worker pipeline** (`pipeline.go`): for an expansion job it fuses via
  `WriteExpandedPLY` onto `<dir>/parent/world.ply` instead of `WritePLYFromViews`; the
  parent ply is excluded from the result bundle shipped back.
- **Parent ply transfer:** passed as a **URL** (`parentPlyUrl`), not inline base64 — a
  ~20 MB cloud would blow RunPod's `/run` request-size cap. The worker pulls it from the
  coordinator (which already serves `/api/jobs/<parent>/world.ply` over the public tunnel).

> **What "decorate to match" means on this path (important):** the worker does **not** do
> pixel-aligned masked inpaint against the parent's rendered views — that only works for
> *same-frame* object additions (the local `runExpansion` fallback). Adjacent tiles are
> framed by their own cameras, so the parent's pixels wouldn't line up. Instead the new
> tile is generated by the **normal pipeline** (syncmvd/ComfyUI) sharing the parent's
> **prompt + fixed seed**, with the existing plot visible at the seam, then **only the
> masked new points are fused** onto the parent cloud. So continuity is *stylistic*
> (palette/material/lighting), not a seamless pixel continuation. True seam blending —
> rendering the parent splat into the new tile's cameras for aligned context — is the
> next quality step.
- **Fail-loud guards:** `WriteExpandedPLY` errors if the parent ply or the per-view masks
  weren't staged (the symptom of an un-rebuilt worker), instead of silently shipping a
  broken "expansion."
- **Deploy gate:** the worker is a baked Docker image, so this needs a **worker image
  rebuild** (`docker build -f services/runpod/Dockerfile -t <user>/worldsketch-worker .`,
  push, point the endpoint at it). The coordinator (run via `dev.sh` = `go run .`) picks
  up its half on relaunch.
- **Known risk:** the parent `world.ply` (~20 MB → ~27 MB base64) inflates the `/run`
  payload; if it trips RunPod's request-size limit, switch `parentPly` to a volume/object
  handoff instead of inline base64 (tracked, see review).

## Client changes

- After a successful generate, record `lastJobId` and mark every user primitive
  `existing` + locked + dimmed ("baked into the world"). New placements are the delta.
- `serializeScene` sets `parent: lastJobId` when any `existing` primitive is present,
  and stamps `existing` per primitive.
- `captureViews` gains a mask pass: in each view, render **only the new
  primitives** white-on-black → the `<name>_mask` the server inpaints + fuses with. The
  expansion reuses the **parent plot's camera frame** (`captureFrame`) so its views line
  up pixel-for-pixel with the parent views being decorated onto (main's framing is per-
  generation dynamic, so this reuse is what keeps the frozen region aligned).
- `api.js` uploads `<name>_mask` alongside rgb/depth/camera.
- A "Expand / Decorate" affordance (the Generate button becomes "Decorate" once a
  world exists and new objects are present). Optional polish: load plot 1's `.splat`
  as a faint backdrop so the user places new objects against the world they're growing.

## Optimising the model (research, grounded in the existing plan docs)

The expansion feature and the existing roadmap share machinery; the levers worth
pulling, cheapest-first:

1. **Seed + sampler pinning (free, do first).** `batchedWorkflow` already hardcodes
   one seed; expansion must reuse the **parent's** seed/sampler/scheduler so the
   masked region lands in the same stylistic basin as its surroundings. This is the
   determinism point [generation-pipeline-plan.md](generation-pipeline-plan.md) raises
   ("pin seeds"), applied across *time* instead of across views.

2. **Warm-start / frozen gsplat training (the real win).** §3d of
   [ARCHITECTURE.md](ARCHITECTURE.md) notes the point-cloud init + primitive cull is
   what lets gsplat converge in ~3000 steps. For expansion we can do better: load the
   parent's trained Gaussians, **freeze** them (no grad), append Gaussians initialised
   from the new points, and optimise **only the new region** against the inpainted
   views. Existing world is bit-stable and training is far cheaper than a full retrain
   — the same "don't recompute what you already have" principle that makes masked
   fusion correct. `train_splat.py` already owns means/scales/quats/colors/opacity; the
   change is a frozen-parameter group + a loss mask. Effort: medium.

3. **SyncMVD generalised to cross-plot consistency.** [syncmvd-plan.md](syncmvd-plan.md)
   syncs the 13 views of one generation through the shared voxel grid. Expansion is the
   same operation with the parent world as a **fixed consensus**: seed the shared
   surface with plot 1's appearance and only let the new texels move. If/when SyncMVD
   lands (`run_synced` in `syncmvd.py` already does latent-space voxel sync via
   `geometry.py`'s `VoxelSync`), expansion is a natural mode of it — sync the new views
   against a frozen surface — and is the highest-quality version of "match the existing
   plot." Effort: large; gated on SyncMVD shipping at all (Phase 0 "measure first" still
   applies — only build it if depth-CN + inpaint context isn't consistent enough).

4. **IP-Adapter style reference (cheap quality add-on).** Pass plot 1's `preview.png`
   as an image prompt so even views where the new object barely touches existing
   surfaces still inherit the global look. Off by default (`WS_IPADAPTER`) because it
   needs custom ComfyUI nodes; the frozen-context inpaint is the primary signal.

5. **Consistency metric for expansion.** Reuse Phase 0b's reprojection-consistency
   metric (`services/ml/consistency.py`, planned) to score the seam: warp the new
   object's pixels into a neighbouring view and check they agree, and check the frozen
   region is unchanged vs the parent. A number that says "the new object matches" is
   what tells us whether we need lever 3.

## Phasing (each independently shippable)

- **Phase 0 — plumbing + tests (this PR).** Data model (`Parent`/`Existing`), the
  masked-inpaint workflow builder, the masked fusion + PLY merge, server routing, and
  Go unit tests for the workflow wiring and the merge. ComfyUI default path untouched.
  GPU/ComfyUI execution validated on a worker (can't run on an Apple/CPU box).
- **Phase 1 — client expand UX.** Existing/new marking, mask capture, the Decorate
  button, parent linkage end-to-end against a live worker.
- **Phase 2 — warm-start training.** Frozen parent Gaussians + new-region loss mask in
  `train_splat.py`; cheaper, bit-stable existing world.
- **Phase 3 — serverless expansion.** Ship the parent artifacts (or just the parent
  `world.ply` + generated views) to the RunPod worker so expansion runs on the GPU box.
- **Phase 4 — quality.** Seed pinning polish, IP-Adapter, the seam consistency metric,
  and (if the metric demands) SyncMVD-as-expansion.

## Risks

- **Seams at the mask boundary.** Hard mask edges leave a halo. Mitigation:
  `WS_EXPAND_MASK_GROW` dilation + feathering, and `SetLatentNoiseMask` (not
  `VAEEncodeForInpaint`) so the boundary blends rather than hard-cuts.
- **Depth re-fit drift.** `fusion.go`'s `depthFit` does a least-squares fit over the
  whole view; on a mostly-frozen view the fit should be computed on the **new** region
  (or inherited from the parent) so a tiny new object doesn't re-scale depth. Handle in
  `WriteExpandedPLY`.
- **Parent without `world.ply`** (serverless parent returned only `.splat`). Slice 1
  falls back to fusing new-only; full merge needs Phase 3 to ship parent artifacts, or
  a `.splat → points` reader.
- **Occlusion of existing by new.** If a new object stands in front of existing
  geometry, the parent pixels behind it are now wrong. The mask + depth handle the
  *new* surface; the now-hidden parent points stay in the cloud (harmless — occluded)
  but a Phase-2 prune pass could drop parent points the new object now covers.
- **Can't validate the diffusion path locally.** Everything except the KSampler call is
  pure CPU Go with tests; the ComfyUI inpaint must be eyeballed on a worker.

## Effort (rough)

Phase 0 ~1–2 days (mostly done in this PR) · Phase 1 ~2–3 · Phase 2 ~2–4 ·
Phase 3 ~1–2 · Phase 4 ~3–5 (SyncMVD-as-expansion dominates, and is optional).
