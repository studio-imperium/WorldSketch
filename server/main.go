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

type imageEditSettings struct {
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

type paletteSettings struct {
	Mode      string
	Strength  float64
	Lightness float64
}

type tripoSettings struct {
	Steps     string
	Guidance  string
	Gaussians string
	Format    string
}

var httpClient = &http.Client{Timeout: 180 * time.Second}

func main() {
	mux := http.NewServeMux()
	// One world is generated object-by-object: the client allocates an output
	// folder once (/api/new-output) and then POSTs /api/generate per object/floor.
	mux.HandleFunc("/api/new-output", handleNewOutput)
	mux.HandleFunc("/api/generate", handleGenerate)
	mux.HandleFunc("/api/floor-texture", handleFloorTexture)
	mux.HandleFunc("/api/ground", handleGround)
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
		"genConcurrency": envFloat("WS_GEN_CONCURRENCY", 4), // subjects re-textured + reconstructed in parallel
		"object":         subjectClientConfig("object"),
		"floor":          subjectClientConfig("floor"),
	})
}

func subjectClientConfig(kind string) map[string]any {
	palette := subjectPaletteSettings(kind)
	yOffsetLegacy := []string{}
	if kind == "object" {
		yOffsetLegacy = []string{"WS_CULL_Y_OFFSET"}
	}
	return map[string]any{
		"yOffset":           subjectEnvFloat(kind, "Y_OFFSET", yOffsetLegacy, 0),
		"opacityFloor":      subjectEnvFloat(kind, "OPACITY_FLOOR", []string{"WS_OPACITY_FLOOR"}, 0.03),
		"paletteLock":       palette.Mode == "lock",
		"paletteStrength":   palette.Strength,
		"paletteLightness":  palette.Lightness,
		"yaw":               subjectEnvFloat(kind, "YAW", nil, 0),
		"fitClampK":         subjectEnvFloat(kind, "FIT_CLAMP_K", []string{"WS_FIT_CLAMP_K"}, 0),
		"fitBboxPercentile": subjectEnvFloat(kind, "FIT_BBOX_PERCENTILE", []string{"WS_FIT_BBOX_PERCENTILE"}, 0),
	}
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
	imageSettings := subjectImageEditSettings(kind)
	if parseBoolDefault(r.FormValue("skip_image_edit"), false) {
		imageSettings.SkipImageEdit = true
	}
	palette := subjectPaletteSettings(kind)

	tImage := time.Now()
	edited := image
	if imageSettings.SkipImageEdit {
		// Image edit skipped: the raw block-out screenshot is fed straight to Tripo.
		// Still record the (input -> output) pair so the screenshot is always saved.
		saveGeneration(dir, name, image, materialImage, edited, prompt)
	} else {
		// Re-texture the block-out. Each subject type has its own image backend/settings.
		switch strings.ToLower(imageSettings.Provider) {
		case "gemini":
			edited, err = geminiEdit(image, materialImage, promptText, imageSettings.GeminiModel)
		default:
			edited, err = openAIEdit(image, materialImage, promptText, imageSettings)
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
		var matched []byte
		var perr error
		switch palette.Mode {
		case "global":
			matched, perr = paletteMatch(image, edited, palette.Strength)
		case "lock":
			// Lock the generated hues to the object's exact primitive colours (sent by the
			// client). WS_PALETTE_MATCH_LIGHTNESS in [0,1] additionally pulls each pixel's
			// lightness toward its matched flat palette colour's brightness (0 = keep the
			// model's lightness, 1 = flat onto the palette colour). No palette = no-op.
			matched, perr = paletteLock(edited, parsePaletteColors(r.FormValue("colors")), palette.Strength, palette.Lightness)
		}
		if perr != nil {
			log.Printf("palette match skipped for %s: %v", name, perr)
		} else if matched != nil {
			edited = matched
		}
		saveGeneration(dir, name, image, materialImage, edited, prompt)
	}

	imageDur := time.Since(tImage)

	tripo := subjectTripoSettings(kind, r.FormValue("steps"), r.FormValue("gaussians"))
	tTripo := time.Now()
	splat, err := tripoGenerate(edited, tripo)
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

// handleFloorTexture turns the user's flat top-down floor paint map into a realistic
// top-down albedo texture with Gemini. The client then applies this texture to the actual
// floor plane, captures the standard isometric guide, and sends that guide to Tripo.
func handleFloorTexture(w http.ResponseWriter, r *http.Request) {
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
	name := sanitizeName(r.FormValue("name"))
	if name == "" {
		name = "floor-texture"
	}
	dir := outputSubdir(r.FormValue("output"))

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

	settings := subjectImageEditSettings("floor")
	palette := subjectPaletteSettings("floor")
	promptText := floorTexturePrompt(prompt, groundColor)

	tImage := time.Now()
	edited := image
	if !settings.SkipImageEdit {
		edited, err = geminiEdit(image, nil, promptText, settings.GeminiModel)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		var matched []byte
		var perr error
		switch palette.Mode {
		case "global":
			matched, perr = paletteMatch(image, edited, palette.Strength)
		case "lock":
			matched, perr = paletteLock(edited, parsePaletteColors(r.FormValue("colors")), palette.Strength, palette.Lightness)
		}
		if perr != nil {
			log.Printf("floor texture palette match skipped for %s: %v", name, perr)
		} else if matched != nil {
			edited = matched
		}
	}
	saveGeneration(dir, name+"-topdown", image, nil, edited, promptText)
	log.Printf("[timing] %-8s texture=%s", name, time.Since(tImage).Round(time.Millisecond))

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s.png"`, name))
	_, _ = w.Write(edited)
}

// handleGround generates the UNIFIED ground for an expanded (multi-plot) world. The client
// sends ONE composited top-down ground image covering the whole plot footprint plus a
// `cols`×`rows` tile count. When a `mask` is present the call is an OUTPAINT: the mask's
// opaque region is the already-generated terrain to preserve and the transparent region is
// the newly-added tiles, which OpenAI repaints as a seamless continuation. The whole ground
// is then reconstructed as ONE Tripo splat (gaussian count scaled by tile count), so plots
// share a single continuous ground with no seam by construction. Returns JSON
// {image, splat} (both base64) — the client keeps `image` as the master for the next expand.
func handleGround(w http.ResponseWriter, r *http.Request) {
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
	name := sanitizeName(r.FormValue("name"))
	if name == "" {
		name = "floor"
	}
	dir := outputSubdir(r.FormValue("output"))
	cols := atoiDefault(r.FormValue("cols"), 1)
	rows := atoiDefault(r.FormValue("rows"), 1)

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
	mask, err := readOptionalFormFile(r, "mask", 24<<20)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	settings := subjectImageEditSettings("floor")
	if sz := openAIGroundSize(r.FormValue("image_size")); sz != "" {
		settings.Size = sz
	}
	// Keep the floor default background (transparent → RGBA output). TripoSplat's preprocess
	// needs an alpha channel and 500s on a flat RGB image, so DON'T force opaque here.
	palette := subjectPaletteSettings("floor")
	promptText := groundPrompt(prompt, groundColor, len(mask) > 0)

	tImage := time.Now()
	edited := image
	if settings.SkipImageEdit {
		saveGeneration(dir, name, image, nil, edited, promptText)
	} else {
		edited, err = openAIGround(image, mask, promptText, settings)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		var matched []byte
		var perr error
		switch palette.Mode {
		case "global":
			matched, perr = paletteMatch(image, edited, palette.Strength)
		case "lock":
			matched, perr = paletteLock(edited, parsePaletteColors(r.FormValue("colors")), palette.Strength, palette.Lightness)
		}
		if perr != nil {
			log.Printf("ground palette match skipped: %v", perr)
		} else if matched != nil {
			edited = matched
		}
		saveGeneration(dir, name, image, mask, edited, promptText)
	}
	imageDur := time.Since(tImage)

	tripo := subjectTripoSettings("floor", "", "")
	tripo.Gaussians = groundGaussians(cols * rows)
	tTripo := time.Now()
	splat, err := tripoGenerate(edited, tripo)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	tripoDur := time.Since(tTripo)
	log.Printf("[timing] %-8s image=%-7s tripo=%-7s total=%s tiles=%dx%d gaussians=%s", name,
		imageDur.Round(time.Millisecond), tripoDur.Round(time.Millisecond), (imageDur + tripoDur).Round(time.Millisecond), cols, rows, tripo.Gaussians)
	saveSplat(dir, name, splat)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"image": base64.StdEncoding.EncodeToString(edited),
		"splat": base64.StdEncoding.EncodeToString(splat),
	})
}

