import { InferenceClient } from "@huggingface/inference"
import { getHuggingFaceAccessToken, getHuggingFaceAuth } from "/scripts/huggingface-auth.js"
import { friendlyHuggingFaceError } from "/scripts/huggingface-errors.js?v=geometry-dev-2"
import {
	cleanGeometryResponse,
	GEOMETRY_PROVIDERS,
	geometryGenerationRequest,
} from "/scripts/geometry-generation-request.js?v=geometry-dev-2"

function retryableProviderError(error) {
	const status = Number(error?.httpResponse?.status)
	if ([401, 404, 408, 409, 425, 429].includes(status) || status >= 500) return true
	return /provider.*(?:unavailable|overloaded)|temporar(?:y|ily)|timed? out/i.test(String(error?.message || ""))
}

export async function generateGeometryOnHuggingFace(prompt, { signal } = {}) {
	if (!getHuggingFaceAuth().signedIn) throw new Error("Sign in with Hugging Face before generating geometry")
	const inference = new InferenceClient(getHuggingFaceAccessToken())
	let lastError
	for (const provider of GEOMETRY_PROVIDERS) {
		try {
			const response = await inference.chatCompletion(
				geometryGenerationRequest(prompt, { provider }),
				{ signal, retry_on_error: false },
			)
			return cleanGeometryResponse(response?.choices?.[0]?.message?.content)
		} catch (error) {
			lastError = error
			if (signal?.aborted || !retryableProviderError(error)) break
		}
	}
	throw friendlyHuggingFaceError(lastError, {
		useInferenceCredits: true,
		inferenceTask: "geometry generation",
	})
}
