// Per-Space image-edit request builders. Spaces expose different /infer
// parameters, so the payload is chosen by Space name.

// FLUX.2 Spaces. The klein Space adds a mode_choice picker (distilled vs base)
// that the full FLUX.2-dev Space does not have.
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

// Qwen-Image-Edit-2509 Space. rewrite_prompt stays off so the exact WorldSketch
// prompt reaches the model instead of a machine-expanded paraphrase.
export function qwenEditPayload({ file, geometryFile = null, prompt, seed, settings }) {
	const images = [{ image: file, caption: null }]
	if (geometryFile) images.push({ image: geometryFile, caption: null })
	return {
		prompt,
		images,
		seed,
		randomize_seed: false,
		width: Number(settings.width),
		height: Number(settings.height),
		num_inference_steps: Number(settings.steps),
		true_guidance_scale: Number(settings.guidance),
		rewrite_prompt: false,
	}
}

export function imageEditPayload(request) {
	return /qwen/i.test(request.space || "") ? qwenEditPayload(request) : fluxEditPayload(request)
}
