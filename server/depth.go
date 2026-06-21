package main

import (
	"os"
	"os/exec"
	"path/filepath"
)

func RunDepth(dir string) {
	for _, name := range viewNames {
		viewDir := filepath.Join(dir, "views", name)
		rgb := filepath.Join(viewDir, "generated_rgb.png")
		depth := filepath.Join(viewDir, "generated_depth.png")
		primitive := filepath.Join(viewDir, "primitive_depth.png")

		cmd := exec.Command(pythonBin(), "../services/ml/depth.py", rgb, depth, primitive)
		if err := cmd.Run(); err != nil {
			copyFile(primitive, depth)
			writeLog(viewDir, "depth.log", err.Error())
		}
	}
}

func pythonBin() string {
	if p := os.Getenv("WORLDSKETCH_PYTHON"); p != "" {
		return p
	}
	path := "../services/ml/.venv/bin/python"
	if _, err := os.Stat(path); err == nil {
		return path
	}
	return "python3"
}
