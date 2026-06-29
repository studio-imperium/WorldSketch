import * as THREE from "three"

// Per-subject capture for modular world generation. Each object (and the floor) is
// photographed ALONE on a pure-black background from a fixed pose, so TripoSplat lands
// it in a consistent orientation and the client can seat it by bounding box alone.

const captureSize = 1024
const background = new THREE.Color(0x000000)
// Light edges so the silhouette reads against the black background (dark edges would
// vanish on it). The flat-material pass keeps true colours for the material-ID map.
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xdcdcdc, transparent: true, opacity: 0.85 })

// TRUE isometric: 45° azimuth + ~35.26° elevation (the (1,1,1) view), rendered with an
// ORTHOGRAPHIC camera so all three axes are equally foreshortened and there is no
// perspective convergence. Every object is shot from this exact pose, which is the
// consistency the no-rotation seating relies on.
const ISO_THETA = Math.PI / 4 // azimuth, looking at the +X +Z corner
const ISO_PHI = Math.acos(1 / Math.sqrt(3)) // ≈54.74° polar angle from +Y (elevation ≈35.26°)
export const FRONT_THETA = ISO_THETA // azimuth subjects are captured from = the scene "front"
export const FRONT_PHI = ISO_PHI

// Mirror every subject capture across X (negates the camera's X position), so the guide —
// and therefore the reconstructed splat — comes out left-right flipped. Flat materials are
// DoubleSide so this never causes back-face culling.
const MIRROR_CAPTURE_X = true

// Capture one object: its primitives, alone, from the true isometric camera.
export function captureObject(renderer, scene, world, object) {
	return captureSubject(renderer, scene, world, object.primitives, isoCamera(object.box))
}

// Capture the floor: just the painted ground tile, from the SAME true isometric camera
// as the objects (framing the full tile footprint) so its reconstructed "front" stays
// consistent with every other subject in the scene.
export function captureFloor(renderer, scene, world) {
	return captureSubject(renderer, scene, world, [world.ground], isoCamera(world.floorBox()))
}

// Capture the WHOLE world in context (every block-out object + the painted floor) from
// the isometric front, with a bright numbered marker on each object in `objects`. Used by
// the identification phase so a VLM can name each object WITH full scene context (a
// boulder among trees reads as a boulder). Returns one PNG blob with the numbers baked in.
export async function captureWorldContext(renderer, scene, world, objects) {
	const view = worldCamera(world, objects)
	const target = new THREE.WebGLRenderTarget(captureSize, captureSize, { colorSpace: THREE.SRGBColorSpace })

	// Show every block-out mesh (context is the point); hide splats, sky, overlays.
	const spark = scene.userData.sparkRenderer
	const sparkVisible = spark?.visible
	if (spark) spark.visible = false
	const overlays = []
	scene.traverse(object => {
		if ((object.userData.sky || object.userData.isSelectionOutline || object.userData.isDebugHelper || object.userData.isPreview || object.userData.isFront) && object.visible) {
			overlays.push(object)
			object.visible = false
		}
	})

	const subject = world.allBlockoutMeshes()
	const swaps = applyFlatMaterials(subject)
	const prevClear = renderer.getClearColor(new THREE.Color()).clone()
	const prevAlpha = renderer.getClearAlpha()
	const edges = addEdges(subject, world)

	renderer.setRenderTarget(target)
	renderer.setClearColor(background, 1)
	renderer.clear()
	renderer.render(scene, view)
	const pixels = new Uint8Array(captureSize * captureSize * 4)
	renderer.readRenderTargetPixels(target, 0, 0, captureSize, captureSize, pixels)
	renderer.setRenderTarget(null)

	for (const edge of edges) {
		edge.geometry.dispose()
		edge.removeFromParent()
	}
	restoreMaterials(swaps)
	for (const object of overlays) object.visible = true
	if (spark) spark.visible = sparkVisible
	renderer.setClearColor(prevClear, prevAlpha)
	target.dispose()

	// Project each object's TOP-centre to pixel coords (view.matrixWorldInverse was just
	// refreshed by the render above), then lift the marker above the object so the number
	// points at it without covering it.
	const c = new THREE.Vector3()
	const lift = captureSize * 0.045
	const marks = objects.map((object, i) => {
		object.box.getCenter(c)
		c.y = object.box.max.y // top of the object
		c.project(view)
		const x = (c.x * 0.5 + 0.5) * captureSize
		const y = Math.max(captureSize * 0.04, (-c.y * 0.5 + 0.5) * captureSize - lift)
		return { n: i + 1, x, y }
	})
	return pixelsToNumberedBlob(pixels, marks)
}

