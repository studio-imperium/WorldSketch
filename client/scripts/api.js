// Allocate the outputs/NNNN folder for one world generation; every object + the
// floor of that world are saved under it server-side.
export async function newOutput() {
	const response = await fetch("/api/new-output", { method: "POST" })
	if (!response.ok) throw new Error((await response.text()) || "could not allocate an output folder")
	return response.json() // { index }
}

// Generate one subject (an object or the floor): re-texture its block-out capture and
// reconstruct it with TripoSplat. Returns the raw .splat bytes.
export async function generateSubject({ prompt, kind, steps, gaussians, output, name, groundColor, image, materialImage, signal }) {
	const form = new FormData()
	form.append("prompt", prompt ?? "")
	form.append("kind", kind)
	if (steps) form.append("steps", String(steps))
	if (gaussians) form.append("gaussians", String(gaussians))
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
