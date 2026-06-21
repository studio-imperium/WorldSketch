"""Multi-view geometry bridge for SyncMVD (Phase 2).

Ports fusion.go's unprojection math and adds the inverse + a voxel-grid sync, so the
denoising loop can: unproject each view onto a shared scene -> average overlapping
regions -> reproject back into each view. Pure numpy (no GPU), so it's unit-testable.

Camera dict matches camera.json: position/forward/right/up (3-vectors), fov (deg),
aspect, near, far, width, height.
"""

import numpy as np


def _norm(v):
    return np.asarray(v, float) / max(float(np.linalg.norm(v)), 1e-9)


def camera_basis(camera):
    return (
        np.asarray(camera["position"], float),
        _norm(camera["forward"]),
        _norm(camera["right"]),
        _norm(camera["up"]),
    )


def unproject(depth_norm, camera):
    """depth_norm: (H, W) in [0, 1]. Returns (H, W, 3) world points.

    Mirrors fusion.go pointsFromView exactly:
        depth = near + nd*(far-near)
        px = (ndc_x) * aspect * tan * depth ;  py = (ndc_y) * tan * depth
        world = pos + fwd*depth + right*px + up*py
    """
    H, W = depth_norm.shape
    pos, fwd, right, up = camera_basis(camera)
    tan = np.tan(np.radians(camera["fov"]) / 2.0)  # fov*pi/360
    aspect, near, far = camera["aspect"], camera["near"], camera["far"]

    ndc_x = (np.arange(W) + 0.5) / W * 2.0 - 1.0          # (W,)
    ndc_y = 1.0 - (np.arange(H) + 0.5) / H * 2.0          # (H,) flipped
    depth = near + depth_norm * (far - near)              # (H, W)
    px = ndc_x[None, :] * aspect * tan * depth            # (H, W)
    py = ndc_y[:, None] * tan * depth                     # (H, W)

    return (
        pos[None, None, :]
        + fwd[None, None, :] * depth[..., None]
        + right[None, None, :] * px[..., None]
        + up[None, None, :] * py[..., None]
    )


def project(points, camera):
    """Inverse of unproject. points: (..., 3). Returns (pixels (..., 2), depth (...)).

    depth here is the forward-axis distance (the same quantity unproject consumes).
    """
    pos, fwd, right, up = camera_basis(camera)
    tan = np.tan(np.radians(camera["fov"]) / 2.0)
    aspect = camera["aspect"]
    W, H = camera["width"], camera["height"]

    rel = np.asarray(points, float) - pos
    depth = rel @ fwd
    safe = np.where(np.abs(depth) < 1e-9, 1e-9, depth)
    ndc_x = (rel @ right) / (aspect * tan * safe)
    ndc_y = (rel @ up) / (tan * safe)

    x = (ndc_x + 1.0) / 2.0 * W - 0.5
    y = (1.0 - ndc_y) / 2.0 * H - 0.5
    return np.stack([x, y], axis=-1), depth


def voxel_keys(world, size):
    """World points (..., 3) -> integer voxel coordinates (..., 3)."""
    return np.floor(np.asarray(world, float) / size).astype(np.int64)


class VoxelSync:
    """Precomputes a shared voxel index from the (static) per-view geometry, then
    sync() averages a set of per-view images through it each denoising step.
    """

    def __init__(self, per_view_keys, per_view_mask):
        self.hw = [m.shape for m in per_view_mask]
        self.flat_mask = [m.reshape(-1) for m in per_view_mask]

        valid = [k.reshape(-1, 3)[m] for k, m in zip(per_view_keys, self.flat_mask)]
        stacked = np.concatenate(valid, axis=0) if valid else np.zeros((0, 3), np.int64)
        uniq, inv = np.unique(stacked, axis=0, return_inverse=True)
        inv = inv.reshape(-1)  # numpy version-proof
        self.num_voxels = len(uniq)

        # map each pixel -> global voxel index (-1 where masked out)
        self.pixel_voxel = []
        offset = 0
        for m in self.flat_mask:
            n = int(m.sum())
            pv = np.full(m.shape[0], -1, np.int64)
            pv[m] = inv[offset:offset + n]
            offset += n
            self.pixel_voxel.append(pv)

    def sync(self, images, weights=None):
        """images: list of (H, W, 3). Returns list of consensus (H, W, 3): each pixel
        replaced by the (weighted) average colour of every view that sees its voxel."""
        sums = np.zeros((self.num_voxels, 3))
        counts = np.zeros(self.num_voxels)
        for i, img in enumerate(images):
            pv = self.pixel_voxel[i]
            sel = pv >= 0
            idx = pv[sel]
            flat = img.reshape(-1, 3)[sel]
            w = np.ones(sel.sum()) if weights is None else weights[i].reshape(-1)[sel]
            np.add.at(sums, idx, flat * w[:, None])
            np.add.at(counts, idx, w)

        avg = np.zeros_like(sums)
        nz = counts > 0
        avg[nz] = sums[nz] / counts[nz][:, None]

        out = []
        for i, img in enumerate(images):
            pv = self.pixel_voxel[i]
            res = img.reshape(-1, 3).copy()
            sel = pv >= 0
            res[sel] = avg[pv[sel]]
            out.append(res.reshape(self.hw[i][0], self.hw[i][1], 3))
        return out
