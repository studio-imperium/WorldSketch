import assert from "node:assert/strict"
import test from "node:test"

import { sceneGenerationPrompt } from "../scripts/generation-prompt.js"

test("balances creative reinterpretation with spatial fidelity", () => {
	const prompt = sceneGenerationPrompt("A vine-covered village house")
	for (const invariant of [
		"Creatively reinterpret every primitive",
		"A block is a massing proxy",
		"SCENE COVERAGE IS MANDATORY",
		"Every explicitly named feature in SCENE TO CREATE must appear",
		"Match each feature to its own visible source mass or painted terrain region",
		"painted bands or lines become the named path",
		"Do not absorb a secondary object into the main subject",
		"do not crop or zoom into one object",
		"SPATIAL FIDELITY IS THE CONSTRAINT",
		"roughly the same projected footprint and height envelope",
		"Do not enlarge a subject to fill empty ground",
		"SURFACE RICHNESS AND CRISP MATERIAL DETAIL ARE REQUIRED",
		"existing forms at three readable scales",
		"Enrich the existing material, not the object count",
		"Do not add arbitrary props",
		"A simple roof should stay a simple roof",
		"Avoid smooth blank surfaces",
		"crisp contact shadows",
		"highly detailed stylized realism at the scale of a believable full-sized place",
		"material response realistic",
		"Architecture must feel massive, structural, and inhabitable",
		"crisp layered detail, natural imperfections, weathering",
		"Never depict a miniature, tabletop diorama, toy, model kit, clay sculpture",
		"The complete terrain chunk—not merely its main object—floats isolated on black",
		"SCENE TO CREATE: A vine-covered village house",
	]) assert.ok(prompt.includes(invariant), `missing balanced prompt invariant: ${invariant}`)
	assert.ok(!prompt.includes("fine storytelling details"))
	assert.ok(!prompt.includes("attached props and nearby dressing"))
	assert.ok(prompt.trim().split(/\s+/).length < 500, "prompt should stay focused enough for the image editor")
	assert.ok(!prompt.includes("GEOMETRY IS IMMUTABLE"))
	assert.ok(!prompt.includes("Image 2"))
})

test("explains the second image as a geometry mask, not an appearance reference", () => {
	const prompt = sceneGenerationPrompt("A stone marker", { hasGeometryReference: true })
	assert.ok(prompt.includes("Image 2 is an exactly aligned structural map"))
	assert.ok(prompt.includes("never copy those colors"))
	assert.ok(prompt.trim().split(/\s+/).length < 510, "geometry-reference prompt should remain concise")
})
