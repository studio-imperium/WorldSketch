export const GEOMETRY_TARGETS = [
	{ model: "openai/gpt-oss-20b", provider: "novita" },
	{ model: "openai/gpt-oss-20b", provider: "together" },
	{ model: "openai/gpt-oss-20b", provider: "ovhcloud" },
	{ model: "Qwen/Qwen3-Coder-30B-A3B-Instruct", provider: "scaleway" },
]
export const GEOMETRY_MODEL = GEOMETRY_TARGETS[0].model
export const GEOMETRY_PROVIDER = GEOMETRY_TARGETS[0].provider
export const MAX_GENERATED_PRIMITIVES = 32

const vector = (items, description) => ({
	type: "array",
	minItems: 3,
	maxItems: 3,
	items,
	description,
})

export const WORLD_SKETCH_GEOMETRY_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["version", "ground", "primitives"],
	properties: {
		version: { type: "integer", enum: [4] },
		ground: {
			type: "object",
			description: "Required floor wrapper. Keep strokes empty unless the user explicitly requests visible terrain or a ground feature.",
			additionalProperties: false,
			required: ["size", "complete", "strokes"],
			properties: {
				size: { type: "number", minimum: 32, maximum: 96 },
				complete: { type: "boolean", enum: [true] },
				strokes: {
					type: "array",
					description: "Optional closed filled ground polygons. Empty by default; never add decorative borders or open-ended trails.",
					maxItems: 2,
					items: {
						type: "object",
						additionalProperties: false,
						required: ["mode", "color", "radius", "closed", "points"],
						properties: {
							mode: { type: "string", enum: ["paint"] },
							color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
							radius: { type: "number", minimum: 0.25, maximum: 3 },
							closed: { type: "boolean", enum: [true] },
							points: {
								type: "array",
								minItems: 3,
								maxItems: 10,
								items: {
									type: "array",
									minItems: 2,
									maxItems: 2,
									items: { type: "number", minimum: -48, maximum: 48 },
								},
							},
						},
					},
				},
			},
		},
		primitives: {
			type: "array",
			minItems: 3,
			maxItems: MAX_GENERATED_PRIMITIVES,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["type", "position", "rotation", "scale", "color"],
				properties: {
					type: { type: "string", enum: ["box"] },
					position: vector({ type: "number", minimum: -48, maximum: 48 }, "Box center [x,y,z]."),
					rotation: vector({ type: "number", minimum: -3.142, maximum: 3.142 }, "Euler rotation [x,y,z] in radians."),
					scale: vector({ type: "number", minimum: 0.2, maximum: 60 }, "Full box dimensions [x,y,z]."),
					color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
				},
			},
		},
	},
}

// Condensed from the user's 184-block Japanese courtyard reference. It teaches the
// coordinate convention, layered architecture and repeated structural rhythm without
// spending thousands of input tokens on the full production build. Its empty ground is
// deliberate: floor paint is optional and should not leak into unrelated generations.
export const COURTYARD_EXAMPLE = {
	version: 4,
	ground: {
		size: 72,
		complete: true,
		strokes: [],
	},
	primitives: [
		{ type: "box", position: [0, 0.6, 18], rotation: [0, 0, 0], scale: [38, 1.2, 1.4], color: "#6f6858" },
		{ type: "box", position: [-19, 0.6, 0], rotation: [0, 0, 0], scale: [1.4, 1.2, 36], color: "#6f6858" },
		{ type: "box", position: [19, 0.6, 0], rotation: [0, 0, 0], scale: [1.4, 1.2, 36], color: "#6f6858" },
		{ type: "box", position: [0, 0.6, -18], rotation: [0, 0, 0], scale: [38, 1.2, 1.4], color: "#6f6858" },
		{ type: "box", position: [3, 0.45, -9], rotation: [0, 0, 0], scale: [16, 0.9, 10], color: "#6f6858" },
		{ type: "box", position: [3, 3.2, -9], rotation: [0, 0, 0], scale: [15, 4.6, 9], color: "#b59c6a" },
		{ type: "box", position: [3, 5.9, -9], rotation: [0, 0, 0], scale: [17, 0.8, 11], color: "#574232" },
		{ type: "box", position: [-3, 1.5, 12], rotation: [0, 0, 0], scale: [0.5, 3, 0.5], color: "#2d251f" },
		{ type: "box", position: [3, 1.5, 12], rotation: [0, 0, 0], scale: [0.5, 3, 0.5], color: "#2d251f" },
		{ type: "box", position: [0, 3.1, 12], rotation: [0, 0, 0], scale: [7, 0.5, 0.8], color: "#4d3523" },
		{ type: "box", position: [-11, 1.4, 5], rotation: [0, 0, 0], scale: [0.7, 2.8, 0.7], color: "#4d3523" },
		{ type: "box", position: [-11, 3.2, 5], rotation: [0, 0, 0], scale: [4, 1.4, 4], color: "#607747" },
	],
}

