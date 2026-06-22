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
if (src) {
	// `src` may be a comma-separated list of splat URLs — one per plot. Each plot
	// is generated in the same absolute world frame, so they overlay into one world
	// when loaded together with no per-scene transform.
	const srcs = src.split(",").map(s => s.trim()).filter(Boolean)
	loadURLs(srcs)
}
if (collisionSrc) {
	fetchCollision(collisionSrc)
		.then(data => loadCollision(data, collisionSrc.split("/").pop()))
		.catch(err => status.textContent = err.message)
}

// loadURLs composes one or more splats (multi-plot world) in a shared world frame. No
// per-scene transform — gaussians are in absolute coords. Each splat loads independently so a
// missing one (e.g. a plot whose GPU build hasn't produced world.splat yet) is skipped with a
// clear message instead of silently leaving the whole viewer blank.
async function loadURLs(srcs, format = undefined) {
	if (!srcs.length) return
	status.textContent = srcs.length === 1 ? "Loading splat" : `Loading ${srcs.length} plots`
	let loaded = 0
	const failed = []
	for (const path of srcs) {
		try {
			await viewer.addSplatScene(path, { format, showLoadingUI: false, splatAlphaRemovalThreshold: 1 })
			loaded++
		} catch (err) {
			console.warn("splat failed to load:", path, err)
			failed.push(path)
		}
	}
	if (loaded === 0) {
		status.textContent = "No splat loaded — has it been built on the GPU worker yet?"
		stats.textContent = `0 / ${srcs.length} (all failed)`
		return
	}
	status.textContent = srcs.length === 1 ? srcs[0].split("/").pop() : `${loaded} of ${srcs.length} plots`
	stats.textContent = failed.length ? `Loaded ${loaded}; ${failed.length} not built yet` : `Loaded ${loaded}`
}

// loadURL composes a single splat — used by the file picker and drag-and-drop.
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
