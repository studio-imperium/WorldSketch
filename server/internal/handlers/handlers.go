package handlers

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"worldsketch/server/internal/config"
	"worldsketch/server/internal/httpx"
	"worldsketch/server/internal/imagegen"
	"worldsketch/server/internal/palette"
	"worldsketch/server/internal/prompts"
	"worldsketch/server/internal/storage"
	"worldsketch/server/internal/tripo"
)

func Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/new-output", NewOutput)
	mux.HandleFunc("/api/generate", Generate)
	mux.HandleFunc("/api/floor-texture", FloorTexture)
	mux.HandleFunc("/api/ground", Ground)
	mux.HandleFunc("/api/identify", Identify)
	mux.HandleFunc("/api/plan", Plan)
	mux.HandleFunc("/api/plan-objects", PlanObjects)
	mux.HandleFunc("/api/config", Config)
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
		"singleObject":   config.EnvBool("WS_SINGLE_OBJECT", false),
		"objectsOnly":    config.EnvBool("WS_OBJECTS_ONLY", false),
		"floorOnly":      config.EnvBool("WS_FLOOR_ONLY", false),
		"identifyOnly":   config.EnvBool("WS_IDENTIFY_ONLY", false),
		"genConcurrency": config.EnvFloat("WS_GEN_CONCURRENCY", 4),
		"object":         subjectClientConfig("object"),
		"floor":          subjectClientConfig("floor"),
		"scene":          subjectClientConfig("scene"),
	})
}

