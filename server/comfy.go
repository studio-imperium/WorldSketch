package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const comfyURL = "http://127.0.0.1:8188"
const defaultPositivePrompt = "stylized realistic game environment, pale blue overcast sky, soft ambient diffuse lighting, shadowless albedo material look, no directional sunlight, readable object silhouettes, coherent 3d scene"

func RunComfy(dir, scenePrompt string) error {
	ckpt, err := firstCheckpoint()
	if err != nil {
		writeLog(dir, "comfy.log", err.Error())
		return err
	}

	control, _ := firstControlNet()
	depthControl := firstDepthControlNet()
	saveWorkflowFiles(dir, ckpt, control)

	if err := generateBatchedViews(dir, ckpt, control, depthControl, scenePrompt); err != nil {
		writeLog(dir, "comfy.log", err.Error())
		return err
	}
	return nil
}

func firstCheckpoint() (string, error) {
	names, err := checkpointNames()
	if err != nil {
		return "", err
	}
	if len(names) == 0 {
		return "", errors.New("ComfyUI has no installed checkpoints")
	}
	for _, name := range names {
		if name == "DreamShaper_8_pruned.safetensors" {
			return name, nil
		}
	}
	return names[0], nil
}

func firstZero123Checkpoint() (string, error) {
	names, err := checkpointNames()
	if err != nil {
		return "", err
	}
	for _, name := range names {
		if name == "stable_zero123_c.ckpt" || name == "stable_zero123.ckpt" {
			return name, nil
		}
	}
	return "", errors.New("Stable Zero123 checkpoint missing. Download stable_zero123_c.ckpt or stable_zero123.ckpt into /Users/wqm/ComfyUI-Shared/models/checkpoints to enable hero-conditioned multiview generation")
}

func checkpointNames() ([]string, error) {
	res, err := http.Get(comfyURL + "/object_info/CheckpointLoaderSimple")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	var data map[string]struct {
		Input struct {
			Required map[string][]json.RawMessage `json:"required"`
		} `json:"input"`
	}
	json.NewDecoder(res.Body).Decode(&data)

	raw := data["CheckpointLoaderSimple"].Input.Required["ckpt_name"]
	if len(raw) == 0 {
		return nil, errors.New("ComfyUI has no checkpoint list")
	}

	var names []string
	json.Unmarshal(raw[0], &names)
	return names, nil
}

func controlNetNames() ([]string, error) {
	res, err := http.Get(comfyURL + "/object_info/ControlNetLoader")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	var data map[string]struct {
		Input struct {
			Required map[string][]json.RawMessage `json:"required"`
		} `json:"input"`
	}
	json.NewDecoder(res.Body).Decode(&data)

	raw := data["ControlNetLoader"].Input.Required["control_net_name"]
	if len(raw) == 0 {
		return nil, errors.New("ComfyUI has no ControlNet model list")
	}

	var names []string
	json.Unmarshal(raw[0], &names)
	return names, nil
}

func firstControlNet() (string, error) {
	names, err := controlNetNames()
	if err != nil {
		return "", err
	}
	if len(names) == 0 {
		return "", errors.New("ComfyUI has no installed ControlNet models")
	}
	for _, name := range names {
		if name == "control_v11p_sd15_canny.pth" {
			return name, nil
		}
	}
	return names[0], nil
}

// firstDepthControlNet returns an installed SD1.5 depth ControlNet, or "" if none
// is present (the workflow then falls back to canny-only — no error).
func firstDepthControlNet() string {
	names, err := controlNetNames()
	if err != nil {
		return ""
	}
	for _, name := range names {
		switch name {
		case "control_v11f1p_sd15_depth.pth", "control_v11p_sd15_depth.pth", "control_sd15_depth.pth":
			return name
		}
	}
	return ""
}

type viewJob struct {
	name      string
	rgbName   string
	edgeName  string
	depthName string
	outPath   string
}

