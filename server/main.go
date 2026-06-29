package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"io"
	"log"
	"math"
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
	mux.HandleFunc("/api/identify", handleIdentify)
	mux.HandleFunc("/api/config", handleConfig)
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

// handleConfig exposes a few runtime/debug flags to the static client, which can't read
// env itself. WS_SINGLE_OBJECT generates only the first object (skipping the floor + the
// rest); WS_IDENTIFY_ONLY runs just the Gemini identification phase and stops (logs the
// numbered graphic + labels, generates nothing).
func handleConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"singleObject":   envBool("WS_SINGLE_OBJECT", false),
		"objectsOnly":    envBool("WS_OBJECTS_ONLY", false),
		"floorOnly":      envBool("WS_FLOOR_ONLY", false),
		"identifyOnly":   envBool("WS_IDENTIFY_ONLY", false),
		"yOffset":        envFloat("WS_CULL_Y_OFFSET", 0),   // plot-local Y nudge applied to seated objects
		"genConcurrency": envFloat("WS_GEN_CONCURRENCY", 4), // subjects re-textured + reconstructed in parallel
		"opacityFloor":   envFloat("WS_OPACITY_FLOOR", 0.1), // drop gaussians below this opacity (kills wisps)
		// Splat-side palette lock: when WS_PALETTE_MATCH=lock, the client recolours the
		// reconstructed gaussians onto the block-out palette with the same strength/lightness.
		"paletteLock":      paletteMode(env("WS_PALETTE_MATCH", "off")) == "lock",
		"paletteStrength":  envFloat("WS_PALETTE_MATCH_STRENGTH", 0.75),
		"paletteLightness": envFloat("WS_PALETTE_MATCH_LIGHTNESS", 0),
		"objectYaw":        envFloat("WS_OBJECT_YAW", 0), // post-seat yaw (deg) applied to object splats
		"floorYaw":         envFloat("WS_FLOOR_YAW", 0),  // post-seat yaw (deg) applied to the floor splat
	})
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

	promptText := imagePromptFor(kind, prompt, groundColor, strings.TrimSpace(r.FormValue("label")))

	tImage := time.Now()
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
		// Pull the re-textured image back toward the block-out's own palette. Two modes:
		//   "global" — whole-image Reinhard transfer in CIELAB; fixes the overall colour
		//              cast but can't correct a local region (a pink trunk survives).
		//   "lock"   — snap every pixel's hue/chroma to the nearest block-out palette
		//              colour, keeping ONLY the model's brightness. Kills all hue drift.
		// Off / false / "" disables it. (WS_PALETTE_MATCH=1/true still means "global".)
		strength := envFloat("WS_PALETTE_MATCH_STRENGTH", 0.75)
		var matched []byte
		var perr error
		switch paletteMode(env("WS_PALETTE_MATCH", "off")) {
		case "global":
			matched, perr = paletteMatch(image, edited, strength)
		case "lock":
			// Lock the generated hues to the object's exact primitive colours (sent by the
			// client). WS_PALETTE_MATCH_LIGHTNESS in [0,1] additionally pulls each pixel's
			// lightness toward its matched flat palette colour's brightness (0 = keep the
			// model's lightness, 1 = flat onto the palette colour). No palette = no-op.
			matched, perr = paletteLock(edited, parsePaletteColors(r.FormValue("colors")), strength, envFloat("WS_PALETTE_MATCH_LIGHTNESS", 0))
		}
		if perr != nil {
			log.Printf("palette match skipped for %s: %v", name, perr)
		} else if matched != nil {
			edited = matched
		}
		saveGeneration(dir, name, image, materialImage, edited, prompt)
	}

	imageDur := time.Since(tImage)

	// Objects are cheap, fixed-budget subjects (OBJECT_STEPS/OBJECT_GUIDANCE); the floor
	// keeps the client-sized steps + the global guidance.
	steps := tripoSteps(r.FormValue("steps"))
	guidance := env("WS_TRIPO_GUIDANCE", "7")
	if kind == "object" {
		steps = env("OBJECT_STEPS", "3")
		guidance = env("OBJECT_GUIDANCE", "2")
	}
	tTripo := time.Now()
	splat, err := tripoGenerate(edited, steps, tripoGaussians(r.FormValue("gaussians")), guidance)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	tripoDur := time.Since(tTripo)
	log.Printf("[timing] %-8s image=%-7s tripo=%-7s total=%s", name,
		imageDur.Round(time.Millisecond), tripoDur.Round(time.Millisecond), (imageDur + tripoDur).Round(time.Millisecond))
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

