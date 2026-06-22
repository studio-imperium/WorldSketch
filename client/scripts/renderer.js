import * as THREE from "three"
import { createOrbit } from "/scripts/controls.js"
import { generateScene, retrainBundle } from "/scripts/api.js"
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
let lastJobId = null // the most recent generated plot — the parent for the next expansion
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
const baseplateScale = 0.4

// World expansion: new plots are ground tiles laid down next to the current one.
const tileSize = bounds.max.x - bounds.min.x // 20×20, matches the starting ground
const tileGap = 0.4 // a hair of seam between tiles so they read as separate plots
const addPlotDirs = [[1, 0], [0, 1], [-1, 0], [0, -1]] // E, S, W, N — tried first by nextPlotOrigin
let activeOrigin = new THREE.Vector3(0, 0, 0) // world-space centre of the plot you're building in
let addPlotCount = 0
let plotSeq = 0 // highest plot id handed out; the starting ground is plot 0
let activePlotId = 0 // the plot you're building in — objects you place join it and move with it
let plotJobIds = {} // plotId -> jobId of that plot's latest build; the world composes their splats
let plotPrompts = {} // plotId -> that plot's own "vibe" (prompt); each plot can differ
let lastPrompt = "" // last vibe typed, used as the default for new plots / batch builds
let building = false // a build run is in progress (plots build one at a time)
let pendingBuildPlots = null // plot ids queued by a build button, awaiting the prompt modal
let matchPlotId = null // "Match" reference: build targets copy this plot's vibe + parent
const selectedPlotIds = new Set() // plots checked in the panel for "Build selected"
const plotMovePoint = new THREE.Vector3() // scratch: where a plot-move drag hits the ground plane

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
	downloadCaptures: document.getElementById("download_captures_btn"),
	retrainBundle: document.getElementById("retrain_bundle_input"),
	generateModal: document.getElementById("generate_modal"),
	generateForm: document.getElementById("generate_form"),
	generateTitle: document.getElementById("generate_title"),
	cancelGenerate: document.getElementById("cancel_generate_btn"),
	scenePrompt: document.getElementById("scene_prompt"),
	worldTile: document.getElementById("world_tile"),
	worldPreview: document.getElementById("world_preview"),
	worldSpinner: document.getElementById("world_spinner"),
	worldStatus: document.getElementById("world_status"),
	addPlot: document.getElementById("add_plot_btn"),
	plotsPanel: document.getElementById("plots_panel"),
	plotsList: document.getElementById("plots_list"),
	buildAll: document.getElementById("build_all_btn"),
	buildSelected: document.getElementById("build_selected_btn"),
	matchPlot: document.getElementById("match_plot"),
	clearWorld: document.getElementById("clear_world_btn"),
	statusBadge: document.getElementById("backend_status"),
}

