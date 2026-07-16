export function inferenceCreditImageRequest({ image, prompt, seed, settings, provider, model }) {
	return {
		provider,
		model,
		inputs: image,
		parameters: {
			prompt,
			seed,
			num_inference_steps: Number(settings.steps),
			// True-CFG for Qwen-Image-Edit — the same knob the ZeroGPU Space's
			// true_guidance_scale sets, so both routes edit with equal strength.
			guidance_scale: Number(settings.guidance),
			image_size: {
				width: Number(settings.width),
				height: Number(settings.height),
			},
			num_images: 1,
			output_format: "png",
			// fal-only (other providers ignore unknown fields): disable fal's inference
			// speedups so the paid route matches the Space's plain pipeline as closely
			// as possible — its output should predict ZeroGPU output.
			...(provider === "fal-ai" ? { acceleration: "none" } : {}),
		},
	}
}
