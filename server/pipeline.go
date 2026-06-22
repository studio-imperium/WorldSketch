package main

import "path/filepath"

// RunPipeline runs the full generation pipeline once on a prepared job dir
// (scene.json + views/<name>/{primitive_rgb,primitive_depth,camera}). It mirrors
// the sequence in Store.Run, but standalone — used by the serverless worker
// (`worldsketch-server -job <dir>`) where there's no HTTP store. status() is called
// before each stage for logging.
func RunPipeline(dir string, scene Scene, status func(string)) error {
	status("generating images")
	if err := runImageGen(dir, scene.Prompt); err != nil {
		return err
	}
	if envBool("WS_IMAGE_ONLY") {
		status("image-only complete")
		return nil
	}

	status("estimating depth")
	RunDepth(dir)

	status("fusing views")
	plyPath := filepath.Join(dir, "world.ply")
	if err := WritePLYFromViews(scene, dir, plyPath); err != nil {
		if err := WritePLY(scene, plyPath, SeedFromString(filepath.Base(dir))); err != nil {
			return err
		}
	}
	if envBool("WS_POINT_CLOUD_ONLY") {
		status("point-cloud-only complete")
		return nil
	}

	status("training splat")
	return RunSplatTraining(dir)
}
