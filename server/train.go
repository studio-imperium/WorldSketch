package main

import (
	"os/exec"
)

func RunSplatTraining(dir string) error {
	cmd := exec.Command(pythonBin(), "../services/ml/train_splat.py", dir)
	cmd.Dir = "."
	out, err := cmd.CombinedOutput()
	if len(out) > 0 {
		writeLog(dir, "train_splat.log", string(out))
	}
	return err
}
