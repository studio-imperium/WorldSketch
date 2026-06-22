import argparse
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image


VIEW_NAMES = [
    "front",
    "back",
    "left",
    "right",
    "top",
    "corner_fl_high",
    "corner_fr_high",
    "corner_bl_high",
    "corner_br_high",
    "corner_fl_low",
    "corner_fr_low",
    "corner_bl_low",
    "corner_br_low",
]


def make_optimizer(params, args):
    means, raw_colors, log_scales, opacity_logits, raw_quats = params
    return torch.optim.Adam(
        [
            {"params": [means], "lr": args.position_lr},
            {"params": [raw_colors], "lr": args.color_lr},
            {"params": [log_scales, opacity_logits, raw_quats], "lr": args.shape_lr},
        ]
    )


def make_ssim_window(size, sigma, channels, device):
    coords = torch.arange(size, dtype=torch.float32, device=device) - (size - 1) / 2.0
    g = torch.exp(-(coords ** 2) / (2.0 * sigma ** 2))
    g = g / g.sum()
    window = g[:, None] * g[None, :]
    return window.expand(channels, 1, size, size).contiguous()


def ssim(a, b, window):
    # a, b: (1, C, H, W). Returns mean structural similarity in [-1, 1].
    channels = a.shape[1]
    pad = window.shape[-1] // 2
    mu_a = F.conv2d(a, window, padding=pad, groups=channels)
    mu_b = F.conv2d(b, window, padding=pad, groups=channels)
    mu_a2, mu_b2, mu_ab = mu_a * mu_a, mu_b * mu_b, mu_a * mu_b
    var_a = F.conv2d(a * a, window, padding=pad, groups=channels) - mu_a2
    var_b = F.conv2d(b * b, window, padding=pad, groups=channels) - mu_b2
    cov = F.conv2d(a * b, window, padding=pad, groups=channels) - mu_ab
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    smap = ((2 * mu_ab + c1) * (2 * cov + c2)) / ((mu_a2 + mu_b2 + c1) * (var_a + var_b + c2))
    return smap.mean()


def densify_and_prune(tensors, avg_grad, args, densify=True):
    """Prune transparent/needle gaussians, then clone/split the highest-gradient
    survivors (the under-reconstructed regions). Returns plain detached tensors."""
    means, raw_colors, log_scales, opacity_logits, raw_quats = (t.detach() for t in tensors)
    device = means.device

    scales = log_scales.exp().clamp(0.002, args.max_scale)
    opacity = torch.sigmoid(opacity_logits)
    ratio = scales.max(dim=-1).values / scales.min(dim=-1).values.clamp_min(1e-6)
    keep = (opacity >= args.prune_opacity) & (ratio <= args.prune_aniso)

    means, raw_colors, log_scales = means[keep], raw_colors[keep], log_scales[keep]
    opacity_logits, raw_quats = opacity_logits[keep], raw_quats[keep]
    scales, grad = scales[keep], avg_grad[keep]
    survivors = means.shape[0]

    room = args.max_points - survivors
    if densify and survivors > 0 and room > 0:
        budget = min(room, int(survivors * args.densify_frac) + 1)
        chosen = torch.topk(grad, min(budget, survivors)).indices
        selected = torch.zeros(survivors, dtype=torch.bool, device=device)
        selected[chosen] = True
        large = scales.max(dim=-1).values > args.densify_scale
        clone = selected & ~large   # small + high error -> duplicate
        split = selected & large    # large + high error -> replace with 2 smaller children

        m = [means[~split]]
        c = [raw_colors[~split]]
        ls = [log_scales[~split]]
        ol = [opacity_logits[~split]]
        q = [raw_quats[~split]]

        if bool(clone.any()):
            m.append(means[clone]); c.append(raw_colors[clone]); ls.append(log_scales[clone])
            ol.append(opacity_logits[clone]); q.append(raw_quats[clone])

        if bool(split.any()):
            child_log = log_scales[split] - math.log(1.6)
            child_scale = child_log.exp()
            for _ in range(2):
                jitter = torch.randn(child_scale.shape, device=device) * child_scale
                m.append(means[split] + jitter); c.append(raw_colors[split]); ls.append(child_log)
                ol.append(opacity_logits[split]); q.append(raw_quats[split])

        means, raw_colors = torch.cat(m), torch.cat(c)
        log_scales, opacity_logits, raw_quats = torch.cat(ls), torch.cat(ol), torch.cat(q)

    return [means, raw_colors, log_scales, opacity_logits, raw_quats]


