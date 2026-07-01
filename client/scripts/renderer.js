import * as THREE from "three"
import { SparkRenderer, SplatMesh } from "spark"
import { zip, unzip } from "fflate"
import { getConfig, newOutput, generateSubject, generateGround, identifyObjects } from "/scripts/api.js"
import { captureObject, captureFloor, captureWorldContext, FRONT_THETA, FRONT_PHI } from "/scripts/capture.js"
import { fitSplatToBox } from "/scripts/fit.js"
import { computeObjects } from "/scripts/geometry.js"
import { clearSelectionOutline, createPrimitive, createSelectionOutline, disposeObject } from "/scripts/primitives.js"
import { addBuild, listBuilds, getBuildSplats, deleteBuild, clearBuilds } from "/scripts/history.js"
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
const scaleAxisDir = new THREE.Vector3()
const tmpScale = new THREE.Vector3()
const tmpWorld = new THREE.Vector3()
const tmpFace = new THREE.Vector3()
const tmpDelta = new THREE.Vector3()
const backgroundColor = new THREE.Color(0xfcfcfc)

const shapeTools = new Set(["box", "sphere", "cylinder", "cone"])
const floorSize = 16 // the single world's ground tile (bigger now that it is its own splat)
const groundThickness = 0.05
const groundTopY = groundThickness // plot-local Y of the ground's top surface
const baseGroundColor = "#587553" // default terrain; painted regions layer on top
const accent = 0xb8ff38

const defaultFitSettings = {
	yOffset: 0,
	opacityFloor: 0.03,
	fitClampK: 0,
	fitBboxPercentile: 0,
	paletteLock: false,
	paletteStrength: 0.75,
	paletteLightness: 0,
	yawDeg: 0,
}
let objectFit = { ...defaultFitSettings }
let floorFit = { ...defaultFitSettings }

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

// Raw splat bytes + subject metadata kept in memory for ZIP export and re-fitting.
// Populated during generateWorld (or uploadZip); cleared at the start of each fresh generation.
const splatStore = new Map()   // name → Uint8Array (unfitted raw bytes)
let sessionSubjects = []        // [{name, kind, yawTurns, fitHeight}] in generation order

// World expansion state. Plots are 16×16 ground tiles laid edge-to-edge; new primitives
// belong to the active plot. The ground is ONE shared surface: generated once then outpainted
// to extend seamlessly into new tiles. groundMaster keeps the last ground image as the
// context the next outpaint continues from.
let activePlotId = 0 // the plot new primitives join and Add-plot grows from
let plotSeq = 0      // last assigned plot id (plot 0 is the base tile)
let groundMaster = null // { imageEl, cols, rows, minIx, minIz } — kept ground for the next expand
const plotHeights = new Map() // plotId → Y offset; drives the ground height-field (hills between plots)

// Debug overlays. "Colliders" re-shows the source primitives as a wireframe over the
// generated splats; "Bounds" draws each splat's seated content AABB.
const colliderColor = 0xb8ff38
const boundsColor = 0x0088ff
let showColliders = false
let showBounds = false

