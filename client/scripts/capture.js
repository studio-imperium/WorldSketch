import * as THREE from "three"

// Canonical isometric captures for TripoSplat. The current app path captures the whole
// scene in one shot; the object/floor helpers remain for loading older saved sessions.

const captureSize = 1024
const background = new THREE.Color(0x000000)
// Light edges so the silhouette reads against the black background (dark edges would
// vanish on it). The flat-material pass keeps true colours for the material-ID map.
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })

// TRUE isometric: 45° azimuth + ~35.26° elevation (the (1,1,1) view), rendered with an
// ORTHOGRAPHIC camera so all three axes are equally foreshortened and there is no
// perspective convergence. Every object is shot from this exact pose, which is the
// consistency the no-rotation seating relies on.
const ISO_THETA = Math.PI / 4 // azimuth, looking at the +X +Z corner
const ISO_PHI = Math.acos(1 / Math.sqrt(3)) // ≈54.74° polar angle from +Y (elevation ≈35.26°)
export const FRONT_THETA = ISO_THETA // azimuth subjects are captured from = the scene "front"
export const FRONT_PHI = ISO_PHI

// Keep generated guides aligned with the editor's default build view. This used to mirror
// X for older seating assumptions, which made captures come from the opposite front.
const MIRROR_CAPTURE_X = false

// Capture one object: its primitives, alone, from the true isometric camera.
export function captureObject(renderer, scene, world, object) {
	return captureSubject(renderer, scene, world, object.primitives, isoCamera(object.box))
}

// Capture the floor: just the painted ground tile, from the SAME true isometric camera
// as the objects (framing the full tile footprint) so its reconstructed "front" stays
// consistent with every other subject in the scene.
export function captureFloor(renderer, scene, world, floorMeshes = null, box = null) {
	const subject = floorMeshes ?? world.floorCaptureMeshes?.() ?? world.groundTiles ?? [world.ground]
	const targetBox = box ?? world.footprintBox?.() ?? world.floorBox()
	return captureSubject(renderer, scene, world, subject, isoCamera(targetBox))
}

