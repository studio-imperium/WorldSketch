import * as THREE from "three"
import { createOrbit } from "/scripts/controls.js"
import { generateScene } from "/scripts/api.js"
import { captureViews } from "/scripts/capture.js"
import { createPrimitive, round, serializePrimitive } from "/scripts/primitives.js"
import { createSky } from "/scripts/sky.js"

const root = document.getElementById("canvas")
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 200)
const renderer = new THREE.WebGLRenderer({ antialias: true })
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const dragPlane = new THREE.Plane()
const surfaceNormal = new THREE.Vector3(0, 1, 0)
const placementNormal = new THREE.Vector3()
const placementPoint = new THREE.Vector3()
const placementAnchor = new THREE.Vector3()
const localHitPoint = new THREE.Vector3()
const localFaceCenter = new THREE.Vector3()
const localFaceNormal = new THREE.Vector3()
const localUp = new THREE.Vector3(0, 1, 0)
const normalMatrix = new THREE.Matrix3()
const scaleCenterScreen = new THREE.Vector2()
const screenProjection = new THREE.Vector3()
const scaleNormal = new THREE.Vector3()
const rotationPlane = new THREE.Plane()
const rotationStartPoint = new THREE.Vector3()
const rotationPoint = new THREE.Vector3()
const rotationStartVector = new THREE.Vector3()
const rotationVector = new THREE.Vector3()
const rotationBasisA = new THREE.Vector3()
const rotationBasisB = new THREE.Vector3()
const rotationAxisVector = new THREE.Vector3()
const rotationDelta = new THREE.Quaternion()
const primitives = []
const defaultSurfaceY = 0
const selectionOutlineColor = 0xb8ff38
const shapeTools = new Set(["box", "sphere", "cylinder", "cone"])
const rotationAxes = {
	x: new THREE.Vector3(1, 0, 0),
	y: new THREE.Vector3(0, 1, 0),
	z: new THREE.Vector3(0, 0, 1),
}

let selected = null
let nextId = 1
let activeTool = "pointer"
let activeColor = "#232323"
let primitiveDrag = null
let placementPreview = null
let rotationGizmo = null
const rollQuat = new THREE.Quaternion()
const rollAxis = new THREE.Vector3()
const selectionOutlineName = "selection_outline"

renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setClearColor(0xeef5f2, 1)
root.appendChild(renderer.domElement)

camera.position.set(5, 4, 7)

const orbit = createOrbit(renderer.domElement, camera)
const group = new THREE.Group()
scene.add(group)
const sky = createSky()
scene.add(sky)

scene.add(new THREE.HemisphereLight(0xffffff, 0x3b3228, 2.2))

const sun = new THREE.DirectionalLight(0xffffff, 2.4)
sun.position.set(4, 7, 3)
scene.add(sun)

const bounds = new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 5, 10))

const els = {
	status: document.getElementById("status"),
	toolButtons: [...document.querySelectorAll("[data-tool]")],
	colorSwatches: [...document.querySelectorAll("[data-color]")],
	generate: document.getElementById("generate_btn"),
	viewSplat: document.getElementById("view_splat_btn"),
	download: document.getElementById("download_btn"),
	downloadPly: document.getElementById("download_ply_btn"),
	downloadCollision: document.getElementById("download_collision_btn"),
	downloadBundle: document.getElementById("download_bundle_btn"),
	generateModal: document.getElementById("generate_modal"),
	generateForm: document.getElementById("generate_form"),
	cancelGenerate: document.getElementById("cancel_generate_btn"),
	scenePrompt: document.getElementById("scene_prompt"),
	worldTile: document.getElementById("world_tile"),
	worldPreview: document.getElementById("world_preview"),
	worldSpinner: document.getElementById("world_spinner"),
	worldStatus: document.getElementById("world_status"),
}

function setActiveTool(tool) {
	activeTool = tool
	for (const button of els.toolButtons) {
		button.classList.toggle("active", button.dataset.tool === tool)
	}
	renderer.domElement.classList.toggle("is-pointer", tool === "pointer")
	renderer.domElement.classList.toggle("is-eraser", tool === "eraser")
	renderer.domElement.classList.toggle("is-placing", isShapeTool(tool))
	renderer.domElement.classList.toggle("is-scaling", tool === "scale")
	renderer.domElement.classList.toggle("is-rotating", tool === "rotate")
	syncPlacementPreview()
	syncRotationGizmo()
}