const els = {
	status: document.getElementById("status"),
	progress: document.getElementById("progress"),
	progressFill: document.getElementById("progress_fill"),
	progressLabel: document.getElementById("progress_label"),
	toolButtons: [...document.querySelectorAll("[data-tool]")],
	colorGrid: document.querySelector(".swatch-grid"),
	colorSwatches: [...document.querySelectorAll("[data-color]")],
	addColor: document.getElementById("add_color_btn"),
	customColor: document.getElementById("custom_color_input"),
	brushSwatches: [...document.querySelectorAll("[data-scale]")],
	generate: document.getElementById("generate_btn"),
	chatForm: document.getElementById("chat_form"),
	chatPrompt: document.getElementById("chat_prompt"),
	floorShot: document.getElementById("floor_shot_btn"),
	addPlot: document.getElementById("add_plot_btn"),
	plotDirs: document.getElementById("plot_dirs"),
	plotDirButtons: [...document.querySelectorAll(".plot-dir")],
	uploadSplats: document.getElementById("upload_splats_input"),
	downloadPrims: document.getElementById("download_prims_btn"),
	uploadPrims: document.getElementById("upload_prims_input"),
	downloadZip: document.getElementById("download_zip_btn"),
	uploadZip: document.getElementById("upload_zip_input"),
	showColliders: document.getElementById("show_colliders_input"),
	showBounds: document.getElementById("show_splat_box_input"),
	settingsBtn: document.getElementById("settings_btn"),
	settingsMenu: document.getElementById("settings_menu"),
	settingsPopover: document.getElementById("settings_popover"),
	historyToggle: document.getElementById("history_toggle_btn"),
	historyPanel: document.getElementById("history_panel"),
	historyList: document.getElementById("history_list"),
	historyCount: document.getElementById("history_count"),
	historyClear: document.getElementById("history_clear_btn"),
	historyClose: document.getElementById("history_close_btn"),
	historyEmpty: document.getElementById("history_empty"),
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

// Lazily give a block its own paintable canvas-texture the first time it is drawn on,
// so the paintbrush works on any primitive exactly like it does on the ground. The
// canvas starts filled with the block's current colour so painting layers on top.
function ensurePaintSurface(mesh) {
	if (mesh.userData.isGround) return mesh.userData.paint ?? world.paint
	if (mesh.userData.paint) return mesh.userData.paint
	if (mesh.userData.type === "box") atlasBoxUVs(mesh.geometry)
	mesh.userData.baseColor = mesh.material.color.getHexString() // remember it before white-out
	const surface = createPaintSurface("#" + mesh.material.color.getHexString())
	mesh.material.map = surface.texture
	mesh.material.color.set(0xffffff) // let the painted texture show its true colours
	mesh.material.needsUpdate = true
	mesh.userData.paint = surface
	return surface
}

// A box's six faces all share the same [0,1] UV square, so one canvas would mirror the
// same mark onto every face. Repack the faces into a 3×2 atlas so each paints alone.
function atlasBoxUVs(geometry) {
	if (geometry.userData.atlased) return
	const uv = geometry.attributes.uv
	const cols = 3
	const rows = 2
	for (let face = 0; face < 6; face++) {
		const col = face % cols
		const row = Math.floor(face / cols)
		for (let k = 0; k < 4; k++) {
			const i = face * 4 + k
			uv.setXY(i, (col + uv.getX(i)) / cols, (row + uv.getY(i)) / rows)
		}
	}
	uv.needsUpdate = true
	geometry.userData.atlased = true
}

// Clip the brush to the atlas cell the hit landed in, so a stroke near a face edge
// doesn't bleed into the neighbouring face's cell.
function clipToAtlasCell(ctx, canvas, uv) {
	const cols = 3
	const rows = 2
	const col = Math.min(cols - 1, Math.max(0, Math.floor(uv.x * cols)))
	const row = Math.min(rows - 1, Math.max(0, Math.floor(uv.y * rows)))
	const w = canvas.width / cols
	const h = canvas.height / rows
	ctx.beginPath()
	ctx.rect(col * w, (rows - 1 - row) * h, w, h) // canvas y is flipped versus UV v
	ctx.clip()
}

// A faint ground arrow marking the scene "front": the side every subject is captured
// from, so it gets the crisp detail (build doors / faces toward it).
function createFrontIndicator(size) {
	const dir = new THREE.Vector3().setFromSpherical(new THREE.Spherical(1, Math.PI / 2, FRONT_THETA))
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
		this.floorGenerated = false

		this.paint = createPaintSurface(baseGroundColor)
		this.ground = createPrimitive("box", "ground", {
			position: [0, groundThickness / 2, 0],
			scale: [floorSize, groundThickness, floorSize],
			color: baseGroundColor,
			locked: true,
		})
		this.ground.material.map = this.paint.texture
		this.ground.userData.baseColor = baseGroundColor.replace("#", "")
		this.ground.material.color.set(0xffffff) // let the painted texture show its true colours
		this.ground.material.needsUpdate = true
		this.ground.userData.isGround = true
		this.ground.userData.plotId = 0
		this.ground.userData.origin = new THREE.Vector3(0, 0, 0)
		this.ground.userData.paint = this.paint
		this.group.add(this.ground)
		// Every plot's ground tile lives here; plot 0 is the original at the origin. Add-plot
		// appends adjacent tiles (see addGroundTile / addPlotAt).
		this.groundTiles = [this.ground]

		this.front = createFrontIndicator(floorSize)
		this.group.add(this.front)
	}

	allBlockoutMeshes() {
		return [...this.groundTiles, ...this.primitives]
	}

	raycastables() {
		return [...this.groundTiles, ...this.primitives.filter(mesh => mesh.visible)].filter(mesh => mesh.visible)
	}

	selectables() {
		return [...this.groundTiles, ...this.primitives].filter(mesh => mesh.visible)
	}

	// Set the base ground colour for the WHOLE world — every plot's ground tile, so all floors
	// stay one colour. Each tile keeps its own painted terrain (only pixels matching that tile's
	// previous base colour are swapped); a tile with no matching pixels is filled flat.
	setGroundColor(color) {
		const next = color.replace("#", "").toLowerCase()
		this.baseGroundColor = `#${next}`
		const to = new THREE.Color(`#${next}`)
		const toRgb = [Math.round(to.r * 255), Math.round(to.g * 255), Math.round(to.b * 255)]
		for (const tile of this.groundTiles) {
			const surface = tile.userData.paint
			if (!surface) continue
			const prev = tile.userData.baseColor ?? next
			tile.userData.baseColor = next
			const from = new THREE.Color(`#${prev}`)
			const fromRgb = [Math.round(from.r * 255), Math.round(from.g * 255), Math.round(from.b * 255)]
			const { canvas, ctx, texture } = surface
			const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
			let changed = 0
			for (let i = 0; i < img.data.length; i += 4) {
				if (Math.abs(img.data[i] - fromRgb[0]) > 2 || Math.abs(img.data[i + 1] - fromRgb[1]) > 2 || Math.abs(img.data[i + 2] - fromRgb[2]) > 2) continue
				img.data[i] = toRgb[0]
				img.data[i + 1] = toRgb[1]
				img.data[i + 2] = toRgb[2]
				changed++
			}
			if (changed) ctx.putImageData(img, 0, 0)
			else {
				ctx.fillStyle = `#${next}`
				ctx.fillRect(0, 0, canvas.width, canvas.height)
			}
			texture.needsUpdate = true
		}
	}

	// Target box the floor splat is fitted into: the full tile footprint, seated at y=0.
	floorBox() {
		const half = this.size / 2
		return new THREE.Box3(new THREE.Vector3(-half, 0, -half), new THREE.Vector3(half, groundTopY, half))
	}

	// Add an adjacent ground tile at grid cell (ix, iz) for a new plot. Mirrors the
	// constructor's ground: a thin, locked, paintable slab with its own paint surface.
	addGroundTile(ix, iz, plotId) {
		const cx = ix * floorSize
		const cz = iz * floorSize
		const paint = createPaintSurface(baseGroundColor)
		const tile = createPrimitive("box", "ground", {
			position: [cx, groundThickness / 2, cz],
			scale: [floorSize, groundThickness, floorSize],
			color: baseGroundColor,
			locked: true,
		})
		tile.material.map = paint.texture
		tile.userData.baseColor = baseGroundColor.replace("#", "")
		tile.material.color.set(0xffffff)
		tile.material.needsUpdate = true
		tile.userData.isGround = true
		tile.userData.paint = paint
		tile.userData.plotId = plotId
		tile.userData.origin = new THREE.Vector3(cx, 0, cz)
		this.groundTiles.push(tile)
		this.group.add(tile)
		return tile
	}

	// AABB spanning EVERY ground tile (the whole plot footprint), seated at y=0. The unified
	// expansion ground splat is fitted into this so one surface covers all plots.
	footprintBox() {
		const box = new THREE.Box3()
		const half = floorSize / 2
		for (const tile of this.groundTiles) {
			const { x, z } = tile.userData.origin
			box.expandByPoint(new THREE.Vector3(x - half, 0, z - half))
			box.expandByPoint(new THREE.Vector3(x + half, groundTopY, z + half))
		}
		return box
	}

	// Drop one seated splat by its generation name (e.g. "floor" when re-running the unified
	// ground on each expand), leaving every other plot's splats in place.
	removeGenerated(name) {
		const i = this.generated.findIndex(g => g.mesh.userData.genName === name)
		if (i < 0) return
		disposeObject(this.generated[i].mesh)
		this.generated.splice(i, 1)
	}

	addPrimitive(type, hit) {
		const mesh = createPrimitive(type, `prim_${String(nextPrimitiveId++).padStart(3, "0")}`, { color: activeColor, scaleFactor: activeBrushScale })
		placeMeshOnSurface(mesh, hit)
		this.group.worldToLocal(mesh.position)
		mesh.userData.world = this
		mesh.userData.plotId = activePlotId // which plot this object belongs to (for per-plot builds)
		recordSupport(mesh, hit)
		this.primitives.push(mesh)
		this.group.add(mesh)
		return mesh
	}

	removePrimitive(mesh) {
		const index = this.primitives.indexOf(mesh)
		if (index >= 0) this.primitives.splice(index, 1)
		// Re-seat anything that was resting on the deleted block onto whatever the
		// deleted block was resting on, so the attachment forest has no dangling refs.
		for (const p of this.primitives) {
			if (p.userData.support === mesh) p.userData.support = mesh.userData.support ?? null
		}
		if (selectedPrimitive === mesh) selectPrimitive(null)
		disposeObject(mesh)
	}

	paintAt(hit) {
		const uv = hit.uv
		if (!uv) return
		const surface = ensurePaintSurface(hit.object)
		if (!surface) return
		// Remember each colour painted onto a primitive (or the ground), so it joins that
		// subject's palette for the hue lock — e.g. red berry spots become an available
		// colour, and a painted blue river joins the floor's palette.
		;(hit.object.userData.paintedColors ??= new Set()).add(activeColor)
		const { canvas, ctx, texture } = surface
		const px = uv.x * canvas.width
		const py = (1 - uv.y) * canvas.height
		const radius = Math.max(6, ((activeBrushScale * 0.8) * canvas.width) / this.size)
		ctx.save()
		if (hit.object.userData.type === "box" && !hit.object.userData.isGround) clipToAtlasCell(ctx, canvas, uv)
		ctx.fillStyle = activeColor
		ctx.beginPath()
		ctx.arc(px, py, radius, 0, Math.PI * 2)
		ctx.fill()
		ctx.restore()
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
		this.floorGenerated = true
		for (const tile of this.groundTiles) tile.visible = false
		this.front.visible = false
	}

	// Tear down a previous generation: drop the splats, restore the editable block-out.
	resetGenerated() {
		for (const { mesh } of this.generated) disposeObject(mesh)
		this.generated = []
		this.setBoundsVisible(false)
		this.floorGenerated = false
		for (const tile of this.groundTiles) {
			tile.visible = true
			setColliderStyle(tile, false)
		}
		this.front.visible = true
		for (const primitive of this.primitives) {
			primitive.visible = true
			setColliderStyle(primitive, false)
		}
		this.state = "draft"
		groundMaster = null // a fresh draft invalidates the kept outpaint context
	}

	setCollidersVisible(show) {
		if (this.state !== "generated") return
		for (const tile of this.groundTiles) {
			tile.visible = show || !this.floorGenerated
			setColliderStyle(tile, show)
		}
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
	renderer.domElement.classList.toggle("is-elevating", tool === "elevate")
	syncPlacementPreview()
	updateElevationHandles()
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
	if (selectedPrimitive) {
		if (selectedPrimitive.userData.isGround) world.setGroundColor(color)
		else {
			selectedPrimitive.material.color.set(color)
			selectedPrimitive.userData.baseColor = selectedPrimitive.material.color.getHexString()
		}
	}
	if (placementPreview) {
		placementPreview.material.color.set(color)
		placementPreview.userData.baseColor = placementPreview.material.color.getHexString()
	}
	for (const swatch of els.colorSwatches) {
		swatch.classList.toggle("active", swatch.dataset.color.toLowerCase() === color.toLowerCase())
	}
}

function bindColorSwatch(swatch) {
	swatch.addEventListener("click", () => applyColor(swatch.dataset.color))
}

function addPaletteColor(color) {
	const hex = color.toLowerCase()
	const existing = els.colorSwatches.find(swatch => swatch.dataset.color.toLowerCase() === hex)
	if (existing) {
		applyColor(hex)
		return
	}
	const swatch = document.createElement("button")
	swatch.type = "button"
	swatch.className = "color-swatch btn btn-ghost btn-square"
	swatch.dataset.color = hex
	swatch.setAttribute("aria-label", hex)
	swatch.title = hex
	const dot = document.createElement("span")
	dot.style.background = hex
	swatch.appendChild(dot)
	els.colorGrid.insertBefore(swatch, els.addColor)
	els.colorSwatches.push(swatch)
	bindColorSwatch(swatch)
	applyColor(hex)
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
	const skip = exclude instanceof Set ? exclude : exclude ? new Set([exclude]) : null
	const objects = world.raycastables().filter(mesh => !(skip?.has(mesh)) && !mesh.userData.isSelectionOutline)
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

// --- Attachment graph -------------------------------------------------------
// Every block remembers the block it was seated on (`support`) and which face of
// that support it sits against (`supportAxis`, in the support's local space). The
// support pointers form a forest rooted at blocks resting on the ground; moving or
// scaling a block walks its descendants so seated stacks stay glued face-to-face.

function recordSupport(mesh, hit) {
	const onPrim = Boolean(hit) && !hit.object.userData.isGround && !hit.object.userData.locked && world.primitives.includes(hit.object)
	mesh.userData.support = onPrim ? hit.object : null
	mesh.userData.supportAxis = onPrim ? hitFaceAxis(hit) : { name: "y", sign: 1 }
}

// All blocks transitively seated on `mesh` (its dependents), nearest first.
function collectSubtree(mesh) {
	const out = []
	const seen = new Set([mesh])
	const stack = [mesh]
	while (stack.length) {
		const parent = stack.pop()
		for (const p of world.primitives) {
			if (p.userData.support === parent && !seen.has(p)) {
				seen.add(p)
				out.push(p)
				stack.push(p)
			}
		}
	}
	return out
}

// Local-space centre of the bounding box.
function boundsCenter(mesh, out) {
	if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
	const b = mesh.geometry.boundingBox
	return out.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2)
}

// Local-space centre of the bounding-box face facing `axis` (e.g. {name:"y",sign:1} = top).
function faceLocalPoint(mesh, axis, out) {
	if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
	const b = mesh.geometry.boundingBox
	boundsCenter(mesh, out)
	out[axis.name] = axis.sign > 0 ? b.max[axis.name] : b.min[axis.name]
	return out
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
	theta: FRONT_THETA, // open the editor at the same isometric angle objects are captured from
	phi: FRONT_PHI,
}

function updateCamera() {
	orbit.phi = Math.max(0.12, Math.min(Math.PI * 0.49, orbit.phi))
	orbit.radius = Math.max(4, Math.min(floorSize * 8, orbit.radius)) // headroom to pan/zoom across a multi-plot world
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
	if (mesh.userData.isGround || mesh.userData.locked) return
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
	if (drag.mode === "scale") setupScaleDrag(mesh)
	if (drag.mode === "roll") setupRollDrag(mesh)
	renderer.domElement.setPointerCapture(event.pointerId)
}

// Capture the rotating block's pivot and the start pose of every dependent, so the
// whole stack can turn as one rigid body and seated faces stay connected.
function setupRollDrag(mesh) {
	drag.roll = {
		pivot: mesh.getWorldPosition(new THREE.Vector3()),
		members: collectSubtree(mesh).map(m => ({
			mesh: m,
			startPos: m.getWorldPosition(new THREE.Vector3()),
			startQuat: m.quaternion.clone(),
		})),
	}
}

// Capture everything the scale drag needs: the on-screen direction of each local
// axis (so the drag direction can pick one), the seated face to pin, and the start
// state of every dependent block so they can be re-glued to the moving faces.
function setupScaleDrag(mesh) {
	mesh.updateWorldMatrix(true, false)
	const center = mesh.getWorldPosition(new THREE.Vector3())
	const worldQuat = mesh.getWorldQuaternion(new THREE.Quaternion())
	const centerScreen = objectScreenPosition(center)
	const screenAxis = {}
	for (const name of ["x", "y", "z"]) {
		scaleAxisDir.set(0, 0, 0)
		scaleAxisDir[name] = 1
		scaleAxisDir.applyQuaternion(worldQuat).multiplyScalar(0.5).add(center)
		const tip = objectScreenPosition(scaleAxisDir)
		const sx = tip.x - centerScreen.x
		const sy = tip.y - centerScreen.y
		const len = Math.hypot(sx, sy) || 1
		screenAxis[name] = { x: sx / len, y: sy / len }
	}
	const bottomLocal = faceLocalPoint(mesh, { name: "y", sign: -1 }, new THREE.Vector3())
	const anchorWorld = mesh.localToWorld(bottomLocal.clone())
	const children = []
	for (const child of world.primitives) {
		if (child.userData.support !== mesh) continue
		const axis = child.userData.supportAxis ?? { name: "y", sign: 1 }
		const faceLocal = faceLocalPoint(mesh, axis, new THREE.Vector3())
		const subtree = [child, ...collectSubtree(child)]
		children.push({
			faceLocal,
			startFaceWorld: mesh.localToWorld(faceLocal.clone()),
			subtree,
			startPos: subtree.map(m => m.position.clone()),
		})
	}
	drag.scale = { mesh, worldQuat, screenAxis, bottomLocal, anchorWorld, children }
}

function updatePrimitiveDrag(event) {
	if (drag.mode === "scale") {
		updateScaleDrag(event)
		return
	}
	if (drag.mode === "roll") {
		const delta = pointerScreenAngle(event, drag.rollCenter) - drag.startAngle
		rollQuat.setFromAxisAngle(drag.rollAxis, delta)
		drag.mesh.quaternion.copy(rollQuat).multiply(drag.startQuaternion)
		drag.mesh.userData.manualRotation = true
		// Orbit each dependent around the rotating block's centre and spin it by the same
		// amount, so the whole stack turns rigidly and stays face-to-face.
		for (const m of drag.roll.members) {
			tmpWorld.copy(m.startPos).sub(drag.roll.pivot).applyQuaternion(rollQuat).add(drag.roll.pivot)
			world.group.worldToLocal(tmpWorld)
			m.mesh.position.copy(tmpWorld)
			m.mesh.quaternion.copy(rollQuat).multiply(m.startQuat)
			m.mesh.userData.manualRotation = true
		}
		return
	}
	// Move: re-seat the block on whatever is under the cursor, then carry its whole
	// dependent stack by the same delta so attached blocks travel with their root.
	const subtree = collectSubtree(drag.mesh)
	const hit = surfaceHit(event, new Set([drag.mesh, ...subtree]))
	if (!hit) return
	const before = drag.mesh.position.clone()
	placeMeshOnSurface(drag.mesh, hit)
	world.group.worldToLocal(drag.mesh.position)
	tmpDelta.copy(drag.mesh.position).sub(before)
	for (const d of subtree) d.position.add(tmpDelta)
	recordSupport(drag.mesh, hit)
}

function updateScaleDrag(event) {
	const s = drag.scale
	const dx = event.clientX - drag.startX
	const dy = event.clientY - drag.startY
	// Lock to one axis on the first decisive movement and keep it until release, so a
	// scale never wanders onto another axis mid-drag.
	if (!s.axis) {
		if (Math.hypot(dx, dy) < 4) return // wait for a deliberate drag before committing
		let best = -1
		for (const name of ["x", "y", "z"]) {
			const sa = s.screenAxis[name]
			const p = Math.abs(dx * sa.x + dy * sa.y)
			if (p > best) {
				best = p
				s.axis = name
			}
		}
	}
	const axis = s.axis
	const sa = s.screenAxis[axis]
	const proj = dx * sa.x + dy * sa.y
	const factor = Math.min(6, Math.max(0.15, 1 + proj * 0.01))
	const newScale = drag.startScale.clone()
	newScale[axis] = drag.startScale[axis] * factor
	s.mesh.scale.copy(newScale)
	// Pin the seated (bottom) face so the block keeps touching its support instead of
	// growing symmetrically about its centre.
	tmpScale.copy(s.bottomLocal).multiply(newScale).applyQuaternion(s.worldQuat)
	tmpWorld.copy(s.anchorWorld).sub(tmpScale)
	world.group.worldToLocal(tmpWorld)
	s.mesh.position.copy(tmpWorld)
	s.mesh.updateWorldMatrix(true, false)
	// Drag every dependent stack along with the face it is seated on.
	for (const rec of s.children) {
		tmpFace.copy(rec.faceLocal)
		s.mesh.localToWorld(tmpFace)
		tmpDelta.copy(tmpFace).sub(rec.startFaceWorld)
		for (let i = 0; i < rec.subtree.length; i++) {
			rec.subtree[i].position.copy(rec.startPos[i]).add(tmpDelta)
		}
	}
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
	const hit = raycast(event, world.raycastables())
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
		if (raycast(event, world.raycastables())) startPaint(event)
		else startOrbit(event)
		return
	}

	if (shapeTools.has(activeTool)) {
		const hit = surfaceHit(event)
		if (hit) world.addPrimitive(activeTool, hit)
		else startOrbit(event)
		return
	}

	if (activeTool === "elevate") {
		// Pick a plot by its (translucent) ground-tile handle, then drag vertically to set height.
		const hit = raycast(event, world.groundTiles.filter(t => t.visible))
		if (hit?.object) {
			selectPrimitive(null)
			const pid = hit.object.userData.plotId
			drag = { mode: "elevate", pointerId: event.pointerId, plotId: pid, tile: hit.object, startY: event.clientY, startH: plotHeights.get(pid) || 0 }
			renderer.domElement.setPointerCapture(event.pointerId)
		} else {
			startOrbit(event)
		}
		return
	}

	// pointer / scale / rotate / eraser act on a selectable block-out mesh under the cursor.
	const hit = raycast(event, world.selectables())
	if (hit?.object) {
		if (activeTool === "eraser") {
			if (hit.object.userData.isGround || hit.object.userData.locked) {
				selectPrimitive(hit.object)
				return
			}
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
	else if (drag?.mode === "elevate") updateElevateDrag(event)
	else if (drag && ["primitive", "scale", "roll"].includes(drag.mode)) updatePrimitiveDrag(event)
	else updatePlacement(event)
})

renderer.domElement.addEventListener("pointerup", event => {
	if (drag?.pointerId === event.pointerId) {
		if (drag.mode === "elevate") applyGroundDeform() // re-shape the ground splat once, on release
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

// Run `worker` over `items` with at most `limit` in flight at once (bounded concurrency).
async function runPool(items, limit, worker) {
	let next = 0
	const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const i = next++
			await worker(items[i], i)
		}
	})
	await Promise.all(runners)
}

// The unique hex colours of an object's primitives (painted blocks report their pre-paint
// base colour). Sent with the subject so the server can lock the generated texture's hues
// to exactly these — instant and exact, no palette-guessing from the screenshot.
function primitiveColors(primitives) {
	const colors = new Set()
	for (const mesh of primitives) {
		colors.add("#" + (mesh.userData.baseColor ?? mesh.material.color.getHexString()))
		if (mesh.userData.paintedColors) for (const c of mesh.userData.paintedColors) colors.add(c)
	}
	return [...colors]
}

function fitSettingsFromConfig(cfg, kind) {
	const scoped = cfg?.[kind] ?? {}
	const legacy = {
		yOffset: kind === "object" ? cfg?.yOffset : 0,
		opacityFloor: cfg?.opacityFloor,
		fitClampK: cfg?.fitClampK,
		fitBboxPercentile: cfg?.fitBboxPercentile,
		paletteLock: cfg?.paletteLock,
		paletteStrength: cfg?.paletteStrength,
		paletteLightness: cfg?.paletteLightness,
		yaw: kind === "floor" ? cfg?.floorYaw : cfg?.objectYaw,
	}
	const value = (key, fallbackKey = key) => (
		scoped[key] ?? scoped[fallbackKey] ?? legacy[key] ?? legacy[fallbackKey] ?? defaultFitSettings[key] ?? defaultFitSettings[fallbackKey]
	)
	const number = (key, fallbackKey = key) => {
		const n = Number(value(key, fallbackKey))
		return Number.isFinite(n) ? n : defaultFitSettings[key]
	}
	return {
		yOffset: number("yOffset"),
		opacityFloor: number("opacityFloor"),
		fitClampK: number("fitClampK"),
		fitBboxPercentile: number("fitBboxPercentile"),
		paletteLock: Boolean(value("paletteLock")),
		paletteStrength: number("paletteStrength"),
		paletteLightness: number("paletteLightness"),
		yawDeg: number("yawDeg", "yaw"),
	}
}

function applyRuntimeConfig(cfg) {
	objectFit = fitSettingsFromConfig(cfg, "object")
	floorFit = fitSettingsFromConfig(cfg, "floor")
}

function fitSettingsFor(kind) {
	return kind === "floor" ? floorFit : objectFit
}

// Generate the whole world: capture every subject's guide serially (the captures share
// the renderer, so they can't overlap), then re-texture + reconstruct them CONCURRENTLY
// (the per-subject image edit + Tripo call is network-bound and the real bottleneck).
// Each splat is seated as it returns; concurrency is bounded by WS_GEN_CONCURRENCY.
async function generateWorld(prompt) {
	if (generating) return
	generating = true
	world.prompt = prompt
	syncGenerateButton()
	setStatus("")
	world.resetGenerated()

	// Debug flags (server env, surfaced via /api/config): WS_SINGLE_OBJECT generates only
	// the first object and skips the floor; WS_OBJECTS_ONLY generates every object but
	// skips the floor (the painted ground stays as a primitive); WS_FLOOR_ONLY generates
	// only the floor and skips every object; WS_IDENTIFY_ONLY stops after the Gemini
	// identification phase (logs the numbered graphic + labels, generates nothing).
	const cfg = await getConfig()
	applyRuntimeConfig(cfg)
	const { singleObject, objectsOnly, floorOnly, identifyOnly, genConcurrency } = cfg
	const concurrency = Math.max(1, Math.floor(genConcurrency || 1)) // WS_GEN_CONCURRENCY: subjects in flight at once
	let objects = computeObjects(world.primitives)
	if (floorOnly) objects = []
	else if (singleObject) objects = objects.slice(0, 1)
	const doFloor = floorOnly || (!singleObject && !objectsOnly)
	const total = objects.length + (doFloor ? 1 : 0)
	let done = 0
	showProgress(0, total, singleObject ? "Preparing (single-object test)…" : "Preparing…")

	try {
		const genStart = performance.now()
		const subjectTimes = []
		let idMs = 0
		let captureMs = 0
		let output = null
		try {
			output = (await newOutput()).index
		} catch {
			// non-fatal: generation still works, just won't be saved under outputs/NNNN
		}

		// 0. Identification: name each object from a numbered whole-world context capture
		// so each is generated as the right thing (a boulder in a "forest" stays a boulder,
		// not a stump). Best-effort — on any failure we fall back to scene-context prompting.
		let labels = {}
		let groundDesc = "" // Gemini's terrain description; used as the floor's texturing prompt
		const tId = performance.now()
		if (objects.length) {
			showProgress(done, total, "Identifying objects…")
			try {
				const context = await captureWorldContext(renderer, scene, world, objects)
				const identified = await identifyObjects({ image: context, scene: prompt, count: objects.length, output })
				labels = identified.labels
				groundDesc = identified.ground
			} catch {
				labels = {}
			}
		}
		idMs = performance.now() - tId

		// WS_IDENTIFY_ONLY: stop here — the numbered graphic + Gemini labels are already
		// logged under outputs/NNNN; surface the result and generate nothing.
		if (identifyOnly) {
			const summary = Object.keys(labels).length
				? Object.entries(labels).map(([n, label]) => `${n}: ${label}`).join("  ·  ")
				: "no labels returned"
			console.log("[identify-only] labels:", labels, "ground:", groundDesc)
			setStatus(`Identified — ${summary}`)
			hideProgress()
			return
		}

		// 1. Capture every subject's guide SERIALLY (captures share the renderer + scene, so
		// they can't overlap) while the block-out is still fully intact. Floor first (if
		// enabled), then each object. Only the guide is sent — it already carries the flat
		// material colours + painted terrain, so the material-ID map is redundant and skipping
		// it halves the per-call input-image cost on the cheap gpt-image-1-mini path.
		const tCap = performance.now()
		const subjects = []
		if (doFloor) {
			showProgress(done, total, "Capturing floor…")
			const cap = await captureFloor(renderer, scene, world)
			subjects.push({
				kind: "floor", image: cap.guide, box: world.floorBox(), name: "floor", isFloor: true,
				prompt: groundDesc || prompt, // Gemini's terrain description (falls back to the scene prompt)
				groundColor: world.baseGroundColor, yawTurns: FLOOR_YAW_TURNS, yawDeg: floorFit.yawDeg, yOffset: floorFit.yOffset,
				primitives: null, colors: primitiveColors([world.ground]), // base ground + painted terrain colours
			})
		}
		for (let i = 0; i < objects.length; i++) {
			showProgress(done, total, `Capturing object ${i + 1} of ${objects.length}…`)
			const cap = await captureObject(renderer, scene, world, objects[i])
			subjects.push({
				kind: "object", image: cap.guide, box: objects[i].box, name: `obj-${String(i + 1).padStart(3, "0")}`,
				prompt, label: labels[String(i + 1)] || "", // server sets object steps/guidance/gaussian count
				yawTurns: OBJECT_YAW_TURNS, yawDeg: objectFit.yawDeg, yOffset: objectFit.yOffset, fitHeight: true, primitives: objects[i].primitives,
				colors: primitiveColors(objects[i].primitives),
			})
		}
		captureMs = performance.now() - tCap

		// 2. Re-texture + reconstruct every subject CONCURRENTLY (bounded by `concurrency`).
		// The image edit + Tripo call is the per-subject bottleneck and parallelises cleanly;
		// each splat is seated as it returns. Nothing here touches the shared renderer.
		done = 0
		splatStore.clear()
		sessionSubjects = []
		showProgress(0, total, concurrency > 1 ? "Generating (concurrent)…" : "Generating…")
		await runPool(subjects, concurrency, async s => {
			const tReq = performance.now()
			try {
				const bytes = await generateSubject({
					prompt: s.prompt, kind: s.kind, steps: s.steps, gaussians: s.gaussians,
					output, name: s.name, label: s.label, groundColor: s.groundColor, colors: s.colors, image: s.image,
				})
				const requestMs = performance.now() - tReq // server-side image edit + Tripo (see server [timing] log)
				const tSeat = performance.now()
				await seatSubject(bytes, s.box, s.name, s.primitives, { kind: s.kind, yawTurns: s.yawTurns, yawDeg: s.yawDeg, yOffset: s.yOffset, fitHeight: Boolean(s.fitHeight), colors: s.colors })
				subjectTimes.push({ subject: s.name, "request(s)": +(requestMs / 1000).toFixed(2), "seat(ms)": Math.round(performance.now() - tSeat) })
				if (s.isFloor) world.groundGenerated()
				splatStore.set(s.name, bytes)
			} catch (error) {
				console.warn(`${s.name}:`, error.message)
			}
			done++
			showProgress(done, total)
		})
		// Build subject metadata for ZIP export / re-fitting (only successfully seated subjects).
		sessionSubjects = subjects
			.filter(s => splatStore.has(s.name))
			.map(s => ({ name: s.name, kind: s.kind ?? "object", yawTurns: s.yawTurns ?? 0, fitHeight: Boolean(s.fitHeight) }))

		const totalS = ((performance.now() - genStart) / 1000).toFixed(1)
		const genS = ((performance.now() - genStart - idMs - captureMs) / 1000).toFixed(1)
		console.log(`[timing] total ${totalS}s — identify ${(idMs / 1000).toFixed(1)}s · capture ${(captureMs / 1000).toFixed(1)}s · generate+seat ${genS}s (×${concurrency} concurrent)`)
		console.table(subjectTimes)

		world.state = "generated"
		applyOverlayVisibility()
		saveBuildToHistory(world.prompt) // snapshot this completed build into the history panel (best-effort)
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

// Reconstruct + seat one subject's splat into its target box. `colors` (hex palette) drives
// the optional splat-side palette lock when it's enabled in config.
async function seatSubject(bytes, box, name, sourcePrimitives, { kind = "object", yawTurns = 0, yawDeg = 0, yOffset = 0, fitHeight = false, fillXZ = false, colors = null, fileName = `${name}.splat` } = {}) {
	const raw = new SplatMesh({ fileBytes: bytes, fileName })
	await raw.initialized
	const fit = fitSettingsFor(kind)
	const fitted = await fitSplatToBox(raw, box, {
		yawTurns,
		yawDeg,
		yOffset,
		fitHeight,
		fillXZ, // unified ground: fill a rectangular multi-tile footprint exactly on X/Z
		opacityFloor: fit.opacityFloor,
		clampK: fit.fitClampK,
		spanLo: fit.fitBboxPercentile,
		spanHi: 1 - fit.fitBboxPercentile,
		palette: fit.paletteLock && colors?.length ? colors : null,
		paletteStrength: fit.paletteStrength,
		paletteLightness: fit.paletteLightness,
	})
	if (!fitted) {
		disposeObject(raw)
		throw new Error(`${name}: splat had no usable bounds after culling`)
	}
	fitted.userData.genName = name
	fitted.userData.genKind = kind
	fitted.userData.genPlotId = kind === "floor" ? null : (sourcePrimitives?.[0]?.userData?.plotId ?? 0)
	// Footprint centre + base Y, so elevation can stick the object to the deformed ground surface
	// under it and tilt it to the slope normal there.
	fitted.userData.seatX = (box.min.x + box.max.x) / 2
	fitted.userData.seatZ = (box.min.z + box.max.z) / 2
	fitted.userData.seatBaseY = box.min.y
	world.addGenerated(fitted, sourcePrimitives || [])
}

// --- World expansion ("Add plot") -------------------------------------------
// Plots are 16×16 ground tiles laid edge-to-edge (no gap → seamless). Objects are generated
// per-plot (incrementally — a new plot's objects can't exist before it does), but the GROUND
// is one shared surface: generated once, then OUTPAINTED to extend into each new tile so it
// continues seamlessly (same colour/material, no seam) and is reconstructed as a SINGLE splat
// spanning every plot. groundMaster keeps the last ground image as the next outpaint's context.

function cellOf(origin) {
	return { ix: Math.round(origin.x / floorSize), iz: Math.round(origin.z / floorSize) }
}

function occupiedCells() {
	const set = new Set()
	for (const tile of world.groundTiles) {
		const c = cellOf(tile.userData.origin)
		set.add(`${c.ix},${c.iz}`)
	}
	return set
}

function activeCell() {
	const tile = world.groundTiles.find(t => t.userData.plotId === activePlotId) ?? world.groundTiles[0]
	return cellOf(tile.userData.origin)
}

// First free grid cell from the active plot along a chosen grid direction (dx, dz ∈ {-1,0,1}):
// step outward until an empty cell is found, so a side already occupied grows past its tiles.
function cellInDirection(dx, dz) {
	const occ = occupiedCells()
	const base = activeCell()
	let ix = base.ix + dx, iz = base.iz + dz
	while (occ.has(`${ix},${iz}`)) { ix += dx; iz += dz }
	return { ix, iz }
}

// Map the picker's on-screen slots (up/down/left/right) to the WORLD grid directions that
// currently appear that way, by projecting the active cell's four neighbours to screen space.
// Recomputed every time the picker opens, so the arrows always follow the camera. The two grid
// axes project to opposite screen vectors, so we split them into the more-horizontal pair
// (left/right) and the more-vertical pair (up/down) for a clean, unambiguous assignment.
function screenDirsForActiveCell() {
	const base = activeCell()
	const cx = base.ix * floorSize, cz = base.iz * floorSize
	const c0 = new THREE.Vector3(cx, 0, cz).project(camera)
	const screenDelta = (dx, dz) => {
		const p = new THREE.Vector3(cx + dx * floorSize, 0, cz + dz * floorSize).project(camera)
		return { dx, dz, sx: p.x - c0.x, sy: p.y - c0.y } // NDC delta; +sy is up on screen
	}
	const xAxis = screenDelta(1, 0) // world +X
	const zAxis = screenDelta(0, 1) // world +Z
	// "Horizontalness" of each axis on screen: how much it runs sideways vs up/down.
	const xHoriz = Math.abs(xAxis.sx) - Math.abs(xAxis.sy)
	const zHoriz = Math.abs(zAxis.sx) - Math.abs(zAxis.sy)
	const horiz = xHoriz >= zHoriz ? xAxis : zAxis // axis that maps to left/right
	const vert = horiz === xAxis ? zAxis : xAxis    // the other → up/down
	const along = (a, sign) => ({ dx: sign * a.dx, dz: sign * a.dz })
	return {
		right: along(horiz, horiz.sx >= 0 ? 1 : -1),
		left: along(horiz, horiz.sx >= 0 ? -1 : 1),
		up: along(vert, vert.sy >= 0 ? 1 : -1),
		down: along(vert, vert.sy >= 0 ? -1 : 1),
	}
}

// The bounding grid rectangle of every tile = the ground image footprint.
function footprint() {
	let minIx = Infinity, maxIx = -Infinity, minIz = Infinity, maxIz = -Infinity
	for (const tile of world.groundTiles) {
		const c = cellOf(tile.userData.origin)
		minIx = Math.min(minIx, c.ix); maxIx = Math.max(maxIx, c.ix)
		minIz = Math.min(minIz, c.iz); maxIz = Math.max(maxIz, c.iz)
	}
	return { minIx, maxIx, minIz, maxIz, cols: maxIx - minIx + 1, rows: maxIz - minIz + 1 }
}

function orderedPlotIds() {
	return world.groundTiles.map(t => t.userData.plotId)
}

function plotPrimitives(plotId) {
	return world.primitives.filter(p => (p.userData.plotId ?? 0) === plotId)
}

// Plot ids whose objects are already seated, so a rebuild skips them (they stay frozen).
function builtPlotIds() {
	const set = new Set()
	for (const g of world.generated) {
		const m = g.mesh
		if (m.userData.genKind === "floor") continue
		if (m.userData.genPlotId != null) set.add(m.userData.genPlotId)
	}
	return set
}

// OpenAI edit accepts only three sizes; pick the one matching the footprint aspect.
function groundImageSize(cols, rows) {
	if (cols > rows) return { w: 1536, h: 1024, label: "1536x1024" }
	if (rows > cols) return { w: 1024, h: 1536, label: "1024x1536" }
	return { w: 1024, h: 1024, label: "1024x1024" }
}

function canvasToBlob(canvas, type = "image/png") {
	return new Promise(resolve => canvas.toBlob(resolve, type))
}

function blobToImage(blob) {
	return new Promise((resolve, reject) => {
		const img = new Image()
		img.onload = () => resolve(img)
		img.onerror = reject
		img.src = URL.createObjectURL(blob)
	})
}

// Average colour of an already-generated ground image, so a NEW plot's ground can be locked to
// the EXACT colour of the plot it grows from (not just the block-out base). Downscales to blend
// out texture; skips transparent + near-black pixels (tile edges / deep shadow). Returns #rrggbb.
function sampleImageColor(imageEl) {
	const n = 24
	const c = document.createElement("canvas")
	c.width = n; c.height = n
	const ctx = c.getContext("2d", { willReadFrequently: true })
	ctx.drawImage(imageEl, 0, 0, n, n)
	const data = ctx.getImageData(0, 0, n, n).data
	let r = 0, g = 0, b = 0, count = 0
	for (let i = 0; i < data.length; i += 4) {
		if (data[i + 3] < 128) continue // skip transparent
		if (data[i] + data[i + 1] + data[i + 2] < 40) continue // skip near-black edges/shadow
		r += data[i]; g += data[i + 1]; b += data[i + 2]; count++
	}
	if (!count) return null
	const hx = v => Math.round(v / count).toString(16).padStart(2, "0")
	return `#${hx(r)}${hx(g)}${hx(b)}`
}

// Compose the ground image (+ outpaint mask) for the whole footprint. World +X → image right,
// world +Z → image down. The kept master is drawn into its sub-region and marked OPAQUE in the
// mask (preserve); newly-added tiles draw their painted guide and stay TRANSPARENT in the mask
// (repaint as a seamless continuation). With no master yet, the whole canvas is generated fresh
// (one coherent image → seamless by construction). Returns { canvas, mask|null }.
function buildGroundComposite(fp, size) {
	const { w, h } = size
	const cellW = w / fp.cols
	const cellH = h / fp.rows
	const canvas = document.createElement("canvas")
	canvas.width = w; canvas.height = h
	const ctx = canvas.getContext("2d")
	ctx.fillStyle = baseGroundColor
	ctx.fillRect(0, 0, w, h)

	const haveMaster = Boolean(groundMaster?.imageEl)
	let mask = null
	if (haveMaster) {
		mask = document.createElement("canvas")
		mask.width = w; mask.height = h
		const mctx = mask.getContext("2d")
		mctx.clearRect(0, 0, w, h) // transparent everywhere = repaint by default
		const mx = (groundMaster.minIx - fp.minIx) * cellW
		const my = (groundMaster.minIz - fp.minIz) * cellH
		const mw = groundMaster.cols * cellW
		const mh = groundMaster.rows * cellH
		ctx.drawImage(groundMaster.imageEl, mx, my, mw, mh)
		mctx.fillStyle = "rgba(255,255,255,1)" // opaque = preserve the existing terrain
		mctx.fillRect(mx, my, mw, mh)
	}

	// Paint guide for every tile not already covered by the master.
	for (const tile of world.groundTiles) {
		const c = cellOf(tile.userData.origin)
		const inMaster = haveMaster &&
			c.ix >= groundMaster.minIx && c.ix < groundMaster.minIx + groundMaster.cols &&
			c.iz >= groundMaster.minIz && c.iz < groundMaster.minIz + groundMaster.rows
		if (inMaster) continue
		const x = (c.ix - fp.minIx) * cellW
		const y = (c.iz - fp.minIz) * cellH
		const paint = tile.userData.paint
		if (paint?.canvas) ctx.drawImage(paint.canvas, x, y, cellW, cellH)
	}
	return { canvas, mask }
}

// Drop an adjacent plot at a specific grid cell, made active so new objects join it. Build on
// it, then Generate extends the ground into it seamlessly.
function addPlotAt(cell) {
	if (generating) return
	const plotId = ++plotSeq
	world.addGroundTile(cell.ix, cell.iz, plotId)
	activePlotId = plotId
	selectPrimitive(null)
	frameOrbitOnCell(cell)
	setActiveTool("box")
	setStatus("New plot added — build on it, then Generate. The ground extends seamlessly from your existing world.")
}

// Place the (fixed-position) picker centred above the Add-plot button, clamped to the viewport.
// Must be called while the picker is visible so its size can be measured.
function positionPlotDirs() {
	const br = els.addPlot.getBoundingClientRect()
	const pr = els.plotDirs.getBoundingClientRect()
	let left = br.left + br.width / 2 - pr.width / 2
	left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8))
	const top = Math.max(8, br.top - pr.height - 8)
	els.plotDirs.style.left = `${left}px`
	els.plotDirs.style.top = `${top}px`
}

// Open/close the directional picker for the Add-plot button. On open, re-map its arrows to the
// current camera view so "up" always grows the far side, etc., then position it over the button.
function togglePlotDirs(open) {
	if (!els.plotDirs) return
	const next = open ?? els.plotDirs.classList.contains("hidden")
	if (next && generating) return
	if (next) {
		const dirs = screenDirsForActiveCell()
		for (const btn of els.plotDirButtons) {
			const d = dirs[btn.dataset.pos]
			if (!d) continue
			btn.dataset.dx = String(d.dx)
			btn.dataset.dz = String(d.dz)
		}
		els.plotDirs.classList.remove("hidden") // unhide first so getBoundingClientRect has a size
		positionPlotDirs()
	} else {
		els.plotDirs.classList.add("hidden")
	}
	els.addPlot?.classList.toggle("active", next)
	els.addPlot?.setAttribute("aria-expanded", String(next))
}

function frameOrbitOnCell(cell) {
	orbit.target.set(cell.ix * floorSize, floorSize * 0.05, cell.iz * floorSize)
	orbit.radius = Math.max(orbit.radius, floorSize * 1.4)
	updateCamera()
}

// --- Plot elevation (hills) -------------------------------------------------
// Raising a plot deforms the ONE unified ground splat via a smooth height field: flat at each
// plot's own height near its centre, ramping between plots so a raised plot reads as a hill.
// The field is a Gaussian-weighted blend of plot heights by distance to each plot's centre.

function heightAt(x, z) {
	let wsum = 0, hsum = 0
	const sigma = floorSize * 0.5 // ramp width — smaller = steeper hills, larger = gentler
	const s2 = 2 * sigma * sigma
	for (const tile of world.groundTiles) {
		const h = plotHeights.get(tile.userData.plotId) || 0
		const dx = x - tile.userData.origin.x
		const dz = z - tile.userData.origin.z
		const w = Math.exp(-(dx * dx + dz * dz) / s2)
		wsum += w
		hsum += w * h
	}
	return wsum > 0 ? hsum / wsum : 0
}

// Displace every ground gaussian in Y by the height field, always recomputed from the flat
// baseline (captured once) so repeated edits never compound.
function deformGround(mesh) {
	const packed = mesh.packedSplats
	if (!packed?.numSplats) return
	let base = mesh.userData.groundBase
	if (!base) {
		const n = packed.numSplats
		const xs = new Float32Array(n), ys = new Float32Array(n), zs = new Float32Array(n)
		packed.forEachSplat((i, c) => { xs[i] = c.x; ys[i] = c.y; zs[i] = c.z })
		base = mesh.userData.groundBase = { xs, ys, zs }
	}
	packed.forEachSplat((i, center, scales, quaternion, opacity, color) => {
		center.set(base.xs[i], base.ys[i] + heightAt(base.xs[i], base.zs[i]), base.zs[i])
		packed.setSplat(i, center, scales, quaternion, opacity, color)
	})
	packed.needsUpdate = true
}

function applyGroundDeform() {
	const g = world.generated.find(x => x.mesh.userData.genName === "floor")
	if (g) deformGround(g.mesh)
}

// Seat one object splat ON the deformed ground: lift its base to the surface height at its own
// footprint (stick to the plane) AND tilt it so its up-axis matches the slope normal there.
// fit.js baked world coords into the gaussians with an identity mesh transform, so we compose
// position+quaternion to rotate about the object's BASE (not the world origin): the object
// worldPos = q·(P − base) + base + (0, surfaceY, 0).
function seatObjectOnGround(mesh) {
	const x = mesh.userData.seatX
	const z = mesh.userData.seatZ
	const baseY = mesh.userData.seatBaseY ?? 0
	if (x == null || z == null) { // uploaded/legacy splat with no footprint — flat lift only
		const pid = mesh.userData.genPlotId
		mesh.quaternion.identity()
		mesh.position.set(0, pid != null ? (plotHeights.get(pid) || 0) : 0, 0)
		return
	}
	const eps = Math.max(0.25, floorSize * 0.04)
	const gradX = (heightAt(x + eps, z) - heightAt(x - eps, z)) / (2 * eps)
	const gradZ = (heightAt(x, z + eps) - heightAt(x, z - eps)) / (2 * eps)
	const normal = new THREE.Vector3(-gradX, 1, -gradZ).normalize()
	const q = new THREE.Quaternion().setFromUnitVectors(localUp, normal)
	const base = new THREE.Vector3(x, baseY, z)
	mesh.quaternion.copy(q)
	mesh.position.copy(base).sub(base.clone().applyQuaternion(q)) // pivot the rotation about the base
	mesh.position.y += heightAt(x, z) // then lift the base onto the surface
}

// Re-seat every plot's objects + the ground to the current plot heights (after a (re)build).
function applyAllPlotHeights() {
	for (const g of world.generated) {
		if (g.mesh.userData.genKind === "floor") continue
		seatObjectOnGround(g.mesh)
	}
	applyGroundDeform()
}

// Show the ground tiles as translucent grab-handles (at their plot heights) while the elevate
// tool is active; otherwise restore them (hidden once generated, normal in draft).
function updateElevationHandles() {
	const show = activeTool === "elevate"
	for (const tile of world.groundTiles) {
		tile.material.transparent = show
		tile.material.opacity = show ? 0.5 : 1
		tile.material.depthWrite = !show
		tile.material.needsUpdate = true
		tile.position.y = groundThickness / 2 + (plotHeights.get(tile.userData.plotId) || 0)
		tile.visible = show || !world.floorGenerated
	}
}

// Drag a selected plot up/down: update its height, move the handle + lift its objects live
// (block-out prims carried by delta). The ground splat re-deforms on pointer-up (heavier).
function updateElevateDrag(event) {
	const h = drag.startH + (drag.startY - event.clientY) * 0.03 // px → world units, up = raise
	const clamped = Math.max(-floorSize, Math.min(floorSize, h))
	const pid = drag.plotId
	const delta = clamped - (plotHeights.get(pid) || 0)
	plotHeights.set(pid, clamped)
	drag.tile.position.y = groundThickness / 2 + clamped
	// Re-seat EVERY object onto the surface (a plot's height also tilts objects on neighbouring
	// plots near the shared seam). Objects follow the height field + tilt to the slope; cheap.
	for (const g of world.generated) if (g.mesh.userData.genKind !== "floor") seatObjectOnGround(g.mesh)
	for (const p of world.primitives) if ((p.userData.plotId ?? 0) === pid) p.position.y += delta
	setStatus(`Plot ${pid} height ${clamped >= 0 ? "+" : ""}${clamped.toFixed(1)} — release to shape the ground`)
}

// Generate / extend a multi-plot world: rebuild the UNIFIED ground (outpainting it to grow
// seamlessly), then generate objects only for plots not yet built (existing plots stay
// frozen). One ground splat spans every plot, so there is never a seam.
async function generateExpanded(prompt) {
	if (generating) return
	generating = true
	world.prompt = prompt
	syncGenerateButton()
	setStatus("")

	const cfg = await getConfig()
	applyRuntimeConfig(cfg)
	const concurrency = Math.max(1, Math.floor(cfg.genConcurrency || 1))

	const already = builtPlotIds()
	const toBuild = orderedPlotIds().filter(pid => !already.has(pid) && plotPrimitives(pid).length)
	let totalObjects = 0
	for (const pid of toBuild) totalObjects += computeObjects(plotPrimitives(pid)).length
	const total = 1 + totalObjects // 1 = the unified ground
	let done = 0
	showProgress(0, total, "Preparing expansion…")

	try {
		let output = null
		try { output = (await newOutput()).index } catch {}

		// 1. UNIFIED GROUND — one splat spanning the whole footprint, outpainted to extend.
		showProgress(done, total, groundMaster ? "Extending ground (seamless)…" : "Generating ground…")
		const fp = footprint()
		const size = groundImageSize(fp.cols, fp.rows)
		const { canvas, mask } = buildGroundComposite(fp, size)
		const imageBlob = await canvasToBlob(canvas)
		const maskBlob = mask ? await canvasToBlob(mask) : null
		// Colour match: lock the new ground to the EXISTING plot's real colour (sampled from the
		// kept ground image), not just the block-out base — so both plots read as one surface.
		// Falls back to the block-out palette on the first build (no kept image yet).
		let groundColorHex = world.baseGroundColor
		let groundColors = primitiveColors(world.groundTiles)
		if (groundMaster?.imageEl) {
			const existing = sampleImageColor(groundMaster.imageEl)
			if (existing) {
				groundColorHex = existing
				groundColors = [existing, ...groundColors]
			}
		}
		try {
			const res = await generateGround({
				prompt, image: imageBlob, mask: maskBlob, groundColor: groundColorHex,
				colors: groundColors, cols: fp.cols, rows: fp.rows, imageSize: size.label, output, name: "floor",
			})
			world.removeGenerated("floor")
			await seatSubject(res.splat, world.footprintBox(), "floor", null, {
				kind: "floor", yawTurns: FLOOR_YAW_TURNS, yawDeg: floorFit.yawDeg, yOffset: floorFit.yOffset, fillXZ: true, colors: groundColors,
			})
			splatStore.set("floor", res.splat)
			world.groundGenerated()
			groundMaster = { imageEl: await blobToImage(res.imageBlob), cols: fp.cols, rows: fp.rows, minIx: fp.minIx, minIz: fp.minIz }
		} catch (error) {
			console.warn("ground:", error.message)
			setStatus("Ground generation failed: " + (error.message || error))
		}
		done++
		showProgress(done, total)

		// 2. OBJECTS — only for plots that aren't built yet (frozen plots are left untouched).
		for (const pid of toBuild) {
			const objects = computeObjects(plotPrimitives(pid))
			if (!objects.length) continue
			let labels = {}
			try {
				const context = await captureWorldContext(renderer, scene, world, objects)
				const identified = await identifyObjects({ image: context, scene: prompt, count: objects.length, output })
				labels = identified.labels || {}
			} catch { /* fall back to scene-context prompting */ }

			const subjects = []
			for (let i = 0; i < objects.length; i++) {
				const cap = await captureObject(renderer, scene, world, objects[i])
				subjects.push({
					image: cap.guide, box: objects[i].box, name: `p${pid}-obj-${String(i + 1).padStart(3, "0")}`,
					label: labels[String(i + 1)] || "", primitives: objects[i].primitives, colors: primitiveColors(objects[i].primitives),
				})
			}
			await runPool(subjects, concurrency, async s => {
				try {
					const bytes = await generateSubject({ prompt, kind: "object", output, name: s.name, label: s.label, colors: s.colors, image: s.image })
					await seatSubject(bytes, s.box, s.name, s.primitives, { kind: "object", yawTurns: OBJECT_YAW_TURNS, yawDeg: objectFit.yawDeg, yOffset: objectFit.yOffset, fitHeight: true, colors: s.colors })
					splatStore.set(s.name, bytes)
				} catch (error) {
					console.warn(`${s.name}:`, error.message)
				}
				done++
				showProgress(done, total)
			})
		}

		applyAllPlotHeights() // re-apply any hills to the freshly-seated ground + objects
		world.state = "generated"
		applyOverlayVisibility()
		sessionSubjects = world.generated
			.map(g => ({ name: g.mesh.userData.genName, kind: g.mesh.userData.genKind ?? "object", yawTurns: g.mesh.userData.genKind === "floor" ? FLOOR_YAW_TURNS : OBJECT_YAW_TURNS, fitHeight: g.mesh.userData.genKind !== "floor" }))
			.filter(s => s.name)
		saveBuildToHistory(world.prompt)
		showProgress(total, total, "Done")
		window.setTimeout(hideProgress, 1000)
	} catch (error) {
		setStatus(error.message || "Expansion failed")
		hideProgress()
	} finally {
		generating = false
		syncGenerateButton()
	}
}

// Load one or more uploaded .splat/.ply files and lay them out in a grid of cells on
// the floor — each splat fit into its own cell box via the normal seat pipeline. Clears
// any current generation first and hides the block-out so it reads as a splat gallery.
async function uploadSplats(files) {
	const list = [...(files || [])]
	if (!list.length || generating) return
	generating = true
	syncGenerateButton()
	setStatus("")
	try {
		world.resetGenerated()
		for (const primitive of world.primitives) primitive.visible = false
		world.front.visible = false

		const cols = Math.ceil(Math.sqrt(list.length))
		const rows = Math.ceil(list.length / cols)
		const cell = 4 // each splat's footprint is fit into a cell this many plot units wide
		const spacing = cell * 1.3
		const half = cell / 2
		showProgress(0, list.length, "Loading splats…")
		for (let i = 0; i < list.length; i++) {
			const file = list[i]
			const cx = ((i % cols) - (cols - 1) / 2) * spacing
			const cz = (Math.floor(i / cols) - (rows - 1) / 2) * spacing
			const box = new THREE.Box3(
				new THREE.Vector3(cx - half, groundTopY, cz - half),
				new THREE.Vector3(cx + half, groundTopY + cell, cz + half),
			)
			const name = file.name.replace(/\.[^.]+$/, "")
			try {
				const bytes = new Uint8Array(await file.arrayBuffer())
				await seatSubject(bytes, box, name, null, { fileName: file.name })
			} catch (error) {
				console.warn(`upload ${file.name}:`, error.message)
			}
			showProgress(i + 1, list.length)
		}
		world.state = "generated"
		applyOverlayVisibility()
		showProgress(list.length, list.length, "Done")
		window.setTimeout(hideProgress, 1000)
	} catch (error) {
		setStatus(error.message || "Upload failed")
		hideProgress()
	} finally {
		generating = false
		syncGenerateButton()
	}
}

// Serialize the block-out primitives to a plain object (shared by download and ZIP export).
function serializePrimitives() {
	const index = new Map(world.primitives.map((mesh, i) => [mesh, i]))
	return {
		version: 2,
		primitives: world.primitives.map(mesh => ({
			type: mesh.userData.type,
			position: mesh.position.toArray(),
			rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
			scale: mesh.scale.toArray(),
			color: `#${mesh.userData.baseColor ?? mesh.material.color.getHexString()}`,
			locked: Boolean(mesh.userData.locked),
			support: mesh.userData.support ? index.get(mesh.userData.support) ?? null : null,
			supportAxis: mesh.userData.supportAxis ?? { name: "y", sign: 1 },
		})),
	}
}

// Save the block-out primitives to a JSON file so a layout can be saved and fully
// reloaded — including the support/attachment forest (saved as array indices, since the
// links are by-reference) so seated stacks survive a round-trip.
function downloadPrimitives() {
	const blob = new Blob([JSON.stringify(serializePrimitives(), null, 2)], { type: "application/json" })
	downloadBlob(blob, `primitives-${Date.now()}.json`)
}

// Export the current session (splats + primitives + subject metadata) as a ZIP so it can
// be re-fitted later without regenerating. The ZIP contains:
//   primitives.json  — block-out scene (same format as the standalone primitive download)
//   scene.json       — ordered subject list with kind/yaw/fitHeight metadata
//   splats/*.splat   — raw Tripo bytes for each seated object / floor
async function downloadZip() {
	if (!splatStore.size) { setStatus("Nothing to export — generate first"); return }
	const enc = new TextEncoder()
	const files = {
		"primitives.json": [enc.encode(JSON.stringify(serializePrimitives(), null, 2)), { level: 6 }],
		"scene.json": [enc.encode(JSON.stringify({ version: 1, subjects: sessionSubjects }, null, 2)), { level: 6 }],
	}
	for (const [name, bytes] of splatStore) {
		files[`splats/${name}.splat`] = [bytes, { level: 0 }]
	}
	try {
		await new Promise((resolve, reject) => {
			zip(files, (err, data) => {
				if (err) { reject(err); return }
				downloadBlob(new Blob([data], { type: "application/zip" }), `worldsketch-${Date.now()}.zip`)
				resolve()
			})
		})
	} catch (err) {
		setStatus("ZIP export failed: " + (err.message || err))
	}
}

// Load a previously exported ZIP, replace the block-out with the stored primitives, then
// re-seat every splat against the freshly computed object-group boxes. This skips
// generation entirely so object/floor fit params can be iterated fast from .env.
async function uploadZip(file) {
	if (!file || generating) return
	generating = true
	syncGenerateButton()
	setStatus("")
	try {
		const raw = new Uint8Array(await file.arrayBuffer())
		const files = await new Promise((resolve, reject) => unzip(raw, (err, data) => err ? reject(err) : resolve(data)))

		const primBytes = files["primitives.json"]
		const sceneBytes = files["scene.json"]
		if (!primBytes) throw new Error("ZIP missing primitives.json")
		if (!sceneBytes) throw new Error("ZIP missing scene.json")

		const sceneData = JSON.parse(new TextDecoder().decode(sceneBytes))
		const subjects = sceneData.subjects ?? []
		if (!subjects.length) throw new Error("ZIP has no subjects in scene.json")

		const n = await applyStoredBuild({
			primitives: primBytes,
			subjects,
			getSplat: name => files[`splats/${name}.splat`],
		})
		setStatus(`Re-fitted ${n} subject${n === 1 ? "" : "s"}`)
	} catch (err) {
		setStatus(err.message || "Re-fit failed")
		hideProgress()
	} finally {
		generating = false
		syncGenerateButton()
	}
}

// Shared re-fit core for ZIP re-fit and history restore: swap the block-out to the
// stored primitives, then re-seat every subject's stored splat bytes against freshly
// computed boxes (same fit pipeline as generation). `primitives` is the serialized
// block-out (Uint8Array, JSON string, or object); `getSplat(name)` returns that
// subject's raw bytes (or undefined). Assumes the caller owns the `generating` lock and
// will report status / clear it. Returns the number of subjects successfully re-seated.
async function applyStoredBuild({ primitives, subjects, getSplat }) {
	if (!subjects?.length) throw new Error("Build has no subjects")
	const primBytes = primitives instanceof Uint8Array
		? primitives
		: new TextEncoder().encode(typeof primitives === "string" ? primitives : JSON.stringify(primitives))

	// Reload primitives (resets generated state, rebuilds block-out).
	await uploadPrimitives(new File([primBytes], "primitives.json", { type: "application/json" }))

	// Pull fresh fit params from the server so the user can tune via .env and re-fit.
	const cfg = await getConfig()
	applyRuntimeConfig(cfg)

	// Group the newly loaded primitives into objects (same logic as generation).
	const objectGroups = computeObjects(world.primitives)
	let objectIdx = 0

	splatStore.clear()
	sessionSubjects = []
	world.resetGenerated()

	const total = subjects.length
	let done = 0
	showProgress(0, total, "Re-fitting…")

	for (const s of subjects) {
		const splatBytes = getSplat(s.name)
		if (!splatBytes) { console.warn(`missing splat ${s.name}`); done++; showProgress(done, total); continue }

		let box, sourcePrimitives, colors
		if (s.kind === "floor") {
			box = world.floorBox()
			sourcePrimitives = null
			colors = primitiveColors([world.ground])
		} else {
			const group = objectGroups[objectIdx++]
			if (!group) { done++; showProgress(done, total); continue }
			box = group.box
			sourcePrimitives = group.primitives
			colors = primitiveColors(sourcePrimitives)
		}

		const fit = fitSettingsFor(s.kind)
		try {
			await seatSubject(splatBytes, box, s.name, sourcePrimitives, {
				kind: s.kind,
				yawTurns: s.yawTurns ?? 0,
				yawDeg: fit.yawDeg,
				yOffset: fit.yOffset,
				fitHeight: Boolean(s.fitHeight),
				colors,
			})
			splatStore.set(s.name, splatBytes)
			sessionSubjects.push(s)
			if (s.kind === "floor") world.groundGenerated()
		} catch (err) {
			console.warn(`refit ${s.name}:`, err.message)
		}
		done++
		showProgress(done, total)
	}

	world.state = "generated"
	applyOverlayVisibility()
	showProgress(total, total, "Done")
	window.setTimeout(hideProgress, 1000)
	return sessionSubjects.length
}

// Load a primitives JSON file (from downloadPrimitives), replacing the current block-out
// and restoring the support links once every mesh exists.
async function uploadPrimitives(file) {
	if (!file || generating) return
	let parsed
	try {
		parsed = JSON.parse(await file.text())
	} catch {
		setStatus("Invalid primitives file (not JSON)")
		return
	}
	const prims = Array.isArray(parsed) ? parsed : parsed?.primitives
	if (!Array.isArray(prims)) {
		setStatus("No primitives found in file")
		return
	}

	world.resetGenerated() // back to an editable draft before swapping the block-out
	selectPrimitive(null)
	for (const mesh of [...world.primitives]) world.removePrimitive(mesh)

	// Pass 1: create every mesh (kept index-aligned with `prims`, null for bad entries).
	const created = prims.map(p => {
		if (!p?.type) return null
		const mesh = createPrimitive(p.type, `prim_${String(nextPrimitiveId++).padStart(3, "0")}`, {
			color: p.color,
			position: p.position,
			rotation: p.rotation,
			scale: p.scale,
			locked: p.locked,
		})
		mesh.userData.world = world
		world.primitives.push(mesh)
		world.group.add(mesh)
		return mesh
	})

	// Pass 2: resolve support indices -> mesh refs now that all meshes exist.
	prims.forEach((p, i) => {
		const mesh = created[i]
		if (!mesh) return
		mesh.userData.support = Number.isInteger(p?.support) ? created[p.support] ?? null : null
		mesh.userData.supportAxis = p?.supportAxis ?? { name: "y", sign: 1 }
	})

	setStatus(`Loaded ${world.primitives.length} primitive${world.primitives.length === 1 ? "" : "s"}`)
}

function applyOverlayVisibility() {
	world.setCollidersVisible(showColliders)
	world.setBoundsVisible(showBounds)
}

// Capture a PNG of JUST the floor from the CURRENT live camera (the exact on-screen
// view), hiding the block-out objects, generated object splats, and debug overlays.
// The floor itself — the painted ground while editing, or the floor splat once
// generated — is left untouched. Downloads the image.
async function screenshotFloor() {
	const restored = []
	const hide = obj => {
		if (obj && obj.visible) {
			obj.visible = false
			restored.push(obj)
		}
	}
	for (const primitive of world.primitives) hide(primitive)
	for (const { mesh, primitives } of world.generated) if (primitives.length) hide(mesh) // keep the floor splat (no source primitives)
	for (const helper of world.boundsHelpers) hide(helper)
	hide(world.front)
	hide(placementPreview)

	const w = renderer.domElement.width
	const h = renderer.domElement.height
	const target = new THREE.WebGLRenderTarget(w, h)
	try {
		renderer.setRenderTarget(target)
		renderer.render(scene, camera)
		const pixels = new Uint8Array(w * h * 4)
		renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels)
		const blob = await pixelsToPngBlob(pixels, w, h)
		downloadBlob(blob, `floor-${Date.now()}.png`)
	} finally {
		renderer.setRenderTarget(null)
		target.dispose()
		for (const obj of restored) obj.visible = true
	}
}

