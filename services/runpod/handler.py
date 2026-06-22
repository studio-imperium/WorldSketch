"""RunPod Serverless handler for WorldSketch.

One invocation = one generated world. It stages the scene + views into a temp job
dir, runs the Go pipeline once (`worldsketch-server -job <dir>` → ComfyUI, fusion,
gsplat), and ships world.splat back to the coordinator. Nothing is stored long-term:
the artifact is PUT to the coordinator's per-job resultUrl (which streams it to the
player and discards it), or returned inline as base64 for small payloads.

Expected input:
    {
      "scene":  {... scene.json ...},          # scene.parent set => expansion
      "views":  [{"name","rgb"(b64 png),"depth"(b64 png),"camera"{...},
                  "mask"(b64 png, expansion only)}, ...],
      "parentPlyUrl": "https://coordinator/.../world.ply",  # expansion only: pull parent cloud
      "resultUrl": "https://coordinator/.../result"   # optional; PUT target
    }
"""

import base64
import json
import os
import pathlib
import subprocess
import time
import urllib.request
import uuid
import sys
import zipfile

import runpod

REPO = os.environ.get("WORLDSKETCH_REPO", "/workspace/WorldSketch")
COMFY_DIR = os.environ.get("COMFY_DIR", "/workspace/ComfyUI")
SERVER_DIR = os.path.join(REPO, "server")
SERVER_BIN = os.path.join(SERVER_DIR, "worldsketch-server")
VOLUME_MODELS = os.environ.get("MODELS_DIR", "/runpod-volume/models")

_comfy = None


def log_python_import_state():
    script = pathlib.Path(REPO) / "services" / "ml" / "syncmvd.py"
    try:
        sys.path.insert(0, str(script.parent))
        import syncmvd

        syncmvd.disable_flash_attn_detection()
        import diffusers.models.controlnets.controlnet

        print("[handler] guarded diffusers controlnet import OK", flush=True)
    except Exception as exc:
        print(f"[handler] guarded diffusers controlnet import failed: {exc}", flush=True)
    finally:
        if str(script.parent) in sys.path:
            sys.path.remove(str(script.parent))


def _model_paths_config():
    """Point ComfyUI at models on the mounted network volume (kept out of the image)."""
    if not os.path.isdir(VOLUME_MODELS):
        return None
    cfg = pathlib.Path("/tmp/extra_model_paths.yaml")
    cfg.write_text(
        "worldsketch:\n"
        f"  base_path: {os.path.dirname(VOLUME_MODELS)}\n"
        "  checkpoints: models/checkpoints\n"
        "  controlnet: models/controlnet\n"
    )
    return str(cfg)


def ensure_comfy():
    """Start ComfyUI once and keep it warm across jobs on this worker."""
    global _comfy
    if _comfy is not None and _comfy.poll() is None:
        return

    cmd = ["python3", "-s", "main.py", "--port", "8188"]
    venv = os.path.join(COMFY_DIR, ".venv/bin/python")
    if os.path.exists(venv):
        cmd[0] = venv
    config = _model_paths_config()
    if config:
        cmd += ["--extra-model-paths-config", config]

    _comfy = subprocess.Popen(cmd, cwd=COMFY_DIR)
    for _ in range(180):
        if _comfy.poll() is not None:
            raise RuntimeError("ComfyUI exited during startup")
        try:
            urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=2)
            return
        except Exception:
            time.sleep(1)
    raise RuntimeError("ComfyUI did not become ready in time")


def _safe_view_name(name):
    # view["name"] lands in a filesystem path — reject anything that could escape job_dir.
    if not isinstance(name, str) or "/" in name or "\\" in name or name in ("", ".", ".."):
        raise ValueError(f"invalid view name: {name!r}")
    return name


def stage_inputs(job_dir, payload):
    root = pathlib.Path(job_dir)
    root.mkdir(parents=True, exist_ok=True)
    (root / "scene.json").write_text(json.dumps(payload["scene"]))
    for view in payload["views"]:
        name = _safe_view_name(view["name"])
        view_dir = root / "views" / name
        view_dir.mkdir(parents=True, exist_ok=True)
        (view_dir / "primitive_rgb.png").write_bytes(base64.b64decode(view["rgb"]))
        (view_dir / "primitive_depth.png").write_bytes(base64.b64decode(view["depth"]))
        (view_dir / "camera.json").write_text(json.dumps(view["camera"]))
        # Expansion only: the new-object mask the fusion step uses to fuse just the delta.
        if view.get("mask"):
            (view_dir / "new_mask.png").write_bytes(base64.b64decode(view["mask"]))
    # Expansion only: pull the parent plot's point cloud from the coordinator (passed as a
    # URL, not inline, to keep the /run payload small) into <job>/parent/world.ply, which
    # the pipeline merges the new tile onto (WriteExpandedPLY).
    parent_ply_url = payload.get("parentPlyUrl")
    if parent_ply_url:
        parent_dir = root / "parent"
        parent_dir.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(parent_ply_url, timeout=180) as resp:
            (parent_dir / "world.ply").write_bytes(resp.read())


def write_result_bundle(job_dir):
    path = pathlib.Path(job_dir)
    bundle = path / "worldsketch-result.zip"
    with zipfile.ZipFile(bundle, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for item in path.rglob("*"):
            if not item.is_file() or item == bundle:
                continue
            rel = item.relative_to(path)
            # Don't ship the staged parent point cloud back — the coordinator already has it.
            if rel.parts and rel.parts[0] == "parent":
                continue
            zf.write(item, rel.as_posix())
    return bundle


def handler(event):
    payload = event.get("input") or {}
    if "scene" not in payload or "views" not in payload:
        return {"error": "input must include 'scene' and 'views'"}

    ensure_comfy()
    job_dir = f"/tmp/ws-{uuid.uuid4().hex}"
    try:
        try:
            stage_inputs(job_dir, payload)
        except Exception as exc:
            return {"error": f"bad input: {exc}"}

        proc = subprocess.run(
            [SERVER_BIN, "-job", job_dir],
            cwd=SERVER_DIR,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            tail = (proc.stdout[-6000:] + proc.stderr[-6000:])
            return {"error": "pipeline failed", "log": tail}

        job_path = pathlib.Path(job_dir)
        splat = job_path / "world.splat"
        if not splat.exists():
            return {"error": "no world.splat produced", "log": proc.stdout[-6000:]}

        result_url = payload.get("resultUrl")
        if result_url:
            bundle = write_result_bundle(job_dir)
            data = bundle.read_bytes()
            req = urllib.request.Request(
                result_url,
                data=data,
                method="PUT",
                headers={"Content-Type": "application/zip"},
            )
            urllib.request.urlopen(req, timeout=180)
            return {"status": "done", "bytes": len(data), "bundle": True}

        # No callback URL: return inline (only viable once artifacts are small, e.g. .spz).
        data = splat.read_bytes()
        return {"status": "done", "splat_b64": base64.b64encode(data).decode()}
    finally:
        subprocess.run(["rm", "-rf", job_dir])


log_python_import_state()
runpod.serverless.start({"handler": handler})
