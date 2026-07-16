import { getConfig } from "/scripts/api.js"
import {
	configureHuggingFaceAuth,
	finishHuggingFaceSignIn,
	getHuggingFaceAuth,
	signInHuggingFace,
} from "/scripts/huggingface-auth.js"

const button = document.getElementById("hf_login_btn")
const label = document.getElementById("hf_login_label")
const errorBox = document.getElementById("login_error")

function showError(error) {
	errorBox.textContent = error?.message || String(error || "Could not sign in with Hugging Face")
	errorBox.classList.remove("hidden")
	label.textContent = "Try again"
	button.disabled = false
}

function enterEditor() {
	location.replace("/app/")
}

button.addEventListener("click", () => {
	button.disabled = true
	errorBox.classList.add("hidden")
	label.textContent = "Opening Hugging Face…"
	window.posthog?.capture("login_started")
	signInHuggingFace().catch(error => {
		window.posthog?.capture("login_failed", { error: error?.message })
		showError(error)
	})
})

try {
	const runtimeConfig = await getConfig()
	configureHuggingFaceAuth(runtimeConfig?.generation)
	const finished = await finishHuggingFaceSignIn()
	if (getHuggingFaceAuth().signedIn) {
		// Only a completed OAuth round-trip counts as a conversion; returning
		// visitors with a stored session skip straight to the editor.
		if (finished?.handled) window.posthog?.capture("login_completed", {}, { send_instantly: true })
		enterEditor()
	} else {
		button.disabled = false
	}
} catch (error) {
	window.posthog?.capture("login_failed", { error: error?.message })
	showError(error)
}