function pixelsToPngBlob(pixels, w, h) {
	const canvas = document.createElement("canvas")
	canvas.width = w
	canvas.height = h
	const ctx = canvas.getContext("2d")
	const image = ctx.createImageData(w, h)
	for (let y = 0; y < h; y++) {
		const src = y * w * 4
		const dst = (h - y - 1) * w * 4 // GL reads bottom-up; flip to top-down
		image.data.set(pixels.subarray(src, src + w * 4), dst)
	}
	ctx.putImageData(image, 0, 0)
	return new Promise(resolve => canvas.toBlob(resolve, "image/png"))
}

function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob)
	const a = document.createElement("a")
	a.href = url
	a.download = filename
	document.body.appendChild(a)
	a.click()
	a.remove()
	URL.revokeObjectURL(url)
}

// --- Build history ----------------------------------------------------------

let historyOpen = false

// Render the current scene to a small offscreen target and return a JPEG data URL for
// the history thumbnail. Independent of the live framebuffer (same render-to-target
// trick as screenshotFloor). Returns "" on any failure — a thumb is never essential.
function captureThumb(maxW = 320) {
	try {
		const fullW = renderer.domElement.width
		const fullH = renderer.domElement.height
		if (!fullW || !fullH) return ""
		const scale = Math.min(1, maxW / fullW)
		const w = Math.max(1, Math.round(fullW * scale))
		const h = Math.max(1, Math.round(fullH * scale))
		const target = new THREE.WebGLRenderTarget(w, h)
		try {
			renderer.setRenderTarget(target)
			renderer.render(scene, camera)
			const pixels = new Uint8Array(w * h * 4)
			renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels)
			const canvas = document.createElement("canvas")
			canvas.width = w
			canvas.height = h
			const ctx = canvas.getContext("2d")
			const image = ctx.createImageData(w, h)
			for (let y = 0; y < h; y++) {
				const src = y * w * 4
				const dst = (h - y - 1) * w * 4 // GL reads bottom-up; flip to top-down
				image.data.set(pixels.subarray(src, src + w * 4), dst)
			}
			ctx.putImageData(image, 0, 0)
			return canvas.toDataURL("image/jpeg", 0.62)
		} finally {
			renderer.setRenderTarget(null)
			target.dispose()
		}
	} catch {
		return ""
	}
}

