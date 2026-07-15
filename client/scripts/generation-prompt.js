export function sceneGenerationPrompt(scene = "", { hasGeometryReference = false } = {}) {
	const geometryReference = hasGeometryReference
		? `Image 1 is the render. Image 2 is an exactly aligned structural map. Use its artificial colors only for mass placement and scale; never copy those colors or appearance.`
		: `Image 1 is the render to transform and the authoritative spatial reference.`
	const objectSource = hasGeometryReference ? "Image 2" : "Image 1"
	const description = String(scene || "A coherent richly detailed environment").trim()
	return `${geometryReference}

Transform this block-out into: ${description}.

Make sure to add NO new objects: Only objects should be ones outlined in ${objectSource}.

Make sure all ground and terrain stays absolutely flat, no bumps or hills or mounds.

FLAT GROUND
FLAT GROUND
FLAT GROUND
平坦地面
無坡度
無顛簸
平坦

Same camera, same composition, same proportions — every block becomes a full-sized real structure exactly in place, and painted ground colors become the terrain features they mark. Crisp realistic materials with visible construction detail. Never a miniature, toy, or diorama. Pure black background: every pixel outside the terrain chunk stays flat #000000.`
}
