package main

import (
	"archive/zip"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func ServeTrainingBundle(w http.ResponseWriter, r *http.Request, dir string) {
	if _, err := os.Stat(filepath.Join(dir, "world.ply")); err != nil {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="worldsketch-training-bundle.zip"`)

	zipper := zip.NewWriter(w)
	defer zipper.Close()

	addDir(zipper, dir, "job")
	addFile(zipper, "../services/ml/train_splat.py", "train_splat.py")
	addFile(zipper, "../services/ml/requirements.txt", "requirements.txt")
	addFile(zipper, "../scripts/runpod-train-bundle.sh", "runpod-train-bundle.sh")
	addText(zipper, "run_train.sh", runTrainScript())
	addText(zipper, "README.md", bundleReadme())
}

func addDir(zipper *zip.Writer, dir string, prefix string) {
	filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}

		name, _ := filepath.Rel(dir, path)
		if strings.HasSuffix(name, ".splat") {
			return nil
		}

		addFile(zipper, path, filepath.Join(prefix, name))
		return nil
	})
}

func addFile(zipper *zip.Writer, path string, name string) {
	file, _ := os.Open(path)
	defer file.Close()

	info, _ := file.Stat()
	header, _ := zip.FileInfoHeader(info)
	header.Name = filepath.ToSlash(name)
	header.Method = zip.Deflate
	writer, _ := zipper.CreateHeader(header)
	io.Copy(writer, file)
}

func addText(zipper *zip.Writer, name string, text string) {
	writer, _ := zipper.Create(name)
	fmt.Fprint(writer, text)
}

func runTrainScript() string {
	return `#!/usr/bin/env bash
set -euo pipefail
python -m venv .venv --system-site-packages
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
python train_splat.py job
`
}

func bundleReadme() string {
	return `# WorldSketch Training Bundle

Upload this zip to a CUDA machine, then train directly from the zip:

` + "```bash" + `
bash -c "$(unzip -p training_bundle.zip runpod-train-bundle.sh)" -- training_bundle.zip
` + "```" + `

The output will be written to:

` + "```text" + `
/output/world.splat
` + "```" + `

You can also unpack the bundle manually and run:

` + "```bash" + `
chmod +x run_train.sh
./run_train.sh
` + "```" + `
`
}
