"""Round-trip tests for geometry.py (Phase 2). Pure numpy, runs on CPU.

Ground truth is generated analytically by intersecting each camera ray with the
y=0 plane (independent of unproject), so the tests actually validate the math.
"""

import warnings

import numpy as np

from geometry import unproject, project, voxel_keys, VoxelSync, camera_basis, _norm

# numpy 2 + macOS Accelerate BLAS emits spurious matmul warnings on clean data.
warnings.filterwarnings("ignore", message=".*matmul.*")


def make_camera(position, target, fov=50.0, size=48, near=0.05, far=48.0):
    pos = np.array(position, float)
    fwd = _norm(np.array(target, float) - pos)
    right = _norm(np.cross(fwd, [0.0, 1.0, 0.0]))
    up = _norm(np.cross(right, fwd))
    return {
        "position": pos.tolist(), "forward": fwd.tolist(), "right": right.tolist(),
        "up": up.tolist(), "fov": fov, "aspect": 1.0, "near": near, "far": far,
        "width": size, "height": size,
    }


def plane_geometry(camera, plane_y=0.0):
    """Per-pixel ray ∩ y=plane_y. Returns (depth_norm, world, mask)."""
    H, W = camera["height"], camera["width"]
    pos, fwd, right, up = camera_basis(camera)
    tan = np.tan(np.radians(camera["fov"]) / 2.0)
    aspect, near, far = camera["aspect"], camera["near"], camera["far"]

    ndc_x = (np.arange(W) + 0.5) / W * 2 - 1
    ndc_y = 1 - (np.arange(H) + 0.5) / H * 2
    dirs = (
        fwd[None, None, :]
        + right[None, None, :] * (ndc_x[None, :, None] * aspect * tan)
        + up[None, None, :] * (ndc_y[:, None, None] * tan)
    )
    dy = dirs[..., 1]
    t = np.where(np.abs(dy) < 1e-9, -1.0, (plane_y - pos[1]) / dy)
    world = pos[None, None, :] + t[..., None] * dirs
    nd = (t - near) / (far - near)
    mask = (t > 0) & (nd >= 0) & (nd <= 1)
    return nd, world, mask


def texture(world):
    x, z = world[..., 0], world[..., 2]
    return np.stack([0.5 + 0.4 * np.sin(x), 0.5 + 0.4 * np.cos(z), 0.5 * np.ones_like(x)], -1)


def test_unproject_matches_plane():
    cam = make_camera([0, 6, 6], [0, 0, 0])
    nd, world, mask = plane_geometry(cam)
    got = unproject(np.where(mask, nd, 0.0), cam)
    err = np.abs(got[mask] - world[mask]).max()
    print(f"unproject vs ray-plane: max err {err:.2e}")
    assert err < 1e-6, err


def test_project_is_inverse():
    cam = make_camera([0, 6, 6], [0, 0, 0])
    nd, world, mask = plane_geometry(cam)
    px, _ = project(world[mask], cam)
    ys, xs = np.mgrid[0:cam["height"], 0:cam["width"]]
    expected = np.stack([xs, ys], -1).astype(float)[mask]
    err = np.abs(px - expected).max()
    print(f"project(unproject(.)) pixel round-trip: max err {err:.2e}")
    assert err < 1e-4, err


def test_voxel_sync():
    cams = [make_camera(p, [0, 0, 0]) for p in [(0, 6, 5), (3, 6, 4), (-3, 6, 4)]]
    geos = [plane_geometry(c) for c in cams]
    size = 0.1
    keys = [voxel_keys(w, size) for (_, w, _) in geos]
    masks = [m for (_, _, m) in geos]
    sync = VoxelSync(keys, masks)

    imgs = [texture(w) for (_, w, _) in geos]

    # Consistent inputs survive the round-trip (within voxel quantization).
    out = sync.sync(imgs)
    for o, im, m in zip(out, imgs, masks):
        err = np.abs(o[m] - im[m]).mean()
        assert err < 0.06, f"consistency err {err:.4f}"
    print(f"sync of consistent views: mean err {np.abs(out[0][masks[0]] - imgs[0][masks[0]]).mean():.4f}")

    # A corrupted view gets pulled back toward the consensus of the others.
    bad = [imgs[0] + 0.4] + imgs[1:]
    fixed = sync.sync(bad)
    m0 = masks[0]
    corrupt_err = np.abs(bad[0][m0] - imgs[0][m0]).mean()
    fixed_err = np.abs(fixed[0][m0] - imgs[0][m0]).mean()
    # Sync only helps where view 0 overlaps the others; isolate those pixels.
    overlap = (np.abs(fixed[0] - bad[0]).sum(-1) > 1e-3) & m0
    overlap_err = np.abs(fixed[0][overlap] - imgs[0][overlap]).mean()
    print(f"corrupted err {corrupt_err:.3f} -> overall {fixed_err:.3f}, "
          f"over {int(overlap.sum())} overlapped px {overlap_err:.3f}")
    assert fixed_err < corrupt_err, (fixed_err, corrupt_err)        # never worse
    assert overlap_err < corrupt_err * 0.5, (overlap_err, corrupt_err)  # strong fix where it overlaps


if __name__ == "__main__":
    test_unproject_matches_plane()
    test_project_is_inverse()
    test_voxel_sync()
    print("ALL GEOMETRY TESTS PASSED")
