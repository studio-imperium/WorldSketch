"""score(splat, layout) — the WorldSketch spatial-accuracy metric (Phase 0).

Given a generated Gaussian splat and the KNOWN block-out layout (the colliders /
ground truth), this measures how far off the splat's geometry is — the number you
need to (a) decide whether training is even worth it vs. post-processing, and (b)
tell whether a fine-tune actually helped.

Because the splat lands in TripoSplat's arbitrary pose/scale, we first align the
splat's gaussian centers to the ground-truth surface with a similarity transform
(scale + rotation + translation, solved by ICP). That makes the score measure
*relative* structure — the depth/placement perception we care about — independent of
the global pose that the cull/seat/fit pipeline already corrects.

Outputs:
  - chamfer        : symmetric Chamfer distance (plot units) — overall geometry error
  - obj_centroid   : mean per-object centroid error (plot units) — placement/depth error
  - per_object     : list of {id, type, error} so you can see which objects are misplaced

Layout JSON schema (one entry per primitive, plot-local coords; see layout_example.json):
  {
    "plot_size": 8,
    "objects": [
      {"id": "p1", "type": "box|sphere|cylinder|cone",
       "position": [x,y,z], "rotation": [rx,ry,rz], "scale": [sx,sy,sz],
       "color": "#rrggbb", "ground": false}
    ]
  }

Usage:
  python score.py path/to/plot.splat path/to/layout.json [--no-ground] [--json]
"""

from __future__ import annotations

import argparse
import json
import sys

import numpy as np

from splat_io import load_gaussians

try:
    from scipy.spatial import cKDTree  # fast NN if available
    _HAVE_KDTREE = True
except Exception:  # pragma: no cover
    _HAVE_KDTREE = False


# --------------------------------------------------------------------------------------
# Ground-truth point cloud: sample each primitive's surface in plot-local coordinates.
# Base geometries match client/scripts/primitives.js (geometryFor / defaultScale):
#   box      BoxGeometry(1,1,1)            -> unit cube [-0.5,0.5]^3
#   sphere   SphereGeometry(0.5)           -> radius 0.5
#   cylinder CylinderGeometry(0.5,0.5,1)   -> radius 0.5, height 1, axis +Y
#   cone     ConeGeometry(0.5,1)           -> base radius 0.5 at y=-0.5, apex at y=+0.5
# --------------------------------------------------------------------------------------

def _sample_box(n, rng, scale=(1, 1, 1)):
    # 6 faces, weighted by their WORLD area (after scale) so a flat slab like the ground
    # ([8,0.05,8]) puts ~all points on its big top/bottom, not the thin edge strips.
    sx, sy, sz = scale
    areas = np.array([sy * sz, sy * sz, sx * sz, sx * sz, sx * sy, sx * sy], float)
    areas = areas / areas.sum()
    face = rng.choice(6, n, p=areas)
    u = rng.uniform(-0.5, 0.5, n)
    v = rng.uniform(-0.5, 0.5, n)
    p = np.zeros((n, 3))
    for f in range(6):
        m = face == f
        axis, sign = f // 2, (f % 2) * 2 - 1
        a, b = [k for k in range(3) if k != axis]
        p[m, axis] = 0.5 * sign
        p[m, a] = u[m]
        p[m, b] = v[m]
    return p


def _sample_sphere(n, rng, scale=(1, 1, 1)):
    v = rng.normal(size=(n, 3))
    v /= np.linalg.norm(v, axis=1, keepdims=True) + 1e-9
    return v * 0.5


def _sample_cylinder(n, rng, scale=(1, 1, 1)):
    # side area = 2*pi*r*h = pi; each cap = pi*r^2 = pi/4. weights: side 2/3, caps 1/6 each.
    r = 0.5
    part = rng.choice(3, n, p=[2 / 3, 1 / 6, 1 / 6])
    p = np.zeros((n, 3))
    th = rng.uniform(0, 2 * np.pi, n)
    side = part == 0
    p[side, 0] = r * np.cos(th[side])
    p[side, 2] = r * np.sin(th[side])
    p[side, 1] = rng.uniform(-0.5, 0.5, side.sum())
    for cap, y in ((1, 0.5), (2, -0.5)):
        m = part == cap
        rad = r * np.sqrt(rng.uniform(0, 1, m.sum()))
        p[m, 0] = rad * np.cos(th[m])
        p[m, 2] = rad * np.sin(th[m])
        p[m, 1] = y
    return p


