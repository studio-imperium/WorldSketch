import * as THREE from "three"
import { SparkRenderer, SplatMesh } from "spark"
import { generatePlot } from "/scripts/api.js"
import { capturePlotGuide } from "/scripts/capture.js"
import { resolveOrientation, orientArrays, orientCenter, orientQuaternion, isIdentity } from "/scripts/orient.js"
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
const backgroundColor = new THREE.Color(0xfcfcfc)
const shapeTools = new Set(["box", "sphere", "cylinder", "cone"])
const plotSize = 8
const plotStep = 8
const plusSize = plotSize * 0.66 // expansion panels sit inside the cell so there's a margin vs real plots
const accent = 0xb8ff38

// Tripo splats arrive with a hallucinated backdrop, drifting floor level, and a
// non-square footprint. We cull sparse/transparent gaussians, take a conservative
// square footprint from the dense core, crop to it, then size + seat the result
// into the plot exactly like a primitive. Tunable here; see cropAndFitSplat.
//
// Three knobs drive the whole pipeline, one per stage (cull -> seat -> fit), and
// are served at generate time by GET /api/config (WS_CULL_STRENGTH / FLOOR_PCT /
// FIT). Everything else is a structural constant baked in below.
const CULL = {
	strength: 0, // 0 = keep everything, 1 = harshest cull. 0.6 reproduces the hand-tuned values.
	floorPct: 0.97, // ground-detection percentile; lower seats the floor higher into the cloud.
	fit: 3, // render scale vs the plot footprint; 1 = true 1:1.
	orient: false, // recover Tripo's arbitrary D4 pose and rotate the splat into plot-local space.
	markers: false, // off-by-default fiducial fallback; default path aligns to the colliders.
	rotate: 1, // final-stage yaw applied after the fit/seat: 1|2|3|4 -> 90*n degrees (4 = none).
	yOffset: 0.45, // plot-local Y nudge applied to the seated splat AFTER all transforms (+ = up).
	floorMode: "percentile", // floor detection (default): "percentile" (global quantile) | "surface" (robust median of column-tops) | "surface_min" (lowest exposed top).
	floorStrength: 1, // strength of an ANALYSIS-only cull used solely to measure the floor; strips backdrop/sub-ground so the estimate is clean WITHOUT culling the rendered splat. 0 = measure on the full visible cloud.
	surfaceSigma: 10, // seat the splat's visible SURFACE (not gaussian centers) on the floor: drop the floor by this many sigma of the floor gaussians' vertical radius. 0 = seat centers (ground hovers above).
	seatFloor: true, // pin the detected floor to the plot floor plane. false = bypass ALL floor logic and just vertically-center the content (debug/test).
	noFloor: false, // lattice mode: there IS no floor. Skip every floor cull/seat and just center the culled content in the cell (for per-cube 3D generation).
	debug: false, // log per-stage splat counts + extents to the console.
}

// Effective per-stage params cropAndFitSplat reads. The structural fields are
// fixed; the six cull fields + floor/ground/unitScale are filled by deriveCull().
const SPLAT_CROP = {
	// --- Structural constants (not tuned per scene) ---
	densityCells: 28, // voxel-grid resolution across the raw XZ extent
	bottomCullSlack: 0.015, // raw footprint span allowed below the bottom percentile before hard culling
	floorCullSlack: 0, // plot-local units allowed below the final seated floor before hard culling
	clampBelowFloor: false, // cull gaussians rendering below the seated floor; OFF = no floor culling (keeps noisy ground solid instead of spotty)
	floorY: 0.05, // plot-local Y the floor is grounded to (top of the ground primitive)
	floorOffset: 0, // extra vertical calibration on top of floorY
	inset: 1, // footprint as a fraction of the plot; 1 = tiles abut seamlessly
	postScale: 1, // extra uniform scale applied AFTER the fit
	tile: true, // overfit + square-crop to an exact tile, then bevel edges
	overfit: 1, // scale content past the tile before cropping
	edgeThickness: 0, // uniform ground thickness kept at the tile edge (0 = no bevel)
	edgeMargin: 1, // distance over which the edge cap ramps up to full height
	perimeterFloorBand: 0.12, // tile-edge culling only touches gaussians at/below this height (fraction of content height); taller = a real object, kept even if it overhangs the tile
	surfaceDensityFrac: 0.05, // surface floor-mode: a column must hold >= this fraction of the peak cell count to be trusted (ignores sparse stray columns)
	surfaceFloorPercentile: 0.5, // surface (median) mode: percentile of the per-column tops to seat on; 0.5 = median bulk ground (robust), 1 = lowest exposed top (== surface_min)
	// --- Derived from CULL by deriveCull(); see endpoints there ---
	floorMode: "percentile", // overwritten by deriveCull from CULL.floorMode; "percentile" = global quantile, "surface" = column-tops
	surfaceSigma: 10, // sigma of vertical gaussian radius to offset the seat from centers to the visible surface
	opacityFloor: 0,
	densityKeepFrac: 0,
	radiusKeepPercentile: 1,
	bottomCullPercentile: 1,
	heightCapFactor: 3,
	belowGroundFactor: 0.3,
	groundPercentile: 0.92,
	floorPercentile: 0.97,
	unitScale: 1,
	debug: false,
}

