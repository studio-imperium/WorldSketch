package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
)

type CollisionExport struct {
	Version   int         `json:"version"`
	Colliders []Primitive `json:"colliders"`
}

func ServeCollisions(w http.ResponseWriter, r *http.Request, dir string) {
	scene := readScene(filepath.Join(dir, "scene.json"))
	if _, err := os.Stat(filepath.Join(dir, "scene.json")); err != nil {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(CollisionExport{
		Version:   1,
		Colliders: scene.Primitives,
	})
}
