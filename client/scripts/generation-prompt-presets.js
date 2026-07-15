import { sceneGenerationPrompt } from "/scripts/generation-prompt.js?v=minimal-default-1"

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
// "Current" is whatever the live pipeline uses (the minimal prompt as of 2026-07-15);
// "Long" is the previous production prompt kept for comparison.
export const promptPresets = [
	{
		key: "current",
		label: "Current",
		build: (scene, opts) => sceneGenerationPrompt(scene, opts),
	},
	{
		key: "long",
		label: "Long",
		build: (scene, { hasGeometryReference = false } = {}) => `Transform the block-out into a production-quality environment rendered with richly detailed stylized realism, isolated on a pure black background.

SCENE TO CREATE: ${sceneText(scene)}

${geometryLine(hasGeometryReference)}

Creatively reinterpret every primitive. A block is a massing proxy, never a literal cube or surface to texture. Leave no primitive geometry visible.

SCENE COVERAGE IS MANDATORY. Every explicitly named feature in SCENE TO CREATE must appear. Match each feature to its own visible source mass or painted terrain region: terrain is the named environment; painted bands or lines become the named path, road, or water; separate blocks remain separate objects. Do not absorb a secondary object into the main subject or omit terrain markings. Show the complete terrain chunk; do not crop or zoom into one object.

SPATIAL FIDELITY IS THE CONSTRAINT. Preserve camera, orthographic projection, framing, composition, and terrain. Keep each subject centered on its source with roughly the same projected footprint and height envelope. Preserve relative scale, spacing, orientation, and occlusion. Keep empty regions open; change silhouettes only to form the simple intended object and add no major subjects.

SURFACE RICHNESS AND CRISP MATERIAL DETAIL ARE REQUIRED. Keep objects simple; render their existing forms at three readable scales: primary shape; authentic construction such as tiles, seams, masonry, boards, joints, foliage, grass, stones, or cracks; and fine texture, wear, color and roughness variation, and crisp contact shadows. Follow real surface orientation and construction. Use a small palette with rich internal variation. Avoid smooth blank surfaces, blurry or oversized detail, plastic, clay-like materials, and unfinished areas.

Enrich the existing material, not the object count. Do not add arbitrary props, panels, machinery, signs, cables, planters, tools, debris, extensions, or decorations unless requested or essential. A simple roof should stay a simple roof, enriched by crisp tiles or shingles, seams, edges, and material variation—not equipment. Use neighboring shapes for scale. Do not enlarge a subject to fill empty ground. Preserve terrain boundary and footprint while enriching only its surface.

STYLE: highly detailed stylized realism at the scale of a believable full-sized place. Use readable silhouettes and a cohesive artistic palette, but keep proportions, construction, lighting, depth, and material response realistic. Architecture must feel massive, structural, and inhabitable; terrain must feel naturally formed. Favor crisp layered detail, natural imperfections, weathering, believable roughness and reflections, ambient occlusion, and grounded shadows. Never depict a miniature, tabletop diorama, toy, model kit, clay sculpture, low-poly asset, cartoon, or plastic object.

Colors are semantic hints, not materials. THE BLACK BACKGROUND IS NON-NEGOTIABLE. Every pixel outside the terrain chunk stays pure flat black (#000000): no sky, horizon, surrounding ground, scenery, gradients, glow, vignette, UI, or text. The complete terrain chunk—not merely its main object—floats isolated on black exactly where the source render is black. Keep it crisp, materially rich, simple, and unmistakably the same composition and scale.`,
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
	{
		key: "enhance",
		label: "Enhance",
		build: (scene, { hasGeometryReference = false } = {}) => `${geometryLine(hasGeometryReference)}

Render this block-out as ${sceneText(scene)}, changing nothing but the surfaces.

Add zero new things: no props, plants, rocks, paths, openings, or ornaments beyond what the blocks and painted regions already show. All richness comes from the materials themselves — believable construction, uneven wear, subtle color and roughness variation, fine texture at the right scale, crisp contact shadows. Same camera, composition, and proportions at full architectural scale; never a miniature. Everything outside the terrain chunk stays pure black (#000000).`,
	},
	{
		key: "texture-pass",
		label: "Texture pass",
		build: (scene, { hasGeometryReference = false } = {}) => `This is a detailing pass, not a redesign. Repaint the block-out as ${sceneText(scene)} by upgrading every existing surface to its finished material — and nothing more.

${geometryLine(hasGeometryReference)}

Treat each block and painted region as final geometry: give it the real material it implies, rendered with fine natural detail — grain, courses, seams, and weathering at a believable scale, with quiet variation instead of uniformity. Where a surface is plain, make the SAME surface richer, never busier: vary its height, tone, and texture rather than placing objects on it. Keep camera, framing, silhouettes, and scale identical. Pure black (#000000) outside the terrain chunk.`,
	},
	{
		key: "nothing-new",
		label: "Nothing new",
		build: (scene, { hasGeometryReference = false } = {}) => `${geometryLine(hasGeometryReference)}

Recreate this exact scene as ${sceneText(scene)}. The output must contain exactly the objects visible in the input — same count, same places, same sizes — plus nothing.

Spend all detail INSIDE the existing silhouettes: material realism, micro-variation, construction logic, wear, and grounded shadows. Empty ground stays empty but becomes a richly textured version of itself. If something is not in the block-out, it does not appear. Full architectural scale, never a miniature. Every pixel outside the terrain chunk is flat black (#000000).`,
	},
	{
		key: "restraint",
		label: "Restraint rules",
		build: (scene, { hasGeometryReference = false } = {}) => `Transform the block-out into ${sceneText(scene)}.

${geometryLine(hasGeometryReference)}

1. Adding is failure: no new objects, props, vegetation clusters, openings, or decorations of any kind.
2. Enhancing is the goal: every existing surface becomes its real material with fine texture, tonal variation, and honest wear — richness through detail density, not through content.
3. Geometry is fixed: same camera, framing, silhouettes, footprints, spacing, and scale; empty areas stay empty.
4. Painted ground colors mark terrain features; render those features in place, nothing else.
5. Full-sized and real — no miniature, toy, or clay look.
6. Background: flat black #000000 outside the terrain chunk. No sky or scenery.`,
	},
	{
		key: "re-render",
		label: "Re-render",
		build: (scene, { hasGeometryReference = false } = {}) => `Re-render this exact scene — ${sceneText(scene)} — as a final-quality frame of the same geometry.

${geometryLine(hasGeometryReference)}

Keep every form precisely where it is and simply resolve it: placeholder surfaces become physically believable materials with natural micro-detail, soft occlusion, and grounded shadows under the same lighting and orthographic camera. Nothing is added, moved, or resized; simple shapes stay simple, just finished. Real-world scale, never a miniature. The void around the terrain chunk remains pure black (#000000).`,
	},
]
