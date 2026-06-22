package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
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
	// Tripo returns the splat in its own centered/normalized frame (commonly Y-down vs our
	// Y-up viewer, and unit-scaled). Keep the raw output for debugging, then reorient + fit
	// it to the scene so it isn't upside down and roughly matches the block-out footprint.
	os.WriteFile(filepath.Join(dir, "world_raw.splat"), splat, 0644)
	final := splat
	if strings.EqualFold(envStr("WS_TRIPO_FORMAT", "splat"), "splat") {
		final = normalizeSplat(splat, scene)
	}
	if err := os.WriteFile(filepath.Join(dir, "world.splat"), final, 0644); err != nil {
		return fmt.Errorf("write world.splat: %w", err)
	}
	log.Printf("tripo: wrote %d-byte world.splat (%s)", len(final), meta)
	return nil
}

// normalizeSplat reorients Tripo's raw splat into the editor's Y-up world and fits it to the
// scene. It operates on the standard 32-byte .splat record: center[0:12] f32, scale[12:24]
// f32, color[24:28] u8, rotation[28:32] u8 packed as (q*128+128) in w,x,y,z order.
//   - WS_TRIPO_FLIP (none|x|y|z, default x): 180° rotation that fixes the upside-down output.
//   - WS_TRIPO_FIT (default on): uniform-scale + translate so the splat fills the scene's XZ
//     footprint and rests on the ground (scene Bounds.Min.Y).
//
// Anything unexpected (not a 32-byte multiple, degenerate bounds) is left untouched.
func normalizeSplat(raw []byte, scene Scene) []byte {
	const stride = 32
	if len(raw) == 0 || len(raw)%stride != 0 {
		return raw
	}
	n := len(raw) / stride
	out := make([]byte, len(raw))
	copy(out, raw)
	le := binary.LittleEndian

	fw, fx, fy, fz, doFlip := flipQuat(envStr("WS_TRIPO_FLIP", "x"))

	// Pass 1: read centers, apply the flip, track the post-flip AABB.
	cx := make([]float64, n)
	cy := make([]float64, n)
	cz := make([]float64, n)
	var minx, miny, minz, maxx, maxy, maxz float64
	for i := 0; i < n; i++ {
		b := i * stride
		x := float64(math.Float32frombits(le.Uint32(out[b:])))
		y := float64(math.Float32frombits(le.Uint32(out[b+4:])))
		z := float64(math.Float32frombits(le.Uint32(out[b+8:])))
		if doFlip {
			x, y, z = quatRotateVec(fw, fx, fy, fz, x, y, z)
		}
		cx[i], cy[i], cz[i] = x, y, z
		if i == 0 {
			minx, maxx, miny, maxy, minz, maxz = x, x, y, y, z, z
			continue
		}
		minx, maxx = math.Min(minx, x), math.Max(maxx, x)
		miny, maxy = math.Min(miny, y), math.Max(maxy, y)
		minz, maxz = math.Min(minz, z), math.Max(maxz, z)
	}

	// Fit: uniform scale to the scene footprint, center in XZ, rest on the ground.
	scale, tx, ty, tz := 1.0, 0.0, 0.0, 0.0
	bMin, bMax := scene.Bounds.Min, scene.Bounds.Max
	exX, exZ := maxx-minx, maxz-minz
	sExX, sExZ := bMax[0]-bMin[0], bMax[2]-bMin[2]
	if envBoolDefault("WS_TRIPO_FIT", true) && exX > 1e-6 && exZ > 1e-6 && sExX > 1e-6 && sExZ > 1e-6 {
		scale = math.Min(sExX/exX, sExZ/exZ)
		tx = (bMin[0]+bMax[0])/2 - (minx+maxx)/2*scale
		tz = (bMin[2]+bMax[2])/2 - (minz+maxz)/2*scale
		ty = bMin[1] - miny*scale
	}

	// Pass 2: write transformed centers + scaled gaussians + flipped rotations.
	for i := 0; i < n; i++ {
		b := i * stride
		le.PutUint32(out[b:], math.Float32bits(float32(cx[i]*scale+tx)))
		le.PutUint32(out[b+4:], math.Float32bits(float32(cy[i]*scale+ty)))
		le.PutUint32(out[b+8:], math.Float32bits(float32(cz[i]*scale+tz)))

		for k := 0; k < 3; k++ { // scales are linear (exp'd) — uniform multiply
			off := b + 12 + k*4
			s := float64(math.Float32frombits(le.Uint32(out[off:]))) * scale
			le.PutUint32(out[off:], math.Float32bits(float32(s)))
		}

		if doFlip { // q' = flip * q, re-packed as (q*128+128) in w,x,y,z
			rw := (float64(out[b+28]) - 128) / 128
			rx := (float64(out[b+29]) - 128) / 128
			ry := (float64(out[b+30]) - 128) / 128
			rz := (float64(out[b+31]) - 128) / 128
			qw, qx, qy, qz := quatMul(fw, fx, fy, fz, rw, rx, ry, rz)
			if nrm := math.Sqrt(qw*qw + qx*qx + qy*qy + qz*qz); nrm > 1e-9 {
				qw, qx, qy, qz = qw/nrm, qx/nrm, qy/nrm, qz/nrm
			}
			out[b+28], out[b+29], out[b+30], out[b+31] = quatByte(qw), quatByte(qx), quatByte(qy), quatByte(qz)
		}
	}
	return out
}

// flipQuat maps a WS_TRIPO_FLIP preset to a 180° rotation quaternion (w,x,y,z). ok=false
// means identity (no reorientation).
func flipQuat(preset string) (w, x, y, z float64, ok bool) {
	switch strings.ToLower(strings.TrimSpace(preset)) {
	case "x": // 180° about X: (x,y,z) -> (x,-y,-z)
		return 0, 1, 0, 0, true
	case "y": // 180° about Y: (x,y,z) -> (-x,y,-z)
		return 0, 0, 1, 0, true
	case "z": // 180° about Z: (x,y,z) -> (-x,-y,z)
		return 0, 0, 0, 1, true
	default: // "none" / unknown
		return 1, 0, 0, 0, false
	}
}

// quatRotateVec rotates (vx,vy,vz) by the unit quaternion (qw,qx,qy,qz).
func quatRotateVec(qw, qx, qy, qz, vx, vy, vz float64) (float64, float64, float64) {
	tx := 2 * (qy*vz - qz*vy)
	ty := 2 * (qz*vx - qx*vz)
	tz := 2 * (qx*vy - qy*vx)
	return vx + qw*tx + (qy*tz - qz*ty),
		vy + qw*ty + (qz*tx - qx*tz),
		vz + qw*tz + (qx*ty - qy*tx)
}

// quatMul returns the Hamilton product a*b, both (w,x,y,z).
func quatMul(aw, ax, ay, az, bw, bx, by, bz float64) (w, x, y, z float64) {
	return aw*bw - ax*bx - ay*by - az*bz,
		aw*bx + ax*bw + ay*bz - az*by,
		aw*by - ax*bz + ay*bw + az*bx,
		aw*bz + ax*by - ay*bx + az*bw
}

// quatByte packs a quaternion component in [-1,1] into the .splat u8 encoding (q*128+128).
func quatByte(q float64) byte {
	v := math.Round(q*128 + 128)
	if v < 0 {
		v = 0
	}
	if v > 255 {
		v = 255
	}
	return byte(v)
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
