package main

import (
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

	if err := r.ParseMultipartForm(24 << 20); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	prompt := strings.TrimSpace(r.FormValue("prompt"))
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

	edited := image
	if !envBool("WS_SKIP_OPENAI", false) {
		edited, err = openAIEdit(image, prompt)
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

// handleConfig exposes the client-side splat cull/fit knobs so they can be tuned
// from the server env (WS_CULL_*) without rebuilding the client. Defaults here
// must match the SPLAT_CROP defaults in client/scripts/renderer.js.
func handleConfig(w http.ResponseWriter, r *http.Request) {
	cfg := map[string]any{
		"opacityFloor":         envFloat("WS_CULL_OPACITY", 0.04),
		"densityCells":         int(envFloat("WS_CULL_DENSITY_CELLS", 28)),
		"densityKeepFrac":      envFloat("WS_CULL_DENSITY_FRAC", 0.08),
		"radiusKeepPercentile": envFloat("WS_CULL_RADIUS_PCT", 0.9),
		"groundPercentile":     envFloat("WS_CULL_GROUND_PCT", 0.92),
		"heightCapFactor":      envFloat("WS_CULL_HEIGHT_CAP", 1.8),
		"belowGroundFactor":    envFloat("WS_CULL_BELOW_GROUND", 0.12),
		"floorPercentile":      envFloat("WS_CULL_FLOOR_PCT", 0.97),
		"floorY":               envFloat("WS_CULL_FLOOR_Y", 0),
		"inset":                envFloat("WS_CULL_INSET", 0.98),
		"postScale":            envFloat("WS_CULL_POST_SCALE", 1),
		"debug":                envBool("WS_CULL_DEBUG", false),
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(cfg)
}

func openAIEdit(image []byte, userPrompt string) ([]byte, error) {
	key := os.Getenv("OPENAI_API_KEY")
	if key == "" {
		return nil, errors.New("OPENAI_API_KEY is not set")
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	mustField(writer, "model", env("WS_IMAGE_MODEL", "gpt-image-1"))
	mustField(writer, "size", env("WS_IMAGE_SIZE", "1024x1024"))
	mustField(writer, "prompt", imagePrompt(userPrompt))
	// Strictness knobs (gpt-image-1): high input fidelity keeps the blockout's
	// proportions and color tones; transparent background stops it from painting
	// the hallucinated backdrop wall. Set the env var empty to omit a field.
	optField(writer, "quality", env("WS_IMAGE_QUALITY", "high"))
	optField(writer, "input_fidelity", env("WS_IMAGE_FIDELITY", "high"))
	optField(writer, "background", env("WS_IMAGE_BACKGROUND", "transparent"))
	optField(writer, "output_format", env("WS_IMAGE_FORMAT", "png"))

	part, err := createPNGFormFile(writer, "image", "plot-guide.png")
	if err != nil {
		return nil, err
	}
	if _, err := part.Write(image); err != nil {
		return nil, err
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

	saveGeneration(image, out, userPrompt)
	return out, nil
}

// saveGeneration writes the block-out guide, the GPT-image output, and the
// prompt into the backend output folder so the (input, prompt -> output) pairs
// can be collected for finetuning. Failures are logged but never block a
// request.
func saveGeneration(input, output []byte, userPrompt string) {
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

	for name, data := range map[string][]byte{
		base + "-input.png":  input,
		base + "-output.png": output,
		base + "-prompt.txt": []byte(userPrompt),
	} {
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
	mustField(writer, "seed", env("WS_TRIPO_SEED", "0"))
	mustField(writer, "steps", env("WS_TRIPO_STEPS", "30"))
	mustField(writer, "guidance_scale", env("WS_TRIPO_GUIDANCE", "3.5"))
	mustField(writer, "num_gaussians", env("WS_TRIPO_GAUSSIANS", "700000"))
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

func imagePrompt(userPrompt string) string {
	prompt := strings.TrimSpace(userPrompt)
	if prompt == "" {
		prompt = "a coherent stylized natural game environment"
	}
	return "Re-texture this square isometric Three.js blockout into a single high-fidelity source image for Gaussian splatting, changing materials ONLY. Keep the ground base a perfect square with straight edges and square corners — never round, skew, taper, rotate, or distort it. Preserve every object's existing proportions, position, silhouette, and the overall color tones of the blockout; do not move, add, remove, resize, or reimagine objects. Replace flat primitive materials with believable detailed natural materials while matching the original hues. The area outside the square base must be completely empty and transparent: no background, no walls, no sky, no horizon, no scenery, no fog, no extra ground or floor. No UI, text, frames, borders, backdrop, or camera-angle changes. Scene prompt: " + prompt
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
