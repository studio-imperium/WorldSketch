import shutil
import sys


def fallback(src, dst):
    if src:
        shutil.copyfile(src, dst)
        return 0
    return 1


def main():
    if len(sys.argv) < 3:
        return 1

    image_path = sys.argv[1]
    output_path = sys.argv[2]
    fallback_path = sys.argv[3] if len(sys.argv) > 3 else None

    try:
        import torch
        from PIL import Image
        from transformers import pipeline
    except Exception:
        return fallback(fallback_path, output_path)

    try:
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        estimator = pipeline(
            task="depth-estimation",
            model="depth-anything/Depth-Anything-V2-Small-hf",
            device=device,
        )
        image = Image.open(image_path).convert("RGB")
        depth = estimator(image)["depth"]
        depth.save(output_path)
        return 0
    except Exception:
        return fallback(fallback_path, output_path)


if __name__ == "__main__":
    raise SystemExit(main())