function setActiveTool(tool) {
	const changed = activeTool !== tool
	activeTool = tool
	if (changed) select(null)
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
	if (seed?.isGround) mesh.userData.isGround = true
	if (seed?.existing) mesh.userData.existing = true
	mesh.userData.plotId = Number.isInteger(seed?.plotId) ? seed.plotId : activePlotId
	group.add(mesh)
	primitives.push(mesh)
	select(mesh)
	scheduleSave()
	return mesh
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
	scheduleSave()
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
	scheduleSave()
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

// --- Plots ---------------------------------------------------------------------------
// A plot is a ground tile plus the objects sharing its plotId. Each plot builds into its
// OWN splat; the world is those splats composed. plotJobIds maps plotId -> its latest build.
function orderedPlotIds() {
	const ids = new Set()
	for (const mesh of primitives) if (mesh.userData.isGround) ids.add(mesh.userData.plotId)
	return [...ids].sort((a, b) => a - b)
}

function plotMeshesOf(plotId) {
	return primitives.filter(primitive => primitive.userData.plotId === plotId)
}

function plotIsBuilt(plotId) {
	return Boolean(plotJobIds[plotId])
}

// Label/number a plot by its position in creation order (Plot 1, Plot 2, …).
function plotLabel(plotId) {
	return `Plot ${orderedPlotIds().indexOf(plotId) + 1}`
}

// worldBounds is the union of every ground tile (plus the standard 0..5 height), so the
// server's fusion keep-region grows to cover all the plots instead of culling the new tile.
function worldBounds() {
	let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
	for (const mesh of primitives) {
		if (!mesh.userData.isGround) continue
		const hx = Math.abs(mesh.scale.x) / 2
		const hz = Math.abs(mesh.scale.z) / 2
		minX = Math.min(minX, mesh.position.x - hx)
		maxX = Math.max(maxX, mesh.position.x + hx)
		minZ = Math.min(minZ, mesh.position.z - hz)
		maxZ = Math.max(maxZ, mesh.position.z + hz)
	}
	if (!Number.isFinite(minX)) { minX = -10; maxX = 10; minZ = -10; maxZ = 10 }
	return { min: [minX, 0, minZ], max: [maxX, 5, maxZ] }
}

// serializeSceneForPlot builds the payload to generate ONE plot: that plot's meshes are the
// delta (existing:false → fused), every other mesh is frozen context (existing:true → drawn
// for occlusion/seam but never fused). parentJobId is for prompt/style inheritance only —
// the server fuses just this plot's masked points into its own world.ply.
function serializeSceneForPlot(prompt, plotId, parentJobId) {
	const subject = new Set(plotMeshesOf(plotId))
	return {
		version: 1,
		prompt,
		parent: parentJobId || "",
		bounds: worldBounds(),
		primitives: primitives.map(mesh => ({ ...serializePrimitive(mesh), existing: !subject.has(mesh) })),
	}
}

// nextPlotOrigin picks where a new plot tile lands: a cell adjacent to the plot you're in
// (E/S/W/N), and if those are taken, the nearest free cell spiralling out from the origin —
// so plots never stack on top of each other (the old modulo cycle re-used cells after 4).
function occupiedPlotCells() {
	const step = tileSize + tileGap
	const cells = new Set()
	for (const mesh of primitives) {
		if (!mesh.userData.isGround) continue
		cells.add(`${Math.round(mesh.position.x / step)},${Math.round(mesh.position.z / step)}`)
	}
	return cells
}

function nextPlotOrigin() {
	const step = tileSize + tileGap
	const occupied = occupiedPlotCells()
	const base = { x: Math.round(activeOrigin.x / step), z: Math.round(activeOrigin.z / step) }
	const candidates = addPlotDirs.map(([dx, dz]) => ({ x: base.x + dx, z: base.z + dz }))
	for (let radius = 1; radius <= 12; radius++) {
		for (let dx = -radius; dx <= radius; dx++) {
			for (let dz = -radius; dz <= radius; dz++) {
				if (Math.max(Math.abs(dx), Math.abs(dz)) === radius) candidates.push({ x: dx, z: dz })
			}
		}
	}
	const free = candidates.find(cell => !occupied.has(`${cell.x},${cell.z}`))
	const cell = free ?? { x: base.x + 1, z: base.z }
	return new THREE.Vector3(cell.x * step, 0, cell.z * step)
}

// addPlot lays down a fresh ground tile and makes it the active plot. You can lay out several
// plots up front (no need to build the first one first) and then build any subset or all of
// them from the Plots panel — each is its own generation. Drag an unbuilt tile to reposition
// it (objects follow). See docs/world-expansion-plan.md.
function addPlot() {
	addPlotCount++
	activeOrigin = nextPlotOrigin()
	activePlotId = ++plotSeq

	const ground = addPrimitive("box", {
		type: "box",
		position: [activeOrigin.x, 0.05, activeOrigin.z],
		rotation: [0, 0, 0],
		scale: [tileSize, 0.1, tileSize],
		color: "#587553",
		isGround: true,
		locked: true, // a surface you place ON (objects drop at the click point, not the tile centre)
	})
	select(null)

	// Frame the camera on the new tile so you can build in it.
	const box = new THREE.Box3().setFromCenterAndSize(
		new THREE.Vector3(activeOrigin.x, 1.5, activeOrigin.z),
		new THREE.Vector3(tileSize, 5, tileSize),
	)
	orbit.frame(box)
	setActiveTool("box")
	setStatus("New plot added — build here, or drag the tile to reposition it, then Build.")
	renderPlotsPanel()
	void ground
}

// markPlotBuilt freezes a plot once it's generated: it becomes the
// existing world (locked + dimmed) that the other plots are matched against. Only this plot's
// meshes are frozen — other plots keep their own built/unbuilt state.
function markPlotBuilt(plotId) {
	for (const mesh of plotMeshesOf(plotId)) {
		mesh.userData.existing = true
		mesh.userData.locked = true
		if (mesh.material) {
			mesh.material.transparent = true
			mesh.material.opacity = 0.5
		}
	}
	select(null)
	scheduleSave()
}

// --- Moving a plot as a unit --------------------------------------------------------
// A plot is a ground tile plus every primitive sharing its plotId. Dragging the active
// (unfrozen) tile translates the whole group across the ground plane, so its objects keep
// their relative layout instead of being stranded when only the tile moved.
function isMovablePlotGround(mesh) {
	// Only an unfrozen (unbuilt) tile, with the pointer tool, and only once there's more than
	// one plot — so the lone starter plot doesn't hijack camera orbit before you've laid out
	// more. Built plots stay put (their splat is fixed in world space).
	return Boolean(mesh?.userData.isGround) && mesh.userData.existing !== true &&
		activeTool === "pointer" && orderedPlotIds().length > 1
}

function plotMembers(ground) {
	const id = ground.userData.plotId
	return primitives.filter(primitive => primitive.userData.plotId === id)
}

function createPlotMoveDrag(event, ground) {
	if (!projectPointerToSurface(event, ground.position.y, plotMovePoint)) return null
	const members = plotMembers(ground)
	return {
		pointerId: event.pointerId,
		mode: "plotMove",
		ground,
		groundY: ground.position.y,
		start: plotMovePoint.clone(),
		members,
		origins: members.map(mesh => mesh.position.clone()),
	}
}

function updatePlotMoveDrag(event) {
	if (!projectPointerToSurface(event, primitiveDrag.groundY, plotMovePoint)) return
	const dx = plotMovePoint.x - primitiveDrag.start.x
	const dz = plotMovePoint.z - primitiveDrag.start.z
	primitiveDrag.members.forEach((mesh, index) => {
		const origin = primitiveDrag.origins[index]
		mesh.position.set(origin.x + dx, origin.y, origin.z + dz)
	})
}

// --- Local autosave: a reload keeps your scene, plots, and parent link ---------------
// (in-memory only otherwise — there's no server-side scene store). Open with ?new to
// start a fresh world.
const STORAGE_KEY = "worldsketch_editor_v1"
let saveTimer = null

function serializeForSave(mesh) {
	return {
		...serializePrimitive(mesh), // id/type/position/rotation/scale/color/existing
		locked: mesh.userData.locked === true,
		isGround: mesh.userData.isGround === true,
		plotId: Number.isInteger(mesh.userData.plotId) ? mesh.userData.plotId : 0,
	}
}

function saveState() {
	saveTimer = null
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({
			v: 1,
			nextId,
			lastJobId,
			plotJobIds,
			plotPrompts,
			lastPrompt,
			addPlotCount,
			plotSeq,
			activePlotId,
			activeOrigin: [activeOrigin.x, activeOrigin.y, activeOrigin.z],
			camera: orbit.getState(),
			primitives: primitives.map(serializeForSave),
		}))
	} catch (err) {
		// localStorage full/disabled — autosave is best-effort, never block the editor.
	}
}

