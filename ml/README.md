# ml/ — TripoSplat structural-training groundwork

Two de-risking experiments before any training data is generated. Each answers a yes/no
question; together they decide whether the fine-tuning project is worth pursuing.

| File | Phase | Question it answers |
|------|-------|---------------------|
| `score.py` (+ `splat_io.py`) | 0 | *Is the residual placement error even worth training away vs. fixing in post-processing?* |
| `infer.py` | 1 | *Can we backprop output gaussians → trainable weights at all?* (TripoSplat is a diffusion pipeline, so this is the real risk.) |

## Phase 0 — `score.py`: the spatial-accuracy metric

Measures how far a generated splat's geometry is from the **known block-out** (the
colliders = free ground truth). It similarity-aligns the splat to the GT cloud first, so
it scores *relative* placement/depth — the thing post-processing can't fix — not global
pose, which it can.

```bash
pip install numpy scipy
cd ml
python score.py path/to/plot.splat layout_example.json
```

Outputs `chamfer` (overall geometry error, plot units), `obj_centroid` (mean per-object
placement error), and a per-object breakdown.

**How to use it now:** run it on a handful of your saved generations against their layouts.
- If `obj_centroid` is already tiny after your full cull/seat/fit → **don't train; tune the pipeline.**
- If it's consistently large and not pose-related → there's a real target for training, and this is the number you'll watch to know if a fine-tune helped.

**Missing piece (Phase 2):** the pipeline doesn't yet export `layout.json`. The block-out's
3D is known client-side (positions/scales/rotations of each primitive); the data engine
just needs to dump it next to the image — `WS_SAVE_GENERATIONS` already saves the image,
so this is a small addition. `layout_example.json` is the target schema.

## Phase 1 — `infer.py`: the differentiability GO/NO-GO

Runs **on the GPU box** with the TripoSplat repo + checkpoints. Note TripoSplat is a
*diffusion* model (DINOv3 + diffusion transformer + VAE decoder + birefnet), so training
means backprop through a **sampling loop** — the crux this probes.

```bash
export TRIPOSPLAT_REPO=/path/to/TripoSplat
export TRIPOSPLAT_CKPTS=$TRIPOSPLAT_REPO/ckpts

python infer.py reproduce  --image guide.png --out out.splat   # sanity: matches the server?
python infer.py inspect                                        # module tree + LoRA targets
python infer.py grad-check --image guide.png                   # does a grad path exist?
```

- `inspect` auto-discovers the submodules and lists attention/MLP Linear layers worth
  LoRA-ing (attribute names are repo-specific, so it discovers rather than assumes).
- `grad-check` first tests whether the public `run()` keeps gradients (it likely won't —
  inference wraps `no_grad`), then tries a manual grad-enabled loop you wire in
  `differentiable_run()` after `inspect` shows the real names.

**Interpreting the result:**
- ✅ grads reach weights → LoRA fine-tuning with a render/geometry reward is viable
  (expect DRaFT-style *few-step truncated backprop* through the diffusion loop + checkpointing).
- ❌ grads vanish / loop is non-differentiable → fall back to the **corrector model**:
  train a small net `(Tripo gaussians + block-out) → per-object correction`, no Tripo
  internals or backprop-through-diffusion required. Uses the exact same Phase-0 ground truth.

## What's intentionally NOT here yet
The data engine (Phase 2), the loss module (Phase 3 — Chamfer/render reward), and the LoRA
training loop (Phase 4). Those come only after both probes above come back green.