function addPrimitive(type, seed) {
	const id = seed?.id ?? `prim_${String(nextId++).padStart(3, "0")}`
	const mesh = createPrimitive(type, id, seed ?? { color: activeColor })
	// A seeded (duplicated/loaded) piece that's already rotated stays angled too.
	if (seed?.rotation?.some(value => value !== 0)) mesh.userData.manualRotation = true
	group.add(mesh)
	primitives.push(mesh)
	select(mesh)
}

function isShapeTool(tool) {
	return shapeTools.has(tool)
}

function syncPlacementPreview() {
	if (!isShapeTool(activeTool)) {
		clearPlacementPreview()
		return
	}

	if (placementPreview?.userData.type === activeTool) return
	clearPlacementPreview()
	placementPreview = createPrimitive(activeTool, "placement_preview", { color: activeColor })
	placementPreview.userData.isPlacementPreview = true
	placementPreview.material.transparent = true
	placementPreview.material.opacity = 0.44
	placementPreview.material.depthWrite = false
	placementPreview.visible = false
	group.add(placementPreview)
}

function clearPlacementPreview() {
	if (!placementPreview) return
	placementPreview.geometry.dispose()
	placementPreview.material.dispose()
	placementPreview.removeFromParent()
	placementPreview = null
}

function updatePlacementPreview(event) {
	if (!placementPreview) return false
	if (!placementPositionFromPointer(event, placementPreview, placementPoint)) {
		placementPreview.visible = false
		return false
	}

	placementPreview.position.copy(placementPoint)
	placementPreview.visible = true
	return true
}

function placeActiveShape(event) {
	if (!isShapeTool(activeTool)) return false
	if (!placementPreview) syncPlacementPreview()
	if (!updatePlacementPreview(event)) return true
	addPrimitive(activeTool, {
		type: activeTool,
		position: placementPreview.position.toArray(),
		rotation: [placementPreview.rotation.x, placementPreview.rotation.y, placementPreview.rotation.z],
		scale: placementPreview.scale.toArray(),
		color: activeColor,
	})
	syncPlacementPreview()
	return true
}

function select(mesh) {
	if (selected) {
		selected.material.emissive.set(0x000000)
		clearSelectionOutline(selected)
	}
	selected = mesh
	if (selected) addSelectionOutline(selected)
	syncSelectionUi()
	syncRotationGizmo()
}

function syncRotationGizmo() {
	// The rotate tool uses a drag-to-roll interaction (createRollDrag), not a gizmo.
	clearRotationGizmo()
}

// Rotation is always a roll around the line from the camera to the object: dragging
// twists the piece about that view axis, and you choose which world axis it is by
// where you stand (look from straight above → the axis is vertical → you change yaw).
function objectScreenPosition(mesh) {
	const ndc = mesh.position.clone().project(camera)
	const rect = renderer.domElement.getBoundingClientRect()
	return {
		x: rect.left + (ndc.x * 0.5 + 0.5) * rect.width,
		y: rect.top + (-ndc.y * 0.5 + 0.5) * rect.height,
	}
}

function pointerScreenAngle(event, center) {
	return Math.atan2(event.clientY - center.y, event.clientX - center.x)
}

function createRollDrag(event, mesh) {
	return {
		pointerId: event.pointerId,
		mode: "roll",
		axis: rollAxis.copy(mesh.position).sub(camera.position).normalize().clone(),
		center: objectScreenPosition(mesh),
		startAngle: pointerScreenAngle(event, objectScreenPosition(mesh)),
		startQuaternion: mesh.quaternion.clone(),
	}
}

function updateRollDrag(event) {
	const delta = pointerScreenAngle(event, primitiveDrag.center) - primitiveDrag.startAngle
	rollQuat.setFromAxisAngle(primitiveDrag.axis, delta)
	selected.quaternion.copy(rollQuat).multiply(primitiveDrag.startQuaternion)
	selected.userData.manualRotation = true // now an angled piece — keep its angle when snapping
}