function scheduleSave() {
	if (saveTimer) clearTimeout(saveTimer)
	saveTimer = setTimeout(saveState, 400)
}

function loadState() {
	let state
	try {
		state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")
	} catch {
		return false
	}
	if (!state || !Array.isArray(state.primitives) || state.primitives.length === 0) return false

	// Restore scalars first so primitives loaded without a saved plotId (older saves)
	// inherit the right active plot, and so addPrimitive's plotId fallback is correct.
	if (Number.isFinite(state.nextId)) nextId = state.nextId
	lastJobId = state.lastJobId ?? null
	plotJobIds = (state.plotJobIds && typeof state.plotJobIds === "object" && !Array.isArray(state.plotJobIds)) ? { ...state.plotJobIds } : {}
	plotPrompts = (state.plotPrompts && typeof state.plotPrompts === "object" && !Array.isArray(state.plotPrompts)) ? { ...state.plotPrompts } : {}
	lastPrompt = typeof state.lastPrompt === "string" ? state.lastPrompt : ""
	addPlotCount = state.addPlotCount ?? 0
	activePlotId = Number.isInteger(state.activePlotId) ? state.activePlotId : 0
	if (Array.isArray(state.activeOrigin)) {
		activeOrigin.set(state.activeOrigin[0] || 0, state.activeOrigin[1] || 0, state.activeOrigin[2] || 0)
	}

	let maxPlotId = 0
	for (const seed of state.primitives) {
		const mesh = addPrimitive(seed.type, seed)
		if (seed.existing && mesh?.material) {
			mesh.material.transparent = true
			mesh.material.opacity = 0.5
		}
		if (mesh && Number.isInteger(mesh.userData.plotId)) maxPlotId = Math.max(maxPlotId, mesh.userData.plotId)
	}
	plotSeq = Math.max(Number.isInteger(state.plotSeq) ? state.plotSeq : 0, maxPlotId)
	if (state.camera) orbit.setState(state.camera)
	return true
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
	if (message.toLowerCase().includes("decorat")) return "DECOR"
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
	els.worldTile.classList.remove("hidden")
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

// composedSplatSrc builds the viewer src from every generated plot's splat. Each plot is its
// own splat in one shared world frame, so the viewer overlays them into the full world — the
// existing plots are never re-fused or re-trained, the world just grows plot by plot.
function composedSplatSrc() {
	const builtJobs = orderedPlotIds().filter(plotIsBuilt).map(id => plotJobIds[id])
	const ids = builtJobs.length ? builtJobs : (lastJobId ? [lastJobId] : [])
	return ids.map(jobId => `/api/jobs/${jobId}/world.splat`).join(",")
}

// applyJobResult wires a finished job's artifacts into the UI (splat viewer link, download
// buttons, world tile). Shared by a fresh Generate and by restoring the last world on reload.
function applyJobResult(job) {
	if (job.plyUrl) els.downloadPly.href = job.plyUrl
	if (job.collisionUrl) els.downloadCollision.href = job.collisionUrl
	if (job.bundleUrl) els.downloadBundle.href = job.bundleUrl
	if (job.splatUrl) {
		// Compose every plot's splat; collisions come from this (latest) job, whose scene holds
		// every primitive (existing + new), so one collisions.json already covers the whole world.
		const src = composedSplatSrc() || job.splatUrl
		els.viewSplat.href = `/splat-viewer.html?src=${src}&collisions=${encodeURIComponent(job.collisionUrl)}`
		els.download.href = job.splatUrl
		els.viewSplat.classList.remove("hidden")
		els.download.classList.remove("hidden")
	}
	els.downloadPly.classList.toggle("hidden", !job.plyUrl)
	els.downloadCollision.classList.toggle("hidden", !job.collisionUrl)
	els.downloadBundle.classList.toggle("hidden", !job.bundleUrl)
	showWorldResult(job)
}

// restoreLastWorld re-attaches the most recent generated world after a reload: the scene
// (primitives + lastJobId) comes back from localStorage, and this fetches that job so the
// splat viewer + downloads work again without regenerating. The server reconstructs a
// finished job from disk even across a coordinator restart, so this survives that too.
async function restoreLastWorld() {
	if (!lastJobId) return
	try {
		const res = await fetch(`/api/jobs/${lastJobId}`)
		if (!res.ok) return // server has no record (output cleared / never finished) — skip quietly
		const job = await res.json()
		if (job && job.status === "done") applyJobResult(job)
	} catch {
		// offline / server down — the scene still loads; the world tile just stays hidden.
	}
}

function hideWorldButtons() {
	els.viewSplat.classList.add("hidden")
	els.download.classList.add("hidden")
	els.downloadPly.classList.add("hidden")
	els.downloadCollision.classList.add("hidden")
	els.downloadBundle.classList.add("hidden")
}

// buildPlot generates ONE plot into its own splat: capture framed on that plot (masked when
// other plots already exist), submit, then record the job and freeze the plot. The parent is
// any already-built plot — used only for prompt/style inheritance; the server fuses just this
// plot's masked points into its own world.ply (see docs/world-expansion-plan.md "Shipped v3").
async function buildPlot(plotId, prompt, parentOverride = null) {
	const subjectMeshes = plotMeshesOf(plotId)
	if (!subjectMeshes.length) return null
	// parentOverride ("Match" a reference plot) wins; otherwise inherit from any built plot,
	// purely for prompt/style continuity (the server fuses only this plot's points).
	let parentJobId = parentOverride
	if (parentJobId == null) {
		const parentId = orderedPlotIds().find(id => id !== plotId && plotIsBuilt(id))
		parentJobId = parentId === undefined ? "" : plotJobIds[parentId]
	}
	const expanding = Boolean(parentJobId)

	// Capture the plot at full strength even on a rebuild, where its meshes were dimmed to
	// 0.5 as the "built" cue — a faded silhouette would weaken the ControlNet conditioning.
	for (const mesh of subjectMeshes) if (mesh.material) mesh.material.opacity = 1

	const scenePayload = serializeSceneForPlot(prompt, plotId, parentJobId)
	const helpers = [placementPreview, rotationGizmo].filter(Boolean)
	const views = await captureViews(renderer, scene, camera, helpers, selected, subjectMeshes, {
		maskMeshes: expanding ? subjectMeshes : null,
	})
	const job = await generateScene(scenePayload, views, setStatus)
	// Only register a plot as built when its splat actually exists (status "done"). A failed
	// build still returns a job object (so its partial bundle is downloadable) — don't add it,
	// or the composed View Splat link would point at a world.splat that 404s. The usual cause
	// of a failed build is splat training: it needs the GPU worker, so run ./scripts/dev.sh.
	if (job.id && job.status === "done") {
		plotJobIds[plotId] = job.id
		lastJobId = job.id
		applyJobResult(job)
		markPlotBuilt(plotId) // freeze just this plot
	} else if (job.status === "failed") {
		throw new Error(job.error || "build failed before the splat was produced (GPU worker not running?)")
	}
	return job
}

// startBuild is the single entry point for every build button. If a "Match" reference plot is
// chosen, it builds the targets to match that plot (its vibe + parent) with no prompt step;
// otherwise it opens the vibe modal first.
function startBuild(plotIds) {
	if (building) return
	const targets = plotIds.filter(id => plotMeshesOf(id).length)
	if (!targets.length) {
		setStatus("Add a plot and place some primitives first.")
		return
	}
	if (matchPlotId != null && plotIsBuilt(matchPlotId)) {
		runBuilds(targets, { matchId: matchPlotId })
	} else {
		promptThenBuild(targets)
	}
}

// runBuilds generates a set of plots one at a time (each its own splat). With matchId set,
// every target copies that reference plot's vibe + parent (so they all match it); otherwise a
// single build uses the typed prompt as that plot's vibe and a batch keeps each plot's own
// vibe, filling only the unset ones with the typed prompt.
async function runBuilds(plotIds, { prompt = "", matchId = null } = {}) {
	if (building) return
	const targets = plotIds.filter(id => plotMeshesOf(id).length)
	if (!targets.length) return
	const matched = matchId != null && plotIsBuilt(matchId)
	const single = targets.length === 1 && !matched
	if (!matched) lastPrompt = prompt
	building = true
	syncBuildUi()
	for (const plotId of targets) {
		const vibe = matched ? (plotPrompts[matchId] || prompt) : (single ? prompt : (plotPrompts[plotId] || prompt))
		plotPrompts[plotId] = vibe
		const parentOverride = matched && matchId !== plotId ? plotJobIds[matchId] : null
		activePlotId = plotId
		renderPlotsPanel()
		setStatus(`Building ${plotLabel(plotId)}${matched ? ` to match ${plotLabel(matchId)}` : ""}…`)
		showWorldLoading()
		hideWorldButtons()
		try {
			await buildPlot(plotId, vibe, parentOverride)
		} catch (err) {
			showWorldError(`${plotLabel(plotId)}: ${err.message}`)
		}
	}
	building = false
	syncBuildUi()
	renderPlotsPanel()
}

// promptThenBuild opens the vibe modal scoped to what you're building, then builds on submit.
// Single plot → pre-filled with that plot's own vibe (editing it sets that plot's vibe). Batch
// → pre-filled with the last vibe, used only to fill plots that don't have their own yet.
function promptThenBuild(plotIds) {
	if (building) return
	pendingBuildPlots = plotIds
	const single = plotIds.length === 1
	els.scenePrompt.value = single ? (plotPrompts[plotIds[0]] || lastPrompt) : lastPrompt
	if (els.generateTitle) {
		els.generateTitle.textContent = single
			? `Vibe for ${plotLabel(plotIds[0])}`
			: plotIds.length >= orderedPlotIds().length
				? "Vibe for all plots (each keeps its own; this fills the rest)"
				: "Vibe for selected plots (each keeps its own; this fills the rest)"
	}
	els.generateModal.showModal()
	els.scenePrompt.focus()
}

// --- Plots panel: choose which plot(s) to build (one, the checked set, or all) -------
function syncBuildUi() {
	els.generate.disabled = building
	if (els.addPlot) els.addPlot.disabled = building
	if (els.clearWorld) els.clearWorld.disabled = building
	if (els.matchPlot) els.matchPlot.disabled = building
	if (els.buildAll) els.buildAll.disabled = building || orderedPlotIds().length === 0
	if (els.buildSelected) els.buildSelected.disabled = building || selectedPlotIds.size === 0
}

// focusPlot makes a plot the active one (where new objects land, what Generate builds) and
// frames the camera on it.
function focusPlot(plotId) {
	activePlotId = plotId
	const ground = plotMeshesOf(plotId).find(mesh => mesh.userData.isGround)
	if (ground) {
		select(ground)
		orbit.frame(new THREE.Box3().setFromObject(ground))
	}
	setStatus(`${plotLabel(plotId)} active${plotIsBuilt(plotId) ? " (built)" : ""} — Build it, or add objects then Build.`)
	renderPlotsPanel()
}

// renderPlotsPanel rebuilds the plot list: a checkbox (multi-select), a click-to-focus label +
// vibe, a built/empty/building badge, and a per-plot Build/Rebuild — plus the Match dropdown.
function renderPlotsPanel() {
	if (!els.plotsList) return
	const ids = orderedPlotIds()
	for (const id of [...selectedPlotIds]) if (!ids.includes(id)) selectedPlotIds.delete(id)
	if (matchPlotId != null && !ids.includes(matchPlotId)) matchPlotId = null

	els.plotsList.textContent = ""
	for (const id of ids) {
		const objectCount = plotMeshesOf(id).filter(mesh => !mesh.userData.isGround).length
		const state = building && id === activePlotId ? "building" : plotIsBuilt(id) ? "built" : "empty"

		const row = document.createElement("li")
		row.className = "plot-row" + (id === activePlotId ? " is-active" : "")

		const check = document.createElement("input")
		check.type = "checkbox"
		check.className = "plot-check"
		check.checked = selectedPlotIds.has(id)
		check.disabled = building
		check.title = "Select to build several together"
		check.addEventListener("change", () => {
			check.checked ? selectedPlotIds.add(id) : selectedPlotIds.delete(id)
			syncBuildUi()
		})

		// The label + vibe is a click target → focus this plot on the canvas.
		const focus = document.createElement("button")
		focus.type = "button"
		focus.className = "plot-focus"
		focus.disabled = building
		focus.title = "Click to focus this plot"
		const labelLine = document.createElement("span")
		labelLine.className = "plot-label"
		labelLine.textContent = `${plotLabel(id)} · ${objectCount} obj`
		const vibeLine = document.createElement("span")
		vibeLine.className = "plot-vibe" + (plotPrompts[id] ? "" : " plot-vibe-empty")
		vibeLine.textContent = plotPrompts[id] ? `“${plotPrompts[id]}”` : "no vibe yet — tap Build"
		focus.append(labelLine, vibeLine)
		focus.addEventListener("click", () => focusPlot(id))

		const badge = document.createElement("span")
		badge.className = `plot-status plot-status-${state}`
		badge.textContent = state === "building" ? "building…" : state

		const build = document.createElement("button")
		build.type = "button"
		build.className = "plot-build btn btn-xs" + (plotIsBuilt(id) ? "" : " btn-primary")
		build.disabled = building
		build.textContent = plotIsBuilt(id) ? "Rebuild" : "Build"
		build.addEventListener("click", () => startBuild([id]))

		row.append(check, focus, badge, build)
		els.plotsList.appendChild(row)
	}

	// Match dropdown: "— none —" then each plot. Choosing one makes a build copy that plot's
	// vibe + parent onto the targets, so they all match it (e.g. match Plot 1).
	if (els.matchPlot) {
		els.matchPlot.textContent = ""
		els.matchPlot.appendChild(new Option("Match: none", ""))
		for (const id of ids) {
			els.matchPlot.appendChild(new Option(`Match: ${plotLabel(id)}${plotIsBuilt(id) ? "" : " (unbuilt)"}`, String(id)))
		}
		els.matchPlot.value = matchPlotId == null ? "" : String(matchPlotId)
	}

	if (els.plotsPanel) els.plotsPanel.classList.toggle("hidden", ids.length <= 1)
	syncBuildUi()
}

// clearWorld is the hard reset: wipe the scene + autosave and start from one fresh ground tile.
function clearWorld() {
	if (!window.confirm("Clear everything and start a fresh world? This can't be undone.")) return
	try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
	for (const mesh of [...primitives]) {
		clearSelectionOutline(mesh)
		mesh.geometry.dispose()
		mesh.material.dispose()
		mesh.removeFromParent()
	}
	primitives.length = 0
	selected = null
	nextId = 1
	lastJobId = null
	plotJobIds = {}
	plotPrompts = {}
	lastPrompt = ""
	addPlotCount = 0
	plotSeq = 0
	activePlotId = 0
	matchPlotId = null
	selectedPlotIds.clear()
	activeOrigin.set(0, 0, 0)
	hideWorldButtons()
	els.worldTile.classList.add("hidden")
	addPrimitive("box", {
		id: `prim_${String(nextId++).padStart(3, "0")}`,
		type: "box",
		position: [0, 0.05, 0],
		rotation: [0, 0, 0],
		scale: [(bounds.max.x - bounds.min.x) * baseplateScale, 0.1, (bounds.max.z - bounds.min.z) * baseplateScale],
		color: "#587553",
		locked: true,
		isGround: true,
	})
	// Recenter the camera back onto the fresh plot.
	orbit.frame(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(0, 1.2, 0), new THREE.Vector3(tileSize, 5, tileSize)))
	select(null)
	setActiveTool("pointer")
	renderPlotsPanel()
	setStatus("Cleared — fresh world.")
	scheduleSave()
}

