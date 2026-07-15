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
			description: "Required floor wrapper. Normally contains one compact closed terrain polygon fitted around the build.",
			additionalProperties: false,
			required: ["size", "complete", "strokes"],
			properties: {
				size: { type: "number", enum: [144] },
				complete: { type: "boolean", enum: [true] },
				strokes: {
					type: "array",
					description: "Closed filled ground polygons. Use one compact supporting land patch by default; never add decorative borders or open-ended trails.",
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
// coordinate convention, layered architecture, repeated structural rhythm and a compact
// closed terrain footprint without spending thousands of tokens on the full build.
export const COURTYARD_EXAMPLE = {
	version: 4,
	ground: {
		size: 144,
		complete: true,
		strokes: [
			{ mode: "paint", color: "#8b8066", radius: 0.6, closed: true, points: [[-18, -21], [18, -21], [22, -17], [22, 17], [18, 21], [-18, 21], [-22, 17], [-22, -17]] },
		],
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
Use boxes plus a clean terrain footprint. Never return commentary or markdown.
World coordinates are X/Z across the floor and Y upward. Position is the box center;
therefore a box resting on the floor usually has position.y equal to scale.y / 2.
Make a recognizable, coherent silhouette with connected walls, roofs, openings and a
small amount of repeated detail. Prefer whole numbers or one decimal place. Keep the
scene within roughly -28 to 28 on X and Z. Use no more than ${MAX_GENERATED_PRIMITIVES}
boxes. Unless the user explicitly requests no terrain, include exactly one compact closed
land patch fitted just beyond the build footprint. It must read as a filled island/base,
not a line: never make a perimeter frame, ring, U-shape, decorative border or open-ended
trail around an object. If the user requests a path, road, water or another ground feature,
use at most one additional compact closed polygon. Polygon points trace the outer boundary
and closed is always true. The generated JSON replaces the entire build, including floor.`

export function geometryPromptRejectsGround(prompt) {
	const description = String(prompt ?? "").toLowerCase()
	return /\b(?:no|without|omit|skip)\s+(?:any\s+)?(?:ground|terrain|floor|land|base)\b/.test(description)
}

export function geometryPromptRequestsDesignedGround(prompt) {
	return /\b(?:path|road|street|trail|river|water|pond|lake|moat|courtyard|plaza|garden|island)\b/i.test(String(prompt ?? ""))
}

function fittedGroundColor(prompt) {
	const description = String(prompt ?? "").toLowerCase()
	if (/\b(?:snow|ice|frozen|arctic)\b/.test(description)) return "#d8e0df"
	if (/\b(?:sand|desert|dune|beach)\b/.test(description)) return "#bfa16a"
	if (/\b(?:stone|rock|volcanic|ruin)\b/.test(description)) return "#746b5d"
	return "#65734d"
}

export function fittedGeometryGroundStroke(primitives, prompt = "") {
	if (!Array.isArray(primitives) || !primitives.length) return null
	let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
	for (const primitive of primitives) {
		const x = Number(primitive?.position?.[0])
		const z = Number(primitive?.position?.[2])
		const sx = Math.abs(Number(primitive?.scale?.[0]))
		const sz = Math.abs(Number(primitive?.scale?.[2]))
		if (![x, z, sx, sz].every(Number.isFinite)) continue
		const yaw = Number(primitive?.rotation?.[1]) || 0
		const halfX = (Math.abs(Math.cos(yaw)) * sx + Math.abs(Math.sin(yaw)) * sz) / 2
		const halfZ = (Math.abs(Math.sin(yaw)) * sx + Math.abs(Math.cos(yaw)) * sz) / 2
		minX = Math.min(minX, x - halfX); maxX = Math.max(maxX, x + halfX)
		minZ = Math.min(minZ, z - halfZ); maxZ = Math.max(maxZ, z + halfZ)
	}
	if (![minX, maxX, minZ, maxZ].every(Number.isFinite)) return null
	const span = Math.max(maxX - minX, maxZ - minZ, 4)
	const pad = Math.min(5, Math.max(2.2, span * 0.12))
	minX = Math.max(-46, minX - pad); maxX = Math.min(46, maxX + pad)
	minZ = Math.max(-46, minZ - pad); maxZ = Math.min(46, maxZ + pad)
	const corner = Math.min(3.5, Math.max(1.2, Math.min(maxX - minX, maxZ - minZ) * 0.14))
	const round = value => Number(value.toFixed(1))
	return {
		mode: "paint",
		color: fittedGroundColor(prompt),
		radius: 0.6,
		closed: true,
		points: [
			[round(minX + corner), round(minZ)], [round(maxX - corner), round(minZ)],
			[round(maxX), round(minZ + corner)], [round(maxX), round(maxZ - corner)],
			[round(maxX - corner), round(maxZ)], [round(minX + corner), round(maxZ)],
			[round(minX), round(maxZ - corner)], [round(minX), round(minZ + corner)],
		],
	}
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