function createRotationGizmo() {
	const gizmo = new THREE.Group()
	const rings = [
		{ axis: "x", color: 0xff5f57, rotation: [0, Math.PI / 2, 0] },
		{ axis: "y", color: 0x4cc26f, rotation: [Math.PI / 2, 0, 0] },
		{ axis: "z", color: 0x4ba3ff, rotation: [0, 0, 0] },
	]

	for (const ring of rings) {
		const mesh = new THREE.Mesh(
			new THREE.TorusGeometry(1, 0.03, 8, 96),
			new THREE.MeshBasicMaterial({
				color: ring.color,
				depthTest: false,
				depthWrite: false,
				transparent: true,
				opacity: 0.9,
			})
		)
		mesh.rotation.set(...ring.rotation)
		mesh.renderOrder = 12000
		mesh.userData.rotationAxis = ring.axis
		gizmo.add(mesh)
	}

	return gizmo
}

function clearRotationGizmo() {
	if (!rotationGizmo) return
	rotationGizmo.removeFromParent()
	rotationGizmo.traverse(child => {
		if (child.geometry) child.geometry.dispose()
		if (child.material) child.material.dispose()
	})
	rotationGizmo = null
}

function updateRotationGizmo() {
	if (!rotationGizmo || !selected) return
	const bounds = primitiveGeometryBounds(selected)
	const size = Math.max(
		bounds.max.x - bounds.min.x,
		bounds.max.y - bounds.min.y,
		bounds.max.z - bounds.min.z
	)
	const scaledSize = size * Math.max(Math.abs(selected.scale.x), Math.abs(selected.scale.y), Math.abs(selected.scale.z))
	const radius = Math.max(0.75, scaledSize * 0.85)
	rotationGizmo.position.copy(selected.position)
	rotationGizmo.scale.setScalar(radius)
}

function addSelectionOutline(mesh) {
	clearSelectionOutline(mesh)
	const outline = new THREE.Group()
	const silhouette = new THREE.Mesh(
		mesh.geometry,
		new THREE.MeshBasicMaterial({
			color: selectionOutlineColor,
			side: THREE.BackSide,
			depthWrite: false,
		})
	)
	const edges = new THREE.LineSegments(
		new THREE.EdgesGeometry(mesh.geometry, 18),
		new THREE.LineBasicMaterial({
			color: selectionOutlineColor,
			depthWrite: false,
		})
	)
	outline.name = selectionOutlineName
	outline.userData.isSelectionOutline = true
	silhouette.scale.setScalar(1.045)
	edges.renderOrder = 10000
	outline.add(silhouette, edges)
	mesh.add(outline)
}

function clearSelectionOutline(mesh) {
	const outline = mesh.getObjectByName(selectionOutlineName)
	if (!outline) return
	outline.traverse(child => {
		if (child.material) child.material.dispose()
		if (child.geometry && child.geometry !== mesh.geometry) child.geometry.dispose()
	})
	outline.removeFromParent()
}

function syncSelectionUi() {
	syncColorPalette()
}

function syncColorPalette() {
	const selectedColor = selected ? `#${selected.material.color.getHexString()}` : activeColor
	for (const swatch of els.colorSwatches) {
		swatch.classList.toggle("active", swatch.dataset.color.toLowerCase() === selectedColor)
	}
}

function applyColor(color) {
	activeColor = color
	if (selected) selected.material.color.set(color)
	if (placementPreview) placementPreview.material.color.set(color)
	syncColorPalette()
}

function removePrimitive(mesh) {
	if (mesh.userData.locked) return
	const index = primitives.indexOf(mesh)
	if (index >= 0) primitives.splice(index, 1)
	clearSelectionOutline(mesh)
	mesh.geometry.dispose()
	mesh.material.dispose()
	mesh.removeFromParent()
	if (selected === mesh) selected = null
	syncSelectionUi()
	syncRotationGizmo()
}

function removeSelected() {
	if (!selected) return
	removePrimitive(selected)
}

function duplicateSelected() {
	if (!selected) return
	const copy = serializePrimitive(selected)
	copy.id = `prim_${String(nextId++).padStart(3, "0")}`
	copy.position[0] += 0.4
	copy.position[2] += 0.4
	addPrimitive(copy.type, copy)
}

function clearScene() {
	for (const primitive of [...primitives]) {
		if (primitive.userData.locked) continue
		clearSelectionOutline(primitive)
		primitive.geometry.dispose()
		primitive.material.dispose()
		primitive.removeFromParent()
	}
	for (let index = primitives.length - 1; index >= 0; index--) {
		if (!primitives[index].userData.locked) primitives.splice(index, 1)
	}
	selected = null
	syncSelectionUi()
	syncRotationGizmo()
}