// paletteMatch nudges the re-textured image (dst) toward the source block-out's CHROMA
// distribution via a Reinhard transfer of the CIELAB a/b channels: it matches their mean and
// spread so the output keeps the intended hues, while local texture survives. `strength` in
// [0,1] lerps between the original (0) and the fully matched result (1). Lightness is left
// untouched (global mode never locks brightness; the lock mode does, via WS_PALETTE_MATCH_
// LIGHTNESS in paletteLock). The pure-black background is masked out of the stats AND left
// unrecoloured.
func paletteMatch(srcPNG, dstPNG []byte, strength float64) ([]byte, error) {
	src, err := decodeRGBA(srcPNG)
	if err != nil {
		return nil, fmt.Errorf("decode source: %w", err)
	}
	dst, err := decodeRGBA(dstPNG)
	if err != nil {
		return nil, fmt.Errorf("decode target: %w", err)
	}
	sMean, sStd, sN := labStats(src)
	dMean, dStd, dN := labStats(dst)
	if sN == 0 || dN == 0 {
		return dstPNG, nil // one image is all background — nothing to match against
	}
	b := dst.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			i := dst.PixOffset(x, y)
			r, g, bl := dst.Pix[i], dst.Pix[i+1], dst.Pix[i+2]
			if isBackground(r, g, bl) {
				continue
			}
			L, a, bb := rgbToLab(r, g, bl)
			a = transferChannel(a, dMean[1], dStd[1], sMean[1], sStd[1], strength)
			bb = transferChannel(bb, dMean[2], dStd[2], sMean[2], sStd[2], strength)
			nr, ng, nb := labToRGB(L, a, bb)
			dst.Pix[i], dst.Pix[i+1], dst.Pix[i+2] = nr, ng, nb
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, dst); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// paletteMode normalises the WS_PALETTE_MATCH value into off / global / lock. Truthy
// legacy values ("1", "true", "on") keep meaning the original global transfer.
func paletteMode(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "0", "false", "off", "no":
		return "off"
	case "lock", "quantize", "snap":
		return "lock"
	default:
		return "global"
	}
}

// parsePaletteColors turns the client's comma-separated hex list (the object's actual
// primitive colours, e.g. "#587553,#6b4f2a") into a CIELAB palette. Bad tokens are
// skipped. This is the elegant path: the exact colours are known, no discovery needed.
func parsePaletteColors(csv string) [][3]float64 {
	var out [][3]float64
	for _, tok := range strings.Split(csv, ",") {
		tok = strings.TrimPrefix(strings.TrimSpace(tok), "#")
		if len(tok) != 6 {
			continue
		}
		r, e1 := strconv.ParseUint(tok[0:2], 16, 8)
		g, e2 := strconv.ParseUint(tok[2:4], 16, 8)
		b, e3 := strconv.ParseUint(tok[4:6], 16, 8)
		if e1 != nil || e2 != nil || e3 != nil {
			continue
		}
		L, a, bb := rgbToLab(uint8(r), uint8(g), uint8(b))
		out = append(out, [3]float64{L, a, bb})
	}
	return out
}

