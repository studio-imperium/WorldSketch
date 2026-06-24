import * as THREE from "three"
import { SparkRenderer, SplatMesh } from "spark"
import { generatePlot } from "/scripts/api.js"
import { capturePlotGuide } from "/scripts/capture.js"
import { clearSelectionOutline, createPrimitive, createSelectionOutline, createSquareFrameOutline, disposeObject } from "/scripts/primitives.js"
import { createSky } from "/scripts/sky.js"

const root = document.getElementById("canvas")
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 200)
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const groundPoint = new THREE.Vector3()
const scratch = new THREE.Vector3()
const localUp = new THREE.Vector3(0, 1, 0)
const localFaceCenter = new THREE.Vector3()
const localFaceNormal = new THREE.Vector3()
const placementNormal = new THREE.Vector3()
const rollAxis = new THREE.Vector3()
const rollQuat = new THREE.Quaternion()
const normalMatrix = new THREE.Matrix3()
const materialState = new WeakMap()
const backgroundColor = new THREE.Color(0xeef5f2)
const shapeTools = new Set(["box", "sphere", "cylinder", "cone"])
const plotSize = 8
const plotStep = 8
const plusSize = plotSize * 0.86 // expansion panels sit inside the cell so there's a margin vs real plots
const accent = 0xb8ff38

// Tripo splats arrive with a hallucinated backdrop, drifting floor level, and a
// non-square footprint. We cull sparse/transparent gaussians, take a conservative
// square footprint from the dense core, crop to it, then size + seat the result
// into the plot exactly like a primitive. Tunable here; see cropAndFitSplat.
// Defaults; overridden at generate time by GET /api/config (WS_CULL_* env vars).
const SPLAT_CROP = {
	opacityFloor: 0.04, // drop near-transparent gaussians (haze / fog)
	densityCells: 28, // voxel-grid resolution across the raw XZ extent
	densityKeepFrac: 0.08, // a cell is "occupied" if it holds >= this fraction of the peak cell count
	radiusKeepPercentile: 0.9, // protected-core radius: opacity+density culls only apply OUTSIDE this distance percentile (1 = protect all/off, lower = harsher)
	bottomCullPercentile: 0.9, // hard first pass: drop stored-Y values below this floor percentile (high stored-Y = below the plot)
	bottomCullSlack: 0.015, // raw footprint span allowed below that percentile before hard culling
	floorCullSlack: 0.015, // plot-local units allowed below the final seated floor before hard culling
	groundPercentile: 0.92, // stored-Y percentile used to crop a height window
	heightCapFactor: 1.8, // keep height up to this multiple of the footprint span
	belowGroundFactor: 0.12, // keep a little below the ground plane (roots / dirt)
	floorPercentile: 0.97, // height percentile grounded to floorY; <1 ignores a sparse tail below the base, 1 = literal lowest gaussian
	floorY: 0, // plot-local Y the floor is grounded to (ground top is 0.05)
	inset: 1, // footprint as a fraction of the plot; 1 = tiles abut seamlessly, <1 leaves a gap
	postScale: 1, // extra uniform scale applied AFTER the fit (>1 overflows, <1 shrinks)
	// --- Tiling: make plots line up seamlessly regardless of content ---
	tile: true, // overfit + square-crop to an exact tile, then bevel edges to a uniform thickness
	overfit: 1.15, // scale content past the tile before cropping, so every edge is a clean cut through solid ground
	edgeThickness: 0.35, // uniform ground thickness (plot-local units) kept at the tile edge so neighbours match
	edgeMargin: 1.5, // distance (plot-local units) over which the edge cap ramps from edgeThickness up to full height
	unitScale: 3.5, // Tripo/Spark raw units render smaller than the plot-space measurement suggests
	floorOffset: -7.3, // matching vertical calibration for the Tripo/Spark coordinate frame
	debug: false, // log per-stage splat counts + extents to the console
}

// Pull cull knobs from the server env (WS_CULL_*) so they can be tuned without a
// rebuild. Falls back silently to the defaults above if the endpoint is missing.
async function loadCullConfig() {
	try {
		const res = await fetch("/api/config")
		if (res.ok) Object.assign(SPLAT_CROP, await res.json())
	} catch {
		// keep defaults
	}
}

let activeTool = "pointer"
let activeColor = "#232323"
let selectedPrimitive = null
let placementPreview = null
let focusedPlot = null
let drag = null
let nextPrimitiveId = 1
let generating = false

const overview = {
	target: new THREE.Vector3(0, 0, 0),
	distance: 34,
}

const focusOrbit = {
	target: new THREE.Vector3(0, 0.9, 0),
	radius: 10,
	theta: Math.PI * 0.25,
	phi: Math.PI * 0.32,
}

const els = {
	status: document.getElementById("status"),
	toolButtons: [...document.querySelectorAll("[data-tool]")],
	colorSwatches: [...document.querySelectorAll("[data-color]")],
	generate: document.getElementById("generate_btn"),
	uploadSplat: document.getElementById("upload_splat_input"),
	exitFocus: document.getElementById("exit_focus_btn"),
	generateModal: document.getElementById("generate_modal"),
	generateForm: document.getElementById("generate_form"),
	cancelGenerate: document.getElementById("cancel_generate_btn"),
	scenePrompt: document.getElementById("scene_prompt"),
	showColliders: document.getElementById("show_colliders_input"),
}