// Capture the complete block-out — floor and every primitive — in ONE camera pose.
// Alongside the visual guide, optionally render a semantic ID diagram in which every
// connected object group is one artificial solid colour. The image editor uses that
// second image as an inventory/mask reference, never as appearance guidance.
export async function captureWorld(renderer, scene, world, box, objectGroups = null, viewAngles = null) {
	// An unpainted drawable sheet is void, not a floor. Excluding it here prevents the
	// image editor from receiving even an invisible floor mesh as part of the subject.
	const floor = world.groundInkBounds?.()
		? (world.floorCaptureMeshes?.() ?? world.groundTiles ?? [world.ground])
		: []
	// Whole-scene blocks are volumetric scaffolding, but the white wireframe makes the
	// actual block boundaries explicit for the image model.
	const theta = Number.isFinite(viewAngles?.theta) ? viewAngles.theta : ISO_THETA
	const phi = Number.isFinite(viewAngles?.phi) ? viewAngles.phi : ISO_PHI
	const capture = await captureSubject(renderer, scene, world, [...floor, ...world.primitives], isoCamera(box, { theta, phi }), false, true, objectGroups)
	return { ...capture, theta, phi }
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
		if ((object.userData.sky || object.userData.isSelectionOutline || object.userData.isEdgeOutline || object.userData.isDebugHelper || object.userData.isPreview || object.userData.isFront || object.userData.isGizmo) && object.visible) {
			overlays.push(object)
			object.visible = false
		}
	})

	const floorSubject = world.floorCaptureMeshes?.() ?? world.groundTiles ?? [world.ground]
	const rawSubject = [...floorSubject, ...world.primitives]
	const temporarySubjects = []
	const subject = rawSubject.map(mesh => makeGroundCaptureTop(mesh, temporarySubjects) ?? mesh)
	const rawSubjectSet = new Set(rawSubject)
	const subjectSet = new Set(subject)
	const hidden = []
	const shown = []
	for (const mesh of subject) {
		if (mesh.visible) continue
		shown.push([mesh, mesh.visible])
		mesh.visible = true
	}
	for (const mesh of [...(world.groundTiles ?? []), ...(world.groundSlopePreviews ?? [])]) {
		if (rawSubjectSet.has(mesh) && mesh.userData.isGround && !mesh.userData.isGroundSlopePreview) {
			hidden.push([mesh, mesh.visible])
			mesh.visible = false
			continue
		}
		if (subjectSet.has(mesh)) continue
		hidden.push([mesh, mesh.visible])
		mesh.visible = false
	}
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
	for (const mesh of temporarySubjects) {
		mesh.geometry.dispose()
		mesh.material.dispose()
		mesh.removeFromParent()
	}
	for (const [mesh, visible] of hidden) mesh.visible = visible
	for (const [mesh, visible] of shown) mesh.visible = visible
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
function isoCamera(box, angles = null) {
	const center = box.getCenter(new THREE.Vector3())
	const size = box.getSize(new THREE.Vector3())
	const radius = Math.max(0.3, 0.5 * Math.hypot(size.x, size.y, size.z)) // bounding-sphere radius
	const half = radius * 1.12 // frame with a small margin
	const dist = Math.max(8, radius * 6)
	const theta = Number.isFinite(angles?.theta) ? angles.theta : ISO_THETA
	const phi = Number.isFinite(angles?.phi) ? angles.phi : ISO_PHI
	const camera = new THREE.OrthographicCamera(-half, half, half, -half, Math.max(0.01, dist - radius * 4), dist + radius * 4)
	camera.up.set(0, 1, 0)
	const offset = new THREE.Vector3().setFromSpherical(new THREE.Spherical(dist, phi, theta))
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

// --- Isometric ground projection ---------------------------------------------------
// The generated ground texture is a TOP-DOWN image, but TripoSplat reconstructs far more
// reliably from the same isometric pose the objects are captured from. An orthographic
// iso view of a flat ground plane is a plain 2D affine map, so the top-down image (and
// its outpaint mask) can be projected into the iso pose — and the model's iso result
// un-projected back to top-down for the outpaint master — without touching the 3D scene.

// Affine [a,b,c,d,e,f] mapping top-down image pixels (srcW x srcH covering a cols x rows
// plot footprint; world +X = image right, +Z = image down) onto iso-view canvas pixels.
function groundIsoMatrix(cols, rows, srcW, srcH, dstW, dstH) {
	const eye = new THREE.Vector3().setFromSpherical(new THREE.Spherical(1, ISO_PHI, ISO_THETA))
	if (MIRROR_CAPTURE_X) eye.x = -eye.x // the same mirror every subject capture uses
	const right = new THREE.Vector3(0, 1, 0).cross(eye).normalize() // camera X in world space
	const up = new THREE.Vector3().crossVectors(eye, right) // camera Y (screen up) in world space
	const kx = cols / srcW // world-units-per-pixel; only the cols:rows aspect matters
	const kz = rows / srcH
	// Projected extents of the footprint rectangle -> scale that fits it with a small margin.
	const uExt = Math.abs(cols * right.x) + Math.abs(rows * right.z)
	const vExt = Math.abs(cols * up.x) + Math.abs(rows * up.z)
	const k = 0.96 * Math.min(dstW / uExt, dstH / vExt)
	const a = k * right.x * kx
	const b = -k * up.x * kx // canvas Y grows down, screen-up grows up
	const c = k * right.z * kz
	const d = -k * up.z * kz
	return [a, b, c, d, dstW / 2 - (a * srcW + c * srcH) / 2, dstH / 2 - (b * srcW + d * srcH) / 2]
}

// Top-down ground image -> iso view on a pure black background (the pose Tripo expects).
export function projectGroundIso(source, cols, rows, dstW, dstH) {
	const canvas = document.createElement("canvas")
	canvas.width = dstW
	canvas.height = dstH
	const ctx = canvas.getContext("2d")
	ctx.fillStyle = "#000"
	ctx.fillRect(0, 0, dstW, dstH)
	ctx.setTransform(...groundIsoMatrix(cols, rows, source.width, source.height, dstW, dstH))
	ctx.drawImage(source, 0, 0)
	return canvas
}

// Outpaint mask, same projection. Mask semantics: OPAQUE = preserve, TRANSPARENT = repaint.
// Everything OUTSIDE the projected plot stays opaque so the model leaves the black
// surround alone; inside, the source mask's keep/repaint regions map through unchanged.
export function projectGroundMaskIso(mask, cols, rows, dstW, dstH) {
	const canvas = document.createElement("canvas")
	canvas.width = dstW
	canvas.height = dstH
	const ctx = canvas.getContext("2d")
	ctx.fillStyle = "#fff"
	ctx.fillRect(0, 0, dstW, dstH)
	ctx.setTransform(...groundIsoMatrix(cols, rows, mask.width, mask.height, dstW, dstH))
	ctx.clearRect(0, 0, mask.width, mask.height) // punch out the plot, then let the mask fill it back
	ctx.drawImage(mask, 0, 0)
	return canvas
}

// Iso ground image -> top-down (the inverse affine), for the outpaint master composite.
export function unprojectGroundIso(source, cols, rows, dstW, dstH) {
	const canvas = document.createElement("canvas")
	canvas.width = dstW
	canvas.height = dstH
	const ctx = canvas.getContext("2d")
	const m = groundIsoMatrix(cols, rows, dstW, dstH, source.width, source.height)
	ctx.setTransform(new DOMMatrix(m).inverse())
	ctx.drawImage(source, 0, 0)
	return canvas
}

// Render a guide (optionally with edge lines) + a flat material-ID map of `subject` alone, on a
// black background, with the dedicated `view` camera. Everything else — other block-out
// meshes, all splats, the sky dome, outlines, helpers, the placement preview — is hidden
// so Tripo only sees the subject on black. The shared scene camera is never touched.
function makeGroundCaptureTop(mesh, temporarySubjects) {
	// Ground tiles are thin boxes for editor picking, but generation captures need only
	// the painted TOP surface. If the side/back faces keep the same paint texture, an
	// isometric capture can show a second projected copy of the floor behind the real one.
	if (!mesh?.userData?.isGround || mesh.userData.isGroundSlopePreview) return null
	const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
	const material = new THREE.MeshBasicMaterial({
		color: source?.color?.clone?.() ?? new THREE.Color(0xffffff),
		map: source?.map ?? null,
		side: THREE.DoubleSide,
		depthTest: true,
		depthWrite: true,
		alphaTest: source?.alphaTest ?? 0,
	})
	const top = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
	top.name = `${mesh.name || mesh.userData.id || "ground"}_capture_top`
	top.position.copy(mesh.position)
	top.position.y += Math.abs(mesh.scale.y) * 0.5 + 0.002
	top.rotation.copy(mesh.rotation)
	top.rotateX(-Math.PI / 2)
	top.scale.set(mesh.scale.x, mesh.scale.z, 1)
	top.userData = { ...mesh.userData, isGroundCaptureTop: true }
	mesh.parent?.add(top)
	temporarySubjects.push(top)
	return top
}

async function captureSubject(renderer, scene, world, subject, view, includeMaterialMap = true, includeEdges = true, semanticGroups = null) {
	const target = new THREE.WebGLRenderTarget(captureSize, captureSize, { colorSpace: THREE.SRGBColorSpace })
	const temporarySubjects = []
	const normalizedSubject = subject.map(mesh => makeGroundCaptureTop(mesh, temporarySubjects) ?? mesh)
	const originalSubjectSet = new Set(subject)
	const subjectSet = new Set(normalizedSubject)

	const hidden = []
	const shown = []
	for (const mesh of normalizedSubject) {
		if (mesh.visible) continue
		shown.push([mesh, mesh.visible])
		mesh.visible = true
	}
	for (const mesh of world.allBlockoutMeshes()) {
		if (originalSubjectSet.has(mesh)) {
			if (mesh.userData.isGround) {
				hidden.push([mesh, mesh.visible])
				mesh.visible = false
			}
			continue
		}
		hidden.push([mesh, mesh.visible])
		mesh.visible = false
	}
	for (const mesh of world.groundSlopePreviews ?? []) {
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
		if ((object.userData.sky || object.userData.isSelectionOutline || object.userData.isEdgeOutline || object.userData.isDebugHelper || object.userData.isPreview || object.userData.isFront || object.userData.isGizmo) && object.visible) {
			overlays.push(object)
			object.visible = false
		}
	})

	const swaps = applyFlatMaterials(normalizedSubject)
	const prevClear = renderer.getClearColor(new THREE.Color()).clone()
	const prevAlpha = renderer.getClearAlpha()

	const edges = includeEdges ? addEdges(normalizedSubject, world) : []
	const guide = await captureTarget(renderer, scene, view, target)
	for (const edge of edges) {
		edge.geometry.dispose()
		edge.removeFromParent()
	}
	const materialMap = includeMaterialMap ? await captureTarget(renderer, scene, view, target) : null
	const semanticMap = semanticGroups?.length
		? await captureSemanticMap(renderer, scene, view, target, swaps, semanticGroups)
		: null

	restoreMaterials(swaps)
	for (const mesh of temporarySubjects) {
		mesh.geometry.dispose()
		mesh.material.dispose()
		mesh.removeFromParent()
	}
	for (const object of overlays) object.visible = true
	if (spark) spark.visible = sparkVisible
	for (const [mesh, visible] of hidden) mesh.visible = visible
	for (const [mesh, visible] of shown) mesh.visible = visible
	renderer.setClearColor(prevClear, prevAlpha)
	target.dispose()
	return { guide, materialMap, semanticMap }
}

