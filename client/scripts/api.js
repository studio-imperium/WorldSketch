// Returns the .splat bytes (a Uint8Array). When the server style-matched this render it also
// returns a gen-id in X-Gen-Id, attached here as `bytes.genId`; passing that back as
// `referenceId` on a neighbouring plot makes the server match its style. Attaching to the
// array (instead of returning an object) keeps every existing `const bytes = await
// generatePlot()` caller — including the snip-edit path — working unchanged.
export async function generatePlot({ prompt, image, materialImage, groundColor, referenceId, signal }) {
	const form = new FormData()
	form.append("prompt", prompt)
	if (groundColor) form.append("ground_color", groundColor)
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

	const bytes = new Uint8Array(await response.arrayBuffer())
	bytes.genId = response.headers.get("X-Gen-Id") || ""
	return bytes
}
