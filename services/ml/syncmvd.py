"""SyncMVD image generation.

Two paths, selected by --sync:
  0: per-view img2img + canny/depth ControlNets via the high-level diffusers pipeline
     (Phase 1 — no cross-view sync; validates the diffusers engine reproduces ComfyUI).
  1: a custom synchronized denoising loop (Phase 3) — every step the predicted clean
     image of all views is projected onto a shared voxel grid (geometry.py), averaged,
     and projected back, so the views agree. --sync-space=rgb (default) decodes x0 to
     full-res RGB and syncs in pixel space (accurate); =latent syncs the x0 latents at
     1/8 res (fast, fuzzy). DDIM scheduler so the x0 epsilon math holds.

Reads the same per-view inputs as the ComfyUI path (primitive_rgb + primitive_edges +
primitive_depth_control), plus camera.json + primitive_depth for the geometry.
"""

import argparse
import builtins
import gc
import importlib
import importlib.machinery
import importlib.util
import sys
import traceback
import types
import typing
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

FLASH_ATTN_MODULE_PREFIXES = (
    "flash_attn",
    "flash_attn_3",
    "flash_attn3",
    "flash_attn_interface",
)


def is_flash_attn_module(name):
    return any(name == prefix or name.startswith(prefix + ".") for prefix in FLASH_ATTN_MODULE_PREFIXES)


def is_flash_attn_stub(name):
    return name in {
        "flash_attn",
        "flash_attn.modules",
        "flash_attn.modules.mha",
    }


def disable_flash_attn_detection():
    """Force HF/diffusers to use PyTorch SDPA instead of optional flash-attn.

    Some RunPod PyTorch images ship FlashAttention 3/Hopper modules that register
    ops through torch.library.infer_schema with stringized annotations. That can
    make importing diffusers fail before the pipeline is even constructed. SD1.5
    ControlNet does not require flash-attn, so hide it from optional dependency
    probes and direct optional imports.
    """
    original_find_spec = importlib.util.find_spec
    original_import_module = importlib.import_module
    original_import = builtins.__import__

    visible = {
        name: bool(safe_find_spec(original_find_spec, name))
        for name in FLASH_ATTN_MODULE_PREFIXES
    }
    print(f"[syncmvd] disabling flash-attn modules {visible}", flush=True)
    install_flash_attn_stubs()

    def find_spec_without_flash_attn(name, *args, **kwargs):
        if is_flash_attn_module(name):
            return None
        return original_find_spec(name, *args, **kwargs)

    def import_module_without_flash_attn(name, package=None):
        if is_flash_attn_module(name) and not is_flash_attn_stub(name):
            raise ImportError(f"{name} disabled by WorldSketch")
        return original_import_module(name, package)

    def import_without_flash_attn(name, globals=None, locals=None, fromlist=(), level=0):
        if level == 0 and is_flash_attn_module(name) and not is_flash_attn_stub(name):
            raise ImportError(f"{name} disabled by WorldSketch")
        return original_import(name, globals, locals, fromlist, level)

    for name in list(sys.modules):
        if is_flash_attn_module(name) and not is_flash_attn_stub(name):
            del sys.modules[name]

    importlib.util.find_spec = find_spec_without_flash_attn
    importlib.import_module = import_module_without_flash_attn
    builtins.__import__ = import_without_flash_attn
    patch_torch_infer_schema_string_annotations()


def safe_find_spec(find_spec, name):
    try:
        return find_spec(name)
    except (ImportError, ValueError):
        return None


def install_flash_attn_stubs():
    flash_attn = types.ModuleType("flash_attn")
    modules = types.ModuleType("flash_attn.modules")
    mha = types.ModuleType("flash_attn.modules.mha")
    flash_attn.__path__ = []
    modules.__path__ = []
    flash_attn.__spec__ = importlib.machinery.ModuleSpec("flash_attn", loader=None, is_package=True)
    modules.__spec__ = importlib.machinery.ModuleSpec("flash_attn.modules", loader=None, is_package=True)
    mha.__spec__ = importlib.machinery.ModuleSpec("flash_attn.modules.mha", loader=None)
    mha.FlashCrossAttention = None
    mha.FlashSelfAttention = None
    flash_attn.modules = modules
    modules.mha = mha
    sys.modules["flash_attn"] = flash_attn
    sys.modules["flash_attn.modules"] = modules
    sys.modules["flash_attn.modules.mha"] = mha
    print("[syncmvd] installed flash_attn.modules.mha stub", flush=True)