// reconcilePlotState un-freezes any plot marked existing/dimmed that was never actually built
// (no job in plotJobIds) — fixes plots that went pale from an earlier failed build.
function reconcilePlotState() {
	for (const id of orderedPlotIds()) {
		if (plotIsBuilt(id)) continue
		for (const mesh of plotMeshesOf(id)) {
			if (!mesh.userData.existing) continue
			mesh.userData.existing = false
			if (!mesh.userData.isGround) mesh.userData.locked = false
			if (mesh.material) { mesh.material.opacity = 1; mesh.material.transparent = false }
		}
	}
}

// fetchBackendStatus shows whether builds will reach the GPU (so a blank splat is explained).
async function fetchBackendStatus() {
	if (!els.statusBadge) return
	try {
		const res = await fetch("/api/status")
		const info = await res.json()
		const labels = {
			gpu: ["GPU ready", "ok"],
			gpu_no_url: ["GPU creds — run ./scripts/dev.sh for the tunnel", "warn"],
			local: ["Local — no GPU (point cloud only)", "warn"],
		}
		const [text, kind] = labels[info.mode] || ["", ""]
		els.statusBadge.textContent = text
		els.statusBadge.className = `backend-status backend-status-${kind}`
		els.statusBadge.classList.toggle("hidden", !text)
	} catch {
		els.statusBadge.classList.add("hidden")
	}
}

