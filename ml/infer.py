"""infer.py — drive TripoSplat from Python and answer the GO/NO-GO question:
can we get gradients of the output gaussians back to weights we could LoRA?

TripoSplat is a *diffusion* pipeline (DINOv3 conditioning + a diffusion transformer +
a VAE decoder + birefnet bg-removal), not a single feed-forward net. So "fine-tuning
possible?" really means "can we backprop through the sampling loop + decoder to the
transformer weights?". Inference almost certainly runs under torch.no_grad(), so the
honest check is: reproduce inference (sanity), map the modules (find LoRA targets), and
probe whether a differentiable path to the gaussians exists.

This is meant to run ON THE GPU BOX where the TripoSplat repo + checkpoints live.

  # 1. clone + install per the repo, download ckpts, then:
  export TRIPOSPLAT_REPO=/path/to/TripoSplat
  export TRIPOSPLAT_CKPTS=/path/to/TripoSplat/ckpts

  python infer.py reproduce --image guide.png --out out.splat   # sanity vs the server
  python infer.py inspect                                        # module tree + LoRA targets
  python infer.py grad-check --image guide.png                  # the GO/NO-GO probe

The exact attribute names inside the pipeline are unknown until you clone it, so
`inspect` auto-discovers the submodule tree and `grad-check` reports precisely what
blocks the gradient (no_grad context, a non-differentiable op, numpy in the loop, ...).
Fill the TODOs in `differentiable_run()` once `inspect` shows the real names.
"""

from __future__ import annotations

import argparse
import os
import sys


def _add_repo_to_path():
    repo = os.environ.get("TRIPOSPLAT_REPO")
    if repo and repo not in sys.path:
        sys.path.insert(0, repo)
    return repo


def _ckpt_paths():
    """Default ckpt layout from the repo README; override via TRIPOSPLAT_CKPTS."""
    root = os.environ.get("TRIPOSPLAT_CKPTS", "ckpts")
    j = os.path.join
    return dict(
        ckpt_path=j(root, "diffusion_models", "triposplat_fp16.safetensors"),
        decoder_path=j(root, "vae", "triposplat_vae_decoder_fp16.safetensors"),
        dinov3_path=j(root, "clip_vision", "dino_v3_vit_h.safetensors"),
        flux2_vae_encoder_path=j(root, "vae", "flux2-vae.safetensors"),
        rmbg_path=j(root, "background_removal", "birefnet.safetensors"),
    )


def load_pipeline(device: str = "cuda"):
    _add_repo_to_path()
    from triposplat import TripoSplatPipeline  # noqa: E402  (repo must be on PYTHONPATH)

    return TripoSplatPipeline(device=device, **_ckpt_paths())


# --------------------------------------------------------------------------------------
# reproduce: run a normal inference and dump a .splat. Diff this against the server's
# output on the same input to prove we're driving the model correctly.
# --------------------------------------------------------------------------------------

def cmd_reproduce(args):
    pipe = load_pipeline(args.device)
    gaussian, prepared = pipe.run(args.image, num_gaussians=args.num_gaussians, show_progress=True)
    gaussian.save_splat(args.out)
    if args.save_prepared:
        prepared.save(args.save_prepared)
    print(f"wrote {args.out}")


# --------------------------------------------------------------------------------------
# inspect: walk the pipeline's nn.Modules. Prints the tree, parameter counts, and the
# Linear layers most likely worth LoRA-ing (attention/MLP projections in the transformer).
# --------------------------------------------------------------------------------------

def cmd_inspect(args):
    import torch  # noqa
    import torch.nn as nn

    pipe = load_pipeline(args.device)

    # Discover nn.Module attributes hanging off the pipeline object.
    modules = {name: m for name, m in vars(pipe).items() if isinstance(m, nn.Module)}
    if not modules:
        print("No nn.Module attributes found directly on the pipeline; dumping all attrs:")
        for k, v in vars(pipe).items():
            print(f"  {k}: {type(v).__name__}")
        return

    total = 0
    for name, m in modules.items():
        n = sum(p.numel() for p in m.parameters())
        total += n
        print(f"\n=== component: {name}  ({type(m).__name__}, {n/1e6:.1f}M params) ===")
        # one level of children for orientation
        for cname, child in m.named_children():
            cn = sum(p.numel() for p in child.parameters())
            print(f"    {cname:<28} {type(child).__name__:<24} {cn/1e6:7.2f}M")

    print(f"\nTOTAL params across components: {total/1e6:.1f}M")

    # LoRA candidates: Linear layers whose names look like attention/MLP projections.
    print("\n--- LoRA candidate Linear layers (by name pattern) ---")
    pat = ("to_q", "to_k", "to_v", "to_out", "q_proj", "k_proj", "v_proj", "o_proj",
           "qkv", "proj", "fc1", "fc2", "mlp", "linear")
    seen = {}
    for comp, m in modules.items():
        for lname, layer in m.named_modules():
            if isinstance(layer, nn.Linear) and any(p in lname.lower() for p in pat):
                key = lname.split(".")[-1]
                seen[key] = seen.get(key, 0) + 1
    for key, count in sorted(seen.items(), key=lambda kv: -kv[1]):
        print(f"    {key:<16} x{count}")
    print("\nPick the transformer's attention/MLP projections above as LoRA targets.")