// paletteLock snaps every pixel of the re-textured image (dst) to the nearest colour in
// `palette` (CIELAB). Each region collapses to a single primitive hue, so local hue drift
// (a pink trunk, teal speckles) is eliminated — the nearest palette colour always wins.
// `strength` in [0,1] blends chroma from the model (0) toward the locked palette colour (1).
// `lightnessLock` in [0,1] does the same for LIGHTNESS, pulling each pixel toward its matched
// palette colour's brightness: 0 keeps the model's shading, 1 makes the region a flat palette
// colour. The pure-black background is left unrecoloured.
func paletteLock(dstPNG []byte, palette [][3]float64, strength, lightnessLock float64) ([]byte, error) {
	if len(palette) == 0 {
		return dstPNG, nil // no palette to lock to — leave the image as-is
	}
	if lightnessLock < 0 {
		lightnessLock = 0
	} else if lightnessLock > 1 {
		lightnessLock = 1
	}
	dst, err := decodeRGBA(dstPNG)
	if err != nil {
		return nil, fmt.Errorf("decode target: %w", err)
	}
	b := dst.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			i := dst.PixOffset(x, y)
			r, g, bl := dst.Pix[i], dst.Pix[i+1], dst.Pix[i+2]
			if isBackground(r, g, bl) {
				continue
			}
			L, a, bb := rgbToLab(r, g, bl)
			p := nearestLab(palette, L, a, bb)
			// Lock chroma to the palette colour; pull lightness toward the palette colour's
			// own brightness by lightnessLock (0 = keep the model's shading, 1 = flat colour).
			nL := L + (p[0]-L)*lightnessLock
			na := a + (p[1]-a)*strength
			nbb := bb + (p[2]-bb)*strength
			nr, ng, nb := labToRGB(nL, na, nbb)
			dst.Pix[i], dst.Pix[i+1], dst.Pix[i+2] = nr, ng, nb
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, dst); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// nearestLab returns the palette colour closest to (L,a,b), weighting lightness low so a
// dark and a bright shade of the same hue still classify to the same palette entry.
func nearestLab(palette [][3]float64, L, a, b float64) [3]float64 {
	best := palette[0]
	bestD := math.Inf(1)
	for _, p := range palette {
		dL := (p[0] - L) * 0.25
		da := p[1] - a
		db := p[2] - b
		if d := dL*dL + da*da + db*db; d < bestD {
			bestD = d
			best = p
		}
	}
	return best
}

// transferChannel maps one LAB channel from the dst distribution onto the src one, then
// blends by strength. The std ratio is clamped so a near-flat target can't blow up.
func transferChannel(v, mDst, sDst, mSrc, sSrc, strength float64) float64 {
	scale := 1.0
	if sDst > 1e-6 {
		scale = sSrc / sDst
	}
	scale = math.Max(0.25, math.Min(4, scale))
	matched := (v-mDst)*scale + mSrc
	return v + (matched-v)*strength
}

func decodeRGBA(b []byte) (*image.RGBA, error) {
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	if rgba, ok := img.(*image.RGBA); ok {
		return rgba, nil
	}
	rgba := image.NewRGBA(img.Bounds())
	draw.Draw(rgba, img.Bounds(), img, img.Bounds().Min, draw.Src)
	return rgba, nil
}

// labStats returns the per-channel mean and standard deviation (L, a, b) over the
// non-background pixels, plus that pixel count.
func labStats(img *image.RGBA) (mean, std [3]float64, n int) {
	var sum, sumSq [3]float64
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			i := img.PixOffset(x, y)
			r, g, bl := img.Pix[i], img.Pix[i+1], img.Pix[i+2]
			if isBackground(r, g, bl) {
				continue
			}
			L, a, bb := rgbToLab(r, g, bl)
			sum[0], sum[1], sum[2] = sum[0]+L, sum[1]+a, sum[2]+bb
			sumSq[0], sumSq[1], sumSq[2] = sumSq[0]+L*L, sumSq[1]+a*a, sumSq[2]+bb*bb
			n++
		}
	}
	if n == 0 {
		return mean, std, 0
	}
	for c := 0; c < 3; c++ {
		mean[c] = sum[c] / float64(n)
		variance := sumSq[c]/float64(n) - mean[c]*mean[c]
		if variance < 0 {
			variance = 0
		}
		std[c] = math.Sqrt(variance)
	}
	return mean, std, n
}

// isBackground treats near-black pixels as the masked-out backdrop (the capture floats
// each subject on pure black), so they neither skew the stats nor get recoloured.
func isBackground(r, g, b uint8) bool {
	return r < 18 && g < 18 && b < 18
}

// --- sRGB <-> CIELAB (D65) --------------------------------------------------

func rgbToLab(r, g, b uint8) (float64, float64, float64) {
	rl := srgbToLinear(float64(r) / 255)
	gl := srgbToLinear(float64(g) / 255)
	bl := srgbToLinear(float64(b) / 255)
	x := (rl*0.4124564 + gl*0.3575761 + bl*0.1804375) / 0.95047
	y := rl*0.2126729 + gl*0.7151522 + bl*0.0721750
	z := (rl*0.0193339 + gl*0.1191920 + bl*0.9503041) / 1.08883
	fx, fy, fz := labF(x), labF(y), labF(z)
	return 116*fy - 16, 500 * (fx - fy), 200 * (fy - fz)
}

