// FLUX.2 Space image-edit request. The klein Space adds a mode_choice picker
// (distilled vs base) that the full FLUX.2-dev Space does not have.
export function fluxEditPayload({ file, geometryFile = null, prompt, seed, settings, space = "" }) {
	const inputImages = [{ image: file, caption: null }]
	if (geometryFile) inputImages.push({ image: geometryFile, caption: null })
	const payload = {
		prompt,
		input_images: inputImages,
		seed,
		randomize_seed: false,
		width: Number(settings.width),
		height: Number(settings.height),
		num_inference_steps: Number(settings.steps),
		guidance_scale: Number(settings.guidance),
		prompt_upsampling: false,
	}
	if (/klein/i.test(space)) payload.mode_choice = "Distilled (4 steps)"
	return payload
}