function serializeScene(prompt = "") {
	return {
		version: 1,
		prompt,
		bounds: {
			min: [-10, 0, -10],
			max: [10, 5, 10],
		},
		primitives: primitives.map(serializePrimitive),
	}
}

function setStatus(message) {
	els.status.textContent = message
	els.status.classList.toggle("hidden", !message)
	if (!els.worldTile.classList.contains("hidden") && els.worldTile.classList.contains("is-loading")) {
		els.worldStatus.textContent = compactStatus(message)
	}
}

function compactStatus(message) {
	if (!message) return "LOADING"
	if (message.includes(":")) return "ERROR"
	if (message.toLowerCase().includes("capturing")) return "CAPTURE"
	if (message.toLowerCase().includes("queued")) return "QUEUED"
	if (message.toLowerCase().includes("generating")) return "IMAGES"
	if (message.toLowerCase().includes("depth")) return "DEPTH"
	if (message.toLowerCase().includes("fusing")) return "FUSING"
	if (message.toLowerCase().includes("training")) return "SPLAT"
	return "LOADING"
}

function showWorldLoading() {
	els.worldTile.classList.remove("hidden")
	els.worldTile.classList.add("is-loading")
	els.worldTile.disabled = true
	els.worldPreview.classList.add("hidden")
	els.worldPreview.removeAttribute("src")
	els.worldSpinner.classList.remove("hidden")
	els.worldStatus.textContent = "LOADING"
}

function showWorldResult(job) {
	els.worldTile.classList.remove("is-loading")
	els.worldTile.disabled = false
	els.worldSpinner.classList.add("hidden")
	els.worldStatus.textContent = ""
	if (job.previewUrl) {
		els.worldPreview.src = job.previewUrl
		els.worldPreview.classList.remove("hidden")
	} else {
		els.worldStatus.textContent = "READY"
	}
}

function showWorldError(message) {
	els.worldTile.classList.remove("is-loading")
	els.worldTile.disabled = true
	els.worldSpinner.classList.add("hidden")
	els.worldPreview.classList.add("hidden")
	els.worldStatus.textContent = "ERROR"
	setStatus(message)
}

function clickDownload(link) {
	if (!link.href || link.href.endsWith("#")) return
	link.click()
}

function downloadWorld() {
	clickDownload(els.downloadCollision)
	clickDownload(els.downloadPly)
	clickDownload(els.downloadBundle)
}

async function generate(prompt) {
	if (!primitives.some(primitive => !primitive.userData.locked)) {
		setStatus("Add at least one primitive.")
		return
	}

	els.generate.disabled = true
	showWorldLoading()
	els.viewSplat.classList.add("hidden")
	els.download.classList.add("hidden")
	els.downloadPly.classList.add("hidden")
	els.downloadCollision.classList.add("hidden")
	els.downloadBundle.classList.add("hidden")
	setStatus("Capturing views")

	try {
		const captureSubjects = primitives
		const views = await captureViews(renderer, scene, camera, [placementPreview, rotationGizmo].filter(Boolean), selected, captureSubjects)
		const job = await generateScene(serializeScene(prompt), views, setStatus)
		if (job.plyUrl) els.downloadPly.href = job.plyUrl
		if (job.collisionUrl) els.downloadCollision.href = job.collisionUrl
		if (job.bundleUrl) els.downloadBundle.href = job.bundleUrl
		if (job.splatUrl) {
			els.viewSplat.href = `/splat-viewer.html?src=${encodeURIComponent(job.splatUrl)}&collisions=${encodeURIComponent(job.collisionUrl)}`
			els.download.href = job.splatUrl
			els.viewSplat.classList.remove("hidden")
			els.download.classList.remove("hidden")
		}
		els.downloadPly.classList.toggle("hidden", !job.plyUrl)
		els.downloadCollision.classList.toggle("hidden", !job.collisionUrl)
		els.downloadBundle.classList.toggle("hidden", !job.bundleUrl)
		showWorldResult(job)
		els.generate.disabled = false
	} catch (err) {
		showWorldError(err.message)
		els.generate.disabled = false
	}
}

