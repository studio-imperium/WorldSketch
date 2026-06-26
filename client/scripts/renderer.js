import * as THREE from "three"
import { SparkRenderer, SplatMesh } from "spark"
import { newOutput, generateSubject } from "/scripts/api.js"
import { captureObject, captureFloor, MASTER_POSE } from "/scripts/capture.js"
import { fitSplatToBox } from "/scripts/fit.js"
import { computeObjects, stepsForVolume } from "/scripts/geometry.js"
import { clearSelectionOutline, createPrimitive, createSelectionOutline, disposeObject } from "/scripts/primitives.js"
import { createSky } from "/scripts/sky.js"

const root = document.getElementById("canvas")
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.03, 400)
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const scratch = new THREE.Vector3()
const localUp = new THREE.Vector3(0, 1, 0)
const localFaceCenter = new THREE.Vector3()
const localFaceNormal = new THREE.Vector3()
const placementNormal = new THREE.Vector3()
const rollAxis = new THREE.Vector3()
const rollQuat = new THREE.Quaternion()
const normalMatrix = new THREE.Matrix3()
const backgroundColor = new THREE.Color(0xfcfcfc)

const shapeTools = new Set(["box", "sphere", "cylinder", "cone"])
const floorSize = 16 // the single world's ground tile (bigger now that it is its own splat)
const groundThickness = 0.05
const groundTopY = groundThickness // plot-local Y of the ground's top surface
const baseGroundColor = "#587553" // default terrain; painted regions layer on top
const FLOOR_STEPS = 16 // the flat floor needs detail but not a huge step budget
// Objects use the minimum gaussian count Tripo supports (2^15). Modularization means
// many small subjects, so keeping every object at the floor count keeps the whole
// world cheap; detail comes from the per-object capture, not raw gaussian volume.
const MIN_GAUSSIANS = 32768
const accent = 0xb8ff38

// Fixed yaw applied to every seated splat (0|1|2|3 = 0/90/180/270°). NOT an
// orientation search — the capture angle is constant so any needed turn is constant
// too. Default 0 (the per-object capture reuses the proven isometric angle). Bump if
// live Tripo output comes out turned; objects + floor are tunable independently since
// they're captured from different angles.
const OBJECT_YAW_TURNS = 0
const FLOOR_YAW_TURNS = 0

let activeTool = "pointer"
let activeColor = "#232323"
let activeBrushScale = 1
let selectedPrimitive = null
let placementPreview = null
let drag = null
let nextPrimitiveId = 1
let generating = false

// Debug overlays. "Colliders" re-shows the source primitives as a wireframe over the
// generated splats; "Bounds" draws each splat's seated content AABB.
const colliderColor = 0xb8ff38
const boundsColor = 0xff3b8d
let showColliders = false
let showBounds = false

const els = {
	status: document.getElementById("status"),
	progress: document.getElementById("progress"),
	progressFill: document.getElementById("progress_fill"),
	progressLabel: document.getElementById("progress_label"),
	toolButtons: [...document.querySelectorAll("[data-tool]")],
	colorSwatches: [...document.querySelectorAll("[data-color]")],
	brushSwatches: [...document.querySelectorAll("[data-scale]")],
	generate: document.getElementById("generate_btn"),
	generateModal: document.getElementById("generate_modal"),
	generateForm: document.getElementById("generate_form"),
	cancelGenerate: document.getElementById("cancel_generate_btn"),
	scenePrompt: document.getElementById("scene_prompt"),
	showColliders: document.getElementById("show_colliders_input"),
	showBounds: document.getElementById("show_splat_box_input"),
}

renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setClearColor(backgroundColor, 1)
root.appendChild(renderer.domElement)

const sky = createSky()
scene.add(sky)
const sparkRenderer = new SparkRenderer({ renderer })
scene.add(sparkRenderer)
scene.userData.sparkRenderer = sparkRenderer // hidden during captures so splats never leak in
scene.add(new THREE.HemisphereLight(0xffffff, 0x4a5d42, 2.25))
const sun = new THREE.DirectionalLight(0xffffff, 1.8)
sun.position.set(5, 8, 3)
scene.add(sun)