// Render each logical object in one unmistakable flat ID colour. Ground is deliberately
// left in its original flat material so its painted alpha silhouette remains exact; only
// the bright artificial colours are object IDs. This is a diagram, not a texture source.
async function captureSemanticMap(renderer, scene, view, target, swaps, groups) {
	const groupOf = new Map()
	groups.forEach((group, id) => group.primitives.forEach(mesh => groupOf.set(mesh, id)))
	const restore = []
	for (const [mesh, _original, temporary] of swaps) {
		const id = groupOf.get(mesh)
		restore.push([temporary, temporary.color.clone(), temporary.map, temporary.alphaTest])
		if (id == null) {
			// Keep the ground texture attached so its transparent painted outline survives,
			// but tint it dark so it cannot be confused with a bright object ID.
			temporary.color.setHex(0x303030)
			temporary.needsUpdate = true
			continue
		}
		// Golden-ratio hue stepping keeps IDs distinct without repeating when a manual
		// block-out contains more objects than a small fixed palette could represent.
		temporary.color.setHSL((0.96 + id * 0.61803398875) % 1, 1, id % 2 ? 0.48 : 0.62)
		temporary.map = null
		temporary.alphaTest = 0
		temporary.needsUpdate = true
	}
	const result = await captureTarget(renderer, scene, view, target)
	for (const [material, color, map, alphaTest] of restore) {
		material.color.copy(color)
		material.map = map
		material.alphaTest = alphaTest
		material.needsUpdate = true
	}
	return result
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
			// The drawable ground sheet clips its undrawn (transparent) texels — carry the
			// alpha test so the capture shows the painted silhouette on pure black, not a
			// giant opaque square.
			alphaTest: source?.alphaTest ?? 0,
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
		// EdgesGeometry knows only the sheet's outer box, not the alpha-painted ground
		// silhouette. Outlining it drew a large white diamond even when the sheet was empty.
		if (!mesh.geometry || mesh.userData.isGroundSlopePreview || mesh.userData.isGroundSheet) continue
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
