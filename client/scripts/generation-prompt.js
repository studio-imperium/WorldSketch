export function sceneGenerationPrompt(scene = "", { hasGeometryReference = false } = {}) {
	const geometryReference = hasGeometryReference
		? `Image 1 is the render. Image 2 is an exactly aligned structural map. Use its artificial colors only for mass placement and scale; never copy those colors or appearance.`
		: `Image 1 is the render to transform and the authoritative spatial reference.`
	const description = String(scene || "A coherent richly detailed environment").trim()
	return `Transform the block-out into a production-quality environment rendered with richly detailed stylized realism.

SCENE TO CREATE: ${description}

${geometryReference}

Creatively reinterpret every primitive. A block is a massing proxy, never a literal cube or surface to texture. Leave no primitive geometry visible.

SCENE COVERAGE IS MANDATORY. Every explicitly named feature in SCENE TO CREATE must appear. Match each feature to its own visible source mass or painted terrain region: terrain is the named environment; painted bands or lines become the named path, road, or water; separate blocks remain separate objects. Do not absorb a secondary object into the main subject or omit terrain markings. Show the complete terrain chunk; do not crop or zoom into one object.

SPATIAL FIDELITY IS THE CONSTRAINT. Preserve camera, orthographic projection, framing, composition, and terrain. Keep each subject centered on its source with roughly the same projected footprint and height envelope. Preserve relative scale, spacing, orientation, and occlusion. Keep empty regions open; change silhouettes only to form the simple intended object and add no major subjects.

SURFACE RICHNESS AND CRISP MATERIAL DETAIL ARE REQUIRED. Keep objects simple; render their existing forms at three readable scales: primary shape; authentic construction such as tiles, seams, masonry, boards, joints, foliage, grass, stones, or cracks; and fine texture, wear, color and roughness variation, and crisp contact shadows. Follow real surface orientation and construction. Use a small palette with rich internal variation. Avoid smooth blank surfaces, blurry or oversized detail, plastic, clay-like materials, and unfinished areas.

Enrich the existing material, not the object count. Do not add arbitrary props, panels, machinery, signs, cables, planters, tools, debris, extensions, or decorations unless requested or essential. A simple roof should stay a simple roof, enriched by crisp tiles or shingles, seams, edges, and material variation—not equipment. Use neighboring shapes for scale. Do not enlarge a subject to fill empty ground. Preserve terrain boundary and footprint while enriching only its surface.

STYLE: highly detailed stylized realism at the scale of a believable full-sized place. Use readable silhouettes and a cohesive artistic palette, but keep proportions, construction, lighting, depth, and material response realistic. Architecture must feel massive, structural, and inhabitable; terrain must feel naturally formed. Favor crisp layered detail, natural imperfections, weathering, believable roughness and reflections, ambient occlusion, and grounded shadows. Never depict a miniature, tabletop diorama, toy, model kit, clay sculpture, low-poly asset, cartoon, or plastic object.

Colors are semantic hints, not materials. Isolate the complete terrain chunk—not merely its main object—on pure black with no sky, scenery, UI, text, or unrelated content. Keep it crisp, materially rich, simple, and unmistakably the same composition and scale.`
}
