import assert from "node:assert/strict"
import test from "node:test"

import { inferenceCreditImageRequest } from "../scripts/huggingface-provider.js"

test("builds the paid inference-provider image edit request", () => {
	const image = { blob: "guide" }
	assert.deepEqual(inferenceCreditImageRequest({
		image,
		prompt: "Preserve the block-out",
		seed: 42,
		settings: { width: "512", height: "512", steps: "4", guidance: "1" },
		provider: "fal-ai",
		model: "black-forest-labs/FLUX.2-klein-4B",
	}), {
		provider: "fal-ai",
		model: "black-forest-labs/FLUX.2-klein-4B",
		inputs: image,
		parameters: {
			prompt: "Preserve the block-out",
			seed: 42,
			num_inference_steps: 4,
			image_size: { width: 512, height: 512 },
			num_images: 1,
			output_format: "png",
		},
	})
})