def _sample_cone(n, rng, scale=(1, 1, 1)):
    # lateral surface + base cap. slant len = sqrt(r^2+h^2); lateral area = pi*r*slant.
    r, h = 0.5, 1.0
    slant = np.hypot(r, h)
    lat_area = np.pi * r * slant
    base_area = np.pi * r * r
    p_lat = lat_area / (lat_area + base_area)
    part = rng.choice(2, n, p=[p_lat, 1 - p_lat])
    p = np.zeros((n, 3))
    th = rng.uniform(0, 2 * np.pi, n)
    lat = part == 0
    # parametrize lateral by t in [0,1] from base(y=-0.5) to apex(y=+0.5); area ~ t.
    t = np.sqrt(rng.uniform(0, 1, lat.sum()))  # area-weighted toward the base
    rr = r * (1 - t)
    p[lat, 0] = rr * np.cos(th[lat])
    p[lat, 2] = rr * np.sin(th[lat])
    p[lat, 1] = -0.5 + t  # t in [0,1] -> y in [-0.5,0.5]
    base = part == 1
    rad = r * np.sqrt(rng.uniform(0, 1, base.sum()))
    p[base, 0] = rad * np.cos(th[base])
    p[base, 2] = rad * np.sin(th[base])
    p[base, 1] = -0.5
    return p


_SAMPLERS = {
    "box": _sample_box,
    "sphere": _sample_sphere,
    "cylinder": _sample_cylinder,
    "cone": _sample_cone,
}


def _euler_xyz(rx, ry, rz):
    """three.js Euler order 'XYZ' -> rotation matrix R = Rx @ Ry @ Rz."""
    cx, sx = np.cos(rx), np.sin(rx)
    cy, sy = np.cos(ry), np.sin(ry)
    cz, sz = np.cos(rz), np.sin(rz)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Rx @ Ry @ Rz


def sample_layout(layout: dict, n_per_object: int = 2000, seed: int = 0):
    """Return (points (M,3), object_id_per_point (M,), objects_meta list)."""
    rng = np.random.default_rng(seed)
    pts, ids, meta = [], [], []
    for idx, obj in enumerate(layout["objects"]):
        t = obj["type"]
        if t not in _SAMPLERS:
            continue
        scale = np.asarray(obj.get("scale", [1, 1, 1]), float)
        local = _SAMPLERS[t](n_per_object, rng, scale)
        rot = np.asarray(obj.get("rotation", [0, 0, 0]), float)
        pos = np.asarray(obj.get("position", [0, 0, 0]), float)
        world = (_euler_xyz(*rot) @ (local * scale).T).T + pos
        pts.append(world)
        ids.append(np.full(n_per_object, idx))
        meta.append({"id": obj.get("id", str(idx)), "type": t, "ground": bool(obj.get("ground", False))})
    return np.concatenate(pts), np.concatenate(ids), meta


# --------------------------------------------------------------------------------------
# Alignment + distances
# --------------------------------------------------------------------------------------

def _nn(query, ref):
    """Indices into ref of the nearest neighbour for each query point."""
    if _HAVE_KDTREE:
        return cKDTree(ref).query(query, k=1)[1]
    # brute force, chunked to bound memory
    idx = np.empty(len(query), dtype=np.int64)
    for s in range(0, len(query), 4096):
        d = np.linalg.norm(query[s:s + 4096, None, :] - ref[None, :, :], axis=2)
        idx[s:s + 4096] = d.argmin(1)
    return idx


def _umeyama(src, dst, allow_reflection: bool = True):
    """Least-squares similarity (scale s, orthogonal R, translation t) mapping src->dst.

    allow_reflection=True permits R with det=-1 — required because TripoSplat lands the
    splat at an arbitrary handedness (the upside-down Y-flip), so the splat->GT map can be
    a reflection. We only measure relative structure, so a mirror fit is fine.
    """
    mu_s, mu_d = src.mean(0), dst.mean(0)
    s0, d0 = src - mu_s, dst - mu_d
    cov = (d0.T @ s0) / len(src)
    U, S, Vt = np.linalg.svd(cov)
    D = np.eye(3)
    if not allow_reflection and np.linalg.det(U) * np.linalg.det(Vt) < 0:
        D[2, 2] = -1
    R = U @ D @ Vt
    var_s = (s0 ** 2).sum() / len(src)
    scale = (S * np.diag(D)).sum() / (var_s + 1e-12)
    t = mu_d - scale * R @ mu_s
    return scale, R, t