// Snapshot the just-completed build (block-out + every subject's splat bytes + prompt +
// a thumbnail) into the persistent history. Best-effort: never blocks or breaks
// generation if storage fails. Fired (not awaited) from generateWorld.
async function saveBuildToHistory(prompt) {
	if (!splatStore.size) return
	const thumb = captureThumb()
	const subjects = sessionSubjects.map(s => ({ ...s }))
	const primitives = JSON.stringify(serializePrimitives())
	try {
		await addBuild({ prompt, thumb, subjects, primitives, splats: splatStore })
		await refreshHistoryPanel()
	} catch (err) {
		console.warn("history save failed:", err.message || err)
	}
}

function relTime(ts) {
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
	if (s < 60) return "just now"
	const m = Math.round(s / 60)
	if (m < 60) return `${m}m ago`
	const h = Math.round(m / 60)
	if (h < 24) return `${h}h ago`
	return `${Math.round(h / 24)}d ago`
}

// Rebuild the history panel list from IndexedDB (newest first). Also keeps the count
// badge + empty-state in sync so it's right whether the panel is open or closed.
async function refreshHistoryPanel() {
	if (!els.historyList) return
	let builds = []
	try { builds = await listBuilds() } catch (err) { console.warn("history list failed:", err.message || err) }
	if (els.historyCount) els.historyCount.textContent = builds.length ? String(builds.length) : ""
	if (els.historyEmpty) els.historyEmpty.classList.toggle("hidden", builds.length > 0)
	els.historyList.replaceChildren()
	for (const b of builds) els.historyList.appendChild(historyItem(b))
}

