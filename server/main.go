package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const outputDir = "output"

func main() {
	jobDir := flag.String("job", "", "serverless worker mode: run the pipeline once on this job dir, then exit")
	flag.Parse()
	if *jobDir != "" {
		runOnce(*jobDir)
		return
	}

	store := NewStore(outputDir)
	saveDefaultWorkflow(outputDir)

	if runpodConfigured() {
		log.Printf("RunPod mode: endpoint=%s  results→%s", os.Getenv("RUNPOD_ENDPOINT_ID"), publicBaseURL())
		if publicBaseURL() == "" {
			log.Println("  WARNING: WORLDSKETCH_PUBLIC_URL is empty — the worker can't return results")
		}
	} else {
		log.Println("Local pipeline mode (set RUNPOD_ENDPOINT_ID + RUNPOD_API_KEY + WORLDSKETCH_PUBLIC_URL for serverless)")
	}

	http.HandleFunc("/api/generate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		scene, files, err := readGenerateRequest(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		job := store.Create(scene, files)

		go store.Run(job.ID)
		writeJSON(w, http.StatusAccepted, map[string]string{"jobId": job.ID})
	})

	http.HandleFunc("/api/retrain", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 512<<20)

		bundle, err := readRetrainRequest(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		job, err := store.CreateRetrain(bundle)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		go store.RunRetrain(job.ID)
		writeJSON(w, http.StatusAccepted, map[string]string{"jobId": job.ID})
	})

	http.HandleFunc("/api/jobs/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/api/jobs/")

		// Result callback: the GPU worker PUTs a result zip here when it finishes.
		// Older workers may still PUT raw world.splat bytes; keep accepting both.
		if r.Method == http.MethodPut && strings.HasSuffix(id, "/result") {
			id = strings.TrimSuffix(id, "/result")
			if !store.validResultToken(id, r.URL.Query().Get("token")) {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			data, err := io.ReadAll(r.Body)
			if err != nil || len(data) == 0 {
				http.Error(w, "empty result body", http.StatusBadRequest)
				return
			}
			bytes, err := receiveWorkerResult(filepath.Join(outputDir, id), data)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			log.Printf("[%s] result received: %d bytes", id, bytes)
			store.markDone(id)
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "bytes": bytes})
			return
		}

		if strings.HasSuffix(id, "/world.ply") {
			id = strings.TrimSuffix(id, "/world.ply")
			http.ServeFile(w, r, filepath.Join(outputDir, id, "world.ply"))
			return
		}
		if strings.HasSuffix(id, "/world.splat") {
			id = strings.TrimSuffix(id, "/world.splat")
			http.ServeFile(w, r, filepath.Join(outputDir, id, "world.splat"))
			return
		}
		if strings.HasSuffix(id, "/training-bundle.zip") {
			id = strings.TrimSuffix(id, "/training-bundle.zip")
			ServeTrainingBundle(w, r, filepath.Join(outputDir, id))
			return
		}
		if strings.HasSuffix(id, "/collisions.json") {
			id = strings.TrimSuffix(id, "/collisions.json")
			ServeCollisions(w, r, filepath.Join(outputDir, id))
			return
		}
		if strings.HasSuffix(id, "/preview.png") {
			id = strings.TrimSuffix(id, "/preview.png")
			http.ServeFile(w, r, previewPath(filepath.Join(outputDir, id)))
			return
		}

		job, ok := store.Get(id)
		if !ok {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusOK, job)
	})

	os.MkdirAll(outputDir, 0755)
	http.Handle("/", http.FileServer(http.Dir("../client")))

	log.Println("Hosting files on port 8067")
	if err := http.ListenAndServe(":8067", nil); err != nil {
		log.Fatal(err)
	}
}

func receiveWorkerResult(dir string, data []byte) (int, error) {
	if len(data) >= 4 && string(data[:4]) == "PK\x03\x04" {
		return extractWorkerBundle(dir, data)
	}
	return len(data), os.WriteFile(filepath.Join(dir, "world.splat"), data, 0644)
}

func extractWorkerBundle(dir string, data []byte) (int, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return 0, err
	}

	total := 0
	for _, file := range reader.File {
		name := filepath.Clean(file.Name)
		if filepath.IsAbs(name) || strings.HasPrefix(name, ".."+string(filepath.Separator)) || name == ".." {
			return total, os.ErrPermission
		}
		target := filepath.Join(dir, name)
		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0755); err != nil {
				return total, err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return total, err
		}
		src, err := file.Open()
		if err != nil {
			return total, err
		}
		dst, err := os.Create(target)
		if err != nil {
			src.Close()
			return total, err
		}
		n, copyErr := io.Copy(dst, src)
		closeErr := dst.Close()
		src.Close()
		total += int(n)
		if copyErr != nil {
			return total, copyErr
		}
		if closeErr != nil {
			return total, closeErr
		}
	}
	return total, nil
}

// runOnce executes the pipeline a single time on a prepared job dir and exits.
// This is the serverless worker entrypoint: the RunPod handler stages inputs into
// the dir, runs this, then ships the resulting artifacts back.
func runOnce(dir string) {
	scene := readScene(filepath.Join(dir, "scene.json"))
	if err := RunPipeline(dir, scene, func(stage string) { log.Println("[pipeline]", stage) }); err != nil {
		log.Fatalf("pipeline failed: %v", err)
	}
	log.Println("pipeline complete:", filepath.Join(dir, "world.splat"))
}

type UploadedView struct {
	Name       string
	RGB        []byte
	Depth      []byte
	CameraJSON []byte
}

func readGenerateRequest(r *http.Request) (Scene, []UploadedView, error) {
	if err := r.ParseMultipartForm(96 << 20); err != nil {
		return Scene{}, nil, err
	}

	sceneFile, _, _ := r.FormFile("scene")
	defer sceneFile.Close()

	var scene Scene
	json.NewDecoder(sceneFile).Decode(&scene)

	views := make([]UploadedView, 0, len(viewNames))
	for _, name := range viewNames {
		views = append(views, readUploadedView(r, name))
	}

	return scene, views, nil
}

func readUploadedView(r *http.Request, name string) UploadedView {
	rgb, _ := readMultipartFile(r, name+"_rgb")
	depth, _ := readMultipartFile(r, name+"_depth")
	camera, _ := readMultipartFile(r, name+"_camera")
	return UploadedView{Name: name, RGB: rgb, Depth: depth, CameraJSON: camera}
}

func readRetrainRequest(r *http.Request) ([]byte, error) {
	if err := r.ParseMultipartForm(512 << 20); err != nil {
		return nil, err
	}
	file, _, err := r.FormFile("bundle")
	if err != nil {
		file, _, err = r.FormFile("training_bundle")
	}
	if err != nil {
		return nil, fmt.Errorf("bundle file is required")
	}
	defer file.Close()
	return io.ReadAll(file)
}

func readMultipartFile(r *http.Request, field string) ([]byte, error) {
	file, _, _ := r.FormFile(field)
	defer file.Close()
	return io.ReadAll(file)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}
