import * as THREE from "three"
import * as GaussianSplats3D from "/lib/gaussian-splats-3d.module.js"
import { createCollisionOverlay, fetchCollision, readCollisionFile } from "/scripts/collision-overlay.js"

const root = document.getElementById("canvas")
const file = document.getElementById("file")
const collisionFile = document.getElementById("collision_file")
const status = document.getElementById("status")
const stats = document.getElementById("stats")

const viewer = new GaussianSplats3D.Viewer({
	rootElement: root,
	cameraUp: [0, 1, 0],
	initialCameraPosition: [3, 2, 4],
	initialCameraLookAt: [0, 0.8, 0],
	sharedMemoryForWorkers: false,
	gpuAcceleratedSort: false,
	splatAlphaRemovalThreshold: 1,
})

viewer.start()

// The library renders threeScene first, then composites the splats on top, so an
// overlay added to threeScene would sit *under* the splats. Instead we keep the
// wireframes in their own scene and draw it after the splat pass each frame.
const overlayScene = new THREE.Scene()
const collisions = createCollisionOverlay(overlayScene)

const colliderToggle = document.getElementById("show_colliders")
collisions.group.visible = colliderToggle.checked
colliderToggle.addEventListener("change", () => {
	collisions.group.visible = colliderToggle.checked
})

const renderWithSplats = viewer.render.bind(viewer)
viewer.render = () => {
	renderWithSplats()
	const renderer = viewer.renderer
	const autoClear = renderer.autoClear
	renderer.autoClear = false
	renderer.render(overlayScene, viewer.camera)
	renderer.autoClear = autoClear
}

file.addEventListener("change", async () => {
	if (!file.files.length) return
	await loadBlob(file.files[0], file.files[0].name)
})

collisionFile.addEventListener("change", async () => {
	if (!collisionFile.files.length) return
	await loadCollision(await readCollisionFile(collisionFile.files[0]), collisionFile.files[0].name)
})

window.addEventListener("dragover", event => {
	event.preventDefault()
})

window.addEventListener("drop", async event => {
	event.preventDefault()
	const item = event.dataTransfer.files[0]
	if (!item) return
	if (item.name.toLowerCase().endsWith(".json")) {
		await loadCollision(await readCollisionFile(item), item.name)
		return
	}
	await loadBlob(item, item.name)
})

const params = new URLSearchParams(location.search)
const src = params.get("src")
const collisionSrc = params.get("collisions")
if (src) loadURL(src)
if (collisionSrc) {
	fetchCollision(collisionSrc)
		.then(data => loadCollision(data, collisionSrc.split("/").pop()))
		.catch(err => status.textContent = err.message)
}

async function loadURL(src, format = undefined) {
	status.textContent = "Loading splat"
	await viewer.addSplatScene(src, {
		format,
		showLoadingUI: false,
		splatAlphaRemovalThreshold: 1,
	})
	status.textContent = src.split("/").pop()
	stats.textContent = "Loaded"
}

async function loadBlob(blob, name) {
	const url = URL.createObjectURL(blob)
	try {
		await loadURL(url, GaussianSplats3D.SceneFormat.Splat)
		status.textContent = name
		stats.textContent = `${(blob.size / 1024 / 1024).toFixed(2)} MB`
	} finally {
		URL.revokeObjectURL(url)
	}
}

function loadCollision(data, name) {
	try {
		const count = collisions.load(data)
		status.textContent = `${name}: ${count} collision wireframes`
	} catch (err) {
		status.textContent = err.message
	}
}
