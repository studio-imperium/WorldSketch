package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// runpodConfigured reports whether the coordinator should delegate generation to a
// RunPod serverless endpoint (vs. running the pipeline locally).
func runpodConfigured() bool {
	return os.Getenv("RUNPOD_ENDPOINT_ID") != "" && os.Getenv("RUNPOD_API_KEY") != ""
}

// publicBaseURL is the externally reachable base URL of this coordinator, so the
// GPU worker can PUT results back (e.g. an ngrok URL in dev, a public host in prod).
func publicBaseURL() string {
	return strings.TrimRight(os.Getenv("WORLDSKETCH_PUBLIC_URL"), "/")
}

type runpodView struct {
	Name   string          `json:"name"`
	RGB    string          `json:"rgb"`
	Depth  string          `json:"depth"`
	Camera json.RawMessage `json:"camera"`
}

// buildRunpodInput packs the staged job dir into the worker's input payload:
// scene + base64 views + the callback URL the worker PUTs world.splat to.
func buildRunpodInput(dir string, scene Scene, resultURL string) (map[string]any, error) {
	var views []runpodView
	for _, name := range viewNames {
		viewDir := filepath.Join(dir, "views", name)
		rgb, err := os.ReadFile(filepath.Join(viewDir, "primitive_rgb.png"))
		if err != nil {
			continue
		}
		depth, _ := os.ReadFile(filepath.Join(viewDir, "primitive_depth.png"))
		camera, _ := os.ReadFile(filepath.Join(viewDir, "camera.json"))
		views = append(views, runpodView{
			Name:   name,
			RGB:    base64.StdEncoding.EncodeToString(rgb),
			Depth:  base64.StdEncoding.EncodeToString(depth),
			Camera: json.RawMessage(camera),
		})
	}
	if len(views) == 0 {
		return nil, errors.New("no views to submit")
	}
	return map[string]any{
		"scene":     scene,
		"views":     views,
		"resultUrl": resultURL,
	}, nil
}

func runpodEndpointURL(path string) string {
	return "https://api.runpod.ai/v2/" + os.Getenv("RUNPOD_ENDPOINT_ID") + "/" + path
}

func runpodAuth(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+os.Getenv("RUNPOD_API_KEY"))
	req.Header.Set("Content-Type", "application/json")
}

// runpodRun submits a job to the endpoint and returns the RunPod job id.
func runpodRun(input map[string]any) (string, error) {
	body, _ := json.Marshal(map[string]any{"input": input})
	req, _ := http.NewRequest(http.MethodPost, runpodEndpointURL("run"), bytes.NewReader(body))
	runpodAuth(req)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()

	data, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		return "", fmt.Errorf("runpod /run %d: %s", res.StatusCode, string(data))
	}
	var out struct {
		ID string `json:"id"`
	}
	json.Unmarshal(data, &out)
	if out.ID == "" {
		return "", fmt.Errorf("runpod /run: no job id in response: %s", string(data))
	}
	return out.ID, nil
}

// runpodStatus returns the RunPod job status (IN_QUEUE/IN_PROGRESS/COMPLETED/
// FAILED/...) and a message if it failed.
func runpodStatus(jobID string) (string, string) {
	req, _ := http.NewRequest(http.MethodGet, runpodEndpointURL("status/"+jobID), nil)
	runpodAuth(req)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err.Error()
	}
	defer res.Body.Close()

	var out struct {
		Status string          `json:"status"`
		Output json.RawMessage `json:"output"`
		Error  string          `json:"error"`
	}
	json.NewDecoder(res.Body).Decode(&out)

	// Include the worker's output (handler returns {error, log}) so failures show the
	// actual traceback in the coordinator console, not just a generic message.
	message := out.Error
	if len(out.Output) > 0 {
		message = strings.TrimSpace(message + " " + string(out.Output))
	}
	return out.Status, message
}