function historyItem(b) {
	const item = document.createElement("div")
	item.className = "history-item"

	const thumbBtn = document.createElement("button")
	thumbBtn.className = "history-thumb"
	thumbBtn.title = "Restore this build"
	if (b.thumb) {
		const img = document.createElement("img")
		img.src = b.thumb
		img.alt = b.prompt || "build"
		thumbBtn.appendChild(img)
	} else {
		thumbBtn.textContent = "—"
	}
	thumbBtn.addEventListener("click", () => restoreBuild(b.id))

	const meta = document.createElement("button")
	meta.className = "history-meta"
	const title = document.createElement("div")
	title.className = "history-title"
	title.textContent = b.prompt?.trim() || "Untitled build"
	title.title = b.prompt || ""
	const sub = document.createElement("div")
	sub.className = "history-sub"
	sub.textContent = `${b.subjectCount} part${b.subjectCount === 1 ? "" : "s"} · ${relTime(b.ts)}`
	meta.append(title, sub)
	meta.addEventListener("click", () => restoreBuild(b.id))

	const del = document.createElement("button")
	del.className = "history-del"
	del.title = "Delete this build"
	del.textContent = "×"
	del.addEventListener("click", async event => {
		event.stopPropagation()
		try { await deleteBuild(b.id) } catch (err) { console.warn(err) }
		await refreshHistoryPanel()
	})

	item.append(thumbBtn, meta, del)
	return item
}

