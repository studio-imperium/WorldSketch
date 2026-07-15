import { Client, handle_file } from "@gradio/client"
import { InferenceClient } from "@huggingface/inference"
import {
	configureHuggingFaceAuth,
	getHuggingFaceAccessToken,
	getHuggingFaceAuth,
	signOutHuggingFaceAuth,
} from "/scripts/huggingface-auth.js"
import { sceneGenerationPrompt } from "/scripts/generation-prompt.js"
import { friendlyHuggingFaceError } from "/scripts/huggingface-errors.js?v=hf-credits-1"
import { fluxKleinEditPayload } from "/scripts/huggingface-image.js"
import { inferenceCreditImageRequest } from "/scripts/huggingface-provider.js"
import { resolveAuthenticatedSpaceFileURL } from "/scripts/huggingface-url.js"

const DEFAULT_CONFIG = {
	oauthClientId: "91581ad0-d16c-4f49-9746-cff21b50ac9e",
	redirectUrl: "",
	imageSpace: "black-forest-labs/FLUX.2-klein-4B",
	tripoSpace: "VAST-AI/TripoSplat",
	inferenceProvider: "fal-ai",
	inferenceModel: "black-forest-labs/FLUX.2-klein-4B",
	image: { steps: 4, guidance: 1, width: 512, height: 512 },
	tripo: { steps: 10, guidance: 1, gaussians: 32768, format: "splat" },
}

let config = structuredClone(DEFAULT_CONFIG)
let activeJob = null

function mergeConfig(next = {}) {
	return {
		...DEFAULT_CONFIG,
		...next,
		image: { ...DEFAULT_CONFIG.image, ...(next.image ?? {}) },
		tripo: { ...DEFAULT_CONFIG.tripo, ...(next.tripo ?? {}) },
	}
}

export function configureHuggingFace(next) {
	config = mergeConfig(next)
	configureHuggingFaceAuth(config)
}

export function signOutHuggingFace() {
	activeJob?.cancel?.()
	activeJob = null
	signOutHuggingFaceAuth()
}

export { getHuggingFaceAuth }

export function cancelHuggingFaceGeneration() {
	activeJob?.cancel?.()
}

function fileReference(value) {
	if (!value) return null
	if (typeof value === "string" && (value.startsWith("http://") || value.startsWith("https://"))) return { url: value }
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = fileReference(item)
			if (found) return found
		}
		return null
	}
	if (typeof value === "object") {
		if (value.url || value.path) return value
		for (const child of Object.values(value)) {
			const found = fileReference(child)
			if (found) return found
		}
	}
	return null
}

async function downloadFile(file, space, signal) {
	const url = resolveAuthenticatedSpaceFileURL(file, space)
	const response = await fetch(url, { headers: { Authorization: `Bearer ${getHuggingFaceAccessToken()}` }, signal })
	if (!response.ok) throw new Error(`Could not download the generated file (${response.status})`)
	return response.blob()
}

function statusLabel(stage, message) {
	const status = message?.status ?? message
	const position = status?.position
	if (status?.stage === "pending" || status?.stage === "queued") {
		return Number.isFinite(position) ? `${stage} — ${position + 1} job${position ? "s" : ""} ahead` : `${stage} — waiting for a GPU`
	}
	if (status?.stage === "generating" || status?.stage === "running") return `${stage} — running`
	return stage
}

async function runSpace(space, endpoint, payload, stage, progress, signal) {
	if (signal?.aborted) throw new DOMException("Generation cancelled", "AbortError")
	const app = await Client.connect(space, { token: getHuggingFaceAccessToken(), events: ["data", "status"] })
	const job = await app.submit(endpoint, payload)
	activeJob = job
	const abort = () => job.cancel?.()
	signal?.addEventListener("abort", abort, { once: true })
	let data = null
	try {
		for await (const message of job) {
			if (message?.type === "status") {
				if (message.stage === "error") {
					const detail = typeof message.message === "string" ? message.message : JSON.stringify(message.message || message.code || "Space job failed")
					throw new Error(detail)
				}
				progress?.(statusLabel(stage, message))
			}
			if (message?.type === "data") data = message.data
		}
	} finally {
		signal?.removeEventListener("abort", abort)
		if (activeJob === job) activeJob = null
	}
	if (signal?.aborted) throw new DOMException("Generation cancelled", "AbortError")
	if (!data) throw new Error(`${stage} finished without returning a result`)
	return data
}

function randomSeed() {
	return crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff
}

export async function generateSceneOnHuggingFace({ prompt, image, useInferenceCredits = false, signal, onProgress }) {
	if (!getHuggingFaceAuth().signedIn) throw new Error("Sign in with Hugging Face before generating")
	try {
		const detailPrompt = sceneGenerationPrompt(prompt)
		let editedImage
		if (useInferenceCredits) {
			onProgress?.(0.12, "Using inference credits for image detail")
			const inference = new InferenceClient(getHuggingFaceAccessToken())
			try {
				editedImage = await inference.imageToImage(inferenceCreditImageRequest({
					image,
					prompt: detailPrompt,
					seed: randomSeed(),
					settings: config.image,
					provider: config.inferenceProvider,
					model: config.inferenceModel,
				}), { signal, retry_on_error: false })
			} catch (error) {
				throw friendlyHuggingFaceError(error, { useInferenceCredits: true })
			}
			if (signal?.aborted) throw new DOMException("Generation cancelled", "AbortError")
			onProgress?.(0.55, "Image detail complete — inference credits used")
		} else {
			onProgress?.(0.12, "Uploading the block-out")
			const imageData = await runSpace(config.imageSpace, "/infer", fluxKleinEditPayload({
				file: handle_file(image),
				prompt: detailPrompt,
				seed: randomSeed(),
				settings: config.image,
			}), "Adding detail to the block-out", label => onProgress?.(0.35, label), signal)
			const editedFile = fileReference(imageData?.[0] ?? imageData)
			if (!editedFile) throw new Error("The image editor returned no image")
			onProgress?.(0.55, "Downloading the detailed image")
			editedImage = await downloadFile(editedFile, config.imageSpace, signal)
		}
		onProgress?.(0.6, "Sending the image to TripoSplat")
		const tripoData = await runSpace(config.tripoSpace, "/generate", {
			image: handle_file(editedImage),
			seed: randomSeed(),
			steps: Number(config.tripo.steps),
			guidance_scale: Number(config.tripo.guidance),
			num_gaussians: Number(config.tripo.gaussians),
			output_format: config.tripo.format || "splat",
		}, "TripoSplat is building the 3D scene", label => onProgress?.(0.76, label), signal)
		const splatFile = fileReference(tripoData?.[2]) ?? fileReference(tripoData)
		if (!splatFile) throw new Error("TripoSplat returned no 3D file")
		onProgress?.(0.94, "Downloading the 3D scene")
		const splat = await downloadFile(splatFile, config.tripoSpace, signal)
		return { bytes: new Uint8Array(await splat.arrayBuffer()), editedImage }
	} catch (error) {
		throw friendlyHuggingFaceError(error)
	}
}
