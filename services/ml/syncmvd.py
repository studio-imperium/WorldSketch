"""SyncMVD image generation.

Two paths, selected by --sync:
  0: per-view img2img + canny/depth ControlNets via the high-level diffusers pipeline
     (Phase 1 — no cross-view sync; validates the diffusers engine reproduces ComfyUI).
  1: a custom synchronized denoising loop (Phase 3) — every step, the predicted clean
     latent of all views is projected onto a shared voxel grid (geometry.py), averaged,
     and projected back, so the views agree. Latent-space sync (no per-step VAE), DDIM.

Reads the same per-view inputs as the ComfyUI path (primitive_rgb + primitive_edges +
primitive_depth_control), plus camera.json + primitive_depth for the geometry.
"""

import argparse
from pathlib import Path

import numpy as np
import torch
from PIL import Image

import json

VIEW_NAMES = ["front", "back", "left", "right", "top", "corner_fl", "corner_fr", "corner_bl", "corner_br"]

NEGATIVE = (
    "black background, darkness, night, galaxy, stars, abstract noise, empty image, "
    "blank image, hard shadows, cast shadows, directional sunlight, dramatic lighting, "
    "rim light, baked lighting, dark shading, high contrast lighting, spotlight, sunset, "
    "text, watermark, blurry, people"
)


def load_pipeline(args, device, dtype):
    import os

    # Cache HF downloads on the (persistent) volume so they survive cold starts.
    os.environ.setdefault("HF_HOME", str(Path(args.models).parent / "hf"))

    import diffusers
    import transformers
    print(f"[syncmvd] transformers {transformers.__version__} diffusers {diffusers.__version__}", flush=True)

    # diffusers 0.31 imports FLAX_WEIGHTS_NAME from transformers.utils, which newer
    # transformers dropped. Re-add the constant so the import works on any version.
    import transformers.utils as _tu
    if not hasattr(_tu, "FLAX_WEIGHTS_NAME"):
        _tu.FLAX_WEIGHTS_NAME = "flax_model.msgpack"

    from diffusers import (
        ControlNetModel,
        DDIMScheduler,
        StableDiffusionControlNetImg2ImgPipeline,
    )

    models = Path(args.models)
    canny = ControlNetModel.from_single_file(
        str(models / "controlnet" / "control_v11p_sd15_canny.pth"), torch_dtype=dtype
    )
    depth = ControlNetModel.from_single_file(
        str(models / "controlnet" / "control_v11f1p_sd15_depth.pth"), torch_dtype=dtype
    )

    # Prefer the single-file checkpoint on the volume; its LDM->diffusers CLIP conversion
    # is fragile, so fall back to the diffusers-format repo (downloaded + cached) if it fails.
    try:
        pipe = StableDiffusionControlNetImg2ImgPipeline.from_single_file(
            str(models / "checkpoints" / args.checkpoint),
            controlnet=[canny, depth], torch_dtype=dtype, safety_checker=None,
        ).to(device)
    except Exception as exc:
        print(f"[syncmvd] from_single_file failed ({exc}); using {args.base_model}", flush=True)
        pipe = StableDiffusionControlNetImg2ImgPipeline.from_pretrained(
            args.base_model, controlnet=[canny, depth], torch_dtype=dtype, safety_checker=None,
        ).to(device)

    # DDIM gives integer timesteps + epsilon prediction, which the sync loop's x0 math
    # relies on (alphas_cumprod[t]).
    pipe.scheduler = DDIMScheduler.from_config(pipe.scheduler.config)
    pipe.set_progress_bar_config(disable=True)
    return pipe


def gather_views(job, size, latent):
    views = []
    for name in VIEW_NAMES:
        d = job / "views" / name
        if not (d / "primitive_rgb.png").exists():
            continue
        load = lambda p, n=size: Image.open(p).convert("RGB").resize((n, n), Image.Resampling.LANCZOS)
        depth_small = Image.open(d / "primitive_depth.png").convert("L").resize(
            (latent, latent), Image.Resampling.NEAREST
        )
        views.append({
            "name": name,
            "init": load(d / "primitive_rgb.png"),
            "edge": load(d / "primitive_edges.png"),
            "depth": load(d / "primitive_depth_control.png"),
            "depth_small": np.asarray(depth_small, np.float32) / 255.0,  # (latent, latent)
            "camera": json.loads((d / "camera.json").read_text()),
            "out": d / "generated_rgb.png",
        })
    return views


def run_per_view(pipe, views, args, generator):
    """Phase 1: independent per-view generation via the high-level pipeline."""
    for v in views:
        img = pipe(
            prompt=args.prompt,
            negative_prompt=NEGATIVE,
            image=v["init"],
            control_image=[v["edge"], v["depth"]],
            strength=args.denoise,
            num_inference_steps=args.steps,
            guidance_scale=args.cfg,
            controlnet_conditioning_scale=[args.canny, args.depth_scale],
            generator=generator,
        ).images[0]
        img.save(v["out"])
        print(f"[syncmvd] {v['name']} done (no-sync)", flush=True)


def _control_cond(pils, device, dtype):
    """PIL list -> (2N, 3, H, W) in [0,1], duplicated for classifier-free guidance."""
    arr = np.stack([np.asarray(p, np.float32) / 255.0 for p in pils])  # (N,H,W,3)
    t = torch.from_numpy(arr).permute(0, 3, 1, 2).to(device, dtype)
    return torch.cat([t, t])


def _sync_lambda(step, total, args):
    p = step / max(total - 1, 1)
    if p < args.sync_taper:
        return args.sync_weight
    return args.sync_weight * max(0.0, 1.0 - (p - args.sync_taper) / (1.0 - args.sync_taper))


