package main

import (
	"os"
	"strconv"
)

// envFloat / envInt read a tunable pipeline parameter from the environment, falling
// back to def. This lets the worker's comfy + cull params be changed from the RunPod
// endpoint's env settings (or local .env) without rebuilding the image.
func envFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
