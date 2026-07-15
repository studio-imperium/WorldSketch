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
// "Current" is whatever the live pipeline uses (the minimal prompt, which won the
// 2026-07-15 A/B round); the rest test enrichment without adding new objects.
export const promptPresets = [
	{
		key: "current",
		label: "Current",
		build: (scene, opts) => sceneGenerationPrompt(scene, opts),
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
