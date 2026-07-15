import { Client, handle_file } from "@gradio/client"
import { sceneGenerationPrompt } from "/scripts/generation-prompt.js"
import { friendlyHuggingFaceError } from "/scripts/huggingface-errors.js?v=hf-errors-2"
import { fluxKleinEditPayload } from "/scripts/huggingface-image.js"
import { resolveAuthenticatedSpaceFileURL } from "/scripts/huggingface-url.js"

const HF_ORIGIN = "https://huggingface.co"
const DEFAULT_CONFIG = {
	oauthClientId: "91581ad0-d16c-4f49-9746-cff21b50ac9e",
	redirectUrl: "",
	imageSpace: "black-forest-labs/FLUX.2-klein-4B",
	tripoSpace: "VAST-AI/TripoSplat",
	image: { steps: 4, guidance: 1, width: 512, height: 512 },
	tripo: { steps: 10, guidance: 1, gaussians: 32768, format: "splat" },
}

const CALLBACK_KEYS = {
	verifier: "worldsketch.hf.verifier",
	state: "worldsketch.hf.state",
	prompt: "worldsketch.hf.pendingPrompt",
}

let config = structuredClone(DEFAULT_CONFIG)
let accessToken = ""
let tokenExpiresAt = 0
let user = null
let activeJob = null
const listeners = new Set()

function mergeConfig(next = {}) {
	return {
		...DEFAULT_CONFIG,
		...next,
		image: { ...DEFAULT_CONFIG.image, ...(next.image ?? {}) },
		tripo: { ...DEFAULT_CONFIG.tripo, ...(next.tripo ?? {}) },
	}
}

function emit() {
	const snapshot = getHuggingFaceAuth()
	for (const listener of listeners) listener(snapshot)
}

function randomUrlSafe(bytes = 32) {
	const data = crypto.getRandomValues(new Uint8Array(bytes))
	let binary = ""
	for (const byte of data) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

async function sha256UrlSafe(value) {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
	let binary = ""
	for (const byte of digest) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function redirectUrl() {
	return config.redirectUrl || `${location.origin}/`
}

function cleanCallbackUrl() {
	const url = new URL(location.href)
	for (const key of ["code", "state", "error", "error_description"]) url.searchParams.delete(key)
	history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`)
}

export function configureHuggingFace(next) {
	config = mergeConfig(next)
	emit()
}

export function onHuggingFaceAuthChange(listener) {
	listeners.add(listener)
	listener(getHuggingFaceAuth())
	return () => listeners.delete(listener)
}

export function getHuggingFaceAuth() {
	if (accessToken && tokenExpiresAt && Date.now() >= tokenExpiresAt) signOutHuggingFace()
	return { signedIn: Boolean(accessToken), user }
}

export async function signInHuggingFace(pendingPrompt = "") {
	if (!config.oauthClientId) throw new Error("Hugging Face sign-in is not configured")
	const verifier = randomUrlSafe(64)
	const state = randomUrlSafe(24)
	sessionStorage.setItem(CALLBACK_KEYS.verifier, verifier)
	sessionStorage.setItem(CALLBACK_KEYS.state, state)
	if (pendingPrompt) sessionStorage.setItem(CALLBACK_KEYS.prompt, pendingPrompt)
	else sessionStorage.removeItem(CALLBACK_KEYS.prompt)

	const authorize = new URL(`${HF_ORIGIN}/oauth/authorize`)
	authorize.search = new URLSearchParams({
		client_id: config.oauthClientId,
		redirect_uri: redirectUrl(),
		response_type: "code",
		scope: "openid profile",
		state,
		code_challenge: await sha256UrlSafe(verifier),
		code_challenge_method: "S256",
	}).toString()
	location.assign(authorize)
}

export async function finishHuggingFaceSignIn() {
	const params = new URLSearchParams(location.search)
	const oauthError = params.get("error")
	const code = params.get("code")
	if (!oauthError && !code) return { handled: false, prompt: "" }
	if (oauthError) {
		const detail = params.get("error_description") || oauthError
		for (const key of Object.values(CALLBACK_KEYS)) sessionStorage.removeItem(key)
		cleanCallbackUrl()
		throw new Error(`Hugging Face sign-in failed: ${detail}`)
	}

	const expectedState = sessionStorage.getItem(CALLBACK_KEYS.state)
	const verifier = sessionStorage.getItem(CALLBACK_KEYS.verifier)
	const returnedState = params.get("state")
	const prompt = sessionStorage.getItem(CALLBACK_KEYS.prompt) || ""
	for (const key of Object.values(CALLBACK_KEYS)) sessionStorage.removeItem(key)
	cleanCallbackUrl()
	if (!verifier || !expectedState || returnedState !== expectedState) {
		throw new Error("Hugging Face sign-in could not be verified. Please try again.")
	}

	const response = await fetch(`${HF_ORIGIN}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: config.oauthClientId,
			code,
			code_verifier: verifier,
			grant_type: "authorization_code",
			redirect_uri: redirectUrl(),
		}),
	})
	const result = await response.json().catch(() => ({}))
	if (!response.ok || !result.access_token) {
		throw new Error(result.error_description || result.error || "Hugging Face sign-in failed")
	}
	accessToken = result.access_token
	tokenExpiresAt = result.expires_in ? Date.now() + Number(result.expires_in) * 1000 : 0
	try {
		const whoami = await fetch(`${HF_ORIGIN}/api/whoami-v2`, { headers: { Authorization: `Bearer ${accessToken}` } })
		if (whoami.ok) user = await whoami.json()
	} catch {
		user = null
	}
	emit()
	return { handled: true, prompt }
}

export function signOutHuggingFace() {
	activeJob?.cancel?.()
	activeJob = null
	for (const key of Object.values(CALLBACK_KEYS)) sessionStorage.removeItem(key)
	accessToken = ""
	tokenExpiresAt = 0
	user = null
	emit()
}

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
	const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal })
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
	const app = await Client.connect(space, { token: accessToken, events: ["data", "status"] })
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

export async function generateSceneOnHuggingFace({ prompt, image, signal, onProgress }) {
	if (!getHuggingFaceAuth().signedIn) throw new Error("Sign in with Hugging Face before generating")
	try {
		onProgress?.(0.12, "Uploading the block-out")
		const imageData = await runSpace(config.imageSpace, "/infer", fluxKleinEditPayload({
			file: handle_file(image),
			prompt: sceneGenerationPrompt(prompt),
			seed: randomSeed(),
			settings: config.image,
		}), "Adding detail to the block-out", label => onProgress?.(0.35, label), signal)
		const editedFile = fileReference(imageData?.[0] ?? imageData)
		if (!editedFile) throw new Error("The image editor returned no image")
		onProgress?.(0.55, "Downloading the detailed image")
		const editedImage = await downloadFile(editedFile, config.imageSpace, signal)

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