// Restore a stored build: swap in its block-out and re-seat its splats from IndexedDB
// without regenerating. Replaces the current scene (same as ZIP re-fit).
async function restoreBuild(id) {
	if (generating) return
	let entry, splats
	try {
		entry = (await listBuilds()).find(b => b.id === id)
		splats = await getBuildSplats(id)
	} catch {
		setStatus("Couldn't load that build")
		return
	}
	if (!entry || !splats) { setStatus("That build is no longer available"); await refreshHistoryPanel(); return }
	generating = true
	syncGenerateButton()
	setStatus("")
	try {
		const n = await applyStoredBuild({
			primitives: entry.primitives,
			subjects: entry.subjects,
			getSplat: name => splats[name],
		})
		world.prompt = entry.prompt || ""
		if (els.chatPrompt) els.chatPrompt.value = world.prompt
		setStatus(`Restored ${n} part${n === 1 ? "" : "s"} from history`)
	} catch (err) {
		setStatus(err.message || "Restore failed")
		hideProgress()
	} finally {
		generating = false
		syncGenerateButton()
	}
}

function toggleHistoryPanel(open) {
	historyOpen = open ?? !historyOpen
	if (historyOpen && els.settingsPopover) toggleSettings(false) // close settings so the two panels don't overlap
	els.historyPanel?.classList.toggle("hidden", !historyOpen)
	els.historyToggle?.classList.toggle("active", historyOpen)
	if (historyOpen) refreshHistoryPanel()
}