// A true isometric (orthographic) camera framing `box`. Distance only sets the clip
// range (orthographic projection is scale-independent of distance); the frustum is
// sized to the box's bounding sphere so the whole object fits with a small margin.
function isoCamera(box) {
	const center = box.getCenter(new THREE.Vector3())
	const size = box.getSize(new THREE.Vector3())
	const radius = Math.max(0.3, 0.5 * Math.hypot(size.x, size.y, size.z)) // bounding-sphere radius
	const half = radius * 1.12 // frame with a small margin
	const dist = Math.max(8, radius * 6)
	const camera = new THREE.OrthographicCamera(-half, half, half, -half, Math.max(0.01, dist - radius * 4), dist + radius * 4)
	camera.up.set(0, 1, 0)
	const offset = new THREE.Vector3().setFromSpherical(new THREE.Spherical(dist, ISO_PHI, ISO_THETA))
	if (MIRROR_CAPTURE_X) offset.x = -offset.x // mirror the viewpoint across X
	camera.position.copy(center).add(offset)
	camera.lookAt(center)
	camera.updateProjectionMatrix()
	camera.updateMatrixWorld(true)
	return camera
}

// A true isometric (orthographic) camera framing the OBJECTS (their union box) with a
// generous margin so the objects read clearly for identification while still showing the
// surrounding floor for context. Falls back to the whole floor if there are no objects.
function worldCamera(world, objects) {
	const box = new THREE.Box3()
	for (const object of objects) box.union(object.box)
	if (box.isEmpty()) {
		box.set(new THREE.Vector3(-world.size / 2, 0, -world.size / 2), new THREE.Vector3(world.size / 2, 0.05, world.size / 2))
	}
	const center = box.getCenter(new THREE.Vector3())
	const size = box.getSize(new THREE.Vector3())
	const radius = Math.max(1.5, 0.5 * Math.hypot(size.x, size.y, size.z))
	const half = radius * 1.6 // margin around the objects: they stay prominent, floor still shows
	const dist = Math.max(10, radius * 6)
	const camera = new THREE.OrthographicCamera(-half, half, half, -half, Math.max(0.01, dist - radius * 4), dist + radius * 4)
	camera.up.set(0, 1, 0)
	camera.position.copy(center).add(new THREE.Vector3().setFromSpherical(new THREE.Spherical(dist, ISO_PHI, ISO_THETA)))
	camera.lookAt(center)
	camera.updateProjectionMatrix()
	camera.updateMatrixWorld(true)
	return camera
}

// Render a guide (with edge lines) + a flat material-ID map of `subject` alone, on a
// black background, with the dedicated `view` camera. Everything else — other block-out
// meshes, all splats, the sky dome, outlines, helpers, the placement preview — is hidden
// so Tripo only sees the subject on black. The shared scene camera is never touched.
async function captureSubject(renderer, scene, world, subject, view) {
	const target = new THREE.WebGLRenderTarget(captureSize, captureSize, { colorSpace: THREE.SRGBColorSpace })
	const subjectSet = new Set(subject)

	const hidden = []
	for (const mesh of world.allBlockoutMeshes()) {
		if (subjectSet.has(mesh)) continue
		hidden.push([mesh, mesh.visible])
		mesh.visible = false
	}

	// Hide every generated splat (the SparkRenderer draws them all).
	const spark = scene.userData.sparkRenderer
	const sparkVisible = spark?.visible
	if (spark) spark.visible = false

	// Hide the sky dome + any overlays so the background reads as pure black.
	const overlays = []
	scene.traverse(object => {
		if ((object.userData.sky || object.userData.isSelectionOutline || object.userData.isDebugHelper || object.userData.isPreview || object.userData.isFront) && object.visible) {
			overlays.push(object)
			object.visible = false
		}
	})

	const swaps = applyFlatMaterials(subject)
	const prevClear = renderer.getClearColor(new THREE.Color()).clone()
	const prevAlpha = renderer.getClearAlpha()

	const edges = addEdges(subject, world)
	const guide = await captureTarget(renderer, scene, view, target)
	for (const edge of edges) {
		edge.geometry.dispose()
		edge.removeFromParent()
	}
	const materialMap = await captureTarget(renderer, scene, view, target)

	restoreMaterials(swaps)
	for (const object of overlays) object.visible = true
	if (spark) spark.visible = sparkVisible
	for (const [mesh, visible] of hidden) mesh.visible = visible
	renderer.setClearColor(prevClear, prevAlpha)
	target.dispose()
	return { guide, materialMap }
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

// Like pixelsToBlob, but stamps a bright numbered circle at each mark so the VLM can tie
// its labels back to our object indices.
function pixelsToNumberedBlob(pixels, marks) {
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

	const r = Math.round(captureSize * 0.03)
	context.font = `bold ${Math.round(r * 1.4)}px sans-serif`
	context.textAlign = "center"
	context.textBaseline = "middle"
	context.lineWidth = Math.max(2, r * 0.2)
	for (const mark of marks) {
		context.beginPath()
		context.arc(mark.x, mark.y, r, 0, Math.PI * 2)
		context.fillStyle = "#ff2d78"
		context.fill()
		context.strokeStyle = "#ffffff"
		context.stroke()
		context.fillStyle = "#ffffff"
		context.fillText(String(mark.n), mark.x, mark.y)
	}
	return new Promise(resolve => canvas.toBlob(resolve, "image/png"))
}
