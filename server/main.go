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
	// One world is generated object-by-object: the client allocates an output
	// folder once (/api/new-output) and then POSTs /api/generate per object/floor.
	mux.HandleFunc("/api/new-output", handleNewOutput)
	mux.HandleFunc("/api/generate", handleGenerate)
	mux.Handle("/", http.FileServer(http.Dir(filepath.Join(rootDir(), "client"))))

	addr := env("PORT", "8067")
	log.Printf("WorldSketch listening on http://localhost:%s", addr)
	log.Fatal(http.ListenAndServe(":"+addr, mux))
}

// handleNewOutput allocates the next outputs/NNNN folder and returns its index, so
// every object + the floor of one world generation land together under it.
func handleNewOutput(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name, _, err := allocateOutput()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"index": name})
}

// handleGenerate re-textures a single isolated subject (one object, or the floor)
// and reconstructs it with TripoSplat. The client captures each subject alone on a
// black background from a consistent pose, so Tripo's output orientation is
// consistent and the client seats it by bounding box — no per-object pose recovery.
func handleGenerate(w http.ResponseWriter, r *http.Request) {
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
	if kind != "floor" {
		kind = "object"
	}
	groundColor := strings.TrimSpace(r.FormValue("ground_color"))
	name := sanitizeName(r.FormValue("name"))
	dir := outputSubdir(r.FormValue("output"))

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

	promptText := imagePromptFor(kind, prompt, groundColor)

	edited := image
	if envBool("WS_SKIP_IMAGE_EDIT", envBool("WS_SKIP_OPENAI", false)) {
		// Image edit skipped: the raw block-out screenshot is fed straight to Tripo.
		// Still record the (input -> output) pair so the screenshot is always saved.
		saveGeneration(dir, name, image, materialImage, edited, prompt)
	} else {
		// Re-texture the block-out. WS_IMAGE_PROVIDER picks the backend: "openai"
		// (gpt-image-1-mini, default — the cheap path) or "gemini" (2.5 Flash Image).
		// Both run the same promptText + image inputs so they are an apples-to-apples A/B.
		model, fidelity := imageModelFor(kind)
		switch strings.ToLower(env("WS_IMAGE_PROVIDER", "openai")) {
		case "gemini":
			edited, err = geminiEdit(image, materialImage, promptText)
		default:
			edited, err = openAIEdit(image, materialImage, promptText, model, fidelity)
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		saveGeneration(dir, name, image, materialImage, edited, prompt)
	}

	splat, err := tripoGenerate(edited, tripoSteps(r.FormValue("steps")), tripoGaussians(r.FormValue("gaussians")))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	saveSplat(dir, name, splat)

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s.splat"`, name))
	_, _ = w.Write(splat)
}

// imageModelFor picks the OpenAI image model + input fidelity per subject. The floor
// is the one subject we don't skimp on — it uses the full gpt-image-1 with high input
// fidelity so the painted terrain layout is preserved precisely. Objects use the cheap
// gpt-image-1-mini (which ignores fidelity). All overridable via env.
func imageModelFor(kind string) (string, string) {
	if kind == "floor" {
		return env("WS_FLOOR_IMAGE_MODEL", "gpt-image-1"), env("WS_FLOOR_IMAGE_FIDELITY", "high")
	}
	return env("WS_IMAGE_MODEL", "gpt-image-1-mini"), env("WS_IMAGE_FIDELITY", "low")
}

func openAIEdit(image, materialImage []byte, promptText, model, fidelity string) ([]byte, error) {
	key := os.Getenv("OPENAI_API_KEY")
	if key == "" {
		return nil, errors.New("OPENAI_API_KEY is not set")
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	mustField(writer, "model", model)
	mustField(writer, "size", env("WS_IMAGE_SIZE", "1024x1024"))
	mustField(writer, "prompt", promptText)
	optField(writer, "quality", env("WS_IMAGE_QUALITY", "low"))
	// input_fidelity is ONLY supported by the full gpt-image-1 model — gpt-image-1-mini
	// (and gpt-image-1.5 / gpt-image-2) reject it. Only send it for the full model, so
	// the default mini object path never passes it. On full gpt-image-1 (the floor), high
	// fidelity preserves the painted terrain layout (but adds ~4160 input tokens/image).
	if strings.EqualFold(model, "gpt-image-1") {
		optField(writer, "input_fidelity", fidelity)
	}
	optField(writer, "background", env("WS_IMAGE_BACKGROUND", "opaque"))
	optField(writer, "output_format", env("WS_IMAGE_FORMAT", "png"))

	images := []struct {
		name string
		data []byte
	}{
		{name: "guide.png", data: image},
	}
	if len(materialImage) > 0 {
		images = append(images, struct {
			name string
			data []byte
		}{name: "materials.png", data: materialImage})
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

	if b64 := findString(parsed, "b64_json", "image_base64", "base64"); b64 != "" {
		return base64.StdEncoding.DecodeString(stripDataURL(b64))
	}
	if url := findString(parsed, "url"); url != "" {
		return fetchBytes(url)
	}
	return nil, errors.New("openai image edit returned no image")
}

// geminiEdit re-textures the block-out with Gemini 2.5 Flash Image (the default
// backend). Same promptText + image inputs as openAIEdit; the key is sourced via
// geminiAPIKey (env or the Viggle .env).
func geminiEdit(image, materialImage []byte, promptText string) ([]byte, error) {
	key := geminiAPIKey()
	if key == "" {
		return nil, errors.New("GEMINI_API_KEY is not set (and not found in the Viggle backend .env)")
	}
	model := env("WS_GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image")

	// Parts: the prompt, then the geometry guide, then the optional material-ID map —
	// same order/role the prompt text refers to as "Image 1" / "Image 2".
	parts := []map[string]any{
		{"text": promptText},
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
			return base64.StdEncoding.DecodeString(p.InlineData.Data)
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

// allocateOutput creates the next outputs/NNNN folder (zero-padded, one per world
// generation) and returns its name + absolute path.
func allocateOutput() (string, string, error) {
	root := outputsRoot()
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", "", err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", "", err
	}
	max := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if n, err := strconv.Atoi(e.Name()); err == nil && n > max {
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

func outputsRoot() string {
	return env("WS_OUTPUT_DIR", filepath.Join(rootDir(), "outputs"))
}

// outputSubdir resolves the per-world folder the client allocated; falls back to a
// fresh timestamped folder if the index is missing (e.g. a direct API hit).
func outputSubdir(index string) string {
	index = sanitizeName(index)
	if index == "" {
		index = time.Now().Format("20060102-150405")
	}
	return filepath.Join(outputsRoot(), index)
}

// saveGeneration writes the block-out guide, the re-textured output, the optional
// material map, and the prompt into the world's output folder, so the (input,
// prompt -> output) pairs can be collected. Failures are logged, never fatal.
func saveGeneration(dir, name string, input, materialInput, output []byte, prompt string) {
	if !envBool("WS_SAVE_GENERATIONS", true) {
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

// saveSplat writes the raw Tripo splat next to its generation pair so a world can be
// re-inspected later. Failures are logged, never fatal.
func saveSplat(dir, name string, splat []byte) {
	if !envBool("WS_SAVE_GENERATIONS", true) {
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

// tripoSteps resolves the diffusion step count for this subject. The client sizes it
// by object volume (tiny rocks get a cheap 2-3 steps), passed in the "steps" field;
// it falls back to WS_TRIPO_STEPS and is clamped to a sane range.
func tripoSteps(field string) string {
	steps := env("WS_TRIPO_STEPS", "24")
	if s := strings.TrimSpace(field); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 {
			steps = strconv.Itoa(clampInt(n, 1, 64))
		}
	}
	return steps
}

// tripoGaussians resolves the gaussian count. The client pins objects to the minimum
// (2^15) to keep the modular many-subject world cheap; the field falls back to
// WS_TRIPO_GAUSSIANS (used by the floor, which sends none) and is clamped sane.
func tripoGaussians(field string) string {
	gaussians := env("WS_TRIPO_GAUSSIANS", "32768")
	if s := strings.TrimSpace(field); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 {
			gaussians = strconv.Itoa(clampInt(n, 1024, 262144))
		}
	}
	return gaussians
}

func tripoGenerate(image []byte, steps, gaussians string) ([]byte, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	mustField(writer, "seed", "42") // fixed seed so generations are reproducible
	mustField(writer, "steps", steps)
	mustField(writer, "preprocess", "true")
	mustField(writer, "guidance_scale", env("WS_TRIPO_GUIDANCE", "7"))
	mustField(writer, "num_gaussians", gaussians)
	mustField(writer, "output_format", env("WS_TRIPO_FORMAT", "splat"))

	part, err := createPNGFormFile(writer, "image", "subject.png")
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

// imagePromptFor picks the re-texturing prompt for the subject kind. Both isolate the
// subject on a pure-black background (the client captures it that way) so the only
// thing Tripo reconstructs is the subject — no hallucinated backdrop to fight.
func imagePromptFor(kind, userPrompt, groundColor string) string {
	scene := strings.TrimSpace(userPrompt)
	if scene == "" {
		scene = "a coherent stylized natural game environment"
	}
	if kind == "floor" {
		return floorPrompt(scene, groundColor)
	}
	return objectPrompt(scene)
}

func objectPrompt(scene string) string {
	return "Re-texture this isometric block-out of a SINGLE object, shown alone on a pure black background, into one high-fidelity, photorealistic object for Gaussian-splat reconstruction. Change MATERIALS and surface detail ONLY. Image 1 is the strict geometry guide: the light edge lines mark its silhouette and structure. Image 2, when provided, is a flat unlit material-ID map — surfaces sharing the same flat colour in Image 2 must stay the same material family and the same general hue/tone in the output. Treat the block-out as a STRICT geometric reference: keep the exact size, height, thickness, footprint, proportions, silhouette, and pose of every part. Do NOT move, add, remove, resize, inflate, thicken, or reimagine anything, and do NOT change any object's aspect ratio. Keep the background PURE BLACK with the object floating on it: no ground plane, no floor, no grass, no base slab, no shadow, no contact shadow, no ambient-occlusion blob, no backdrop, no scenery, no sky, no horizon, no fog. Detail the side that faces the camera (the front) precisely; the unseen back may be left plain and simple. Render as flat, evenly-lit albedo/reference material with fully ambient illumination: no cast shadows, no directional sunlight, no dramatic or rim lighting. Replace flat primitive materials with believable, detailed natural materials while matching the original hues. No UI, text, frames, borders, or camera-angle change. Crucially, this is ONE single object, NOT a scene: interpret it as a single individual object you would find in the setting described below, and texture only this one object to match that world's style, materials, and palette. Do NOT depict the scene itself — no environment, landscape, terrain, ground, water, sky, buildings, or any additional objects; render exactly the one object in the block-out and nothing else. Interpret this object as something found in: " + scene
}

func floorPrompt(scene, groundColor string) string {
	ground := ""
	if groundColor != "" {
		ground = " The ground/baseplate input colour is " + groundColor + "; preserve that ground hue and material category. If it is sandy, tan, yellow, beige, orange, or brown, the ground must become sand, dry soil, clay, stone, or desert terrain, never green grass. If it is green, use grass, moss, or foliage in that same green tone."
	}
	return "Re-texture this near top-down view of a single flat, square ground tile into a high-fidelity, photorealistic terrain surface for Gaussian-splat reconstruction. The ground stays a single LEVEL surface at one height — NO hills, mounds, dunes, ridges, raised banks, embankments, slopes, terraces, plateaus, cliffs, craters, or other large 3D landforms; the overall plane does not rise or dip. Shallow SURFACE TEXTURE and natural detail are very welcome and encouraged, though: grass blades, moss, scattered pebbles, small stones, dirt clods, twigs, leaves, cracks, and fine material grain make the ground lively and dynamic — just keep that detail as a thin textured skin on the flat plane, never built up into raised terrain. Rivers, paths, and ponds read as essentially flat changes of colour and material: a river or pond water surface sits flush and level (not a deep carved canyon, not raised banks), and a path is flush with the surrounding grass. The tile itself is a thin flat slab — never a tall block, plinth, wall, or pedestal — and a perfect square with straight edges and square corners. Change MATERIALS and surface detail ONLY, preserving the exact square footprint. The square must FILL the canvas: its corners reach the image edges with NO empty padding, NO transparent margin, and NO border between the tile and the image edge (the splat is scaled to the canvas, so any padding breaks scale alignment with the colliders). Image 1 is the geometry guide. Image 2, when provided, is a flat painted material-ID map: treat the painted regions as TERRAIN INTENT and blend them naturally into the surrounding ground — BLUE marks water (a flat river, stream, or pond), BROWN or TAN marks a dirt path or sand, GREY or DARK marks rock or stone, GREEN marks grass or moss." + ground + " The ground material and colour must be UNIFORM all the way to the four edges (except where painted terrain runs off an edge): no color shift, no fade, no darker rim, no vignette, no detail bunching, so adjacent tiles tile seamlessly. Render as flat, evenly-lit albedo with fully ambient illumination: no cast shadows, no directional sunlight, no dramatic lighting (fine surface texture and shallow material detail are welcome — just avoid shading that reads as hills or raised landforms). The area outside the square tile must be pure black and empty: no background, no walls, no sky, no scenery. No UI, text, frames, or camera-angle change. Scene context: " + scene
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

// sanitizeName reduces a client-supplied folder/file label to a safe basename so the
// output index/name can never escape the outputs root.
func sanitizeName(s string) string {
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

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
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
