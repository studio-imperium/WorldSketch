export function fluxKleinEditPayload({ file, geometryFile = null, prompt, seed, settings }) {
	const inputImages = [{ image: file, caption: null }]
	if (geometryFile) inputImages.push({ image: geometryFile, caption: null })
	return {
		prompt,
		input_images: inputImages,
		mode_choice: "Distilled (4 steps)",
		seed,
		randomize_seed: false,
		width: Number(settings.width),
		height: Number(settings.height),
		num_inference_steps: Number(settings.steps),
		guidance_scale: Number(settings.guidance),
		prompt_upsampling: false,
	}
}