// Toggle a primitive between its solid look and a wireframe-over-everything collider
// overlay by mutating its OWN material, so disposeObject stays correct.
function setColliderStyle(mesh, on) {
	const mat = mesh.material
	if (on) {
		if (!mesh.userData.colliderSnapshot) {
			mesh.userData.colliderSnapshot = {
				wireframe: mat.wireframe, transparent: mat.transparent, opacity: mat.opacity,
				depthTest: mat.depthTest, depthWrite: mat.depthWrite,
				color: mat.color.getHex(), renderOrder: mesh.renderOrder, map: mat.map,
			}
		}
		mat.wireframe = true
		mat.transparent = true
		mat.opacity = 0.9
		mat.depthTest = false
		mat.depthWrite = false
		mat.map = null
		mat.color.set(colliderColor)
		mesh.renderOrder = 999
		mat.needsUpdate = true
	} else if (mesh.userData.colliderSnapshot) {
		const s = mesh.userData.colliderSnapshot
		mat.wireframe = s.wireframe
		mat.transparent = s.transparent
		mat.opacity = s.opacity
		mat.depthTest = s.depthTest
		mat.depthWrite = s.depthWrite
		mat.map = s.map
		mat.color.setHex(s.color)
		mesh.renderOrder = s.renderOrder
		mat.needsUpdate = true
		mesh.userData.colliderSnapshot = null
	}
}

// A paintable canvas-texture for the ground so the user can "draw" terrain (rivers,
// paths, rock) that the floor generation turns into real materials.
function createPaintSurface(baseColor) {
	const canvas = document.createElement("canvas")
	canvas.width = canvas.height = 1024
	const ctx = canvas.getContext("2d")
	ctx.fillStyle = baseColor
	ctx.fillRect(0, 0, canvas.width, canvas.height)
	const texture = new THREE.CanvasTexture(canvas)
	texture.colorSpace = THREE.SRGBColorSpace
	return { canvas, ctx, texture }
}

// A faint ground arrow marking the scene "front": the side every subject is captured
// from, so it gets the crisp detail (build doors / faces toward it).
function createFrontIndicator(size) {
	const dir = new THREE.Vector3().setFromSpherical(new THREE.Spherical(1, MASTER_POSE.phi, MASTER_POSE.theta))
	dir.y = 0
	dir.normalize()
	const len = size * 0.07
	const shape = new THREE.Shape()
	shape.moveTo(0, len)
	shape.lineTo(-len * 0.62, -len * 0.5)
	shape.lineTo(len * 0.62, -len * 0.5)
	shape.closePath()
	const geometry = new THREE.ShapeGeometry(shape)
	geometry.rotateX(-Math.PI / 2) // lay flat, tip toward +Z
	const material = new THREE.MeshBasicMaterial({ color: 0x1f2328, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })
	const arrow = new THREE.Mesh(geometry, material)
	arrow.userData.isFront = true
	arrow.renderOrder = 5
	const reach = size / 2 - len * 1.6
	arrow.position.set(dir.x * reach, 0.06, dir.z * reach)
	arrow.rotation.y = Math.atan2(dir.x, dir.z) // align +Z to the front direction
	return arrow
}

// The single world: a paintable ground tile, the block-out primitives placed on it,
// and the gaussian splats generated from them. There is exactly one (the legacy
// multi-plot grid is gone).
class World {
	constructor() {
		this.size = floorSize
		this.group = new THREE.Group()
		scene.add(this.group)
		this.primitives = []
		this.generated = [] // { mesh, primitives }
		this.boundsHelpers = []
		this.state = "draft"
		this.prompt = ""
		this.baseGroundColor = baseGroundColor

		this.paint = createPaintSurface(baseGroundColor)
		this.ground = createPrimitive("box", "ground", {
			position: [0, groundThickness / 2, 0],
			scale: [floorSize, groundThickness, floorSize],
			color: baseGroundColor,
			locked: true,
		})
		this.ground.material.map = this.paint.texture
		this.ground.material.color.set(0xffffff) // let the painted texture show its true colours
		this.ground.material.needsUpdate = true
		this.ground.userData.isGround = true
		this.group.add(this.ground)

		this.front = createFrontIndicator(floorSize)
		this.group.add(this.front)
	}

