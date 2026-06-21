"""SyncMVD image generation — Phase 1 scaffold.

A from-scratch `diffusers` replacement for the ComfyUI image-gen stage: batched
img2img + canny & depth ControlNets, writing generated_rgb.png per view. NO cross-view
sync yet — the goal of this phase is just to reproduce the ComfyUI output via diffusers,
so the custom synchronized loop (Phase 3) has a verified base to build on.

Invoked by the Go pipeline (RunSyncMVD) like train_splat.py. Reads the same per-view
inputs the ComfyUI path uses (primitive_rgb + primitive_edges + primitive_depth_control).
"""

import argparse
from pathlib import Path

import torch
from PIL import Image

VIEW_NAMES = ["front", "back", "left", "right", "top", "corner_fl", "corner_fr", "corner_bl", "corner_br"]

# Mirrors comfy.go's negative prompt (positive is passed in via --prompt).
NEGATIVE = (
    "black background, darkness, night, galaxy, stars, abstract noise, empty image, "
    "blank image, hard shadows, cast shadows, directional sunlight, dramatic lighting, "
    "rim light, baked lighting, dark shading, high contrast lighting, spotlight, sunset, "
    "text, watermark, blurry, people"
)


def main():
    args = parse_args()
    job = Path(args.job_dir)

    if not torch.cuda.is_available():
        raise SystemExit("syncmvd requires CUDA")

    from diffusers import (
        ControlNetModel,
        MultiControlNetModel,
        StableDiffusionControlNetImg2ImgPipeline,
    )

    device = "cuda"
    dtype = torch.float16
    models = Path(args.models)

    canny = ControlNetModel.from_single_file(
        str(models / "controlnet" / "control_v11p_sd15_canny.pth"), torch_dtype=dtype
    )
    depth = ControlNetModel.from_single_file(
        str(models / "controlnet" / "control_v11f1p_sd15_depth.pth"), torch_dtype=dtype
    )
    pipe = StableDiffusionControlNetImg2ImgPipeline.from_single_file(
        str(models / "checkpoints" / args.checkpoint),
        controlnet=MultiControlNetModel([canny, depth]),
        torch_dtype=dtype,
        safety_checker=None,
    ).to(device)
    pipe.set_progress_bar_config(disable=True)

    size = (args.size, args.size)

    def load(path):
        return Image.open(path).convert("RGB").resize(size, Image.Resampling.LANCZOS)

    generator = torch.Generator(device=device).manual_seed(args.seed)

    for name in VIEW_NAMES:
        view = job / "views" / name
        if not (view / "primitive_rgb.png").exists():
            continue

        init = load(view / "primitive_rgb.png")
        edge = load(view / "primitive_edges.png")
        depth_hint = load(view / "primitive_depth_control.png")

        result = pipe(
            prompt=args.prompt,
            negative_prompt=NEGATIVE,
            image=init,
            control_image=[edge, depth_hint],
            strength=args.denoise,
            num_inference_steps=args.steps,
            guidance_scale=args.cfg,
            controlnet_conditioning_scale=[args.canny, args.depth],
            generator=generator,
        ).images[0]

        result.save(view / "generated_rgb.png")
        print(f"[syncmvd] {name} done", flush=True)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("job_dir")
    p.add_argument("--prompt", required=True)
    p.add_argument("--models", default="/runpod-volume/models")
    p.add_argument("--checkpoint", default="DreamShaper_8_pruned.safetensors")
    p.add_argument("--size", type=int, default=512)
    p.add_argument("--steps", type=int, default=7)
    p.add_argument("--denoise", type=float, default=0.5)
    p.add_argument("--cfg", type=float, default=6.5)
    p.add_argument("--canny", type=float, default=0.9)
    p.add_argument("--depth", type=float, default=0.6)
    p.add_argument("--seed", type=int, default=1125899906842624)
    return p.parse_args()


if __name__ == "__main__":
    raise SystemExit(main())
