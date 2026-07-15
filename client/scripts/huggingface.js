import { Client, handle_file } from "@gradio/client"
import { InferenceClient } from "@huggingface/inference"
import {
	configureHuggingFaceAuth,
	getHuggingFaceAccessToken,
	getHuggingFaceAuth,
	signOutHuggingFaceAuth,
} from "/scripts/huggingface-auth.js"
import { sceneGenerationPrompt } from "/scripts/generation-prompt.js?v=minimal-default-1"
import { friendlyHuggingFaceError } from "/scripts/huggingface-errors.js?v=hf-credits-1"
import { imageEditPayload } from "/scripts/huggingface-image.js?v=qwen-edit-1"
import { inferenceCreditImageRequest } from "/scripts/huggingface-provider.js"
import { resolveAuthenticatedSpaceFileURL } from "/scripts/huggingface-url.js"

const DEFAULT_CONFIG = {
	oauthClientId: "91581ad0-d16c-4f49-9746-cff21b50ac9e",
	redirectUrl: "",
	imageSpace: "Qwen/Qwen-Image-Edit-2509",
	tripoSpace: "VAST-AI/TripoSplat",
	inferenceProvider: "fal-ai",
	inferenceModel: "black-forest-labs/FLUX.2-dev",
	image: { steps: 40, guidance: 4, width: 1024, height: 1024 },
	tripo: { steps: 30, guidance: 3, gaussians: 131072, format: "splat" },
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

async function downloadFile(file, space, signal, { onProgress, stallMs = 45_000 } = {}) {
	const url = resolveAuthenticatedSpaceFileURL(file, space)
	const controller = new AbortController()
	let stalled = false
	let stallTimer = 0
	const abort = () => controller.abort(signal?.reason)
	const armStallTimer = () => {
		window.clearTimeout(stallTimer)
		stallTimer = window.setTimeout(() => {
			stalled = true
			controller.abort()
		}, stallMs)
	}
	signal?.addEventListener("abort", abort, { once: true })
	try {
		armStallTimer()
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${getHuggingFaceAccessToken()}` },
			signal: controller.signal,
		})
		if (!response.ok) throw new Error(`Could not download the generated file (${response.status})`)
		const reader = response.body?.getReader?.()
		if (!reader) return response.blob()
		const total = Math.max(0, Number(response.headers.get("content-length")) || 0)
		const chunks = []
		let loaded = 0
		while (true) {
			armStallTimer()
			const { done, value } = await reader.read()
			if (done) break
			if (!value?.byteLength) continue
			chunks.push(value)
			loaded += value.byteLength
			onProgress?.({ loaded, total })
		}
		return new Blob(chunks, { type: response.headers.get("content-type") || "application/octet-stream" })
	} catch (error) {
		if (stalled) throw new Error(`The generated file download stalled for ${Math.round(stallMs / 1000)} seconds. Please try again.`)
		throw error
	} finally {
		window.clearTimeout(stallTimer)
		signal?.removeEventListener("abort", abort)
	}
}

function downloadLabel(loaded, total) {
	const mb = bytes => `${(bytes / (1024 * 1024)).toFixed(1)} MB`
	return total > 0
		? `Downloading the 3D scene — ${mb(loaded)} of ${mb(total)}`
		: `Downloading the 3D scene — ${mb(loaded)}`
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

// TripoSplat's Space runs its own background-removal model (BiRefNet) on any
// upload without transparency, and that pass can carve away real terrain. It
// skips removal entirely when the image already carries a real alpha channel
// (any pixel below 255), so a transparent 1px border keeps the full frame
// intact and leaves the black background to the image model.
async function withTransparentBorder(blob) {
	const bitmap = await createImageBitmap(blob)
	const canvas = document.createElement("canvas")
	canvas.width = bitmap.width
	canvas.height = bitmap.height
	const context = canvas.getContext("2d")
	context.drawImage(bitmap, 0, 0)
	bitmap.close()
	context.clearRect(0, 0, canvas.width, 1)
	context.clearRect(0, canvas.height - 1, canvas.width, 1)
	context.clearRect(0, 0, 1, canvas.height)
	context.clearRect(canvas.width - 1, 0, 1, canvas.height)
	const png = await new Promise((resolve, reject) => {
		canvas.toBlob(result => result ? resolve(result) : reject(new Error("Could not encode the image for TripoSplat")), "image/png")
	})
	return new File([png], "scene.png", { type: "image/png" })
}

function randomSeed() {
	return crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff
}

// Image-detail stage only: block-out render (+ optional aligned geometry map) →
// detailed image blob. `prompt` is the FULL prompt text, not the scene description.
// A fixed `seed` makes runs reproducible for A/B comparisons.
export async function detailImageOnHuggingFace({ prompt, image, geometryImage = null, seed = randomSeed(), useInferenceCredits = false, signal, onProgress }) {
	if (!getHuggingFaceAuth().signedIn) throw new Error("Sign in with Hugging Face before generating")
	try {
		if (useInferenceCredits) {
			onProgress?.(0, "Using inference credits for image detail")
			const inference = new InferenceClient(getHuggingFaceAccessToken())
			let editedImage
			try {
				editedImage = await inference.imageToImage(inferenceCreditImageRequest({
					image,
					prompt,
					seed,
					settings: config.image,
					provider: config.inferenceProvider,
					model: config.inferenceModel,
				}), { signal, retry_on_error: false })
			} catch (error) {
				throw friendlyHuggingFaceError(error, { useInferenceCredits: true })
			}
			if (signal?.aborted) throw new DOMException("Generation cancelled", "AbortError")
			onProgress?.(1, "Image detail complete — inference credits used")
			return editedImage
		}
		onProgress?.(0, "Uploading the block-out")
		const imageData = await runSpace(config.imageSpace, "/infer", imageEditPayload({
			file: handle_file(image),
			geometryFile: geometryImage ? handle_file(geometryImage) : null,
			prompt,
			seed,
			settings: config.image,
			space: config.imageSpace,
		}), "Adding detail to the block-out", label => onProgress?.(0.5, label), signal)
		const editedFile = fileReference(imageData?.[0] ?? imageData)
		if (!editedFile) throw new Error("The image editor returned no image")
		onProgress?.(0.9, "Downloading the detailed image")
		return await downloadFile(editedFile, config.imageSpace, signal)
	} catch (error) {
		throw friendlyHuggingFaceError(error)
	}
}

// 3D stage only: detailed image → splat bytes. A fixed `seed` makes runs
// reproducible for A/B comparisons.
export async function buildSplatOnHuggingFace({ image, seed = randomSeed(), signal, onProgress }) {
	if (!getHuggingFaceAuth().signedIn) throw new Error("Sign in with Hugging Face before generating")
	try {
		onProgress?.(0, "Sending the image to TripoSplat")
		const tripoData = await runSpace(config.tripoSpace, "/generate", {
			image: handle_file(await withTransparentBorder(image)),
			seed,
			steps: Number(config.tripo.steps),
			guidance_scale: Number(config.tripo.guidance),
			num_gaussians: Number(config.tripo.gaussians),
			output_format: config.tripo.format || "splat",
		}, "TripoSplat is building the 3D scene", label => onProgress?.(0.43, label), signal)
		const splatFile = fileReference(tripoData?.[2]) ?? fileReference(tripoData)
		if (!splatFile) throw new Error("TripoSplat returned no 3D file")
		onProgress?.(0.92, "Downloading the 3D scene")
		const splat = await downloadFile(splatFile, config.tripoSpace, signal, {
			onProgress: ({ loaded, total }) => {
				const ratio = total > 0 ? loaded / total : Math.min(0.95, loaded / (8 * 1024 * 1024))
				onProgress?.(0.92 + Math.min(1, ratio) * 0.07, downloadLabel(loaded, total))
			},
		})
		onProgress?.(0.99, "Reading the downloaded 3D scene")
		return new Uint8Array(await splat.arrayBuffer())
	} catch (error) {
		throw friendlyHuggingFaceError(error)
	}
}

export async function generateSceneOnHuggingFace({ prompt, image, geometryImage = null, useInferenceCredits = false, signal, onProgress, onImageReady }) {
	// The public Space supports multiple aligned edit images. The paid inference API
	// accepts one image only, so mention the geometry map only on the path that sends it.
	const useGeometryReference = !useInferenceCredits && Boolean(geometryImage)
	const editedImage = await detailImageOnHuggingFace({
		prompt: sceneGenerationPrompt(prompt, { hasGeometryReference: useGeometryReference }),
		image,
		geometryImage: useGeometryReference ? geometryImage : null,
		useInferenceCredits,
		signal,
		onProgress: (fraction, label) => onProgress?.(0.12 + fraction * 0.43, label),
	})
	onImageReady?.(editedImage)
	const bytes = await buildSplatOnHuggingFace({
		image: editedImage,
		signal,
		onProgress: (fraction, label) => onProgress?.(0.6 + fraction * 0.37, label),
	})
	return { bytes, editedImage }
}
