package main

import (
	"os"
	"path/filepath"
	"testing"
)

// writeFile creates parent dirs and writes dummy bytes at path.
func writeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte("dummy"), 0644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestGetReconstructsCompletedJobFromDisk(t *testing.T) {
	tmp := t.TempDir()
	store := NewStore(tmp)

	const id = "deadbeefdeadbeef"
	dir := filepath.Join(tmp, id)
	writeFile(t, filepath.Join(dir, "scene.json"))
	writeFile(t, filepath.Join(dir, "world.splat"))
	writeFile(t, filepath.Join(dir, "world.ply"))
	writeFile(t, filepath.Join(dir, "views", "front", "generated_rgb.png"))

	// The job was never Created in memory; Get must resurrect it from disk.
	job, ok := store.Get(id)
	if !ok {
		t.Fatal("Get returned ok=false for a completed job on disk")
	}
	if job.Status != "done" {
		t.Errorf("Status = %q, want %q", job.Status, "done")
	}
	if want := "/api/jobs/" + id + "/world.splat"; job.SplatURL != want {
		t.Errorf("SplatURL = %q, want %q", job.SplatURL, want)
	}
	if want := "/api/jobs/" + id + "/collisions.json"; job.CollisionURL != want {
		t.Errorf("CollisionURL = %q, want %q", job.CollisionURL, want)
	}
	if want := "/api/jobs/" + id + "/world.ply"; job.PlyURL != want {
		t.Errorf("PlyURL = %q, want %q", job.PlyURL, want)
	}
	if want := "/api/jobs/" + id + "/training-bundle.zip"; job.BundleURL != want {
		t.Errorf("BundleURL = %q, want %q", job.BundleURL, want)
	}
	if want := "/api/jobs/" + id + "/preview.png"; job.PreviewURL != want {
		t.Errorf("PreviewURL = %q, want %q", job.PreviewURL, want)
	}
}

func TestGetReconstructsWithoutOptionalArtifacts(t *testing.T) {
	tmp := t.TempDir()
	store := NewStore(tmp)

	const id = "cafecafecafecafe"
	dir := filepath.Join(tmp, id)
	writeFile(t, filepath.Join(dir, "scene.json"))
	writeFile(t, filepath.Join(dir, "world.splat"))

	job, ok := store.Get(id)
	if !ok {
		t.Fatal("Get returned ok=false for a completed job on disk")
	}
	if job.Status != "done" {
		t.Errorf("Status = %q, want %q", job.Status, "done")
	}
	if job.SplatURL == "" || job.CollisionURL == "" {
		t.Errorf("SplatURL/CollisionURL must be set; got SplatURL=%q CollisionURL=%q", job.SplatURL, job.CollisionURL)
	}
	if job.PlyURL != "" || job.BundleURL != "" {
		t.Errorf("PlyURL/BundleURL must be empty without world.ply; got PlyURL=%q BundleURL=%q", job.PlyURL, job.BundleURL)
	}
	if job.PreviewURL != "" {
		t.Errorf("PreviewURL must be empty without generated_rgb.png; got %q", job.PreviewURL)
	}
}

func TestGetReturnsFalseForInterruptedJob(t *testing.T) {
	tmp := t.TempDir()
	store := NewStore(tmp)

	const id = "0badf00d0badf00d"
	dir := filepath.Join(tmp, id)
	// scene.json present but no world.splat: interrupted, not resumable.
	writeFile(t, filepath.Join(dir, "scene.json"))

	if _, ok := store.Get(id); ok {
		t.Fatal("Get returned ok=true for an interrupted job (scene.json but no world.splat)")
	}
}

func TestGetReturnsFalseForUnknownID(t *testing.T) {
	tmp := t.TempDir()
	store := NewStore(tmp)

	if _, ok := store.Get("ffffffffffffffff"); ok {
		t.Fatal("Get returned ok=true for an unknown id with no dir on disk")
	}
}