func subjectClientConfig(kind string) map[string]any {
	palette := config.SubjectPaletteSettings(kind)
	yOffsetLegacy := []string{}
	if kind == "object" {
		yOffsetLegacy = []string{"WS_CULL_Y_OFFSET"}
	}
	return map[string]any{
		"yOffset":           config.SubjectEnvFloat(kind, "Y_OFFSET", yOffsetLegacy, 0),
		"opacityFloor":      config.SubjectEnvFloat(kind, "OPACITY_FLOOR", []string{"WS_OPACITY_FLOOR"}, 0.03),
		"paletteLock":       palette.Mode == "lock",
		"paletteStrength":   palette.Strength,
		"paletteLightness":  palette.Lightness,
		"yaw":               config.SubjectEnvFloat(kind, "YAW", nil, 0),
		"fitClampK":         config.SubjectEnvFloat(kind, "FIT_CLAMP_K", []string{"WS_FIT_CLAMP_K"}, 0),
		"fitBboxPercentile": config.SubjectEnvFloat(kind, "FIT_BBOX_PERCENTILE", []string{"WS_FIT_BBOX_PERCENTILE"}, 0),
		"fillOverscale":     config.SubjectEnvFloat(kind, "FILL_OVERSCALE", nil, 1.08),
		"reliefDip":         config.SubjectEnvFloat(kind, "RELIEF_DIP", nil, 0.35),
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
	kind := strings.ToLower(strings.TrimSpace(r.FormValue("kind")))
	if kind != "floor" && kind != "scene" {
		kind = "object"
	}
	groundColor := strings.TrimSpace(r.FormValue("ground_color"))
	name := storage.SanitizeName(r.FormValue("name"))
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

	hasGround := true // backwards-compatible default for older clients
	if kind == "scene" {
		hasGround = config.ParseBoolDefault(r.FormValue("has_ground"), true)
	}
	objectCount := -1
	if value := strings.TrimSpace(r.FormValue("object_count")); value != "" {
		if parsed, parseErr := strconv.Atoi(value); parseErr == nil && parsed >= 0 {
			objectCount = parsed
		}
	}
	promptText := prompts.ImageFor(kind, prompt, groundColor, strings.TrimSpace(r.FormValue("label")), hasGround, objectCount)
	imageSettings := config.SubjectImageEditSettings(kind)
	if config.ParseBoolDefault(r.FormValue("skip_image_edit"), false) {
		imageSettings.SkipImageEdit = true
	}

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
		edited = applyPalette(kind, image, nil, edited, r.FormValue("colors"), "palette match skipped for "+name)
		storage.SaveGeneration(dir, name, image, materialImage, edited, prompt)
	}

	imageDur := time.Since(tImage)
	tripoSettings := config.SubjectTripoSettings(kind, r.FormValue("steps"), r.FormValue("gaussians"))
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

func FloorTexture(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	prompt := strings.TrimSpace(r.FormValue("prompt"))
	groundColor := strings.TrimSpace(r.FormValue("ground_color"))
	name := storage.SanitizeName(r.FormValue("name"))
	if name == "" {
		name = "floor-texture"
	}
	dir := storage.OutputSubdir(r.FormValue("output"))

	file, _, err := r.FormFile("image")
	if err != nil {
		http.Error(w, "missing image", http.StatusBadRequest)
		return
	}
	image, err := io.ReadAll(io.LimitReader(file, 20<<20))
	file.Close()
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	settings := config.SubjectImageEditSettings("floor")
	promptText := prompts.FloorTexture(prompt, groundColor, false)

	tImage := time.Now()
	edited := image
	if !settings.SkipImageEdit {
		edited, err = imagegen.GeminiEdit(image, nil, promptText, settings.GeminiModel)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		edited = applyPalette("floor", image, nil, edited, r.FormValue("colors"), "floor texture palette match skipped for "+name)
	}
	storage.SaveGeneration(dir, name+"-topdown", image, nil, edited, promptText)
	log.Printf("[timing] %-8s texture=%s", name, time.Since(tImage).Round(time.Millisecond))

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s.png"`, name))
	_, _ = w.Write(edited)
}

func Ground(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseMultipartForm(48 << 20); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	prompt := strings.TrimSpace(r.FormValue("prompt"))
	groundColor := strings.TrimSpace(r.FormValue("ground_color"))
	name := storage.SanitizeName(r.FormValue("name"))
	if name == "" {
		name = "floor"
	}
	dir := storage.OutputSubdir(r.FormValue("output"))
	cols := config.AtoiDefault(r.FormValue("cols"), 1)
	rows := config.AtoiDefault(r.FormValue("rows"), 1)

	file, _, err := r.FormFile("image")
	if err != nil {
		http.Error(w, "missing image", http.StatusBadRequest)
		return
	}
	image, err := io.ReadAll(io.LimitReader(file, 24<<20))
	file.Close()
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	mask, err := httpx.ReadOptionalFormFile(r, "mask", 24<<20)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	settings := config.SubjectImageEditSettings("floor")
	if size := config.OpenAIGroundSize(r.FormValue("image_size")); size != "" {
		settings.Size = size
	}
	// texture_only: generate the cohesive TOP-DOWN terrain texture and stop — no splat
	// step. The client slices it per tile and reconstructs each slice separately.
	textureOnly := config.ParseBoolDefault(r.FormValue("texture_only"), false)
	promptText := prompts.Ground(prompt, groundColor, len(mask) > 0)
	if textureOnly {
		promptText = prompts.FloorTexture(prompt, groundColor, len(mask) > 0)
	}

	tImage := time.Now()
	edited := image
	if settings.SkipImageEdit {
		storage.SaveGeneration(dir, name, image, nil, edited, promptText)
	} else {
		edited, err = imagegen.OpenAIGround(image, mask, promptText, settings)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		edited = applyPalette("floor", image, mask, edited, r.FormValue("colors"), "ground palette match skipped")
		storage.SaveGeneration(dir, name, image, mask, edited, promptText)
	}
	imageDur := time.Since(tImage)

	if textureOnly {
		log.Printf("[timing] %-8s texture=%-7s tiles=%dx%d", name, imageDur.Round(time.Millisecond), cols, rows)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"image": base64.StdEncoding.EncodeToString(edited),
		})
		return
	}

	tripoSettings := config.SubjectTripoSettings("floor", "", "")
	tripoSettings.Gaussians = config.GroundGaussians(cols * rows)
	tripoSettings.Steps = config.GroundSteps(cols * rows)
	tTripo := time.Now()
	splat, err := tripo.Generate(edited, tripoSettings)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	tripoDur := time.Since(tTripo)
	log.Printf("[timing] %-8s image=%-7s tripo=%-7s total=%s tiles=%dx%d gaussians=%s", name,
		imageDur.Round(time.Millisecond), tripoDur.Round(time.Millisecond), (imageDur + tripoDur).Round(time.Millisecond), cols, rows, tripoSettings.Gaussians)
	storage.SaveSplat(dir, name, splat)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"image": base64.StdEncoding.EncodeToString(edited),
		"splat": base64.StdEncoding.EncodeToString(splat),
	})
}