def main():
    args = parse_args()
    job_dir = Path(args.job_dir)

    if not torch.cuda.is_available():
        raise SystemExit(
            "gsplat training requires CUDA. This Mac can prepare the training bundle, "
            "but gsplat's rasterizer is disabled on MPS/CPU."
        )

    try:
        from gsplat.rendering import rasterization
    except Exception as exc:
        raise SystemExit(f"gsplat import failed: {exc}") from exc

    device = torch.device("cuda")
    views = load_views(job_dir, args.size, args.min_target_luma, args.min_valid_ratio, args.mask_erode, device)
    points, colors = load_ply(job_dir / "world.ply", args.min_point_luma)
    if len(points) == 0:
        raise SystemExit("no usable points after dark point filtering")
    # Default the gaussian budget to the projected point count, so it tracks the
    # terrain size automatically and never needs hand-tuning.
    if args.max_points <= 0:
        args.max_points = len(points)
        print(f"max-points auto: using all {len(points)} projected points", flush=True)
    points, colors = subsample(points, colors, args.max_points)

    means = torch.nn.Parameter(torch.tensor(points, dtype=torch.float32, device=device))
    raw_colors = torch.nn.Parameter(logit(torch.tensor(colors, dtype=torch.float32, device=device)))
    log_scales = torch.nn.Parameter(init_log_scales(points, device))
    opacity_logits = torch.nn.Parameter(torch.full((len(points),), args.opacity_init, dtype=torch.float32, device=device))
    raw_quats = torch.nn.Parameter(torch.tensor([[1.0, 0.0, 0.0, 0.0]], dtype=torch.float32, device=device).repeat(len(points), 1))

    optimizer = make_optimizer([means, raw_colors, log_scales, opacity_logits, raw_quats], args)
    ssim_window = make_ssim_window(11, 1.5, 3, device)
    grad_accum = torch.zeros(means.shape[0], device=device)
    grad_steps = 0

    # Neutral training background. Combined with the background-opacity loss below
    # this keeps stray gaussians from being rewarded for painting the (white) sky.
    background = torch.tensor([0.5, 0.5, 0.5], dtype=torch.float32, device=device)
    for step in range(args.steps):
        # Exponential decay of the position LR so it sharpens late instead of jittering.
        progress = step / max(args.steps - 1, 1)
        optimizer.param_groups[0]["lr"] = args.position_lr * (args.position_lr_final / args.position_lr) ** progress

        view = views[step % len(views)]
        quats = F.normalize(raw_quats, dim=-1)
        scales = log_scales.exp().clamp(0.002, args.max_scale)
        opacities = torch.sigmoid(opacity_logits)
        render, render_alpha, _ = rasterization(
            means,
            quats,
            scales,
            opacities,
            torch.sigmoid(raw_colors),
            view["viewmat"],
            view["K"],
            args.size,
            args.size,
            near_plane=0.03,
            far_plane=80.0,
            backgrounds=background[None],
            render_mode="RGB",
            packed=False,
            rasterize_mode="classic",
        )

        pred = render[0]
        alpha = render_alpha[0]
        target = view["image"]
        mask = view["mask"]
        inv_mask = 1.0 - mask

        # Object color: L1 + D-SSIM, both restricted to the object. For SSIM we
        # composite pred and target over the same background so only the object
        # drives the structural term (no penalty for the unsupervised region).
        obj_l1 = ((pred - target).abs() * mask).sum() / mask.sum().clamp_min(1.0)
        comp_pred = (pred * mask + background * inv_mask).permute(2, 0, 1).unsqueeze(0)
        comp_target = (target * mask + background * inv_mask).permute(2, 0, 1).unsqueeze(0)
        dssim = 1.0 - ssim(comp_pred, comp_target, ssim_window)
        color_loss = (1.0 - args.ssim_weight) * obj_l1 + args.ssim_weight * dssim

        # Drive accumulated opacity to zero outside the mask so floaters over the
        # background can no longer hide in the unsupervised region.
        bg_loss = (alpha * inv_mask).sum() / inv_mask.sum().clamp_min(1.0)

        # Penalize needle-shaped gaussians (the white spikes) by their axis ratio.
        smax = scales.max(dim=-1).values
        smin = scales.min(dim=-1).values.clamp_min(1e-6)
        aniso_loss = (smax / smin - 1.0).mean()

        loss = (
            color_loss
            + args.bg_weight * bg_loss
            + args.scale_reg * scales.mean()
            + args.opacity_reg * opacities.mean()
            + args.aniso_reg * aniso_loss
        )

        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

        if step % 25 == 0 or step == args.steps - 1:
            print(f"step {step:04d} loss {loss.item():.5f} gaussians {means.shape[0]}", flush=True)

        # Accumulate positional gradient magnitude — the densification signal: high
        # gradient means the optimizer is straining to move that gaussian (under-fit).
        if means.grad is not None:
            with torch.no_grad():
                grad_accum += means.grad.norm(dim=-1)
            grad_steps += 1

        # Adaptive density control.
        refining = args.prune_warmup <= step < args.steps - args.refine_stop
        if refining and args.reset_every > 0 and step % args.reset_every == 0:
            with torch.no_grad():
                opacity_logits.clamp_(max=args.opacity_reset)
            grad_accum.zero_()
            grad_steps = 0
        if refining and args.refine_every > 0 and step % args.refine_every == 0 and grad_steps > 0:
            densify = step < args.steps * args.densify_stop_frac
            updated = densify_and_prune(
                [means, raw_colors, log_scales, opacity_logits, raw_quats],
                grad_accum / grad_steps,
                args,
                densify,
            )
            if updated[0].shape[0] > 0:
                if updated[0].shape[0] != means.shape[0]:
                    print(f"step {step:04d} density {means.shape[0]} -> {updated[0].shape[0]} gaussians", flush=True)
                means, raw_colors, log_scales, opacity_logits, raw_quats = (torch.nn.Parameter(t) for t in updated)
                optimizer = make_optimizer([means, raw_colors, log_scales, opacity_logits, raw_quats], args)
            grad_accum = torch.zeros(means.shape[0], device=device)
            grad_steps = 0

    write_splat(
        job_dir / "world.splat",
        means.detach().cpu().numpy(),
        log_scales.detach().exp().clamp(0.002, args.max_scale).cpu().numpy(),
        F.normalize(raw_quats.detach(), dim=-1).cpu().numpy(),
        torch.sigmoid(raw_colors.detach()).cpu().numpy(),
        torch.sigmoid(opacity_logits.detach()).cpu().numpy(),
    )


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("job_dir")
    parser.add_argument("--steps", type=int, default=3000)
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--max-points", type=int, default=0)  # 0 = auto: use all projected points
    parser.add_argument("--max-scale", type=float, default=0.07)
    parser.add_argument("--position-lr", type=float, default=0.006)
    parser.add_argument("--position-lr-final", type=float, default=0.00006)
    parser.add_argument("--color-lr", type=float, default=0.035)
    parser.add_argument("--shape-lr", type=float, default=0.018)
    parser.add_argument("--min-target-luma", type=float, default=0.08)
    parser.add_argument("--min-point-luma", type=float, default=0.06)
    parser.add_argument("--min-valid-ratio", type=float, default=0.03)
    parser.add_argument("--mask-erode", type=int, default=1)
    parser.add_argument("--opacity-init", type=float, default=0.5)
    # Loss weights.
    parser.add_argument("--ssim-weight", type=float, default=0.2)
    parser.add_argument("--bg-weight", type=float, default=0.5)
    parser.add_argument("--scale-reg", type=float, default=0.01)
    parser.add_argument("--opacity-reg", type=float, default=0.0005)
    parser.add_argument("--aniso-reg", type=float, default=0.01)
    # Adaptive density control.
    parser.add_argument("--prune-warmup", type=int, default=80)
    parser.add_argument("--refine-every", type=int, default=100)
    parser.add_argument("--prune-opacity", type=float, default=0.05)
    parser.add_argument("--prune-aniso", type=float, default=8.0)
    parser.add_argument("--densify-frac", type=float, default=0.1)
    parser.add_argument("--densify-scale", type=float, default=0.02)
    parser.add_argument("--densify-stop-frac", type=float, default=0.6)
    parser.add_argument("--reset-every", type=int, default=500)
    parser.add_argument("--opacity-reset", type=float, default=-1.5)
    parser.add_argument("--refine-stop", type=int, default=60)
    return parser.parse_args()


