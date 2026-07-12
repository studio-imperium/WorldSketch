package storage

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"worldsketch/server/internal/config"
)

func AllocateOutput() (string, string, error) {
	root := OutputsRoot()
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", "", err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", "", err
	}
	max := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if n, err := strconv.Atoi(entry.Name()); err == nil && n > max {
			max = n
		}
	}
	name := fmt.Sprintf("%04d", max+1)
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", err
	}
	return name, dir, nil
}

func OutputsRoot() string {
	return config.Env("WS_OUTPUT_DIR", filepath.Join(config.RootDir(), "outputs"))
}

func OutputSubdir(index string) string {
	index = SanitizeName(index)
	if index == "" {
		index = time.Now().Format("20060102-150405")
	}
	return filepath.Join(OutputsRoot(), index)
}

func SaveGeneration(dir, name string, input, materialInput, output []byte, prompt string) {
	if !config.EnvBool("WS_SAVE_GENERATIONS", true) {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("saveGeneration: mkdir %s: %v", dir, err)
		return
	}
	base := filepath.Join(dir, name)
	files := map[string][]byte{
		base + "-input.png":  input,
		base + "-output.png": output,
		base + "-prompt.txt": []byte(prompt),
	}
	if len(materialInput) > 0 {
		files[base+"-materials.png"] = materialInput
	}
	for path, data := range files {
		if err := os.WriteFile(path, data, 0o644); err != nil {
			log.Printf("saveGeneration: write %s: %v", path, err)
		}
	}
}

func SaveSplat(dir, name string, splat []byte) {
	if !config.EnvBool("WS_SAVE_GENERATIONS", true) {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("saveSplat: mkdir %s: %v", dir, err)
		return
	}
	path := filepath.Join(dir, name+".splat")
	if err := os.WriteFile(path, splat, 0o644); err != nil {
		log.Printf("saveSplat: write %s: %v", path, err)
	}
}

func SaveIdentify(dir string, image []byte, raw string, labels map[string]string, ground string) {
	if !config.EnvBool("WS_SAVE_GENERATIONS", true) {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("saveIdentify: mkdir %s: %v", dir, err)
		return
	}
	if err := os.WriteFile(filepath.Join(dir, "identify.png"), image, 0o644); err != nil {
		log.Printf("saveIdentify: write image: %v", err)
	}
	payload, err := json.MarshalIndent(map[string]any{"raw": raw, "labels": labels, "ground": ground}, "", "  ")
	if err != nil {
		payload = []byte(raw)
	}
	if err := os.WriteFile(filepath.Join(dir, "identify-response.json"), payload, 0o644); err != nil {
		log.Printf("saveIdentify: write response: %v", err)
	}
}

func SanitizeName(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	s = filepath.Base(filepath.Clean(s))
	if s == "." || s == ".." || s == string(filepath.Separator) {
		return ""
	}
	return s
}