// Expand the three CULL knobs into the per-stage params above. strength linearly
// interpolates each cull field between a gentle (s=0, barely culls) and harsh
// (s=1) endpoint; the pairs are chosen so s=0.6 lands on the previously hand-tuned
// values exactly. floorPct sets the seat/ground percentiles; fit sets unitScale.
function deriveCull() {
	const s = Math.min(1, Math.max(0, CULL.strength))
	const lerp = (gentle, harsh) => gentle + (harsh - gentle) * s
	SPLAT_CROP.opacityFloor = lerp(0, 0.0667) // higher = drops more haze
	SPLAT_CROP.densityKeepFrac = lerp(0, 0.1333) // higher = cells must be denser to survive
	SPLAT_CROP.radiusKeepPercentile = lerp(1, 0.8333) // lower = smaller protected core
	SPLAT_CROP.bottomCullPercentile = lerp(1, 0.8333) // lower = cuts more below-floor smear
	SPLAT_CROP.heightCapFactor = lerp(3, 1) // lower = shorter height window
	SPLAT_CROP.belowGroundFactor = lerp(0.3, 0) // lower = keeps less below the ground
	SPLAT_CROP.floorPercentile = CULL.floorPct
	SPLAT_CROP.groundPercentile = Math.max(0, CULL.floorPct - 0.05)
	SPLAT_CROP.unitScale = CULL.fit
	SPLAT_CROP.floorMode = CULL.floorMode
	SPLAT_CROP.surfaceSigma = CULL.surfaceSigma
	SPLAT_CROP.debug = CULL.debug
}
deriveCull()

// Pull the three cull knobs from the server env (WS_CULL_*) so they can be tuned
// without a rebuild. Falls back silently to the defaults above if the endpoint is
// missing, then re-derives the effective params.
async function loadCullConfig() {
	try {
		const res = await fetch("/api/config")
		if (res.ok) Object.assign(CULL, await res.json())
	} catch {
		// keep defaults
	}
	deriveCull()
}

let activeTool = "pointer"
let activeColor = "#232323"
let selectedPrimitive = null
let placementPreview = null
let focusedPlot = null
// Temporary single-plot mode: boot straight into one focused plot, hide the
// expansion ("+") tiles and the exit-focus affordance. Flip to false to restore
// the multi-plot overview workflow.
const singlePlotMode = true
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
	showSplatBox: document.getElementById("show_splat_box_input"),
	showFloor: document.getElementById("show_floor_input"),
	showSplatFloor: document.getElementById("show_splat_floor_input"),
}

// "Colliders" overlay: re-show a generated plot's (otherwise hidden) primitives as a
// bright wireframe drawn over the splat, to check how well the splat lines up with them.
const colliderColor = 0xb8ff38
let showColliders = false

// "Bounds" overlay: draw the splat's true content AABB (computed during the
// cull/fit) as a wireframe box, to check how the splat sits relative to the plot.
const boundsColor = 0xff3b8d
let showSplatBox = false

// "Floor" overlay: a grid at the plot-local floor level (SPLAT_CROP.floorY, the
// height the splat is seated to) so the floor plane is visible at all times while
// debugging seating / Y-offset.
const floorColor = 0x2bb3ff
let showFloor = false

// "Splat floor" overlay: a grid at the plot-local Y the splat's DETECTED floor was
// seated to (plot.splatFloorY), so you can see where the floor-finding algorithm
// thinks the ground is vs where the splat actually renders.
const splatFloorColor = 0xff8c2b
let showSplatFloor = false

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

function applyBoundsVisibility() {
	for (const plot of plots.plots) plot.setBoundsVisible(showSplatBox)
}

function applyFloorVisibility() {
	for (const plot of plots.plots) plot.setFloorVisible(showFloor)
}