for (const button of document.querySelectorAll("[data-tool]")) {
	button.addEventListener("click", () => setActiveTool(button.dataset.tool))
}

for (const swatch of els.colorSwatches) {
	swatch.addEventListener("click", () => applyColor(swatch.dataset.color))
}

els.generate.addEventListener("click", () => {
	els.generateModal.showModal()
	els.scenePrompt.focus()
})

els.cancelGenerate.addEventListener("click", () => els.generateModal.close())

els.generateForm.addEventListener("submit", (event) => {
	event.preventDefault()
	const prompt = els.scenePrompt.value.trim()
	els.generateModal.close()
	generate(prompt)
})

els.worldTile.addEventListener("click", () => {
	if (els.worldTile.disabled || els.worldTile.classList.contains("is-loading")) return
	downloadWorld()
})

renderer.domElement.addEventListener("pointerdown", (event) => {
	if (activeTool === "eraser" || isShapeTool(activeTool)) return

	// Dragging empty space orbits — with the rotate tool that's how you reposition to
	// choose the roll axis (e.g. look from above to roll about the vertical / yaw).
	const hit = hitPrimitive(event)
	if (!hit || hit.userData.locked) return

	event.preventDefault()
	event.stopImmediatePropagation()
	renderer.domElement.setPointerCapture(event.pointerId)
	select(hit)
	if (activeTool === "rotate") {
		primitiveDrag = createRollDrag(event, selected) // roll only — no translation
	} else if (activeTool === "scale") {
		primitiveDrag = createScaleDrag(event, selected)
	} else {
		primitiveDrag = { pointerId: event.pointerId, mode: "move" }
	}
	// Track pointer travel so a real transform deselects on release, but a plain
	// click-to-select (which also opens a move drag) keeps the piece selected.
	primitiveDrag.startClientX = event.clientX
	primitiveDrag.startClientY = event.clientY
	primitiveDrag.transformed = false
	renderer.domElement.classList.add("is-dragging")
}, { capture: true })

renderer.domElement.addEventListener("pointermove", (event) => {
	if (isShapeTool(activeTool)) updatePlacementPreview(event)
	if (!primitiveDrag || event.pointerId !== primitiveDrag.pointerId || !selected) return
	event.preventDefault()
	event.stopImmediatePropagation()
	if (Math.abs(event.clientX - primitiveDrag.startClientX) + Math.abs(event.clientY - primitiveDrag.startClientY) > 3) {
		primitiveDrag.transformed = true
	}
	if (primitiveDrag.mode === "scale") {
		updateScaleDrag(event)
		return
	}
	if (primitiveDrag.mode === "roll") {
		updateRollDrag(event)
		return
	}
	if (!placementPositionFromPointer(event, selected, placementPoint, selected)) return
	selected.position.copy(placementPoint)
	updateRotationGizmo()
}, { capture: true })

renderer.domElement.addEventListener("pointerup", (event) => {
	if (!primitiveDrag || event.pointerId !== primitiveDrag.pointerId) return
	event.preventDefault()
	event.stopImmediatePropagation()
	const transformed = primitiveDrag.transformed
	primitiveDrag = null
	renderer.domElement.classList.remove("is-dragging")
	renderer.domElement.releasePointerCapture(event.pointerId)
	if (transformed) select(null) // deselect after an actual move/scale/rotate
}, { capture: true })

renderer.domElement.addEventListener("pointerup", (event) => {
	if (primitiveDrag) return
	if (orbit.moved()) return
	if (placeActiveShape(event)) return
	const hit = hitPrimitive(event)
	if (activeTool === "eraser") {
		if (hit && !hit.userData.locked) removePrimitive(hit)
		return
	}
	select(hit)
})

function hitPrimitive(event) {
	pointerFromEvent(event)
	raycaster.setFromCamera(pointer, camera)
	const hits = raycaster.intersectObjects(primitives, false)
	return hits[0]?.object ?? null
}

function hitRotationGizmo(event) {
	if (!rotationGizmo || !rotationGizmo.visible) return null
	pointerFromEvent(event)
	raycaster.setFromCamera(pointer, camera)
	return raycaster.intersectObjects(rotationGizmo.children, false)[0] ?? null
}

