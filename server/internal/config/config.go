package config

import (
	"bufio"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type ImageEditSettings struct {
	Provider      string
	GeminiModel   string
	OpenAIModel   string
	Size          string
	Quality       string
	Fidelity      string
	Background    string
	Format        string
	SkipImageEdit bool
}

type TripoSettings struct {
	Steps     string
	Guidance  string
	Gaussians string
	Format    string
}

func SceneImageEditSettings() ImageEditSettings {
	return ImageEditSettings{
		Provider:      Env("WS_SCENE_IMAGE_PROVIDER", "openai"),
		GeminiModel:   Env("WS_SCENE_GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image"),
		OpenAIModel:   Env("WS_SCENE_IMAGE_MODEL", "gpt-image-1"),
		Size:          Env("WS_SCENE_IMAGE_SIZE", "1024x1024"),
		Quality:       Env("WS_SCENE_IMAGE_QUALITY", "high"),
		Fidelity:      Env("WS_SCENE_IMAGE_FIDELITY", "high"),
		Background:    Env("WS_SCENE_IMAGE_BACKGROUND", "opaque"),
		Format:        Env("WS_SCENE_IMAGE_FORMAT", "png"),
		SkipImageEdit: EnvBool("WS_SCENE_SKIP_IMAGE_EDIT", false),
	}
}

func SceneTripoSettings() TripoSettings {
	return TripoSettings{
		Steps:     ClampIntString(Env("WS_SCENE_TRIPO_STEPS", "24"), "24", 1, 64),
		Guidance:  Env("WS_SCENE_TRIPO_GUIDANCE", "7"),
		Gaussians: ClampIntString(Env("WS_SCENE_TRIPO_GAUSSIANS", "262144"), "262144", 1024, 262144),
		Format:    Env("WS_SCENE_TRIPO_FORMAT", "splat"),
	}
}

func GeminiAPIKey() string {
	if key := strings.TrimSpace(os.Getenv("GEMINI_API_KEY")); key != "" {
		return key
	}
	path := Env("WS_GEMINI_ENV_FILE", filepath.Join(RootDir(), "..", "Viggle", "Backend", ".env"))
	return ReadEnvKey(path, "GEMINI_API_KEY")
}

func ReadEnvKey(path, key string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	prefix := key + "="
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimPrefix(strings.TrimSpace(scanner.Text()), "export ")
		if strings.HasPrefix(line, "#") || !strings.HasPrefix(line, prefix) {
			continue
		}
		return strings.Trim(strings.TrimSpace(strings.TrimPrefix(line, prefix)), `"'`)
	}
	return ""
}

func LoadDotEnv() {
	path := Env("WS_ENV_FILE", filepath.Join(RootDir(), ".env"))
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	loaded := 0
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
		if len(val) >= 2 && (val[0] == '"' || val[0] == '\'') && val[len(val)-1] == val[0] {
			val = val[1 : len(val)-1]
		}
		if _, present := os.LookupEnv(key); present {
			continue
		}
		os.Setenv(key, val)
		loaded++
	}
	if loaded > 0 {
		log.Printf("loaded %d vars from %s", loaded, path)
	}
}

func RootDir() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	if filepath.Base(wd) == "server" {
		return filepath.Dir(wd)
	}
	return wd
}

func Env(name, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func EnvBool(name string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func EnvFloat(name string, fallback float64) float64 {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func ClampIntString(value, fallback string, min, max int) string {
	out := fallback
	if s := strings.TrimSpace(value); s != "" {
		out = s
	}
	if n, err := strconv.Atoi(out); err == nil && n > 0 {
		return strconv.Itoa(ClampInt(n, min, max))
	}
	return fallback
}

func ClampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