function toggleSettings(open) {
	const next = open ?? els.settingsPopover.classList.contains("hidden")
	els.settingsPopover.classList.toggle("hidden", !next)
	els.settingsBtn.setAttribute("aria-expanded", String(next))
}

// --- UI wiring --------------------------------------------------------------

for (const button of els.toolButtons) button.addEventListener("click", () => setActiveTool(button.dataset.tool))
for (const swatch of els.colorSwatches) bindColorSwatch(swatch)
for (const swatch of els.brushSwatches) swatch.addEventListener("click", () => applyBrushScale(Number(swatch.dataset.scale)))

els.addColor?.addEventListener("click", () => els.customColor?.click())
els.customColor?.addEventListener("change", event => addPaletteColor(event.target.value))

// Lift the picker out of .tool-dock (which clips overflow at <=720px) so it can open above the
// bar at any width; it is fixed-positioned over the button in positionPlotDirs().
if (els.plotDirs) document.body.appendChild(els.plotDirs)

els.addPlot?.addEventListener("click", event => {
	event.stopPropagation() // don't let the document handler immediately re-close it
	togglePlotDirs()
})

for (const btn of els.plotDirButtons) {
	btn.addEventListener("click", () => {
		const dx = Number(btn.dataset.dx), dz = Number(btn.dataset.dz)
		if (!Number.isFinite(dx) || !Number.isFinite(dz) || (dx === 0 && dz === 0)) return
		addPlotAt(cellInDirection(dx, dz))
		togglePlotDirs(false)
	})
}

