"""RunPod Serverless handler for WorldSketch.

One invocation = one generated world. It stages the scene + views into a temp job
dir, runs the Go pipeline once (`worldsketch-server -job <dir>` → ComfyUI, fusion,
gsplat), and ships world.splat back to the coordinator. Nothing is stored long-term:
the artifact is PUT to the coordinator's per-job resultUrl (which streams it to the
player and discards it), or returned inline as base64 for small payloads.

Expected input:
    {
      "scene":  {... scene.json ...},
      "views":  [{"name","rgb"(b64 png),"depth"(b64 png),"camera"{...}}, ...],
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

import runpod

REPO = os.environ.get("WORLDSKETCH_REPO", "/workspace/WorldSketch")
COMFY_DIR = os.environ.get("COMFY_DIR", "/workspace/ComfyUI")
SERVER_DIR = os.path.join(REPO, "server")
SERVER_BIN = os.path.join(SERVER_DIR, "worldsketch-server")
VOLUME_MODELS = os.environ.get("MODELS_DIR", "/runpod-volume/models")

_comfy = None


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


def stage_inputs(job_dir, payload):
    root = pathlib.Path(job_dir)
    root.mkdir(parents=True, exist_ok=True)
    (root / "scene.json").write_text(json.dumps(payload["scene"]))
    for view in payload["views"]:
        view_dir = root / "views" / view["name"]
        view_dir.mkdir(parents=True, exist_ok=True)
        (view_dir / "primitive_rgb.png").write_bytes(base64.b64decode(view["rgb"]))
        (view_dir / "primitive_depth.png").write_bytes(base64.b64decode(view["depth"]))
        (view_dir / "camera.json").write_text(json.dumps(view["camera"]))


def handler(event):
    payload = event.get("input") or {}
    if "scene" not in payload or "views" not in payload:
        return {"error": "input must include 'scene' and 'views'"}

    ensure_comfy()
    job_dir = f"/tmp/ws-{uuid.uuid4().hex}"
    try:
        stage_inputs(job_dir, payload)

        proc = subprocess.run(
            [SERVER_BIN, "-job", job_dir],
            cwd=SERVER_DIR,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            tail = (proc.stdout[-2000:] + proc.stderr[-2000:])
            return {"error": "pipeline failed", "log": tail}

        splat = pathlib.Path(job_dir) / "world.splat"
        if not splat.exists():
            return {"error": "no world.splat produced", "log": proc.stdout[-2000:]}
        data = splat.read_bytes()

        result_url = payload.get("resultUrl")
        if result_url:
            req = urllib.request.Request(
                result_url,
                data=data,
                method="PUT",
                headers={"Content-Type": "application/octet-stream"},
            )
            urllib.request.urlopen(req, timeout=180)
            return {"status": "done", "bytes": len(data)}

        # No callback URL: return inline (only viable once artifacts are small, e.g. .spz).
        return {"status": "done", "splat_b64": base64.b64encode(data).decode()}
    finally:
        subprocess.run(["rm", "-rf", job_dir])


runpod.serverless.start({"handler": handler})
