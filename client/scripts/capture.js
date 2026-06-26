import * as THREE from "three"

// Per-subject capture for modular world generation. Each object (and the floor) is
// photographed ALONE on a black background from a fixed pose, so TripoSplat lands it
// in a consistent orientation and the client can seat it by bounding box alone.

const captureSize = 1024
const background = new THREE.Color(0x000000)
// Light edges so the silhouette reads against the black background (dark edges would
// vanish on it). The flat-material pass keeps true colours for the material-ID map.
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xdcdcdc, transparent: true, opacity: 0.85 })

// The proven isometric pose (read off the old whole-plot capture). Objects reuse this
// exact view direction — the consistency the no-rotation seating depends on — and only
// scale the orbit radius to frame each subject. REF_SIZE is the plot size the radius
// was tuned against, so a subject of footprint S is framed at radius * S / REF_SIZE.
export const MASTER_POSE = {
	radius: 14.69,
	phi: THREE.MathUtils.degToRad(46.7),
	theta: THREE.MathUtils.degToRad(13.3),
	fov: 50,
}
export const REF_SIZE = 8
// The floor is shot from nearly top-down so the whole flat surface is visible and its
// flatness is unambiguous to Tripo. Same azimuth (theta) so "front" stays consistent.
export const FLOOR_PHI = THREE.MathUtils.degToRad(20)

// Capture one object: its primitives, alone, framed by their footprint.
export function captureObject(renderer, scene, camera, world, object) {
	return captureSubject(renderer, scene, camera, world, object.primitives, objectPose(object.box))
}

// Capture the floor: just the painted ground tile, shot near top-down.
export function captureFloor(renderer, scene, camera, world) {
	return captureSubject(renderer, scene, camera, world, [world.ground], floorPose(world))
}

// Render a guide (with edge lines) + a flat material-ID map of `subject` alone, on a
// black background, from `pose`. Everything else — other block-out meshes, all splats,
// outlines, helpers, the placement preview — is hidden so only the subject is seen.
async function captureSubject(renderer, scene, camera, world, subject, pose) {
	const original = snapshot(camera, renderer)
	const target = new THREE.WebGLRenderTarget(captureSize, captureSize, { colorSpace: THREE.SRGBColorSpace })
	const subjectSet = new Set(subject)

	const hidden = []
	for (const mesh of world.allBlockoutMeshes()) {
		if (subjectSet.has(mesh)) continue
		hidden.push([mesh, mesh.visible])
		mesh.visible = false
	}

	// Hide every generated splat (the SparkRenderer draws them all) + any overlays.
	const spark = scene.userData.sparkRenderer
	const sparkVisible = spark?.visible
	if (spark) spark.visible = false
	const overlays = []
	scene.traverse(object => {
		if ((object.userData.isSelectionOutline || object.userData.isDebugHelper || object.userData.isPreview || object.userData.isFront) && object.visible) {
			overlays.push(object)
			object.visible = false
		}
	})

	const swaps = applyFlatMaterials(subject)
	posePerspective(camera, pose)

	const edges = addEdges(subject, world)
	const guide = await captureTarget(renderer, scene, camera, target)
	for (const edge of edges) {
		edge.geometry.dispose()
		edge.removeFromParent()
	}
	const materialMap = await captureTarget(renderer, scene, camera, target)

	restoreMaterials(swaps)
	for (const object of overlays) object.visible = true
	if (spark) spark.visible = sparkVisible
	for (const [mesh, visible] of hidden) mesh.visible = visible
	target.dispose()
	restore(camera, renderer, original)
	return { guide, materialMap }
}

function objectPose(box) {
	const center = box.getCenter(new THREE.Vector3())
	const size = box.getSize(new THREE.Vector3())
	const frame = Math.max(0.6, Math.hypot(size.x, size.z)) // footprint diagonal
	const radius = Math.max(2.5, (MASTER_POSE.radius * frame) / REF_SIZE)
	return { target: center, radius, phi: MASTER_POSE.phi, theta: MASTER_POSE.theta, fov: MASTER_POSE.fov, frame }
}

function floorPose(world) {
	const center = new THREE.Vector3(world.group.position.x, 0, world.group.position.z)
	const radius = (MASTER_POSE.radius * world.size) / REF_SIZE
	return { target: center, radius, phi: FLOOR_PHI, theta: MASTER_POSE.theta, fov: MASTER_POSE.fov, frame: world.size }
}

function posePerspective(camera, pose) {
	camera.up.set(0, 1, 0)
	camera.fov = pose.fov
	camera.aspect = 1
	camera.near = 0.03
	camera.far = Math.max(64, pose.radius * 6 + pose.frame * 4)
	camera.position.copy(pose.target).add(new THREE.Vector3().setFromSpherical(new THREE.Spherical(pose.radius, pose.phi, pose.theta)))
	camera.lookAt(pose.target)
	camera.updateProjectionMatrix()
	camera.updateMatrixWorld(true)
}

// Replace each subject mesh's material with an unlit flat one (true colour, plus the
// ground's paint texture if present) so the capture is shadowless reference albedo and
// the material-ID map reads cleanly.
function applyFlatMaterials(meshes) {
	const swaps = []
	for (const mesh of meshes) {
		if (!mesh.material) continue
		const original = mesh.material
		const source = Array.isArray(original) ? original[0] : original
		const color = source?.color?.clone?.() ?? new THREE.Color(0x888888)
		mesh.material = new THREE.MeshBasicMaterial({
			color,
			map: source?.map ?? null,
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

function addEdges(meshes, world) {
	const edges = []
	for (const mesh of meshes) {
		if (!mesh.geometry) continue
		const edge = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), edgeMaterial)
		edge.position.copy(mesh.position)
		edge.quaternion.copy(mesh.quaternion)
		edge.scale.copy(mesh.scale)
		edge.renderOrder = 20
		world.group.add(edge)
		edges.push(edge)
	}
	return edges
}

function captureTarget(renderer, scene, camera, target) {
	renderer.setRenderTarget(target)
	renderer.setClearColor(background, 1)
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
