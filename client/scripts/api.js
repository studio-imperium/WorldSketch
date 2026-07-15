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

// Allocate the outputs/NNNN folder for one world generation.
export async function newOutput() {
	const response = await fetch("/api/new-output", { method: "POST" })
	if (!response.ok) throw new Error((await response.text()) || "could not allocate an output folder")
	return response.json() // { index }
}

// Texture and reconstruct the complete scene with one image edit and one TripoSplat call.
export async function generateScene({ prompt, output, image, materialImage, signal }) {
	const form = new FormData()
	form.append("prompt", prompt ?? "")
	if (output) form.append("output", output)
	form.append("image", image, "scene.png")
	if (materialImage) form.append("material_image", materialImage, "scene-materials.png")

	const response = await fetch("/api/generate", { method: "POST", body: form, signal })
	if (!response.ok) {
		const message = await response.text()
		throw new Error(message || `generation failed (${response.status})`)
	}
	return new Uint8Array(await response.arrayBuffer())
}
