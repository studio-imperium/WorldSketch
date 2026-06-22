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
	// One-shot (no parent) must not include a parentPly key.
	if _, ok := input["parentPly"]; ok {
		t.Fatal("non-expansion payload should not include parentPly")
	}
}

// Expansion payload must carry the per-view mask + the parent's world.ply, and inherit
// the parent's prompt when none was supplied.
func TestBuildRunpodInputExpansion(t *testing.T) {
	root := t.TempDir()
	parentDir := filepath.Join(root, "parent")
	dir := filepath.Join(root, "child")
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(parentDir, "world.ply"), []byte("PLYBYTES"), 0644)
	os.WriteFile(filepath.Join(parentDir, "scene.json"), []byte(`{"version":1,"prompt":"mossy ruins"}`), 0644)

	vd := filepath.Join(dir, "views", viewNames[0])
	if err := os.MkdirAll(vd, 0755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(vd, "primitive_rgb.png"), []byte("RGB"), 0644)
	os.WriteFile(filepath.Join(vd, "primitive_depth.png"), []byte("D"), 0644)
	os.WriteFile(filepath.Join(vd, "camera.json"), []byte(`{"name":"front"}`), 0644)
	os.WriteFile(filepath.Join(vd, "new_mask.png"), []byte("MASKBYTES"), 0644)

	input, err := buildRunpodInput(dir, Scene{Parent: "parent"}, "https://x/result")
	if err != nil {
		t.Fatal(err)
	}

	plyB64, ok := input["parentPly"].(string)
	if !ok {
		t.Fatal("expansion payload missing parentPly")
	}
	if ply, _ := base64.StdEncoding.DecodeString(plyB64); string(ply) != "PLYBYTES" {
		t.Fatalf("parentPly not base64 of the parent world.ply: %q", plyB64)
	}
	if got := input["scene"].(Scene).Prompt; got != "mossy ruins" {
		t.Fatalf("expansion should inherit the parent prompt, got %q", got)
	}

	raw, _ := json.Marshal(input)
	var got struct {
		Views []struct {
			Mask string `json:"mask"`
		} `json:"views"`
	}
	json.Unmarshal(raw, &got)
	if mask, _ := base64.StdEncoding.DecodeString(got.Views[0].Mask); string(mask) != "MASKBYTES" {
		t.Fatalf("view mask not carried in payload, got %q", got.Views[0].Mask)
	}
}
