package main

import (
	"os"
	"os/exec"
)

func RunSplatTraining(dir string) error {
	cmd := exec.Command(pythonBin(), "../services/ml/train_splat.py", dir)
	cmd.Dir = "."
	cmd.Stdout = os.Stdout // stream to worker stdout so progress + tracebacks show in the logs
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