// "Colliders" overlay: re-show a generated plot's (otherwise hidden) primitives as a
// bright wireframe drawn over the splat, to check how well the splat lines up with them.
const colliderColor = 0xb8ff38
let showColliders = false

// Toggle a primitive between its normal solid look and a wireframe-over-everything
// collider overlay, by mutating its OWN material so disposeObject stays correct.
function setColliderStyle(mesh, on) {
	const mat = mesh.material
	if (on) {
		if (!mesh.userData.colliderSnapshot) {
			mesh.userData.colliderSnapshot = {
				wireframe: mat.wireframe, transparent: mat.transparent, opacity: mat.opacity,
				depthTest: mat.depthTest, depthWrite: mat.depthWrite,
				color: mat.color.getHex(), renderOrder: mesh.renderOrder,
			}
		}
		mat.wireframe = true
		mat.transparent = true
		mat.opacity = 0.9
		mat.depthTest = false // draw over the splat
		mat.depthWrite = false
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
		mat.color.setHex(s.color)
		mesh.renderOrder = s.renderOrder
		mat.needsUpdate = true
		mesh.userData.colliderSnapshot = null
	}
}

function applyColliderVisibility() {
	for (const plot of plots.plots) plot.setCollidersVisible(showColliders)
}

renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setClearColor(backgroundColor, 1)
root.appendChild(renderer.domElement)

const sky = createSky()
scene.add(sky)
const sparkRenderer = new SparkRenderer({ renderer })
scene.add(sparkRenderer)
scene.userData.sparkRenderer = sparkRenderer // captured guides hide this so splats never leak into the GPT block-out
scene.add(new THREE.HemisphereLight(0xffffff, 0x4a5d42, 2.25))

const sun = new THREE.DirectionalLight(0xffffff, 1.8)
sun.position.set(5, 8, 3)
scene.add(sun)

class Plot {
	constructor(manager, gx, gz) {
		this.manager = manager
		this.gx = gx
		this.gz = gz
		this.id = `${gx},${gz}`
		this.size = plotSize
		this.selected = false
		this.state = "draft"
		this.prompt = ""
		this.primitives = []
		this.gaussian = null
		this.selectionOutline = null
		this.group = new THREE.Group()
		this.group.position.set(gx * plotStep, 0, gz * plotStep)
		this.ground = createPrimitive("box", `plot_${this.id}`, {
			position: [0, 0.025, 0],
			scale: [plotSize, 0.05, plotSize],
			color: "#587553",
			locked: true,
		})
		this.ground.userData.plot = this
		this.ground.userData.isGround = true
		this.group.add(this.ground)
		scene.add(this.group)
	}

	get center() {
		return this.group.position
	}

	containsPoint(point) {
		return Math.abs(point.x - this.center.x) <= this.size / 2 && Math.abs(point.z - this.center.z) <= this.size / 2
	}

	addPrimitive(type, hit) {
		const mesh = createPrimitive(type, `prim_${String(nextPrimitiveId++).padStart(3, "0")}`, { color: activeColor })
		placeMeshOnSurface(mesh, hit)
		this.group.worldToLocal(mesh.position)
		mesh.userData.plot = this
		this.primitives.push(mesh)
		this.group.add(mesh)
		selectPrimitive(mesh)
		return mesh
	}

	removePrimitive(mesh) {
		const index = this.primitives.indexOf(mesh)
		if (index >= 0) this.primitives.splice(index, 1)
		if (selectedPrimitive === mesh) selectPrimitive(null)
		disposeObject(mesh)
	}

	setSelected(selected) {
		this.selected = selected
		if (this.selectionOutline) {
			disposeObject(this.selectionOutline)
			this.selectionOutline = null
		}
		if (selected) {
			this.selectionOutline = createSquareFrameOutline(plotSize, 0.25, 0xffffff, 0.5)
			this.selectionOutline.position.y = 0.07
			this.group.add(this.selectionOutline)
		}
	}

	setGenerated(mesh) {
		if (this.gaussian) disposeObject(this.gaussian)
		this.gaussian = mesh
		this.group.add(mesh)
		this.ground.visible = false
		for (const primitive of this.primitives) primitive.visible = false
		this.state = "generated"
		this.setCollidersVisible(showColliders) // honor the toggle for the new splat
	}

	setDraftVisible(visible) {
		this.ground.visible = visible
		for (const primitive of this.primitives) {
			primitive.visible = visible
			setColliderStyle(primitive, false) // back to solid for editing/capture
		}
	}

	// Overlay the original primitives as wireframe colliders on the generated splat.
	setCollidersVisible(show) {
		if (this.state !== "generated") return
		for (const primitive of this.primitives) {
			primitive.visible = show
			setColliderStyle(primitive, show)
		}
	}

	setFaded(faded) {
		for (const object of [this.group, this.selectionOutline].filter(Boolean)) {
			object.traverse(child => setObjectFaded(child, faded))
		}
	}

	meshesForCapture() {
		return [this.ground, ...this.primitives]
	}

	raycastables() {
		return [this.ground, ...this.primitives.filter(mesh => mesh.visible)]
	}