def patch_torch_infer_schema_string_annotations():
    """Teach torch custom_op schema inference to handle future annotations.

    FA3 packages in some RunPod images define custom ops under
    `from __future__ import annotations`, so PyTorch 2.4 sees annotations like
    "torch.Tensor" instead of the `torch.Tensor` class and rejects them. Resolving
    those strings before the original schema inference runs avoids the import-time
    crash without changing any generated image behavior.
    """
    try:
        import torch._library.custom_ops as custom_ops
        import torch._library.infer_schema as infer_schema_module
    except Exception as exc:
        print(f"[syncmvd] torch schema patch skipped: {exc}", flush=True)
        return

    original = getattr(infer_schema_module, "_worldsketch_original_infer_schema", None)
    if original is None:
        original = infer_schema_module.infer_schema
        infer_schema_module._worldsketch_original_infer_schema = original

    namespace = {
        "torch": torch,
        "Tensor": torch.Tensor,
        "typing": typing,
        "Optional": typing.Optional,
        "Sequence": typing.Sequence,
        "List": typing.List,
        "Union": typing.Union,
        "Tuple": typing.Tuple,
    }

    def infer_schema_with_resolved_annotations(func, *args, **kwargs):
        annotations = getattr(func, "__annotations__", None)
        if annotations:
            for key, value in list(annotations.items()):
                if not isinstance(value, str):
                    continue
                try:
                    annotations[key] = eval(value, namespace)
                except Exception:
                    pass
        return original(func, *args, **kwargs)

    infer_schema_module.infer_schema = infer_schema_with_resolved_annotations
    if hasattr(custom_ops, "infer_schema"):
        custom_ops.infer_schema = infer_schema_with_resolved_annotations
    print("[syncmvd] patched torch custom_op schema annotations", flush=True)


def load_pipeline(args, device, dtype):
    import os

    # Cache HF downloads on the (persistent) volume so they survive cold starts.
    os.environ.setdefault("HF_HOME", str(Path(args.models).parent / "hf"))
    disable_flash_attn_detection()

    import diffusers
    import transformers
    print(f"[syncmvd] transformers {transformers.__version__} diffusers {diffusers.__version__}", flush=True)

    # diffusers 0.31 imports FLAX_WEIGHTS_NAME from transformers.utils, which newer
    # transformers dropped. Re-add the constant so the import works on any version.
    import transformers.utils as _tu
    if not hasattr(_tu, "FLAX_WEIGHTS_NAME"):
        _tu.FLAX_WEIGHTS_NAME = "flax_model.msgpack"

    try:
        from diffusers import (
            ControlNetModel,
            DDIMScheduler,
            StableDiffusionControlNetImg2ImgPipeline,
        )
    except Exception:
        print("[syncmvd] diffusers import failed with full traceback:", flush=True)
        traceback.print_exc()
        raise

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
    pipe.enable_attention_slicing()
    return pipe


def gather_views(job, size, latent):
    views = []
    for name in VIEW_NAMES:
        d = job / "views" / name
        if not (d / "primitive_rgb.png").exists():
            continue
        load = lambda p, n=size: Image.open(p).convert("RGB").resize((n, n), Image.Resampling.LANCZOS)
        depth_img = Image.open(d / "primitive_depth.png").convert("L")
        depth_small = depth_img.resize((latent, latent), Image.Resampling.NEAREST)
        depth_full = depth_img.resize((size, size), Image.Resampling.NEAREST)
        views.append({
            "name": name,
            "init": load(d / "primitive_rgb.png"),
            "edge": load(d / "primitive_edges.png"),
            "depth": load(d / "primitive_depth_control.png"),
            "depth_small": np.asarray(depth_small, np.float32) / 255.0,  # (latent, latent) — latent-space sync
            "depth_full": np.asarray(depth_full, np.float32) / 255.0,    # (size, size) — pixel-space sync
            "camera": json.loads((d / "camera.json").read_text()),
            "out": d / "generated_rgb.png",
        })
    return views


def run_per_view(pipe, views, args, generator):
    """Phase 1: independent per-view generation via the high-level pipeline."""
    for v in views:
        torch.cuda.empty_cache()
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


def _denoise_setup(pipe, views, args, generator, device, dtype):
    """Shared img2img setup for the synced loops: CFG embeds, init latents noised to the
    img2img start step, the canny/depth control conds, and the alphas_cumprod table."""
    n = len(views)

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
    return n, embeds, latents, timesteps, canny_cond, depth_cond, alphas


def _predict_x0(pipe, latents, t, embeds, canny_cond, depth_cond, alphas, args):
    """One UNet+ControlNet pass with CFG -> predicted clean latent x0, plus the
    sqrt(a) / sqrt(1-a) coefficients so the caller can re-derive epsilon after syncing."""
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

    a = alphas[t]
    sa, s1 = a ** 0.5, (1 - a) ** 0.5
    x0 = (latents - s1 * noise_pred) / sa
    return x0, sa, s1


def _decode_and_save(pipe, latents, views):
    images = pipe.vae.decode(latents / pipe.vae.config.scaling_factor, return_dict=False)[0]
    pils = pipe.image_processor.postprocess(images, output_type="pil")
    for v, p in zip(views, pils):
        p.save(v["out"])
        print(f"[syncmvd] {v['name']} saved", flush=True)


def _build_sync(views, depth_key, voxel):
    """Shared voxel index from the static per-view geometry. depth_key picks the
    resolution ('depth_small' for latent sync, 'depth_full' for pixel sync)."""
    from geometry import unproject, voxel_keys, VoxelSync

    keys, masks = [], []
    for v in views:
        world = unproject(v[depth_key], v["camera"])  # (R, R, 3)
        keys.append(voxel_keys(world, voxel))
        masks.append(v[depth_key] > 0.01)
    return VoxelSync(keys, masks)


