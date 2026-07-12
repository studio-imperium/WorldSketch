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

type PaletteSettings struct {
	Mode      string
	Strength  float64
	Lightness float64
}

type TripoSettings struct {
	Steps     string
	Guidance  string
	Gaussians string
	Format    string
}

func SubjectImageEditSettings(kind string) ImageEditSettings {
	if kind == "floor" {
		return ImageEditSettings{
			Provider:      SubjectEnv(kind, "IMAGE_PROVIDER", []string{"WS_IMAGE_PROVIDER"}, "openai"),
			GeminiModel:   SubjectEnv(kind, "GEMINI_IMAGE_MODEL", []string{"WS_GEMINI_IMAGE_MODEL"}, "gemini-2.5-flash-image"),
			OpenAIModel:   SubjectEnv(kind, "IMAGE_MODEL", []string{"WS_FLOOR_IMAGE_MODEL", "WS_IMAGE_MODEL"}, "gpt-image-1"),
			Size:          SubjectEnv(kind, "IMAGE_SIZE", []string{"WS_IMAGE_SIZE"}, "1024x1024"),
			Quality:       SubjectEnv(kind, "IMAGE_QUALITY", []string{"WS_IMAGE_QUALITY"}, "medium"),
			Fidelity:      SubjectEnv(kind, "IMAGE_FIDELITY", []string{"WS_FLOOR_IMAGE_FIDELITY", "WS_IMAGE_FIDELITY"}, "high"),
			Background:    SubjectEnv(kind, "IMAGE_BACKGROUND", []string{"WS_IMAGE_BACKGROUND"}, "transparent"),
			Format:        SubjectEnv(kind, "IMAGE_FORMAT", []string{"WS_IMAGE_FORMAT"}, "png"),
			SkipImageEdit: SubjectSkipImageEdit(kind),
		}
	}
	return ImageEditSettings{
		Provider:      SubjectEnv(kind, "IMAGE_PROVIDER", []string{"WS_IMAGE_PROVIDER"}, "openai"),
		GeminiModel:   SubjectEnv(kind, "GEMINI_IMAGE_MODEL", []string{"WS_GEMINI_IMAGE_MODEL"}, "gemini-2.5-flash-image"),
		OpenAIModel:   SubjectEnv(kind, "IMAGE_MODEL", []string{"WS_IMAGE_MODEL"}, "gpt-image-1-mini"),
		Size:          SubjectEnv(kind, "IMAGE_SIZE", []string{"WS_IMAGE_SIZE"}, "1024x1024"),
		Quality:       SubjectEnv(kind, "IMAGE_QUALITY", []string{"WS_IMAGE_QUALITY"}, "medium"),
		Fidelity:      SubjectEnv(kind, "IMAGE_FIDELITY", []string{"WS_IMAGE_FIDELITY"}, "low"),
		Background:    SubjectEnv(kind, "IMAGE_BACKGROUND", []string{"WS_IMAGE_BACKGROUND"}, "transparent"),
		Format:        SubjectEnv(kind, "IMAGE_FORMAT", []string{"WS_IMAGE_FORMAT"}, "png"),
		SkipImageEdit: SubjectSkipImageEdit(kind),
	}
}

func SubjectSkipImageEdit(kind string) bool {
	fallback := EnvBool("WS_SKIP_IMAGE_EDIT", EnvBool("WS_SKIP_OPENAI", false))
	return SubjectEnvBool(kind, "SKIP_IMAGE_EDIT", nil, fallback)
}

func SubjectPaletteSettings(kind string) PaletteSettings {
	return PaletteSettings{
		Mode:      PaletteMode(SubjectEnv(kind, "PALETTE_MATCH", []string{"WS_PALETTE_MATCH"}, "off")),
		Strength:  SubjectEnvFloat(kind, "PALETTE_MATCH_STRENGTH", []string{"WS_PALETTE_MATCH_STRENGTH"}, 0.75),
		Lightness: SubjectEnvFloat(kind, "PALETTE_MATCH_LIGHTNESS", []string{"WS_PALETTE_MATCH_LIGHTNESS"}, 0),
	}
}

