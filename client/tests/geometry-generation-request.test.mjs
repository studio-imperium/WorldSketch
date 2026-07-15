import assert from "node:assert/strict"
import test from "node:test"

import {
	cleanGeometryResponse,
	COURTYARD_EXAMPLE,
	GEOMETRY_PROVIDERS,
	geometryGenerationRequest,
	MAX_GENERATED_PRIMITIVES,
	WORLD_SKETCH_GEOMETRY_SCHEMA,
} from "../scripts/geometry-generation-request.js"

test("builds a fast, schema-constrained geometry request", () => {
	const request = geometryGenerationRequest("a small stone lighthouse")
	assert.equal(request.provider, "novita")
	assert.deepEqual(GEOMETRY_PROVIDERS, ["novita", "together", "ovhcloud"])
	assert.equal(request.model, "openai/gpt-oss-20b")
	assert.equal(request.response_format.type, "json_schema")
	assert.equal(request.response_format.json_schema.strict, true)
	assert.equal(request.max_tokens, 2400)
	assert.equal(WORLD_SKETCH_GEOMETRY_SCHEMA.properties.primitives.maxItems, MAX_GENERATED_PRIMITIVES)
	assert.match(request.messages.at(-1).content, /small stone lighthouse/)
})

test("can target a healthy fallback provider without changing the prompt", () => {
	const request = geometryGenerationRequest("a small stone lighthouse", { provider: "together" })
	assert.equal(request.provider, "together")
	assert.match(request.messages.at(-1).content, /small stone lighthouse/)
})

test("uses a compact valid courtyard example instead of the full reference build", () => {
	assert.ok(COURTYARD_EXAMPLE.primitives.length > 5)
	assert.ok(COURTYARD_EXAMPLE.primitives.length < MAX_GENERATED_PRIMITIVES)
	assert.equal(COURTYARD_EXAMPLE.version, 4)
	assert.equal(COURTYARD_EXAMPLE.ground.complete, true)
})

test("cleans defensive JSON fences and rejects empty responses", () => {
	assert.equal(cleanGeometryResponse("```json\n{\"version\":4}\n```"), '{"version":4}')
	assert.throws(() => cleanGeometryResponse(""), /returned no JSON/)
})
