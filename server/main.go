package main

import (
	"log"
	"net/http"
	"path/filepath"

	"worldsketch/server/internal/config"
	"worldsketch/server/internal/handlers"
	"worldsketch/server/internal/httpx"
)

func main() {
	config.LoadDotEnv()

	mux := http.NewServeMux()
	handlers.Register(mux)

	clientDir := filepath.Join(config.RootDir(), "client")
	mux.Handle("/", httpx.NoCache(http.FileServer(http.Dir(clientDir))))

	addr := config.Env("PORT", "8067")
	log.Printf("WorldSketch listening on http://localhost:%s", addr)
	log.Fatal(http.ListenAndServe(":"+addr, mux))
}
