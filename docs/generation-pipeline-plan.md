# Plan: End-to-end GPU generation → playable world

## Vision
Player builds a scene → hits generate → the scene is **queued** → a **single GPU worker runs the entire pipeline** (render views → image-gen → fusion → gsplat → `.spz`) → returns **`.spz` + colliders** → player drops straight into their generated world and **walks around in first person with collision**.

No browser-side capture, no bundle shuffling, no manual GPU hop. Client sends a scene, gets back a playable world.

## The architecture shift
| | Today | Target |
|---|---|---|
| What the client sends | 9 rendered views (RGB+depth+cameras) it captured in-browser | **just the scene JSON** (primitives + bounds) |
| View rendering ("screenshots") | Browser WebGL (`capture.js`) | **GPU worker, headless** |
| Image generation | Local ComfyUI on the Mac | **GPU worker** |
| Fusion → point cloud | Go on the Mac | **GPU worker** (same `fusion.go`) |
| gsplat | Rented GPU, manual | **GPU worker** |
| Output | downloadable `.splat` bundle | **`.spz` + collider JSON, served back** |
| Playback | orbit viewer | **first-person walkable w/ collision** |

The Mac/browser becomes **authoring + playback only**. Everything from screenshots to `.spz` lives on one GPU worker — so the data never round-trips mid-pipeline.

## Pipeline stages (all on the GPU worker)
1. **Headless view rasterization** — scene JSON → the 9 `primitive_rgb` / `primitive_depth` / `camera.json`. Replaces the browser capture. Must reproduce `capture.js`'s exact camera poses + depth convention, or fusion misaligns.
2. **Edge + depth-control maps** — `WriteEdgeMap` / `WriteDepthControl` (already exist, CPU).
3. **Image generation** — ControlNet img2img today; **SyncMVD** is the drop-in quality upgrade later (see [syncmvd-plan.md](syncmvd-plan.md)). Same I/O either way.
4. **Fusion → point cloud** — `fusion.go`, unchanged.
5. **gsplat training** — `train_splat.py`, unchanged except output format.
6. **Encode `.spz` + emit collider JSON** — collider JSON is already the scene primitives (`collisions.go`).
7. **Return artifacts** — `.spz` + colliders to the player.

Note the elegance: stages 2/4/6 already exist in your Go/Python code. The genuinely new pieces are **headless rendering**, **`.spz` encoding**, and the **first-person player**.

## Components to build
| Component | Effort | Owner |
|---|---|---|
| Job queue + GPU worker service | medium | **you** (infra) |
| Relocate Go backend onto the GPU box | small–medium | me (mostly config) |
| Headless view renderer (replace `capture.js`) | medium | me |
| `.spz` encoder (from gsplat output) | small–medium | me |
| First-person playback client (splat render + controller + collision) | **large** | me |
| Artifact hosting (serve `.spz` to players) | small | **you** (infra) |

## Key decisions & risks
- **Where the Go server runs.** Putting it *on the GPU box* is the unlock: it can shell out to the diffusion + gsplat python locally (no transfers), and `fusion.go`/`collisions.go`/`ply.go`/`jobs.go` are reused as-is. This is what makes "one worker does everything" cheap to build.
- **Headless rendering approach.** Options: a headless GL renderer (moderngl/pyrender), a headless `three` via node, GPU rasterizer (nvdiffrast), or — since the primitives are analytic — rasterize them directly. **Risk:** the headless output must match the browser's camera/projection/depth exactly, or fusion's unprojection drifts. Mitigate with a pixel-diff test against a few browser-captured references.
- **`.spz` format.** Niantic's compressed splat format (quantized + gzipped). Reuse an existing encoder if one exists for your stack; otherwise port the spec. The gsplat trainer already has all the data (means/scales/quats/colors/opacity) — it's an output-writer swap from `.splat`.
- **First-person collision.** You already have **analytic colliders** (box/sphere/cylinder/cone) — so capsule-vs-primitive collision is tractable (no mesh cooking). The player is a splat renderer + a kinematic character controller (gravity, capsule sweep against the colliders). This is the biggest single build.
- **Worker concurrency / cold start.** One scene at a time per GPU is simplest; queue depth + model residency (keep SD + gsplat warm) matter for throughput.
- **Determinism.** Headless render → image-gen → fusion must be reproducible enough that a re-run looks the same; pin seeds.

## What *you* have to do (operational)
1. **Provision the GPU worker + a queue** (the rented GPU becomes a long-running worker, not a one-shot gsplat box). A simple queue (Redis/SQS/db table) + a poll loop is enough to start.
2. **Host the backend on the GPU box** — run the Go server there so diffusion + fusion + gsplat are all local to it. Client talks to it (or to a thin API in front).
3. **Serve artifacts** — somewhere to store/serve the `.spz` + colliders back to players (object storage + URL).
4. Everything else (headless renderer, spz encoder, first-person player) is code I write.

## Phasing (each phase independently shippable)
- **Phase 0 — measure first** *(in progress)*: validate depth-CN + the consistency metric. Gates whether SyncMVD is even needed. Don't skip.
- **Phase A — Consolidate on the GPU box**: move the Go backend + ComfyUI/diffusion + gsplat onto one GPU worker, *keep* browser capture for now. Output stays `.splat`. Proves "one box does it all," kills the manual gsplat hop.
- **Phase B — `.spz` output**: swap/extend the trainer's writer to emit `.spz`; return it + colliders.
- **Phase C — Headless rendering**: move view rasterization off the browser; client now sends only scene JSON. This is the "cut out the middleman" step.
- **Phase D — First-person player**: splat viewer + character controller + collision against the analytic colliders. The payoff — walk around your world.
- **Phase E — SyncMVD (optional quality)**: swap the image-gen stage for synchronized multi-view diffusion if depth-CN isn't consistent enough.

## Recommended order
0 → A → B → D → C → (E). Rationale: A removes your current biggest pain (manual GPU step) immediately; B + D get a *playable* result fast (even with browser capture still in the loop); C cuts the last client dependency; E is a quality lever you only spend on if the metric says you need it. (D before C is deliberate — playability is the motivating milestone; headless rendering is plumbing that can come right after.)

## Effort (rough)
Phase A ~2–3 days · B ~1–2 · C ~2–4 · D ~1–2 weeks (the player is the real work) · E ~3–5 days. The first-person player dominates; everything upstream is mostly relocating and rewiring code you already have.
