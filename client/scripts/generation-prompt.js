export function sceneGenerationPrompt(scene = "", { hasGeometryReference = false } = {}) {
	const geometryReference = hasGeometryReference
		? `Image 1 is the render to transform. Image 2 is an exactly aligned structural map; its artificial colors identify major masses and terrain only. Use it for placement and relative scale, but never copy those colors or treat it as an appearance reference.`
		: `Image 1 is the render to transform and the authoritative spatial reference.`
	const description = String(scene || "A coherent handcrafted environment").trim()
	return `Transform the supplied player-made block-out into a richly detailed, production-quality stylized 3D game environment.

SCENE TO CREATE: ${description}

${geometryReference}

Creatively reinterpret every primitive as a finished subject implied by the scene. A block is a massing proxy, never a literal cube or surface to texture. Choose any appropriate subject; leave no primitive geometry visible.

SPATIAL FIDELITY IS THE CONSTRAINT. Preserve the camera, orthographic projection, framing, composition, and terrain. Keep every subject centered on its source with roughly the same projected footprint and height envelope. Preserve relative scale, spacing, orientation, and occlusion. Keep subjects separate and empty regions open. Change silhouettes only to form the intended simple object; add no new major subjects.

SURFACE RICHNESS AND CRISP MATERIAL DETAIL ARE REQUIRED. Keep objects simple and uncluttered while rendering their existing forms at three readable scales: clear primary shape; authentic surface construction such as tiles, shingles, seams, masonry courses, boards, joints, leaf clusters, bark, grass, stones, or cracks; and fine texture, edge wear, color and roughness variation, and crisp contact shadows. Details must follow the surface orientation and real construction. Use a small coherent material palette with rich internal variation. Avoid smooth blank surfaces, blurry or oversized detail, plastic, clay-like materials, and unfinished areas.

Enrich the existing material, not the object count. Do not add arbitrary props, panels, machinery, vents, signs, cables, planters, tools, debris, extensions, fixtures, or decorations unless requested or essential for recognition. A simple roof should stay a simple roof, made rich through crisp tiles or shingles, seams, edges, and material variation—not unrelated equipment. Use neighboring shapes as scale references. Do not enlarge a subject to fill empty ground. Preserve the terrain boundary, footprint, placement, and thickness while enriching only its surface.

STYLE: premium handcrafted miniature diorama, painterly realism, crisp forms, warm natural light, saturated color, fine world-scale texture, material variation, and soft ambient plus strong contact shadows. Apply this generation-agnostically without biasing every result toward houses or fantasy villages.

Block-out colors are semantic hints, not final materials. Keep the isolated pure black background without sky, horizon, distant scenery, UI, grid, border, legible text, or unrelated content. Make it crisp and materially rich while remaining simple and unmistakably the same composition and scale.`
}