// generateBatchedViews renders every view in a single batched diffusion: all view
// inputs are stacked into one batch=N latent and denoised in one KSampler call,
// keeping the GPU saturated instead of paying per-view setup and HTTP round-trips.
func generateBatchedViews(dir, ckpt, control, depthControl, scenePrompt string) error {
	var jobs []viewJob
	for _, name := range viewNames {
		viewDir := filepath.Join(dir, "views", name)
		in := filepath.Join(viewDir, "primitive_rgb.png")
		if _, err := os.Stat(in); err != nil {
			continue
		}
		edge := filepath.Join(viewDir, "primitive_edges.png")
		WriteEdgeMap(in, edge)

		rgbName, err := uploadImage(in, "worldsketch_"+name+".png")
		if err != nil {
			return err
		}
		edgeName, err := uploadImage(edge, "worldsketch_"+name+"_edges.png")
		if err != nil {
			return err
		}

		depthName := ""
		if depthControl != "" {
			depthCtrl := filepath.Join(viewDir, "primitive_depth_control.png")
			WriteDepthControl(filepath.Join(viewDir, "primitive_depth.png"), depthCtrl)
			depthName, err = uploadImage(depthCtrl, "worldsketch_"+name+"_depth.png")
			if err != nil {
				return err
			}
		}

		jobs = append(jobs, viewJob{name, rgbName, edgeName, depthName, filepath.Join(viewDir, "generated_rgb.png")})
	}
	if len(jobs) == 0 {
		return errors.New("no views with primitive_rgb to generate")
	}

	prompt := batchedWorkflow(ckpt, control, depthControl, jobs, positivePrompt(scenePrompt))
	saveJSON(filepath.Join(dir, "comfy_api_prompt.json"), prompt)

	promptID, err := queuePrompt(prompt)
	if err != nil {
		return err
	}

	images, err := waitForImages(promptID)
	if err != nil {
		return err
	}
	if len(images) < len(jobs) {
		return fmt.Errorf("comfy returned %d images for %d views", len(images), len(jobs))
	}

	// SaveImage preserves batch order, so images[i] corresponds to jobs[i].
	for i, job := range jobs {
		data, err := downloadComfyImage(images[i])
		if err != nil {
			return err
		}
		if err := os.WriteFile(job.outPath, data, 0644); err != nil {
			return err
		}
	}
	return nil
}