def load_views(job_dir, size, min_luma, min_valid_ratio, mask_erode, device):
    views = []
    for name in VIEW_NAMES:
        view_dir = job_dir / "views" / name
        image_path = view_dir / "generated_rgb.png"
        depth_path = view_dir / "primitive_depth.png"
        camera_path = view_dir / "camera.json"
        if not image_path.exists() or not depth_path.exists() or not camera_path.exists():
            continue

        image = Image.open(image_path).convert("RGB").resize((size, size), Image.Resampling.LANCZOS)
        depth = Image.open(depth_path).convert("L").resize((size, size), Image.Resampling.NEAREST)
        image_np = np.asarray(image, dtype=np.float32) / 255.0
        depth_np = np.asarray(depth, dtype=np.float32) / 255.0
        luma = image_np @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
        mask_np = ((depth_np > 0.01) & (luma > min_luma)).astype(np.float32)
        # Erode (not dilate) so we drop the translucent white halo at the
        # silhouette edge instead of training gaussians on it.
        mask_np = erode_mask(mask_np, mask_erode)
        valid_ratio = float(mask_np.mean())
        if valid_ratio < min_valid_ratio:
            print(f"skipping {name}: only {valid_ratio:.1%} usable pixels", flush=True)
            continue

        camera = json.loads(camera_path.read_text())
        views.append(
            {
                "name": name,
                "image": torch.tensor(image_np, dtype=torch.float32, device=device),
                "mask": torch.tensor(mask_np[..., None], dtype=torch.float32, device=device),
                "viewmat": torch.tensor(view_matrix(camera), dtype=torch.float32, device=device)[None],
                "K": torch.tensor(intrinsics(camera, size), dtype=torch.float32, device=device)[None],
            }
        )

    if not views:
        raise SystemExit("no generated views found for gsplat training")
    return views