async function retrainUploadedBundle(file) {
	if (!file) return

	els.generate.disabled = true
	els.retrainBundle.disabled = true
	showWorldLoading()
	hideWorldButtons()
	setStatus("Uploading bundle")

	try {
		const job = await retrainBundle(file, setStatus)
		applyJobResult(job)
	} catch (err) {
		showWorldError(err.message)
	} finally {
		els.generate.disabled = false
		els.retrainBundle.disabled = false
		els.retrainBundle.value = ""
	}
}

async function captureCurrentViews() {
	const captureSubjects = primitives
	return captureViews(renderer, scene, camera, [placementPreview, rotationGizmo].filter(Boolean), selected, captureSubjects)
}

async function downloadCaptures() {
	if (!primitives.some(primitive => !primitive.userData.locked)) {
		setStatus("Add at least one primitive.")
		return
	}

	els.downloadCaptures.disabled = true
	setStatus("Capturing views")
	try {
		const views = await captureCurrentViews()
		const files = views.map(view => ({ name: `${view.name}_rgb.png`, blob: view.rgb }))
		downloadBlob(await createZip(files), "worldsketch-rgb-captures.zip")
		setStatus(`Downloaded ${views.length} RGB captures`)
	} catch (err) {
		setStatus(err.message)
	} finally {
		els.downloadCaptures.disabled = false
	}
}

