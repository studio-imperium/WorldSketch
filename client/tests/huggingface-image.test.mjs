import assert from "node:assert/strict"
import test from "node:test"

import { fluxKleinEditPayload } from "../scripts/huggingface-image.js"

test("builds the live FLUX.2 Klein image-edit request", () => {
	const file = { blob: "guide" }
	assert.deepEqual(fluxKleinEditPayload({
		file,
		prompt: "Preserve the block-out",
		seed: 42,
		settings: { width: "512", height: "512", steps: "4", guidance: "1" },
	}), {
		prompt: "Preserve the block-out",
		input_images: [{ image: file, caption: null }],
		mode_choice: "Distilled (4 steps)",
		seed: 42,
		randomize_seed: false,
		width: 512,
		height: 512,
		num_inference_steps: 4,
		guidance_scale: 1,
		prompt_upsampling: false,
	})
})
