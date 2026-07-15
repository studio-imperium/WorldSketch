export function sceneGenerationPrompt(scene = "", { hasGeometryReference = false } = {}) {
	const geometryReference = hasGeometryReference
		? `Image 1 is the render to transform. Image 2 is an exactly aligned structural map; its artificial colors identify major masses and terrain only. Use it for placement and relative scale, but never copy those colors or treat it as an appearance reference.`
		: `Image 1 is the render to transform and the authoritative spatial reference.`
	const description = String(scene || "A coherent handcrafted environment").trim()
	return `Transform the supplied player-made block-out into a richly detailed, production-quality stylized 3D game environment.

SCENE TO CREATE: ${description}

${geometryReference}

Creatively reinterpret every primitive as a finished subject implied by the scene. A block is a massing proxy, never a literal cube or surface to texture. Create any appropriate architecture, vegetation, terrain, machinery, furnishing, vehicle, monument, or fantastical object; leave no primitive geometry visible.

SPATIAL FIDELITY IS THE CONSTRAINT. Preserve the camera, orthographic projection, framing, composition, and terrain. Keep every subject centered on its source with roughly the same projected footprint and height envelope. Preserve relative scale, spacing, orientation, adjacency, and occlusion. Keep separate subjects separate and empty regions open. Secondary details may refine silhouettes locally, but add no new major subjects.

RICHNESS AND DETAIL DENSITY ARE REQUIRED. Make every major subject a fully art-directed asset with detail at three readable scales: strong primary forms; abundant subject-specific secondary construction such as trim, supports, ledges, panels, joints, openings, layered foliage, and material transitions; and fine storytelling details such as fixtures, cables, planters, tools, vessels, attached props, flowers, moss, stains, chips, cracks, and wear. Use several coordinated, context-appropriate materials. Break up large surfaces with localized color, roughness, age, construction variation, and crisp contact shadows. Favor dense, intentional asymmetry. Avoid smooth blank walls, empty facades, uniform lawns, simple foliage blobs, toy-like plastic, clay-like materials, and unfinished areas.

Spend the detail budget inside and immediately around the existing source masses; keep attached props and nearby dressing subordinate to their anchors. Use terrain and neighboring shapes as scale references. Do not enlarge a subject to fill empty ground. Preserve the terrain boundary, footprint, placement, and thickness while enriching its surface.

STYLE: premium handcrafted miniature diorama, painterly realism, crisp readable forms, warm natural light, saturated natural color, fine world-scale texture, authored material variation, soft ambient shadows, and strong contact shadows. Apply this generation-agnostically without biasing every result toward houses or fantasy villages.

Treat block-out colors as semantic hints, not final materials. Keep the isolated pure black background with no sky, horizon, distant scenery, editor UI, grid, border, legible text, or unrelated content. The result must feel richly inhabited and materially varied while remaining unmistakably the same composition and scale.`
}