func uploadImage(path, name string) (string, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	file, _ := os.Open(path)
	defer file.Close()

	part, _ := writer.CreateFormFile("image", name)
	io.Copy(part, file)
	writer.WriteField("type", "input")
	writer.WriteField("overwrite", "true")
	writer.Close()

	req, _ := http.NewRequest(http.MethodPost, comfyURL+"/upload/image", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()

	if res.StatusCode >= 300 {
		data, _ := io.ReadAll(res.Body)
		return "", errors.New(string(data))
	}

	var out struct {
		Name string `json:"name"`
	}
	json.NewDecoder(res.Body).Decode(&out)
	return out.Name, nil
}

func queuePrompt(prompt map[string]any) (string, error) {
	payload := map[string]any{
		"client_id": "worldsketch",
		"prompt":    prompt,
	}
	data, _ := json.Marshal(payload)

	res, err := http.Post(comfyURL+"/prompt", "application/json", bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	defer res.Body.Close()

	if res.StatusCode >= 300 {
		data, _ := io.ReadAll(res.Body)
		return "", errors.New(string(data))
	}

	var out struct {
		PromptID string `json:"prompt_id"`
	}
	json.NewDecoder(res.Body).Decode(&out)
	return out.PromptID, nil
}

func waitForImages(promptID string) ([]ComfyImage, error) {
	deadline := time.Now().Add(8 * time.Minute)
	for time.Now().Before(deadline) {
		res, err := http.Get(comfyURL + "/history/" + promptID)
		if err != nil {
			return nil, err
		}

		var history map[string]struct {
			Outputs map[string]struct {
				Images []ComfyImage `json:"images"`
			} `json:"outputs"`
		}
		json.NewDecoder(res.Body).Decode(&history)
		res.Body.Close()

		for _, item := range history {
			for _, output := range item.Outputs {
				if len(output.Images) > 0 {
					return output.Images, nil
				}
			}
		}

		time.Sleep(150 * time.Millisecond)
	}
	return nil, errors.New("ComfyUI generation timed out")
}

type ComfyImage struct {
	Filename  string `json:"filename"`
	Subfolder string `json:"subfolder"`
	Type      string `json:"type"`
}

func downloadComfyImage(image ComfyImage) ([]byte, error) {
	q := url.Values{}
	q.Set("filename", image.Filename)
	q.Set("subfolder", image.Subfolder)
	q.Set("type", image.Type)

	res, err := http.Get(comfyURL + "/view?" + q.Encode())
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		data, _ := io.ReadAll(res.Body)
		return nil, errors.New(string(data))
	}
	return io.ReadAll(res.Body)
}

func batchedWorkflow(ckpt, control, depthControl string, jobs []viewJob, positiveText string) map[string]any {
	seed := 1125899906842624

	prompt := map[string]any{
		"ckpt": node("CheckpointLoaderSimple", map[string]any{"ckpt_name": ckpt}),
		"pos": node("CLIPTextEncode", map[string]any{
			"text": positiveText,
			"clip": link("ckpt", 1),
		}),
		"neg": node("CLIPTextEncode", map[string]any{
			"text": "black background, darkness, night, galaxy, stars, abstract noise, empty image, blank image, hard shadows, cast shadows, directional sunlight, dramatic lighting, rim light, baked lighting, dark shading, high contrast lighting, spotlight, sunset, text, watermark, blurry, people",
			"clip": link("ckpt", 1),
		}),
	}

	// Stack every view's input image into one batch latent.
	rgbBatch := loadImageBatch(prompt, jobs, "rgb", func(j viewJob) string { return j.rgbName })
	prompt["vae_encode"] = node("VAEEncode", map[string]any{
		"pixels": link(rgbBatch, 0),
		"vae":    link("ckpt", 2),
	})

	// Apply ControlNets in series: canny pins silhouettes, depth pins surface
	// geometry so the same point lands consistently across views.
	positive := link("pos", 0)
	negative := link("neg", 0)
	if control != "" {
		edgeBatch := loadImageBatch(prompt, jobs, "edge", func(j viewJob) string { return j.edgeName })
		prompt["cnet_loader"] = node("ControlNetLoader", map[string]any{"control_net_name": control})
		prompt["cnet"] = node("ControlNetApplyAdvanced", map[string]any{
			"positive":      positive,
			"negative":      negative,
			"control_net":   link("cnet_loader", 0),
			"image":         link(edgeBatch, 0),
			"strength":      0.9,
			"start_percent": 0.0,
			"end_percent":   0.9,
		})
		positive = link("cnet", 0)
		negative = link("cnet", 1)
	}
	if depthControl != "" {
		depthBatch := loadImageBatch(prompt, jobs, "depth", func(j viewJob) string { return j.depthName })
		prompt["cnet_depth_loader"] = node("ControlNetLoader", map[string]any{"control_net_name": depthControl})
		prompt["cnet_depth"] = node("ControlNetApplyAdvanced", map[string]any{
			"positive":      positive,
			"negative":      negative,
			"control_net":   link("cnet_depth_loader", 0),
			"image":         link(depthBatch, 0),
			"strength":      0.6,
			"start_percent": 0.0,
			"end_percent":   0.8,
		})
		positive = link("cnet_depth", 0)
		negative = link("cnet_depth", 1)
	}

	prompt["ksampler"] = node("KSampler", map[string]any{
		"model":        link("ckpt", 0),
		"positive":     positive,
		"negative":     negative,
		"latent_image": link("vae_encode", 0),
		"seed":         seed,
		"steps":        7,
		"cfg":          6.5,
		"sampler_name": "euler",
		"scheduler":    "normal",
		"denoise":      0.5,
	})
	prompt["decode"] = node("VAEDecode", map[string]any{
		"samples": link("ksampler", 0),
		"vae":     link("ckpt", 2),
	})
	prompt["save"] = node("SaveImage", map[string]any{
		"images":          link("decode", 0),
		"filename_prefix": "worldsketch_batch",
	})

	return prompt
}

func positivePrompt(scenePrompt string) string {
	// Always use the base positive prompt; append the player's prompt when present.
	scenePrompt = strings.TrimSpace(scenePrompt)
	if scenePrompt == "" {
		return defaultPositivePrompt
	}
	return scenePrompt + ", " + defaultPositivePrompt
}

// loadImageBatch adds one LoadImage node per view (image name chosen by pick) and
// stacks them into a single IMAGE batch. Returns the node id of the final batch.
func loadImageBatch(prompt map[string]any, jobs []viewJob, prefix string, pick func(viewJob) string) string {
	ids := make([]string, len(jobs))
	for i, job := range jobs {
		id := fmt.Sprintf("%s_%d", prefix, i)
		prompt[id] = node("LoadImage", map[string]any{"image": pick(job)})
		ids[i] = id
	}
	return batchImages(prompt, ids, prefix+"_batch")
}

// batchImages stacks several LoadImage outputs into one IMAGE batch by chaining
// the core two-input ImageBatch node. Returns the node id of the final batch.
func batchImages(prompt map[string]any, loadIDs []string, prefix string) string {
	current := loadIDs[0]
	for i := 1; i < len(loadIDs); i++ {
		id := fmt.Sprintf("%s_%d", prefix, i)
		prompt[id] = node("ImageBatch", map[string]any{
			"image1": link(current, 0),
			"image2": link(loadIDs[i], 0),
		})
		current = id
	}
	return current
}

func heroViewName() string {
	return viewNames[0]
}

func novelViewPose(name string) (float64, float64) {
	switch name {
	case "right":
		return 90, 0
	case "left":
		return -90, 0
	case "back":
		return 180, 0
	case "top":
		return 0, 75
	case "corner_fr":
		return 45, 37
	case "corner_fl":
		return -45, 37
	case "corner_br":
		return 135, 37
	case "corner_bl":
		return -135, 37
	default:
		return 0, 0
	}
}

func node(class string, inputs map[string]any) map[string]any {
	return map[string]any{
		"class_type": class,
		"inputs":     inputs,
	}
}

func link(id string, slot int) []any {
	return []any{id, slot}
}

func copyPrimitiveRGB(dir string) {
	for _, name := range viewNames {
		viewDir := filepath.Join(dir, "views", name)
		copyFile(filepath.Join(viewDir, "primitive_rgb.png"), filepath.Join(viewDir, "generated_rgb.png"))
	}
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0644)
}

func writeLog(dir, name, message string) {
	os.WriteFile(filepath.Join(dir, name), []byte(message), 0644)
}
