import assert from "node:assert/strict"
import test from "node:test"

import { sceneGenerationPrompt } from "../scripts/generation-prompt.js"

test("balances creative reinterpretation with spatial fidelity", () => {
	const prompt = sceneGenerationPrompt("A vine-covered village house")
	for (const invariant of [
		"Creatively reinterpret every primitive",
		"A block is a massing proxy",
		"SPATIAL FIDELITY IS THE CONSTRAINT",
		"roughly the same projected footprint and height envelope",
		"Do not enlarge a subject to fill empty ground",
		"secondary geometry needed to make each interpretation convincing",
		"without biasing every generation toward houses",
		"Scene description: A vine-covered village house",
	]) assert.ok(prompt.includes(invariant), `missing balanced prompt invariant: ${invariant}`)
	assert.ok(!prompt.includes("GEOMETRY IS IMMUTABLE"))
	assert.ok(!prompt.includes("Image 2"))
})

test("explains the second image as a geometry mask, not an appearance reference", () => {
	const prompt = sceneGenerationPrompt("A stone marker", { hasGeometryReference: true })
	assert.ok(prompt.includes("Image 2 is an exactly aligned structural map"))
	assert.ok(prompt.includes("never copy those colors"))
})
