export function sceneGenerationPrompt(scene = "") {
	return `Transform the supplied block-out into a richly detailed, production-quality isometric environment.

The image is a player-made 3D block-out. Preserve its exact camera angle, orthographic perspective, framing, footprint, silhouette, height relationships, major volumes, paths, terrain boundaries, openings, and object placement. The result must clearly depict the same structure. Do not rotate, mirror, flatten, simplify, crop, or substantially redesign it.

Interpret every primitive shape as finished architecture or environment design. Turn the blocks into believable buildings, towers, walls, gatehouses, roofs, windows, doors, balconies, supports, stairs, fences, paths, terrain, trees, water, and other appropriate features. The flat colors are rough semantic hints, not final materials.

Render a highly detailed handcrafted miniature diorama with warm natural lighting, painterly realism, crisp readable forms, soft ambient shadows, strong contact shadows, and richly authored materials. Add weathered stone, aged plaster, dark ceramic roof tiles, exposed wooden beams, carved doors, small balconies, railings, windows, gutters, pipes, lanterns, flower pots, vines, moss, shrubs, grass, flowers, dirt, chipped edges, and believable material variation where appropriate. Add environmental storytelling without hiding or moving the source construction.

Replace natural-geometry blocks with organic trees, layered foliage, branches, roots, rocks, grasses, soil, flowers, and worn paths while preserving their original position, scale, and silhouette.

Keep the entire environment visible and centered with comfortable margins. Preserve the input's three-quarter isometric view. Keep the clean isolated diorama base and pure black background. Do not add sky, horizon, distant scenery, editor overlays, grid lines, selection outlines, text, or white borders.

Do not produce flat colored cubes, voxel art, Minecraft-style graphics, low-poly prototype geometry, plastic materials, simplified cartoon buildings, blurry surfaces, or generic concept art that ignores the input.

Mentally trace the input's major silhouette and edges before editing. Add detail directly onto the existing geometry. Structural preservation is mandatory.

Scene description: ${String(scene || "A coherent handcrafted environment").trim()}`
}