def run_synced_latent(pipe, views, args, generator, device, dtype):
    """Latent-space sync (fast, fuzzy): voxel-average the x0 *latents* at 1/8 res.

    Cheap (no per-step VAE) but the 8x downsample blurs the consensus geometrically.
    """
    sync = _build_sync(views, "depth_small", args.sync_voxel)
    n, embeds, latents, timesteps, canny_cond, depth_cond, alphas = _denoise_setup(
        pipe, views, args, generator, device, dtype)

    for i, t in enumerate(timesteps):
        x0, sa, s1 = _predict_x0(pipe, latents, t, embeds, canny_cond, depth_cond, alphas, args)

        lam = _sync_lambda(i, len(timesteps), args)
        if lam > 0:
            x0_np = x0.float().permute(0, 2, 3, 1).cpu().numpy()  # (N, L, L, 4)
            consensus = sync.sync([x0_np[j] for j in range(n)])
            cons = torch.from_numpy(np.stack(consensus)).permute(0, 3, 1, 2).to(device, dtype)
            x0 = (1 - lam) * x0 + lam * cons

        # re-derive epsilon from the synced x0 and step
        noise_corr = (latents - sa * x0) / s1
        latents = pipe.scheduler.step(noise_corr, t, latents, return_dict=False)[0]
        print(f"[syncmvd] step {i + 1}/{len(timesteps)} lambda {lam:.2f} (latent)", flush=True)

    _decode_and_save(pipe, latents, views)


def run_synced_rgb(pipe, views, args, generator, device, dtype):
    """Phase 3 (accurate): decode x0 -> full-res RGB, voxel-average in pixel space,
    re-encode. Per synced step: predict x0 latents -> VAE-decode to RGB -> unproject all
    views onto a shared voxel grid -> average -> reproject -> blend the consensus into
    each view's RGB with lambda_t -> VAE-encode back to x0. Pixel-space sync avoids the
    8x latent fuzz of run_synced_latent at the cost of a decode+encode each synced step;
    --sync-interval k limits that to every k-th step.
    """
    sync = _build_sync(views, "depth_full", args.sync_voxel)
    n, embeds, latents, timesteps, canny_cond, depth_cond, alphas = _denoise_setup(
        pipe, views, args, generator, device, dtype)
    scaling = pipe.vae.config.scaling_factor
    interval = max(args.sync_interval, 1)

    for i, t in enumerate(timesteps):
        x0, sa, s1 = _predict_x0(pipe, latents, t, embeds, canny_cond, depth_cond, alphas, args)

        lam = _sync_lambda(i, len(timesteps), args)
        synced = lam > 0 and i % interval == 0
        if synced:
            imgs = pipe.vae.decode(x0 / scaling, return_dict=False)[0]   # (N, 3, H, W) in [-1, 1]
            imgs_np = imgs.float().permute(0, 2, 3, 1).cpu().numpy()     # (N, H, W, 3)
            consensus = sync.sync([imgs_np[j] for j in range(n)])
            cons = torch.from_numpy(np.stack(consensus)).permute(0, 3, 1, 2).to(device, dtype)
            blended = (1 - lam) * imgs + lam * cons
            # mode() (the distribution mean) re-encodes deterministically — no sampling noise.
            x0 = pipe.vae.encode(blended).latent_dist.mode() * scaling

        # re-derive epsilon from the (possibly synced) x0 and step
        noise_corr = (latents - sa * x0) / s1
        latents = pipe.scheduler.step(noise_corr, t, latents, return_dict=False)[0]
        tag = "rgb" if synced else "rgb-skip"
        print(f"[syncmvd] step {i + 1}/{len(timesteps)} lambda {lam:.2f} ({tag})", flush=True)

    _decode_and_save(pipe, latents, views)


def run_synced(pipe, views, args, generator, device, dtype):
    """Synchronized denoising loop. Pixel-space (accurate) by default; latent-space
    (fast, fuzzy) when --sync-space=latent."""
    if args.sync_space == "latent":
        run_synced_latent(pipe, views, args, generator, device, dtype)
    else:
        run_synced_rgb(pipe, views, args, generator, device, dtype)


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
        try:
            run_synced(pipe, views, args, generator, device, dtype)
        except torch.OutOfMemoryError:
            print("[syncmvd] synced generation OOM; retrying per-view fallback", flush=True)
            gc.collect()
            torch.cuda.empty_cache()
            run_per_view(pipe, views, args, generator)


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
    p.add_argument("--sync-space", default="rgb", choices=["rgb", "latent"], dest="sync_space")
    p.add_argument("--sync-interval", type=int, default=1, dest="sync_interval")  # rgb: sync every k steps
    p.add_argument("--sync-weight", type=float, default=1.0, dest="sync_weight")
    p.add_argument("--sync-voxel", type=float, default=0.25, dest="sync_voxel")
    p.add_argument("--sync-taper", type=float, default=0.7, dest="sync_taper")
    return p.parse_args()


if __name__ == "__main__":
    raise SystemExit(main())
