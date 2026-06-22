package main

import (
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// loadDotEnv populates the process environment from a .env file (KEY=value lines) for any
// keys not already set, so running the coordinator directly (`go run .` or the built binary)
// picks up RunPod creds + tunables without the shell having to export them. Already-set vars
// WIN, so dev.sh's exports and the RunPod endpoint's own env take precedence. The .env lives
// at the repo root and the server runs from ./server, so we check the cwd then its parent.
// A missing file is fine (e.g. on the RunPod worker, where env comes from the endpoint).
func loadDotEnv() {
	for _, path := range []string{".env", filepath.Join("..", ".env")} {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		loaded := 0
		for key, val := range parseDotEnv(data) {
			if _, ok := os.LookupEnv(key); ok {
				continue // already set — shell / RunPod env wins
			}
			os.Setenv(key, val)
			loaded++
		}
		log.Printf("loaded %d env var(s) from %s", loaded, path)
		return // first .env found wins
	}
}

// parseDotEnv parses KEY=value lines: skips blanks and # comments, tolerates a leading
// `export `, and strips one layer of matching single/double quotes around the value.
func parseDotEnv(data []byte) map[string]string {
	out := map[string]string{}
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		if n := len(val); n >= 2 && ((val[0] == '"' && val[n-1] == '"') || (val[0] == '\'' && val[n-1] == '\'')) {
			val = val[1 : n-1]
		}
		if key != "" {
			out[key] = val
		}
	}
	return out
}

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