def erode_mask(mask, radius):
    if radius <= 0:
        return mask
    return 1.0 - dilate_mask(1.0 - mask, radius)


def dilate_mask(mask, radius):
    if radius <= 0:
        return mask

    out = mask.copy()
    h, w = mask.shape
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx * dx + dy * dy > radius * radius:
                continue
            y0 = max(0, dy)
            y1 = min(h, h + dy)
            x0 = max(0, dx)
            x1 = min(w, w + dx)
            sy0 = max(0, -dy)
            sy1 = min(h, h - dy)
            sx0 = max(0, -dx)
            sx1 = min(w, w - dx)
            out[y0:y1, x0:x1] = np.maximum(out[y0:y1, x0:x1], mask[sy0:sy1, sx0:sx1])
    return out


def view_matrix(camera):
    pos = np.array(camera["position"], dtype=np.float32)
    right = normalize(np.array(camera["right"], dtype=np.float32))
    up = normalize(np.array(camera["up"], dtype=np.float32))
    forward = normalize(np.array(camera["forward"], dtype=np.float32))

    rot = np.stack([right, -up, forward], axis=0)
    trans = -rot @ pos
    view = np.eye(4, dtype=np.float32)
    view[:3, :3] = rot
    view[:3, 3] = trans
    return view


def intrinsics(camera, size):
    f = 0.5 * size / math.tan(math.radians(camera["fov"]) * 0.5)
    return [[f, 0.0, size * 0.5], [0.0, f, size * 0.5], [0.0, 0.0, 1.0]]


def load_ply(path, min_luma):
    lines = path.read_text().splitlines()
    count = 0
    props = []
    header_end = 0
    in_vertex = False
    for i, line in enumerate(lines):
        parts = line.split()
        if line == "end_header":
            header_end = i + 1
            break
        if len(parts) >= 3 and parts[0] == "element":
            in_vertex = parts[1] == "vertex"
            if in_vertex:
                count = int(parts[2])
        elif in_vertex and len(parts) >= 3 and parts[0] == "property":
            props.append(parts[2])

    ix, iy, iz = props.index("x"), props.index("y"), props.index("z")
    ir, ig, ib = props.index("red"), props.index("green"), props.index("blue")
    points = []
    colors = []
    for line in lines[header_end : header_end + count]:
        values = line.split()
        color = np.array([int(values[ir]), int(values[ig]), int(values[ib])], dtype=np.float32) / 255.0
        if float(color @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)) < min_luma:
            continue
        points.append([float(values[ix]), float(values[iy]), float(values[iz])])
        colors.append(color)
    return np.asarray(points, dtype=np.float32), np.asarray(colors, dtype=np.float32)


def subsample(points, colors, max_points):
    if len(points) <= max_points:
        return points, colors
    rng = np.random.default_rng(7)
    idx = rng.choice(len(points), max_points, replace=False)
    return points[idx], colors[idx]


def init_log_scales(points, device):
    mn = points.min(axis=0)
    mx = points.max(axis=0)
    ext = np.maximum(mx - mn, 0.001)
    area = max(2 * (ext[0] * ext[1] + ext[0] * ext[2] + ext[1] * ext[2]), 0.001)
    scale = np.clip(math.sqrt(area / len(points)) * 1.1, 0.018, 0.08)
    values = torch.full((len(points), 3), math.log(scale), dtype=torch.float32, device=device)
    return values


def write_splat(path, means, scales, quats, colors, opacities):
    with path.open("wb") as file:
        for mean, scale, quat, color, opacity in zip(means, scales, quats, colors, opacities):
            file.write(struct.pack("<3f", *mean.tolist()))
            file.write(struct.pack("<3f", *scale.tolist()))
            file.write(bytes([byte(color[0]), byte(color[1]), byte(color[2]), byte(opacity)]))
            file.write(bytes([quat_byte(quat[0]), quat_byte(quat[1]), quat_byte(quat[2]), quat_byte(quat[3])]))


def normalize(v):
    return v / max(float(np.linalg.norm(v)), 1e-8)


def logit(x):
    x = x.clamp(1e-4, 1 - 1e-4)
    return torch.log(x / (1 - x))


def byte(value):
    return int(np.clip(float(value) * 255.0, 0, 255))


def quat_byte(value):
    return int(np.clip(float(value) * 128.0 + 128.0, 0, 255))


if __name__ == "__main__":
    raise SystemExit(main())
