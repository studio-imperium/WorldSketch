// Fetch runtime/debug flags from the server (env-driven). Returns {} on failure so
// generation still proceeds with defaults.
export async function getConfig() {
	try {
		const response = await fetch("/api/config")
		if (!response.ok) return {}
		return await response.json()
	} catch {
		return {}
	}
}

// Identification phase: send a numbered context capture of the whole world + the scene
// prompt; the server has Gemini label each numbered object AND describe the ground
// terrain, logging both the graphic and the response under outputs/NNNN. Returns
// { labels: { "1": "oak tree", ... }, ground: "mossy forest floor…" }, or empties on
// any failure so generation falls back to scene-context prompting.
export async function identifyObjects({ image, scene, count, output, signal }) {
	try {
		const form = new FormData()
		form.append("prompt", scene ?? "")
		form.append("count", String(count))
		if (output) form.append("output", output)
		form.append("image", image, "identify.png")
		const response = await fetch("/api/identify", { method: "POST", body: form, signal })
		if (!response.ok) return { labels: {}, ground: "" }
		const json = await response.json()
		return { labels: json.labels || {}, ground: json.ground || "" }
	} catch {
		return { labels: {}, ground: "" }
	}
}

// Allocate the outputs/NNNN folder for one world generation; every object + the
// floor of that world are saved under it server-side.
export async function newOutput() {
	const response = await fetch("/api/new-output", { method: "POST" })
	if (!response.ok) throw new Error((await response.text()) || "could not allocate an output folder")
	return response.json() // { index }
}

// Generate one subject (an object or the floor): re-texture its block-out capture and
// reconstruct it with TripoSplat. Returns the raw .splat bytes.
export async function generateSubject({ prompt, kind, steps, gaussians, output, name, groundColor, label, colors, image, materialImage, signal }) {
	const form = new FormData()
	form.append("prompt", prompt ?? "")
	form.append("kind", kind)
	if (steps) form.append("steps", String(steps))
	if (gaussians) form.append("gaussians", String(gaussians))
	if (label) form.append("label", label)
	// The object's actual primitive colours, so the server can lock the generated
	// texture's hues to exactly these (WS_PALETTE_MATCH=lock).
	if (colors && colors.length) form.append("colors", colors.join(","))
	if (output) form.append("output", output)
	if (name) form.append("name", name)
	if (groundColor) form.append("ground_color", groundColor)
	form.append("image", image, `${name || "guide"}.png`)
	if (materialImage) form.append("material_image", materialImage, `${name || "materials"}-materials.png`)

	const response = await fetch("/api/generate", { method: "POST", body: form, signal })
	if (!response.ok) {
		const message = await response.text()
		throw new Error(message || `generation failed (${response.status})`)
	}
	return new Uint8Array(await response.arrayBuffer())
}
