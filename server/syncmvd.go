package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

// runImageGen selects the image-generation backend. Default is ComfyUI; set
// WS_IMAGEGEN=syncmvd to use the diffusers SyncMVD path instead.
func runImageGen(dir, scenePrompt string) error {
	if os.Getenv("WS_IMAGEGEN") == "syncmvd" {
		return RunSyncMVD(dir, scenePrompt)
	}
	return RunComfy(dir, scenePrompt)
}

func modelsDir() string {
	if d := os.Getenv("MODELS_DIR"); d != "" {
		return d
	}
	return "/runpod-volume/models"
}

// RunSyncMVD generates the views via the diffusers script (services/ml/syncmvd.py).
// It first writes the same edge + depth-control maps the ComfyUI path uses, then hands
// the job dir to Python, which writes generated_rgb.png per view.
func RunSyncMVD(dir, scenePrompt string) error {
	for _, name := range viewNames {
		viewDir := filepath.Join(dir, "views", name)
		in := filepath.Join(viewDir, "primitive_rgb.png")
		if _, err := os.Stat(in); err != nil {
			continue
		}
		WriteEdgeMap(in, filepath.Join(viewDir, "primitive_edges.png"))
		WriteDepthControl(filepath.Join(viewDir, "primitive_depth.png"), filepath.Join(viewDir, "primitive_depth_control.png"))
	}

	sync := envInt("WS_SYNC", 0)
	if envBool("WS_IMAGE_ONLY") {
		sync = 0
	}

	args := []string{
		"../services/ml/syncmvd.py", dir,
		"--prompt", positivePrompt(scenePrompt),
		"--models", modelsDir(),
		"--base-model", envStr("WS_BASE_MODEL", "Lykon/dreamshaper-8"),
		"--size", strconv.Itoa(envInt("WS_SIZE", 512)),
		"--steps", strconv.Itoa(envInt("WS_STEPS", 7)),
		"--denoise", fmt.Sprintf("%g", envFloat("WS_DENOISE", 0.5)),
		"--cfg", fmt.Sprintf("%g", envFloat("WS_CFG", 6.5)),
		"--canny", fmt.Sprintf("%g", envFloat("WS_CANNY_STRENGTH", 0.9)),
		"--depth-scale", fmt.Sprintf("%g", envFloat("WS_DEPTH_STRENGTH", 0.6)),
		"--sync", strconv.Itoa(sync),
		"--sync-space", envStr("WS_SYNC_SPACE", "rgb"),
		"--sync-interval", strconv.Itoa(envInt("WS_SYNC_INTERVAL", 1)),
		"--sync-weight", fmt.Sprintf("%g", envFloat("WS_SYNC_WEIGHT", 1.0)),
		"--sync-voxel", fmt.Sprintf("%g", envFloat("WS_SYNC_VOXEL", 0.25)),
		"--sync-taper", fmt.Sprintf("%g", envFloat("WS_SYNC_TAPER", 0.7)),
		"--sync-batch", strconv.Itoa(envInt("WS_SYNC_BATCH", 1)),
	}
	if envBool("WS_IMAGE_ONLY") {
		args = append(args, "--view", envStr("WS_IMAGE_ONLY_VIEW", "front"))
	}
	cmd := exec.Command(pythonBin(), args...)
	cmd.Dir = "."
	cmd.Stdout = os.Stdout // stream to worker stdout so tracebacks show in the logs
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
