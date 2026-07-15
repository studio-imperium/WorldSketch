import assert from "node:assert/strict"
import test from "node:test"

import { DEFAULT_BUILD_DEFINITIONS, loadDefaultBuildSeeds } from "../scripts/default-builds.js"

test("ships castle and courtyard as the two fresh-session builds", () => {
	assert.deepEqual(DEFAULT_BUILD_DEFINITIONS, [
		{ name: "castle", url: "/grand-medieval-castle.json" },
		{ name: "courtyard", url: "/japanese-courtyard-blockout.json" },
	])
})

test("loads default build JSON without discarding its ground data", async () => {
	const fixtures = new Map([
		["/grand-medieval-castle.json", { version: 3, primitives: [{ type: "box" }] }],
		["/japanese-courtyard-blockout.json", { version: 4, ground: { strokes: [] }, primitives: [{ type: "cone" }] }],
	])
	const seeds = await loadDefaultBuildSeeds(async url => ({
		ok: fixtures.has(url),
		status: fixtures.has(url) ? 200 : 404,
		json: async () => fixtures.get(url),
	}))
	assert.deepEqual(seeds.map(seed => seed.name), ["castle", "courtyard"])
	assert.equal(seeds[1].prims.ground.strokes.length, 0)
})