	allBlockoutMeshes() {
		return [this.ground, ...this.primitives]
	}

	raycastables() {
		return [this.ground, ...this.primitives.filter(mesh => mesh.visible)]
	}

	// Target box the floor splat is fitted into: the full tile footprint, seated at y=0.
	floorBox() {
		const half = this.size / 2
		return new THREE.Box3(new THREE.Vector3(-half, 0, -half), new THREE.Vector3(half, groundTopY, half))
	}

	addPrimitive(type, hit) {
		const mesh = createPrimitive(type, `prim_${String(nextPrimitiveId++).padStart(3, "0")}`, { color: activeColor, scaleFactor: activeBrushScale })
		placeMeshOnSurface(mesh, hit)
		this.group.worldToLocal(mesh.position)
		mesh.userData.world = this
		this.primitives.push(mesh)
		this.group.add(mesh)
		return mesh
	}

	removePrimitive(mesh) {
		const index = this.primitives.indexOf(mesh)
		if (index >= 0) this.primitives.splice(index, 1)
		if (selectedPrimitive === mesh) selectPrimitive(null)
		disposeObject(mesh)
	}

	paintAt(hit) {
		const uv = hit.uv
		if (!uv) return
		const { canvas, ctx, texture } = this.paint
		const px = uv.x * canvas.width
		const py = (1 - uv.y) * canvas.height
		const radius = Math.max(6, ((activeBrushScale * 0.8) * canvas.width) / this.size)
		ctx.fillStyle = activeColor
		ctx.beginPath()
		ctx.arc(px, py, radius, 0, Math.PI * 2)
		ctx.fill()
		texture.needsUpdate = true
	}

	// Seat a generated splat, hiding the source primitives it replaces (progressive
	// reveal as each object completes).
	addGenerated(mesh, sourcePrimitives) {
		this.generated.push({ mesh, primitives: sourcePrimitives })
		this.group.add(mesh)
		for (const primitive of sourcePrimitives) primitive.visible = false
	}

	groundGenerated() {
		this.ground.visible = false
		this.front.visible = false
	}

	// Tear down a previous generation: drop the splats, restore the editable block-out.
	resetGenerated() {
		for (const { mesh } of this.generated) disposeObject(mesh)
		this.generated = []
		this.setBoundsVisible(false)
		this.ground.visible = true
		this.front.visible = true
		for (const primitive of this.primitives) {
			primitive.visible = true
			setColliderStyle(primitive, false)
		}
		this.state = "draft"
	}

	setCollidersVisible(show) {
		if (this.state !== "generated") return
		for (const primitive of this.primitives) {
			primitive.visible = show
			setColliderStyle(primitive, show)
		}
	}

	setBoundsVisible(show) {
		for (const helper of this.boundsHelpers) {
			this.group.remove(helper)
			disposeObject(helper)
		}
		this.boundsHelpers = []
		if (!show || this.state !== "generated") return
		for (const { mesh } of this.generated) {
			const box = mesh.userData.contentBox
			if (!box) continue
			const helper = new THREE.Box3Helper(box, boundsColor)
			helper.material.depthTest = false
			helper.renderOrder = 998
			helper.userData.isDebugHelper = true
			this.group.add(helper)
			this.boundsHelpers.push(helper)
		}
	}
}

const world = new World()

// --- Tools / palette --------------------------------------------------------

function setActiveTool(tool) {
	const changed = activeTool !== tool
	activeTool = tool
	if (changed) selectPrimitive(null)
	for (const button of els.toolButtons) button.classList.toggle("active", button.dataset.tool === tool)
	renderer.domElement.classList.toggle("is-pointer", tool === "pointer")
	renderer.domElement.classList.toggle("is-eraser", tool === "eraser")
	renderer.domElement.classList.toggle("is-placing", shapeTools.has(tool))
	renderer.domElement.classList.toggle("is-painting", tool === "paint")
	renderer.domElement.classList.toggle("is-scaling", tool === "scale")
	renderer.domElement.classList.toggle("is-rotating", tool === "rotate")
	syncPlacementPreview()
}