	dispose() {
		disposeObject(this.group)
	}
}

class PlotManager {
	constructor() {
		this.map = new Map()
		this.plus = []
	}

	get plots() {
		return [...this.map.values()]
	}

	has(gx, gz) {
		return this.map.has(key(gx, gz))
	}

	add(gx, gz) {
		if (this.has(gx, gz)) return this.map.get(key(gx, gz))
		const plot = new Plot(this, gx, gz)
		this.map.set(plot.id, plot)
		this.syncPlus()
		return plot
	}

	clearSelection() {
		for (const plot of this.plots) plot.setSelected(false)
		syncGenerateButton()
	}

	selected() {
		return this.plots.filter(plot => plot.selected)
	}

	availableCells() {
		if (this.map.size === 0) return [{ gx: 0, gz: 0 }]
		const cells = new Map()
		for (const plot of this.plots) {
			for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const gx = plot.gx + dx
				const gz = plot.gz + dz
				if (!this.has(gx, gz)) cells.set(key(gx, gz), { gx, gz })
			}
		}
		return [...cells.values()]
	}

	syncPlus() {
		for (const plus of this.plus) disposeObject(plus)
		this.plus = []
		if (focusedPlot) return
		for (const cell of this.availableCells()) {
			const plus = createPlus(cell.gx, cell.gz)
			this.plus.push(plus)
			scene.add(plus)
		}
	}
}

const plots = new PlotManager()

function key(gx, gz) {
	return `${gx},${gz}`
}

function createPlus(gx, gz) {
	const group = new THREE.Group()
	group.position.set(gx * plotStep, 0.12, gz * plotStep)
	group.userData = { isPlus: true, gx, gz }

	const fill = new THREE.Mesh(
		new THREE.PlaneGeometry(plusSize, plusSize),
		new THREE.MeshBasicMaterial({ color: 0xaab4ae, depthWrite: false, side: THREE.DoubleSide }),
	)
	fill.name = "plus_fill"
	fill.rotation.x = -Math.PI / 2

	// One opaque, single-color "+" so the two arms don't blend brighter where they
	// overlap (the old transparent arms doubled up in the middle).
	const plusMaterial = new THREE.MeshBasicMaterial({ color: 0xf2f5f3, depthTest: true, depthWrite: false })
	const plusMark = new THREE.Group()
	plusMark.name = "plus_mark"
	plusMark.position.y = 0.08
	plusMark.renderOrder = 1
	const horizontal = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 0.24), plusMaterial)
	const vertical = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.08, 1.5), plusMaterial)
	plusMark.add(horizontal, vertical)

	const hit = new THREE.Mesh(
		new THREE.BoxGeometry(plotSize, 0.06, plotSize),
		new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
	)
	hit.userData = group.userData
	group.add(fill, plusMark, hit)
	return group
}

function setActiveTool(tool) {
	const changed = activeTool !== tool
	activeTool = tool
	if (changed) selectPrimitive(null)
	for (const button of els.toolButtons) button.classList.toggle("active", button.dataset.tool === tool)
	renderer.domElement.classList.toggle("is-pointer", tool === "pointer")
	renderer.domElement.classList.toggle("is-eraser", tool === "eraser")
	renderer.domElement.classList.toggle("is-placing", shapeTools.has(tool))
	renderer.domElement.classList.toggle("is-scaling", tool === "scale")
	renderer.domElement.classList.toggle("is-rotating", tool === "rotate")
	syncPlacementPreview()
}

function setObjectFaded(object, faded) {
	if (!object.material) return
	const materials = Array.isArray(object.material) ? object.material : [object.material]
	for (const material of materials) {
		if (!materialState.has(material)) {
			materialState.set(material, {
				transparent: material.transparent,
				opacity: typeof material.opacity === "number" ? material.opacity : 1,
				depthWrite: material.depthWrite,
				color: material.color?.clone(),
			})
		}
		const state = materialState.get(material)
		if (faded) {
			material.transparent = state.transparent
			material.opacity = state.opacity
			material.depthWrite = state.depthWrite
			if (material.color && state.color) material.color.copy(state.color).lerp(backgroundColor, 0.38)
		} else {
			material.transparent = state.transparent
			material.opacity = state.opacity
			material.depthWrite = state.depthWrite
			if (material.color && state.color) material.color.copy(state.color)
		}
		material.needsUpdate = true
	}
}

function syncPlotFocusFade() {
	for (const plot of plots.plots) plot.setFaded(Boolean(focusedPlot && plot !== focusedPlot))
}

function syncPlacementPreview() {
	if (!shapeTools.has(activeTool) || !focusedPlot) {
		if (placementPreview) disposeObject(placementPreview)
		placementPreview = null
		return
	}
	if (placementPreview?.userData.type === activeTool) return
	if (placementPreview) disposeObject(placementPreview)
	placementPreview = createPrimitive(activeTool, "preview", { color: activeColor })
	placementPreview.userData.type = activeTool
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
	if (selectedPrimitive) {
		selectedPrimitive.material.color.set(color)
	} else {
		for (const plot of selectedPlotsForColor()) plot.ground.material.color.set(color)
	}
	if (placementPreview) placementPreview.material.color.set(color)
	for (const swatch of els.colorSwatches) {
		swatch.classList.toggle("active", swatch.dataset.color.toLowerCase() === color.toLowerCase())
	}
}

