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

// Scene planning: the server has Gemini turn a scene description — and optionally the
// user's top-down sketch from the Draw tab — into a block-out plan the editor applies
// directly. Returns { plots: [{ix,iz,height}], ground: "#hex", blocks: [{x,z,y,sx,sy,
// sz,yaw,color}] }. Throws on failure — the caller surfaces it.
export async function planScene({ prompt, image, signal }) {
	const form = new FormData()
	form.append("prompt", prompt ?? "")
	if (image) form.append("image", image, "sketch.png")
	const response = await fetch("/api/plan", { method: "POST", body: form, signal })
	if (!response.ok) {
		const message = await response.text()
		throw new Error(message || `scene planning failed (${response.status})`)
	}
	return response.json()
}

// Deterministic sketch planning: the client numbers each stroke-object on the sketch;
// Gemini designs each number's geometry in a LOCAL frame and the client places the
// designs at the exact drawn positions. Returns { ground, objects: { "1": { label,
// blocks: [{x,z,y,sx,sy,sz,yaw,color}] } } }.
export async function planSketchObjects({ prompt, image, footprints, signal }) {
	const form = new FormData()
	form.append("prompt", prompt ?? "")
	form.append("footprints", footprints ?? "")
	form.append("image", image, "sketch.png")
	const response = await fetch("/api/plan-objects", { method: "POST", body: form, signal })
	if (!response.ok) {
		const message = await response.text()
		throw new Error(message || `sketch planning failed (${response.status})`)
	}
	return response.json()
}

// Allocate the outputs/NNNN folder for one world generation; every object + the
// floor of that world are saved under it server-side.
export async function newOutput() {
	const response = await fetch("/api/new-output", { method: "POST" })
	if (!response.ok) throw new Error((await response.text()) || "could not allocate an output folder")
	return response.json() // { index }
}

// Texture and reconstruct one capture (legacy object/floor or the current whole scene).
// The whole-scene path performs one image edit followed by one TripoSplat call.
export async function generateSubject({ prompt, kind, steps, gaussians, output, name, groundColor, label, colors, image, materialImage, skipImageEdit = false, signal }) {
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
	if (skipImageEdit) form.append("skip_image_edit", "true")
	form.append("image", image, `${name || "guide"}.png`)
	if (materialImage) form.append("material_image", materialImage, `${name || "materials"}-materials.png`)

	const response = await fetch("/api/generate", { method: "POST", body: form, signal })
	if (!response.ok) {
		const message = await response.text()
		throw new Error(message || `generation failed (${response.status})`)
	}
	return new Uint8Array(await response.arrayBuffer())
}

// Floor-only first stage: turn the flat top-down paint/material map into a realistic
// top-down terrain texture. The client applies this texture to the floor, captures the
// regular isometric guide, then sends that guide to TripoSplat without another image edit.
export async function generateFloorTexture({ prompt, image, groundColor, colors, output, name, signal }) {
	const form = new FormData()
	form.append("prompt", prompt ?? "")
	if (groundColor) form.append("ground_color", groundColor)
	if (colors && colors.length) form.append("colors", colors.join(","))
	if (output) form.append("output", output)
	if (name) form.append("name", name)
	form.append("image", image, `${name || "floor-texture"}.png`)

	const response = await fetch("/api/floor-texture", { method: "POST", body: form, signal })
	if (!response.ok) {
		const message = await response.text()
		throw new Error(message || `floor texture failed (${response.status})`)
	}
	return await response.blob()
}

// Generate the UNIFIED ground for an expanded world. The client sends one composited
// top-down ground image spanning the whole plot footprint; when `mask` is present the
// server OUTPAINTS — only the masked (new) region is repainted as a seamless continuation
// of the existing terrain, the rest is preserved. The server reconstructs the whole ground
// as ONE splat (gaussian count scaled by tile count) so there is no seam between plots.
// Returns { splat: Uint8Array, imageBlob: Blob } — keep imageBlob as the master for the
// NEXT expansion's outpaint context.
export async function generateGround({ prompt, image, mask, groundColor, colors, cols, rows, imageSize, output, name, signal }) {
	const form = new FormData()
	form.append("prompt", prompt ?? "")
	if (groundColor) form.append("ground_color", groundColor)
	if (colors && colors.length) form.append("colors", colors.join(","))
	form.append("cols", String(cols ?? 1))
	form.append("rows", String(rows ?? 1))
	if (imageSize) form.append("image_size", imageSize)
	if (output) form.append("output", output)
	form.append("name", name || "floor")
	form.append("image", image, "ground.png")
	if (mask) form.append("mask", mask, "ground-mask.png")

	const response = await fetch("/api/ground", { method: "POST", body: form, signal })
	if (!response.ok) {
		const message = await response.text()
		throw new Error(message || `ground generation failed (${response.status})`)
	}
	const json = await response.json()
	if (!json.splat) throw new Error("ground generation returned no splat")
	return {
		splat: base64ToBytes(json.splat),
		imageBlob: new Blob([base64ToBytes(json.image || "")], { type: "image/png" }),
	}
}

// ONE cohesive terrain TEXTURE for the whole footprint — no splat step. The client
// slices the returned image per tile and reconstructs each slice as its own splat.
export async function generateGroundTexture({ prompt, image, mask, groundColor, colors, cols, rows, imageSize, output, name, signal }) {
	const form = new FormData()
	form.append("prompt", prompt ?? "")
	form.append("texture_only", "1")
	if (groundColor) form.append("ground_color", groundColor)
	if (colors && colors.length) form.append("colors", colors.join(","))
	form.append("cols", String(cols ?? 1))
	form.append("rows", String(rows ?? 1))
	if (imageSize) form.append("image_size", imageSize)
	if (output) form.append("output", output)
	form.append("name", name || "floor")
	form.append("image", image, "ground.png")
	if (mask) form.append("mask", mask, "ground-mask.png")

	const response = await fetch("/api/ground", { method: "POST", body: form, signal })
	if (!response.ok) {
		const message = await response.text()
		throw new Error(message || `ground texture failed (${response.status})`)
	}
	const json = await response.json()
	if (!json.image) throw new Error("ground texture returned no image")
	return { imageBlob: new Blob([base64ToBytes(json.image)], { type: "image/png" }) }
}

function base64ToBytes(b64) {
	const bin = atob(b64)
	const out = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
	return out
}