function syncPlacementPreview() {
	if (!shapeTools.has(activeTool)) {
		if (placementPreview) disposeObject(placementPreview)
		placementPreview = null
		return
	}
	if (placementPreview?.userData.type === activeTool) return
	if (placementPreview) disposeObject(placementPreview)
	placementPreview = createPrimitive(activeTool, "preview", { color: activeColor, scaleFactor: activeBrushScale })
	placementPreview.userData.type = activeTool
	placementPreview.userData.isPreview = true
	placementPreview.material.transparent = true
	placementPreview.material.opacity = 0.45
	placementPreview.material.depthWrite = false
	scene.add(placementPreview)
}

function selectPrimitive(mesh) {
	if (selectedPrimitive) clearSelectionOutline(selectedPrimitive)
	selectedPrimitive = mesh
	if (mesh) createSelectionOutline(mesh, 0xffffff)
}

function applyColor(color) {
	activeColor = color
	if (selectedPrimitive) selectedPrimitive.material.color.set(color)
	if (placementPreview) placementPreview.material.color.set(color)
	for (const swatch of els.colorSwatches) {
		swatch.classList.toggle("active", swatch.dataset.color.toLowerCase() === color.toLowerCase())
	}
}

function applyBrushScale(scale) {
	activeBrushScale = scale
	if (placementPreview) placementPreview.userData.type = null
	syncPlacementPreview()
	for (const swatch of els.brushSwatches) {
		swatch.classList.toggle("active", Number(swatch.dataset.scale) === scale)
	}
}

// --- Raycasting / placement -------------------------------------------------

function pointerFromEvent(event) {
	const rect = renderer.domElement.getBoundingClientRect()
	pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
	pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
}

function raycast(event, objects, recursive = false) {
	pointerFromEvent(event)
	raycaster.setFromCamera(pointer, camera)
	return raycaster.intersectObjects(objects, recursive)[0] ?? null
}

function surfaceHit(event, exclude = null) {
	const objects = world.raycastables().filter(mesh => mesh !== exclude && !mesh.userData.isSelectionOutline)
	const hit = raycast(event, objects)
	if (!hit) return null
	const normal = hit.face?.normal ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0)
	normalMatrix.getNormalMatrix(hit.object.matrixWorld)
	normal.applyMatrix3(normalMatrix).normalize()
	return { point: hit.point.clone(), normal, object: hit.object, face: hit.face, uv: hit.uv }
}

function placeMeshOnSurface(mesh, hit) {
	if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
	const anchor = placementAnchor(hit)
	const normal = placementNormalFromHit(hit)
	const bottom = mesh.geometry.boundingBox.min.y * Math.abs(mesh.scale.y)
	alignMeshToNormal(mesh, normal)
	mesh.position.copy(anchor).addScaledVector(normal, -bottom + 0.006)
}

function placementAnchor(hit) {
	if (hit.object.userData.isGround || hit.object.userData.locked) return hit.point.clone()
	if (!hit.object.geometry.boundingBox) hit.object.geometry.computeBoundingBox()
	const bounds = hit.object.geometry.boundingBox
	const axis = hitFaceAxis(hit)
	localFaceCenter.set(
		(bounds.min.x + bounds.max.x) / 2,
		(bounds.min.y + bounds.max.y) / 2,
		(bounds.min.z + bounds.max.z) / 2,
	)
	localFaceCenter[axis.name] = axis.sign > 0 ? bounds.max[axis.name] : bounds.min[axis.name]
	const anchor = localFaceCenter.clone()
	hit.object.localToWorld(anchor)
	return anchor
}