function selectedPlotsForColor() {
	const selected = new Set(plots.selected())
	if (focusedPlot) selected.add(focusedPlot)
	return selected
}

function focusPlot(plot) {
	focusedPlot = plot
	plots.clearSelection()
	selectPrimitive(null)
	plot.setSelected(true)
	syncPlotFocusFade()
	focusOrbit.target.set(plot.center.x, 0.8, plot.center.z)
	focusOrbit.radius = 10
	focusOrbit.theta = Math.PI * 0.25
	focusOrbit.phi = Math.PI * 0.32
	plots.syncPlus()
	syncPlacementPreview()
	syncGenerateButton()
	syncFocusUi()
	updateFocusCamera()
}

function exitFocus() {
	if (!focusedPlot) return
	focusedPlot.setSelected(false)
	focusedPlot = null
	syncPlotFocusFade()
	selectPrimitive(null)
	syncPlacementPreview()
	plots.syncPlus()
	syncGenerateButton()
	syncFocusUi()
	updateOverviewCamera()
}

function generationTargets() {
	if (focusedPlot) return [focusedPlot]
	return plots.selected()
}

function syncGenerateButton() {
	const targets = generationTargets()
	els.generate.disabled = generating || targets.length === 0
	els.generate.classList.toggle("is-disabled", els.generate.disabled)
}

function syncFocusUi() {
	els.exitFocus.classList.toggle("hidden", !focusedPlot)
}

function setStatus(message) {
	els.status.textContent = message
	els.status.classList.toggle("hidden", !message)
}

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

function rayToGround(event, target = groundPoint) {
	pointerFromEvent(event)
	raycaster.setFromCamera(pointer, camera)
	return raycaster.ray.intersectPlane(groundPlane, target)
}

function plusHit(event) {
	const objects = plots.plus.flatMap(plus => plus.children)
	const hit = raycast(event, objects)
	const data = hit?.object?.userData?.isPlus ? hit.object.userData : hit?.object?.parent?.userData
	return data?.isPlus ? data : null
}

function plotGroundHit(event) {
	const hit = raycast(event, plots.plots.map(plot => plot.ground))
	return hit?.object?.userData?.plot ?? null
}

function surfaceHit(event, exclude = null) {
	if (!focusedPlot) return null
	const objects = focusedPlot.raycastables().filter(mesh => mesh !== exclude && !mesh.userData.isSelectionOutline)
	const hit = raycast(event, objects)
	if (!hit) return null
	const normal = hit.face?.normal ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0)
	normalMatrix.getNormalMatrix(hit.object.matrixWorld)
	normal.applyMatrix3(normalMatrix).normalize()
	return { point: hit.point.clone(), normal, object: hit.object, face: hit.face }
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
	if (!placementPreview || !focusedPlot) return
	const hit = surfaceHit(event)
	if (!hit) {
		placementPreview.visible = false
		return
	}
	placementPreview.visible = true
	placeMeshOnSurface(placementPreview, hit)
}

function allPrimitives() {
	return plots.plots.flatMap(plot => plot.primitives)
}

function updateOverviewCamera() {
	camera.up.set(0, 0, -1)
	camera.position.set(overview.target.x, overview.distance, overview.target.z)
	camera.lookAt(overview.target)
	camera.near = 0.03
	camera.far = 240
	camera.fov = 45
	camera.updateProjectionMatrix()
}

function updateFocusCamera() {
	focusOrbit.phi = Math.max(0.12, Math.min(Math.PI * 0.48, focusOrbit.phi))
	focusOrbit.radius = Math.max(4, Math.min(22, focusOrbit.radius))
	const spherical = new THREE.Spherical(focusOrbit.radius, focusOrbit.phi, focusOrbit.theta)
	camera.up.set(0, 1, 0)
	camera.position.copy(focusOrbit.target).add(scratch.setFromSpherical(spherical))
	camera.lookAt(focusOrbit.target)
	camera.near = 0.03
	camera.far = 160
	camera.fov = 50
	camera.updateProjectionMatrix()
}

function startOverviewPan(event) {
	drag = {
		mode: "overview-pan",
		pointerId: event.pointerId,
		x: event.clientX,
		y: event.clientY,
		target: overview.target.clone(),
		distance: overview.distance,
	}
	renderer.domElement.setPointerCapture(event.pointerId)
}

function updateOverviewPan(event) {
	const rect = renderer.domElement.getBoundingClientRect()
	const visibleHeight = 2 * drag.distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5)
	const unitsPerPixelY = visibleHeight / rect.height
	const unitsPerPixelX = (visibleHeight * camera.aspect) / rect.width
	overview.target.set(
		drag.target.x - (event.clientX - drag.x) * unitsPerPixelX,
		0,
		drag.target.z - (event.clientY - drag.y) * unitsPerPixelY,
	)
	updateOverviewCamera()
}

function startFocusOrbit(event) {
	drag = {
		mode: "focus-orbit",
		pointerId: event.pointerId,
		x: event.clientX,
		y: event.clientY,
	}
	renderer.domElement.setPointerCapture(event.pointerId)
}

