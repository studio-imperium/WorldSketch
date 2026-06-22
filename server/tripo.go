package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
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

// tripoConfigured reports whether the Tripo single-image splat pipeline is selected.
// It is an additive, flag-gated alternative to the ComfyUI/depth/fusion/train path:
// one isometric capture -> OpenAI gpt-image-1 edit -> TripoSplat /generate -> world.splat.
// The old pipeline is left fully intact; this only runs when WS_PIPELINE=tripo.
func tripoConfigured() bool {
	return envStr("WS_PIPELINE", "") == "tripo"
}

// runTripo drives the Tripo pipeline for a job and records the result. Splat-only:
// markDone sets SplatURL (world.splat exists) + CollisionURL (served from scene
// primitives) + PreviewURL; there is no world.ply on this path.
func (s *Store) runTripo(id, dir string, scene Scene) {
	if err := runTripoPipeline(dir, scene, func(st string) { s.set(id, st, "") }); err != nil {
		s.fail(id, err)
		return
	}
	s.markDone(id)
}

// runTripoPipeline reads ONE captured view (the isometric corner by default), restyles
// it with OpenAI's image-edit endpoint using the scene prompt, ships that image to the
// TripoSplat API, and writes the returned world.splat. No depth/fusion/local training —
// Tripo does the image->3D Gaussian step on its own GPU box.
func runTripoPipeline(dir string, scene Scene, status func(string)) error {
	isoView := envStr("WS_ISO_VIEW", "corner_fr_high")
	srcImage := filepath.Join(dir, "views", isoView, "primitive_rgb.png")
	if !fileExists(srcImage) {
		return fmt.Errorf("isometric source view %q not found at %s", isoView, srcImage)
	}

	status("generating image (openai)")
	imgBytes, err := openaiImageEdit(srcImage, scene.Prompt)
	if err != nil {
		return fmt.Errorf("openai image edit: %w", err)
	}
	// Persist for preview + debugging. previewPath serves views/front/generated_rgb.png,
	// so write there too — the editor's preview thumbnail reads that path regardless of
	// which view fed the pipeline.
	writeTripoGenerated(dir, isoView, imgBytes)

	status("generating splat (tripo)")
	splat, meta, err := tripoGenerate(imgBytes)
	if err != nil {
		return fmt.Errorf("tripo generate: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "world.splat"), splat, 0644); err != nil {
		return fmt.Errorf("write world.splat: %w", err)
	}
	log.Printf("tripo: wrote %d-byte world.splat (%s)", len(splat), meta)
	return nil
}

// writeTripoGenerated saves the OpenAI image to the iso view dir and to the preview
// location (previewPath) so the editor preview works regardless of WS_ISO_VIEW.
func writeTripoGenerated(dir, isoView string, img []byte) {
	for _, p := range []string{
		filepath.Join(dir, "views", isoView, "generated_rgb.png"),
		previewPath(dir),
	} {
		os.MkdirAll(filepath.Dir(p), 0755)
		os.WriteFile(p, img, 0644)
	}
}

// imagePartHeader builds a multipart file-part header that declares image/png. The
// default CreateFormFile uses application/octet-stream, which OpenAI's image-edit
// endpoint rejects ("unsupported mimetype").
func imagePartHeader(field, filename string) textproto.MIMEHeader {
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, field, filename))
	h.Set("Content-Type", "image/png")
	return h
}

// openaiImageEdit calls POST /v1/images/edits with gpt-image-1, conditioning the
// generation on the captured isometric image + the scene prompt. gpt-image-1 returns
// the result as base64 in data[0].b64_json. Requires OPENAI_API_KEY.
func openaiImageEdit(imagePath, scenePrompt string) ([]byte, error) {
	key := os.Getenv("OPENAI_API_KEY")
	if key == "" {
		return nil, fmt.Errorf("OPENAI_API_KEY not set")
	}

	var body bytes.Buffer
	w := multipart.NewWriter(&body)

	f, err := os.Open(imagePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	part, err := w.CreatePart(imagePartHeader("image", "iso.png"))
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(part, f); err != nil {
		return nil, err
	}
	w.WriteField("model", envStr("WS_OPENAI_MODEL", "gpt-image-1"))
	w.WriteField("prompt", tripoEditPrompt(scenePrompt))
	w.WriteField("size", envStr("WS_OPENAI_SIZE", "1024x1024"))
	w.WriteField("n", "1")
	if err := w.Close(); err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPost, "https://api.openai.com/v1/images/edits", &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", w.FormDataContentType())

	client := &http.Client{Timeout: 5 * time.Minute}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		return nil, fmt.Errorf("openai status %d: %s", res.StatusCode, string(data))
	}

	var out struct {
		Data []struct {
			B64JSON string `json:"b64_json"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("decode openai response: %w", err)
	}
	if len(out.Data) == 0 || out.Data[0].B64JSON == "" {
		return nil, fmt.Errorf("openai returned no image: %s", string(data))
	}
	return base64.StdEncoding.DecodeString(out.Data[0].B64JSON)
}

// tripoEditPrompt builds the image-edit instruction: keep the block-out composition,
// render it as a finished isometric asset on a clean background. The scene prompt (the
// player's "vibe") leads, then the structural constraints.
func tripoEditPrompt(scenePrompt string) string {
	base := "Render this rough 3D block-out as a single finished, detailed isometric game asset " +
		"with clean studio lighting on a plain neutral background, preserving the overall shapes, " +
		"layout, and proportions."
	scenePrompt = strings.TrimSpace(scenePrompt)
	if scenePrompt == "" {
		return base
	}
	return scenePrompt + ". " + base
}

// tripoGenerate POSTs the image to the TripoSplat API and returns the binary splat. The
// API is synchronous: the response body IS the .splat/.ply, with metadata in the
// X-Num-Gaussians / X-Generation-Seconds / X-Output-Format headers.
func tripoGenerate(image []byte) ([]byte, string, error) {
	base := strings.TrimRight(envStr("TRIPO_API_URL", "http://148.153.245.160:18080"), "/")

	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreatePart(imagePartHeader("image", "input.png"))
	if err != nil {
		return nil, "", err
	}
	if _, err := part.Write(image); err != nil {
		return nil, "", err
	}
	w.WriteField("seed", strconv.Itoa(envInt("WS_TRIPO_SEED", 42)))
	w.WriteField("steps", strconv.Itoa(envInt("WS_TRIPO_STEPS", 20)))
	w.WriteField("guidance_scale", fmt.Sprintf("%g", envFloat("WS_TRIPO_GUIDANCE", 3.0)))
	w.WriteField("num_gaussians", strconv.Itoa(envInt("WS_TRIPO_GAUSSIANS", 262144)))
	w.WriteField("output_format", envStr("WS_TRIPO_FORMAT", "splat"))
	if err := w.Close(); err != nil {
		return nil, "", err
	}

	req, err := http.NewRequest(http.MethodPost, base+"/generate", &body)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())

	client := &http.Client{Timeout: 20 * time.Minute}
	res, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, "", err
	}
	if res.StatusCode >= 300 {
		return nil, "", fmt.Errorf("tripo status %d: %s", res.StatusCode, string(data))
	}
	meta := fmt.Sprintf("gaussians=%s format=%s seconds=%s",
		res.Header.Get("X-Num-Gaussians"),
		res.Header.Get("X-Output-Format"),
		res.Header.Get("X-Generation-Seconds"))
	return data, meta, nil
}
