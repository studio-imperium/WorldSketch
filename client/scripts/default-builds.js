export const DEFAULT_BUILD_DEFINITIONS = Object.freeze([
	Object.freeze({ name: "castle", url: "/grand-medieval-castle.json" }),
	Object.freeze({ name: "courtyard", url: "/japanese-courtyard-blockout.json" }),
])

export async function loadDefaultBuildSeeds(fetcher = fetch) {
	return Promise.all(DEFAULT_BUILD_DEFINITIONS.map(async definition => {
		const response = await fetcher(definition.url)
		if (!response.ok) throw new Error(`Could not load default build ${definition.name} (${response.status})`)
		const prims = await response.json()
		if (!Array.isArray(prims?.primitives)) throw new Error(`Default build ${definition.name} has no primitives`)
		return { name: definition.name, prims }
	}))
}
