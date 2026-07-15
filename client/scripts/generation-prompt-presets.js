import { sceneGenerationPrompt } from "/scripts/generation-prompt.js?v=realistic-style-1"

function geometryLine(hasGeometryReference) {
	return hasGeometryReference
		? `Image 1 is the render. Image 2 is an exactly aligned structural map. Use its artificial colors only for mass placement and scale; never copy those colors or appearance.`
		: `Image 1 is the render to transform and the authoritative spatial reference.`
}

function sceneText(scene) {
	return String(scene || "A coherent richly detailed environment").trim()
}

// Candidate prompts for A/B testing, deliberately varied in length and emphasis.
// Every preset takes (scene, { hasGeometryReference }) and returns the full prompt text.
export const promptPresets = [
	{
		key: "current",
		label: "Current",
		build: (scene, opts) => sceneGenerationPrompt(scene, opts),
	},
	{
		key: "minimal",
		label: "Minimal",
		build: (scene, { hasGeometryReference = false } = {}) => `${geometryLine(hasGeometryReference)}

Transform this block-out into: ${sceneText(scene)}.

Same camera, same composition, same proportions — every block becomes a full-sized real structure exactly in place, and painted ground colors become the terrain features they mark. Crisp realistic materials with visible construction detail. Never a miniature, toy, or diorama. Pure black background: every pixel outside the terrain chunk stays flat #000000.`,
	},
	{
		key: "spatial",
		label: "Spatial-first",
		build: (scene, { hasGeometryReference = false } = {}) => `Repaint this block-out as ${sceneText(scene)}, keeping its geometry sacred.

${geometryLine(hasGeometryReference)}

LOCKED: the orthographic camera, framing, and composition; each mass's position, footprint, height, spacing, and occlusion. Blocks are massing proxies — replace each with the real structure it stands for, matching its silhouette closely. Painted ground regions become the terrain features they mark (paths, water, fields) in exactly those shapes. Keep empty areas empty; add no new objects.

FREE: surface realism — real materials, construction seams, weathering, grounded shadows, and believable lighting at full architectural scale. Never a miniature or toy.

Background: pure flat black (#000000) everywhere outside the terrain chunk — no sky, ground, glow, or scenery.`,
	},
	{
		key: "materials",
		label: "Material-first",
		build: (scene, { hasGeometryReference = false } = {}) => `${geometryLine(hasGeometryReference)}

Rebuild this block-out as ${sceneText(scene)} with production-quality surfaces.

Every surface must read as real construction at three scales: overall form; visible assembly such as masonry courses, roof tiles, planks, joints, stone, soil, and foliage clumps; and fine wear — cracks, stains, roughness and color variation, crisp contact shadows. No smooth blank faces, no plastic or clay look, no blur. A small cohesive palette with rich internal variation. Life-sized and inhabitable, never a miniature.

Keep the camera, composition, footprint, and relative scale of every mass unchanged, and keep empty ground empty. Isolate the complete terrain chunk on pure black (#000000) — nothing else in frame.`,
	},
	{
		key: "game-asset",
		label: "Game-asset",
		build: (scene, { hasGeometryReference = false } = {}) => `Isometric environment asset render: ${sceneText(scene)}.

${geometryLine(hasGeometryReference)}

Style: high-end 3D game environment art, orthographic view, photoscanned-quality materials, sharp texture density, baked ambient occlusion and soft grounded shadows. The chunk floats on a pure black void (#000000) like an asset-viewer screenshot — no sky, no backdrop, no floor beyond the chunk.

Rebuild each block as the real structure it represents, in the same position and proportion; painted ground marks become real paths, water, or vegetation. Full architectural scale — not a miniature, stylized toy, or low-poly asset.`,
	},
	{
		key: "rules",
		label: "Rule list",
		build: (scene, { hasGeometryReference = false } = {}) => `Transform the block-out into a finished environment.

SCENE: ${sceneText(scene)}

${geometryLine(hasGeometryReference)}

Rules, in priority order:
1. Background: every pixel outside the terrain chunk is flat black #000000. No sky, horizon, scenery, glow, text, or UI.
2. Geometry: same orthographic camera, framing, and composition. Each mass keeps its footprint, height, and position; separate blocks stay separate; empty ground stays empty.
3. Interpretation: blocks are placeholders — render the real structure each one stands for; painted ground colors mark terrain features, not materials.
4. Surfaces: realistic materials with visible construction and wear at full architectural scale; crisp detail, grounded shadows, no blank or blurry areas.
5. Never: miniatures, dioramas, toys, clay, low-poly, cartoons, or added props and objects not in the scene description.`,
	},
]