func labToRGB(L, a, bb float64) (uint8, uint8, uint8) {
	fy := (L + 16) / 116
	fx := fy + a/500
	fz := fy - bb/200
	x := labFInv(fx) * 0.95047
	y := labFInv(fy)
	z := labFInv(fz) * 1.08883
	rl := x*3.2404542 + y*-1.5371385 + z*-0.4985314
	gl := x*-0.9692660 + y*1.8760108 + z*0.0415560
	bl := x*0.0556434 + y*-0.2040259 + z*1.0572252
	return clamp8(linearToSrgb(rl)), clamp8(linearToSrgb(gl)), clamp8(linearToSrgb(bl))
}

func labF(t float64) float64 {
	if t > 0.008856 {
		return math.Cbrt(t)
	}
	return 7.787*t + 16.0/116.0
}

func labFInv(t float64) float64 {
	if c := t * t * t; c > 0.008856 {
		return c
	}
	return (t - 16.0/116.0) / 7.787
}

func srgbToLinear(c float64) float64 {
	if c <= 0.04045 {
		return c / 12.92
	}
	return math.Pow((c+0.055)/1.055, 2.4)
}

func linearToSrgb(c float64) float64 {
	if c <= 0.0031308 {
		return c * 12.92
	}
	return 1.055*math.Pow(c, 1/2.4) - 0.055
}

func clamp8(c float64) uint8 {
	v := c * 255
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return uint8(v + 0.5)
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

func tripoGenerate(image []byte, steps, gaussians, guidance string) ([]byte, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	mustField(writer, "seed", "42") // fixed seed so generations are reproducible
	mustField(writer, "steps", steps)
	mustField(writer, "preprocess", "true")
	mustField(writer, "guidance_scale", guidance)
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

// handleIdentify runs the identification phase: it receives a numbered context capture
// of the whole world + the scene prompt, asks Gemini to label each numbered object, and
// logs BOTH the numbered graphic and Gemini's response into the world's output folder.
// Best-effort: it always returns 200 (with possibly-empty labels) so generation can
// fall back to scene-context prompting if identification fails.
func handleIdentify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseMultipartForm(48 << 20); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	scene := strings.TrimSpace(r.FormValue("prompt"))
	count, _ := strconv.Atoi(strings.TrimSpace(r.FormValue("count")))
	if count < 1 {
		count = 1
	}
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

	raw, labels, ground, err := geminiIdentify(image, scene, count)
	if err != nil {
		raw = "identify error: " + err.Error()
		labels = map[string]string{}
		ground = ""
		log.Printf("identify: %v", err)
	}
	saveIdentify(dir, image, raw, labels, ground)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"labels": labels, "ground": ground, "raw": raw})
}

// geminiIdentify asks a Gemini vision model to label each numbered object in the image
// as a concrete noun, returning the raw response text + the parsed number->label map.
func geminiIdentify(image []byte, scene string, count int) (string, map[string]string, string, error) {
	key := geminiAPIKey()
	if key == "" {
		return "", nil, "", errors.New("GEMINI_API_KEY is not set (and not found in the Viggle backend .env)")
	}
	model := env("WS_GEMINI_IDENTIFY_MODEL", "gemini-2.5-flash")

	parts := []map[string]any{
		{"text": identifyPrompt(scene, count)},
		{"inlineData": map[string]string{"mimeType": "image/png", "data": base64.StdEncoding.EncodeToString(image)}},
	}
	payload, err := json.Marshal(map[string]any{
		"contents":         []map[string]any{{"role": "user", "parts": parts}},
		"generationConfig": map[string]any{"responseMimeType": "application/json"},
	})
	if err != nil {
		return "", nil, "", err
	}

	url := "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return "", nil, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", key)

	res, err := httpClient.Do(req)
	if err != nil {
		return "", nil, "", err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return "", nil, "", err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", nil, "", fmt.Errorf("gemini identify failed: %s", string(data))
	}

	var parsed struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return "", nil, "", err
	}
	var sb strings.Builder
	for _, c := range parsed.Candidates {
		for _, p := range c.Content.Parts {
			sb.WriteString(p.Text)
		}
	}
	raw := strings.TrimSpace(sb.String())
	labels, ground := parseIdentify(raw)
	return raw, labels, ground, nil
}