function updateFocusOrbit(event) {
	const dx = event.clientX - drag.x
	const dy = event.clientY - drag.y
	drag.x = event.clientX
	drag.y = event.clientY
	focusOrbit.theta -= dx * 0.006
	focusOrbit.phi -= dy * 0.006
	updateFocusCamera()
}

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
	focusedPlot.group.worldToLocal(worldPosition)
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

function overviewPointerDown(event) {
	const plus = plusHit(event)
	if (plus) {
		const plot = plots.add(plus.gx, plus.gz)
		plots.clearSelection()
		plot.setSelected(true)
		syncGenerateButton()
		return
	}

	const plot = plotGroundHit(event)
	if (plot) {
		if (event.ctrlKey || event.metaKey) {
			plot.setSelected(!plot.selected)
			syncGenerateButton()
			return
		}
		focusPlot(plot)
		return
	}

	plots.clearSelection()
	startOverviewPan(event)
}

function focusPointerDown(event) {
	if (activeTool !== "pointer" && activeTool !== "scale" && activeTool !== "rotate" && activeTool !== "eraser" && !shapeTools.has(activeTool)) return

	if (shapeTools.has(activeTool)) {
		const hit = surfaceHit(event)
		if (hit) {
			focusedPlot.addPrimitive(activeTool, hit)
		} else {
			startFocusOrbit(event)
		}
		return
	}

	const hit = raycast(event, focusedPlot.primitives.filter(mesh => mesh.visible))
	if (hit?.object) {
		if (activeTool === "eraser") {
			focusedPlot.removePrimitive(hit.object)
			return
		}
		startPrimitiveDrag(event, hit.object)
		return
	}

	const groundHit = activeTool === "pointer" ? surfaceHit(event) : null
	if (groundHit?.object?.userData.isGround) {
		selectPrimitive(null)
		focusedPlot.setSelected(true)
		startFocusOrbit(event)
		return
	}

	startFocusOrbit(event)
}

async function generateSelected(prompt) {
	const targets = generationTargets()
	if (!targets.length) return

	generating = true
	syncGenerateButton()
	setStatus("Generating")
	await loadCullConfig()

	try {
		for (let index = 0; index < targets.length; index++) {
			const plot = targets[index]
			const wasGenerated = plot.state === "generated"
			plot.state = "generating"
			setStatus(targets.length === 1 ? "Generating" : `Generating ${index + 1}/${targets.length}`)
			if (wasGenerated) plot.setDraftVisible(true)
			const guide = await capturePlotGuide(renderer, scene, camera, plot, [placementPreview].filter(Boolean))
			if (wasGenerated) plot.setDraftVisible(false)
			const bytes = await generatePlot({
				prompt,
				image: guide.guide,
				materialImage: guide.materialMap,
				groundColor: `#${plot.ground.material.color.getHexString()}`,
			})
			await applySplatBytes(bytes, plot, { prompt, fileName: `${plot.id}.raw.splat` })
		}
		setStatus("")
	} catch (error) {
		setStatus(error.message)
	} finally {
		generating = false
		syncGenerateButton()
	}
}

// Run the cull/fit pipeline on raw splat bytes (from generation OR an upload) and
// seat the result on the plot. Single source of truth so uploads behave exactly
// like generated splats — handy for tuning the WS_CULL_* env knobs on a fixed file.
async function applySplatBytes(bytes, plot, { prompt, fileName } = {}) {
	const raw = new SplatMesh({ fileBytes: bytes, fileName: fileName || `${plot.id}.raw.splat` })
	await raw.initialized
	// cropAndFitSplat culls + seats the SAME mesh in place and returns it (or null).
	const splat = await cropAndFitSplat(raw, plot)
	if (!splat) {
		disposeObject(raw)
		throw new Error("Splat loaded, but had no visible bounds after cropping.")
	}
	if (prompt !== undefined) plot.prompt = prompt
	plot.setGenerated(splat)
}

// Load a local .splat/.ply onto the focused/selected plot through the same pipeline.
async function uploadSplatToPlot(file) {
	if (!file || generating) return
	const plot = generationTargets()[0]
	if (!plot) {
		setStatus("Select or focus a plot first")
		return
	}

	generating = true
	syncGenerateButton()
	setStatus(`Loading ${file.name}`)
	await loadCullConfig()

	try {
		const bytes = new Uint8Array(await file.arrayBuffer())
		plot.state = "generating"
		await applySplatBytes(bytes, plot, { fileName: file.name })
		setStatus("")
	} catch (error) {
		setStatus(error.message)
	} finally {
		generating = false
		syncGenerateButton()
	}
}

function percentile(sorted, q) {
	if (!sorted.length) return 0
	const pos = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
	return sorted[pos]
}

function smoothstep(edge0, edge1, x) {
	const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
	return t * t * (3 - 2 * t)
}

