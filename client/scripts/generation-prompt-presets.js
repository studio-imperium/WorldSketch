import { sceneGenerationPrompt } from "/scripts/generation-prompt.js?v=flat-ground-1"

function geometryLine(hasGeometryReference) {
	return hasGeometryReference
		? `Image 1 is the render. Image 2 is an exactly aligned structural map. Use its artificial colors only for mass placement and scale; never copy those colors or appearance.`
		: `Image 1 is the render to transform and the authoritative spatial reference.`
}

function sceneText(scene) {
	return String(scene || "A coherent richly detailed environment").trim()
}

// Candidate prompts for A/B testing. "Current" is the live pipeline prompt (the
// minimal variant, which won the 2026-07-15 round); the rest are minimal-length
// candidates that lean on COLOR FIDELITY — the model likes to substitute its own
// palette (black→blue, red→beige), and these test different ways of stopping that.
export const promptPresets = [
	{
		key: "current",
		label: "Current",
		build: (scene, opts) => sceneGenerationPrompt(scene, opts),
	},
	{
		key: "color-lock",
		label: "Color lock",
		build: (scene, { hasGeometryReference = false } = {}) => `${geometryLine(hasGeometryReference)}

Transform this block-out into: ${sceneText(scene)}.

Same camera, same composition, same proportions — every block becomes a full-sized real structure exactly in place. THE COLORS ARE LOCKED: each block and painted region keeps its own hue in the final image. Render a realistic material IN that color — a red block becomes a red structure, dark stays dark, never substitute a different palette. Enrich with texture, shading, and wear, not with new colors. Never a miniature. Every pixel outside the terrain chunk stays flat black (#000000).`,
	},
	{
		key: "palette",
		label: "Palette is law",
		build: (scene, { hasGeometryReference = false } = {}) => `The input's colors are the art direction. ${geometryLine(hasGeometryReference)}

Turn this block-out into: ${sceneText(scene)}.

Sample the color of every block and painted ground region and keep it recognizably the same in the output — same hue, similar tone, now expressed as a believable real material with fine texture and wear. Swapping a region's color family (red to beige, black to blue, green to grey) is a failure. Keep the camera, composition, and proportions unchanged at full architectural scale; never a miniature. Pure black (#000000) everywhere outside the terrain chunk.`,
	},
	{
		key: "color-rules",
		label: "Color rules",
		build: (scene, { hasGeometryReference = false } = {}) => `Transform the block-out into: ${sceneText(scene)}.

${geometryLine(hasGeometryReference)}

1. Every region keeps its input hue — pick a real material that naturally HAS that color; never repaint a region into a different color family.
2. Shading, texture, and weathering may vary a color's brightness, never its hue.
3. Same camera, composition, footprints, and scale; blocks become the real structures they stand for, in place.
4. Full-sized and real — no miniature or toy look.
5. Flat black #000000 outside the terrain chunk; dark input regions stay dark, they do not turn blue.`,
	},
	{
		key: "painted-model",
		label: "Painted model",
		build: (scene, { hasGeometryReference = false } = {}) => `${geometryLine(hasGeometryReference)}

This block-out is a color-accurate model of: ${sceneText(scene)}. The builder already chose every color on purpose.

Materialize it faithfully: for each block and painted region, choose a real-world material that matches its existing color, then render that material with crisp construction detail, texture variation, and honest wear. Do not recolor anything to look more natural — the palette is intentional. Same camera, composition, and proportions at real-world scale; never a miniature. The surrounding void stays pure black (#000000).`,
	},
	{
		key: "hue-preserve",
		label: "Hue preserve",
		build: (scene, { hasGeometryReference = false } = {}) => `Re-render this exact scene — ${sceneText(scene)} — at final quality with its colors intact.

${geometryLine(hasGeometryReference)}

Every form stays where it is; every region's HUE must survive into the finished image. Resolve placeholder surfaces into realistic materials of the same color: vary value, roughness, and texture freely, shift hue never. If a region reads red in the input it reads red in the output. Same orthographic camera and framing, real-world scale, no miniature look. Everything outside the terrain chunk remains flat black (#000000).`,
	},
]
