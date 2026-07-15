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
	signInHuggingFace().catch(showError)
})

try {
	const runtimeConfig = await getConfig()
	configureHuggingFaceAuth(runtimeConfig?.generation)
	await finishHuggingFaceSignIn()
	if (getHuggingFaceAuth().signedIn) enterEditor()
	else button.disabled = false
} catch (error) {
	showError(error)
}
