package main

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
)

func RunSplatTraining(dir string) error {
	args := []string{
		"../services/ml/train_splat.py", dir,
		"--steps", strconv.Itoa(envInt("WS_SPLAT_STEPS", 3000)),
		"--size", strconv.Itoa(envInt("WS_SPLAT_SIZE", 512)),
		"--max-scale", fmt.Sprintf("%g", envFloat("WS_SPLAT_MAX_SCALE", 0.07)),
		"--mask-erode", strconv.Itoa(envInt("WS_SPLAT_MASK_ERODE", 1)),
		"--bg-weight", fmt.Sprintf("%g", envFloat("WS_SPLAT_BG_WEIGHT", 0.5)),
		"--densify-frac", fmt.Sprintf("%g", envFloat("WS_SPLAT_DENSIFY_FRAC", 0.1)),
		"--densify-scale", fmt.Sprintf("%g", envFloat("WS_SPLAT_DENSIFY_SCALE", 0.02)),
		"--densify-stop-frac", fmt.Sprintf("%g", envFloat("WS_SPLAT_DENSIFY_STOP_FRAC", 0.6)),
		"--refine-every", strconv.Itoa(envInt("WS_SPLAT_REFINE_EVERY", 100)),
		"--refine-stop", strconv.Itoa(envInt("WS_SPLAT_REFINE_STOP", 60)),
	}
	cmd := exec.Command(pythonBin(), args...)
	cmd.Dir = "."
	cmd.Stdout = os.Stdout // stream to worker stdout so progress + tracebacks show in the logs
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
