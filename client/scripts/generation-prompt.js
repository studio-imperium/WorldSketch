export function sceneGenerationPrompt(scene = "", { hasGeometryReference = false } = {}) {
	const geometryReference = hasGeometryReference
		? `Image 1 is the render to transform. Image 2 is an exactly aligned structural map of the same block-out. Its artificial colors identify the original major masses and terrain region; use it to preserve their placement, relative scale, and correspondence, but never copy those colors or treat Image 2 as an appearance reference.`
		: `Image 1 is the render to transform and the authoritative spatial reference.`
	return `Transform the supplied player-made block-out into a richly detailed, production-quality stylized 3D game environment.

${geometryReference}

Creatively reinterpret every primitive as a finished object or environment feature implied by the scene description. A block is a massing proxy, not a literal cube and not merely a surface to texture. It may become convincing architecture, vegetation, terrain, machinery, furniture, a vehicle, a monument, a fantasy object, or another appropriate subject. Make the interpretation bold, coherent, recognizable, and richly authored rather than leaving primitive geometry visible.

SPATIAL FIDELITY IS THE CONSTRAINT. Preserve the input camera, orthographic projection, framing, overall composition, terrain location, and the layout relationships between all major subjects. Keep each interpreted subject centered on its source shape with roughly the same projected footprint and height envelope. Preserve relative scale, spacing, orientation, adjacency, and occlusion. Do not move a subject to a more convenient location, merge separate subjects, or invent additional major subjects in empty regions.

You may add the secondary geometry needed to make each interpretation convincing—for example roof forms, eaves, windows, doors, balconies, beams, vines, branches, roots, wheels, pipes, railings, carved elements, attached props, and small surrounding accents. These details may naturally refine the silhouette, but they must remain visually attached to their source subject and must not turn one small source mass into a sprawling compound. Preserve the source mass as the clear spatial anchor.

Scale is essential. Read the whole block-out as one world-sized region and use the terrain and neighboring shapes as scale references. Do not enlarge a subject to fill empty ground or dominate the frame. A small block on a large terrain area should become a detailed but still small subject on a large, mostly open terrain area. Keep deliberately empty space open; use only restrained surface variation or tiny incidental dressing there.

Preserve the terrain's existing outer boundary, overall footprint, placement, and thickness. Retexture and enrich the terrain naturally, but do not regularize an irregular boundary into a rectangle, square, oval, or generic display plinth, and do not expand it beyond the source.

Render in the same appealing visual language as a premium handcrafted miniature diorama: painterly realism, crisp readable forms, warm natural lighting, soft ambient shadows, strong contact shadows, saturated natural color, fine world-scale texture, and richly authored material variation. Use subject-appropriate construction and detail—weathering, joints, seams, grain, masonry, foliage clusters, worn edges, metalwork, fabric, soil, water, or other materials as appropriate—without biasing every generation toward houses or fantasy villages.

The flat block-out colors are rough semantic hints, not literal final materials. Preserve the clean isolated presentation and pure black background. Do not add sky, horizon, distant scenery, editor overlays, grid lines, borders, text, or unrelated background content.

The scene description determines what the shapes become and how the finished world feels. The block-out determines where those subjects are, how large they are, and how they relate spatially.

Scene description: ${String(scene || "A coherent handcrafted environment").trim()}

Final check before rendering: the result should be substantially more imaginative and detailed than the primitive input while remaining unmistakably the same composition at the same scale.`
}
