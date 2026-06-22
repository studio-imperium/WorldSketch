package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
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

func ExtractTrainingBundle(dir string, data []byte) (int, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return 0, err
	}

	total := 0
	for _, file := range reader.File {
		name := path.Clean(strings.ReplaceAll(file.Name, "\\", "/"))
		if path.IsAbs(name) || name == ".." || strings.HasPrefix(name, "../") {
			return total, os.ErrPermission
		}

		rel := ""
		if strings.HasPrefix(name, "job/") {
			rel = strings.TrimPrefix(name, "job/")
		} else if isJobArtifactPath(name) {
			rel = name
		}
		if rel == "" || rel == "." {
			continue
		}

		target := filepath.Join(dir, filepath.FromSlash(rel))
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

func isJobArtifactPath(name string) bool {
	switch name {
	case "scene.json", "world.ply", "collisions.json", "world.splat":
		return true
	}
	return strings.HasPrefix(name, "views/")
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
