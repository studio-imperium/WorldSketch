"""Read Gaussian-splat files into plain numpy arrays.

Supports the standard `.splat` binary (the antimatter15 / Spark format, 32 bytes per
gaussian) that WorldSketch's pipeline produces (WS_TRIPO_FORMAT=splat). A minimal
`.ply` reader is included for convenience.

Layout of one 32-byte `.splat` record:
    offset 0..11   position   3 x float32   (x, y, z)
    offset 12..23  scale      3 x float32   (sx, sy, sz)
    offset 24..27  color      4 x uint8     (r, g, b, a)   a = opacity
    offset 28..31  rotation   4 x uint8     quaternion, decoded as (b - 128) / 128
"""

from __future__ import annotations

import numpy as np


def load_splat(path: str) -> dict:
    """Parse a `.splat` file. Returns a dict of numpy arrays.

    Keys: positions (N,3) float32, scales (N,3) float32, colors (N,3) float32 in
    [0,1], opacity (N,) float32 in [0,1], quat (N,4) float32 (x,y,z,w-ish, decoded).
    """
    raw = np.fromfile(path, dtype=np.uint8)
    if raw.size == 0 or raw.size % 32 != 0:
        raise ValueError(f"{path}: not a valid .splat (size {raw.size} not a multiple of 32)")
    rec = raw.reshape(-1, 32)
    positions = rec[:, 0:12].copy().view(np.float32)
    scales = rec[:, 12:24].copy().view(np.float32)
    rgba = rec[:, 24:28].astype(np.float32) / 255.0
    quat = (rec[:, 28:32].astype(np.float32) - 128.0) / 128.0
    return {
        "positions": positions,
        "scales": scales,
        "colors": rgba[:, :3],
        "opacity": rgba[:, 3],
        "quat": quat,
    }


def load_ply(path: str) -> dict:
    """Minimal Gaussian-splat `.ply` reader (binary_little_endian).

    Only pulls x/y/z (and opacity/scale/color if present). Good enough for the score
    metric, which only needs gaussian centers. Falls back loudly if the header is ASCII.
    """
    with open(path, "rb") as f:
        header_lines = []
        while True:
            line = f.readline().decode("ascii", "replace").strip()
            header_lines.append(line)
            if line == "end_header":
                break
        if not any(l.startswith("format binary_little_endian") for l in header_lines):
            raise ValueError(f"{path}: only binary_little_endian .ply is supported")

        count = 0
        props = []  # (name, numpy_dtype)
        type_map = {
            "float": "<f4", "float32": "<f4", "double": "<f8", "float64": "<f8",
            "uchar": "u1", "uint8": "u1", "char": "i1", "int8": "i1",
            "ushort": "<u2", "short": "<i2", "uint": "<u4", "int": "<i4",
        }
        for l in header_lines:
            if l.startswith("element vertex"):
                count = int(l.split()[-1])
            elif l.startswith("property"):
                parts = l.split()
                props.append((parts[-1], type_map[parts[1]]))

        dtype = np.dtype([(n, t) for n, t in props])
        data = np.frombuffer(f.read(count * dtype.itemsize), dtype=dtype)

    def col(*names):
        for n in names:
            if n in data.dtype.names:
                return data[n].astype(np.float32)
        return None

    x, y, z = col("x"), col("y"), col("z")
    positions = np.stack([x, y, z], axis=1)
    out = {"positions": positions}
    sx, sy, sz = col("scale_0"), col("scale_1"), col("scale_2")
    if sx is not None:
        out["scales"] = np.stack([sx, sy, sz], axis=1)
    op = col("opacity")
    if op is not None:
        out["opacity"] = op
    return out


def load_gaussians(path: str) -> dict:
    if path.lower().endswith(".ply"):
        return load_ply(path)
    return load_splat(path)
