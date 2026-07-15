package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"os"
	"path/filepath"
	"worldsketch/server/internal/config"
	"worldsketch/server/internal/httpx"
	"worldsketch/server/internal/imagegen"
	"worldsketch/server/internal/prompts"
	"worldsketch/server/internal/storage"
	"worldsketch/server/internal/tripo"
)

func Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/new-output", NewOutput)
	mux.HandleFunc("/api/generate", Generate)
	mux.HandleFunc("/api/config", Config)
	mux.HandleFunc("/api/scene-boxes", SceneBoxes)
}

// SceneBoxes returns Gemini-detected 2D object boxes over a generated scene image.
// The result is cached beside the output (scene-boxes.json) so replays cost nothing.
func SceneBoxes(w http.ResponseWriter, r *http.Request) {
	index := strings.TrimSpace(r.URL.Query().Get("output"))
	if index == "" || strings.ContainsAny(index, "/\\.") {
		http.Error(w, "bad output index", http.StatusBadRequest)
		return
	}
	dir := storage.OutputSubdir(index)
	cache := filepath.Join(dir, "scene-boxes.json")
	if data, err := os.ReadFile(cache); err == nil && json.Valid(data) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(data)
		return
	}
	img, err := os.ReadFile(filepath.Join(dir, "scene-output.png"))
	if err != nil {
		http.Error(w, "no scene image for that output", http.StatusNotFound)
		return
	}
	model := config.Env("WS_GEMINI_BOXES_MODEL", "gemini-2.5-flash")
	tBoxes := time.Now()
	raw, err := imagegen.GeminiText(prompts.SceneBoxes(), img, model)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	raw = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(raw), "```json"), "```"))
	var boxes []map[string]any
	if err := json.Unmarshal([]byte(raw), &boxes); err != nil {
		log.Printf("scene-boxes: %v (raw: %.300s)", err, raw)
		http.Error(w, "unparseable box response", http.StatusBadGateway)
		return
	}
	data, _ := json.Marshal(boxes)
	log.Printf("[timing] boxes    model=%s n=%d took=%s", model, len(boxes), time.Since(tBoxes).Round(time.Millisecond))
	if err := os.WriteFile(cache, data, 0o644); err != nil {
		log.Printf("scene-boxes cache: %v", err)
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(data)
}

func NewOutput(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name, _, err := storage.AllocateOutput()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"index": name})
}

func Config(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"scene": sceneClientConfig(),
	})
}

func sceneClientConfig() map[string]any {
	return map[string]any{
		"yOffset":           config.EnvFloat("WS_SCENE_Y_OFFSET", 0),
		"opacityFloor":      config.EnvFloat("WS_SCENE_OPACITY_FLOOR", 0.03),
		"yaw":               config.EnvFloat("WS_SCENE_YAW", 0),
		"fitBboxPercentile": config.EnvFloat("WS_SCENE_FIT_BBOX_PERCENTILE", 0),
		"semanticImage":     config.EnvBool("WS_SCENE_SEMANTIC_IMAGE", false),
	}
}

func Generate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseMultipartForm(48 << 20); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	prompt := strings.TrimSpace(r.FormValue("prompt"))
	const name = "scene"
	dir := storage.OutputSubdir(r.FormValue("output"))

	file, _, err := r.FormFile("image")
	if err != nil {
		http.Error(w, "missing image", http.StatusBadRequest)
		return
	}
	defer file.Close()
	image, err := io.ReadAll(io.LimitReader(file, 20<<20))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	materialImage, err := httpx.ReadOptionalFormFile(r, "material_image", 20<<20)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	promptText := prompts.Scene(prompt)
	imageSettings := config.SceneImageEditSettings()

	tImage := time.Now()
	edited := image
	if imageSettings.SkipImageEdit {
		storage.SaveGeneration(dir, name, image, materialImage, edited, prompt)
	} else {
		switch strings.ToLower(imageSettings.Provider) {
		case "gemini":
			edited, err = imagegen.GeminiEdit(image, materialImage, promptText, imageSettings.GeminiModel)
		default:
			edited, err = imagegen.OpenAIEdit(image, materialImage, promptText, imageSettings)
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		storage.SaveGeneration(dir, name, image, materialImage, edited, prompt)
	}

	imageDur := time.Since(tImage)
	tripoSettings := config.SceneTripoSettings()
	tTripo := time.Now()
	splat, err := tripo.Generate(edited, tripoSettings)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	tripoDur := time.Since(tTripo)
	log.Printf("[timing] %-8s image=%-7s tripo=%-7s total=%s", name,
		imageDur.Round(time.Millisecond), tripoDur.Round(time.Millisecond), (imageDur + tripoDur).Round(time.Millisecond))
	storage.SaveSplat(dir, name, splat)

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s.splat"`, name))
	_, _ = w.Write(splat)
}
