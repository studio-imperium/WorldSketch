import assert from "node:assert/strict"
import test from "node:test"

import { friendlyHuggingFaceError } from "../scripts/huggingface-errors.js"

test("explains an incompatible ZeroGPU duration in plain language", () => {
	const result = friendlyHuggingFaceError(new Error("The requested GPU duration (360s) is larger than the maximum allowed"))
	assert.match(result.message, /6 minutes/)
	assert.match(result.message, /above your account's per-run limit/)
	assert.match(result.message, /Hugging Face details:/)
})

test("keeps an unrelated provider error intact", () => {
	const original = new Error("The image editor returned no image")
	assert.equal(friendlyHuggingFaceError(original), original)
})

test("warns that an aborted GPU task may consume quota", () => {
	const result = friendlyHuggingFaceError(new Error("GPU task aborted"))
	assert.match(result.message, /may still have used GPU time/)
})

test("shows the requested time, remaining time, and retry window", () => {
	const result = friendlyHuggingFaceError(new Error(
		"You have exceeded your Free ZeroGPU quota (85s requested vs. 30s left). Try again in 1:23:45.",
	))
	assert.match(result.message, /requested 1 minute 25 seconds/)
	assert.match(result.message, /30 seconds remaining/)
	assert.match(result.message, /try again in 1:23:45/i)
	assert.match(result.message, /85s requested vs\. 30s left/)
})

test("distinguishes a daily run limit from an empty time balance", () => {
	const result = friendlyHuggingFaceError(new Error(
		"ZeroGPU quota exceeded: daily GPU task limit reached. Try again in 04:12:09.",
	))
	assert.match(result.message, /daily run limit was reached/)
	assert.doesNotMatch(result.message, /time is used up/i)
	assert.match(result.message, /daily GPU task limit reached/)
})

test("does not claim a generic quota error means no time remains", () => {
	const result = friendlyHuggingFaceError(new Error("ZeroGPU quota exceeded"))
	assert.match(result.message, /may have hit its daily run limit/)
	assert.doesNotMatch(result.message, /used up/i)
	assert.match(result.message, /Hugging Face details: ZeroGPU quota exceeded/)
})
