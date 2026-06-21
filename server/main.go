package main

import (
	"encoding/json"
	"flag"
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

	http.HandleFunc("/api/jobs/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/api/jobs/")

		// Result callback: the GPU worker PUTs world.splat here when it finishes.
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
			if err := os.WriteFile(filepath.Join(outputDir, id, "world.splat"), data, 0644); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			log.Printf("[%s] result received: %d bytes", id, len(data))
			store.markDone(id)
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "bytes": len(data)})
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
			http.ServeFile(w, r, filepath.Join(outputDir, id, "views", "front", "generated_rgb.png"))
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

// runOnce executes the pipeline a single time on a prepared job dir and exits.
// This is the serverless worker entrypoint: the RunPod handler stages inputs into
// the dir, runs this, then ships the resulting world.splat back.
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
