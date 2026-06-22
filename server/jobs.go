package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
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
	root   string
	mu     sync.Mutex
	jobs   map[string]*Job
	tokens map[string]string // job id -> one-time token guarding its result callback
}

func NewStore(root string) *Store {
	os.MkdirAll(root, 0755)
	return &Store{
		root:   root,
		jobs:   map[string]*Job{},
		tokens: map[string]string{},
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

	// Serverless: hand the whole pipeline to the RunPod GPU worker instead of
	// running ComfyUI + gsplat locally. The worker PUTs world.splat back to us.
	if runpodConfigured() {
		s.runRemote(id, dir, scene)
		return
	}

	s.set(id, "generating images", "")
	if err := runImageGen(dir, scene.Prompt); err != nil {
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
	if message != "" {
		log.Printf("[%s] %s: %s", id, status, message)
	} else {
		log.Printf("[%s] %s", id, status)
	}

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

// runRemote submits the job to the RunPod serverless worker and waits for it to
// finish. The worker PUTs world.splat back to a one-time callback URL (handled in
// main.go), which marks the job done; we poll RunPod only to surface failures.
func (s *Store) runRemote(id, dir string, scene Scene) {
	base := publicBaseURL()
	if base == "" {
		s.fail(id, errors.New("WORLDSKETCH_PUBLIC_URL is not set — the GPU worker needs a public URL to return results"))
		return
	}

	token := newID()
	s.mu.Lock()
	s.tokens[id] = token
	s.mu.Unlock()
	resultURL := base + "/api/jobs/" + id + "/result?token=" + token

	s.set(id, "submitting to gpu", "")
	input, err := buildRunpodInput(dir, scene, resultURL)
	if err != nil {
		s.fail(id, err)
		return
	}
	rpID, err := runpodRun(input)
	if err != nil {
		s.fail(id, err)
		return
	}
	log.Printf("[%s] runpod job %s queued; awaiting result at %s", id, rpID, resultURL)

	s.set(id, "generating on gpu", "")
	deadline := time.Now().Add(20 * time.Minute)
	lastStatus := ""
	for time.Now().Before(deadline) {
		time.Sleep(2 * time.Second)
		if s.isDone(id) {
			return // the result callback already completed the job
		}
		status, message := runpodStatus(rpID)
		if status != lastStatus {
			log.Printf("[%s] runpod status: %s", id, status)
			lastStatus = status
		}
		switch status {
		case "FAILED", "CANCELLED", "TIMED_OUT":
			s.fail(id, fmt.Errorf("gpu job %s: %s", strings.ToLower(status), message))
			return
		}
	}
	if !s.isDone(id) {
		s.fail(id, errors.New("gpu job timed out (worker never PUT a result — is the tunnel/public URL alive?)"))
	}
}

// markDone is called by the result callback once world.splat has been received.
func (s *Store) markDone(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job := s.jobs[id]
	if job == nil {
		return
	}
	job.Status = "done"
	job.SplatURL = "/api/jobs/" + id + "/world.splat"
	job.CollisionURL = "/api/jobs/" + id + "/collisions.json"
	if fileExists(filepath.Join(s.root, id, "world.ply")) {
		job.PlyURL = "/api/jobs/" + id + "/world.ply"
		job.BundleURL = "/api/jobs/" + id + "/training-bundle.zip"
	}
	if fileExists(filepath.Join(s.root, id, "views", "front", "generated_rgb.png")) {
		job.PreviewURL = "/api/jobs/" + id + "/preview.png"
	}
	job.UpdatedAt = time.Now()
}

func (s *Store) isDone(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	job := s.jobs[id]
	return job != nil && job.Status == "done"
}

func (s *Store) validResultToken(id, token string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	want, ok := s.tokens[id]
	return ok && token != "" && token == want
}

func readScene(path string) Scene {
	var scene Scene
	data, _ := os.ReadFile(path)
	json.Unmarshal(data, &scene)
	return scene
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func newID() string {
	var bytes [8]byte
	rand.Read(bytes[:])
	return hex.EncodeToString(bytes[:])
}
