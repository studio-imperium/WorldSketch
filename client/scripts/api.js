export async function generatePlot({ prompt, image, materialImage, groundColor, signal }) {
	const form = new FormData()
	form.append("prompt", prompt)
	if (groundColor) form.append("ground_color", groundColor)
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

	return new Uint8Array(await response.arrayBuffer())
}