function placementNormalFromHit(hit) {
	if (hit.object.userData.isGround || hit.object.userData.locked) return hit.normal.clone()
	const axis = hitFaceAxis(hit)
	localFaceNormal.set(0, 0, 0)
	localFaceNormal[axis.name] = axis.sign
	normalMatrix.getNormalMatrix(hit.object.matrixWorld)
	return placementNormal.copy(localFaceNormal).applyMatrix3(normalMatrix).normalize().clone()
}

function hitFaceAxis(hit) {
	const normal = hit.face?.normal ?? localUp
	localFaceNormal.copy(normal).normalize()
	const x = Math.abs(localFaceNormal.x)
	const y = Math.abs(localFaceNormal.y)
	const z = Math.abs(localFaceNormal.z)
	if (x >= y && x >= z) return { name: "x", sign: Math.sign(localFaceNormal.x) || 1 }
	if (y >= x && y >= z) return { name: "y", sign: Math.sign(localFaceNormal.y) || 1 }
	return { name: "z", sign: Math.sign(localFaceNormal.z) || 1 }
}

function alignMeshToNormal(mesh, normal) {
	if (mesh.userData.manualRotation) return
	mesh.quaternion.setFromUnitVectors(localUp, normal)
}

function updatePlacement(event) {
	if (!placementPreview) return
	const hit = surfaceHit(event)
	if (!hit) {
		placementPreview.visible = false
		return
	}
	placementPreview.visible = true
	placeMeshOnSurface(placementPreview, hit)
}

// --- Camera (single orbit around the world) ---------------------------------

const orbit = {
	target: new THREE.Vector3(0, floorSize * 0.05, 0),
	radius: floorSize * 1.25,
	theta: MASTER_POSE.theta,
	phi: MASTER_POSE.phi,
}

function updateCamera() {
	orbit.phi = Math.max(0.12, Math.min(Math.PI * 0.49, orbit.phi))
	orbit.radius = Math.max(4, Math.min(floorSize * 4, orbit.radius))
	camera.up.set(0, 1, 0)
	camera.position.copy(orbit.target).add(scratch.setFromSpherical(new THREE.Spherical(orbit.radius, orbit.phi, orbit.theta)))
	camera.lookAt(orbit.target)
	camera.near = 0.03
	camera.far = 400
	camera.fov = 50
	camera.updateProjectionMatrix()
}

function startOrbit(event) {
	drag = { mode: "orbit", pointerId: event.pointerId, x: event.clientX, y: event.clientY }
	renderer.domElement.setPointerCapture(event.pointerId)
}

function updateOrbit(event) {
	const dx = event.clientX - drag.x
	const dy = event.clientY - drag.y
	drag.x = event.clientX
	drag.y = event.clientY
	orbit.theta -= dx * 0.006
	orbit.phi -= dy * 0.006
	updateCamera()
}

// --- Primitive drag (move / scale / roll) -----------------------------------

function startPrimitiveDrag(event, mesh) {
	selectPrimitive(mesh)
	const worldPosition = mesh.getWorldPosition(new THREE.Vector3())
	drag = {
		mode: activeTool === "rotate" ? "roll" : activeTool === "scale" ? "scale" : "primitive",
		pointerId: event.pointerId,
		mesh,
		startX: event.clientX,
		startY: event.clientY,
		startScale: mesh.scale.clone(),
		startQuaternion: mesh.quaternion.clone(),
		rollAxis: rollAxis.copy(worldPosition).sub(camera.position).normalize().clone(),
		rollCenter: objectScreenPosition(worldPosition),
		startAngle: 0,
	}
	drag.startAngle = pointerScreenAngle(event, drag.rollCenter)
	renderer.domElement.setPointerCapture(event.pointerId)
}

function updatePrimitiveDrag(event) {
	if (drag.mode === "scale") {
		const delta = Math.max(-0.75, Math.min(2.5, (event.clientY - drag.startY) * -0.01))
		drag.mesh.scale.copy(drag.startScale).multiplyScalar(Math.max(0.15, 1 + delta))
		return
	}
	if (drag.mode === "roll") {
		const delta = pointerScreenAngle(event, drag.rollCenter) - drag.startAngle
		rollQuat.setFromAxisAngle(drag.rollAxis, delta)
		drag.mesh.quaternion.copy(rollQuat).multiply(drag.startQuaternion)
		drag.mesh.userData.manualRotation = true
		return
	}
	const hit = surfaceHit(event, drag.mesh)
	if (!hit) return
	placeMeshOnSurface(drag.mesh, hit)
	const worldPosition = drag.mesh.position.clone()
	world.group.worldToLocal(worldPosition)
	drag.mesh.position.copy(worldPosition)
}