def run_synced(pipe, views, args, generator, device, dtype):
    """Phase 3: synchronized denoising loop in latent space."""
    from geometry import unproject, voxel_keys, VoxelSync

    n = len(views)
    latent = args.size // 8

    # Shared voxel index from the (static) per-view geometry at latent resolution.
    keys, masks = [], []
    for v in views:
        world = unproject(v["depth_small"], v["camera"])  # (latent, latent, 3)
        keys.append(voxel_keys(world, args.sync_voxel))
        masks.append(v["depth_small"] > 0.01)
    sync = VoxelSync(keys, masks)

    # Prompt embeds (CFG): [neg]*N then [pos]*N.
    pos, neg = pipe.encode_prompt(args.prompt, device, 1, True, NEGATIVE)
    embeds = torch.cat([neg.repeat(n, 1, 1), pos.repeat(n, 1, 1)]).to(dtype)

    # img2img init latents.
    init = pipe.image_processor.preprocess([v["init"] for v in views]).to(device, dtype)
    init_lat = pipe.vae.encode(init).latent_dist.sample(generator) * pipe.vae.config.scaling_factor

    pipe.scheduler.set_timesteps(args.steps, device=device)
    start = max(args.steps - min(int(args.steps * args.denoise), args.steps), 0)
    timesteps = pipe.scheduler.timesteps[start:]
    noise = torch.randn(init_lat.shape, generator=generator, device=device, dtype=dtype)
    latents = pipe.scheduler.add_noise(init_lat, noise, timesteps[:1])

    canny_cond = _control_cond([v["edge"] for v in views], device, dtype)
    depth_cond = _control_cond([v["depth"] for v in views], device, dtype)
    alphas = pipe.scheduler.alphas_cumprod.to(device)

    for i, t in enumerate(timesteps):
        lmi = pipe.scheduler.scale_model_input(torch.cat([latents, latents]), t)
        down, mid = pipe.controlnet(
            lmi, t, encoder_hidden_states=embeds,
            controlnet_cond=[canny_cond, depth_cond],
            conditioning_scale=[args.canny, args.depth_scale],
            guess_mode=False, return_dict=False,
        )
        noise_pred = pipe.unet(
            lmi, t, encoder_hidden_states=embeds,
            down_block_additional_residuals=down,
            mid_block_additional_residual=mid,
            return_dict=False,
        )[0]
        uncond, text = noise_pred.chunk(2)
        noise_pred = uncond + args.cfg * (text - uncond)

        # predicted clean latent (epsilon -> x0)
        a = alphas[t]
        sa, s1 = a ** 0.5, (1 - a) ** 0.5
        x0 = (latents - s1 * noise_pred) / sa

        lam = _sync_lambda(i, len(timesteps), args)
        if lam > 0:
            x0_np = x0.float().permute(0, 2, 3, 1).cpu().numpy()  # (N, L, L, 4)
            consensus = sync.sync([x0_np[j] for j in range(n)])
            cons = torch.from_numpy(np.stack(consensus)).permute(0, 3, 1, 2).to(device, dtype)
            x0 = (1 - lam) * x0 + lam * cons

        # re-derive epsilon from the synced x0 and step
        noise_corr = (latents - sa * x0) / s1
        latents = pipe.scheduler.step(noise_corr, t, latents, return_dict=False)[0]
        print(f"[syncmvd] step {i + 1}/{len(timesteps)} lambda {lam:.2f}", flush=True)

    images = pipe.vae.decode(latents / pipe.vae.config.scaling_factor, return_dict=False)[0]
    pils = pipe.image_processor.postprocess(images, output_type="pil")
    for v, p in zip(views, pils):
        p.save(v["out"])
        print(f"[syncmvd] {v['name']} saved", flush=True)


def main():
    args = parse_args()
    job = Path(args.job_dir)
    if not torch.cuda.is_available():
        raise SystemExit("syncmvd requires CUDA")

    device, dtype = "cuda", torch.float16
    pipe = load_pipeline(args, device, dtype)
    views = gather_views(job, args.size, args.size // 8)
    if not views:
        raise SystemExit("no views found")
    generator = torch.Generator(device=device).manual_seed(args.seed)

    if args.sync <= 0:
        run_per_view(pipe, views, args, generator)
    else:
        run_synced(pipe, views, args, generator, device, dtype)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("job_dir")
    p.add_argument("--prompt", required=True)
    p.add_argument("--models", default="/runpod-volume/models")
    p.add_argument("--checkpoint", default="DreamShaper_8_pruned.safetensors")
    p.add_argument("--base-model", default="Lykon/dreamshaper-8", dest="base_model")
    p.add_argument("--size", type=int, default=512)
    p.add_argument("--steps", type=int, default=7)
    p.add_argument("--denoise", type=float, default=0.5)
    p.add_argument("--cfg", type=float, default=6.5)
    p.add_argument("--canny", type=float, default=0.9)
    p.add_argument("--depth-scale", type=float, default=0.6, dest="depth_scale")
    p.add_argument("--seed", type=int, default=1125899906842624)
    # sync controls
    p.add_argument("--sync", type=int, default=1)            # 0 = per-view (Phase 1)
    p.add_argument("--sync-weight", type=float, default=1.0, dest="sync_weight")
    p.add_argument("--sync-voxel", type=float, default=0.25, dest="sync_voxel")
    p.add_argument("--sync-taper", type=float, default=0.7, dest="sync_taper")
    return p.parse_args()


if __name__ == "__main__":
    raise SystemExit(main())
