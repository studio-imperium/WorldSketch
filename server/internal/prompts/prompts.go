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

	base := "Image 1 is a rough ISOMETRIC BLOCK-OUT of a REGION OF A GAME WORLD — a large outdoor area roughly 100 meters across, built from colored primitive shapes floating on a pure black background. " +
		"Reimagine each colored block as the natural object it represents, rendered together as one cohesive, believable place in a polished hand-painted stylized isometric game-art style — " +
		"semi-realistic yet clearly stylized, richly detailed, with soft warm painted lighting, clean readable silhouettes, saturated natural colors, and crisp storybook charm, " +
		"like a hand-painted isometric map region from a high-quality fantasy builder/RPG. " +
		"This is a LANDSCAPE at real-world scale, NOT a miniature or diorama: trees, rocks, and structures are life-sized features seen from a high isometric viewpoint, each occupying only a small part of the terrain. " +
		"Match ONLY the ART STYLE — the block COLORS are just placeholders to tell objects apart, NOT literal surface textures; give every object its own natural materials and colors. " +
		"SPATIAL FIDELITY IS THE TOP PRIORITY: this result is fitted back into the EXACT bounding volume of the block-out, so it must occupy the same space the same way. " +
		"PRESERVE THE LAYOUT precisely — keep the exact position, relative size, FOOTPRINT, HEIGHT, proportions, and upright orientation of every element, " +
		"and do not move, resize, re-centre, add, remove, merge, or split any element. " +
		"Render every element at the scale its footprint implies within that ~100m area — do not enlarge objects to fill the frame. " +
		"Do NOT ADD structure that is not in the block-out: no new roof, lid, ceiling, top, extra walls, floor, base, or enclosure. " +
		"If a shape is OPEN — for example upright walls with nothing on top, or an open room seen from above — keep it OPEN; NEVER close an open room into a solid house or building. " +
		"You MAY smooth the crude facets into natural surface detail, but ONLY within each element's existing silhouette: do not change its overall shape or size, " +
		"and do not make it blocky, cubic, pixelated, or Minecraft-like either. " +
		"Render ONLY the shapes that are present — match the block-out exactly. " +
		"Do NOT INVENT a ground plane, baseplate, terrain, grass, soil, pebbles, dirt, path, or background scenery that is not one of the placed shapes. " +
		"BUT if the block-out DOES include a floor or ground surface as one of its shapes — for example a flat slab that the walls and furniture sit on, i.e. a room floor — " +
		"you MUST render that floor too, re-textured in the same art style; do NOT delete it or leave it black. " +
		"Render any floor or terrain PHYSICALLY FLAT and LEVEL — no island-like beveled edges, no tapered rim, no raised tabletop, no cliff sides, and no mound or hill shape — " +
		"and reproduce its drawn outline exactly. " +
		"Thin white outlines in Image 1 trace each shape's exact silhouette, including the floor's boundary — follow them precisely, but never paint the white lines themselves into the artwork. " +
		"Everything that is NOT a placed shape stays pure black: empty black fills all the space around and outside the shapes, " +
		"with no invented slab or shadow beneath objects that were floating — no sky, no frame, no text, no UI. " +
		"Keep the isometric camera angle exactly. " +
		"Scene context: " + scene + "\n\n" +
		"Structural preservation: keep the source silhouette and occlusion intact."
	return base
}