function objectScreenPosition(worldPosition) {
	const rect = renderer.domElement.getBoundingClientRect()
	const projected = worldPosition.clone().project(camera)
	return {
		x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
		y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
	}
}

function pointerScreenAngle(event, center) {
	return Math.atan2(event.clientY - center.y, event.clientX - center.x)
}

// --- Paint ------------------------------------------------------------------

function startPaint(event) {
	drag = { mode: "paint", pointerId: event.pointerId }
	renderer.domElement.setPointerCapture(event.pointerId)
	paintAtEvent(event)
}

function paintAtEvent(event) {
	const hit = raycast(event, [world.ground])
	if (hit) world.paintAt(hit)
}

// --- Pointer routing --------------------------------------------------------

function pointerDown(event) {
	if (event.button !== 0) return
	if (generating) {
		startOrbit(event) // only camera movement while generating
		return
	}

	if (activeTool === "paint") {
		if (raycast(event, [world.ground])) startPaint(event)
		else startOrbit(event)
		return
	}

	if (shapeTools.has(activeTool)) {
		const hit = surfaceHit(event)
		if (hit) world.addPrimitive(activeTool, hit)
		else startOrbit(event)
		return
	}

	// pointer / scale / rotate / eraser act on a primitive under the cursor.
	const hit = raycast(event, world.primitives.filter(mesh => mesh.visible))
	if (hit?.object) {
		if (activeTool === "eraser") {
			world.removePrimitive(hit.object)
			return
		}
		startPrimitiveDrag(event, hit.object)
		return
	}
	if (activeTool === "pointer") selectPrimitive(null)
	startOrbit(event)
}

renderer.domElement.addEventListener("pointerdown", pointerDown)

renderer.domElement.addEventListener("pointermove", event => {
	if (drag?.mode === "orbit") updateOrbit(event)
	else if (drag?.mode === "paint") paintAtEvent(event)
	else if (drag && ["primitive", "scale", "roll"].includes(drag.mode)) updatePrimitiveDrag(event)
	else updatePlacement(event)
})

renderer.domElement.addEventListener("pointerup", event => {
	if (drag?.pointerId === event.pointerId) {
		renderer.domElement.releasePointerCapture(event.pointerId)
		drag = null
	}
})

renderer.domElement.addEventListener("wheel", event => {
	event.preventDefault()
	orbit.radius *= event.deltaY > 0 ? 1.08 : 0.92
	updateCamera()
}, { passive: false })

// --- Generation -------------------------------------------------------------

function setStatus(message) {
	els.status.textContent = message
	els.status.classList.toggle("hidden", !message)
}

function showProgress(done, total, label) {
	els.progress.classList.remove("hidden")
	const pct = total ? Math.round((done / total) * 100) : 0
	els.progressFill.style.width = `${pct}%`
	if (label !== undefined) els.progressLabel.textContent = label
}

function hideProgress() {
	els.progress.classList.add("hidden")
	els.progressFill.style.width = "0%"
}

function syncGenerateButton() {
	els.generate.disabled = generating
	els.generate.classList.toggle("is-disabled", generating)
}