func identifyPrompt(scene string, count int) string {
	n := strconv.Itoa(count)
	return "You are analysing an isometric block-out of a 3D scene so each part can be generated as a realistic asset. The overall scene is: \"" + scene + "\". Each object is tagged with a bright numbered circle, numbered 1 to " + n + ". Do TWO things:\n1. For EACH number, name the single most likely concrete real-world object it represents as a SHORT BUT SPECIFIC phrase (about 2 to 6 words). Judge by its shape and silhouette, by its COLOURS and any painted markings, spots, stripes, or patterns on it, AND by the scene context. Always fold in the distinguishing detail you can actually see — colour, material, or a notable feature — instead of a bare category: prefer \"weathered grey granite boulder\" over \"rock\", \"red-roofed log cabin\" over \"house\", \"tall pointed pine tree\" over \"tree\". Treat a clearly painted colour as a real cue (red spots on a bush = berries, blue top on a post = a lantern, etc.). Use the scene only to disambiguate; \n2. Describe the GROUND terrain — the flat surface the objects sit on — as a short, concrete phrase naming its material and surface detail, e.g. \"mossy forest floor\", \"cracked dry desert sand\", \"wet cobblestone path\", \"short green meadow grass\". Base it on the painted ground colour/markings and the scene.\nRespond with ONLY a JSON object of the form {\"objects\":{\"1\":\"tall pointed pine tree\",\"2\":\"bush dotted with red berries\"},\"ground\":\"mossy forest floor with scattered pebbles\"}, with no other text. Include every number from 1 to " + n + " in \"objects\"."
}

// parseIdentify extracts the object number->label map AND the ground terrain
// description from Gemini's response, tolerating code fences, the {"objects":...,
// "ground":...} shape, and the legacy flat number->label map (ground then empty).
func parseIdentify(raw string) (map[string]string, string) {
	s := strings.TrimSpace(raw)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	s = strings.TrimSpace(s)

	var full struct {
		Objects map[string]string `json:"objects"`
		Labels  map[string]string `json:"labels"`
		Ground  string            `json:"ground"`
		Terrain string            `json:"terrain"`
	}
	if err := json.Unmarshal([]byte(s), &full); err == nil {
		labels := full.Objects
		if labels == nil {
			labels = full.Labels
		}
		ground := strings.TrimSpace(full.Ground)
		if ground == "" {
			ground = strings.TrimSpace(full.Terrain)
		}
		if labels != nil || ground != "" {
			if labels == nil {
				labels = map[string]string{}
			}
			return labels, ground
		}
	}
	// Legacy: a flat {"1":"oak",...} map with no ground description.
	labels := map[string]string{}
	if err := json.Unmarshal([]byte(s), &labels); err == nil {
		return labels, ""
	}
	return map[string]string{}, ""
}

// saveIdentify logs the numbered context graphic + Gemini's response into the world's
// output folder so the identification phase is auditable. Failures are logged, never fatal.
func saveIdentify(dir string, image []byte, raw string, labels map[string]string, ground string) {
	if !envBool("WS_SAVE_GENERATIONS", true) {
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

// imagePromptFor picks the re-texturing prompt for the subject kind. Both isolate the
// subject on a pure-black background (the client captures it that way) so the only
// thing Tripo reconstructs is the subject — no hallucinated backdrop to fight.
func imagePromptFor(kind, userPrompt, groundColor, label string) string {
	scene := strings.TrimSpace(userPrompt)
	if scene == "" {
		scene = "a coherent stylized natural game environment"
	}
	if kind == "floor" {
		return floorPrompt(scene, groundColor)
	}
	return objectPrompt(scene, label)
}

// objectPrompt re-textures one isolated object. label is the identification phase's
// guess for what this object is (e.g. "log cabin"); when present the model is told
// exactly what to render, which fixes "rock in a forest scene becomes a stump". When
// empty it falls back to interpreting the object from the scene context alone.
func objectPrompt(scene, label string) string {
	// Lead with WHAT to render, then a couple of hard constraints. Image 1 is the
	// block-out; we only ask Gemini to match its proportions, not treat it as a strict
	// geometric cage — the long version confused the model more than it helped.
	subject := "a single object that fits this scene"
	if label != "" {
		subject = "a single " + label
	}
	return "Using the same structure and colors as Image 1, transform the structure into " + subject + ", photorealistic."
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
