import * as THREE from "three"
import { ORIENT_MARKERS, MARKER_INSET } from "/scripts/orient.js"

const captureSize = 1024
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x151515, transparent: true, opacity: 0.58 })

export async function capturePlotGuide(renderer, scene, camera, plot, helpers = [], options = {}) {
	const original = snapshot(camera, renderer)
	// Tag the target as sRGB so Three.js applies the same linear→sRGB output encoding
	// it does for the on-screen canvas. Without this the read-back pixels stay in
	// linear space and the captured colours look noticeably darker than the client.
	const target = new THREE.WebGLRenderTarget(captureSize, captureSize, { colorSpace: THREE.SRGBColorSpace })
	const hidden = hideOtherPlots(plot)
	const materialSwap = applyFlatMaterials(plot)

	const spark = scene.userData.sparkRenderer
	const sparkVisible = spark?.visible
	if (spark) spark.visible = false

	const outlines = []
	scene.traverse(object => {
		if ((object.userData.isSelectionOutline || object.userData.isDebugHelper) && object.visible) {
			outlines.push(object)
			object.visible = false
		}
	})

	for (const helper of helpers) if (helper) helper.visible = false
	poseIso(camera, plot)
	updateSky(scene, camera)

	// Orientation fiducials: two adjacent-corner colour tags Tripo reconstructs so
	// the splat's arbitrary yaw/handedness can be recovered (and then culled) on the
	// client. See resolveOrientation in orient.js.
	const markers = options.markers ? addOrientMarkers(plot) : []

	const edges = addEdges(plot)
	const guide = await captureTarget(renderer, scene, camera, target)
	for (const object of edges) object.removeFromParent()
	const materialMap = await captureTarget(renderer, scene, camera, target)
	for (const marker of markers) {
		marker.geometry.dispose()
		marker.material.dispose()
		marker.removeFromParent()
	}

	if (spark) spark.visible = sparkVisible
	for (const object of outlines) object.visible = true
	for (const helper of helpers) if (helper) helper.visible = true
	restoreMaterials(materialSwap)
	for (const [object, visible] of hidden) object.visible = visible
	target.dispose()
	restore(camera, renderer, original)
	return { guide, materialMap }
}

// "Snip & edit" capture: an isometric photo of the plot AS IT CURRENTLY RENDERS
// (the generated splat stays visible), framed exactly like capturePlotGuide so the
// edited + rebuilt splat re-seats on the same plot. Unlike the guide, this keeps the
// spark renderer on and skips the block-out edges / flat materials / markers.
export async function capturePlotPhoto(renderer, scene, camera, plot, helpers = []) {
	const original = snapshot(camera, renderer)
	const target = new THREE.WebGLRenderTarget(captureSize, captureSize, { colorSpace: THREE.SRGBColorSpace })
	const hidden = hideOtherPlots(plot)

	const outlines = []
	scene.traverse(object => {
		if ((object.userData.isSelectionOutline || object.userData.isDebugHelper) && object.visible) {
			outlines.push(object)
			object.visible = false
		}
	})
	for (const helper of helpers) if (helper) helper.visible = false

	poseIso(camera, plot)
	updateSky(scene, camera)
	const photo = await captureTarget(renderer, scene, camera, target)

	for (const object of outlines) object.visible = true
	for (const helper of helpers) if (helper) helper.visible = true
	for (const [object, visible] of hidden) object.visible = visible
	target.dispose()
	restore(camera, renderer, original)
	return { photo }
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

// Small flat-coloured cubes at two adjacent corners of the plot, sitting on the
// ground. Added to the plot group only for the capture so Tripo bakes them into the
// reconstruction; resolveOrientation later detects their hues, recovers the pose,
// and culls them. Returns the meshes so the caller can remove them afterwards.
function addOrientMarkers(plot) {
	const meshes = []
	const reach = (plot.size / 2) * MARKER_INSET
	const s = plot.size * 0.07
	for (const marker of ORIENT_MARKERS) {
		const mesh = new THREE.Mesh(
			new THREE.BoxGeometry(s, s, s),
			new THREE.MeshBasicMaterial({ color: marker.hex, side: THREE.DoubleSide }),
		)
		mesh.position.set(marker.corner[0] * reach, s / 2, marker.corner[1] * reach)
		mesh.renderOrder = 15
		plot.group.add(mesh)
		meshes.push(mesh)
	}
	return meshes
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
	// Capture pose = a hand-picked focus-orbit angle (read off the logCameraPose output):
	// a spherical offset (radius, phi, theta) around the plot centre at y≈0.8, looking at
	// that target. Matches updateFocusCamera's math so the capture reproduces exactly the
	// view dialled in while orbiting (fov 50 included, so the framing matches too).
	const radius = 14.69
	const phi = THREE.MathUtils.degToRad(46.7)
	const theta = THREE.MathUtils.degToRad(13.3)
	const target = new THREE.Vector3(center.x, center.y + 0.8, center.z)
	camera.up.set(0, 1, 0)
	camera.fov = 50
	camera.aspect = 1
	camera.near = 0.03
	camera.far = Math.max(48, plot.size * 8)
	camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(new THREE.Spherical(radius, phi, theta)))
	camera.lookAt(target)
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
		up: camera.up.clone(),
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
	camera.up.copy(state.up)
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
