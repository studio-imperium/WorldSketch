export function inferenceCreditImageRequest({ image, prompt, seed, settings, provider, model }) {
	return {
		provider,
		model,
		inputs: image,
		parameters: {
			prompt,
			seed,
			num_inference_steps: Number(settings.steps),
			image_size: {
				width: Number(settings.width),
				height: Number(settings.height),
			},
			num_images: 1,
			output_format: "png",
		},
	}
}