function applySplatFloorVisibility() {
	for (const plot of plots.plots) plot.setSplatFloorVisible(showSplatFloor)
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
		this.floorHelper = null
		this.splatFloorHelper = null
		this.splatFloorY = null // plot-local Y the splat's detected floor was seated to
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
		// Don't auto-select on placement — selection only happens when you click a
		// shape with the pointer tool.
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
		this.setBoundsVisible(showSplatBox)
		this.setSplatFloorVisible(showSplatFloor)
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

	// Draw the splat's content AABB (captured in cropAndFitSplat) as a wireframe box
	// in the plot's local space, drawn over the splat so it reads against the edges.
	setBoundsVisible(show) {
		if (this.boundsHelper) {
			this.group.remove(this.boundsHelper)
			disposeObject(this.boundsHelper)
			this.boundsHelper = null
		}
		if (!show || this.state !== "generated" || !this.splatBox) return
		this.boundsHelper = new THREE.Box3Helper(this.splatBox, boundsColor)
		this.boundsHelper.material.depthTest = false
		this.boundsHelper.renderOrder = 998
		this.group.add(this.boundsHelper)
	}

	// Draw a grid at the plot-local floor level (the height the splat is seated to) so
	// the floor plane stays visible for debugging seating / Y-offset. Unlike the other
	// overlays this is a fixed reference, shown regardless of plot state.
	setFloorVisible(show) {
		if (this.floorHelper) {
			this.group.remove(this.floorHelper)
			disposeObject(this.floorHelper)
			this.floorHelper = null
		}
		if (!show) return
		this.floorHelper = new THREE.GridHelper(plotSize, plotSize, floorColor, floorColor)
		this.floorHelper.position.y = SPLAT_CROP.floorY
		this.floorHelper.material.depthTest = false
		this.floorHelper.material.transparent = true
		this.floorHelper.material.opacity = 0.6
		this.floorHelper.renderOrder = 997
		this.floorHelper.userData.isDebugHelper = true
		this.group.add(this.floorHelper)
	}

	// Draw a grid at the plot-local Y the splat's DETECTED floor was seated to
	// (splatFloorY). Compare it against the actual green ground to see how far off the
	// floor-finding algorithm landed. Generated plots only (needs a computed floor).
	setSplatFloorVisible(show) {
		if (this.splatFloorHelper) {
			this.group.remove(this.splatFloorHelper)
			disposeObject(this.splatFloorHelper)
			this.splatFloorHelper = null
		}
		if (!show || this.state !== "generated" || this.splatFloorY == null) return
		this.splatFloorHelper = new THREE.GridHelper(plotSize, plotSize, splatFloorColor, splatFloorColor)
		this.splatFloorHelper.position.y = this.splatFloorY
		this.splatFloorHelper.material.depthTest = false
		this.splatFloorHelper.material.transparent = true
		this.splatFloorHelper.material.opacity = 0.6
		this.splatFloorHelper.renderOrder = 997
		this.splatFloorHelper.userData.isDebugHelper = true
		this.group.add(this.splatFloorHelper)
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

// Centered rounded-rectangle outline (XY plane) so the empty-cell tile matches the
// rounded white UI surfaces instead of a hard-edged grey square.
function roundedRectShape(size, radius) {
	const s = size / 2
	const r = Math.min(radius, s)
	const shape = new THREE.Shape()
	shape.moveTo(-s + r, -s)
	shape.lineTo(s - r, -s)
	shape.quadraticCurveTo(s, -s, s, -s + r)
	shape.lineTo(s, s - r)
	shape.quadraticCurveTo(s, s, s - r, s)
	shape.lineTo(-s + r, s)
	shape.quadraticCurveTo(-s, s, -s, s - r)
	shape.lineTo(-s, -s + r)
	shape.quadraticCurveTo(-s, -s, -s + r, -s)
	return shape
}

function createPlus(gx, gz) {
	const group = new THREE.Group()
	group.position.set(gx * plotStep, 0.12, gz * plotStep)
	group.userData = { isPlus: true, gx, gz }

	const fill = new THREE.Mesh(
		new THREE.ShapeGeometry(roundedRectShape(plusSize, plusSize * 0.14)),
		new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false, side: THREE.DoubleSide }),
	)
	fill.name = "plus_fill"
	fill.rotation.x = -Math.PI / 2

	// One opaque, single-color "+" so the two arms don't blend brighter where they
	// overlap (the old transparent arms doubled up in the middle). Coloured to match
	// the canvas background so the mark reads as a cut-out from the white tile.
	const plusMaterial = new THREE.MeshBasicMaterial({ color: backgroundColor, depthTest: true, depthWrite: false })
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
	// The baseplate is just another selectable object now, so recolouring it goes
	// through the normal selected-primitive path — no plot-level special case.
	if (selectedPrimitive) selectedPrimitive.material.color.set(color)
	if (placementPreview) placementPreview.material.color.set(color)
	for (const swatch of els.colorSwatches) {
		swatch.classList.toggle("active", swatch.dataset.color.toLowerCase() === color.toLowerCase())
	}
}

