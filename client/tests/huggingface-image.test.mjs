import assert from "node:assert/strict"
import test from "node:test"

import { fluxEditPayload, imageEditPayload, qwenEditPayload } from "../scripts/huggingface-image.js"

test("builds the live FLUX.2-dev image-edit request (no mode_choice)", () => {
	const file = { blob: "guide" }
	assert.deepEqual(fluxEditPayload({
		file,
		prompt: "Preserve the block-out",
		seed: 42,
		settings: { width: "512", height: "512", steps: "30", guidance: "4" },
		space: "black-forest-labs/FLUX.2-dev",
	}), {
		prompt: "Preserve the block-out",
		input_images: [{ image: file, caption: null }],
		seed: 42,
		randomize_seed: false,
		width: 512,
		height: 512,
		num_inference_steps: 30,
		guidance_scale: 4,
		prompt_upsampling: false,
	})
})

test("adds mode_choice only for the klein Space", () => {
	const file = { blob: "guide" }
	const payload = fluxEditPayload({
		file,
		prompt: "Preserve the block-out",
		seed: 42,
		settings: { width: 1024, height: 1024, steps: 4, guidance: 1 },
		space: "black-forest-labs/FLUX.2-klein-4B",
	})
	assert.equal(payload.mode_choice, "Distilled (4 steps)")
})

test("builds the live Qwen-Image-Edit-2509 request with prompt rewriting off", () => {
	const file = { blob: "guide" }
	const geometryFile = { blob: "geometry" }
	assert.deepEqual(qwenEditPayload({
		file,
		geometryFile,
		prompt: "Preserve the block-out",
		seed: 42,
		settings: { width: "1024", height: "1024", steps: "40", guidance: "4" },
	}), {
		prompt: "Preserve the block-out",
		images: [
			{ image: file, caption: null },
			{ image: geometryFile, caption: null },
		],
		seed: 42,
		randomize_seed: false,
		width: 1024,
		height: 1024,
		num_inference_steps: 40,
		true_guidance_scale: 4,
		rewrite_prompt: false,
	})
})

test("dispatches the payload builder by Space name", () => {
	const file = { blob: "guide" }
	const base = { file, prompt: "p", seed: 1, settings: { width: 512, height: 512, steps: 8, guidance: 2 } }
	assert.ok("true_guidance_scale" in imageEditPayload({ ...base, space: "Qwen/Qwen-Image-Edit-2509" }))
	assert.ok("guidance_scale" in imageEditPayload({ ...base, space: "black-forest-labs/FLUX.2-dev" }))
})

test("adds the aligned geometry map as a second Flux edit image", () => {
	const file = { blob: "guide" }
	const geometryFile = { blob: "geometry" }
	const payload = fluxEditPayload({
		file,
		geometryFile,
		prompt: "Preserve every mask",
		seed: 42,
		settings: { width: 1024, height: 1024, steps: 30, guidance: 4 },
	})
	assert.deepEqual(payload.input_images, [
		{ image: file, caption: null },
		{ image: geometryFile, caption: null },
	])
})