function createScaleDrag(event, mesh) {
	const bounds = primitiveGeometryBounds(mesh)
	const normal = scaleNormal.set(0, 1, 0).applyQuaternion(mesh.quaternion).normalize().clone()
	const anchor = mesh.position.clone().addScaledVector(normal, bounds.min.y * Math.abs(mesh.scale.y))
	worldToScreen(mesh.position, scaleCenterScreen)

	return {
		pointerId: event.pointerId,
		mode: "scale",
		startScale: mesh.scale.clone(),
		startDistance: Math.max(24, screenDistance(event, scaleCenterScreen)),
		centerScreen: scaleCenterScreen.clone(),
		anchor,
		normal,
	}
}

function updateScaleDrag(event) {
	const factor = scaleFactorFromDrag(event)
	selected.scale.copy(primitiveDrag.startScale).multiplyScalar(factor)

	const bounds = primitiveGeometryBounds(selected)
	selected.position.copy(primitiveDrag.anchor).addScaledVector(
		primitiveDrag.normal,
		-bounds.min.y * Math.abs(selected.scale.y)
	)
	updateRotationGizmo()
}

function scaleFactorFromDrag(event) {
	const rawFactor = screenDistance(event, primitiveDrag.centerScreen) / primitiveDrag.startDistance
	const minStart = Math.max(0.001, Math.min(
		Math.abs(primitiveDrag.startScale.x),
		Math.abs(primitiveDrag.startScale.y),
		Math.abs(primitiveDrag.startScale.z)
	))
	const maxStart = Math.max(
		Math.abs(primitiveDrag.startScale.x),
		Math.abs(primitiveDrag.startScale.y),
		Math.abs(primitiveDrag.startScale.z)
	)
	return THREE.MathUtils.clamp(rawFactor, 0.15 / minStart, 8 / maxStart)
}

function createRotationDrag(event, axisName) {
	const axis = rotationAxisVector.copy(rotationAxes[axisName]).normalize().clone()
	rotationPlane.setFromNormalAndCoplanarPoint(axis, selected.position)
	if (!rayToPlane(event, rotationPlane, rotationStartPoint)) return null
	configureRotationBasis(axis)
	rotationStartVector.copy(rotationStartPoint).sub(selected.position).normalize()
	return {
		pointerId: event.pointerId,
		mode: "rotate",
		axis,
		startQuaternion: selected.quaternion.clone(),
		startAngle: angleInRotationPlane(rotationStartVector),
	}
}

function updateRotationDrag(event) {
	rotationPlane.setFromNormalAndCoplanarPoint(primitiveDrag.axis, selected.position)
	if (!rayToPlane(event, rotationPlane, rotationPoint)) return
	rotationVector.copy(rotationPoint).sub(selected.position).normalize()
	const angle = angleInRotationPlane(rotationVector)
	rotationDelta.setFromAxisAngle(primitiveDrag.axis, angle - primitiveDrag.startAngle)
	selected.quaternion.copy(rotationDelta).multiply(primitiveDrag.startQuaternion)
}

function configureRotationBasis(axis) {
	if (Math.abs(axis.y) < 0.9) {
		rotationBasisA.set(0, 1, 0).cross(axis).normalize()
	} else {
		rotationBasisA.set(1, 0, 0)
	}
	rotationBasisB.copy(axis).cross(rotationBasisA).normalize()
}

function angleInRotationPlane(vector) {
	return Math.atan2(vector.dot(rotationBasisB), vector.dot(rotationBasisA))
}

function placementPositionFromPointer(event, mesh, target, ignored = null) {
	pointerFromEvent(event)
	raycaster.setFromCamera(pointer, camera)
	const targets = ignored ? primitives.filter(primitive => primitive !== ignored) : primitives
	const hit = raycaster.intersectObjects(targets, false)[0]
	if (hit) {
		placementPositionFromHit(hit, mesh, target)
		return true
	}

	if (!projectPointerToSurface(event, defaultSurfaceY, target)) return false
	alignPlacementToNormal(mesh, surfaceNormal)
	target.y = defaultSurfaceY - primitiveBottomOffset(mesh)
	return true
}