// openAIGround re-textures / outpaints the ground via OpenAI's images/edits endpoint. Same
// shape as openAIEdit but it takes a single image plus an optional alpha mask (transparent =
// repaint, opaque = preserve) and never sends a material map. Masked edits keep the existing
// terrain and continue it into the new region.
func openAIGround(image, mask []byte, promptText string, settings imageEditSettings) ([]byte, error) {
	key := os.Getenv("OPENAI_API_KEY")
	if key == "" {
		return nil, errors.New("OPENAI_API_KEY is not set (required for ground expansion)")
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	mustField(writer, "model", settings.OpenAIModel)
	mustField(writer, "size", settings.Size)
	mustField(writer, "prompt", promptText)
	optField(writer, "quality", settings.Quality)
	if strings.EqualFold(settings.OpenAIModel, "gpt-image-1") {
		optField(writer, "input_fidelity", settings.Fidelity) // high fidelity preserves the kept terrain across the seam
	}
	optField(writer, "background", settings.Background)
	optField(writer, "output_format", settings.Format)

	part, err := createPNGFormFile(writer, "image", "ground.png")
	if err != nil {
		return nil, err
	}
	if _, err := part.Write(image); err != nil {
		return nil, err
	}
	if len(mask) > 0 {
		mpart, err := createPNGFormFile(writer, "mask", "mask.png")
		if err != nil {
			return nil, err
		}
		if _, err := mpart.Write(mask); err != nil {
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
		return nil, fmt.Errorf("openai ground edit failed: %s", string(data))
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
	return nil, errors.New("openai ground edit returned no image")
}

// groundPrompt builds the re-texturing prompt for the unified ground. `extending` switches
// it to outpaint mode: preserve the already-generated terrain exactly and make the new
// (masked) region a seamless continuation — same materials, colour, lighting, and scale,
// no seam, no repetition.
func groundPrompt(scene, groundColor string, extending bool) string {
	scene = strings.TrimSpace(scene)
	if scene == "" {
		scene = "a coherent stylized natural game environment"
	}
	ground := ""
	if groundColor != "" {
		ground = " The base ground colour is " + groundColor + "; keep that hue and material family (sandy/tan/brown stays sand or soil, green stays grass or moss)."
	}
	layout := " The painted floor design is a HARD LAYOUT CONSTRAINT, not a suggestion: preserve the exact positions, silhouettes, topology, curvature, width, and connectivity of all painted regions. Do not straighten, reroute, simplify, merge, split, rotate, resize, or invent terrain markings. A circular or looping river must remain circular/looping in the same place; a winding path must keep the same bends; islands, ponds, crossings, and branches must keep their exact relative layout. Only replace flat colours with matching terrain materials inside those same shapes."
	base := "This is a flat, top-down view of ground terrain for Gaussian-splat reconstruction. Render a high-fidelity, photorealistic, evenly-lit terrain surface that FILLS the entire canvas edge to edge with NO padding, border, frame, vignette, or margin. The ground is ONE LEVEL flat surface at a single height — NO hills, mounds, dunes, slopes, ridges, banks, cliffs, terraces, or raised landforms; only a thin textured skin of natural surface detail (grass blades, moss, scattered pebbles, dirt, small cracks, twigs, leaves) and flush flat features (paths, rivers, and ponds sit level with the surrounding ground, never carved or raised)." + layout + " Use fully ambient illumination: no cast shadows, no directional sunlight, no dramatic lighting. The material and colour stay UNIFORM all the way to every edge so the terrain tiles seamlessly with no rim, fade, or detail bunching."
	cont := ""
	if extending {
		cont = " IMPORTANT — this is an EXTENSION: the opaque (kept) part of the image is already-generated terrain that you must preserve unchanged. Paint ONLY the masked (empty) region, and make it a perfectly seamless CONTINUATION of the existing terrain across the boundary: identical materials, colours, lighting, texture grain, and scale, flowing across with NO visible seam, line, edge, or change in tone. Do NOT copy, repeat, or mirror the existing region — grow it naturally as if the whole ground had always been one continuous piece."
	}
	return base + ground + cont + " No walls, no sky, no buildings, no objects, no UI, no text, no camera-angle change. Scene context: " + scene
}

// groundGaussians scales Tripo's gaussian budget with the ground's tile count so a larger
// footprint keeps its density: base × next-power-of-two(tiles), clamped to Tripo's accepted
// [1024, 262144] range (it honours num_gaussians up to 262144).
func groundGaussians(tiles int) string {
	base := 32768
	if v := strings.TrimSpace(env("WS_FLOOR_TRIPO_GAUSSIANS", env("WS_TRIPO_GAUSSIANS", ""))); v != "" {
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

// openAIGroundSize whitelists the client-requested canvas size to OpenAI's supported edit
// sizes; an unsupported/empty value returns "" so the caller keeps the floor default.
func openAIGroundSize(size string) string {
	switch strings.TrimSpace(size) {
	case "1024x1024", "1536x1024", "1024x1536":
		return size
	}
	return ""
}

func atoiDefault(s string, fallback int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
		return n
	}
	return fallback
}

func subjectImageEditSettings(kind string) imageEditSettings {
	if kind == "floor" {
		return imageEditSettings{
			Provider:      subjectEnv(kind, "IMAGE_PROVIDER", []string{"WS_IMAGE_PROVIDER"}, "openai"),
			GeminiModel:   subjectEnv(kind, "GEMINI_IMAGE_MODEL", []string{"WS_GEMINI_IMAGE_MODEL"}, "gemini-2.5-flash-image"),
			OpenAIModel:   subjectEnv(kind, "IMAGE_MODEL", []string{"WS_FLOOR_IMAGE_MODEL", "WS_IMAGE_MODEL"}, "gpt-image-1"),
			Size:          subjectEnv(kind, "IMAGE_SIZE", []string{"WS_IMAGE_SIZE"}, "1024x1024"),
			Quality:       subjectEnv(kind, "IMAGE_QUALITY", []string{"WS_IMAGE_QUALITY"}, "medium"),
			Fidelity:      subjectEnv(kind, "IMAGE_FIDELITY", []string{"WS_FLOOR_IMAGE_FIDELITY", "WS_IMAGE_FIDELITY"}, "high"),
			Background:    subjectEnv(kind, "IMAGE_BACKGROUND", []string{"WS_IMAGE_BACKGROUND"}, "transparent"),
			Format:        subjectEnv(kind, "IMAGE_FORMAT", []string{"WS_IMAGE_FORMAT"}, "png"),
			SkipImageEdit: subjectSkipImageEdit(kind),
		}
	}
	return imageEditSettings{
		Provider:      subjectEnv(kind, "IMAGE_PROVIDER", []string{"WS_IMAGE_PROVIDER"}, "openai"),
		GeminiModel:   subjectEnv(kind, "GEMINI_IMAGE_MODEL", []string{"WS_GEMINI_IMAGE_MODEL"}, "gemini-2.5-flash-image"),
		OpenAIModel:   subjectEnv(kind, "IMAGE_MODEL", []string{"WS_IMAGE_MODEL"}, "gpt-image-1-mini"),
		Size:          subjectEnv(kind, "IMAGE_SIZE", []string{"WS_IMAGE_SIZE"}, "1024x1024"),
		Quality:       subjectEnv(kind, "IMAGE_QUALITY", []string{"WS_IMAGE_QUALITY"}, "medium"),
		Fidelity:      subjectEnv(kind, "IMAGE_FIDELITY", []string{"WS_IMAGE_FIDELITY"}, "low"),
		Background:    subjectEnv(kind, "IMAGE_BACKGROUND", []string{"WS_IMAGE_BACKGROUND"}, "transparent"),
		Format:        subjectEnv(kind, "IMAGE_FORMAT", []string{"WS_IMAGE_FORMAT"}, "png"),
		SkipImageEdit: subjectSkipImageEdit(kind),
	}
}

func subjectSkipImageEdit(kind string) bool {
	fallback := envBool("WS_SKIP_IMAGE_EDIT", envBool("WS_SKIP_OPENAI", false))
	return subjectEnvBool(kind, "SKIP_IMAGE_EDIT", nil, fallback)
}

func subjectPaletteSettings(kind string) paletteSettings {
	mode := paletteMode(subjectEnv(kind, "PALETTE_MATCH", []string{"WS_PALETTE_MATCH"}, "off"))
	return paletteSettings{
		Mode:      mode,
		Strength:  subjectEnvFloat(kind, "PALETTE_MATCH_STRENGTH", []string{"WS_PALETTE_MATCH_STRENGTH"}, 0.75),
		Lightness: subjectEnvFloat(kind, "PALETTE_MATCH_LIGHTNESS", []string{"WS_PALETTE_MATCH_LIGHTNESS"}, 0),
	}
}

func openAIEdit(image, materialImage []byte, promptText string, settings imageEditSettings) ([]byte, error) {
	key := os.Getenv("OPENAI_API_KEY")
	if key == "" {
		return nil, errors.New("OPENAI_API_KEY is not set")
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	mustField(writer, "model", settings.OpenAIModel)
	mustField(writer, "size", settings.Size)
	mustField(writer, "prompt", promptText)
	optField(writer, "quality", settings.Quality)
	// input_fidelity is ONLY supported by the full gpt-image-1 model — gpt-image-1-mini
	// (and gpt-image-1.5 / gpt-image-2) reject it. Only send it for the full model, so
	// the default mini object path never passes it. On full gpt-image-1 (the floor), high
	// fidelity preserves the painted terrain layout (but adds ~4160 input tokens/image).
	if strings.EqualFold(settings.OpenAIModel, "gpt-image-1") {
		optField(writer, "input_fidelity", settings.Fidelity)
	}
	optField(writer, "background", settings.Background)
	optField(writer, "output_format", settings.Format)

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
func geminiEdit(image, materialImage []byte, promptText, model string) ([]byte, error) {
	key := geminiAPIKey()
	if key == "" {
		return nil, errors.New("GEMINI_API_KEY is not set (and not found in the Viggle backend .env)")
	}

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

func subjectTripoSettings(kind, stepsField, gaussiansField string) tripoSettings {
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
	return tripoSettings{
		Steps:     clampIntString(subjectEnv(kind, "TRIPO_STEPS", stepsLegacy, stepsField), stepsDefault, 1, 64),
		Guidance:  subjectEnv(kind, "TRIPO_GUIDANCE", guidanceLegacy, guidanceDefault),
		Gaussians: clampIntString(subjectEnv(kind, "TRIPO_GAUSSIANS", []string{"WS_TRIPO_GAUSSIANS"}, gaussiansField), "32768", 1024, 262144),
		Format:    subjectEnv(kind, "TRIPO_FORMAT", []string{"WS_TRIPO_FORMAT"}, "splat"),
	}
}

func clampIntString(value, fallback string, min, max int) string {
	out := fallback
	if s := strings.TrimSpace(value); s != "" {
		out = s
	}
	if n, err := strconv.Atoi(out); err == nil && n > 0 {
		return strconv.Itoa(clampInt(n, min, max))
	}
	return fallback
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

// nearestLab returns the palette colour closest to (L,a,b) by chroma only. Lightness is
// intentionally ignored here so dark greens do not snap to a brown palette entry just
// because brown has a closer brightness.
func nearestLab(palette [][3]float64, L, a, b float64) [3]float64 {
	best := palette[0]
	bestD := math.Inf(1)
	for _, p := range palette {
		da := p[1] - a
		db := p[2] - b
		if d := da*da + db*db; d < bestD {
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

func tripoGenerate(image []byte, settings tripoSettings) ([]byte, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	mustField(writer, "seed", "42") // fixed seed so generations are reproducible
	mustField(writer, "steps", settings.Steps)
	mustField(writer, "preprocess", "true")
	mustField(writer, "guidance_scale", settings.Guidance)
	mustField(writer, "num_gaussians", settings.Gaussians)
	mustField(writer, "output_format", settings.Format)

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
	return "Using the same structure and colors as Image 1, transform the structure into " + subject + ", photorealistic. The object must appear completely alone — no floor, no ground plane, no shadow beneath it, no background scenery — just the isolated object on a pure black background."
}

func floorPrompt(scene, groundColor string) string {
	ground := ""
	if groundColor != "" {
		ground = " The ground/baseplate input colour is " + groundColor + "; preserve that ground hue and material category. If it is sandy, tan, yellow, beige, orange, or brown, the ground must become sand, dry soil, clay, stone, or desert terrain, never green grass. If it is green, use grass, moss, or foliage in that same green tone."
	}
	layout := " Image 2, when provided, is a flat painted material-ID map and must be treated as a HARD LAYOUT CONSTRAINT. Preserve the exact positions, silhouettes, topology, curvature, width, and connectivity of all painted regions. Do not straighten, reroute, simplify, merge, split, rotate, resize, or invent terrain markings. A circular or looping river must remain circular/looping in the same place; a winding path must keep the same bends; islands, ponds, crossings, and branches must keep their exact relative layout. BLUE marks water (a flat river, stream, or pond), BROWN or TAN marks a dirt path or sand, GREY or DARK marks rock or stone, GREEN marks grass or moss. Change only the material/detail inside those same painted shapes."
	return "Re-texture this isometric view of a single flat, square ground tile into a high-fidelity, photorealistic terrain surface for Gaussian-splat reconstruction. The ground stays a single LEVEL surface at one height — NO hills, mounds, dunes, ridges, raised banks, embankments, slopes, terraces, plateaus, cliffs, craters, or other large 3D landforms; the overall plane does not rise or dip. Shallow SURFACE TEXTURE and natural detail are very welcome and encouraged, though: grass blades, moss, scattered pebbles, small stones, dirt clods, twigs, leaves, cracks, and fine material grain make the ground lively and dynamic — just keep that detail as a thin textured skin on the flat plane, never built up into raised terrain. Rivers, paths, and ponds read as essentially flat changes of colour and material: a river or pond water surface sits flush and level (not a deep carved canyon, not raised banks), and a path is flush with the surrounding grass. The tile itself is a thin flat slab — never a tall block, plinth, wall, or pedestal — and a perfect square with straight edges and square corners. Change MATERIALS and surface detail ONLY, preserving the exact square footprint. The square must FILL the canvas: its corners reach the image edges with NO empty padding, NO transparent margin, and NO border between the tile and the image edge (the splat is scaled to the canvas, so any padding breaks scale alignment with the colliders). Image 1 is the isometric geometry guide." + layout + ground + " The ground material and colour must be UNIFORM all the way to the four edges (except where painted terrain runs off an edge): no color shift, no fade, no darker rim, no vignette, no detail bunching, so adjacent tiles tile seamlessly. Render as flat, evenly-lit albedo with fully ambient illumination: no cast shadows, no directional sunlight, no dramatic lighting (fine surface texture and shallow material detail are welcome — just avoid shading that reads as hills or raised landforms). The area outside the square tile must be pure black and empty: no background, no walls, no sky, no scenery. No UI, text, frames, or camera-angle change. Scene context: " + scene
}

func floorTexturePrompt(scene, groundColor string) string {
	scene = strings.TrimSpace(scene)
	if scene == "" {
		scene = "a coherent stylized natural game environment"
	}
	ground := ""
	if groundColor != "" {
		ground = " The base ground colour is " + groundColor + "; preserve that hue and material category. If it is green, render grass, moss, or foliage in that green family. If it is tan, yellow, beige, orange, or brown, render sand, dry soil, clay, dirt, or desert terrain, never green grass."
	}
	return "Image 1 is a FLAT TOP-DOWN material and layout map for one square floor tile. Create a more realistic TOP-DOWN terrain texture from it, preserving the exact layout pixel-for-pixel in position and topology. The output must remain a square top-down orthographic texture, not perspective, not isometric, not 3D. Preserve the exact positions, silhouettes, curvature, widths, connectivity, and edge crossings of every painted region. Do not straighten, reroute, simplify, merge, split, rotate, resize, offset, or invent terrain shapes. A circular or looping river must remain circular/looping in the same place; a winding path must keep the same bends; islands, ponds, crossings, branches, and shoreline contours must keep their exact relative layout. BLUE regions become flat water; BROWN or TAN regions become dirt, sand, or path material; GREY or DARK regions become stone or rock; GREEN regions become grass or moss. Change only the material detail inside those same shapes. The terrain is a flat albedo texture: no hills, banks, cliffs, shadows, lighting direction, perspective, walls, objects, labels, UI, border, padding, vignette, or frame. Fill the entire image edge to edge, and keep materials seamless at the four edges except where a painted feature exits the tile." + ground + " Scene context: " + scene
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

func envMaybe(name string) (string, bool) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", false
	}
	return value, true
}

func subjectPrefix(kind string) string {
	if kind == "floor" {
		return "WS_FLOOR_"
	}
	return "WS_OBJECT_"
}

func subjectEnv(kind, suffix string, legacy []string, fallback string) string {
	if value, ok := envMaybe(subjectPrefix(kind) + suffix); ok {
		return value
	}
	for _, key := range legacy {
		if value, ok := envMaybe(key); ok {
			return value
		}
	}
	return fallback
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

func parseBoolDefault(value string, fallback bool) bool {
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func subjectEnvBool(kind, suffix string, legacy []string, fallback bool) bool {
	if value, ok := envMaybe(subjectPrefix(kind) + suffix); ok {
		return parseBoolDefault(value, fallback)
	}
	for _, key := range legacy {
		if value, ok := envMaybe(key); ok {
			return parseBoolDefault(value, fallback)
		}
	}
	return fallback
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

func parseFloatDefault(value string, fallback float64) float64 {
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func subjectEnvFloat(kind, suffix string, legacy []string, fallback float64) float64 {
	if value, ok := envMaybe(subjectPrefix(kind) + suffix); ok {
		return parseFloatDefault(value, fallback)
	}
	for _, key := range legacy {
		if value, ok := envMaybe(key); ok {
			return parseFloatDefault(value, fallback)
		}
	}
	return fallback
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
