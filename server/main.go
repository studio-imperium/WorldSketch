package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const defaultTripoURL = "http://148.153.245.160:18080"

var httpClient = &http.Client{Timeout: 180 * time.Second}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/generate-plot", handleGeneratePlot)
	mux.HandleFunc("/api/config", handleConfig)
	mux.Handle("/", http.FileServer(http.Dir(filepath.Join(rootDir(), "client"))))

	addr := env("PORT", "8067")
	log.Printf("WorldSketch listening on http://localhost:%s", addr)
	log.Fatal(http.ListenAndServe(":"+addr, mux))
}

func handleGeneratePlot(w http.ResponseWriter, r *http.Request) {
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

	materialImage, err := readOptionalFormFile(r, "material_image", 20<<20)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	edited := image
	if envBool("WS_SKIP_OPENAI", false) {
		// Image edit skipped entirely, so the raw screenshot is what's fed to Tripo.
		// The edit step normally records the (input, prompt -> output) pair; do it here
		// too so the original screenshot is always saved, not just the splat.
		saveGeneration(image, materialImage, edited, prompt)
	} else {
		// Re-texture the block-out. WS_IMAGE_PROVIDER picks the backend: "openai"
		// (gpt-image-1, default) or "gemini" (2.5 Flash Image) for an A/B on the same
		// block-out + seed. Both run the identical imagePrompt and saveGeneration.
		switch strings.ToLower(env("WS_IMAGE_PROVIDER", "openai")) {
		case "gemini":
			edited, err = geminiEdit(image, materialImage, prompt, groundColor)
		default:
			edited, err = openAIEdit(image, materialImage, prompt, groundColor)
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
	}

	splat, err := tripoGenerate(edited)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	saveSplat(splat)

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `inline; filename="plot.splat"`)
	_, _ = w.Write(splat)
}

