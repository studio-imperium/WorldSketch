import { InferenceClient } from "@huggingface/inference"
import { getHuggingFaceAccessToken, getHuggingFaceAuth } from "/scripts/huggingface-auth.js"
import { friendlyHuggingFaceError } from "/scripts/huggingface-errors.js?v=geometry-dev-4"
import {
	cleanGeometryResponse,
	GEOMETRY_TARGETS,
	geometryGenerationRequest,
	geometryResponseContent,
} from "/scripts/geometry-generation-request.js?v=geometry-dev-4"

function retryableProviderError(error) {
	const status = Number(error?.httpResponse?.status)
	if ([401, 404, 408, 409, 425, 429].includes(status) || status >= 500) return true
	if (error?.code === "EMPTY_GEOMETRY_RESPONSE") return true
	return /provider.*(?:unavailable|overloaded)|temporar(?:y|ily)|timed? out/i.test(String(error?.message || ""))
}

export async function generateGeometryOnHuggingFace(prompt, { signal } = {}) {
	if (!getHuggingFaceAuth().signedIn) throw new Error("Sign in with Hugging Face before generating geometry")
	const inference = new InferenceClient(getHuggingFaceAccessToken())
	let lastError
	let exhaustedModel = ""
	for (const target of GEOMETRY_TARGETS) {
		if (target.model === exhaustedModel) continue
		try {
			const response = await inference.chatCompletion(
				geometryGenerationRequest(prompt, target),
				{ signal, retry_on_error: false },
			)
			return cleanGeometryResponse(geometryResponseContent(response))
		} catch (error) {
			lastError = error
			if (error?.code === "EMPTY_GEOMETRY_RESPONSE") exhaustedModel = target.model
			if (signal?.aborted || !retryableProviderError(error)) break
		}
	}
	throw friendlyHuggingFaceError(lastError, {
		useInferenceCredits: true,
		inferenceTask: "geometry generation",
	})
}