function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob)
	const link = document.createElement("a")
	link.href = url
	link.download = filename
	document.body.appendChild(link)
	link.click()
	link.remove()
	setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function createZip(files) {
	const encoder = new TextEncoder()
	const localParts = []
	const centralParts = []
	let offset = 0

	for (const file of files) {
		const nameBytes = encoder.encode(file.name)
		const data = new Uint8Array(await file.blob.arrayBuffer())
		const crc = crc32(data)
		const localHeader = zipLocalHeader(nameBytes, data.length, crc)
		const centralHeader = zipCentralHeader(nameBytes, data.length, crc, offset)

		localParts.push(localHeader, data)
		centralParts.push(centralHeader)
		offset += localHeader.length + data.length
	}

	const centralSize = centralParts.reduce((total, part) => total + part.length, 0)
	return new Blob(
		[...localParts, ...centralParts, zipEndRecord(files.length, centralSize, offset)],
		{ type: "application/zip" },
	)
}

function zipLocalHeader(nameBytes, size, crc) {
	const header = new Uint8Array(30 + nameBytes.length)
	const view = new DataView(header.buffer)
	view.setUint32(0, 0x04034b50, true)
	view.setUint16(4, 20, true)
	view.setUint16(8, 0, true)
	view.setUint32(14, crc, true)
	view.setUint32(18, size, true)
	view.setUint32(22, size, true)
	view.setUint16(26, nameBytes.length, true)
	header.set(nameBytes, 30)
	return header
}

