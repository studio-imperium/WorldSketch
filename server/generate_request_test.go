package main

import (
	"bytes"
	"mime/multipart"
	"net/http/httptest"
	"testing"
)

// buildGenerateRequest forges a multipart /api/generate body. includeMasks toggles the
// per-view _mask parts (sent only on expansion submits).
func buildGenerateRequest(t *testing.T, sceneJSON string, includeMasks bool) {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)

	scene, _ := w.CreateFormFile("scene", "scene.json")
	scene.Write([]byte(sceneJSON))

	for _, name := range viewNames {
		for _, suffix := range []string{"_rgb", "_depth", "_camera"} {
			part, _ := w.CreateFormFile(name+suffix, "f.bin")
			part.Write([]byte("x"))
		}
		if includeMasks {
			part, _ := w.CreateFormFile(name+"_mask", "new_mask.png")
			part.Write([]byte("x"))
		}
	}
	w.Close()

	req := httptest.NewRequest("POST", "/api/generate", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	// readGenerateRequest is the synchronous path that must never panic on a well-formed
	// (or mask-less) request — a nil FormFile on a missing optional part once did.
	_, views, err := readGenerateRequest(req)
	if err != nil {
		t.Fatalf("readGenerateRequest errored: %v", err)
	}
	if len(views) != len(viewNames) {
		t.Fatalf("expected %d views, got %d", len(viewNames), len(views))
	}
}

func TestReadGenerateRequestNoMasks(t *testing.T) {
	// Plain (non-expansion) generation sends no _mask parts — must not panic.
	buildGenerateRequest(t, `{"version":1,"primitives":[{"id":"a","type":"box"}]}`, false)
}

func TestReadGenerateRequestWithMasks(t *testing.T) {
	buildGenerateRequest(t, `{"version":1,"parent":"p","primitives":[{"id":"a","type":"box","existing":true},{"id":"b","type":"sphere"}]}`, true)
}

func TestReadGenerateRequestMissingSceneIsError(t *testing.T) {
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	w.Close()
	req := httptest.NewRequest("POST", "/api/generate", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	if _, _, err := readGenerateRequest(req); err == nil {
		t.Fatal("expected an error when the scene part is missing, got nil")
	}
}
