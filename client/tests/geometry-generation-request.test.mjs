import assert from "node:assert/strict"
import test from "node:test"

import {
	cleanGeometryResponse,
	COURTYARD_EXAMPLE,
	GEOMETRY_TARGETS,
	geometryGenerationRequest,
	geometryResponseContent,
	MAX_GENERATED_PRIMITIVES,
	WORLD_SKETCH_GEOMETRY_SCHEMA,
} from "../scripts/geometry-generation-request.js"

test("builds a fast, schema-constrained geometry request", () => {
	const request = geometryGenerationRequest("a small stone lighthouse")
	assert.equal(request.provider, "novita")
	assert.equal(request.model, "openai/gpt-oss-20b")
	assert.deepEqual(GEOMETRY_TARGETS, [
		{ model: "openai/gpt-oss-20b", provider: "novita" },
		{ model: "openai/gpt-oss-20b", provider: "together" },
		{ model: "openai/gpt-oss-20b", provider: "ovhcloud" },
		{ model: "Qwen/Qwen3-Coder-30B-A3B-Instruct", provider: "scaleway" },
	])
	assert.equal(request.response_format.type, "json_schema")
	assert.equal(request.response_format.json_schema.strict, true)
	assert.equal(request.max_tokens, 8192)
	assert.equal(request.reasoning_effort, "low")
	assert.equal(WORLD_SKETCH_GEOMETRY_SCHEMA.properties.primitives.maxItems, MAX_GENERATED_PRIMITIVES)
	assert.match(request.messages.at(-1).content, /small stone lighthouse/)
})

test("can target a healthy fallback provider without changing the prompt", () => {
	const request = geometryGenerationRequest("a small stone lighthouse", GEOMETRY_TARGETS[1])
	assert.equal(request.provider, "together")
	assert.equal(request.model, "openai/gpt-oss-20b")
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

test("rejects empty and length-limited completions so another model can try", () => {
	assert.equal(geometryResponseContent({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }), "{}")
	assert.throws(
		() => geometryResponseContent({ choices: [{ message: { content: "" }, finish_reason: "length" }] }),
		error => error.code === "EMPTY_GEOMETRY_RESPONSE" && /whole output budget/.test(error.message),
	)
	assert.throws(
		() => geometryResponseContent({ choices: [{ message: { content: "{\"partial\":" }, finish_reason: "length" }] }),
		error => error.code === "EMPTY_GEOMETRY_RESPONSE",
	)
})
