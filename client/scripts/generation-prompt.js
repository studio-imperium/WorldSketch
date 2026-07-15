export function sceneGenerationPrompt(scene = "", { hasGeometryReference = false } = {}) {
	const geometryReference = hasGeometryReference
		? `Image 1 is the render to edit. Image 2 is an exactly aligned segmentation map of the same block-out. The artificial colors in Image 2 are geometry masks only: use them to lock every occupied region, object boundary, and empty region, but never copy those colors or treat Image 2 as an appearance reference.`
		: `Image 1 is the render to edit and the authoritative geometry reference.`
	return `Perform a constrained texture-and-surface-detail edit of Image 1. This is not permission to generate or redesign a new scene.

${geometryReference}

GEOMETRY IS IMMUTABLE. Preserve the exact camera, orthographic projection, framing, object count, connected components, position, footprint, projected silhouette, height, width, depth, orientation, occlusion, openings, terrain boundary, and negative space of the input. Do not move, resize, rotate, mirror, crop, merge, split, complete, or reinterpret any volume.

Apply new materials and fine detail only inside the pixels and silhouettes already occupied by each source shape. Treat every primitive as a strict spatial mask. Surface texture, shallow joints, seams, grain, small cracks, restrained edge wear, and material variation are allowed; new masses, extensions, overhangs, roofs, branches, props, or silhouettes are forbidden.

Preserve the exact number and scale of objects. A single cube must remain one cube-sized object in the same position; never expand it into a house, compound building, tower complex, or collection of props. A simple source shape must not become a larger or more complex structure than its original occupied volume.

Preserve the ground exactly. Keep its arbitrary outline, size, thickness, and location pixel-for-pixel. Never regularize it into a rectangle, square, oval, raised display plinth, or new diorama base. Do not place new objects, vegetation, walls, paths, rocks, buildings, or decorations on otherwise empty ground.

Everything outside the existing foreground silhouettes must remain the same pure black background. Do not add sky, horizon, distant scenery, shadows in empty space, borders, text, or editor overlays.

Within those strict geometric limits, render a crisp, richly textured stylized 3D game asset with warm natural light, clear material identity, fine world-scale texture, contact shadows, and polished production detail. The flat source colors are semantic hints rather than final materials, but they do not authorize any geometric invention.

The scene description supplies material and identity guidance only. It never overrides the source geometry or permits an absent feature to be added.

Scene description: ${String(scene || "A coherent stylized environment").trim()}

Final check before rendering: every output silhouette and occupied region must trace back to the same region in the input images. When detail conflicts with structural preservation, preserve the structure and omit the detail.`
}
