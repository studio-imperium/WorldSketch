import { InferenceClient } from "@huggingface/inference"
import { getHuggingFaceAccessToken, getHuggingFaceAuth } from "/scripts/huggingface-auth.js"
import { friendlyHuggingFaceError } from "/scripts/huggingface-errors.js?v=geometry-dev-1"
import { cleanGeometryResponse, geometryGenerationRequest } from "/scripts/geometry-generation-request.js?v=geometry-dev-1"

export async function generateGeometryOnHuggingFace(prompt, { signal } = {}) {
	if (!getHuggingFaceAuth().signedIn) throw new Error("Sign in with Hugging Face before generating geometry")
	const inference = new InferenceClient(getHuggingFaceAccessToken())
	try {
		const response = await inference.chatCompletion(
			geometryGenerationRequest(prompt),
			{ signal, retry_on_error: false },
		)
		return cleanGeometryResponse(response?.choices?.[0]?.message?.content)
	} catch (error) {
		throw friendlyHuggingFaceError(error, {
			useInferenceCredits: true,
			inferenceTask: "geometry generation",
		})
	}
}
