const DEFAULT_OAUTH_CLIENT_ID = "91581ad0-d16c-4f49-9746-cff21b50ac9e"

function env(name, fallback) {
	const value = process.env[name]?.trim()
	return value || fallback
}

function envFloat(name, fallback) {
	const value = Number(env(name, String(fallback)))
	return Number.isFinite(value) ? value : fallback
}

function envInt(name, fallback, min, max) {
	const value = Number(env(name, String(fallback)))
	if (!Number.isInteger(value)) return fallback
	return Math.min(max, Math.max(min, value))
}

export function runtimeConfig() {
	return {
		scene: {
			yOffset: envFloat("WS_SCENE_Y_OFFSET", 0),
			opacityFloor: envFloat("WS_SCENE_OPACITY_FLOOR", 0.03),
			yaw: envFloat("WS_SCENE_YAW", 0),
			fitBboxPercentile: envFloat("WS_SCENE_FIT_BBOX_PERCENTILE", 0),
		},
		generation: {
			provider: "huggingface",
			oauthClientId: env("WS_HF_OAUTH_CLIENT_ID", DEFAULT_OAUTH_CLIENT_ID),
			redirectUrl: env("WS_HF_REDIRECT_URL", ""),
			imageSpace: env("WS_HF_IMAGE_SPACE", "black-forest-labs/FLUX.2-klein-4B"),
			tripoSpace: env("WS_HF_TRIPO_SPACE", "VAST-AI/TripoSplat"),
			inferenceProvider: env("WS_HF_INFERENCE_PROVIDER", "fal-ai"),
			inferenceModel: env("WS_HF_INFERENCE_MODEL", "black-forest-labs/FLUX.2-klein-4B"),
			image: {
				steps: envInt("WS_HF_IMAGE_STEPS", 4, 1, 100),
				guidance: envFloat("WS_HF_IMAGE_GUIDANCE", 1),
				width: envInt("WS_HF_IMAGE_WIDTH", 1024, 256, 2048),
				height: envInt("WS_HF_IMAGE_HEIGHT", 1024, 256, 2048),
			},
			tripo: {
				steps: envInt("WS_HF_TRIPO_STEPS", 20, 1, 64),
				guidance: envFloat("WS_HF_TRIPO_GUIDANCE", 3),
				gaussians: envInt("WS_HF_TRIPO_GAUSSIANS", 131072, 32768, 262144),
				format: "splat",
			},
		},
	}
}

export default {
	fetch(request) {
		if (request.method !== "GET") {
			return new Response("method not allowed\n", {
				status: 405,
				headers: { Allow: "GET" },
			})
		}
		return Response.json(runtimeConfig(), {
			headers: { "Cache-Control": "no-cache" },
		})
	},
}