// handleConfig exposes the splat cull/fit knobs so they can be tuned from the
// server env without rebuilding the client. Three knobs, one per pipeline stage
// (cull -> seat -> fit); the client (deriveCull in renderer.js) expands strength
// into the per-stage params. Defaults here must match the CULL defaults there.
func handleConfig(w http.ResponseWriter, r *http.Request) {
	cfg := map[string]any{
		"strength":      envFloat("WS_CULL_STRENGTH", 0),         // 0 = keep all, 1 = harshest cull
		"floorPct":      envFloat("WS_CULL_FLOOR_PCT", 0.97),     // ground-detection percentile
		"fit":           envFloat("WS_CULL_FIT", 3),              // render scale vs the plot footprint
		"orient":        envBool("WS_ORIENT", false),             // recover Tripo's arbitrary D4 pose
		"markers":       envBool("WS_ORIENT_MARKER", false),      // off-by-default fiducial fallback (symmetric scenes)
		"rotate":        envFloat("WS_SPLAT_ROTATE", 1),          // final-stage yaw: 1|2|3|4 -> 90*n deg (4 = none)
		"yOffset":       envFloat("WS_CULL_Y_OFFSET", 0.45),      // plot-local Y nudge applied after all transforms
		"floorMode":     env("WS_FIND_FLOOR_MODE", "percentile"), // floor detection (default): "percentile" (global quantile) | "surface" (robust median of column-tops) | "surface_min" (lowest exposed top)
		"floorStrength": envFloat("WS_FLOOR_CULL_STRENGTH", 1),   // strength of an analysis-only cull used JUST to measure the floor (strips backdrop/sub-ground); does NOT cull the rendered splat. 0 = measure on the full cloud
		"surfaceSigma":  envFloat("WS_FLOOR_SURFACE_SIGMA", 10),  // seat the splat's visible SURFACE on the floor: offset the seat by this many sigma of the floor gaussians' vertical radius. 0 = seat centers (ground hovers above)
		"seatFloor":     envBool("WS_SEAT_FLOOR", true),          // pin the detected floor to the plot floor plane. false = bypass ALL floor logic, just vertically-center the content (debug/test)
		"debug":         envBool("WS_CULL_DEBUG", false),
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(cfg)
}

func openAIEdit(image, materialImage []byte, userPrompt, groundColor string) ([]byte, error) {
	key := os.Getenv("OPENAI_API_KEY")
	if key == "" {
		return nil, errors.New("OPENAI_API_KEY is not set")
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	mustField(writer, "model", env("WS_IMAGE_MODEL", "gpt-image-1"))
	mustField(writer, "size", env("WS_IMAGE_SIZE", "1024x1024"))
	mustField(writer, "prompt", imagePrompt(userPrompt, groundColor))
	// Strictness knobs (gpt-image-1): high input fidelity keeps the blockout's
	// proportions and color tones; transparent background stops it from painting
	// the hallucinated backdrop wall. Set the env var empty to omit a field.
	optField(writer, "quality", env("WS_IMAGE_QUALITY", "low"))
	optField(writer, "input_fidelity", env("WS_IMAGE_FIDELITY", "high"))
	optField(writer, "background", env("WS_IMAGE_BACKGROUND", "transparent"))
	optField(writer, "output_format", env("WS_IMAGE_FORMAT", "png"))

	images := []struct {
		name string
		data []byte
	}{
		{name: "plot-guide.png", data: image},
	}
	if len(materialImage) > 0 {
		images = append(images, struct {
			name string
			data []byte
		}{name: "plot-materials.png", data: materialImage})
	}
	field := "image"
	if len(images) > 1 {
		field = "image[]"
	}
	for _, img := range images {
		part, err := createPNGFormFile(writer, field, img.name)
		if err != nil {
			return nil, err
		}
		if _, err := part.Write(img.data); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPost, "https://api.openai.com/v1/images/edits", &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", writer.FormDataContentType())

	res, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("openai image edit failed: %s", string(data))
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, err
	}

	var out []byte
	if b64 := findString(parsed, "b64_json", "image_base64", "base64"); b64 != "" {
		out, err = base64.StdEncoding.DecodeString(stripDataURL(b64))
	} else if url := findString(parsed, "url"); url != "" {
		out, err = fetchBytes(url)
	} else {
		return nil, errors.New("openai image edit returned no image")
	}
	if err != nil {
		return nil, err
	}

	saveGeneration(image, materialImage, out, userPrompt)
	return out, nil
}

// geminiEdit re-textures the block-out with Gemini 2.5 Flash Image (the gpt-image-1
// alternative). Same imagePrompt + image inputs as openAIEdit so the two are an
// apples-to-apples A/B; the key is sourced via geminiAPIKey (env or the Viggle .env).
func geminiEdit(image, materialImage []byte, userPrompt, groundColor string) ([]byte, error) {
	key := geminiAPIKey()
	if key == "" {
		return nil, errors.New("GEMINI_API_KEY is not set (and not found in the Viggle backend .env)")
	}
	model := env("WS_GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image")

	// Parts: the prompt, then the geometry guide, then the optional material-ID map —
	// same order/role the imagePrompt text refers to as "Image 1" / "Image 2".
	parts := []map[string]any{
		{"text": imagePrompt(userPrompt, groundColor)},
		{"inlineData": map[string]string{"mimeType": "image/png", "data": base64.StdEncoding.EncodeToString(image)}},
	}
	if len(materialImage) > 0 {
		parts = append(parts, map[string]any{"inlineData": map[string]string{"mimeType": "image/png", "data": base64.StdEncoding.EncodeToString(materialImage)}})
	}
	payload, err := json.Marshal(map[string]any{
		"contents":         []map[string]any{{"role": "user", "parts": parts}},
		"generationConfig": map[string]any{"responseModalities": []string{"TEXT", "IMAGE"}},
	})
	if err != nil {
		return nil, err
	}

	url := "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", key)

	res, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("gemini image edit failed: %s", string(data))
	}

	var parsed struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					InlineData struct {
						Data string `json:"data"`
					} `json:"inlineData"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, err
	}
	for _, c := range parsed.Candidates {
		for _, p := range c.Content.Parts {
			if p.InlineData.Data == "" {
				continue
			}
			out, err := base64.StdEncoding.DecodeString(p.InlineData.Data)
			if err != nil {
				return nil, err
			}
			saveGeneration(image, materialImage, out, userPrompt)
			return out, nil
		}
	}
	return nil, errors.New("gemini image edit returned no image")
}

// geminiAPIKey resolves the Gemini key: the GEMINI_API_KEY env wins, else it is read
// from the Viggle backend .env (the user keeps it there). Override the path with
// WS_GEMINI_ENV_FILE; the default sits beside the WorldSketch checkout.
func geminiAPIKey() string {
	if k := strings.TrimSpace(os.Getenv("GEMINI_API_KEY")); k != "" {
		return k
	}
	path := env("WS_GEMINI_ENV_FILE", filepath.Join(rootDir(), "..", "Viggle", "Backend", ".env"))
	return readEnvKey(path, "GEMINI_API_KEY")
}

// readEnvKey returns the value of key from a KEY=VALUE .env file (ignoring comments,
// an optional "export " prefix, and surrounding quotes), or "" if absent/unreadable.
func readEnvKey(path, key string) string {
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

// saveGeneration writes the block-out guide, the GPT-image output, and the
// prompt into the backend output folder so the (input, prompt -> output) pairs
// can be collected for finetuning. Failures are logged but never block a
// request.
func saveGeneration(input, materialInput, output []byte, userPrompt string) {
	if !envBool("WS_SAVE_GENERATIONS", true) {
		return
	}

	dir := env("WS_OUTPUT_DIR", filepath.Join(rootDir(), "server", "output"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("saveGeneration: mkdir %s: %v", dir, err)
		return
	}

	stamp := time.Now().Format("20060102-150405.000")
	base := filepath.Join(dir, stamp)

	files := map[string][]byte{
		base + "-input.png":  input,
		base + "-output.png": output,
		base + "-prompt.txt": []byte(userPrompt),
	}
	if len(materialInput) > 0 {
		files[base+"-materials.png"] = materialInput
	}

	for name, data := range files {
		if err := os.WriteFile(name, data, 0o644); err != nil {
			log.Printf("saveGeneration: write %s: %v", name, err)
		}
	}
}

// saveSplat writes the raw Tripo splat into the output folder so it can be
// re-uploaded to a plot (via the client "Upload splat" button) to A/B-test the
// cull/fit pipeline against a fixed input. Failures are logged, never fatal.
func saveSplat(splat []byte) {
	if !envBool("WS_SAVE_GENERATIONS", true) {
		return
	}

	dir := env("WS_OUTPUT_DIR", filepath.Join(rootDir(), "server", "output"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("saveSplat: mkdir %s: %v", dir, err)
		return
	}

	name := filepath.Join(dir, time.Now().Format("20060102-150405.000")+".splat")
	if err := os.WriteFile(name, splat, 0o644); err != nil {
		log.Printf("saveSplat: write %s: %v", name, err)
	}
}

func tripoGenerate(image []byte) ([]byte, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	mustField(writer, "seed", "42") // fixed seed so generations are reproducible
	mustField(writer, "steps", env("WS_TRIPO_STEPS", "24"))
	mustField(writer, "preprocess", "true")
	mustField(writer, "guidance_scale", env("WS_TRIPO_GUIDANCE", "7"))
	mustField(writer, "num_gaussians", env("WS_TRIPO_GAUSSIANS", "32768"))
	mustField(writer, "output_format", env("WS_TRIPO_FORMAT", "splat"))

	part, err := createPNGFormFile(writer, "image", "plot.png")
	if err != nil {
		return nil, err
	}
	if _, err := part.Write(image); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}

	base := strings.TrimRight(env("TRIPOSPLAT_URL", defaultTripoURL), "/")
	req, err := http.NewRequest(http.MethodPost, base+"/generate", &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	res, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("triposplat failed: %s", string(data))
	}

	if strings.Contains(res.Header.Get("Content-Type"), "application/json") {
		var parsed map[string]any
		if err := json.Unmarshal(data, &parsed); err != nil {
			return nil, err
		}
		if b64 := findString(parsed, "splat_base64", "file_base64", "base64", "data"); b64 != "" {
			decoded, err := base64.StdEncoding.DecodeString(stripDataURL(b64))
			if err == nil {
				return decoded, nil
			}
		}
		if url := findString(parsed, "splat_url", "file_url", "url", "output"); url != "" {
			return fetchBytes(url)
		}
		return nil, errors.New("triposplat returned json without a splat")
	}

	return data, nil
}

func imagePrompt(userPrompt, groundColor string) string {
	prompt := strings.TrimSpace(userPrompt)
	if prompt == "" {
		prompt = "a coherent stylized natural game environment"
	}
	groundInstruction := ""
	if groundColor != "" {
		groundInstruction = " The ground/baseplate input color is " + groundColor + "; preserve that ground hue and material category. If it is sandy, tan, yellow, beige, orange, or brown, the ground must become sand, dry soil, clay, stone, or desert terrain, never green grass. If it is green, use grass, moss, or foliage in that same green tone."
	}
	return "Re-texture this square isometric Three.js blockout into a single high-fidelity source image for Gaussian splatting, changing materials ONLY. Image 1 is the strict geometry guide with readable edges. Image 2, when provided, is a flat unlit material-ID map: use it to preserve material identity. Surfaces with the same flat input color in Image 2 must remain the same material family and same general hue/tone in the output, across the whole plot." + groundInstruction + " Treat the blockout as a STRICT geometric reference: every object must keep its exact size, height, thickness, footprint, and relative scale. Do NOT enlarge, thicken, inflate, or change any object's proportions or aspect ratio. The ground base is a FLAT THIN slab: keep it thin and flat, never turn it into a tall block, plinth, or pedestal. Keep the ground base a perfect square with straight edges and square corners — never round, skew, taper, rotate, or distort it. Preserve every object's position, silhouette, and the overall color tones; do not move, add, remove, resize, or reimagine objects. Material and color discipline is critical: every surface that has the same input color must remain the same material family and same general hue/tone in the output. If multiple ground/baseplate surfaces share the same green input color, make them one consistent grass material with only subtle texture variation, not different grass species, brightness levels, or color palettes. Replace flat primitive materials with believable detailed natural materials while matching the original hues. Render it as shadowless albedo/reference material: no cast shadows, no contact shadows, no ambient-occlusion blobs, no dark underside shadow plates, no directional sunlight, and no dramatic lighting. Use flat, even, fully ambient illumination so every surface is uniformly lit and the ground stays an even flat tone. The square base must FILL the canvas: its corners reach the image edges with NO empty padding, NO transparent margin, NO border between the base and the image edge — frame the scene tightly so the output base occupies the same screen footprint as the input base (this is critical: the splat is scaled to the canvas, so any added padding shrinks the world relative to the block-out and breaks scale alignment with the primitive colliders). The ground material and color must be UNIFORM all the way to the four edges of the square base — no color shift, no fade, no darker rim, no grass tufts only in the middle, no detail bunching, no vignette; the edge looks identical to the center so adjacent plots can tile seamlessly. The area outside the square base must be completely empty and transparent: no background, no walls, no sky, no horizon, no scenery, no fog, no extra ground or floor. No UI, text, frames, borders, backdrop, or camera-angle changes. Scene prompt: " + prompt
}

func readOptionalFormFile(r *http.Request, name string, maxBytes int64) ([]byte, error) {
	file, _, err := r.FormFile(name)
	if errors.Is(err, http.ErrMissingFile) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", name, err)
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, maxBytes))
	if err != nil {
		return nil, err
	}
	return data, nil
}

func mustField(writer *multipart.Writer, key, value string) {
	if err := writer.WriteField(key, value); err != nil {
		panic(err)
	}
}

// optField writes a multipart field only when the value is non-empty, so a knob
// can be disabled by setting its env var to "".
func optField(writer *multipart.Writer, key, value string) {
	if strings.TrimSpace(value) == "" {
		return
	}
	mustField(writer, key, value)
}

func createPNGFormFile(writer *multipart.Writer, field, filename string) (io.Writer, error) {
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`, field, filename))
	header.Set("Content-Type", "image/png")
	return writer.CreatePart(header)
}

func findString(value any, names ...string) string {
	nameSet := map[string]bool{}
	for _, name := range names {
		nameSet[name] = true
	}
	var walk func(any) string
	walk = func(v any) string {
		switch x := v.(type) {
		case map[string]any:
			for k, v := range x {
				if nameSet[k] {
					if s, ok := v.(string); ok && s != "" {
						return s
					}
				}
			}
			for _, v := range x {
				if s := walk(v); s != "" {
					return s
				}
			}
		case []any:
			for _, v := range x {
				if s := walk(v); s != "" {
					return s
				}
			}
		}
		return ""
	}
	return walk(value)
}

func stripDataURL(value string) string {
	if comma := strings.IndexByte(value, ','); comma >= 0 && strings.Contains(value[:comma], "base64") {
		return value[comma+1:]
	}
	return value
}

func fetchBytes(url string) ([]byte, error) {
	res, err := httpClient.Get(url)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("fetch %s failed with %d", url, res.StatusCode)
	}
	return io.ReadAll(res.Body)
}

func env(name, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func envBool(name string, fallback bool) bool {
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

func envFloat(name string, fallback float64) float64 {
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

func rootDir() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	if filepath.Base(wd) == "server" {
		return filepath.Dir(wd)
	}
	return wd
}
