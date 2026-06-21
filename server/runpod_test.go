package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Validates the payload shape handler.py consumes: base64 rgb/depth, camera as a
// JSON object (not a string), and resultUrl.
func TestBuildRunpodInput(t *testing.T) {
	dir := t.TempDir()
	vd := filepath.Join(dir, "views", viewNames[0])
	if err := os.MkdirAll(vd, 0755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(vd, "primitive_rgb.png"), []byte("RGBDATA"), 0644)
	os.WriteFile(filepath.Join(vd, "primitive_depth.png"), []byte("DEPTHDATA"), 0644)
	os.WriteFile(filepath.Join(vd, "camera.json"), []byte(`{"name":"front","fov":50}`), 0644)

	input, err := buildRunpodInput(dir, Scene{}, "https://x/result?token=abc")
	if err != nil {
		t.Fatal(err)
	}
	if input["resultUrl"] != "https://x/result?token=abc" {
		t.Fatalf("bad resultUrl: %v", input["resultUrl"])
	}

	raw, _ := json.Marshal(input)
	var got struct {
		Views []struct {
			Name   string          `json:"name"`
			RGB    string          `json:"rgb"`
			Camera json.RawMessage `json:"camera"`
		} `json:"views"`
		ResultURL string `json:"resultUrl"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Views) != 1 || got.Views[0].Name != viewNames[0] {
		t.Fatalf("views wrong: %+v", got.Views)
	}
	rgb, _ := base64.StdEncoding.DecodeString(got.Views[0].RGB)
	if string(rgb) != "RGBDATA" {
		t.Fatalf("rgb not base64 of file bytes: %q", got.Views[0].RGB)
	}
	var cam map[string]any
	if err := json.Unmarshal(got.Views[0].Camera, &cam); err != nil {
		t.Fatalf("camera must be a JSON object, got %s: %v", got.Views[0].Camera, err)
	}
	if cam["name"] != "front" {
		t.Fatalf("camera content wrong: %v", cam)
	}
}
