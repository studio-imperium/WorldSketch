package imagegen

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"strings"

	"worldsketch/server/internal/config"
	"worldsketch/server/internal/httpx"
)

func OpenAIGround(image, mask []byte, promptText string, settings config.ImageEditSettings) ([]byte, error) {
	key := os.Getenv("OPENAI_API_KEY")
	if key == "" {
		return nil, errors.New("OPENAI_API_KEY is not set (required for ground expansion)")
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	writeImageEditFields(writer, settings, promptText)

	part, err := httpx.CreatePNGFormFile(writer, "image", "ground.png")
	if err != nil {
		return nil, err
	}
	if _, err := part.Write(image); err != nil {
		return nil, err
	}
	if len(mask) > 0 {
		mpart, err := httpx.CreatePNGFormFile(writer, "mask", "mask.png")
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

	return doOpenAIImageEdit(key, &body, writer.FormDataContentType(), "openai ground edit")
}

func OpenAIEdit(image, materialImage []byte, promptText string, settings config.ImageEditSettings) ([]byte, error) {
	key := os.Getenv("OPENAI_API_KEY")
	if key == "" {
		return nil, errors.New("OPENAI_API_KEY is not set")
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	writeImageEditFields(writer, settings, promptText)

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
		part, err := httpx.CreatePNGFormFile(writer, field, img.name)
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

	return doOpenAIImageEdit(key, &body, writer.FormDataContentType(), "openai image edit")
}

func writeImageEditFields(writer *multipart.Writer, settings config.ImageEditSettings, promptText string) {
	httpx.MustField(writer, "model", settings.OpenAIModel)
	httpx.MustField(writer, "size", settings.Size)
	httpx.MustField(writer, "prompt", promptText)
	httpx.OptField(writer, "quality", settings.Quality)
	if strings.EqualFold(settings.OpenAIModel, "gpt-image-1") {
		httpx.OptField(writer, "input_fidelity", settings.Fidelity)
	}
	httpx.OptField(writer, "background", settings.Background)
	httpx.OptField(writer, "output_format", settings.Format)
}

func doOpenAIImageEdit(key string, body io.Reader, contentType, label string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodPost, "https://api.openai.com/v1/images/edits", body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", contentType)

	res, err := httpx.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("%s failed: %s", label, string(data))
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, err
	}
	if b64 := httpx.FindString(parsed, "b64_json", "image_base64", "base64"); b64 != "" {
		return base64.StdEncoding.DecodeString(httpx.StripDataURL(b64))
	}
	if url := httpx.FindString(parsed, "url"); url != "" {
		return httpx.FetchBytes(url)
	}
	return nil, fmt.Errorf("%s returned no image", label)
}

func GeminiEdit(image, materialImage []byte, promptText, model string) ([]byte, error) {
	key := config.GeminiAPIKey()
	if key == "" {
		return nil, errors.New("GEMINI_API_KEY is not set (and not found in the Viggle backend .env)")
	}

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

	data, err := doGemini(model, key, payload, "gemini image edit")
	if err != nil {
		return nil, err
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
	for _, candidate := range parsed.Candidates {
		for _, part := range candidate.Content.Parts {
			if part.InlineData.Data == "" {
				continue
			}
			return base64.StdEncoding.DecodeString(part.InlineData.Data)
		}
	}
	return nil, errors.New("gemini image edit returned no image")
}

// GeminiText runs a JSON-mode prompt (optionally with one inline image, e.g. the
// user's top-down sketch for the scene planner) and returns the raw text response.
// thinkingBudget caps Gemini 2.5's hidden reasoning tokens — the default (unlimited)
// thinking costs 20-30s of wall time on a plan call; a low cap keeps a little planning
// depth at a few seconds. Negative = no cap (model default).
func GeminiText(promptText string, image []byte, model string, thinkingBudget int) (string, error) {
	key := config.GeminiAPIKey()
	if key == "" {
		return "", errors.New("GEMINI_API_KEY is not set (and not found in the Viggle backend .env)")
	}
	generationConfig := map[string]any{"responseMimeType": "application/json"}
	if thinkingBudget >= 0 {
		generationConfig["thinkingConfig"] = map[string]any{"thinkingBudget": thinkingBudget}
	}
	parts := []map[string]any{{"text": promptText}}
	if len(image) > 0 {
		parts = append(parts, map[string]any{"inlineData": map[string]string{"mimeType": "image/png", "data": base64.StdEncoding.EncodeToString(image)}})
	}
	payload, err := json.Marshal(map[string]any{
		"contents":         []map[string]any{{"role": "user", "parts": parts}},
		"generationConfig": generationConfig,
	})
	if err != nil {
		return "", err
	}

	data, err := doGemini(model, key, payload, "gemini plan")
	if err != nil {
		return "", err
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
		return "", err
	}
	var sb strings.Builder
	for _, candidate := range parsed.Candidates {
		for _, part := range candidate.Content.Parts {
			sb.WriteString(part.Text)
		}
	}
	return strings.TrimSpace(sb.String()), nil
}

func GeminiIdentify(image []byte, promptText string) (string, error) {
	key := config.GeminiAPIKey()
	if key == "" {
		return "", errors.New("GEMINI_API_KEY is not set (and not found in the Viggle backend .env)")
	}
	model := config.Env("WS_GEMINI_IDENTIFY_MODEL", "gemini-2.5-flash")

	parts := []map[string]any{
		{"text": promptText},
		{"inlineData": map[string]string{"mimeType": "image/png", "data": base64.StdEncoding.EncodeToString(image)}},
	}
	payload, err := json.Marshal(map[string]any{
		"contents":         []map[string]any{{"role": "user", "parts": parts}},
		"generationConfig": map[string]any{"responseMimeType": "application/json"},
	})
	if err != nil {
		return "", err
	}

	data, err := doGemini(model, key, payload, "gemini identify")
	if err != nil {
		return "", err
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
		return "", err
	}
	var sb strings.Builder
	for _, candidate := range parsed.Candidates {
		for _, part := range candidate.Content.Parts {
			sb.WriteString(part.Text)
		}
	}
	return strings.TrimSpace(sb.String()), nil
}

func doGemini(model, key string, payload []byte, label string) ([]byte, error) {
	url := "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", key)

	res, err := httpx.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("%s failed: %s", label, string(data))
	}
	return data, nil
}
