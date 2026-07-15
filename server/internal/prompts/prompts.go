package prompts

// SceneBoxes asks Gemini to detect object bounding boxes over a GENERATED scene image.
// The client projects seated gaussians into the image frame and uses these boxes as
// objectness evidence (wisp/haze rejection) during segmentation.
func SceneBoxes() string {
	return "Detect every distinct foreground prop object in this game diorama image (plants, trees, rocks, structures, " +
		"furniture, props). Also include one entry labeled exactly 'terrain' for the whole diorama ground, " +
		"and one entry labeled 'pond' for each water feature (pond, lake, puddle) if any. " +
		"Do not include shadows or dirt paths as separate objects. " +
		"Return a JSON list where each entry has \"label\" (descriptive text) and \"box_2d\" ([ymin,xmin,ymax,xmax], 0-1000 normalized)."
}

func Scene(scene string) string {
	base := `Use Image 1 as the geometric source and transform it into a richly detailed, production-quality isometric environment.

Image 1 is a player-made 3D blockout. Preserve its exact camera angle, perspective, framing, footprint, silhouette, height relationships, major volumes, paths, terrain boundaries, openings, and object placement. The final image must clearly depict the same structure. Do not rotate, mirror, flatten, simplify, or substantially redesign it.

Interpret every primitive shape as finished architecture or environment design. Turn basic blocks into believable buildings, towers, walls, gatehouses, roofs, windows, doors, balconies, supports, stairs, fences, paths, terrain, trees, water, and other appropriate features. The flat colors in Image 1 are only rough semantic hints and must not remain as plain colored geometry.

Render the scene in a premium stylized isometric game-art style inspired by a highly detailed handcrafted miniature diorama. Use warm natural lighting, painterly realism, crisp readable forms, soft ambient shadows, strong contact shadows, and richly authored materials.

Add detailed weathered stone, aged plaster, dark ceramic roof tiles, exposed wooden beams, carved doors, small balconies, railings, windows, gutters, pipes, lanterns, flower pots, vines, moss, shrubs, grass, flowers, dirt, chipped edges, and believable material variation. Add dense environmental storytelling, but do not clutter or hide the original construction.

For natural geometry, replace primitive shapes with organic trees, layered foliage, branches, roots, rocks, grasses, soil, flowers, and worn paths while preserving the original position, scale, and silhouette.

Keep the entire environment visible and centered with comfortable margins. Preserve the arbitrary three-quarter isometric angle from Image 1. Place the finished environment on a clean isolated diorama base with a pure black background. No sky, horizon, distant scenery, editor overlays, grid lines, selection outlines, or white borders.

Do not produce flat colored cubes, voxel art, Minecraft-style graphics, low-poly prototype geometry, plastic materials, simplified cartoon buildings, blurry surfaces, or generic concept art that ignores the input.

Before rendering, mentally trace the major silhouette and edges of Image 1. The final detailed environment should align closely with that trace, with detail added directly onto the existing geometry rather than replacing it.` +
		"Scene context: " + scene + "\n\n" +
		"Structural preservation is mandatory: honor the original block-out exactly."
	return base
}