func Identify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseMultipartForm(48 << 20); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	scene := strings.TrimSpace(r.FormValue("prompt"))
	count := config.AtoiDefault(r.FormValue("count"), 1)
	if count < 1 {
		count = 1
	}
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

	raw, err := imagegen.GeminiIdentify(image, prompts.Identify(scene, count))
	labels, ground := prompts.ParseIdentify(raw)
	if err != nil {
		raw = "identify error: " + err.Error()
		labels = map[string]string{}
		ground = ""
		log.Printf("identify: %v", err)
	}
	storage.SaveIdentify(dir, image, raw, labels, ground)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"labels": labels, "ground": ground, "raw": raw})
}

// --- Scene planning -----------------------------------------------------------
// POST /api/plan { prompt } → a validated block-out plan the editor applies directly:
// plots (grid cells + heights), blocks (axis-aligned boxes), and a base ground colour.

type planPlot struct {
	IX     int     `json:"ix"`
	IZ     int     `json:"iz"`
	Height float64 `json:"height"`
}

type planBlock struct {
	X     float64 `json:"x"`
	Z     float64 `json:"z"`
	Y     float64 `json:"y"`
	SX    float64 `json:"sx"`
	SY    float64 `json:"sy"`
	SZ    float64 `json:"sz"`
	Yaw   float64 `json:"yaw"`
	Color string  `json:"color"`
}

