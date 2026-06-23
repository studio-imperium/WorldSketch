export async function generatePlot({ prompt, image, materialImage, signal }) {
	const form = new FormData()
	form.append("prompt", prompt)
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
