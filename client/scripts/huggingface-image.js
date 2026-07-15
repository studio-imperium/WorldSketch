export function fluxKleinEditPayload({ file, prompt, seed, settings }) {
	return {
		prompt,
		input_images: [{ image: file, caption: null }],
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
