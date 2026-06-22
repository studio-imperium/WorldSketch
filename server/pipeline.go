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

	status("estimating depth")
	RunDepth(dir)

	plyPath := filepath.Join(dir, "world.ply")
	if scene.isExpansion() {
		// Expansion: fuse only the new tile (masked) and merge onto the parent's world.ply,
		// which the handler staged at <dir>/parent/world.ply.
		status("fusing into existing world")
		if err := WriteExpandedPLY(scene, dir, filepath.Join(dir, "parent"), plyPath); err != nil {
			return err
		}
	} else {
		status("fusing views")
		if err := WritePLYFromViews(scene, dir, plyPath); err != nil {
			if err := WritePLY(scene, plyPath, SeedFromString(filepath.Base(dir))); err != nil {
				return err
			}
		}
	}

	status("training splat")
	return RunSplatTraining(dir)
}
