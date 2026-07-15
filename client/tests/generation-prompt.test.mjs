import assert from "node:assert/strict"
import test from "node:test"

import { sceneGenerationPrompt } from "../scripts/generation-prompt.js"

test("keeps the minimal prompt's invariants", () => {
	const prompt = sceneGenerationPrompt("A vine-covered village house")
	for (const invariant of [
		"Transform this block-out into: A vine-covered village house",
		"add NO new objects: Only objects should be ones outlined in Image 1",
		"all ground and terrain stays absolutely flat",
		"FLAT GROUND",
		"平坦地面",
		"Same camera, same composition, same proportions",
		"every block becomes a full-sized real structure exactly in place",
		"painted ground colors become the terrain features they mark",
		"Never a miniature, toy, or diorama",
		"every pixel outside the terrain chunk stays flat #000000",
	]) assert.ok(prompt.includes(invariant), `missing minimal prompt invariant: ${invariant}`)
	assert.ok(!prompt.includes("Image 2"))
	assert.ok(prompt.trim().split(/\s+/).length < 170, "the minimal prompt must stay minimal")
})

test("points the no-new-objects rule at the structural map when one is sent", () => {
	const prompt = sceneGenerationPrompt("A stone quarry", { hasGeometryReference: true })
	assert.ok(prompt.includes("Only objects should be ones outlined in Image 2"))
})

test("explains the second image as a geometry mask, not an appearance reference", () => {
	const prompt = sceneGenerationPrompt("A stone marker", { hasGeometryReference: true })
	assert.ok(prompt.includes("Image 2 is an exactly aligned structural map"))
	assert.ok(prompt.includes("never copy those colors"))
	assert.ok(prompt.trim().split(/\s+/).length < 140, "geometry-reference prompt should remain concise")
})