type scenePlan struct {
	Plots  []planPlot  `json:"plots"`
	Ground string      `json:"ground"`
	Blocks []planBlock `json:"blocks"`
}

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func clampF(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// parseScenePlan strips code fences, unmarshals, and clamps everything into safe
// editor ranges so a creative model response can never wreck the client world.
func parseScenePlan(raw string) (scenePlan, error) {
	s := strings.TrimSpace(raw)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	s = strings.TrimSpace(s)

	var plan scenePlan
	if err := json.Unmarshal([]byte(s), &plan); err != nil {
		return plan, fmt.Errorf("plan is not valid JSON: %w", err)
	}

	// Plots: ints in a sane radius, deduped, capped, always including the origin cell.
	seen := map[[2]int]bool{}
	plots := []planPlot{}
	for _, p := range plan.Plots {
		if p.IX < -6 || p.IX > 6 || p.IZ < -6 || p.IZ > 6 {
			continue
		}
		key := [2]int{p.IX, p.IZ}
		if seen[key] {
			continue
		}
		seen[key] = true
		p.Height = clampF(p.Height, -4, 6)
		plots = append(plots, p)
		if len(plots) >= 6 {
			break
		}
	}
	if !seen[[2]int{0, 0}] {
		plots = append([]planPlot{{IX: 0, IZ: 0, Height: 0}}, plots...)
	}
	plan.Plots = plots

	if !hexColor.MatchString(plan.Ground) {
		plan.Ground = ""
	}

	blocks := plan.Blocks
	if len(blocks) > 60 {
		blocks = blocks[:60]
	}
	kept := blocks[:0]
	for _, b := range blocks {
		// Drop blocks nowhere near any plot (2-unit slack for edge-huggers); clamp the
		// rest into editor-safe ranges. The client snaps stragglers onto the nearest tile.
		near := false
		for _, p := range plan.Plots {
			if clampF(b.X, float64(p.IX)*16-10, float64(p.IX)*16+10) == b.X && clampF(b.Z, float64(p.IZ)*16-10, float64(p.IZ)*16+10) == b.Z {
				near = true
				break
			}
		}
		if !near {
			continue
		}
		b.SX = clampF(b.SX, 0.15, 12)
		b.SY = clampF(b.SY, 0.15, 12)
		b.SZ = clampF(b.SZ, 0.15, 12)
		b.Y = clampF(b.Y, 0, 24)
		if !hexColor.MatchString(b.Color) {
			b.Color = "#9b9b9b"
		}
		kept = append(kept, b)
	}
	plan.Blocks = kept
	if len(plan.Blocks) == 0 {
		return plan, errors.New("plan contained no usable blocks")
	}
	return plan, nil
}

// --- Deterministic sketch planning ---------------------------------------------
// POST /api/plan-objects { prompt, footprints, image } → per-numbered-object designs
// in LOCAL frames. The client found the stroke-objects, numbered them on the image,
// and places the returned designs at the exact drawn positions itself — the model
// never decides layout, only what each object is and how it's built.

type sketchObjectDesign struct {
	Label  string      `json:"label"`
	Blocks []planBlock `json:"blocks"`
}

type sketchObjectsPlan struct {
	Ground  string                        `json:"ground"`
	Objects map[string]sketchObjectDesign `json:"objects"`
}

func parseSketchObjectsPlan(raw string) (sketchObjectsPlan, error) {
	s := strings.TrimSpace(raw)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	s = strings.TrimSpace(s)

	var plan sketchObjectsPlan
	if err := json.Unmarshal([]byte(s), &plan); err != nil {
		return plan, fmt.Errorf("object designs are not valid JSON: %w", err)
	}
	if !hexColor.MatchString(plan.Ground) {
		plan.Ground = ""
	}
	total := 0
	for n, obj := range plan.Objects {
		blocks := obj.Blocks
		if len(blocks) > 12 { // prompt asks for 6-12 boxes per object
			blocks = blocks[:12]
		}
		kept := blocks[:0]
		for _, b := range blocks {
			b.X = clampF(b.X, -12, 12) // local offsets from the object's footprint centre
			b.Z = clampF(b.Z, -12, 12)
			b.Y = clampF(b.Y, 0, 24)
			b.SX = clampF(b.SX, 0.15, 12)
			b.SY = clampF(b.SY, 0.15, 12)
			b.SZ = clampF(b.SZ, 0.15, 12)
			if !hexColor.MatchString(b.Color) {
				b.Color = "#9b9b9b"
			}
			kept = append(kept, b)
		}
		obj.Blocks = kept
		plan.Objects[n] = obj
		total += len(kept)
	}
	if total == 0 {
		return plan, errors.New("object designs contained no usable blocks")
	}
	return plan, nil
}

func PlanObjects(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_ = r.ParseMultipartForm(16 << 20)
	scene := strings.TrimSpace(r.FormValue("prompt"))
	if scene == "" {
		scene = "a small cozy natural scene"
	}
	footprints := strings.TrimSpace(r.FormValue("footprints"))
	sketch, err := httpx.ReadOptionalFormFile(r, "image", 8<<20)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if len(sketch) == 0 {
		http.Error(w, "missing sketch image", http.StatusBadRequest)
		return
	}
	model := config.Env("WS_GEMINI_PLAN_MODEL", "gemini-2.5-flash")
	thinking := int(config.EnvFloat("WS_GEMINI_PLAN_THINKING", 512))

	tPlan := time.Now()
	raw, err := imagegen.GeminiText(prompts.PlanObjects(scene, footprints), sketch, model, thinking)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	plan, err := parseSketchObjectsPlan(raw)
	if err != nil {
		log.Printf("plan-objects: %v (raw: %.300s)", err, raw)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	log.Printf("[timing] plan-obj model=%s objects=%d took=%s", model, len(plan.Objects), time.Since(tPlan).Round(time.Millisecond))

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(plan)
}

func Plan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_ = r.ParseMultipartForm(16 << 20)
	scene := strings.TrimSpace(r.FormValue("prompt"))
	if scene == "" {
		scene = "a small cozy natural scene"
	}
	// Optional: the user's top-down sketch from the Draw tab (Gemini reads it directly).
	sketch, err := httpx.ReadOptionalFormFile(r, "image", 8<<20)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	model := config.Env("WS_GEMINI_PLAN_MODEL", "gemini-2.5-flash")
	// Cap the model's hidden reasoning: full default thinking costs 20-30s per plan for
	// little layout gain. 512 keeps a touch of planning depth at ~5-8s total.
	thinking := int(config.EnvFloat("WS_GEMINI_PLAN_THINKING", 512))

	tPlan := time.Now()
	raw, err := imagegen.GeminiText(prompts.Plan(scene, len(sketch) > 0), sketch, model, thinking)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	plan, err := parseScenePlan(raw)
	if err != nil {
		log.Printf("plan: %v (raw: %.300s)", err, raw)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	log.Printf("[timing] plan     model=%s plots=%d blocks=%d took=%s", model, len(plan.Plots), len(plan.Blocks), time.Since(tPlan).Round(time.Millisecond))

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(plan)
}

func applyPalette(kind string, source, mask, edited []byte, colorsCSV, logPrefix string) []byte {
	settings := config.SubjectPaletteSettings(kind)
	var matched []byte
	var err error
	switch settings.Mode {
	case "global":
		matched, err = palette.Match(source, edited, settings.Strength)
	case "lock":
		matched, err = palette.Lock(edited, mask, palette.ParseColors(colorsCSV), settings.Strength, settings.Lightness)
	default:
		return edited
	}
	if err != nil {
		log.Printf("%s: %v", logPrefix, err)
		return edited
	}
	if matched == nil {
		return edited
	}
	return matched
}