# --------------------------------------------------------------------------------------
# grad-check: the GO/NO-GO probe. Does a differentiable path from output gaussians to
# trainable weights exist? First we detect whether `pipe.run` returns grad-tracked
# tensors (it usually won't — inference wraps no_grad). Then we attempt a manual,
# grad-enabled forward via `differentiable_run` and backprop a trivial loss.
# --------------------------------------------------------------------------------------

def cmd_grad_check(args):
    import torch

    pipe = load_pipeline(args.device)

    # (1) Does the public API even keep gradients?
    with torch.enable_grad():
        gaussian, _ = pipe.run(args.image, num_gaussians=args.num_gaussians, show_progress=False)
    xyz = _gaussian_xyz(gaussian)
    print(f"output gaussian xyz: shape={tuple(xyz.shape)}, requires_grad={xyz.requires_grad}, "
          f"grad_fn={xyz.grad_fn}")
    if xyz.requires_grad:
        print("✅ public pipe.run() keeps gradients — you can backprop the reward directly.")
    else:
        print("⚠️  pipe.run() detaches (inference runs under no_grad). Need a manual grad path.")

    # (2) Manual grad path (fill differentiable_run after `inspect`).
    try:
        xyz2, params = differentiable_run(pipe, args.image, num_gaussians=args.num_gaussians,
                                          n_steps=args.n_steps)
    except NotImplementedError as e:
        print(f"\nmanual grad path not wired yet: {e}")
        print("Run `inspect` first, then fill differentiable_run() with the real module calls.")
        return

    loss = xyz2.float().pow(2).mean()  # trivial reward stand-in
    loss.backward()
    got = [(n, float(p.grad.abs().mean())) for n, p in params if p.grad is not None]
    print(f"\nbackward ok. params receiving gradient: {len(got)}/{len(params)}")
    for n, g in got[:8]:
        print(f"    {n:<40} |grad|={g:.3e}")
    if got:
        print("\n✅ GO: gradients reach trainable weights — LoRA fine-tuning is viable.")
    else:
        print("\n❌ NO-GO via this path — gradients vanish. Inspect the loop for a "
              "non-differentiable op (argmax, .detach(), numpy, quantization).")


def _gaussian_xyz(gaussian):
    """Best-effort extraction of the (N,3) center tensor from the returned Gaussian obj.

    The attribute name is repo-specific; try the common ones, else raise with a hint.
    """
    import torch
    for attr in ("xyz", "means", "positions", "_xyz", "centers", "mean"):
        v = getattr(gaussian, attr, None)
        if isinstance(v, torch.Tensor):
            return v
    raise AttributeError(
        "couldn't find the centers tensor on the Gaussian object — inspect it with "
        "`vars(gaussian).keys()` and add the attribute name to _gaussian_xyz()."
    )


def differentiable_run(pipe, image, num_gaussians, n_steps=4):
    """Run the diffusion sampling + decode WITH autograd enabled, returning the output
    gaussian centers (grad-tracked) and the list of (name, param) you intend to train.

    This is the surgery the GO/NO-GO depends on. After `inspect` reveals the real names,
    wire it up roughly as:

        cond = pipe.dinov3(preprocess(image))               # image conditioning
        x = torch.randn(latent_shape, device=..., requires_grad=False)
        for t in schedule[:n_steps]:                         # few-step, grad-enabled loop
            x = sampler_step(pipe.transformer, x, t, cond)   # keep grad; checkpoint to save mem
        gauss = pipe.decoder(x, num_gaussians)               # VAE decode -> gaussians
        return gauss.xyz, [(n, p) for n, p in pipe.transformer.named_parameters()]

    Notes:
      - Backprop through many denoising steps is memory-heavy: use a FEW steps
        (DRaFT-style truncated backprop) and/or torch.utils.checkpoint per step.
      - Freeze the base; only the params you return (ideally LoRA-wrapped) need grad.
    """
    raise NotImplementedError(
        "wire the manual diffusion loop + decoder here using the module names from `inspect`"
    )


def main():
    ap = argparse.ArgumentParser(description="TripoSplat python harness + differentiability probe")
    ap.add_argument("--device", default="cuda")
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("reproduce", help="run a normal inference -> .splat (sanity vs server)")
    r.add_argument("--image", required=True)
    r.add_argument("--out", default="out.splat")
    r.add_argument("--save-prepared", default=None, help="also save the preprocessed image")
    r.add_argument("--num-gaussians", type=int, default=32768)
    r.set_defaults(func=cmd_reproduce)

    i = sub.add_parser("inspect", help="print module tree + LoRA candidate layers")
    i.set_defaults(func=cmd_inspect)

    g = sub.add_parser("grad-check", help="GO/NO-GO: can gradients reach trainable weights?")
    g.add_argument("--image", required=True)
    g.add_argument("--num-gaussians", type=int, default=32768)
    g.add_argument("--n-steps", type=int, default=4, help="few-step truncated backprop depth")
    g.set_defaults(func=cmd_grad_check)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