func SubjectTripoSettings(kind, stepsField, gaussiansField string) TripoSettings {
	stepsDefault := "24"
	stepsLegacy := []string{"WS_TRIPO_STEPS"}
	guidanceDefault := "7"
	guidanceLegacy := []string{"WS_TRIPO_GUIDANCE"}
	if kind == "object" {
		stepsDefault = "14"
		stepsLegacy = []string{"OBJECT_STEPS", "WS_TRIPO_STEPS"}
		guidanceDefault = "3"
		guidanceLegacy = []string{"OBJECT_GUIDANCE", "WS_TRIPO_GUIDANCE"}
	}
	return TripoSettings{
		Steps:     ClampIntString(SubjectEnv(kind, "TRIPO_STEPS", stepsLegacy, stepsField), stepsDefault, 1, 64),
		Guidance:  SubjectEnv(kind, "TRIPO_GUIDANCE", guidanceLegacy, guidanceDefault),
		Gaussians: ClampIntString(SubjectEnv(kind, "TRIPO_GAUSSIANS", []string{"WS_TRIPO_GAUSSIANS"}, gaussiansField), "32768", 1024, 262144),
		Format:    SubjectEnv(kind, "TRIPO_FORMAT", []string{"WS_TRIPO_FORMAT"}, "splat"),
	}
}

func GroundGaussians(tiles int) string {
	base := 32768
	if v := strings.TrimSpace(Env("WS_FLOOR_TRIPO_GAUSSIANS", Env("WS_TRIPO_GAUSSIANS", ""))); v != "" {
		if n, e := strconv.Atoi(v); e == nil && n > 0 {
			base = n
		}
	}
	if tiles < 1 {
		tiles = 1
	}
	mult := 1
	for mult < tiles {
		mult <<= 1
	}
	g := base * mult
	if g > 262144 {
		g = 262144
	}
	if g < 1024 {
		g = 1024
	}
	return strconv.Itoa(g)
}

func GroundSteps(tiles int) string {
	if v := strings.TrimSpace(Env("WS_FLOOR_TRIPO_STEPS", Env("WS_TRIPO_STEPS", ""))); v != "" {
		return ClampIntString(v, "24", 1, 64)
	}
	base := 24
	if tiles < 1 {
		tiles = 1
	}
	extra := 0
	for m := 1; m < tiles; m <<= 1 {
		extra += 4
	}
	return strconv.Itoa(ClampInt(base+extra, 1, 64))
}

func OpenAIGroundSize(size string) string {
	switch strings.TrimSpace(size) {
	case "1024x1024", "1536x1024", "1024x1536":
		return size
	}
	return ""
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

func EnvMaybe(name string) (string, bool) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", false
	}
	return value, true
}

func SubjectPrefix(kind string) string {
	if kind == "floor" {
		return "WS_FLOOR_"
	}
	return "WS_OBJECT_"
}

func SubjectEnv(kind, suffix string, legacy []string, fallback string) string {
	if value, ok := EnvMaybe(SubjectPrefix(kind) + suffix); ok {
		return value
	}
	for _, key := range legacy {
		if value, ok := EnvMaybe(key); ok {
			return value
		}
	}
	return fallback
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

func ParseBoolDefault(value string, fallback bool) bool {
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func SubjectEnvBool(kind, suffix string, legacy []string, fallback bool) bool {
	if value, ok := EnvMaybe(SubjectPrefix(kind) + suffix); ok {
		return ParseBoolDefault(value, fallback)
	}
	for _, key := range legacy {
		if value, ok := EnvMaybe(key); ok {
			return ParseBoolDefault(value, fallback)
		}
	}
	return fallback
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

func ParseFloatDefault(value string, fallback float64) float64 {
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func SubjectEnvFloat(kind, suffix string, legacy []string, fallback float64) float64 {
	if value, ok := EnvMaybe(SubjectPrefix(kind) + suffix); ok {
		return ParseFloatDefault(value, fallback)
	}
	for _, key := range legacy {
		if value, ok := EnvMaybe(key); ok {
			return ParseFloatDefault(value, fallback)
		}
	}
	return fallback
}

func PaletteMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "0", "false", "off", "no":
		return "off"
	case "lock", "quantize", "snap":
		return "lock"
	default:
		return "global"
	}
}

func AtoiDefault(s string, fallback int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
		return n
	}
	return fallback
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
