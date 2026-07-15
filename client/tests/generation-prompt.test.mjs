import assert from "node:assert/strict"
import test from "node:test"

import { sceneGenerationPrompt } from "../scripts/generation-prompt.js"

test("locks Flux edits to the source geometry", () => {
	const prompt = sceneGenerationPrompt("A stone marker")
	for (const invariant of [
		"GEOMETRY IS IMMUTABLE",
		"A single cube must remain one cube-sized object",
		"Never regularize it into a rectangle",
		"material and identity guidance only",
		"Scene description: A stone marker",
	]) assert.ok(prompt.includes(invariant), `missing geometry invariant: ${invariant}`)
	assert.ok(!prompt.includes("Image 2"))
})

test("explains the second image as a geometry mask, not an appearance reference", () => {
	const prompt = sceneGenerationPrompt("A stone marker", { hasGeometryReference: true })
	assert.ok(prompt.includes("Image 2 is an exactly aligned segmentation map"))
	assert.ok(prompt.includes("never copy those colors"))
})