function splatBounds(keep, xs, ys, zs) {
	let minX = Infinity
	let maxX = -Infinity
	let minZ = Infinity
	let maxZ = -Infinity
	const localY = []
	for (let i = 0; i < keep.length; i++) {
		if (!keep[i]) continue
		if (xs[i] < minX) minX = xs[i]
		if (xs[i] > maxX) maxX = xs[i]
		if (zs[i] < minZ) minZ = zs[i]
		if (zs[i] > maxZ) maxZ = zs[i]
		localY.push(ys[i])
	}
	if (!localY.length) return null
	localY.sort((a, b) => a - b)
	return {
		minX,
		maxX,
		minZ,
		maxZ,
		centerX: (minX + maxX) / 2,
		centerZ: (minZ + maxZ) / 2,
		boxX: Math.max(1e-3, maxX - minX),
		boxZ: Math.max(1e-3, maxZ - minZ),
		floorLocalY: percentile(localY, SPLAT_CROP.floorPercentile),
	}
}

// Cull a freshly-loaded Tripo splat (backdrop, fringe, out-of-tile content) IN
// PLACE and seat it squarely in the plot, returning the same mesh (or null if
// nothing survives — caller disposes on null). Culling in place keeps measurement
// and rendering in one coordinate space. The stored model is upside-down, so
// world-up = decreasing stored-Y; the negative Y scale flips it upright and the
// high-Y percentile is the ground plane.
async function cropAndFitSplat(source, plot) {
	const packed = source.packedSplats
	const total = packed?.numSplats ?? 0
	if (!total) return null

	const xs = new Float32Array(total)
	const ys = new Float32Array(total)
	const zs = new Float32Array(total)
	const ops = new Float32Array(total)
	const keep = new Uint8Array(total).fill(1)
	packed.forEachSplat((i, center, _scales, _quaternion, opacity) => {
		xs[i] = center.x
		ys[i] = center.y
		zs[i] = center.z
		ops[i] = opacity
	})

	// 0. Hard bottom cut: the stored model is upside-down, so high stored-Y values
	//    become low/below-floor content after the flip. Do this before protected-core
	//    logic so the central subject cannot preserve the underside smear.
	let rawMinX = Infinity
	let rawMaxX = -Infinity
	let rawMinZ = Infinity
	let rawMaxZ = -Infinity
	for (let i = 0; i < total; i++) {
		if (xs[i] < rawMinX) rawMinX = xs[i]
		if (xs[i] > rawMaxX) rawMaxX = xs[i]
		if (zs[i] < rawMinZ) rawMinZ = zs[i]
		if (zs[i] > rawMaxZ) rawMaxZ = zs[i]
	}
	const rawSpan = Math.max(1e-3, rawMaxX - rawMinX, rawMaxZ - rawMinZ)
	const bottomY = percentile(ys.slice().sort(), SPLAT_CROP.bottomCullPercentile)
	const bottomLimitY = bottomY + SPLAT_CROP.bottomCullSlack * rawSpan
	for (let i = 0; i < total; i++) if (ys[i] > bottomLimitY) keep[i] = 0

	// 1. Protected core: the inner radiusKeepPercentile of splats (by distance from
	//    the content center) are kept unconditionally. Opacity + density culling
	//    only touch splats OUTSIDE this radius, so the central subject is never
	//    eaten — harsher (lower) percentiles expose more of the periphery to culling.
	//    radiusKeepPercentile = 1 protects everything (opacity + density disabled).
	const keptX = []
	const keptZ = []
	for (let i = 0; i < total; i++) {
		if (!keep[i]) continue
		keptX.push(xs[i])
		keptZ.push(zs[i])
	}
	if (!keptX.length) return null
	const originX = percentile(keptX.sort((a, b) => a - b), 0.5)
	const originZ = percentile(keptZ.sort((a, b) => a - b), 0.5)
	const inCore = new Uint8Array(total)
	if (SPLAT_CROP.radiusKeepPercentile >= 1) {
		inCore.fill(1)
	} else {
		const dist = []
		const distByIndex = new Float32Array(total)
		for (let i = 0; i < total; i++) {
			if (!keep[i]) continue
			distByIndex[i] = Math.hypot(xs[i] - originX, zs[i] - originZ)
			dist.push(distByIndex[i])
		}
		const coreRadius = percentile(dist.sort((a, b) => a - b), SPLAT_CROP.radiusKeepPercentile)
		for (let i = 0; i < total; i++) inCore[i] = keep[i] && distByIndex[i] <= coreRadius ? 1 : 0
	}

	// 2. Opacity cull (periphery only): drop near-transparent gaussians (haze / fog).
	for (let i = 0; i < total; i++) if (!inCore[i] && ops[i] < SPLAT_CROP.opacityFloor) keep[i] = 0

	// 3. Density cull (periphery only): voxel-grid the survivors and keep the largest
	//    connected cluster of occupied cells. Detached floaters outside the core are
	//    dropped; core splats are immune so the cohesive subject always stays.
	let minX = Infinity
	let maxX = -Infinity
	let minZ = Infinity
	let maxZ = -Infinity
	for (let i = 0; i < total; i++) {
		if (!keep[i]) continue
		if (xs[i] < minX) minX = xs[i]
		if (xs[i] > maxX) maxX = xs[i]
		if (zs[i] < minZ) minZ = zs[i]
		if (zs[i] > maxZ) maxZ = zs[i]
	}
	if (!Number.isFinite(minX)) return null

	const cells = SPLAT_CROP.densityCells
	const spanX = maxX - minX || 1
	const spanZ = maxZ - minZ || 1
	const counts = new Int32Array(cells * cells)
	const cellOf = i => {
		const cx = Math.min(cells - 1, Math.floor(((xs[i] - minX) / spanX) * cells))
		const cz = Math.min(cells - 1, Math.floor(((zs[i] - minZ) / spanZ) * cells))
		return cz * cells + cx
	}
	for (let i = 0; i < total; i++) if (keep[i]) counts[cellOf(i)]++
	let peak = 0
	for (let c = 0; c < counts.length; c++) if (counts[c] > peak) peak = counts[c]
	const minCount = Math.max(2, Math.floor(peak * SPLAT_CROP.densityKeepFrac))

	const comp = new Int32Array(counts.length).fill(-1)
	const stack = []
	let bestComp = -1
	let bestSize = 0
	let nextComp = 0
	for (let start = 0; start < counts.length; start++) {
		if (counts[start] < minCount || comp[start] !== -1) continue
		const id = nextComp++
		let size = 0
		stack.length = 0
		stack.push(start)
		comp[start] = id
		while (stack.length) {
			const c = stack.pop()
			size++
			const cx = c % cells
			const cz = (c - cx) / cells
			const neighbors = [cx > 0 ? c - 1 : -1, cx < cells - 1 ? c + 1 : -1, cz > 0 ? c - cells : -1, cz < cells - 1 ? c + cells : -1]
			for (const n of neighbors) {
				if (n >= 0 && comp[n] === -1 && counts[n] >= minCount) {
					comp[n] = id
					stack.push(n)
				}
			}
		}
		if (size > bestSize) {
			bestSize = size
			bestComp = id
		}
	}
	if (bestComp === -1) return null
	for (let i = 0; i < total; i++) if (keep[i] && !inCore[i] && comp[cellOf(i)] !== bestComp) keep[i] = 0

	// 4. Height window: drop anything well above the ground or below the roots,
	//    measured in stored units relative to the post-cull horizontal span.
	let lo2X = Infinity
	let hi2X = -Infinity
	let lo2Z = Infinity
	let hi2Z = -Infinity
	for (let i = 0; i < total; i++) {
		if (!keep[i]) continue
		if (xs[i] < lo2X) lo2X = xs[i]
		if (xs[i] > hi2X) hi2X = xs[i]
		if (zs[i] < lo2Z) lo2Z = zs[i]
		if (zs[i] > hi2Z) hi2Z = zs[i]
	}
	const span = Math.max(1e-3, hi2X - lo2X, hi2Z - lo2Z)
	const keptY = []
	for (let i = 0; i < total; i++) if (keep[i]) keptY.push(ys[i])
	keptY.sort((a, b) => a - b)
	const groundY = percentile(keptY, SPLAT_CROP.groundPercentile)
	const ceilY = groundY - SPLAT_CROP.heightCapFactor * span // world-up = lower stored-Y
	const underY = groundY + SPLAT_CROP.belowGroundFactor * span
	for (let i = 0; i < total; i++) {
		if (!keep[i]) continue
		if (ys[i] < ceilY || ys[i] > underY) keep[i] = 0
	}

	// 5. Rough transform for tile-shaping. This pass may still include faint fringe,
	//    so it is only used to decide what belongs in the square tile.
	let bounds = splatBounds(keep, xs, ys, zs)
	if (!bounds) return null
	const fill = plot.size * SPLAT_CROP.inset * SPLAT_CROP.postScale

	let scaleX
	let scaleZ
	if (SPLAT_CROP.tile) {
		const s = (fill * SPLAT_CROP.overfit) / Math.min(bounds.boxX, bounds.boxZ)
		scaleX = s
		scaleZ = s
	} else {
		scaleX = fill / bounds.boxX
		scaleZ = fill / bounds.boxZ
	}
	const scaleY = (scaleX + scaleZ) / 2

	const roughX = i => scaleX * (xs[i] - bounds.centerX)
	const roughZ = i => scaleZ * (zs[i] - bounds.centerZ)
	const roughY = i => scaleY * (bounds.floorLocalY - ys[i])

	// 6. Tile shaping: rough-crop to a square, then bevel the ground edge.
	if (SPLAT_CROP.tile) {
		const half = fill / 2
		for (let i = 0; i < total; i++) {
			if (keep[i] && (Math.abs(roughX(i)) > half || Math.abs(roughZ(i)) > half)) keep[i] = 0
		}
		let hMax = SPLAT_CROP.edgeThickness
		for (let i = 0; i < total; i++) if (keep[i]) hMax = Math.max(hMax, roughY(i))
		const T = SPLAT_CROP.edgeThickness
		for (let i = 0; i < total; i++) {
			if (!keep[i]) continue
			const edgeDist = half - Math.max(Math.abs(roughX(i)), Math.abs(roughZ(i)))
			const cap = T + (hMax - T) * smoothstep(0, SPLAT_CROP.edgeMargin, edgeDist)
			if (roughY(i) > cap) keep[i] = 0
		}
	}

	// 7. Final fit: remeasure AFTER tile shaping. This is the important bit: the
	//    visible survivors, not the discarded skirt/backdrop, determine the scale.
	bounds = splatBounds(keep, xs, ys, zs)
	if (!bounds) return null
	scaleX = fill / bounds.boxX
	scaleZ = fill / bounds.boxZ
	const finalScaleY = (scaleX + scaleZ) / 2
	const finalY = i => finalScaleY * (bounds.floorLocalY - ys[i])

	// 8. Absolute floor clamp: after the final seat transform is known, drop any
	//    gaussian that would render below the plot floor. This catches soft shadow
	//    sheets / undersides that survive percentile culling.
	for (let i = 0; i < total; i++) {
		if (keep[i] && finalY(i) < -SPLAT_CROP.floorCullSlack) keep[i] = 0
	}
	bounds = splatBounds(keep, xs, ys, zs)
	if (!bounds) return null
	scaleX = fill / bounds.boxX
	scaleZ = fill / bounds.boxZ
	const scaleYFinal = (scaleX + scaleZ) / 2
	const renderScaleX = scaleX * SPLAT_CROP.unitScale
	const renderScaleY = scaleYFinal * SPLAT_CROP.unitScale
	const renderScaleZ = scaleZ * SPLAT_CROP.unitScale

	// 9. Cull IN PLACE: compact survivors to the front of the source mesh + truncate,
	//    then apply the transform. Editing the loaded mesh (vs rebuilding) keeps
	//    measurement and rendering in the same coordinate space.
	let kept = 0
	packed.forEachSplat((i, center, scales, quaternion, opacity, color) => {
		if (!keep[i]) return
		packed.setSplat(kept, center, scales, quaternion, opacity, color)
		kept++
	})
	if (!kept) return null
	packed.numSplats = kept
	packed.needsUpdate = true

	source.scale.set(renderScaleX, -renderScaleY, renderScaleZ)
	source.position.set(
		-bounds.centerX * renderScaleX,
		SPLAT_CROP.floorY + SPLAT_CROP.floorOffset + bounds.floorLocalY * renderScaleY,
		-bounds.centerZ * renderScaleZ,
	)

	if (SPLAT_CROP.debug) {
		console.log("[splat fit]", {
			raw: total,
			kept,
			keptPct: ((kept / total) * 100).toFixed(1) + "%",
			tile: SPLAT_CROP.tile,
			boxX: bounds.boxX.toFixed(3),
			boxZ: bounds.boxZ.toFixed(3),
			scaleX: scaleX.toFixed(3),
			scaleZ: scaleZ.toFixed(3),
			unitScale: SPLAT_CROP.unitScale,
			floorOffset: SPLAT_CROP.floorOffset,
			floorLocalY: bounds.floorLocalY.toFixed(3),
		})
	}
	return source
}