function focusPlot(plot) {
	focusedPlot = plot
	plots.clearSelection()
	selectPrimitive(null)
	// No plot-level frame outline anymore — the baseplate uses the regular primitive
	// selection outline, shown only while it's actually selected.
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
	// In single-plot mode there's nothing to exit back to, so keep the button hidden.
	els.exitFocus.classList.toggle("hidden", singlePlotMode || !focusedPlot)
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

// Debug: log the camera pose (and orbit params) on user-driven orbit/pan so a good
// angle can be read off and reused — handy for tuning the capture camera.
function logCameraPose(tag, extra = {}) {
	const deg = r => +((r * 180) / Math.PI).toFixed(1)
	console.log(`[camera ${tag}]`, {
		pos: [+camera.position.x.toFixed(2), +camera.position.y.toFixed(2), +camera.position.z.toFixed(2)],
		rotDeg: [deg(camera.rotation.x), deg(camera.rotation.y), deg(camera.rotation.z)],
		...extra,
	})
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
	logCameraPose("pan", {
		target: [+overview.target.x.toFixed(2), +overview.target.z.toFixed(2)],
		distance: +overview.distance.toFixed(2),
	})
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
	logCameraPose("orbit", {
		radius: +focusOrbit.radius.toFixed(2),
		thetaDeg: +((focusOrbit.theta * 180) / Math.PI).toFixed(1),
		phiDeg: +((focusOrbit.phi * 180) / Math.PI).toFixed(1),
	})
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

	// Baseplate behaves like a regular object: a pointer click selects it (regular
	// selection outline) so it can be recoloured, but it's locked against
	// move/scale/rotate/erase — those just orbit the camera, same as empty space.
	const groundHit = surfaceHit(event)
	if (groundHit?.object?.userData.isGround) {
		if (activeTool === "pointer") selectPrimitive(focusedPlot.ground)
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
			const guide = await capturePlotGuide(renderer, scene, camera, plot, [placementPreview].filter(Boolean), { markers: CULL.orient && CULL.markers, noFloor: CULL.noFloor })
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

// Surface floor detection. Treat the topmost gaussian in each XZ column as the visible
// surface (a downward raycast's first hit), build a density-gated set of those
// per-column tops, then aggregate them into one floor height. Stored-Y is flipped
// (model is upside-down): the highest world point in a cell is its MIN stored-Y, and
// world-low ground sits at the HIGH end of stored-Y. So the sorted tops run from object
// cells (low stored, world-high) up to ground cells (high stored, world-low).
//
//   surface_min  -> the single lowest exposed top (max stored). Outlier-sensitive: a
//                   below-ground smear column drags it down, and that error scales with
//                   scene height, so the splat seats at a height-dependent Y.
//   surface(med) -> a robust percentile of the tops (surfaceFloorPercentile, default
//                   0.5 = median). Ignores the below-ground outliers AND the object
//                   cells, pinning the bulk ground so floors seat consistently.
function surfaceFloorLocalY(keep, xs, ys, zs, box, mode = SPLAT_CROP.floorMode) {
	const cells = SPLAT_CROP.densityCells
	const spanX = (box.maxX - box.minX) || 1
	const spanZ = (box.maxZ - box.minZ) || 1
	const topStoredY = new Float32Array(cells * cells).fill(Infinity) // min stored-Y per cell = highest world point
	const count = new Int32Array(cells * cells)
	for (let i = 0; i < keep.length; i++) {
		if (!keep[i]) continue
		const cx = Math.min(cells - 1, Math.floor(((xs[i] - box.minX) / spanX) * cells))
		const cz = Math.min(cells - 1, Math.floor(((zs[i] - box.minZ) / spanZ) * cells))
		const c = cz * cells + cx
		count[c]++
		if (ys[i] < topStoredY[c]) topStoredY[c] = ys[i]
	}
	let peak = 0
	for (let c = 0; c < count.length; c++) if (count[c] > peak) peak = count[c]
	const minCount = Math.max(2, Math.ceil(peak * SPLAT_CROP.surfaceDensityFrac))
	// Density-gated column tops, with an ungated fallback so the set is never empty.
	const tops = []
	for (let c = 0; c < count.length; c++) if (count[c] >= minCount) tops.push(topStoredY[c])
	if (!tops.length) for (let c = 0; c < count.length; c++) if (count[c] > 0) tops.push(topStoredY[c])
	if (!tops.length) return 0
	tops.sort((a, b) => a - b)
	if (mode === "surface_min") return tops[tops.length - 1] // max stored = lowest exposed top in world
	return percentile(tops, SPLAT_CROP.surfaceFloorPercentile) // robust median of the column tops
}

// Measure the floor on an ANALYSIS-only cull: a throwaway copy of the keep mask with
// the strength-based backdrop / sub-ground culls applied (driven by CULL.floorStrength).
// This lets the floor estimate ignore Tripo's thick base slab / hallucinated backdrop
// WITHOUT removing any of it from the rendered splat — the returned value just overrides
// floorLocalY in the seat. Returns null when floorStrength <= 0 (measure normally).
function analysisFloorLocalY(keep, xs, ys, zs, ops) {
	const s = Math.min(1, Math.max(0, CULL.floorStrength))
	if (s <= 0) return null
	const lerp = (g, h) => g + (h - g) * s
	const opacityFloor = lerp(0, 0.0667)
	const bottomPct = lerp(1, 0.8333)
	const heightCap = lerp(3, 1)
	const belowGround = lerp(0.3, 0)
	const groundPct = Math.max(0, CULL.floorPct - 0.05)

	const total = keep.length
	const aKeep = keep.slice()
	let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
	for (let i = 0; i < total; i++) {
		if (!aKeep[i]) continue
		if (xs[i] < minX) minX = xs[i]
		if (xs[i] > maxX) maxX = xs[i]
		if (zs[i] < minZ) minZ = zs[i]
		if (zs[i] > maxZ) maxZ = zs[i]
	}
	if (!Number.isFinite(minX)) return null
	const span = Math.max(1e-3, maxX - minX, maxZ - minZ)

	// Bottom cut: drop the deepest below-floor smear.
	const sortedY = []
	for (let i = 0; i < total; i++) if (aKeep[i]) sortedY.push(ys[i])
	sortedY.sort((a, b) => a - b)
	const bottomLimit = percentile(sortedY, bottomPct) + SPLAT_CROP.bottomCullSlack * span
	for (let i = 0; i < total; i++) if (aKeep[i] && ys[i] > bottomLimit) aKeep[i] = 0

	// Opacity cull: drop haze / fog.
	for (let i = 0; i < total; i++) if (aKeep[i] && ops[i] < opacityFloor) aKeep[i] = 0

	// Height window: drop content well above the ground and the sub-ground slab/backdrop
	// below it — this is the cull that stops the floor latching onto Tripo's thick base.
	const keptY = []
	for (let i = 0; i < total; i++) if (aKeep[i]) keptY.push(ys[i])
	if (!keptY.length) return null
	keptY.sort((a, b) => a - b)
	const groundY = percentile(keptY, groundPct)
	const ceilY = groundY - heightCap * span // world-up = lower stored-Y
	const underY = groundY + belowGround * span
	for (let i = 0; i < total; i++) {
		if (!aKeep[i]) continue
		if (ys[i] < ceilY || ys[i] > underY) aKeep[i] = 0
	}

	const ab = splatBounds(aKeep, xs, ys, zs)
	return ab ? ab.floorLocalY : null
}

// Median vertical radius of the gaussians near the floor (within a band of centerFloorY),
// used to offset the seat from gaussian centers to the visible surface. Falls back to the
// whole kept set if too few floor gaussians are in-band.
function medianFloorRadius(keep, ys, rad, centerFloorY) {
	let minY = Infinity, maxY = -Infinity
	for (let i = 0; i < keep.length; i++) {
		if (!keep[i]) continue
		if (ys[i] < minY) minY = ys[i]
		if (ys[i] > maxY) maxY = ys[i]
	}
	if (!Number.isFinite(minY)) return 0
	const band = 0.1 * Math.max(1e-3, maxY - minY)
	const sel = []
	for (let i = 0; i < keep.length; i++) if (keep[i] && Math.abs(ys[i] - centerFloorY) <= band) sel.push(rad[i])
	if (sel.length < 16) {
		sel.length = 0
		for (let i = 0; i < keep.length; i++) if (keep[i]) sel.push(rad[i])
	}
	if (!sel.length) return 0
	sel.sort((a, b) => a - b)
	return percentile(sel, 0.5)
}

function splatBounds(keep, xs, ys, zs, floorOverride = null) {
	let minX = Infinity
	let maxX = -Infinity
	let minZ = Infinity
	let maxZ = -Infinity
	let minY = Infinity
	let maxY = -Infinity
	const localY = []
	for (let i = 0; i < keep.length; i++) {
		if (!keep[i]) continue
		if (xs[i] < minX) minX = xs[i]
		if (xs[i] > maxX) maxX = xs[i]
		if (zs[i] < minZ) minZ = zs[i]
		if (zs[i] > maxZ) maxZ = zs[i]
		if (ys[i] < minY) minY = ys[i]
		if (ys[i] > maxY) maxY = ys[i]
		localY.push(ys[i])
	}
	if (!localY.length) return null
	localY.sort((a, b) => a - b)
	const box = { minX, maxX, minZ, maxZ }
	const floorLocalY = floorOverride != null
		? floorOverride
		: SPLAT_CROP.floorMode === "percentile"
			? percentile(localY, SPLAT_CROP.floorPercentile)
			: surfaceFloorLocalY(keep, xs, ys, zs, box)
	return {
		minX,
		maxX,
		minZ,
		maxZ,
		minY,
		maxY,
		centerX: (minX + maxX) / 2,
		centerZ: (minZ + maxZ) / 2,
		boxX: Math.max(1e-3, maxX - minX),
		boxZ: Math.max(1e-3, maxZ - minZ),
		floorLocalY,
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
	const rs = new Float32Array(total) // gaussian colour, cached for orientation scoring + marker detection
	const gs = new Float32Array(total)
	const bs = new Float32Array(total)
	const rad = new Float32Array(total) // gaussian vertical (world-Y) std dev, for surface-aware floor seating
	const keep = new Uint8Array(total).fill(1)
	packed.forEachSplat((i, center, scales, quaternion, opacity, color) => {
		xs[i] = center.x
		ys[i] = center.y
		zs[i] = center.z
		ops[i] = opacity
		rs[i] = color.r
		gs[i] = color.g
		bs[i] = color.b
		// Vertical (world-Y) std dev of the gaussian = |row-1 of its rotation matrix · scales|.
		// The D4 orientation only spins X-Z, so the Y-extent is orientation-invariant and can
		// be read straight from the raw quaternion here.
		const r10 = 2 * (quaternion.x * quaternion.y + quaternion.w * quaternion.z)
		const r11 = 1 - 2 * (quaternion.x * quaternion.x + quaternion.z * quaternion.z)
		const r12 = 2 * (quaternion.y * quaternion.z - quaternion.w * quaternion.x)
		rad[i] = Math.hypot(r10 * scales.x, r11 * scales.y, r12 * scales.z)
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
	if (!CULL.noFloor) for (let i = 0; i < total; i++) if (ys[i] > bottomLimitY) keep[i] = 0

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
	if (!CULL.noFloor) {
		for (let i = 0; i < total; i++) {
			if (!keep[i]) continue
			if (ys[i] < ceilY || ys[i] > underY) keep[i] = 0
		}
	}

	// 4b. Orientation: Tripo lands the cloud at an arbitrary D4 pose (one of 4 yaws x
	//     optional handedness flip). Recover it from the capture's corner fiducials
	//     (or, failing that, by aligning to the colliders) and rotate/reflect the
	//     working arrays so every downstream stage sees the splat in plot-local space.
	//     The same transform is applied to the packed centres + quaternions below.
	let orient = { yawDeg: 0, mirror: false }
	if (CULL.orient) {
		const keptIdx = []
		for (let i = 0; i < total; i++) if (keep[i]) keptIdx.push(i)
		const res = resolveOrientation({ xs, ys, zs, rs, gs, bs, kept: keptIdx, groundY, plot, markers: CULL.markers, debug: CULL.debug })
		orient = res.orient
		if (res.markerCull) for (let i = 0; i < total; i++) if (res.markerCull[i]) keep[i] = 0
		orientArrays(orient, xs, zs, total)
		if (CULL.debug) console.log("[orient]", { source: res.source, yawDeg: orient.yawDeg, mirror: orient.mirror, scores: res.scores })
	}

	// Floor seating, computed once and reused for every bounds pass below:
	//  1. Measure the gaussian-CENTER floor — on a throwaway analysis cull (backdrop /
	//     sub-ground removed) if floorStrength > 0, else on the full kept set.
	//  2. Drop it by surfaceSigma * (vertical radius of the floor gaussians) so we seat
	//     the splat's visible SURFACE on the floor plane, not the centers. Pinning centers
	//     floats the surface up by ~radius*renderScaleY — the "ground hovers N blocks up" bug.
	let centerFloorY = analysisFloorLocalY(keep, xs, ys, zs, ops)
	if (centerFloorY == null) {
		const cb = splatBounds(keep, xs, ys, zs)
		centerFloorY = cb ? cb.floorLocalY : 0
	}
	const floorRadius = medianFloorRadius(keep, ys, rad, centerFloorY)
	const seatFloorY = centerFloorY - SPLAT_CROP.surfaceSigma * floorRadius

	// 5. Rough transform for tile-shaping. This pass may still include faint fringe,
	//    so it is only used to decide what belongs in the square tile.
	let bounds = splatBounds(keep, xs, ys, zs, seatFloorY)
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

	// 6. Tile shaping: rough-crop to a square, then bevel the ground edge — but ONLY
	//    for gaussians at/around floor level. roughY is 0 at the floor and grows
	//    upward, so anything taller than perimeterFloorBand is a real object and is
	//    left intact even where it overhangs the tile edge; only the ground sheet /
	//    backdrop skirt at the perimeter gets cropped.
	if (SPLAT_CROP.tile && !CULL.noFloor) {
		const half = fill / 2
		let hMax = SPLAT_CROP.edgeThickness
		for (let i = 0; i < total; i++) if (keep[i]) hMax = Math.max(hMax, roughY(i))
		const floorBand = SPLAT_CROP.perimeterFloorBand * hMax
		const nearFloor = i => roughY(i) <= floorBand
		for (let i = 0; i < total; i++) {
			if (keep[i] && nearFloor(i) && (Math.abs(roughX(i)) > half || Math.abs(roughZ(i)) > half)) keep[i] = 0
		}
		const T = SPLAT_CROP.edgeThickness
		for (let i = 0; i < total; i++) {
			if (!keep[i] || !nearFloor(i)) continue
			const edgeDist = half - Math.max(Math.abs(roughX(i)), Math.abs(roughZ(i)))
			const cap = T + (hMax - T) * smoothstep(0, SPLAT_CROP.edgeMargin, edgeDist)
			if (roughY(i) > cap) keep[i] = 0
		}
	}

	// 7. Final fit: remeasure AFTER tile shaping. This is the important bit: the
	//    visible survivors, not the discarded skirt/backdrop, determine the scale.
	bounds = splatBounds(keep, xs, ys, zs, seatFloorY)
	if (!bounds) return null
	scaleX = fill / bounds.boxX
	scaleZ = fill / bounds.boxZ
	const finalScaleY = (scaleX + scaleZ) / 2
	const finalY = i => finalScaleY * (bounds.floorLocalY - ys[i])

	// 8. Absolute floor clamp (opt-in): drop any gaussian that would render below the
	//    plot floor. Off by default — culling here punches holes in noisy ground
	//    surfaces (the "spotty floor"), so we keep the floor solid and do NOT cull it.
	if (SPLAT_CROP.clampBelowFloor) {
		for (let i = 0; i < total; i++) {
			if (keep[i] && finalY(i) < -SPLAT_CROP.floorCullSlack) keep[i] = 0
		}
		bounds = splatBounds(keep, xs, ys, zs, seatFloorY)
		if (!bounds) return null
	}
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
		if (!isIdentity(orient)) {
			orientCenter(orient, center) // same D4 transform applied to xs/zs above
			orientQuaternion(orient, quaternion)
		}
		packed.setSplat(kept, center, scales, quaternion, opacity, color)
		kept++
	})
	if (!kept) return null
	packed.numSplats = kept
	packed.needsUpdate = true

	// seatFloor on: pin the detected floor (bounds.floorLocalY) to the plot floor plane.
	// off (debug): bypass all floor logic and seat the content's vertical CENTER instead,
	// so we can see where the raw splat naturally sits relative to the floor grid.
	const seatY = (CULL.seatFloor && !CULL.noFloor) ? bounds.floorLocalY : (bounds.minY + bounds.maxY) / 2
	source.scale.set(renderScaleX, -renderScaleY, renderScaleZ)
	source.position.set(
		-bounds.centerX * renderScaleX,
		SPLAT_CROP.floorY + SPLAT_CROP.floorOffset + seatY * renderScaleY,
		-bounds.centerZ * renderScaleZ,
	)

	// Final-stage yaw applied AFTER the fit/seat as a manual orientation override:
	// WS_SPLAT_ROTATE = 1|2|3|4 -> 90*n degrees about the plot's vertical axis (4 = 360
	// = none). Rotating the seated mesh about the plot centre = rotate the mesh AND
	// post-rotate its seat position by the same yaw (rendered' = Ry * rendered).
	const rot = (((Math.round(CULL.rotate) % 4) + 4) % 4) // 1->90 2->180 3->270 4/0->none
	if (rot) {
		const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (rot * Math.PI) / 2)
		source.quaternion.copy(yaw)
		source.position.applyQuaternion(yaw)
	}

	// The seat lands the splat exactly one content-height too high, so drop the whole
	// splat by its own world-space height to sit the floor on the plane.
	const splatHeight = (bounds.maxY - bounds.minY) * renderScaleY
	if (CULL.seatFloor && !CULL.noFloor) source.position.y -= splatHeight/3

	// Final vertical nudge (WS_CULL_Y_OFFSET), applied after the seat + yaw so it's a
	// pure plot-local Y shift independent of every other transform. Skipped with no floor —
	// the content is already centered, so a floor nudge would just push it off-center.
	if (!CULL.noFloor) source.position.y += CULL.yOffset

	// Plot-local Y the detected floor (ys = floorLocalY) lands at — the seat pins it
	// here regardless of content, so renderScaleY cancels. Stored for the "Splat floor"
	// debug grid to compare against where the ground actually renders.
	plot.splatFloorY = SPLAT_CROP.floorY + SPLAT_CROP.floorOffset + CULL.yOffset

	// The true content AABB in the plot's local space, mirroring the seat transform
	// above: x/z are centered (position cancels centerX/centerZ), y runs from the
	// seated floor up through the flipped height range. A 90/270 yaw swaps the X/Z
	// extents. Stored for the "Bounds" debug overlay so a misplaced splat is obvious.
	const extentX = (bounds.boxX / 2) * renderScaleX
	const extentZ = (bounds.boxZ / 2) * renderScaleZ
	const halfX = rot % 2 ? extentZ : extentX
	const halfZ = rot % 2 ? extentX : extentZ
	const floorBaseY = SPLAT_CROP.floorY + SPLAT_CROP.floorOffset + CULL.yOffset
	const yAtMin = floorBaseY + renderScaleY * (bounds.floorLocalY - bounds.minY)
	const yAtMax = floorBaseY + renderScaleY * (bounds.floorLocalY - bounds.maxY)
	plot.splatBox = new THREE.Box3(
		new THREE.Vector3(-halfX, Math.min(yAtMin, yAtMax), -halfZ),
		new THREE.Vector3(halfX, Math.max(yAtMin, yAtMax), halfZ),
	)

	if (SPLAT_CROP.debug) {
		// Report both floor estimates on the final survivors so the two modes can be
		// compared on a real generation (and against the "Floor" grid toggle).
		const fbox = { minX: bounds.minX, maxX: bounds.maxX, minZ: bounds.minZ, maxZ: bounds.maxZ }
		const keptY = []
		for (let i = 0; i < total; i++) if (keep[i]) keptY.push(ys[i])
		keptY.sort((a, b) => a - b)
		const floorPercentileY = percentile(keptY, SPLAT_CROP.floorPercentile)
		const floorMinY = surfaceFloorLocalY(keep, xs, ys, zs, fbox, "surface_min")
		const floorMedianY = surfaceFloorLocalY(keep, xs, ys, zs, fbox, "surface")
		// min vs median diverging across generations of different height = the height-
		// dependent floor; the gap renders as renderScaleY*(median - min) of vertical shift.
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
			renderScaleY: renderScaleY.toFixed(3),
			floorOffset: SPLAT_CROP.floorOffset,
			floorMode: SPLAT_CROP.floorMode,
			floorStrength: CULL.floorStrength,
			surfaceSigma: SPLAT_CROP.surfaceSigma,
			centerFloorY: centerFloorY.toFixed(3), // gaussian-center floor (pre surface offset)
			floorRadius: floorRadius.toFixed(4), // median vertical gaussian radius near the floor
			surfaceShift: (renderScaleY * (centerFloorY - seatFloorY)).toFixed(3), // world-Y the seat dropped to reach the surface
			seatFloorY: seatFloorY.toFixed(3), // what we actually seat (== bounds.floorLocalY)
			splatHeight: splatHeight.toFixed(3), // world height the splat is dropped by post-seat
			floorMinY: floorMinY.toFixed(3),
			floorMedianY: floorMedianY.toFixed(3),
			floorPercentileY: floorPercentileY.toFixed(3),
		})
	}
	return source
}

renderer.domElement.addEventListener("pointerdown", event => {
	if (event.button !== 0) return
	if (generating) {
		// While generating, only camera movement is allowed — no placing or editing.
		if (focusedPlot) startFocusOrbit(event)
		else startOverviewPan(event)
		return
	}
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
	if (event.key === "Escape" && focusedPlot && !singlePlotMode && !els.generateModal.open) exitFocus()
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

els.showSplatBox?.addEventListener("change", () => {
	showSplatBox = els.showSplatBox.checked
	applyBoundsVisibility()
})

els.showFloor?.addEventListener("change", () => {
	showFloor = els.showFloor.checked
	applyFloorVisibility()
})

els.showSplatFloor?.addEventListener("change", () => {
	showSplatFloor = els.showSplatFloor.checked
	applySplatFloorVisibility()
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
if (singlePlotMode) {
	// Boot straight into a single, already-focused plot (focusPlot handles the
	// plus-tile suppression, camera, and UI sync).
	focusPlot(plots.add(0, 0))
} else {
	plots.syncPlus()
	updateOverviewCamera()
	syncGenerateButton()
	syncFocusUi()
}
requestAnimationFrame(animate)
