export async function generateScene(scene, views, onStatus) {
	onStatus("Queued")

	const body = new FormData()
	body.append("scene", new Blob([JSON.stringify(scene, null, 2)], { type: "application/json" }), "scene.json")
	for (const view of views) {
		body.append(`${view.name}_rgb`, view.rgb, "primitive_rgb.png")
		body.append(`${view.name}_depth`, view.depth, "primitive_depth.png")
		body.append(`${view.name}_camera`, new Blob([JSON.stringify(view.camera, null, 2)], { type: "application/json" }), "camera.json")
	}

	const res = await fetch("/api/generate", {
		method: "POST",
		body,
	})
	if (!res.ok) throw new Error(await res.text())

	const { jobId } = await res.json()
	return poll(jobId, onStatus)
}

export async function retrainBundle(file, onStatus) {
	onStatus("Uploading bundle")

	const body = new FormData()
	body.append("bundle", file, file.name || "worldsketch-training-bundle.zip")

	const res = await fetch("/api/retrain", {
		method: "POST",
		body,
	})
	if (!res.ok) throw new Error(await res.text())

	const { jobId } = await res.json()
	return poll(jobId, onStatus)
}

async function poll(jobId, onStatus) {
	while (true) {
		const res = await fetch(`/api/jobs/${jobId}`)
		const job = await res.json()
		onStatus(job.error ? `${job.status}: ${job.error}` : job.status)

		if (job.status === "done") return job
		if (job.status === "failed" && job.bundleUrl) return job
		if (job.status === "failed") throw new Error(job.error || "generation failed")

		await new Promise(resolve => setTimeout(resolve, 500))
	}
}