renderer.domElement.addEventListener("pointerdown", event => {
	if (event.button !== 0 || generating) return
	if (focusedPlot) focusPointerDown(event)
	else overviewPointerDown(event)
})

renderer.domElement.addEventListener("pointermove", event => {
	if (drag?.mode === "overview-pan") updateOverviewPan(event)
	else if (drag?.mode === "focus-orbit") updateFocusOrbit(event)
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
	if (focusedPlot) {
		focusOrbit.radius *= event.deltaY > 0 ? 1.08 : 0.92
		updateFocusCamera()
	} else {
		overview.distance *= event.deltaY > 0 ? 1.08 : 0.92
		overview.distance = Math.max(12, Math.min(80, overview.distance))
		updateOverviewCamera()
	}
}, { passive: false })

window.addEventListener("keyup", event => {
	if (event.key === "Escape" && focusedPlot && !els.generateModal.open) exitFocus()
})

window.addEventListener("resize", () => {
	camera.aspect = window.innerWidth / window.innerHeight
	camera.updateProjectionMatrix()
	renderer.setSize(window.innerWidth, window.innerHeight)
})

for (const button of els.toolButtons) button.addEventListener("click", () => setActiveTool(button.dataset.tool))
for (const swatch of els.colorSwatches) swatch.addEventListener("click", () => applyColor(swatch.dataset.color))