// Generate the whole world one subject at a time: the floor first, then each object
// (a connected group of snapped primitives), seating every splat by its own bounding
// box. The progress bar advances per subject since this now takes a while.
async function generateWorld(prompt) {
	if (generating) return
	generating = true
	world.prompt = prompt
	syncGenerateButton()
	setStatus("")
	world.resetGenerated()

	const objects = computeObjects(world.primitives)
	const total = objects.length + 1 // +1 for the floor
	let done = 0
	showProgress(0, total, "Preparing…")

	try {
		let output = null
		try {
			output = (await newOutput()).index
		} catch {
			// non-fatal: generation still works, just won't be saved under outputs/NNNN
		}

		// 1. Floor.
		showProgress(done, total, "Generating floor…")
		const floorCapture = await captureFloor(renderer, scene, camera, world)
		// Send only the guide (one input image). The guide already carries the flat
		// material colours + painted terrain, so the separate material-ID map is
		// redundant here and skipping it halves the per-call input-image cost on the
		// cheap gpt-image-1-mini path.
		const floorBytes = await generateSubject({
			prompt,
			kind: "floor",
			steps: FLOOR_STEPS,
			output,
			name: "floor",
			groundColor: world.baseGroundColor,
			image: floorCapture.guide,
		})
		await seatSubject(floorBytes, world.floorBox(), "floor", null, FLOOR_YAW_TURNS)
		world.groundGenerated()
		done++
		showProgress(done, total)

		// 2. Each object.
		for (let i = 0; i < objects.length; i++) {
			const object = objects[i]
			const label = objects.length === 1 ? "Generating object…" : `Generating object ${i + 1} of ${objects.length}…`
			showProgress(done, total, label)
			const capture = await captureObject(renderer, scene, camera, world, object)
			const bytes = await generateSubject({
				prompt,
				kind: "object",
				steps: stepsForVolume(object.volume),
				gaussians: MIN_GAUSSIANS,
				output,
				name: `obj-${String(i + 1).padStart(3, "0")}`,
				image: capture.guide, // guide only — see the floor call above for why
			})
			await seatSubject(bytes, object.box, `obj-${i + 1}`, object.primitives, OBJECT_YAW_TURNS)
			done++
			showProgress(done, total)
		}

		world.state = "generated"
		applyOverlayVisibility()
		showProgress(total, total, "Done")
		window.setTimeout(hideProgress, 1000)
	} catch (error) {
		setStatus(error.message || "Generation failed")
		hideProgress()
	} finally {
		generating = false
		syncGenerateButton()
	}
}

// Reconstruct + seat one subject's splat into its target box.
async function seatSubject(bytes, box, name, sourcePrimitives, yawTurns = 0) {
	const raw = new SplatMesh({ fileBytes: bytes, fileName: `${name}.splat` })
	await raw.initialized
	const fitted = await fitSplatToBox(raw, box, { yawTurns })
	if (!fitted) {
		disposeObject(raw)
		throw new Error(`${name}: splat had no usable bounds after culling`)
	}
	world.addGenerated(fitted, sourcePrimitives || [])
}

function applyOverlayVisibility() {
	world.setCollidersVisible(showColliders)
	world.setBoundsVisible(showBounds)
}

// --- UI wiring --------------------------------------------------------------

for (const button of els.toolButtons) button.addEventListener("click", () => setActiveTool(button.dataset.tool))
for (const swatch of els.colorSwatches) swatch.addEventListener("click", () => applyColor(swatch.dataset.color))
for (const swatch of els.brushSwatches) swatch.addEventListener("click", () => applyBrushScale(Number(swatch.dataset.scale)))

els.showColliders?.addEventListener("change", () => {
	showColliders = els.showColliders.checked
	world.setCollidersVisible(showColliders)
})

els.showBounds?.addEventListener("change", () => {
	showBounds = els.showBounds.checked
	world.setBoundsVisible(showBounds)
})

els.generate.addEventListener("click", () => {
	if (els.generate.disabled) return
	els.scenePrompt.value = world.prompt || ""
	els.generateModal.showModal()
	els.scenePrompt.focus()
})

els.cancelGenerate.addEventListener("click", () => els.generateModal.close())

els.generateForm.addEventListener("submit", event => {
	event.preventDefault()
	const prompt = els.scenePrompt.value.trim()
	els.generateModal.close()
	generateWorld(prompt)
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

setActiveTool("pointer")
applyColor(activeColor)
applyBrushScale(activeBrushScale)
updateCamera()
syncGenerateButton()
requestAnimationFrame(animate)
