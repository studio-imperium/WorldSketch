package tripo

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"worldsketch/server/internal/config"
	"worldsketch/server/internal/httpx"
)

const defaultTripoURL = "http://148.153.245.160:17860"

type gradioFile struct {
	Path     string         `json:"path"`
	URL      string         `json:"url"`
	Size     int            `json:"size"`
	OrigName string         `json:"orig_name"`
	MIMEType string         `json:"mime_type"`
	IsStream bool           `json:"is_stream"`
	Meta     map[string]any `json:"meta"`
}

func Generate(image []byte, settings config.TripoSettings) ([]byte, error) {
	base := strings.TrimRight(config.Env("TRIPOSPLAT_URL", defaultTripoURL), "/")
	uploaded, err := uploadImage(base, image)
	if err != nil {
		return nil, err
	}
	outputs, err := callGenerate(base, uploaded, image, settings)
	if err != nil {
		return nil, err
	}
	file, err := selectOutputFile(outputs, settings.Format)
	if err != nil {
		return nil, err
	}
	return downloadFile(base, file)
}

func uploadImage(base string, image []byte) (string, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := httpx.CreatePNGFormFile(writer, "files", "subject.png")
	if err != nil {
		return "", err
	}
	if _, err := part.Write(image); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}

	req, err := http.NewRequest(http.MethodPost, base+"/gradio_api/upload", &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	res, err := httpx.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()

	data, err := io.ReadAll(res.Body)
	if err != nil {
		return "", err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("triposplat upload failed: %s", string(data))
	}
	var paths []string
	if err := json.Unmarshal(data, &paths); err != nil {
		return "", err
	}
	if len(paths) == 0 || paths[0] == "" {
		return "", errors.New("triposplat upload returned no file path")
	}
	return paths[0], nil
}

func callGenerate(base, uploadedPath string, image []byte, settings config.TripoSettings) ([]json.RawMessage, error) {
	format := strings.TrimSpace(settings.Format)
	if format == "" {
		format = "splat"
	}
	file := gradioFile{
		Path:     uploadedPath,
		URL:      "",
		Size:     len(image),
		OrigName: "subject.png",
		MIMEType: "image/png",
		IsStream: false,
		Meta:     map[string]any{"_type": "gradio.FileData"},
	}
	payload, err := json.Marshal(map[string]any{
		"image":          file,
		"seed":           42,
		"steps":          atoiDefault(settings.Steps, 20),
		"guidance_scale": atofDefault(settings.Guidance, 3),
		"num_gaussians":  atoiDefault(settings.Gaussians, 262144),
		"output_format":  format,
		"preprocess":     true,
	})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPost, base+"/gradio_api/call/v2/generate", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

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
		return nil, fmt.Errorf("triposplat call failed: %s", string(data))
	}
	var started struct {
		EventID string `json:"event_id"`
	}
	if err := json.Unmarshal(data, &started); err != nil {
		return nil, err
	}
	if started.EventID == "" {
		return nil, fmt.Errorf("triposplat call returned no event_id: %s", string(data))
	}
	return waitForResult(base, started.EventID)
}

func waitForResult(base, eventID string) ([]json.RawMessage, error) {
	req, err := http.NewRequest(http.MethodGet, base+"/gradio_api/call/generate/"+url.PathEscape(eventID), nil)
	if err != nil {
		return nil, err
	}
	res, err := httpx.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		data, _ := io.ReadAll(res.Body)
		return nil, fmt.Errorf("triposplat result failed: %s", string(data))
	}

	var event string
	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			raw := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if event == "error" {
				return nil, fmt.Errorf("triposplat failed: %s", raw)
			}
			if event != "complete" {
				continue
			}
			var output struct {
				Data []json.RawMessage `json:"data"`
			}
			if err := json.Unmarshal([]byte(raw), &output); err == nil && output.Data != nil {
				return output.Data, nil
			}
			var data []json.RawMessage
			if err := json.Unmarshal([]byte(raw), &data); err != nil {
				return nil, err
			}
			return data, nil
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return nil, errors.New("triposplat stream ended without a complete event")
}

func selectOutputFile(outputs []json.RawMessage, format string) (gradioFile, error) {
	var fallback *gradioFile
	want := "." + strings.TrimPrefix(strings.ToLower(strings.TrimSpace(format)), ".")
	for _, raw := range outputs {
		var file gradioFile
		if err := json.Unmarshal(raw, &file); err != nil || file.Path == "" {
			continue
		}
		if isImageFile(file) {
			continue
		}
		if fallback == nil {
			copy := file
			fallback = &copy
		}
		name := strings.ToLower(file.OrigName + " " + file.Path)
		if want != "." && strings.Contains(name, want) {
			return file, nil
		}
	}
	if fallback != nil {
		return *fallback, nil
	}
	return gradioFile{}, errors.New("triposplat returned no downloadable file")
}

func isImageFile(file gradioFile) bool {
	name := strings.ToLower(file.OrigName + " " + file.Path + " " + file.MIMEType)
	return strings.Contains(name, "image/") ||
		strings.Contains(name, ".png") ||
		strings.Contains(name, ".jpg") ||
		strings.Contains(name, ".jpeg") ||
		strings.Contains(name, ".webp")
}

func downloadFile(base string, file gradioFile) ([]byte, error) {
	if file.URL != "" {
		if strings.HasPrefix(file.URL, "http://") || strings.HasPrefix(file.URL, "https://") {
			return httpx.FetchBytes(file.URL)
		}
		return httpx.FetchBytes(base + "/" + strings.TrimLeft(file.URL, "/"))
	}
	if strings.HasPrefix(file.Path, "http://") || strings.HasPrefix(file.Path, "https://") {
		return httpx.FetchBytes(file.Path)
	}
	return httpx.FetchBytes(base + "/gradio_api/file=" + url.QueryEscape(file.Path))
}

func atoiDefault(value string, fallback int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
		return n
	}
	return fallback
}

func atofDefault(value string, fallback float64) float64 {
	if n, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil {
		return n
	}
	return fallback
}