els.exitFocus.addEventListener("click", exitFocus)

els.showColliders?.addEventListener("change", () => {
	showColliders = els.showColliders.checked
	applyColliderVisibility()
})

els.generate.addEventListener("click", () => {
	if (els.generate.disabled) return
	els.scenePrompt.value = focusedPlot?.prompt || plots.selected()[0]?.prompt || ""
	els.generateModal.showModal()
	els.scenePrompt.focus()
})

els.uploadSplat?.addEventListener("change", event => {
	const file = event.target.files?.[0]
	event.target.value = "" // allow re-selecting the same file
	uploadSplatToPlot(file)
})

els.cancelGenerate.addEventListener("click", () => els.generateModal.close())

els.generateForm.addEventListener("submit", event => {
	event.preventDefault()
	const prompt = els.scenePrompt.value.trim()
	els.generateModal.close()
	generateSelected(prompt)
})

function animate(time) {
	for (const plus of plots.plus) {
		const wave = (Math.sin(time * 0.004 + plus.position.x + plus.position.z) + 1) / 2
		const mark = plus.getObjectByName("plus_mark")
		if (mark) mark.scale.setScalar(0.94 + wave * 0.08)
	}
	sky.position.copy(camera.position)
	renderer.render(scene, camera)
	requestAnimationFrame(animate)
}

setActiveTool("pointer")
plots.syncPlus()
updateOverviewCamera()
syncGenerateButton()
syncFocusUi()
requestAnimationFrame(animate)