els.floorShot?.addEventListener("click", async () => {
	try {
		await screenshotFloor()
	} catch (error) {
		setStatus(error.message || "Floor screenshot failed")
	}
})

els.uploadSplats?.addEventListener("change", async event => {
	await uploadSplats(event.target.files)
	event.target.value = "" // let the same file(s) be re-selected
})

els.downloadPrims?.addEventListener("click", downloadPrimitives)

els.uploadPrims?.addEventListener("change", async event => {
	await uploadPrimitives(event.target.files[0])
	event.target.value = "" // let the same file be re-selected
})

els.downloadZip?.addEventListener("click", downloadZip)

els.uploadZip?.addEventListener("change", async event => {
	await uploadZip(event.target.files[0])
	event.target.value = "" // let the same file be re-selected
})

els.showColliders?.addEventListener("change", () => {
	showColliders = els.showColliders.checked
	world.setCollidersVisible(showColliders)
})

els.showBounds?.addEventListener("change", () => {
	showBounds = els.showBounds.checked
	world.setBoundsVisible(showBounds)
})

els.settingsBtn?.addEventListener("click", event => {
	event.stopPropagation() // don't let the document handler immediately re-close it
	toggleSettings()
})

document.addEventListener("click", event => {
	if (!els.settingsMenu?.contains(event.target)) toggleSettings(false)
	if (!els.plotDirs?.contains(event.target) && event.target !== els.addPlot && !els.addPlot?.contains(event.target)) togglePlotDirs(false)
})

document.addEventListener("keydown", event => {
	if (event.key === "Escape") { toggleSettings(false); togglePlotDirs(false) }
})

els.historyToggle?.addEventListener("click", () => toggleHistoryPanel())

els.historyClear?.addEventListener("click", async () => {
	try { await clearBuilds() } catch (err) { console.warn(err) }
	await refreshHistoryPanel()
})

els.historyClose?.addEventListener("click", () => toggleHistoryPanel(false))

els.chatForm.addEventListener("submit", event => {
	event.preventDefault()
	if (els.generate.disabled) return
	const prompt = els.chatPrompt.value.trim()
	// More than one plot → expansion path (unified outpainted ground + per-plot objects).
	// A single plot keeps the original one-shot pipeline untouched.
	if (world.groundTiles.length > 1) generateExpanded(prompt)
	else generateWorld(prompt)
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
if (world.prompt) els.chatPrompt.value = world.prompt
refreshHistoryPanel() // populate the count badge from any builds saved in earlier sessions
requestAnimationFrame(animate)