def _yaw(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def align_similarity(src, dst, iters: int = 8, sample: int = 4000, seed: int = 0):
    """Similarity ICP that aligns src (splat centers) onto dst (GT cloud).

    The plot is 4-fold symmetric and the splat arrives at an arbitrary D4 pose + flip, so a
    single ICP from identity gets stuck. We seed ICP from each of the 8 D4 inits (4 yaws x
    {no-flip, Y-flip}), refine each, and keep whichever lands the lowest residual.
    """
    rng = np.random.default_rng(seed)
    work = src[rng.choice(len(src), min(sample, len(src)), replace=False)]
    dsub = dst[rng.choice(len(dst), min(sample, len(dst)), replace=False)]
    rms_s = np.sqrt(((work - work.mean(0)) ** 2).sum(1).mean())
    rms_d = np.sqrt(((dsub - dsub.mean(0)) ** 2).sum(1).mean())
    base_scale = rms_d / (rms_s + 1e-12)

    best = None
    for flip in (1.0, -1.0):
        for k in range(4):
            R = _yaw(k * np.pi / 2) @ np.diag([1.0, flip, 1.0])
            scale = base_scale
            t = dsub.mean(0) - scale * (R @ work.mean(0))
            cur = (scale * (R @ work.T).T) + t
            for _ in range(iters):
                j = _nn(cur, dsub)
                ds, dR, dt = _umeyama(cur, dsub[j])
                cur = (ds * (dR @ cur.T).T) + dt
                scale, R, t = ds * scale, dR @ R, ds * (dR @ t) + dt
            resid = np.linalg.norm(cur - dsub[_nn(cur, dsub)], axis=1).mean()
            if best is None or resid < best[0]:
                best = (resid, scale, R, t)
    return best[1], best[2], best[3]


def chamfer(a, b, sample: int = 6000, seed: int = 0):
    rng = np.random.default_rng(seed)
    ai = rng.choice(len(a), min(sample, len(a)), replace=False)
    bi = rng.choice(len(b), min(sample, len(b)), replace=False)
    a, b = a[ai], b[bi]
    da = np.linalg.norm(a - b[_nn(a, b)], axis=1)
    db = np.linalg.norm(b - a[_nn(b, a)], axis=1)
    return float(da.mean() + db.mean())


def score(splat_path: str, layout: dict, include_ground: bool = True, n_per_object: int = 2000):
    g = load_gaussians(splat_path)
    pred = g["positions"].astype(np.float64)
    pred = pred[np.isfinite(pred).all(1)]

    gt, gt_id, meta = sample_layout(layout, n_per_object=n_per_object)
    if not include_ground:
        keep = ~np.isin(gt_id, [i for i, m in enumerate(meta) if m["ground"]])
        gt, gt_id = gt[keep], gt_id[keep]

    scale, R, t = align_similarity(pred, gt)
    aligned = (scale * (R @ pred.T).T) + t

    cd = chamfer(aligned, gt)

    # per-object centroid error: assign each aligned splat point to the GT object whose
    # nearest GT point it lands on, then compare predicted vs GT centroid per object.
    nn_gt = _nn(aligned, gt)
    assigned_obj = gt_id[nn_gt]
    per_object, errs = [], []
    for idx, m in enumerate(meta):
        if not include_ground and m["ground"]:
            continue
        sel = assigned_obj == idx
        gt_centroid = gt[gt_id == idx].mean(0)
        if sel.sum() < 5:
            err = float("nan")  # model produced ~nothing where this object should be
        else:
            err = float(np.linalg.norm(aligned[sel].mean(0) - gt_centroid))
        per_object.append({"id": m["id"], "type": m["type"], "ground": m["ground"], "error": err})
        if not m["ground"] and np.isfinite(err):
            errs.append(err)

    return {
        "chamfer": cd,
        "obj_centroid": float(np.mean(errs)) if errs else float("nan"),
        "align_scale": float(scale),
        "n_gaussians": int(len(pred)),
        "per_object": per_object,
    }


def main():
    ap = argparse.ArgumentParser(description="WorldSketch splat spatial-accuracy score")
    ap.add_argument("splat", help="path to .splat or .ply")
    ap.add_argument("layout", help="path to layout.json (ground-truth block-out)")
    ap.add_argument("--no-ground", action="store_true", help="exclude the baseplate from the GT cloud")
    ap.add_argument("--json", action="store_true", help="emit the result as JSON")
    args = ap.parse_args()

    with open(args.layout) as f:
        layout = json.load(f)
    result = score(args.splat, layout, include_ground=not args.no_ground)

    if args.json:
        print(json.dumps(result, indent=2))
        return
    print(f"gaussians         : {result['n_gaussians']}")
    print(f"align scale       : {result['align_scale']:.3f}  (splat->GT similarity fit)")
    print(f"chamfer (plot u.) : {result['chamfer']:.4f}")
    print(f"obj centroid err  : {result['obj_centroid']:.4f}  (mean over non-ground objects)")
    print("per-object:")
    for o in result["per_object"]:
        tag = " [ground]" if o["ground"] else ""
        e = "n/a (missing)" if o["error"] != o["error"] else f"{o['error']:.4f}"
        print(f"  {o['id']:<8} {o['type']:<9} err={e}{tag}")


if __name__ == "__main__":
    sys.exit(main())
