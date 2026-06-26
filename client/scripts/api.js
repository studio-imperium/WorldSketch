// Returns { bytes, genId }: the .splat bytes plus the server's gen-id for this render,
// which can be passed back as `referenceId` on a neighbouring plot so it matches.
export async function generatePlot({ prompt, image, materialImage, groundColor, mode, referenceId, signal }) {
	const form = new FormData()
	form.append("prompt", prompt)
	if (groundColor) form.append("ground_color", groundColor)
	if (mode) form.append("mode", mode) // "edit" = snip & edit an existing plot
	if (referenceId) form.append("reference_id", referenceId)
	form.append("image", image, "plot-guide.png")
	if (materialImage) form.append("material_image", materialImage, "plot-materials.png")

	const response = await fetch("/api/generate-plot", {
		method: "POST",
		body: form,
		signal,
	})

	if (!response.ok) {
		const message = await response.text()
		throw new Error(message || `generation failed (${response.status})`)
	}

	const genId = response.headers.get("X-Gen-Id") || ""
	const bytes = new Uint8Array(await response.arrayBuffer())
	return { bytes, genId }
}
