import * as THREE from "three"

const captureSize = 1024
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x151515, transparent: true, opacity: 0.58 })

export async function capturePlotGuide(renderer, scene, camera, plot, helpers = []) {
	const original = snapshot(camera, renderer)
	const target = new THREE.WebGLRenderTarget(captureSize, captureSize)
	const hidden = hideOtherPlots(plot)
	const materialSwap = applyFlatMaterials(plot)

	const spark = scene.userData.sparkRenderer
	const sparkVisible = spark?.visible
	if (spark) spark.visible = false

	const outlines = []
	scene.traverse(object => {
		if (object.userData.isSelectionOutline && object.visible) {
			outlines.push(object)
			object.visible = false
		}
	})

	for (const helper of helpers) if (helper) helper.visible = false
	poseIso(camera, plot)
	updateSky(scene, camera)

	const edges = addEdges(plot)
	const guide = await captureTarget(renderer, scene, camera, target)
	for (const object of edges) object.removeFromParent()
	const materialMap = await captureTarget(renderer, scene, camera, target)

	if (spark) spark.visible = sparkVisible
	for (const object of outlines) object.visible = true
	for (const helper of helpers) if (helper) helper.visible = true
	restoreMaterials(materialSwap)
	for (const [object, visible] of hidden) object.visible = visible
	target.dispose()
	restore(camera, renderer, original)
	return { guide, materialMap }
}

function hideOtherPlots(plot) {
	const hidden = []
	for (const other of plot.manager.plots) {
		const visible = other.group.visible
		if (other !== plot) {
			hidden.push([other.group, visible])
			other.group.visible = false
		}
	}
	return hidden
}

function addEdges(plot) {
	const edges = []
	for (const mesh of plot.meshesForCapture()) {
		if (!mesh.geometry) continue
		const edge = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), edgeMaterial)
		edge.position.copy(mesh.position)
		edge.quaternion.copy(mesh.quaternion)
		edge.scale.copy(mesh.scale)
		edge.renderOrder = 20
		plot.group.add(edge)
		edges.push(edge)
	}
	return edges
}

function applyFlatMaterials(plot) {
	const swaps = []
	for (const mesh of plot.meshesForCapture()) {
		if (!mesh.material) continue
		const original = mesh.material
		const source = Array.isArray(original) ? original[0] : original
		const color = source?.color?.clone?.() ?? new THREE.Color(0x888888)
		mesh.material = new THREE.MeshBasicMaterial({
			color,
			side: THREE.DoubleSide,
			depthTest: true,
			depthWrite: true,
		})
		swaps.push([mesh, original, mesh.material])
	}
	return swaps
}

function restoreMaterials(swaps) {
	for (const [mesh, original, temporary] of swaps) {
		mesh.material = original
		temporary.dispose()
	}
}

function poseIso(camera, plot) {
	const center = plot.center
	const distance = plot.size * 1.35
	camera.fov = 42
	camera.aspect = 1
	camera.near = 0.03
	camera.far = Math.max(48, plot.size * 8)
	camera.position.set(center.x + distance, center.y + plot.size * 0.92, center.z + distance)
	camera.lookAt(center.x, center.y + 0.55, center.z)
	camera.updateProjectionMatrix()
	camera.updateMatrixWorld(true)
}

function captureTarget(renderer, scene, camera, target) {
	renderer.setRenderTarget(target)
	renderer.setClearColor(0xeef5f2, 1)
	renderer.clear()
	renderer.render(scene, camera)

	const pixels = new Uint8Array(captureSize * captureSize * 4)
	renderer.readRenderTargetPixels(target, 0, 0, captureSize, captureSize, pixels)
	renderer.setRenderTarget(null)

	return pixelsToBlob(pixels)
}

function pixelsToBlob(pixels) {
	const canvas = document.createElement("canvas")
	canvas.width = captureSize
	canvas.height = captureSize
	const context = canvas.getContext("2d")
	const image = context.createImageData(captureSize, captureSize)

	for (let y = 0; y < captureSize; y++) {
		const src = y * captureSize * 4
		const dst = (captureSize - y - 1) * captureSize * 4
		image.data.set(pixels.subarray(src, src + captureSize * 4), dst)
	}

	context.putImageData(image, 0, 0)
	return new Promise(resolve => canvas.toBlob(resolve, "image/png"))
}

function snapshot(camera, renderer) {
	return {
		position: camera.position.clone(),
		quaternion: camera.quaternion.clone(),
		aspect: camera.aspect,
		near: camera.near,
		far: camera.far,
		fov: camera.fov,
		clear: renderer.getClearColor(new THREE.Color()).clone(),
	}
}

function restore(camera, renderer, state) {
	camera.position.copy(state.position)
	camera.quaternion.copy(state.quaternion)
	camera.aspect = state.aspect
	camera.near = state.near
	camera.far = state.far
	camera.fov = state.fov
	camera.updateProjectionMatrix()
	renderer.setClearColor(state.clear, 1)
}

function updateSky(scene, camera) {
	scene.traverse(object => {
		if (object.userData.sky) object.position.copy(camera.position)
	})
}