function zipCentralHeader(nameBytes, size, crc, offset) {
	const header = new Uint8Array(46 + nameBytes.length)
	const view = new DataView(header.buffer)
	view.setUint32(0, 0x02014b50, true)
	view.setUint16(4, 20, true)
	view.setUint16(6, 20, true)
	view.setUint16(10, 0, true)
	view.setUint32(16, crc, true)
	view.setUint32(20, size, true)
	view.setUint32(24, size, true)
	view.setUint16(28, nameBytes.length, true)
	view.setUint32(42, offset, true)
	header.set(nameBytes, 46)
	return header
}

function zipEndRecord(fileCount, centralSize, centralOffset) {
	const header = new Uint8Array(22)
	const view = new DataView(header.buffer)
	view.setUint32(0, 0x06054b50, true)
	view.setUint16(8, fileCount, true)
	view.setUint16(10, fileCount, true)
	view.setUint32(12, centralSize, true)
	view.setUint32(16, centralOffset, true)
	return header
}

function crc32(data) {
	let crc = 0xffffffff
	for (const byte of data) {
		crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
	}
	return (crc ^ 0xffffffff) >>> 0
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
	let value = index
	for (let bit = 0; bit < 8; bit++) {
		value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
	}
	return value >>> 0
})

for (const button of document.querySelectorAll("[data-tool]")) {
	button.addEventListener("click", () => setActiveTool(button.dataset.tool))
}

for (const swatch of els.colorSwatches) {
	swatch.addEventListener("click", () => applyColor(swatch.dataset.color))
}

els.generate.addEventListener("click", () => startBuild([activePlotId]))

els.cancelGenerate.addEventListener("click", () => {
	pendingBuildPlots = null
	els.generateModal.close()
})