const SYSTEM_PROMPT = `You generate compact WorldSketch block-outs as strict JSON.
Use boxes, with floor paint only when explicitly requested. Never return commentary or markdown.
World coordinates are X/Z across the floor and Y upward. Position is the box center;
therefore a box resting on the floor usually has position.y equal to scale.y / 2.
Make a recognizable, coherent silhouette with connected walls, roofs, openings and a
small amount of repeated detail. Prefer whole numbers or one decimal place. Keep the
scene within roughly -28 to 28 on X and Z. Use no more than ${MAX_GENERATED_PRIMITIVES}
boxes. Ground is optional despite the required wrapper: return strokes: [] unless the
user asks for terrain, floor, a path, road, water or another ground feature. Never invent
a perimeter frame, ring, U-shape, decorative border or open-ended trail around an object.
Requested ground must use one or two compact closed polygons whose points trace the
outer boundary and whose closed value is true. The generated JSON replaces the entire
current build, including its floor.`

export function geometryPromptRequestsGround(prompt) {
	const description = String(prompt ?? "").toLowerCase()
	if (/\b(?:no|without|omit|skip)\s+(?:any\s+)?(?:ground|terrain|floor|path|road|trail|water)\b/.test(description)) return false
	return /\b(?:ground|terrain|floor|path|road|street|trail|river|water|pond|lake|moat|garden|grass|sand|snow|courtyard|plaza|island)\b/.test(description)
}

export function geometryGenerationRequest(prompt, {
	model = GEOMETRY_MODEL,
	provider = GEOMETRY_PROVIDER,
} = {}) {
	const description = String(prompt ?? "").trim()
	if (!description) throw new Error("Describe the geometry you want to generate")
	return {
		provider,
		model,
		messages: [
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: "Create a compact Japanese courtyard with perimeter walls, one layered building, a gate and a tree." },
			{ role: "assistant", content: JSON.stringify(COURTYARD_EXAMPLE) },
			{ role: "user", content: `Create this WorldSketch block-out: ${description}` },
		],
		response_format: {
			type: "json_schema",
			json_schema: {
				name: "worldsketch_geometry",
				strict: true,
				schema: WORLD_SKETCH_GEOMETRY_SCHEMA,
			},
		},
		max_tokens: 8192,
		reasoning_effort: "low",
		temperature: 0.2,
	}
}

export function cleanGeometryResponse(content) {
	if (typeof content !== "string" || !content.trim()) throw new Error("The geometry model returned no JSON")
	return content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
}

export function geometryResponseContent(response) {
	const choice = response?.choices?.[0]
	if (choice?.finish_reason !== "length") {
		const content = choice?.message?.content
		if (typeof content === "string" && content.trim()) return content
	}
	const error = new Error(choice?.finish_reason === "length"
		? "The geometry model used its whole output budget without returning complete JSON"
		: "The geometry model returned no JSON")
	error.code = "EMPTY_GEOMETRY_RESPONSE"
	throw error
}