function placementPositionFromHit(hit, mesh, target) {
	const face = hitFaceAxis(hit)
	if (hit.object.userData.locked) {
		placementAnchor.copy(hit.point)
	} else {
		const bounds = primitiveGeometryBounds(hit.object)
		localFaceCenter.set(
			(bounds.min.x + bounds.max.x) / 2,
			(bounds.min.y + bounds.max.y) / 2,
			(bounds.min.z + bounds.max.z) / 2
		)
		localFaceCenter[face.axis.name] = face.axis.sign > 0 ? bounds.max[face.axis.name] : bounds.min[face.axis.name]
		placementAnchor.copy(localFaceCenter)
		hit.object.localToWorld(placementAnchor)
	}

	const bounds = primitiveGeometryBounds(mesh)
	placementNormal.copy(face.normal)
	alignPlacementToNormal(mesh, placementNormal)
	target.copy(placementAnchor).addScaledVector(placementNormal, -bounds.min.y * Math.abs(mesh.scale.y))
}

function hitFaceAxis(hit) {
	if (hit.face) {
		localFaceNormal.copy(hit.face.normal).normalize()
	} else {
		localHitPoint.copy(hit.point)
		hit.object.worldToLocal(localHitPoint)
		localFaceNormal.copy(localHitPoint).normalize()
	}
	const axis = dominantAxis(localFaceNormal)
	localFaceNormal.set(0, 0, 0)
	localFaceNormal[axis.name] = axis.sign
	normalMatrix.getNormalMatrix(hit.object.matrixWorld)
	placementNormal.copy(localFaceNormal).applyMatrix3(normalMatrix).normalize()
	return { axis, normal: placementNormal.clone() }
}

function alignPlacementToNormal(mesh, normal) {
	// A manually-rotated piece keeps its own orientation — it snaps onto faces by
	// position only, staying angled, instead of being re-flattened to the surface.
	if (mesh.userData.manualRotation) return
	mesh.quaternion.setFromUnitVectors(localUp, normal)
}

function dominantAxis(normal) {
	const x = Math.abs(normal.x)
	const y = Math.abs(normal.y)
	const z = Math.abs(normal.z)
	if (x >= y && x >= z) return { name: "x", sign: Math.sign(normal.x) || 1 }
	if (y >= x && y >= z) return { name: "y", sign: Math.sign(normal.y) || 1 }
	return { name: "z", sign: Math.sign(normal.z) || 1 }
}

function projectPointerToSurface(event, y, target) {
	pointerFromEvent(event)
	raycaster.setFromCamera(pointer, camera)
	dragPlane.set(surfaceNormal, -y)
	return raycaster.ray.intersectPlane(dragPlane, target)
}

function rayToPlane(event, plane, target) {
	pointerFromEvent(event)
	raycaster.setFromCamera(pointer, camera)
	return raycaster.ray.intersectPlane(plane, target)
}

function primitiveBottomOffset(mesh) {
	const bounds = primitiveGeometryBounds(mesh)
	return bounds.min.y * Math.abs(mesh.scale.y)
}

function primitiveGeometryBounds(mesh) {
	if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
	return mesh.geometry.boundingBox
}

function worldToScreen(world, target) {
	const rect = renderer.domElement.getBoundingClientRect()
	screenProjection.copy(world).project(camera)
	target.set(
		rect.left + (screenProjection.x * 0.5 + 0.5) * rect.width,
		rect.top + (-screenProjection.y * 0.5 + 0.5) * rect.height
	)
	return target
}

function screenDistance(event, point) {
	return Math.hypot(event.clientX - point.x, event.clientY - point.y)
}

function pointerFromEvent(event) {
	const rect = renderer.domElement.getBoundingClientRect()
	pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
	pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
}

document.addEventListener("keydown", (event) => {
	if (event.key === "Delete" || event.key === "Backspace") removeSelected()
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
		event.preventDefault()
		duplicateSelected()
	}
})

window.addEventListener("resize", () => {
	camera.aspect = window.innerWidth / window.innerHeight
	camera.updateProjectionMatrix()
	renderer.setSize(window.innerWidth, window.innerHeight)
})

function animate() {
	sky.position.copy(camera.position)
	renderer.render(scene, camera)
	requestAnimationFrame(animate)
}

addPrimitive("box", {
	id: `prim_${String(nextId++).padStart(3, "0")}`,
	type: "box",
	position: [0, 0.05, 0],
	rotation: [0, 0, 0],
	scale: [bounds.max.x - bounds.min.x, 0.1, bounds.max.z - bounds.min.z],
	color: "#587553",
	locked: true,
})
select(null)
setActiveTool("pointer")
animate()
