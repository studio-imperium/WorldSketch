package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Job struct {
	ID           string    `json:"id"`
	Status       string    `json:"status"`
	Error        string    `json:"error,omitempty"`
	PlyURL       string    `json:"plyUrl,omitempty"`
	CollisionURL string    `json:"collisionUrl,omitempty"`
	BundleURL    string    `json:"bundleUrl,omitempty"`
	PreviewURL   string    `json:"previewUrl,omitempty"`
	SplatURL     string    `json:"splatUrl,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

type Store struct {
	root string
	mu   sync.Mutex
	jobs map[string]*Job
}

func NewStore(root string) *Store {
	os.MkdirAll(root, 0755)
	return &Store{
		root: root,
		jobs: map[string]*Job{},
	}
}

func (s *Store) Create(scene Scene, views []UploadedView) *Job {
	id := newID()
	dir := filepath.Join(s.root, id)
	os.MkdirAll(dir, 0755)

	data, _ := json.MarshalIndent(scene, "", "\t")
	os.WriteFile(filepath.Join(dir, "scene.json"), data, 0644)
	writeViews(dir, views)

	now := time.Now()
	job := &Job{
		ID:           id,
		Status:       "queued",
		CollisionURL: "/api/jobs/" + id + "/collisions.json",
		CreatedAt:    now,
		UpdatedAt:    now,
	}

	s.mu.Lock()
	s.jobs[id] = job
	s.mu.Unlock()

	return job
}

func (s *Store) Get(id string) (*Job, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	job, ok := s.jobs[id]
	if !ok {
		return nil, false
	}

	copy := *job
	return &copy, true
}

func (s *Store) Run(id string) {
	dir := filepath.Join(s.root, id)
	scene := readScene(filepath.Join(dir, "scene.json"))

	s.set(id, "generating images", "")
	if err := RunComfy(dir, scene.Prompt); err != nil {
		s.fail(id, err)
		return
	}
	s.setPreview(id)

	s.set(id, "estimating depth", "")
	RunDepth(dir)

	s.set(id, "fusing views", "")
	plyPath := filepath.Join(dir, "world.ply")
	if err := WritePLYFromViews(scene, dir, plyPath); err != nil {
		if err := WritePLY(scene, plyPath, SeedFromString(id)); err != nil {
			s.fail(id, err)
			return
		}
	}
	s.setPLY(id)
	s.setBundle(id)

	s.set(id, "training splat", "")
	if err := RunSplatTraining(dir); err != nil {
		s.fail(id, err)
		return
	}

	s.mu.Lock()
	job := s.jobs[id]
	job.Status = "done"
	job.PlyURL = "/api/jobs/" + id + "/world.ply"
	job.CollisionURL = "/api/jobs/" + id + "/collisions.json"
	job.BundleURL = "/api/jobs/" + id + "/training-bundle.zip"
	job.PreviewURL = "/api/jobs/" + id + "/preview.png"
	job.SplatURL = "/api/jobs/" + id + "/world.splat"
	job.UpdatedAt = time.Now()
	s.mu.Unlock()
}

func writeViews(dir string, views []UploadedView) {
	for _, view := range views {
		viewDir := filepath.Join(dir, "views", view.Name)
		os.MkdirAll(viewDir, 0755)
		os.WriteFile(filepath.Join(viewDir, "primitive_rgb.png"), view.RGB, 0644)
		os.WriteFile(filepath.Join(viewDir, "primitive_depth.png"), view.Depth, 0644)
		os.WriteFile(filepath.Join(viewDir, "camera.json"), view.CameraJSON, 0644)
	}
}

func (s *Store) set(id, status, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	job := s.jobs[id]
	job.Status = status
	job.Error = message
	job.UpdatedAt = time.Now()
}

func (s *Store) fail(id string, err error) {
	s.set(id, "failed", err.Error())
}

func (s *Store) setPLY(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	job := s.jobs[id]
	job.PlyURL = "/api/jobs/" + id + "/world.ply"
	job.UpdatedAt = time.Now()
}

func (s *Store) setBundle(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	job := s.jobs[id]
	job.BundleURL = "/api/jobs/" + id + "/training-bundle.zip"
	job.UpdatedAt = time.Now()
}

func (s *Store) setPreview(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	job := s.jobs[id]
	job.PreviewURL = "/api/jobs/" + id + "/preview.png"
	job.UpdatedAt = time.Now()
}

func readScene(path string) Scene {
	var scene Scene
	data, _ := os.ReadFile(path)
	json.Unmarshal(data, &scene)
	return scene
}

func newID() string {
	var bytes [8]byte
	rand.Read(bytes[:])
	return hex.EncodeToString(bytes[:])
}