if (els.addPlot) els.addPlot.addEventListener("click", addPlot)
if (els.buildAll) els.buildAll.addEventListener("click", () => startBuild(orderedPlotIds()))
if (els.buildSelected) els.buildSelected.addEventListener("click", () => startBuild([...selectedPlotIds].sort((a, b) => a - b)))
if (els.clearWorld) els.clearWorld.addEventListener("click", clearWorld)
if (els.matchPlot) els.matchPlot.addEventListener("change", () => {
	matchPlotId = els.matchPlot.value === "" ? null : Number(els.matchPlot.value)
	syncBuildUi()
})
if (els.downloadCaptures) els.downloadCaptures.addEventListener("click", downloadCaptures)
if (els.retrainBundle) els.retrainBundle.addEventListener("change", () => {
	retrainUploadedBundle(els.retrainBundle.files?.[0])
})

els.generateForm.addEventListener("submit", (event) => {
	event.preventDefault()
	const prompt = els.scenePrompt.value.trim()
	els.generateModal.close()
	const plots = pendingBuildPlots ?? [activePlotId]
	pendingBuildPlots = null
	runBuilds(plots, { prompt })
})

els.worldTile.addEventListener("click", () => {
	if (els.worldTile.disabled || els.worldTile.classList.contains("is-loading")) return
	downloadWorld()
})

renderer.domElement.addEventListener("pointerdown", (event) => {
	// Right / middle / shift-drag → let the camera pan (handled by the orbit controls).
	if (event.button !== 0 || event.shiftKey) return
	if (activeTool === "eraser" || isShapeTool(activeTool)) return

	// Dragging empty space orbits — with the rotate tool that's how you reposition to
	// choose the roll axis (e.g. look from above to roll about the vertical / yaw).
	const hit = hitPrimitive(event)
	if (!hit) return

	// A plot moves as a unit: once its (unfrozen) ground tile is selected, dragging it
	// translates the whole plot — tile + every object on it. The first click only selects,
	// so an unselected or frozen tile still falls through to camera orbit.
	if (hit.userData.isGround) {
		if (!isMovablePlotGround(hit) || selected !== hit) return
		const plotDrag = createPlotMoveDrag(event, hit)
		if (!plotDrag) return
		event.preventDefault()
		event.stopImmediatePropagation()
		renderer.domElement.setPointerCapture(event.pointerId)
		primitiveDrag = plotDrag
		primitiveDrag.startClientX = event.clientX
		primitiveDrag.startClientY = event.clientY
		primitiveDrag.transformed = false
		renderer.domElement.classList.add("is-dragging")
		return
	}

	if (hit.userData.locked) return

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
	if (primitiveDrag.mode === "plotMove") {
		updatePlotMoveDrag(event)
		return
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
	const drag = primitiveDrag
	primitiveDrag = null
	renderer.domElement.classList.remove("is-dragging")
	renderer.domElement.releasePointerCapture(event.pointerId)
	if (drag.transformed) {
		// A moved plot becomes the new active origin so the next Add plot lands beside it.
		if (drag.mode === "plotMove" && drag.ground.userData.plotId === activePlotId) {
			activeOrigin.set(drag.ground.position.x, 0, drag.ground.position.z)
		}
		select(null) // deselect after an actual move/scale/rotate
		scheduleSave()
	}
}, { capture: true })

renderer.domElement.addEventListener("pointerup", (event) => {
	if (event.button !== 0) return // right/middle = camera pan, not select
	if (primitiveDrag) return
	if (orbit.moved()) return
	if (placeActiveShape(event)) return
	const hit = hitPrimitive(event)
	if (activeTool === "eraser") {
		if (hit && !hit.userData.locked) removePrimitive(hit)
		return
	}
	select(hit)
	if (hit && isMovablePlotGround(hit)) setStatus("Plot selected — drag it to reposition (its objects move with it).")
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
	if (hit.object.userData.locked || hit.object.userData.isGround) {
		// A ground tile (or any locked surface) is something you place ON: drop the object at
		// the exact click point. Only unlocked objects use face-centre stacking.
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
	orbit.applyMovement() // WASD / arrow-key fly
	sky.position.copy(camera.position)
	renderer.render(scene, camera)
	requestAnimationFrame(animate)
}

// ?new wipes the autosave and starts clean; otherwise restore the last world if there is one.
if (new URLSearchParams(location.search).has("new")) {
	try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}
if (loadState()) {
	reconcilePlotState() // un-pale any plot that isn't actually built
	void restoreLastWorld() // re-attach the last generated world (splat viewer + downloads)
} else {
	addPrimitive("box", {
		id: `prim_${String(nextId++).padStart(3, "0")}`,
		type: "box",
		position: [0, 0.05, 0],
		rotation: [0, 0, 0],
		scale: [(bounds.max.x - bounds.min.x) * baseplateScale, 0.1, (bounds.max.z - bounds.min.z) * baseplateScale],
		color: "#587553",
		locked: true,
		isGround: true,
	})
}
window.addEventListener("beforeunload", saveState)
select(null)
setActiveTool("pointer")
renderPlotsPanel()
void fetchBackendStatus() // show whether builds will reach the GPU
animate()
