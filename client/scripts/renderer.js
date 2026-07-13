import * as THREE from "three"
import { PackedSplats, SparkRenderer, SplatMesh } from "spark"
import { zip, unzip } from "fflate"
import { getConfig, newOutput, generateSubject, generateGroundTexture, identifyObjects, planScene, planSketchObjects } from "/scripts/api.js"
import { captureObject, captureWorld, captureWorldContext, projectGroundIso, FRONT_THETA, FRONT_PHI } from "/scripts/capture.js"
import { fitSplatToBox } from "/scripts/fit.js"
import { computeObjects } from "/scripts/geometry.js"
import { addEdgeOutline, clearSelectionOutline, createPrimitive, createSelectionOutline, disposeObject, setEdgeOutlineVisible, updateEdgeOutlineColor } from "/scripts/primitives.js"
import { addBuild, listBuilds, getBuildSplats, deleteBuild, clearBuilds } from "/scripts/history.js"
import { createSky } from "/scripts/sky.js"

const root = document.getElementById("canvas")
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.03, 400)
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, stencil: false, powerPreference: "high-performance" })
const raycaster = new THREE.Raycaster()
// Expansion ghost tiles live on their own layer so the editor camera shows them but the
// capture cameras (capture.js, default layer 0) never bake them into generated images.
const GHOST_LAYER = 1
camera.layers.enable(GHOST_LAYER)
raycaster.layers.enable(GHOST_LAYER)
const pointer = new THREE.Vector2()
const scratch = new THREE.Vector3()
const localUp = new THREE.Vector3(0, 1, 0)
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
const gizmoRayPoint = new THREE.Vector3()
const gizmoPlane = new THREE.Plane()
const gizmoAxisWorld = new THREE.Vector3()
const gizmoCameraDir = new THREE.Vector3()
const gizmoPlaneNormal = new THREE.Vector3()
const backgroundColor = new THREE.Color(0xfcfcfc)

const shapeTools = new Set(["box"])
const selectionTools = new Set(["pointer", "move"]) // both select; move also shows the translate widget
const floorSize = 16 // the single world's ground tile (bigger now that it is its own splat)
const groundThickness = 0.05
const groundTopY = groundThickness // plot-local Y of the ground's top surface
const floorSeamOverlap = 0.18 // tiny X/Z overfit so adjacent per-plot floor splats do not reveal seams
// Ground tiles overhang their grid cell by 2cm per side: tiles that merely touch edge-to-edge
// let antialiasing blend the darker side-faces through the sub-pixel crack at the shared edge,
// which reads as a faint crease line between plots. Overlapping tops close that crack, and a
// hair of Y lift alternated by grid parity gives the overlap band a strict depth winner instead
// of z-fighting (adjacent cells always differ in ix+iz parity; 1.5mm is invisible at any zoom).
const tileSeamOverlap = 0.04
const tileSeamLift = (ix, iz) => ((ix + iz) & 1 ? 0.0015 : 0)
const baseGroundColor = "#587553" // default terrain; painted regions layer on top
const GROUND_SHEET_SIZE = 48 // world units the drawable ground sheet spans (paint creates ground)
// THE project accent — the single colour every UI affordance uses (tabs, selection,
// ghosts, colliders, primary button). DB32 "bright blue"; also set in styles.css.
const accent = 0x5b6ee1

const defaultFitSettings = {
	yOffset: 0,
	opacityFloor: 0.03,
	fitClampK: 0,
	fitBboxPercentile: 0,
	paletteLock: false,
	paletteStrength: 0.75,
	paletteLightness: 0,
	yawDeg: 0,
	fillOverscale: 1.08, // floors only: overscale the X/Z fit, clip boxes cull the overhang
	reliefDip: 0.35, // floors only: how far surface relief may dip below the seated sheet
}
let objectFit = { ...defaultFitSettings }
let floorFit = { ...defaultFitSettings }
let sceneFit = { ...defaultFitSettings }

// Fixed yaw applied to every seated splat (0|1|2|3 = 0/90/180/270°). NOT an
// orientation search — the capture angle is constant so any needed turn is constant
// too. Default 0 (the per-object capture reuses the proven isometric angle). Bump if
// live Tripo output comes out turned; objects + floor are tunable independently since
// they're captured from different angles.
const OBJECT_YAW_TURNS = 0
const FLOOR_YAW_TURNS = 0

// Two stages: Build the one-plot block-out, then View the single generated splat.
// The Draw/planning stage stays disabled, plots are locked to one while testing the
// whole-scene one-shot pipeline (one capture → one texture edit → one TripoSplat).
let uiTab = "build"

let activeTool = "pointer"
let activeColor = baseGroundColor // first strokes CREATE ground, so start on the terrain green
let activeBrushScale = 1
let selectedPrimitive = null
let placementPreview = null
let drag = null
let pendingPlotHeight = null // latest floor-lift target { pid, height }; applied once per frame in animate
let elevationDirty = false // curved-terrain previews need a refresh; coalesced per frame in animate
let nextPrimitiveId = 1
let generating = false
let splatting = false // a SPLAT generation is in flight (drives the View tab's disabled+spinner gate)
let building = false // a GEOMETRY generation is in flight (drives the Build tab's disabled+spinner gate)

// Raw splat bytes + subject metadata kept in memory for ZIP export and re-fitting.
// Populated during generateWorld (or uploadZip); cleared at the start of each fresh generation.
const splatStore = new Map()   // name → Uint8Array (unfitted raw bytes)
let sessionSubjects = []        // [{name, kind, plotId, yawTurns, fitHeight}] in generation order

// World expansion state. Plots are 16×16 ground tiles laid edge-to-edge; new primitives
// belong to the active plot. Generated floors are independent per plot.
let activePlotId = 0 // the plot new primitives join and Add-plot grows from
let plotSeq = 0      // last assigned plot id (plot 0 is the base tile)
let groundMaster = null // legacy unified-ground context; reset before new per-plot floor generation
const plotHeights = new Map() // plotId → Y offset; drives the ground height-field (hills between plots)

// Debug overlays. "Colliders" re-shows the source primitives as a wireframe over the
// generated splats; "Bounds" draws each splat's seated content AABB.
const colliderColor = accent
const boundsColor = accent
let showColliders = false
let showBounds = false
let devControlsVisible = false
let rawSplatPreview = null
let rawOrbitSnapshot = null

const els = {
	status: document.getElementById("status"),
	progress: document.getElementById("progress"),
	progressFill: document.getElementById("progress_fill"),
	progressLabel: document.getElementById("progress_label"),
	toolButtons: [...document.querySelectorAll("[data-tool]")],
	viewTabs: [...document.querySelectorAll("[data-view-tab]")],
	colorGrid: document.querySelector(".swatch-grid"),
	colorSwatches: [...document.querySelectorAll("[data-color]")],
	addColor: document.getElementById("add_color_btn"),
	customColor: document.getElementById("custom_color_input"),
	brushSwatches: [...document.querySelectorAll("[data-scale]")],
	generate: document.getElementById("generate_btn"),
	drawCanvas: document.getElementById("draw_canvas"),
	drawClear: document.getElementById("draw_clear_btn"),
	drawToolButtons: [...document.querySelectorAll("[data-draw-tool]")],
	viewToolButtons: [...document.querySelectorAll("[data-view-tool]")],
	framesTitle: document.getElementById("frames_title"),
	framesList: document.getElementById("frames_list"),
	frameAdd: document.getElementById("frame_add_btn"),
	chatForm: document.getElementById("chat_form"),
	chatPrompt: document.getElementById("chat_prompt"),
	floorShot: document.getElementById("floor_shot_btn"),
	viewRawSplat: document.getElementById("view_raw_splat_input"),
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
		setEdgeOutlineVisible(mesh, false) // the green wireframe replaces the base-colour outline
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
		setEdgeOutlineVisible(mesh, true)
	}
}

function setPickableHidden(mesh, on) {
	const mat = mesh.material
	if (on) {
		if (!mesh.userData.pickableSnapshot) {
			mesh.userData.pickableSnapshot = {
				transparent: mat.transparent, opacity: mat.opacity, depthTest: mat.depthTest,
				depthWrite: mat.depthWrite, color: mat.color.getHex(), renderOrder: mesh.renderOrder,
				map: mat.map, wireframe: mat.wireframe,
			}
		}
		mesh.visible = true
		mat.transparent = true
		mat.opacity = 0
		mat.depthTest = false
		mat.depthWrite = false
		mat.wireframe = false
		mesh.renderOrder = 1001
		mat.needsUpdate = true
		setEdgeOutlineVisible(mesh, false) // an invisible pickable must not leave its outline floating
	} else if (mesh.userData.pickableSnapshot) {
		const s = mesh.userData.pickableSnapshot
		mat.transparent = s.transparent
		mat.opacity = s.opacity
		mat.depthTest = s.depthTest
		mat.depthWrite = s.depthWrite
		mat.map = s.map
		mat.wireframe = s.wireframe
		mat.color.setHex(s.color)
		mesh.renderOrder = s.renderOrder
		mat.needsUpdate = true
		mesh.userData.pickableSnapshot = null
		setEdgeOutlineVisible(mesh, true)
	}
}

// A paintable canvas-texture for the ground so the user can "draw" terrain (rivers,
// paths, rock) that the floor generation turns into real materials.
// baseColor null → a fully TRANSPARENT canvas (the drawable ground sheet starts as
// void; strokes create the ground). Painted tiles/blocks keep their opaque base fill.
function createPaintSurface(baseColor, size = 1024) {
	const canvas = document.createElement("canvas")
	canvas.width = canvas.height = size
	const ctx = canvas.getContext("2d", { willReadFrequently: true })
	if (baseColor) {
		ctx.fillStyle = baseColor
		ctx.fillRect(0, 0, canvas.width, canvas.height)
	}
	const texture = new THREE.CanvasTexture(canvas)
	texture.colorSpace = THREE.SRGBColorSpace
	texture.anisotropy = renderer.capabilities.getMaxAnisotropy() // keep painted terrain crisp at the grazing angles a zoomed-out orbit produces
	return { canvas, ctx, texture }
}

// Push the broad ground planes slightly deeper in the depth buffer so whatever rests on
// them (blocks seated 6mm up, slope previews, splat skirts) wins the depth contest
// cleanly. Depth-only: captured guide images are colour-identical.
function applyGroundDepthBias(material) {
	material.polygonOffset = true
	material.polygonOffsetFactor = 1
	material.polygonOffsetUnits = 1
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

function brushRadiiForHit(hit, canvas, worldSize) {
	const worldRadius = activeBrushScale * 0.8
	if (hit.object.userData.type !== "box" || hit.object.userData.isGround) {
		const radius = Math.max(6, (worldRadius * canvas.width) / worldSize)
		return { x: radius, y: radius }
	}
	const cellW = canvas.width / 3
	const cellH = canvas.height / 2
	const { width, height } = hitFaceWorldSize(hit)
	return {
		x: Math.max(6, (worldRadius * cellW) / width),
		y: Math.max(6, (worldRadius * cellH) / height),
	}
}

function hitFaceWorldSize(hit) {
	if (!hit.object.geometry.boundingBox) hit.object.geometry.computeBoundingBox()
	const size = hit.object.geometry.boundingBox.getSize(new THREE.Vector3())
	size.multiply(hit.object.scale).set(Math.abs(size.x), Math.abs(size.y), Math.abs(size.z))
	const normal = hit.face?.normal ?? new THREE.Vector3(0, 1, 0)
	const ax = Math.abs(normal.x)
	const ay = Math.abs(normal.y)
	const az = Math.abs(normal.z)
	if (ax >= ay && ax >= az) return { width: Math.max(0.001, size.z), height: Math.max(0.001, size.y) }
	if (ay >= ax && ay >= az) return { width: Math.max(0.001, size.x), height: Math.max(0.001, size.z) }
	return { width: Math.max(0.001, size.x), height: Math.max(0.001, size.y) }
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
		this.groundSlopePreviews = []
		this.state = "draft"
		this.prompt = ""
		this.baseGroundColor = baseGroundColor
		this.floorGenerated = false

		// The ground is one large DRAWABLE SHEET, not a fixed plot: its paint canvas starts
		// fully transparent (alphaTest clips undrawn texels), and the paint tool creates
		// ground wherever the user strokes. Where nothing is drawn there simply is no ground.
		this.paint = createPaintSurface(null, 2048)
		this.ground = createPrimitive("box", "ground", {
			position: [0, groundThickness / 2, 0],
			scale: [GROUND_SHEET_SIZE, groundThickness, GROUND_SHEET_SIZE],
			color: baseGroundColor,
			locked: true,
		})
		this.ground.userData.seamLift = tileSeamLift(0, 0)
		this.ground.material.map = this.paint.texture
		this.ground.userData.baseColor = baseGroundColor.replace("#", "")
		this.ground.material.color.set(0xffffff) // let the painted texture show its true colours
		this.ground.material.alphaTest = 0.5 // undrawn canvas = no ground (void)
		applyGroundDepthBias(this.ground.material)
		this.ground.material.needsUpdate = true
		this.ground.userData.isGround = true
		this.ground.userData.isGroundSheet = true
		this.ground.userData.plotId = 0
		this.ground.userData.origin = new THREE.Vector3(0, 0, 0)
		this.ground.userData.paint = this.paint
		setEdgeOutlineVisible(this.ground, false) // the sheet's square outline would read as a plot border around the void
		this.group.add(this.ground)
		this.groundTiles = [this.ground]

	}

	// World-space bounds of the DRAWN ground (null when nothing is drawn yet). Sampled
	// from a downscaled alpha scan so it stays exact after erasing, and cheap enough to
	// call per generation. Canvas x → world +X, canvas y → world +Z (top-down mapping).
	groundInkBounds() {
		const S = 128
		const probe = document.createElement("canvas")
		probe.width = probe.height = S
		const pctx = probe.getContext("2d", { willReadFrequently: true })
		pctx.clearRect(0, 0, S, S)
		pctx.drawImage(this.paint.canvas, 0, 0, S, S)
		const data = pctx.getImageData(0, 0, S, S).data
		let minX = S, maxX = -1, minZ = S, maxZ = -1
		for (let j = 0; j < S; j++) {
			for (let i = 0; i < S; i++) {
				if (data[(j * S + i) * 4 + 3] <= 32) continue
				if (i < minX) minX = i
				if (i > maxX) maxX = i
				if (j < minZ) minZ = j
				if (j > maxZ) maxZ = j
			}
		}
		if (maxX < 0) return null
		const half = GROUND_SHEET_SIZE / 2
		return new THREE.Box3(
			new THREE.Vector3(-half + (minX / S) * GROUND_SHEET_SIZE, 0, -half + (minZ / S) * GROUND_SHEET_SIZE),
			new THREE.Vector3(-half + ((maxX + 1) / S) * GROUND_SHEET_SIZE, groundTopY + 0.01, -half + ((maxZ + 1) / S) * GROUND_SHEET_SIZE),
		)
	}

	allBlockoutMeshes() {
		return [...this.groundTiles, ...this.primitives]
	}

	// Capture-subject selection never depends on .visible — the View tab hides the whole
	// block-out, and captures force-show their subjects anyway. Curved previews (present
	// whenever elevation exists) take priority over the flat tiles.
	floorCaptureMeshes() {
		return this.groundSlopePreviews.length ? this.groundSlopePreviews : this.groundTiles
	}

	floorCaptureMeshesForTile(tile) {
		const plotId = tile.userData.plotId
		const preview = this.groundSlopePreviews.find(mesh => mesh.userData.plotId === plotId)
		return [preview ?? tile]
	}

	// The meshes a pointer ray should treat as "the ground": a tile's curved slope mesh when
	// it has one (it follows the real surface), else its flat tile — post-generation, plots
	// added later have no curved mesh and stay flat block-outs.
	groundHitMeshes() {
		const curved = this.groundSlopePreviews.filter(mesh => mesh.visible)
		if (!curved.length) return this.groundTiles
		const covered = new Set(curved.map(mesh => mesh.userData.plotId))
		return [...curved, ...this.groundTiles.filter(tile => !covered.has(tile.userData.plotId))]
	}

	raycastables() {
		return [...this.groundHitMeshes(), ...this.primitives.filter(mesh => mesh.visible)].filter(mesh => mesh.visible)
	}

	selectables() {
		return [...this.groundHitMeshes(), ...this.primitives].filter(mesh => mesh.visible)
	}

	// Set the base ground colour for the WHOLE world — every plot's ground tile, so all floors
	// stay one colour. Each tile keeps its own painted terrain (only pixels matching that tile's
	// previous base colour are swapped); a tile with no matching pixels is filled flat.
	setGroundColor(color) {
		const next = color.replace("#", "").toLowerCase()
		this.baseGroundColor = `#${next}`
		for (const tile of this.groundTiles) {
			this.setGroundTileColor(tile, color)
		}
	}

	setGroundTileColor(tile, color) {
		const next = color.replace("#", "").toLowerCase()
		const surface = tile.userData.paint
		if (!surface) return
		const prev = tile.userData.baseColor ?? next
		tile.userData.baseColor = next
		tile.userData.paintVersion = (tile.userData.paintVersion || 0) + 1 // recolour redraws the paint canvas
		updateEdgeOutlineColor(tile, `#${next}`)
		const from = new THREE.Color(`#${prev}`)
		const to = new THREE.Color(`#${next}`)
		const fromRgb = [Math.round(from.r * 255), Math.round(from.g * 255), Math.round(from.b * 255)]
		const toRgb = [Math.round(to.r * 255), Math.round(to.g * 255), Math.round(to.b * 255)]
		const { canvas, ctx, texture } = surface
		const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
		let changed = 0
		for (let i = 0; i < img.data.length; i += 4) {
			if (img.data[i + 3] <= 32) continue // never recolour the sheet's undrawn void
			if (Math.abs(img.data[i] - fromRgb[0]) > 2 || Math.abs(img.data[i + 1] - fromRgb[1]) > 2 || Math.abs(img.data[i + 2] - fromRgb[2]) > 2) continue
			img.data[i] = toRgb[0]
			img.data[i + 1] = toRgb[1]
			img.data[i + 2] = toRgb[2]
			changed++
		}
		if (changed) ctx.putImageData(img, 0, 0)
		else if (!tile.userData.isGroundSheet) {
			// Legacy plot-tile fallback: a tile with no matching pixels gets a flat refill.
			// The drawable sheet must NEVER flood-fill — ground only exists where drawn.
			ctx.fillStyle = `#${next}`
			ctx.fillRect(0, 0, canvas.width, canvas.height)
		}
		texture.needsUpdate = true
		updateGroundSlopePreview()
	}

	// Target box a plot floor splat is fitted into: that tile footprint, seated at y=0.
	floorBoxForTile(tile = this.ground) {
		const half = this.size / 2
		const origin = tile?.userData?.origin ?? new THREE.Vector3()
		return new THREE.Box3(
			new THREE.Vector3(origin.x - half, 0, origin.z - half),
			new THREE.Vector3(origin.x + half, groundTopY, origin.z + half),
		)
	}

	floorBox(plotId = 0) {
		const tile = this.groundTiles.find(t => t.userData.plotId === plotId) ?? this.ground
		return this.floorBoxForTile(tile)
	}

	// Add an adjacent ground tile at grid cell (ix, iz) for a new plot. Mirrors the
	// constructor's ground: a thin, locked, paintable slab with its own paint surface.
	addGroundTile(ix, iz, plotId) {
		const cx = ix * floorSize
		const cz = iz * floorSize
		const paint = createPaintSurface(baseGroundColor)
		const tile = createPrimitive("box", "ground", {
			position: [cx, groundThickness / 2 + tileSeamLift(ix, iz), cz],
			scale: [floorSize + tileSeamOverlap, groundThickness, floorSize + tileSeamOverlap],
			color: baseGroundColor,
			locked: true,
		})
		tile.userData.seamLift = tileSeamLift(ix, iz)
		tile.material.map = paint.texture
		tile.userData.baseColor = baseGroundColor.replace("#", "")
		tile.material.color.set(0xffffff)
		applyGroundDepthBias(tile.material)
		tile.material.needsUpdate = true
		tile.userData.isGround = true
		tile.userData.paint = paint
		tile.userData.plotId = plotId
		tile.userData.origin = new THREE.Vector3(cx, 0, cz)
		this.groundTiles.push(tile)
		this.group.add(tile)
		// Full elevation-handle refresh, not just the curved previews: when a neighbouring plot
		// is already raised, the previews are active and every tile must be made transparent
		// under its curved surface — including THIS new tile, or it renders flat AND curved at
		// once until the next height edit happens to re-run the refresh.
		updateElevationHandles()
		return tile
	}

	// AABB spanning EVERY ground tile (the whole plot footprint), seated at y=0.
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

	floorClipBoxes() {
		const half = floorSize / 2
		return this.groundTiles.map(tile => {
			const { x, z } = tile.userData.origin
			return new THREE.Box3(
				new THREE.Vector3(x - half, 0, z - half),
				new THREE.Vector3(x + half, groundTopY, z + half),
			)
		})
	}

	// Drop one seated splat by its generation name, leaving every other plot's splats in place.
	removeGenerated(name) {
		const i = this.generated.findIndex(g => g.mesh.userData.genName === name)
		if (i < 0) return
		disposeObject(this.generated[i].mesh)
		this.generated.splice(i, 1)
	}

	removeGeneratedWhere(predicate) {
		for (let i = this.generated.length - 1; i >= 0; i--) {
			if (!predicate(this.generated[i])) continue
			disposeObject(this.generated[i].mesh)
			this.generated.splice(i, 1)
		}
	}

	addPrimitive(type, hit) {
		const mesh = createPrimitive(type, `prim_${String(nextPrimitiveId++).padStart(3, "0")}`, { color: activeColor, scaleFactor: activeBrushScale })
		placeMeshOnSurface(mesh, hit)
		this.group.worldToLocal(mesh.position)
		mesh.userData.world = this
		mesh.userData.plotId = plotIdFromHit(hit) // bind to the floor/support that was actually clicked
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

	paintAt(hit, erase = false) {
		const uv = hit.uv
		if (!uv) return
		const surface = ensurePaintSurface(hit.object)
		if (!surface) return
		// Remember each colour painted onto a primitive (or the ground), so it joins that
		// subject's palette for the hue lock — e.g. red berry spots become an available
		// colour, and a painted blue river joins the floor's palette. Record on the tile,
		// not a transient curved-surface mesh (those are rebuilt on every height change).
		const paintTarget = hit.object.userData.tile ?? hit.object
		if (!erase) (paintTarget.userData.paintedColors ??= new Set()).add(activeColor)
		paintTarget.userData.paintVersion = (paintTarget.userData.paintVersion || 0) + 1 // invalidate the snapshot paint cache
		const { canvas, ctx, texture } = surface
		const px = uv.x * canvas.width
		const py = (1 - uv.y) * canvas.height
		const isSheet = Boolean(hit.object.userData.isGroundSheet || hit.object.userData.tile?.userData?.isGroundSheet)
		const radius = brushRadiiForHit(hit, canvas, isSheet ? GROUND_SHEET_SIZE : this.size)
		ctx.save()
		if (hit.object.userData.type === "box" && !hit.object.userData.isGround) clipToAtlasCell(ctx, canvas, uv)
		if (erase) ctx.globalCompositeOperation = "destination-out" // erasing the sheet removes the ground itself
		ctx.fillStyle = activeColor
		// Pointer events arrive far apart on fast drags — a round-capped LINE from the
		// previous stamp keeps the stroke continuous (vital when strokes CREATE ground).
		const last = drag?.paintLast
		if (last && last.object === hit.object && radius.x === radius.y) {
			ctx.strokeStyle = activeColor
			ctx.lineWidth = radius.x * 2
			ctx.lineCap = "round"
			ctx.beginPath()
			ctx.moveTo(last.px, last.py)
			ctx.lineTo(px, py)
			ctx.stroke()
		} else {
			ctx.beginPath()
			ctx.ellipse(px, py, radius.x, radius.y, 0, 0, Math.PI * 2)
			ctx.fill()
		}
		ctx.restore()
		if (drag) drag.paintLast = { object: hit.object, px, py }
		texture.needsUpdate = true
	}

	// Seat a generated splat. Splats render only in the View tab, and the View tab never
	// shows the block-out, so there is no per-source hiding to do here anymore.
	addGenerated(mesh, sourcePrimitives) {
		const record = { mesh, primitives: sourcePrimitives }
		this.generated.push(record)
		this.group.add(mesh)
		mesh.visible = uiTab === "view"
		for (const primitive of sourcePrimitives) setColliderStyle(primitive, false)
	}

	groundGenerated() {
		this.floorGenerated = true
		for (const tile of this.groundTiles) {
			tile.userData.floorBaked = true // this tile is now covered by the generated floor splat
			setColliderStyle(tile, false)
		}
		updateElevationHandles() // per-tab visibility (View hides every tile regardless)
	}

	// Frames: tear the tiles down to nothing (frame switches rebuild from snapshot data).
	clearTiles() {
		clearGroundSelectionHighlight()
		for (const mesh of this.groundSlopePreviews) disposeObject(mesh)
		this.groundSlopePreviews = []
		for (const tile of [...this.groundTiles]) disposeObject(tile)
		this.groundTiles = []
		this.ground = null // callers rebuild tiles immediately and re-point this
		plotHeights.clear()
	}

	// Tear down a previous generation: drop the splats, restore the editable block-out.
	resetGenerated() {
		clearRawSplatPreview()
		for (const { mesh } of this.generated) disposeObject(mesh)
		this.generated.length = 0 // in place — this array belongs to the active View frame
		this.setBoundsVisible(false)
		this.floorGenerated = false
		for (const tile of this.groundTiles) {
			tile.userData.floorBaked = false // back to an editable draft — nothing is baked anymore
			setPickableHidden(tile, false)
			tile.visible = true
			setColliderStyle(tile, false)
		}
		for (const primitive of this.primitives) {
			setPickableHidden(primitive, false)
			primitive.visible = true
			setColliderStyle(primitive, false)
		}
		this.state = "draft"
		groundMaster = null // a fresh draft invalidates the kept outpaint context
		applyUiTab() // re-assert per-tab visibility (a View-tab reset must not reveal the block-out)
	}

	setCollidersVisible(show) {
		if (this.state !== "generated") return
		for (const tile of this.groundTiles) {
			if (show) {
				setPickableHidden(tile, false)
				tile.visible = true
				setColliderStyle(tile, true)
			} else {
				setColliderStyle(tile, false)
				setPickableHidden(tile, this.floorGenerated && tile.userData.floorBaked)
				tile.visible = true
			}
		}
		for (const primitive of this.primitives) {
			if (show) {
				setPickableHidden(primitive, false)
				primitive.visible = true
				setColliderStyle(primitive, true)
			} else {
				setColliderStyle(primitive, false)
				setPickableHidden(primitive, true)
			}
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

function generatedForPrimitive(mesh) {
	return world.generated.find(record => record.primitives?.includes(mesh)) ?? null
}

function editablePrimitiveFor(mesh) {
	if (mesh.userData.tile) mesh = mesh.userData.tile // curved ground surface → its flat tile
	if (world.state !== "generated" || mesh.userData.isGround) return mesh
	const record = generatedForPrimitive(mesh)
	return record?.primitives?.[0] ?? mesh
}

// --- Translation gizmo ------------------------------------------------------

const gizmoAxes = [
	{ name: "x", color: 0xe44b4b, dir: new THREE.Vector3(1, 0, 0) },
	{ name: "y", color: 0x4caf50, dir: new THREE.Vector3(0, 1, 0) }, // standard axis colours: X red, Y green, Z blue
	{ name: "z", color: 0x3b82f6, dir: new THREE.Vector3(0, 0, 1) },
]

function createGizmoAxis({ name, color, dir }) {
	const group = new THREE.Group()
	group.userData.isGizmo = true
	group.userData.axis = name
	const material = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false })
	const hitMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.001, depthTest: false, depthWrite: false })
	const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.95, 12), material)
	shaft.position.y = 0.48
	const cone = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.34, 20), material)
	cone.position.y = 1.12
	const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1.45, 12), hitMaterial)
	hit.position.y = 0.72
	hit.userData.isGizmoHandle = true
	hit.userData.axis = name
	group.add(shaft, cone, hit)
	group.quaternion.setFromUnitVectors(localUp, dir)
	group.renderOrder = 1000
	group.traverse(object => {
		object.userData.isGizmo = true
		object.renderOrder = 1000
	})
	return group
}

const transformGizmo = new THREE.Group()
transformGizmo.visible = false
transformGizmo.userData.isGizmo = true
const gizmoAxisGroups = new Map()
const gizmoHandleMeshes = []
for (const axis of gizmoAxes) {
	const group = createGizmoAxis(axis)
	gizmoAxisGroups.set(axis.name, group)
	const handle = group.children.find(child => child.userData.isGizmoHandle)
	if (handle) gizmoHandleMeshes.push(handle)
	transformGizmo.add(group)
}
scene.add(transformGizmo)

function selectedGizmoPosition(out = new THREE.Vector3()) {
	if (!selectedPrimitive) return out.set(0, 0, 0)
	if (!selectedPrimitive.geometry.boundingBox) selectedPrimitive.geometry.computeBoundingBox()
	selectedPrimitive.updateWorldMatrix(true, false)
	const box = selectedPrimitive.geometry.boundingBox.clone().applyMatrix4(selectedPrimitive.matrixWorld)
	box.getCenter(out)
	if (selectedPrimitive.userData.isGround) out.y = heightAt(out.x, out.z) + groundTopY + 0.25 // sit on the curved surface
	return out
}

function updateTransformGizmo() {
	const show = Boolean(selectedPrimitive) && activeTool === "move" && !generating && uiTab === "build"
	transformGizmo.visible = show
	if (!show) return
	selectedGizmoPosition(transformGizmo.position)
	const floorSelected = Boolean(selectedPrimitive.userData.isGround)
	for (const [axis, group] of gizmoAxisGroups) group.visible = !floorSelected || axis === "y"
	const dist = Math.max(1, camera.position.distanceTo(transformGizmo.position))
	const scale = Math.min(2.2, Math.max(0.8, dist * 0.055))
	transformGizmo.scale.setScalar(scale)
}

function gizmoHit(event) {
	if (!transformGizmo.visible) return null
	const handles = gizmoHandleMeshes.filter(mesh => mesh.parent?.visible)
	return handles.length ? raycast(event, handles) : null
}

function gizmoAxisVector(axis) {
	if (axis === "x") return new THREE.Vector3(1, 0, 0)
	if (axis === "y") return new THREE.Vector3(0, 1, 0)
	return new THREE.Vector3(0, 0, 1)
}

function intersectGizmoPlane(event, out) {
	pointerFromEvent(event)
	raycaster.setFromCamera(pointer, camera)
	return raycaster.ray.intersectPlane(gizmoPlane, out)
}

function startGizmoDrag(event, handle) {
	if (!selectedPrimitive) return false
	const axis = handle.userData.axis
	const floorDrag = Boolean(selectedPrimitive.userData.isGround)
	gizmoAxisWorld.copy(gizmoAxisVector(axis)).normalize()
	camera.getWorldDirection(gizmoCameraDir)
	gizmoPlaneNormal.copy(gizmoCameraDir).addScaledVector(gizmoAxisWorld, -gizmoCameraDir.dot(gizmoAxisWorld))
	if (gizmoPlaneNormal.lengthSq() < 1e-5) {
		gizmoPlaneNormal.set(axis === "y" ? 1 : 0, axis === "y" ? 0 : 1, 0)
	}
	gizmoPlaneNormal.normalize()
	gizmoPlane.setFromNormalAndCoplanarPoint(gizmoPlaneNormal, transformGizmo.position)
	let startScalar = 0
	if (!floorDrag) {
		if (!intersectGizmoPlane(event, gizmoRayPoint)) return false
		startScalar = gizmoRayPoint.clone().sub(transformGizmo.position).dot(gizmoAxisWorld)
	}
	const subtree = floorDrag ? [] : objectClusterOf(selectedPrimitive)
	beginBuildAction() // undo checkpoint: gizmo move / floor lift (popped again if nothing moves)
	drag = {
		mode: "gizmo",
		pointerId: event.pointerId,
		mesh: selectedPrimitive,
		axis,
		axisWorld: gizmoAxisWorld.clone(),
		origin: transformGizmo.position.clone(),
		startScalar,
		startY: event.clientY,
		subtree,
		startPositions: [selectedPrimitive, ...subtree].map(mesh => mesh.position.clone()),
		startQuaternions: [selectedPrimitive, ...subtree].map(mesh => mesh.quaternion.clone()),
		groundRef: floorDrag ? null : gizmoGroundRef(selectedPrimitive, subtree),
		startPlotHeight: floorDrag ? (plotHeights.get(selectedPrimitive.userData.plotId) || 0) : 0,
		actionPushed: true,
	}
	renderer.domElement.setPointerCapture(event.pointerId)
	renderer.domElement.classList.add("is-dragging")
	return true
}

// Lift a plot by dragging its ground body directly (move tool), so raising/lowering a plot
// after generation is "click the plot, drag up/down" — no need to grab the thin Y gizmo arrow.
// Selects the plot first (summoning the Y gizmo too), then arms the same floor drag the gizmo
// uses; a press with no vertical movement just leaves the plot selected (setPlotHeight ignores
// a ~0 delta).
function startFloorLift(event, tile) {
	selectPrimitive(tile)
	if (!selectedPrimitive?.userData.isGround) return false
	beginBuildAction() // undo checkpoint: floor lift (popped again if nothing moves)
	drag = {
		mode: "gizmo",
		actionPushed: true,
		pointerId: event.pointerId,
		mesh: selectedPrimitive,
		axis: "y",
		axisWorld: new THREE.Vector3(0, 1, 0),
		origin: transformGizmo.position.clone(),
		startScalar: 0,
		startY: event.clientY,
		subtree: [],
		startPositions: [selectedPrimitive.position.clone()],
		startPlotHeight: plotHeights.get(selectedPrimitive.userData.plotId ?? 0) || 0,
	}
	renderer.domElement.setPointerCapture(event.pointerId)
	renderer.domElement.classList.add("is-dragging")
	return true
}

// Ground-conform reference for a block move: the cluster's footprint centre/base and the
// terrain sample under it at drag start. As the drag slides the cluster around, the same
// delta-conform setPlotHeight applies to clusters (rotate by the slope-normal change about
// the base, lift by the surface-height change) keeps it seated on — and tilted with — the
// curved ground at its NEW spot, while preserving manual rotations and stack offsets.
function gizmoGroundRef(mesh, subtree) {
	const box = new THREE.Box3()
	for (const m of [mesh, ...subtree]) box.expandByObject(m)
	if (box.isEmpty()) return null
	const centre = box.getCenter(new THREE.Vector3())
	return { cx: centre.x, cz: centre.z, baseY: box.min.y, h0: heightAt(centre.x, centre.z), n0: slopeNormalAt(centre.x, centre.z) }
}

const conformQuat = new THREE.Quaternion()
const conformQuatInv = new THREE.Quaternion()
const conformBase = new THREE.Vector3()

// Re-seat the dragged cluster onto the terrain under its CURRENT footprint. Positions and
// quaternions were just reset from their drag-start values, so the conform is applied fresh
// each pointer event and never accumulates.
function conformDraggedCluster(moved) {
	const g = drag.groundRef
	if (!g || !drag.startQuaternions) return
	const cx = g.cx + tmpDelta.x
	const cz = g.cz + tmpDelta.z
	conformQuat.setFromUnitVectors(localUp, slopeNormalAt(cx, cz))
		.multiply(conformQuatInv.setFromUnitVectors(localUp, g.n0).invert())
	const lift = heightAt(cx, cz) - g.h0
	conformBase.set(cx, g.baseY + tmpDelta.y, cz)
	for (let i = 0; i < moved.length; i++) {
		const mesh = moved[i]
		mesh.position.sub(conformBase).applyQuaternion(conformQuat).add(conformBase)
		mesh.position.y += lift
		mesh.quaternion.copy(conformQuat).multiply(drag.startQuaternions[i])
	}
}

function bindPrimitiveTreeToCurrentPlot(mesh, subtree) {
	const pos = mesh.getWorldPosition(tmpWorld)
	const half = floorSize / 2
	const tile = world.groundTiles.find(t => {
		const origin = t.userData.origin
		return pos.x >= origin.x - half && pos.x <= origin.x + half && pos.z >= origin.z - half && pos.z <= origin.z + half
	})
	if (tile) bindPrimitiveTreeToPlot(mesh, subtree, tile.userData.plotId ?? 0)
}

function updateGizmoDrag(event) {
	drag.mutated = true // the checkpoint pushed at drag start is now earned
	if (drag.mesh.userData.isGround) {
		// Only the LATEST target matters — pointer events fire far above frame rate, so
		// the height change (cluster reseat + terrain refresh) applies once per frame.
		// Generated splats are NOT touched: Build and View are decoupled after generation.
		pendingPlotHeight = { pid: drag.mesh.userData.plotId ?? 0, height: drag.startPlotHeight + (drag.startY - event.clientY) * 0.03 }
		return
	}
	if (!intersectGizmoPlane(event, gizmoRayPoint)) return
	const currentScalar = gizmoRayPoint.clone().sub(drag.origin).dot(drag.axisWorld)
	const delta = currentScalar - drag.startScalar
	tmpDelta.copy(drag.axisWorld).multiplyScalar(delta)
	const moved = [drag.mesh, ...drag.subtree]
	for (let i = 0; i < moved.length; i++) moved[i].position.copy(drag.startPositions[i]).add(tmpDelta)
	conformDraggedCluster(moved) // stick to + tilt with the curved ground at the new spot
	if (drag.axis !== "y") bindPrimitiveTreeToCurrentPlot(drag.mesh, drag.subtree)
	updateTransformGizmo()
}

function finishGizmoDrag() {
	if (!drag || drag.mode !== "gizmo") return
	if (drag.mesh.userData.isGround) {
		if (pendingPlotHeight) { // flush the last coalesced height
			const p = pendingPlotHeight
			pendingPlotHeight = null
			setPlotHeight(p.pid, p.height)
		}
	}
	else {
		bindPrimitiveTreeToCurrentPlot(drag.mesh, drag.subtree)
		focusPlot(drag.mesh.userData.plotId ?? 0) // dragging a block onto another plot focuses it
	}
}

// --- Tools / palette --------------------------------------------------------

function setActiveTool(tool) {
	const previous = activeTool
	activeTool = tool
	// Keep the selection when hopping between the two selection tools (pointer ↔ move).
	if (previous !== tool && !(selectionTools.has(previous) && selectionTools.has(tool))) selectPrimitive(null)
	for (const button of els.toolButtons) button.classList.toggle("active", button.dataset.tool === tool)
	renderer.domElement.classList.toggle("is-pointer", tool === "pointer")
	renderer.domElement.classList.toggle("is-move", tool === "move")
	renderer.domElement.classList.toggle("is-eraser", tool === "eraser")
	renderer.domElement.classList.toggle("is-placing", shapeTools.has(tool))
	renderer.domElement.classList.toggle("is-painting", tool === "paint")
	renderer.domElement.classList.toggle("is-scaling", tool === "scale")
	renderer.domElement.classList.toggle("is-rotating", tool === "rotate")
	syncPlacementPreview()
	updateElevationHandles()
	updateTransformGizmo()
}

function syncPlacementPreview() {
	if (!shapeTools.has(activeTool) || uiTab === "view") {
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
	// Ghost the preview's edge outline to match its translucent body.
	const previewEdges = placementPreview.children.find(child => child.userData.isEdgeOutline)
	if (previewEdges) {
		previewEdges.material.transparent = true
		previewEdges.material.opacity = 0.5
	}
	scene.add(placementPreview)
}

function selectPrimitive(mesh) {
	mesh = mesh ? editablePrimitiveFor(mesh) : null
	if (selectedPrimitive) clearSelectionOutline(selectedPrimitive)
	clearGroundSelectionHighlight()
	selectedPrimitive = mesh
	if (mesh) {
		applySelectionOutline(mesh)
		syncActiveColorFromSelection(mesh)
	}
	updateTransformGizmo()
}

// An elevated floor's flat collider box would show a flat outline floating over the curved
// terrain — highlight the true (curved) surface instead. Flat floors keep the box shell.
let groundSelectionHighlight = null

function clearGroundSelectionHighlight() {
	if (!groundSelectionHighlight) return
	disposeObject(groundSelectionHighlight)
	groundSelectionHighlight = null
}

function applySelectionOutline(mesh) {
	if (mesh.userData.isGround && hasPlotElevation()) {
		groundSelectionHighlight = new THREE.Mesh(buildCurvedTileGeometry(mesh, 0.06), new THREE.MeshBasicMaterial({
			color: accent, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide,
		}))
		groundSelectionHighlight.userData.isSelectionOutline = true
		groundSelectionHighlight.renderOrder = 4
		world.group.add(groundSelectionHighlight)
		return
	}
	createSelectionOutline(mesh)
}

// Rebuild the selected floor's highlight so it tracks the height field while it changes
// (e.g. during a Y-widget drag that raises/lowers the plot).
function refreshGroundSelectionHighlight() {
	if (!selectedPrimitive?.userData.isGround) return
	clearSelectionOutline(selectedPrimitive)
	clearGroundSelectionHighlight()
	applySelectionOutline(selectedPrimitive)
}

function setActiveColorOnly(color) {
	activeColor = color
	if (placementPreview) {
		placementPreview.material.color.set(color)
		placementPreview.userData.baseColor = placementPreview.material.color.getHexString()
		updateEdgeOutlineColor(placementPreview, color)
	}
	for (const swatch of els.colorSwatches) {
		swatch.classList.toggle("active", swatch.dataset.color.toLowerCase() === color.toLowerCase())
	}
}

function syncActiveColorFromSelection(mesh) {
	const hex = "#" + (mesh.userData.baseColor ?? mesh.material.color.getHexString())
	setActiveColorOnly(hex)
}

function applyColor(color) {
	setActiveColorOnly(color)
	if (selectedPrimitive) {
		const current = `#${selectedPrimitive.userData.baseColor ?? selectedPrimitive.material.color.getHexString()}`
		if (current.toLowerCase() !== color.toLowerCase()) beginBuildAction() // undo checkpoint: recolour
		if (selectedPrimitive.userData.isGround) world.setGroundTileColor(selectedPrimitive, color)
		else {
			selectedPrimitive.material.color.set(color)
			selectedPrimitive.userData.baseColor = selectedPrimitive.material.color.getHexString()
			updateEdgeOutlineColor(selectedPrimitive, color)
		}
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

// --- Build / View tabs --------------------------------------------------------
// Two tabs over the same world. Build: the editable block-out (primitives + ground
// tiles) with every generated splat hidden — all block-out editing lives here. View:
// the generated splats. The tabs are DECOUPLED after generation: Build edits never
// move existing splats (regenerate to reflect them), and View has its own move/rotate
// tools that act on the splat meshes alone.

const emptyViewHint = "Nothing generated yet — hit Generate and the View tab fills in"

function setUiTab(tab) {
	if (tab === uiTab) return
	uiTab = tab
	if (tab !== "build") {
		selectPrimitive(null) // Draw and View have no block-out selection / gizmo
		clearGhostHover()
	}
	if (tab !== "view") deselectSplat() // splat selection is a View-only thing
	if (tab === "view" && !world.generated.length) setStatus(emptyViewHint)
	else if (els.status.textContent === emptyViewHint) setStatus("")
	applyUiTab()
}

function applyUiTab() {
	const building = uiTab !== "view" // Draw keeps the Build-side scene state under its overlay
	document.body.classList.toggle("tab-view", uiTab === "view") // CSS strips all UI but the tabs in View
	document.body.classList.toggle("tab-draw", uiTab === "draw") // CSS swaps in the sketch pad in Draw
	for (const button of els.viewTabs) {
		button.classList.toggle("active", button.dataset.viewTab === uiTab)
		button.setAttribute("aria-selected", String(button.dataset.viewTab === uiTab))
	}
	// The prompt bar serves the active stage (in Draw, Enter/send = generate geometry;
	// the primary splat button is CSS-hidden there).
	if (els.chatPrompt) els.chatPrompt.placeholder = uiTab === "draw" ? "Describe your drawing..." : "Describe your scene..."
	// Splats render only in the View tab.
	for (const { mesh } of world.generated) mesh.visible = !building
	// Expansion ghosts are build-time UI: hide them from the camera AND the raycaster.
	camera.layers[building ? "enable" : "disable"](GHOST_LAYER)
	raycaster.layers[building ? "enable" : "disable"](GHOST_LAYER)
	if (building) {
		// The full editable block-out, whatever the generation state.
		for (const mesh of world.allBlockoutMeshes()) {
			setColliderStyle(mesh, false)
			setPickableHidden(mesh, false)
			mesh.visible = true
		}
	} else if (showColliders && world.state === "generated") {
		world.setCollidersVisible(true) // debug overlay: wireframe block-out over the splats
	} else {
		// View renders splats ONLY — no blocks, no floor plate. True hiding (visible=false)
		// so the block-out costs zero draw calls; View is read-only, nothing needs its raycast.
		for (const mesh of world.allBlockoutMeshes()) {
			setColliderStyle(mesh, false)
			mesh.visible = false
		}
	}
	updateElevationHandles() // re-applies per-tab ground tile visibility (baked tiles hide in View only)
	syncPlacementPreview()
	updateTransformGizmo()
	syncViewGate()
	renderFramesPanel()
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

// Blocks land exactly where the cursor points — on the ground AND anywhere on another
// block's face (no snapping to the face centre). Orientation still snaps to the face
// (placementNormalFromHit), only the position is free. Elevated ground maps the hit
// onto the curved surface height.
function placementAnchor(hit) {
	if (hit.object.userData.isGround && hasPlotElevation()) {
		return new THREE.Vector3(hit.point.x, heightAt(hit.point.x, hit.point.z) + groundTopY, hit.point.z)
	}
	return hit.point.clone()
}

function placementNormalFromHit(hit) {
	if (hit.object.userData.isGround || hit.object.userData.locked) {
		return hit.object.userData.isGround && hasPlotElevation() ? slopeNormalAt(hit.point.x, hit.point.z) : hit.normal.clone()
	}
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

// Focus (activate) a plot: new primitives join it and the expansion ghosts surround it.
// Focus follows interaction — building/painting/selecting on a plot — never plot creation.
function focusPlot(plotId) {
	if (plotId == null || plotId === activePlotId) return
	if (!world.groundTiles.some(t => t.userData.plotId === plotId)) return
	activePlotId = plotId
	updateGhostTiles()
}

function plotIdFromHit(hit, fallback = activePlotId) {
	const pid = hit?.object?.userData?.plotId
	return Number.isInteger(pid) ? pid : fallback
}

function bindPrimitiveTreeToPlot(root, descendants, plotId) {
	root.userData.plotId = plotId
	for (const child of descendants) child.userData.plotId = plotId
}

// --- Attachment graph -------------------------------------------------------
// Every block remembers the block it was seated on (`support`) and which face of
// that support it sits against (`supportAxis`, in the support's local space). The
// support forest only drives the SCALE drag now (a growing face has to know which
// blocks are seated on it); moving and rotating treat the whole connected cluster
// as the object — see objectClusterOf.

function recordSupport(mesh, hit) {
	const onPrim = Boolean(hit) && !hit.object.userData.isGround && !hit.object.userData.locked && world.primitives.includes(hit.object)
	mesh.userData.support = onPrim ? hit.object : null
	mesh.userData.supportAxis = onPrim ? hitFaceAxis(hit) : { name: "y", sign: 1 }
}

// All blocks transitively seated on `mesh` (its dependents), nearest first. Only the
// scale drag uses this narrow face-seated view; everything else uses objectClusterOf.
function collectSupportSubtree(mesh) {
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

// Every OTHER block in the same connected cluster as `mesh` — "the object". Blocks
// count as connected generally (touching or overlapping, the same computeObjects rule
// that groups generation subjects), not just when one was placed on the other's face,
// so grabbing or rotating any block of an object carries the whole object with it.
function objectClusterOf(mesh) {
	const group = computeObjects(world.primitives).find(g => g.primitives.includes(mesh))
	return group ? group.primitives.filter(p => p !== mesh) : []
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
	radius: floorSize * 2.3, // open zoomed out enough to show the dashed expansion outlines on all 4 sides
	theta: FRONT_THETA, // open the editor at the same isometric angle objects are captured from
	phi: FRONT_PHI,
}

function updateCamera() {
	orbit.phi = Math.max(0.12, Math.min(Math.PI * 0.49, orbit.phi))
	// Raw inspection changes only the camera: the uploaded splat itself remains untouched.
	// Its native scale can be far outside the editor's normal 4..128 orbit range.
	const minRadius = rawSplatPreview ? 0.001 : 4
	const maxRadius = rawSplatPreview ? 1e7 : floorSize * 8
	orbit.radius = Math.max(minRadius, Math.min(maxRadius, orbit.radius)) // headroom to pan/zoom across a multi-plot world
	camera.up.set(0, 1, 0)
	camera.position.copy(orbit.target).add(scratch.setFromSpherical(new THREE.Spherical(orbit.radius, orbit.phi, orbit.theta)))
	camera.lookAt(orbit.target)
	// Scale the near plane with zoom: a fixed 0.03 near starves the depth buffer of
	// precision at distance, so contact edges (blocks seated 6mm above the ground, slope
	// previews, splat/mesh intersections) z-fight once zoomed out. Nothing ever sits
	// within 2% of the orbit radius from the camera, so raising it never clips geometry.
	camera.near = rawSplatPreview ? Math.max(0.00001, orbit.radius / 10000) : Math.min(2, Math.max(0.03, orbit.radius * 0.02))
	camera.far = rawSplatPreview ? Math.max(400, orbit.radius * 20) : 400
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

// --- Primitive transform drags (scale / roll) -------------------------------

function startPrimitiveDrag(event, mesh, hit = null) {
	mesh = editablePrimitiveFor(mesh)
	selectPrimitive(mesh)
	if (mesh.userData.isGround || mesh.userData.locked) return
	if (selectionTools.has(activeTool)) return
	const worldPosition = mesh.getWorldPosition(new THREE.Vector3())
	beginBuildAction() // undo checkpoint: scale / rotate (popped again if nothing moves)
	drag = {
		mode: activeTool === "rotate" ? "roll" : "scale",
		actionPushed: true,
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
	if (drag.mode === "scale") setupScaleDrag(mesh, hit)
	if (drag.mode === "roll") setupRollDrag(mesh)
	renderer.domElement.setPointerCapture(event.pointerId)
	renderer.domElement.classList.add("is-dragging")
}

// Capture the rotating block's pivot and the start pose of every dependent, so the
// whole stack can turn as one rigid body and seated faces stay connected.
function setupRollDrag(mesh) {
	drag.roll = {
		pivot: mesh.getWorldPosition(new THREE.Vector3()),
		members: objectClusterOf(mesh).map(m => ({
			mesh: m,
			startPos: m.getWorldPosition(new THREE.Vector3()),
			startQuat: m.quaternion.clone(),
		})),
	}
}

// Capture everything the scale drag needs: the on-screen direction of each local
// axis (so the drag direction can pick one), the seated face to pin, and the start
// state of every dependent block so they can be re-glued to the moving faces.
function setupScaleDrag(mesh, hit = null) {
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
	const pickedAxis = hit ? hitFaceAxis(hit) : null
	const anchorAxis = pickedAxis ? { name: pickedAxis.name, sign: -pickedAxis.sign } : { name: "y", sign: -1 }
	const anchorLocal = faceLocalPoint(mesh, anchorAxis, new THREE.Vector3())
	const anchorWorld = mesh.localToWorld(anchorLocal.clone())
	const children = []
	for (const child of world.primitives) {
		if (child.userData.support !== mesh) continue
		const axis = child.userData.supportAxis ?? { name: "y", sign: 1 }
		const faceLocal = faceLocalPoint(mesh, axis, new THREE.Vector3())
		const subtree = [child, ...collectSupportSubtree(child)]
		children.push({
			faceLocal,
			startFaceWorld: mesh.localToWorld(faceLocal.clone()),
			subtree,
			startPos: subtree.map(m => m.position.clone()),
		})
	}
	if (pickedAxis) {
		screenAxis[pickedAxis.name] = {
			x: screenAxis[pickedAxis.name].x * pickedAxis.sign,
			y: screenAxis[pickedAxis.name].y * pickedAxis.sign,
		}
	}
	drag.scale = { mesh, worldQuat, screenAxis, anchorLocal, anchorWorld, children, axis: pickedAxis?.name ?? null }
}

function updatePrimitiveDrag(event) {
	drag.mutated = true // the checkpoint pushed at drag start is now earned
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
	// Pin the opposite grabbed face so dragging outward grows and inward shrinks.
	tmpScale.copy(s.anchorLocal).multiply(newScale).applyQuaternion(s.worldQuat)
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

function startPaint(event, erase = false) {
	beginBuildAction() // undo checkpoint: one paint stroke
	drag = { mode: "paint", pointerId: event.pointerId, erase, actionPushed: true, mutated: true }
	renderer.domElement.setPointerCapture(event.pointerId)
	paintAtEvent(event)
}

function paintAtEvent(event) {
	const hit = raycast(event, world.raycastables())
	if (!hit) return
	world.paintAt(hit, Boolean(drag?.erase))
	focusPlot(plotIdFromHit(hit))
}

// --- View-tab splat tools -----------------------------------------------------
// View owns its own move/scale/rotate: they act on the generated SplatMesh transforms
// only, so nothing feeds back into the Build block-out. Splat scaling stays UNIFORM —
// Spark collapses non-uniform mesh scales to an average, while a uniform scale is safe.
// Selection raycasts invisible proxy boxes (children of each splat mesh, sized to its
// content bounds), because gaussian clouds have no geometry a raycaster could hit.

let viewTool = "orbit" // "orbit" | "move" | "scale" | "rotate"
let selectedSplatMesh = null

const splatProxyMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false })
const splatSelectionMaterial = new THREE.LineBasicMaterial({ color: 0x5b6ee1, transparent: true, opacity: 0.9 })
const splatDragPlane = new THREE.Plane()
const splatRotQuat = new THREE.Quaternion()
const splatDragPoint = new THREE.Vector3()

function ensureSplatProxies() {
	for (const { mesh } of world.generated) {
		if (mesh.userData.splatProxy?.parent === mesh) continue
		const cb = mesh.userData.contentBox
		if (!cb) continue
		const size = cb.getSize(new THREE.Vector3())
		const centre = cb.getCenter(new THREE.Vector3())
		if (mesh.userData.genKind === "floor") { // floor content boxes carry huge Y headroom — use a thin slab at ground level
			size.y = 0.6
			centre.y = cb.min.y + 0.3
		}
		const proxy = new THREE.Mesh(
			new THREE.BoxGeometry(Math.max(0.2, size.x), Math.max(0.2, size.y), Math.max(0.2, size.z)),
			splatProxyMaterial,
		)
		proxy.position.copy(centre)
		proxy.userData.isSplatProxy = true
		const outline = new THREE.LineSegments(new THREE.EdgesGeometry(proxy.geometry), splatSelectionMaterial)
		outline.userData.isSelectionOutline = true
		outline.visible = false
		proxy.add(outline)
		proxy.userData.outline = outline
		mesh.userData.splatProxy = proxy
		mesh.add(proxy)
	}
}

function selectSplat(mesh) {
	if (selectedSplatMesh === mesh) return
	deselectSplat()
	selectedSplatMesh = mesh
	const outline = mesh?.userData.splatProxy?.userData.outline
	if (outline) outline.visible = true
}

function deselectSplat() {
	const outline = selectedSplatMesh?.userData.splatProxy?.userData.outline
	if (outline) outline.visible = false
	selectedSplatMesh = null
}

function raycastSplatProxies(event) {
	ensureSplatProxies()
	const proxies = world.generated.map(g => g.mesh.userData.splatProxy).filter(Boolean)
	return proxies.length ? raycast(event, proxies) : null
}

function startSplatDrag(event, hit) {
	const mesh = hit.object.parent
	selectSplat(mesh)
	const pivot = hit.object.getWorldPosition(new THREE.Vector3())
	mesh.updateWorldMatrix(true, false)
	drag = {
		mode: viewTool === "rotate" ? "splat-rotate" : viewTool === "scale" ? "splat-scale" : "splat-move",
		pointerId: event.pointerId,
		mesh,
		startPos: mesh.position.clone(),
		startQuat: mesh.quaternion.clone(),
		startScale: mesh.scale.clone(),
		pivot,
		pivotLocal: mesh.worldToLocal(pivot.clone()),
		startPoint: hit.point.clone(),
		startX: event.clientX,
		startY: event.clientY,
		rollAxis: pivot.clone().sub(camera.position).normalize(),
		rollCenter: objectScreenPosition(pivot),
	}
	drag.startAngle = pointerScreenAngle(event, drag.rollCenter)
	renderer.domElement.setPointerCapture(event.pointerId)
	renderer.domElement.classList.add("is-dragging")
}

// Drag on the horizontal plane through the grab point; hold Shift to move vertically.
function updateSplatMove(event) {
	if (event.shiftKey) {
		drag.mesh.position.set(drag.startPos.x, drag.startPos.y + (drag.startY - event.clientY) * 0.02, drag.startPos.z)
		return
	}
	splatDragPlane.set(localUp, -drag.startPoint.y)
	pointerFromEvent(event)
	raycaster.setFromCamera(pointer, camera)
	if (!raycaster.ray.intersectPlane(splatDragPlane, splatDragPoint)) return
	drag.mesh.position.set(
		drag.startPos.x + splatDragPoint.x - drag.startPoint.x,
		drag.startPos.y,
		drag.startPos.z + splatDragPoint.z - drag.startPoint.z,
	)
}

// Uniform scale about the selected splat's own content centre. Keeping all three scale
// components equal avoids Spark's non-uniform-scale averaging limitation.
function updateSplatScale(event) {
	const delta = (event.clientX - drag.startX) - (event.clientY - drag.startY)
	const factor = Math.min(6, Math.max(0.15, Math.exp(delta * 0.01)))
	drag.mesh.scale.copy(drag.startScale).multiplyScalar(factor)
	// The splat's packed coordinates are world-like and its mesh origin is usually zero;
	// compensate position so scaling happens around the proxy/content centre, not origin.
	tmpWorld.copy(drag.pivotLocal).multiply(drag.mesh.scale).applyQuaternion(drag.startQuat)
	drag.mesh.position.copy(drag.pivot).sub(tmpWorld)
}

// Match Build-mode rotation: pointer angle around the object's on-screen centre drives
// a roll about the camera-to-object axis, rather than a sideways-only world-Y spin.
function updateSplatRotate(event) {
	const angle = pointerScreenAngle(event, drag.rollCenter) - drag.startAngle
	splatRotQuat.setFromAxisAngle(drag.rollAxis, angle)
	drag.mesh.quaternion.copy(splatRotQuat).multiply(drag.startQuat)
	drag.mesh.position.copy(drag.startPos).sub(drag.pivot).applyQuaternion(splatRotQuat).add(drag.pivot)
}

function setViewTool(tool) {
	viewTool = tool
	for (const button of els.viewToolButtons) button.classList.toggle("active", button.dataset.viewTool === tool)
	if (tool === "orbit") deselectSplat()
	renderer.domElement.classList.toggle("is-splat-move", tool === "move")
	renderer.domElement.classList.toggle("is-splat-scale", tool === "scale")
	renderer.domElement.classList.toggle("is-splat-rotate", tool === "rotate")
}

// --- Pointer routing --------------------------------------------------------

function pointerDown(event) {
	if (event.button !== 0) return
	if (generating) {
		startOrbit(event) // only camera movement while generating
		return
	}
	if (rawSplatPreview) {
		startOrbit(event) // raw view is deliberately inspection-only
		return
	}
	if (uiTab === "view") {
		// Move/scale/rotate act on the splat under the cursor; anywhere else (or the orbit
		// tool) the drag is the camera. Block-out editing stays a Build-only thing.
		if (viewTool !== "orbit") {
			const hit = raycastSplatProxies(event)
			if (hit) {
				startSplatDrag(event, hit)
				return
			}
			deselectSplat()
		}
		startOrbit(event)
		return
	}

	const hitGizmo = gizmoHit(event)
	if (hitGizmo?.object && startGizmoDrag(event, hitGizmo.object)) return

	// A CLICK (press without drag) on an empty grid cell creates a plot there, with any
	// tool active. Press-and-drag still orbits, so the pointerup handler decides.
	if (plotGrid.plane) {
		const gridHit = raycast(event, [plotGrid.plane])
		if (gridHit) {
			const cell = gridCellAt(gridHit.point)
			if (!cellOccupied(cell)) {
				startOrbit(event)
				drag.pendingCell = cell
				drag.downX = event.clientX
				drag.downY = event.clientY
				return
			}
		}
	}

	if (activeTool === "paint") {
		if (raycast(event, world.raycastables())) startPaint(event)
		else startOrbit(event)
		return
	}

	if (shapeTools.has(activeTool)) {
		const hit = surfaceHit(event)
		if (hit) {
			beginBuildAction() // undo checkpoint: block placement
			focusPlot(world.addPrimitive(activeTool, hit).userData.plotId)
		} else startOrbit(event)
		return
	}

	// pointer / move / scale / rotate / eraser act on a selectable block-out mesh under the cursor.
	const hit = raycast(event, world.selectables())
	// The drawable ground sheet is NOT a selectable object: its colour comes from painting
	// and there are no plots to lift. Only the eraser interacts with it here (removing
	// drawn ground); every other tool treats a sheet hit — ink or void — as empty space.
	if (hit?.object?.userData.isGroundSheet && activeTool !== "eraser") {
		if (selectionTools.has(activeTool)) selectPrimitive(null)
		startOrbit(event)
		return
	}
	if (hit?.object) {
		focusPlot(hit.object.userData.plotId ?? 0)
		if (activeTool === "eraser") {
			if (hit.object.userData.isGroundSheet || hit.object.userData.tile?.userData?.isGroundSheet) {
				startPaint(event, true) // erasing the sheet removes drawn ground (stroke, not select)
				return
			}
			if (hit.object.userData.isGround || hit.object.userData.locked) {
				selectPrimitive(hit.object)
				return
			}
			beginBuildAction() // undo checkpoint: block removal
			world.removePrimitive(hit.object)
			return
		}
		if (activeTool === "scale" || activeTool === "rotate") startPrimitiveDrag(event, hit.object, hit)
		else if (activeTool === "move" && hit.object.userData.isGround) startFloorLift(event, hit.object)
		else selectPrimitive(hit.object)
		return
	}
	if (selectionTools.has(activeTool)) selectPrimitive(null)
	startOrbit(event)
}

renderer.domElement.addEventListener("pointerdown", pointerDown)

renderer.domElement.addEventListener("pointermove", event => {
	if (drag?.mode === "orbit") updateOrbit(event)
	else if (drag?.mode === "paint") paintAtEvent(event)
	else if (drag?.mode === "gizmo") updateGizmoDrag(event)
	else if (drag?.mode === "splat-move") updateSplatMove(event)
	else if (drag?.mode === "splat-scale") updateSplatScale(event)
	else if (drag?.mode === "splat-rotate") updateSplatRotate(event)
	else if (drag && ["scale", "roll"].includes(drag.mode)) updatePrimitiveDrag(event)
	else if (uiTab === "build" && !generating) { updateGhostHover(event); updatePlacement(event) }
})

renderer.domElement.addEventListener("pointerup", event => {
	if (drag?.pointerId === event.pointerId) {
		if (drag.mode === "gizmo") finishGizmoDrag()
		if (drag.mode === "orbit" && drag.pendingCell && Math.hypot(event.clientX - drag.downX, event.clientY - drag.downY) < 5) {
			addPlotAt(drag.pendingCell) // a clean click on an empty cell → new plot
		}
		if (drag.actionPushed && !drag.mutated) activeBuildHistory()?.undo.pop() // drag never moved — drop its checkpoint
		renderer.domElement.releasePointerCapture(event.pointerId)
		drag = null
		renderer.domElement.classList.remove("is-dragging")
		updateTransformGizmo()
	}
})

renderer.domElement.addEventListener("wheel", event => {
	event.preventDefault()
	orbit.radius *= event.deltaY > 0 ? 1.08 : 0.92
	updateCamera()
}, { passive: false })

// --- AI scene building --------------------------------------------------------
// "Describe your scene" no longer splats directly: the server's planner (Gemini)
// designs a block-out — plots with varied heights + coloured boxes — and the editor
// applies it exactly as if the user had built it by hand. The top-right "Generate
// splat" button then turns the current build into splats.

function tileContaining(x, z) {
	const half = floorSize / 2
	return world.groundTiles.find(t => {
		const o = t.userData.origin
		return x >= o.x - half && x <= o.x + half && z >= o.z - half && z <= o.z + half
	}) ?? null
}

function nearestTileTo(x, z) {
	let best = null
	let bestD = Infinity
	for (const t of world.groundTiles) {
		const o = t.userData.origin
		const d = Math.max(Math.abs(x - o.x), Math.abs(z - o.z))
		if (d < bestD) {
			bestD = d
			best = t
		}
	}
	return best
}

function applyScenePlan(plan) {
	setUiTab("build")
	// Frames: the current build survives as its own frame; the plan fills a fresh one.
	// Existing splat frames stay untouched — the tabs are deliberately decoupled.
	snapshotActiveBuildFrame()
	pushBuildFrame()
	selectPrimitive(null)
	for (const mesh of [...world.primitives]) world.removePrimitive(mesh)
	world.clearTiles()
	groundMaster = null // fresh terrain lineage

	// Plots first: their heights shape the ground surface the blocks seat onto.
	const plots = Array.isArray(plan.plots) && plan.plots.length ? plan.plots : [{ ix: 0, iz: 0, height: 0 }]
	for (const p of plots) {
		const ix = Math.round(Number(p.ix) || 0)
		const iz = Math.round(Number(p.iz) || 0)
		if (world.groundTiles.some(t => {
			const c = cellOf(t.userData.origin)
			return c.ix === ix && c.iz === iz
		})) continue
		const tile = world.addGroundTile(ix, iz, ++plotSeq)
		const height = Math.max(-4, Math.min(6, Number(p.height) || 0))
		if (Math.abs(height) > 1e-3) plotHeights.set(tile.userData.plotId, height)
	}
	world.ground = world.groundTiles[0]
	world.paint = world.ground.userData.paint
	activePlotId = world.ground.userData.plotId ?? 0
	syncWorldState()
	if (typeof plan.ground === "string" && /^#[0-9a-f]{6}$/i.test(plan.ground)) world.setGroundColor(plan.ground)

	// Blocks: x/z are world coordinates, y is the block BOTTOM's height above the local
	// ground surface — heightAt() folds in the plot elevations, so blocks land correctly
	// on raised or sunken plots without the planner knowing the height field.
	for (const b of plan.blocks ?? []) {
		let x = Number(b.x) || 0
		let z = Number(b.z) || 0
		const sx = Math.max(0.15, Math.min(12, Number(b.sx) || 1))
		const sy = Math.max(0.15, Math.min(12, Number(b.sy) || 1))
		const sz = Math.max(0.15, Math.min(12, Number(b.sz) || 1))
		let tile = tileContaining(x, z)
		if (!tile) { // snap stragglers onto the nearest plot instead of floating over the void
			tile = nearestTileTo(x, z)
			if (!tile) continue
			const o = tile.userData.origin
			const half = floorSize / 2 - 0.5
			x = Math.max(o.x - half, Math.min(o.x + half, x))
			z = Math.max(o.z - half, Math.min(o.z + half, z))
		}
		const lift = Math.max(0, Math.min(24, Number(b.y) || 0))
		const yaw = ((Number(b.yaw) || 0) * Math.PI) / 180
		const mesh = createPrimitive("box", `prim_${String(nextPrimitiveId++).padStart(3, "0")}`, {
			color: typeof b.color === "string" && /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : "#9b9b9b",
			position: [x, heightAt(x, z) + groundTopY + lift + sy / 2 + 0.006, z],
			rotation: [0, yaw, 0],
			scale: [sx, sy, sz],
		})
		if (yaw) mesh.userData.manualRotation = true
		mesh.userData.world = world
		mesh.userData.plotId = tile.userData.plotId ?? 0
		mesh.userData.support = null
		mesh.userData.supportAxis = { name: "y", sign: 1 }
		world.primitives.push(mesh)
		world.group.add(mesh)
	}

	// Tilt each object cluster perpendicular to the slope it stands on (the same rule
	// seatObjectOnGround applies to splats) — blocks on a hillside must not stand plumb.
	for (const group of computeObjects(world.primitives)) {
		const centre = group.box.getCenter(new THREE.Vector3())
		const q = new THREE.Quaternion().setFromUnitVectors(localUp, slopeNormalAt(centre.x, centre.z))
		const base = new THREE.Vector3(centre.x, group.box.min.y, centre.z)
		for (const mesh of group.primitives) {
			mesh.position.sub(base).applyQuaternion(q).add(base)
			mesh.quaternion.premultiply(q)
		}
	}

	updateElevationHandles()
	updateGhostTiles()
	applyUiTab()
}

async function buildSceneFromPrompt(prompt) {
	if (generating) return
	generating = true
	building = true // Build tab appears as a disabled spinner until the geometry lands
	world.prompt = prompt
	syncGenerateButton()
	setStatus("")
	showProgress(0, 1, "Designing your scene…")
	try {
		const plan = await planScene({ prompt })
		building = false
		applyScenePlan(plan)
		const plots = world.groundTiles.length
		setStatus(`Built ${world.primitives.length} blocks across ${plots} plot${plots === 1 ? "" : "s"} — tweak it, then hit Generate splat`)
		showProgress(1, 1, "Scene ready")
		window.setTimeout(hideProgress, 900)
	} catch (error) {
		setStatus(error.message || "Scene design failed")
		hideProgress()
	} finally {
		generating = false
		building = false
		syncGenerateButton()
	}
}

// --- Draw tab (top-down sketch pad) --------------------------------------------
// A full-screen, pannable "infinite" canvas the user draws their world map onto.
// Strokes are stored as VECTORS in sketch-world coordinates and redrawn each change
// with the pan offset, so the canvas has no edges. The white paper + plot grid are
// the element's CSS background (background-position pans along), which means eraser
// strokes (destination-out) only ever cut ink, never paper. Export crops to the
// inked grid cells and includes light grid lines so Gemini can map cells to plots.

const SKETCH_CELL = 324 // screen px per plot grid cell (CSS grid + export math share this)
const SKETCH_MAX_CELLS = 3 // export crop cap per side — each cell becomes one 16x16 plot
const drawCtx = els.drawCanvas?.getContext("2d")
const sketchPan = { x: 0, y: 0 } // screen offset of the sketch-world origin (grabber pans this)
let sketchStrokes = [] // [{ tool: "pen"|"eraser", color, width, pts: [{x,y}, ...] }] in sketch-world px
let sketchFills = new Map() // "cx,cz" sketch-cell → fill colour (bucket tool; renders UNDER ink)
let lassoSel = null // { path: [{x,y}], strokes: Set } — current lasso selection, world px
let drawStroke = null // in-flight pen/eraser stroke, lasso, or pan drag
let drawTool = "pen"
let sketchDpr = 1
// Ink renders on its own layer, so eraser strokes (destination-out) cut ink only —
// never the paper, the grid, or the bucket fills beneath.
const inkLayer = document.createElement("canvas")
const inkCtx = inkLayer.getContext("2d")

function sketchCellKey(p) {
	return `${Math.floor(p.x / SKETCH_CELL)},${Math.floor(p.y / SKETCH_CELL)}`
}

// --- Draw undo/redo (per draw frame) --------------------------------------------
// Command stack: each action knows how to undo and redo itself. The stack lives on
// the ACTIVE draw frame, so history is localized per sketch (and per tab).

function activeDrawHistory() {
	const frame = frames.draw.find(f => f.id === activeFrameId.draw)
	return frame ? (frame.history ??= { undo: [], redo: [] }) : null
}

function pushDrawAction(action) {
	const h = activeDrawHistory()
	if (!h) return
	h.undo.push(action)
	if (h.undo.length > 50) h.undo.shift()
	h.redo.length = 0
}

function undoDraw() {
	const h = activeDrawHistory()
	if (!h?.undo.length) return
	const action = h.undo.pop()
	action.undo()
	h.redo.push(action)
	lassoSel = null
	redrawSketch()
}

function redoDraw() {
	const h = activeDrawHistory()
	if (!h?.redo.length) return
	const action = h.redo.pop()
	action.redo()
	h.undo.push(action)
	lassoSel = null
	redrawSketch()
}

function shiftStrokes(list, dx, dy) {
	for (const s of list) {
		for (const pt of s.pts) {
			pt.x += dx
			pt.y += dy
		}
	}
}

function pointInPolygon(p, poly) {
	let inside = false
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[i]
		const b = poly[j]
		if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
	}
	return inside
}

function setDrawTool(tool) {
	if (tool !== "lasso") lassoSel = null
	drawTool = tool
	for (const button of els.drawToolButtons) button.classList.toggle("active", button.dataset.drawTool === tool)
	els.drawCanvas?.classList.toggle("is-pan", tool === "pan")
	els.drawCanvas?.classList.toggle("is-bucket", tool === "bucket")
	redrawSketch()
}

function resizeSketchCanvas() {
	if (!els.drawCanvas) return
	sketchDpr = Math.min(window.devicePixelRatio || 1, 2)
	els.drawCanvas.width = Math.round(window.innerWidth * sketchDpr)
	els.drawCanvas.height = Math.round(window.innerHeight * sketchDpr)
	inkLayer.width = els.drawCanvas.width
	inkLayer.height = els.drawCanvas.height
	els.drawCanvas.style.backgroundSize = `${SKETCH_CELL}px ${SKETCH_CELL}px`
	redrawSketch()
}

// Paint every stroke in order under the given world→target transform.
function renderSketchInk(ctx, tx, ty, scale) {
	ctx.save()
	ctx.setTransform(scale, 0, 0, scale, tx, ty)
	ctx.lineCap = "round"
	ctx.lineJoin = "round"
	for (const s of sketchStrokes) {
		ctx.globalCompositeOperation = s.tool === "eraser" ? "destination-out" : "source-over"
		ctx.strokeStyle = s.color
		ctx.fillStyle = s.color
		ctx.lineWidth = s.width
		ctx.beginPath()
		if (s.pts.length === 1) {
			ctx.arc(s.pts[0].x, s.pts[0].y, s.width / 2, 0, Math.PI * 2)
			ctx.fill() // a tap leaves a dot
			continue
		}
		ctx.moveTo(s.pts[0].x, s.pts[0].y)
		for (let i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i].x, s.pts[i].y)
		ctx.stroke()
	}
	ctx.restore()
	ctx.globalCompositeOperation = "source-over"
}

// Compositing is split from ink rendering so pointer-moves stay cheap: the ink layer
// only re-renders every stroke when it actually must (pan, lasso move, undo-ish ops);
// an in-flight pen stroke just appends its newest segment to the layer.
function compositeSketch() {
	if (!drawCtx) return
	const w = els.drawCanvas.width
	const h = els.drawCanvas.height
	drawCtx.setTransform(1, 0, 0, 1, 0, 0)
	drawCtx.globalCompositeOperation = "source-over"
	drawCtx.clearRect(0, 0, w, h)
	// Bucket fills first: the plot's background colour, always under the ink.
	for (const [key, color] of sketchFills) {
		const [cx, cz] = key.split(",").map(Number)
		drawCtx.fillStyle = color
		drawCtx.fillRect((cx * SKETCH_CELL + sketchPan.x) * sketchDpr, (cz * SKETCH_CELL + sketchPan.y) * sketchDpr, SKETCH_CELL * sketchDpr, SKETCH_CELL * sketchDpr)
	}
	drawCtx.drawImage(inkLayer, 0, 0)
	// Lasso overlay (screen only — exports never include it).
	const lassoPath = drawStroke?.mode === "lasso-draw" ? drawStroke.path : lassoSel?.path
	if (lassoPath?.length > 1) {
		drawCtx.save()
		drawCtx.setTransform(sketchDpr, 0, 0, sketchDpr, sketchPan.x * sketchDpr, sketchPan.y * sketchDpr)
		drawCtx.strokeStyle = "#5b6ee1"
		drawCtx.lineWidth = 2
		drawCtx.setLineDash([8, 6])
		drawCtx.beginPath()
		drawCtx.moveTo(lassoPath[0].x, lassoPath[0].y)
		for (let i = 1; i < lassoPath.length; i++) drawCtx.lineTo(lassoPath[i].x, lassoPath[i].y)
		if (drawStroke?.mode !== "lasso-draw") drawCtx.closePath()
		drawCtx.stroke()
		drawCtx.restore()
	}
	els.drawCanvas.style.backgroundPosition = `${sketchPan.x}px ${sketchPan.y}px` // grid pans along
	// The prompt bar only appears once there is something to generate from.
	document.body.classList.toggle("sketch-empty", sketchStrokes.length === 0 && sketchFills.size === 0)
}

function repaintInk() {
	inkCtx.setTransform(1, 0, 0, 1, 0, 0)
	inkCtx.globalCompositeOperation = "source-over"
	inkCtx.clearRect(0, 0, inkLayer.width, inkLayer.height)
	renderSketchInk(inkCtx, sketchPan.x * sketchDpr, sketchPan.y * sketchDpr, sketchDpr)
}

// Synchronous full redraw — for rare events (init, resize, frame switch, clear).
function redrawSketch() {
	if (!drawCtx) return
	repaintInk()
	compositeSketch()
}

// Pointer events fire at 120-250Hz; redraws coalesce to at most one per display frame.
let sketchRafPending = false
let sketchFullPending = false

function scheduleSketch(full) {
	if (full) sketchFullPending = true
	if (sketchRafPending) return
	sketchRafPending = true
	requestAnimationFrame(() => {
		sketchRafPending = false
		if (sketchFullPending) {
			sketchFullPending = false
			repaintInk()
		}
		compositeSketch()
	})
}

// Append just the newest piece of the in-flight stroke to the ink layer.
function drawInkSegment(stroke, from, to) {
	inkCtx.save()
	inkCtx.setTransform(sketchDpr, 0, 0, sketchDpr, sketchPan.x * sketchDpr, sketchPan.y * sketchDpr)
	inkCtx.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over"
	inkCtx.strokeStyle = stroke.color
	inkCtx.fillStyle = stroke.color
	inkCtx.lineWidth = stroke.width
	inkCtx.lineCap = "round"
	inkCtx.lineJoin = "round"
	if (!to) {
		inkCtx.beginPath()
		inkCtx.arc(from.x, from.y, stroke.width / 2, 0, Math.PI * 2)
		inkCtx.fill() // a tap leaves a dot
	} else {
		inkCtx.beginPath()
		inkCtx.moveTo(from.x, from.y)
		inkCtx.lineTo(to.x, to.y)
		inkCtx.stroke()
	}
	inkCtx.restore()
}

function sketchWorldPoint(event) {
	const rect = els.drawCanvas.getBoundingClientRect()
	return { x: event.clientX - rect.left - sketchPan.x, y: event.clientY - rect.top - sketchPan.y }
}

els.drawCanvas?.addEventListener("pointerdown", event => {
	if (event.button !== 0 || generating) return
	if (drawTool === "pan") {
		drawStroke = { mode: "pan", pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: sketchPan.x, panY: sketchPan.y }
		els.drawCanvas.classList.add("is-dragging")
	} else if (drawTool === "bucket") {
		// Fill the clicked cell's background (drives that plot's floor colour on generate).
		const key = sketchCellKey(sketchWorldPoint(event))
		const prev = sketchFills.get(key)
		const next = activeColor
		if (prev !== next) {
			sketchFills.set(key, next)
			pushDrawAction({
				undo: () => (prev === undefined ? sketchFills.delete(key) : sketchFills.set(key, prev)),
				redo: () => sketchFills.set(key, next),
			})
		}
		scheduleSketch(false) // fills live in the composite pass, no ink repaint needed
		return
	} else if (drawTool === "lasso") {
		const p = sketchWorldPoint(event)
		if (lassoSel && pointInPolygon(p, lassoSel.path)) {
			drawStroke = { mode: "lasso-move", pointerId: event.pointerId, last: p, origin: { x: p.x, y: p.y } } // drag the captured ink
		} else {
			lassoSel = null
			drawStroke = { mode: "lasso-draw", pointerId: event.pointerId, path: [p] }
		}
		scheduleSketch(false)
	} else {
		const width = activeBrushScale * 18 * (drawTool === "eraser" ? 2.2 : 1)
		const p = sketchWorldPoint(event)
		const stroke = { tool: drawTool, color: activeColor, width, pts: [p] }
		drawStroke = { mode: "ink", pointerId: event.pointerId, stroke }
		sketchStrokes.push(stroke)
		drawInkSegment(stroke, p, null) // incremental: only the dot, never a full repaint
		scheduleSketch(false)
	}
	try {
		els.drawCanvas.setPointerCapture(event.pointerId)
	} catch { /* synthetic pointers can't be captured */ }
})

els.drawCanvas?.addEventListener("pointermove", event => {
	if (!drawStroke || event.pointerId !== drawStroke.pointerId) return
	if (drawStroke.mode === "pan") {
		sketchPan.x = drawStroke.panX + (event.clientX - drawStroke.startX)
		sketchPan.y = drawStroke.panY + (event.clientY - drawStroke.startY)
		scheduleSketch(true) // the whole ink layer shifts with the pan
	} else if (drawStroke.mode === "lasso-draw") {
		drawStroke.path.push(sketchWorldPoint(event))
		scheduleSketch(false) // overlay only — the ink is untouched
	} else if (drawStroke.mode === "lasso-move") {
		const p = sketchWorldPoint(event)
		const dx = p.x - drawStroke.last.x
		const dy = p.y - drawStroke.last.y
		drawStroke.last = p
		for (const s of lassoSel.strokes) {
			for (const pt of s.pts) {
				pt.x += dx
				pt.y += dy
			}
		}
		for (const pt of lassoSel.path) {
			pt.x += dx
			pt.y += dy
		}
		scheduleSketch(true)
	} else {
		const p = sketchWorldPoint(event)
		drawInkSegment(drawStroke.stroke, drawStroke.stroke.pts.at(-1), p) // append only the new segment
		drawStroke.stroke.pts.push(p)
		scheduleSketch(false)
	}
})

const endSketchStroke = event => {
	if (!drawStroke || event.pointerId !== drawStroke.pointerId) return
	if (drawStroke.mode === "ink") {
		const stroke = drawStroke.stroke
		pushDrawAction({
			undo: () => {
				const i = sketchStrokes.indexOf(stroke)
				if (i >= 0) sketchStrokes.splice(i, 1)
			},
			redo: () => sketchStrokes.push(stroke),
		})
	} else if (drawStroke.mode === "lasso-move" && lassoSel) {
		const dx = drawStroke.last.x - drawStroke.origin.x
		const dy = drawStroke.last.y - drawStroke.origin.y
		if (Math.abs(dx) + Math.abs(dy) > 0.01) {
			const moved = [...lassoSel.strokes]
			pushDrawAction({
				undo: () => shiftStrokes(moved, -dx, -dy),
				redo: () => shiftStrokes(moved, dx, dy),
			})
		}
	}
	if (drawStroke.mode === "lasso-draw" && drawStroke.path.length > 2) {
		// Capture: a pen stroke joins the selection when most of it lies inside the loop.
		const path = drawStroke.path
		const selected = new Set()
		for (const s of sketchStrokes) {
			if (s.tool !== "pen") continue
			let inside = 0
			for (const pt of s.pts) if (pointInPolygon(pt, path)) inside++
			if (inside >= Math.max(1, s.pts.length / 2)) selected.add(s)
		}
		lassoSel = selected.size ? { path, strokes: selected } : null
	}
	drawStroke = null
	els.drawCanvas.classList.remove("is-dragging")
	scheduleSketch(true) // settle with one canonical full repaint
}
els.drawCanvas?.addEventListener("pointerup", endSketchStroke)
els.drawCanvas?.addEventListener("pointercancel", endSketchStroke)

for (const button of els.drawToolButtons) button.addEventListener("click", () => setDrawTool(button.dataset.drawTool))

els.drawClear?.addEventListener("click", () => {
	if (sketchStrokes.length || sketchFills.size) {
		const savedStrokes = [...sketchStrokes]
		const savedFills = new Map(sketchFills)
		pushDrawAction({
			undo: () => {
				sketchStrokes.push(...savedStrokes)
				for (const [k, v] of savedFills) sketchFills.set(k, v)
			},
			redo: () => {
				sketchStrokes.length = 0
				sketchFills.clear()
			},
		})
	}
	sketchStrokes.length = 0
	sketchFills.clear()
	lassoSel = null
	redrawSketch()
})

// Connected components of pen strokes = "stroke objects" (a tree icon drawn with three
// strokes is ONE object). Strokes whose padded boxes touch/overlap connect. Returned in
// reading order (top-to-bottom, then left-to-right) so numbering is stable.
function sketchStrokeClusters() {
	const pens = sketchStrokes.filter(s => s.tool === "pen" && s.pts.length)
	if (!pens.length) return []
	const boxes = pens.map(s => {
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
		for (const p of s.pts) {
			minX = Math.min(minX, p.x - s.width / 2)
			minY = Math.min(minY, p.y - s.width / 2)
			maxX = Math.max(maxX, p.x + s.width / 2)
			maxY = Math.max(maxY, p.y + s.width / 2)
		}
		return { minX, minY, maxX, maxY }
	})
	const SLACK = 18
	const parent = [...Array(pens.length).keys()]
	const find = i => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]]
			i = parent[i]
		}
		return i
	}
	for (let i = 0; i < pens.length; i++) {
		for (let j = i + 1; j < pens.length; j++) {
			const a = boxes[i], b = boxes[j]
			if (a.minX - SLACK < b.maxX && b.minX - SLACK < a.maxX && a.minY - SLACK < b.maxY && b.minY - SLACK < a.maxY) {
				parent[find(i)] = find(j)
			}
		}
	}
	const groups = new Map()
	for (let i = 0; i < pens.length; i++) {
		const root = find(i)
		if (!groups.has(root)) groups.set(root, [])
		groups.get(root).push(i)
	}
	return [...groups.values()].map(idxs => {
		const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
		for (const i of idxs) {
			box.minX = Math.min(box.minX, boxes[i].minX)
			box.minY = Math.min(box.minY, boxes[i].minY)
			box.maxX = Math.max(box.maxX, boxes[i].maxX)
			box.maxY = Math.max(box.maxY, boxes[i].maxY)
		}
		return { ...box, cx: (box.minX + box.maxX) / 2, cy: (box.minY + box.maxY) / 2, w: box.maxX - box.minX, h: box.maxY - box.minY }
	}).sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx))
}

// The export crop: the inked grid cells, snapped outward to whole cells, capped.
function sketchCrop() {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
	for (const s of sketchStrokes) {
		if (s.tool !== "pen") continue
		for (const p of s.pts) {
			minX = Math.min(minX, p.x - s.width / 2)
			minY = Math.min(minY, p.y - s.width / 2)
			maxX = Math.max(maxX, p.x + s.width / 2)
			maxY = Math.max(maxY, p.y + s.width / 2)
		}
	}
	// Bucket-filled cells count as drawn area too.
	for (const key of sketchFills.keys()) {
		const [cx, cz] = key.split(",").map(Number)
		minX = Math.min(minX, cx * SKETCH_CELL)
		minY = Math.min(minY, cz * SKETCH_CELL)
		maxX = Math.max(maxX, (cx + 1) * SKETCH_CELL)
		maxY = Math.max(maxY, (cz + 1) * SKETCH_CELL)
	}
	const c0 = Math.floor(minX / SKETCH_CELL)
	const r0 = Math.floor(minY / SKETCH_CELL)
	return {
		c0,
		r0,
		cols: Math.min(SKETCH_MAX_CELLS, Math.max(1, Math.ceil(maxX / SKETCH_CELL) - c0)),
		rows: Math.min(SKETCH_MAX_CELLS, Math.max(1, Math.ceil(maxY / SKETCH_CELL) - r0)),
	}
}

// Export the crop as ink over white paper with light grid lines, plus a numbered pink
// marker above each stroke-object — the same numbered-circle trick the identify phase
// uses, so Gemini can design "object N" without ever deciding layout.
async function exportNumberedSketch(clusters, crop) {
	const cellPx = Math.max(96, Math.min(320, Math.floor(1536 / Math.max(crop.cols, crop.rows))))
	const scale = cellPx / SKETCH_CELL

	const ink = document.createElement("canvas")
	ink.width = crop.cols * cellPx
	ink.height = crop.rows * cellPx
	renderSketchInk(ink.getContext("2d"), -crop.c0 * SKETCH_CELL * scale, -crop.r0 * SKETCH_CELL * scale, scale)

	const out = document.createElement("canvas")
	out.width = ink.width
	out.height = ink.height
	const ctx = out.getContext("2d")
	ctx.fillStyle = "#ffffff"
	ctx.fillRect(0, 0, out.width, out.height)
	// Bucket fills under the grid: they read as each plot's ground colour.
	for (const [key, color] of sketchFills) {
		const [cx, cz] = key.split(",").map(Number)
		ctx.fillStyle = color
		ctx.fillRect((cx - crop.c0) * cellPx, (cz - crop.r0) * cellPx, cellPx, cellPx)
	}
	ctx.strokeStyle = "#d4d9df"
	ctx.lineWidth = 2
	for (let i = 0; i <= crop.cols; i++) {
		ctx.beginPath()
		ctx.moveTo(i * cellPx, 0)
		ctx.lineTo(i * cellPx, out.height)
		ctx.stroke()
	}
	for (let i = 0; i <= crop.rows; i++) {
		ctx.beginPath()
		ctx.moveTo(0, i * cellPx)
		ctx.lineTo(out.width, i * cellPx)
		ctx.stroke()
	}
	ctx.drawImage(ink, 0, 0)

	const r = Math.max(12, Math.round(cellPx * 0.09))
	ctx.font = `bold ${Math.round(r * 1.3)}px sans-serif`
	ctx.textAlign = "center"
	ctx.textBaseline = "middle"
	ctx.lineWidth = Math.max(2, r * 0.18)
	clusters.forEach((c, i) => {
		const x = Math.min(out.width - r, Math.max(r, (c.cx - crop.c0 * SKETCH_CELL) * scale))
		const y = Math.min(out.height - r, Math.max(r, (c.minY - crop.r0 * SKETCH_CELL) * scale - r * 1.5))
		ctx.beginPath()
		ctx.arc(x, y, r, 0, Math.PI * 2)
		ctx.fillStyle = "#ff2d78"
		ctx.fill()
		ctx.strokeStyle = "#ffffff"
		ctx.stroke()
		ctx.fillStyle = "#ffffff"
		ctx.fillText(String(i + 1), x, y)
	})
	return new Promise(resolve => out.toBlob(resolve, "image/png"))
}

resizeSketchCanvas()
setDrawTool("pen")

// The Draw stage's primary action — fully DETERMINISTIC layout: the client finds the
// stroke-objects, numbers them on the export (like the identify capture), Gemini only
// designs each number's geometry in a LOCAL frame, and the client places every design
// at its stroke-object's exact drawn position. Plots = the sketch's cell rectangle.
// Map bucket-filled sketch cells onto their plots' floor colours — fully deterministic.
function applySketchFillColors(crop) {
	for (const [key, color] of sketchFills) {
		const [cx, cz] = key.split(",").map(Number)
		const ix = cx - crop.c0
		const iz = cz - crop.r0
		if (ix < 0 || iz < 0 || ix >= crop.cols || iz >= crop.rows) continue
		const tile = world.groundTiles.find(t => {
			const c = cellOf(t.userData.origin)
			return c.ix === ix && c.iz === iz
		})
		if (tile) world.setGroundTileColor(tile, color)
	}
}

async function generateGeometryFromDrawing() {
	if (generating) return
	const description = els.chatPrompt.value.trim()
	const clusters = sketchStrokeClusters()
	if (!clusters.length && !sketchFills.size) {
		if (!description) {
			setStatus("Sketch something (or describe it) first")
			return
		}
		buildSceneFromPrompt(description) // no ink — fall back to the text-only planner
		return
	}
	generating = true
	building = true // Build tab shows as a disabled spinner until the geometry lands
	world.prompt = description
	syncGenerateButton()
	setStatus("")
	showProgress(0, 1, "Reading your map…")
	try {
		const crop = sketchCrop()
		// Fills-only sketches need no model at all: plots + colours are pure layout.
		let res = { ground: null, objects: {} }
		if (clusters.length) {
			const image = await exportNumberedSketch(clusters, crop)
			const unitsPerPx = floorSize / SKETCH_CELL
			const footprints = clusters
				.map((c, i) => `Object ${i + 1} is about ${(c.w * unitsPerPx).toFixed(1)} x ${(c.h * unitsPerPx).toFixed(1)} units`)
				.join("; ")
			res = await planSketchObjects({ prompt: description, image, footprints })
		}
		building = false // unlock the Build gate before applyScenePlan switches to it

		// Deterministic assembly: plots are exactly the cropped cell rectangle, and each
		// numbered design lands centred on its stroke-object's drawn position.
		const plan = { plots: [], ground: res.ground, blocks: [] }
		for (let iz = 0; iz < crop.rows; iz++) {
			for (let ix = 0; ix < crop.cols; ix++) plan.plots.push({ ix, iz, height: 0 })
		}
		clusters.forEach((c, i) => {
			const design = res.objects?.[String(i + 1)]
			if (!design?.blocks?.length) return
			const wx = (c.cx / SKETCH_CELL - crop.c0) * floorSize - floorSize / 2
			const wz = (c.cy / SKETCH_CELL - crop.r0) * floorSize - floorSize / 2
			for (const b of design.blocks) {
				plan.blocks.push({ ...b, x: wx + (Number(b.x) || 0), z: wz + (Number(b.z) || 0) })
			}
		})
		applyScenePlan(plan)
		applySketchFillColors(crop) // bucket colours land on their plots, deterministically
		const fp = footprint()
		orbit.target.set(((fp.minIx + fp.maxIx) / 2) * floorSize, 0, ((fp.minIz + fp.maxIz) / 2) * floorSize)
		orbit.theta = FRONT_THETA
		orbit.phi = 0.16 // near top-down, mirroring the map perspective
		orbit.radius = Math.max(floorSize * 2.2, Math.max(fp.cols, fp.rows) * floorSize * 1.35)
		updateCamera()
		showProgress(1, 1, "Scene ready")
		window.setTimeout(hideProgress, 900)
	} catch (error) {
		setStatus(error.message || "Sketch reading failed")
		hideProgress()
	} finally {
		generating = false
		building = false
		syncGenerateButton()
	}
}

// --- Frames ---------------------------------------------------------------------
// Each tab keeps its own independent list of frames on the left: sketches (Draw),
// block-out worlds (Build), splat worlds (View). The pipeline creates them naturally —
// generate-geometry adds a Build frame, generate-splat adds a Splat frame — instead of
// overwriting, and the user can add/delete/switch frames manually in any tab.

let frameSeq = 0
const frames = { draw: [], build: [], view: [] }
const activeFrameId = { draw: 0, build: 0, view: 0 }

function frameLabel(tab, n) {
	return tab === "draw" ? `Sketch ${n}` : tab === "build" ? `Build ${n}` : `Splat ${n}`
}

function syncWorldState() {
	world.state = world.generated.length ? "generated" : "draft"
}

function renderFramesPanel() {
	if (!els.framesList) return
	els.framesTitle.textContent = uiTab === "draw" ? "Sketches" : uiTab === "build" ? "Builds" : "Splats"
	els.framesList.replaceChildren()
	for (const frame of frames[uiTab]) {
		const row = document.createElement("div")
		row.className = "frame-row" + (frame.id === activeFrameId[uiTab] ? " active" : "")
		const name = document.createElement("span")
		name.className = "frame-name"
		name.textContent = frame.name
		name.title = frame.name
		const del = document.createElement("button")
		del.className = "frame-del"
		del.type = "button"
		del.textContent = "×"
		del.title = "Delete this frame"
		del.addEventListener("click", event => {
			event.stopPropagation()
			deleteFrame(uiTab, frame.id)
		})
		row.append(name, del)
		row.addEventListener("click", () => activateFrame(uiTab, frame.id))
		els.framesList.appendChild(row)
	}
}

// -- Draw frames: the live sketch state IS the active frame's data (by reference). --

function newDrawFrame() {
	const frame = { id: ++frameSeq, name: frameLabel("draw", frames.draw.length + 1), strokes: [], fills: new Map(), pan: { x: 0, y: 0 } }
	frames.draw.push(frame)
	return frame
}

function stashActiveDrawFrame() {
	const current = frames.draw.find(f => f.id === activeFrameId.draw)
	if (current) current.pan = { x: sketchPan.x, y: sketchPan.y } // strokes are shared by reference
}

function activateDrawFrame(frame) {
	activeFrameId.draw = frame.id
	sketchStrokes = frame.strokes
	sketchFills = frame.fills ??= new Map()
	sketchPan.x = frame.pan.x
	sketchPan.y = frame.pan.y
	drawStroke = null
	lassoSel = null
	redrawSketch()
}

// -- Build frames: snapshots of the whole block-out (prims + tiles + heights + paint). --

function pushBuildFrame(name) {
	const frame = { id: ++frameSeq, name: name ?? frameLabel("build", frames.build.length + 1), snapshot: null }
	frames.build.push(frame)
	activeFrameId.build = frame.id
	renderFramesPanel()
	return frame
}

function snapshotActiveBuildFrame() {
	const current = frames.build.find(f => f.id === activeFrameId.build)
	if (current) current.snapshot = snapshotBuildWorld()
}

function snapshotBuildWorld() {
	return {
		prims: serializePrimitives(),
		tiles: world.groundTiles.map(tile => {
			const c = cellOf(tile.userData.origin)
			// Paint encodes are the expensive part of a snapshot — cache the dataURL per
			// tile and only re-encode when the paint actually changed (paintVersion bumps).
			const version = tile.userData.paintVersion || 0
			if (tile.userData.paintCache?.version !== version) {
				tile.userData.paintCache = { version, url: tile.userData.paint?.canvas.toDataURL("image/png") ?? null }
			}
			return {
				ix: c.ix,
				iz: c.iz,
				plotId: tile.userData.plotId,
				height: plotHeights.get(tile.userData.plotId) || 0,
				baseColor: tile.userData.baseColor,
				paint: tile.userData.paintCache.url,
			}
		}),
		baseGroundColor: world.baseGroundColor,
		prompt: world.prompt,
	}
}

// --- Build undo/redo (per build frame) ------------------------------------------
// Snapshot-based: every mutating interaction checkpoints the whole block-out first
// (cheap thanks to the paint cache); undo/redo swap whole snapshots. The stacks live
// on the ACTIVE build frame, so history is localized per build (and per tab).

let buildHistoryBusy = false

function activeBuildHistory() {
	const frame = frames.build.find(f => f.id === activeFrameId.build)
	return frame ? (frame.history ??= { undo: [], redo: [] }) : null
}

// Checkpoint the current state before a mutation. Drags call this on pointer-down and
// pop it again if nothing actually moved (see the pointerup handler).
function beginBuildAction() {
	const h = activeBuildHistory()
	if (!h) return
	h.undo.push(snapshotBuildWorld())
	if (h.undo.length > 30) h.undo.shift()
	h.redo.length = 0
}

async function undoBuild() {
	const h = activeBuildHistory()
	if (!h?.undo.length || buildHistoryBusy) return
	buildHistoryBusy = true
	try {
		const snap = h.undo.pop()
		h.redo.push(snapshotBuildWorld())
		await applyBuildSnapshot(snap)
	} finally {
		buildHistoryBusy = false
	}
}

async function redoBuild() {
	const h = activeBuildHistory()
	if (!h?.redo.length || buildHistoryBusy) return
	buildHistoryBusy = true
	try {
		const snap = h.redo.pop()
		h.undo.push(snapshotBuildWorld())
		await applyBuildSnapshot(snap)
	} finally {
		buildHistoryBusy = false
	}
}

function emptyBuildSnapshot() {
	return {
		prims: { primitives: [] },
		tiles: [{ ix: 0, iz: 0, plotId: 0, height: 0, baseColor: baseGroundColor.replace("#", ""), paint: null }],
		baseGroundColor,
		prompt: "",
	}
}

async function applyBuildSnapshot(snap) {
	selectPrimitive(null)
	for (const mesh of [...world.primitives]) world.removePrimitive(mesh)
	// The drawable ground sheet is permanent — restoring a snapshot means wiping the ink
	// and drawing the snapshot's painting back onto the same canvas (alpha included).
	const pidMap = new Map()
	const sheet = world.ground
	const t0 = snap.tiles?.[0]
	const { canvas, ctx, texture } = world.paint
	ctx.clearRect(0, 0, canvas.width, canvas.height)
	if (t0?.paint) {
		await new Promise(resolve => {
			const img = new Image()
			img.onload = () => {
				ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
				resolve()
			}
			img.onerror = resolve
			img.src = t0.paint
		})
	}
	texture.needsUpdate = true
	plotHeights.clear()
	if (Math.abs(t0?.height ?? 0) > 1e-3) plotHeights.set(sheet.userData.plotId ?? 0, t0.height)
	if (t0) pidMap.set(t0.plotId, sheet.userData.plotId ?? 0)
	sheet.userData.paintedColors = new Set()
	// Seed the paint cache with the URL we already have — snapshots of an untouched
	// restored sheet never re-encode.
	sheet.userData.paintVersion = (sheet.userData.paintVersion || 0) + 1
	sheet.userData.paintCache = { version: sheet.userData.paintVersion, url: t0?.paint ?? null }
	world.baseGroundColor = snap.baseGroundColor ?? baseGroundColor
	world.prompt = snap.prompt ?? ""
	activePlotId = sheet.userData.plotId ?? 0
	const prims = snap.prims?.primitives ?? []
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
		mesh.userData.plotId = pidMap.get(p.plotId) ?? (world.ground.userData.plotId ?? 0)
		world.primitives.push(mesh)
		world.group.add(mesh)
		return mesh
	})
	created.forEach((mesh, i) => {
		const p = prims[i]
		if (!mesh) return
		mesh.userData.support = Number.isInteger(p?.support) ? created[p.support] ?? null : null
		mesh.userData.supportAxis = p?.supportAxis ?? { name: "y", sign: 1 }
	})
	groundMaster = null // terrain outpaint context belongs to a single build lineage
	syncWorldState()
	updateElevationHandles()
	updateGhostTiles()
	applyUiTab()
}

// -- Splat frames: each generation run seats into its own frame's record list. --

function beginNewSplatFrame() {
	// Hide every existing frame's splats; the new frame becomes the live target that
	// world.addGenerated() seats into.
	for (const f of frames.view) for (const rec of f.records) rec.mesh.visible = false
	const frame = { id: ++frameSeq, name: frameLabel("view", frames.view.length + 1), records: [] }
	frames.view.push(frame)
	activeFrameId.view = frame.id
	world.generated = frame.records
	world.floorGenerated = false // a fresh frame is a fresh full generation
	for (const tile of world.groundTiles) tile.userData.floorBaked = false
	syncWorldState()
	renderFramesPanel()
	return frame
}

async function activateFrame(tab, id) {
	if (generating) return
	const frame = frames[tab].find(f => f.id === id)
	if (!frame || activeFrameId[tab] === id) return
	if (tab === "draw") {
		stashActiveDrawFrame()
		activateDrawFrame(frame)
	} else if (tab === "build") {
		snapshotActiveBuildFrame()
		activeFrameId.build = id
		await applyBuildSnapshot(frame.snapshot ?? emptyBuildSnapshot())
	} else {
		deselectSplat() // the selection belongs to the frame being left
		activeFrameId.view = id
		for (const f of frames.view) for (const rec of f.records) rec.mesh.visible = false
		world.generated = frame.records
		syncWorldState()
		applyUiTab()
	}
	renderFramesPanel()
	syncViewGate()
}

async function deleteFrame(tab, id) {
	if (generating) return
	const list = frames[tab]
	const idx = list.findIndex(f => f.id === id)
	if (idx < 0) return
	const frame = list[idx]
	if (tab === "view") for (const rec of frame.records) disposeObject(rec.mesh)
	list.splice(idx, 1)
	if (activeFrameId[tab] === id) {
		activeFrameId[tab] = 0
		if (tab === "draw") {
			activateDrawFrame(list.at(-1) ?? newDrawFrame())
		} else if (tab === "build") {
			const next = list.at(-1)
			if (next) {
				activeFrameId.build = next.id
				await applyBuildSnapshot(next.snapshot ?? emptyBuildSnapshot())
			} else {
				// Build is the first stage now, so deleting its last frame immediately
				// replaces it with a fresh one-plot build instead of falling back to Draw.
				await applyBuildSnapshot(emptyBuildSnapshot())
				pushBuildFrame()
				snapshotActiveBuildFrame()
			}
		} else {
			const next = list.at(-1)
			if (next) {
				activeFrameId.view = next.id
				world.generated = next.records
				for (const rec of next.records) rec.mesh.visible = uiTab === "view"
			} else {
				world.generated = []
				if (uiTab === "view") setUiTab("build")
			}
			syncWorldState()
			applyUiTab()
		}
	}
	renderFramesPanel()
	syncViewGate()
}

function addFrameForActiveTab() {
	if (generating) return
	if (uiTab === "draw") {
		stashActiveDrawFrame()
		activateDrawFrame(newDrawFrame())
	} else if (uiTab === "build") {
		snapshotActiveBuildFrame()
		pushBuildFrame()
		applyBuildSnapshot(emptyBuildSnapshot())
	} else {
		beginNewSplatFrame()
		applyUiTab()
	}
	renderFramesPanel()
}

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
	// Make the frozen state visible: not-allowed cursor over both canvases, and no
	// "clickable" affordances left glowing (plot-grid hover, pointer cursor).
	document.body.classList.toggle("is-generating", generating)
	if (generating) {
		clearGhostHover()
		if (placementPreview) placementPreview.visible = false // no frozen ghost block mid-air
	}
	syncViewGate()
}

// Build is always available; View unlocks once the single scene splat has landed.
function syncTabGates() {
	const gate = (name, count, busy) => {
		const btn = els.viewTabs.find(button => button.dataset.viewTab === name)
		if (!btn) return
		btn.classList.remove("hidden")
		btn.disabled = busy || count === 0 // always visible; greyed until it has content
		btn.classList.toggle("is-loading", busy)
	}
	gate("build", frames.build.length, building)
	gate("view", frames.view.length, splatting)
}
const syncViewGate = syncTabGates // existing call sites

function setDevControlsVisible(visible) {
	devControlsVisible = Boolean(visible)
	document.body.classList.toggle("dev-controls-visible", devControlsVisible)
	if (!devControlsVisible) toggleSettings(false)
}

function toggleDevControls() {
	setDevControlsVisible(!devControlsVisible)
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
		fillOverscale: number("fillOverscale"),
		reliefDip: number("reliefDip"),
	}
}

function applyRuntimeConfig(cfg) {
	objectFit = fitSettingsFromConfig(cfg, "object")
	floorFit = fitSettingsFromConfig(cfg, "floor")
	sceneFit = fitSettingsFromConfig(cfg, "scene")
}

function fitSettingsFor(kind) {
	if (kind === "floor") return floorFit
	if (kind === "scene") return sceneFit
	return objectFit
}

// --- Scene yaw estimation ------------------------------------------------------
// Tripo's returned orientation is CONTENT-DEPENDENT — saved runs needed different
// quarter-turns under the same pipeline, with and without terrain — so no fixed yaw
// knob can seat every reconstruction facing its block-out. Estimate the quarter-turn
// per run instead: project the raw splat and the guide blocks through the capture camera
// and pick the yaw whose silhouette overlaps best AND whose distinct colour masses (a
// blue roof, brown crates) land where the same-coloured blocks are.
// Validated offline against runs 0101/0102/0104 (3/3 with wide margins); monochrome
// content falls back to silhouette-only, which is genuinely ambiguous ±90 there.
const ISO_PROJ_RIGHT = [1 / Math.sqrt(2), 0, 1 / Math.sqrt(2)] // capture camera basis
const ISO_PROJ_UP = [1 / Math.sqrt(6), 2 / Math.sqrt(6), -1 / Math.sqrt(6)] // (MIRROR_CAPTURE_X pose)
const YAW_GRID = 32

async function guideOccupancy(blob) {
	if (!blob || typeof createImageBitmap !== "function") return null
	let bitmap
	try {
		bitmap = await createImageBitmap(blob)
		const size = 128
		const canvas = document.createElement("canvas")
		canvas.width = canvas.height = size
		const ctx = canvas.getContext("2d", { willReadFrequently: true })
		ctx.drawImage(bitmap, 0, 0, size, size)
		const data = ctx.getImageData(0, 0, size, size).data
		const pixels = []
		let minX = size, maxX = -1, minY = size, maxY = -1
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const o = (y * size + x) * 4
				if (data[o + 3] <= 20 || data[o] + data[o + 1] + data[o + 2] <= 30) continue
				pixels.push([x, y])
				minX = Math.min(minX, x); maxX = Math.max(maxX, x)
				minY = Math.min(minY, y); maxY = Math.max(maxY, y)
			}
		}
		if (!pixels.length) return null
		const out = new Set()
		for (const [x, y] of pixels) {
			const gx = Math.min(YAW_GRID - 1, Math.floor(((x - minX) / Math.max(1, maxX - minX + 1)) * YAW_GRID))
			// Canvas Y points down; ISO_PROJ_UP points up.
			const gy = Math.min(YAW_GRID - 1, Math.floor(((maxY - y) / Math.max(1, maxY - minY + 1)) * YAW_GRID))
			out.add(gx * YAW_GRID + gy)
		}
		return out
	} catch {
		return null
	} finally {
		bitmap?.close?.()
	}
}

function unitChroma(r, g, b) {
	const m = (r + g + b) / 3
	const v = [r - m, g - m, b - m]
	const l = Math.hypot(v[0], v[1], v[2])
	return l > 1e-6 ? [v[0] / l, v[1] / l, v[2] / l, l] : [0, 0, 0, 0]
}

async function estimateSceneYaw(bytes, meshes, guide = null) {
	// The drawable ground sheet's geometry is always the full 48u canvas, not the actual
	// painted outline, so it would swamp the normalized comparison. Real blocks provide
	// the reliable position/colour anchors for both grounded and object-only scenes.
	meshes = meshes?.filter(mesh => !mesh.userData.isGroundSheet && mesh.geometry)
	if (!meshes?.length || bytes.length < 32 * 100) return null
	// Project every block's sampled volume: occupancy silhouette + per-colour anchors.
	const corner = new THREE.Vector3()
	const blockUV = []
	for (const mesh of meshes) {
		const color = new THREE.Color(`#${mesh.userData.baseColor ?? mesh.material.color.getHexString()}`)
		const key = color.getHexString()
		mesh.updateWorldMatrix(true, false)
		const geo = mesh.geometry.boundingBox ?? (mesh.geometry.computeBoundingBox(), mesh.geometry.boundingBox)
		const vol = mesh.scale.x * mesh.scale.y * mesh.scale.z
		for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let c = 0; c < 3; c++) {
			corner.set(
				geo.min.x + (a / 2) * (geo.max.x - geo.min.x),
				geo.min.y + (b / 2) * (geo.max.y - geo.min.y),
				geo.min.z + (c / 2) * (geo.max.z - geo.min.z),
			).applyMatrix4(mesh.matrixWorld)
			blockUV.push([
				corner.x * ISO_PROJ_RIGHT[0] + corner.y * ISO_PROJ_RIGHT[1] + corner.z * ISO_PROJ_RIGHT[2],
				corner.x * ISO_PROJ_UP[0] + corner.y * ISO_PROJ_UP[1] + corner.z * ISO_PROJ_UP[2],
				key, vol / 27,
			])
		}
	}
	let bu0 = Infinity, bu1 = -Infinity, bv0 = Infinity, bv1 = -Infinity
	for (const [u, v] of blockUV) { bu0 = Math.min(bu0, u); bu1 = Math.max(bu1, u); bv0 = Math.min(bv0, v); bv1 = Math.max(bv1, v) }
	const blockOcc = new Set()
	const anchors = new Map() // colour key -> [Σux, Σvy, Σw]
	let blockMass = 0
	for (const [u, v, key, w] of blockUV) {
		const x = (u - bu0) / Math.max(1e-9, bu1 - bu0)
		const y = (v - bv0) / Math.max(1e-9, bv1 - bv0)
		blockOcc.add(Math.min(YAW_GRID - 1, x * YAW_GRID | 0) * YAW_GRID + Math.min(YAW_GRID - 1, y * YAW_GRID | 0))
		const a = anchors.get(key) ?? anchors.set(key, [0, 0, 0]).get(key)
		a[0] += x * w; a[1] += y * w; a[2] += w
		blockMass += w
	}
	// The actual capture contains the exact projected silhouette and spacing, including
	// irregular bases made from blocks. It is a stronger yaw target than the sparse 3×3×3
	// block samples above. Keep those samples for colour anchors and as a fallback for
	// older sessions where no guide can be rendered.
	const occupancyTarget = await guideOccupancy(guide) ?? blockOcc
	// Parse guide hexes directly — THREE.Color would convert them to the linear working
	// space, while the splat's stored colour bytes (and unitChroma) are display sRGB.
	const anchorChroma = new Map([...anchors.keys()].map(key => [key, unitChroma(
		parseInt(key.slice(0, 2), 16), parseInt(key.slice(2, 4), 16), parseInt(key.slice(4, 6), 16),
	)]))

	// Sample the raw splat (pos f32×3 at +0, rgba u8×4 at +24, 32-byte stride; stored Y
	// is world-inverted — the same flip fit.js bakes with its negative Y scale).
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const count = bytes.length >> 5
	const stride = Math.max(1, Math.floor(count / 20000))
	const pts = []
	for (let i = 0; i < count; i += stride) {
		const o = i << 5
		if (view.getUint8(o + 27) < 40) continue // skip near-transparent reconstruction haze
		pts.push([view.getFloat32(o, true), -view.getFloat32(o + 4, true), view.getFloat32(o + 8, true),
			view.getUint8(o + 24), view.getUint8(o + 25), view.getUint8(o + 26)])
	}
	if (pts.length < 100) return null

	const candidates = [0, 90, 180, 270]
	let bestYaw = null, bestScore = -Infinity
	const scores = []
	for (const yaw of candidates) {
		const th = (yaw * Math.PI) / 180, co = Math.cos(th), si = Math.sin(th)
		const uv = []
		for (const [x, y, z, r, g, b] of pts) {
			const wx = x * co + z * si, wz = -x * si + z * co
			uv.push([
				wx * ISO_PROJ_RIGHT[0] + y * ISO_PROJ_RIGHT[1] + wz * ISO_PROJ_RIGHT[2],
				wx * ISO_PROJ_UP[0] + y * ISO_PROJ_UP[1] + wz * ISO_PROJ_UP[2],
				r, g, b,
			])
		}
		const us = uv.map(p => p[0]).sort((a, b) => a - b)
		const vs = uv.map(p => p[1]).sort((a, b) => a - b)
		const q = (arr, f) => arr[Math.min(arr.length - 1, (f * (arr.length - 1)) | 0)]
		const u0 = q(us, 0.003), u1 = q(us, 0.997), v0 = q(vs, 0.003), v1 = q(vs, 0.997)
		const splatOcc = new Set()
		const colorSums = new Map([...anchors.keys()].map(key => [key, [0, 0, 0]]))
		let n = 0
		for (const [u, v, r, g, b] of uv) {
			const x = (u - u0) / Math.max(1e-9, u1 - u0)
			const y = (v - v0) / Math.max(1e-9, v1 - v0)
			if (x < 0 || x > 1 || y < 0 || y > 1) continue
			n++
			splatOcc.add(Math.min(YAW_GRID - 1, x * YAW_GRID | 0) * YAW_GRID + Math.min(YAW_GRID - 1, y * YAW_GRID | 0))
			const cu = unitChroma(r, g, b)
			if (cu[3] < 10) continue // grey/shadow gaussians carry no colour direction
			let bestKey = null, bestDot = 0.6 // require a decent chroma match to claim a point
			for (const [key, bc] of anchorChroma) {
				if (bc[3] < 10) continue
				const dot = cu[0] * bc[0] + cu[1] * bc[1] + cu[2] * bc[2]
				if (dot > bestDot) { bestDot = dot; bestKey = key }
			}
			if (bestKey) {
				const s = colorSums.get(bestKey)
				s[0] += x; s[1] += y; s[2]++
			}
		}
		let inter = 0
		for (const cell of splatOcc) if (occupancyTarget.has(cell)) inter++
		const iou = inter / Math.max(1, occupancyTarget.size + splatOcc.size - inter)
		let anchorTerm = 0, anchorWeight = 0
		for (const [key, a] of anchors) {
			const s = colorSums.get(key)
			const share = a[2] / blockMass
			if (!s[2] || share > 0.6) continue // the dominant colour is everywhere — no signal
			const w = Math.min(share, s[2] / Math.max(1, n))
			const d = Math.hypot(s[0] / s[2] - a[0] / a[2], s[1] / s[2] - a[1] / a[2])
			anchorTerm += w * (1 - Math.min(1, d * 1.5))
			anchorWeight += w
		}
		const score = iou + (anchorWeight ? 2 * (anchorTerm / anchorWeight) : 0)
		scores.push(`${yaw}°:${score.toFixed(3)}(iou ${iou.toFixed(3)} col ${anchorWeight ? (anchorTerm / anchorWeight).toFixed(3) : "—"})`)
		if (score > bestScore) { bestScore = score; bestYaw = yaw }
	}
	console.log(`[fit] scene yaw estimate → ${bestYaw}° (${scores.join(" ")})`)
	return bestYaw
}

// Two objects are "equal" when their blocks match in relative position, size, spin and
// colour, with nothing painted — equal objects share ONE generated splat, seated once
// per instance (no extra image-edit or reconstruction cost for duplicates).
function objectSignature(group) {
	const base = group.box.getCenter(new THREE.Vector3())
	base.y = group.box.min.y
	const q = v => Math.round(v * 20) / 20
	const parts = []
	for (const p of group.primitives) {
		if (p.userData.paint || p.userData.paintedColors?.size) return null // painted → unique
		const rel = p.getWorldPosition(new THREE.Vector3()).sub(base)
		parts.push([q(rel.x), q(rel.y), q(rel.z), q(p.scale.x), q(p.scale.y), q(p.scale.z), q(p.rotation.x), q(p.rotation.y), q(p.rotation.z), p.userData.baseColor ?? ""].join(","))
	}
	return parts.sort().join("|")
}

// Group equal objects: returns one entry per UNIQUE object with every instance (the
// canonical group included) carrying its original object index for stable naming.
function dedupeObjectGroups(objects) {
	const uniques = []
	const bySig = new Map()
	objects.forEach((group, index) => {
		const sig = objectSignature(group)
		const hit = sig ? bySig.get(sig) : null
		if (hit) hit.instances.push({ group, index })
		else {
			const entry = { group, index, instances: [{ group, index }] }
			uniques.push(entry)
			if (sig) bySig.set(sig, entry)
		}
	})
	return uniques
}

// Bounds used by both generation and saved-session re-fitting. The ground contributes
// only its DRAWN extent (the transparent sheet around the painting is void, not scene).
function wholeSceneBox() {
	const box = new THREE.Box3()
	const ink = world.groundInkBounds()
	if (ink) box.union(ink)
	for (const mesh of world.primitives) box.union(new THREE.Box3().setFromObject(mesh))
	return box.isEmpty() ? new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 1, 2)) : box
}

// Carve the single seated scene splat into independently movable pieces, purely from
// CONTENT. The floor is (nearly) flat, so: estimate a LOCAL floor height map (eroded so
// wide objects cannot fake an elevated floor), call everything within a band of it
// "ground", flood-fill what remains into connected blobs — and make EVERY big blob its
// own piece, including objects the image model invented on its own. The guide blocks are
// not consulted at all: the splat is the sole source of truth for what exists and where.
// (Two objects painted touching each other become one piece — acceptable, and visible.)
function segmentSceneSplat(hasGround = true) {
	const record = world.generated.find(g => g.mesh.userData.genName === "scene")
	const packed = record?.mesh.packedSplats
	if (!packed?.forEachSplat) return

	// ---- The dials ------------------------------------------------------------------
	const FLOOR_BAND = 0.9 // height above local floor that still counts as ground; RAISE if objects grab turf, LOWER if short props vanish into the floor
	const FRINGE_LOW = 0.25 // fringe claim floor: below this stays ground even under a blob (the "contact patch" an object leaves behind)
	const FRINGE_DILATE = 1 // fringe claim reach in voxels beyond the blob's own footprint; raise if object bases get clipped, lower if bases grab a turf ring
	const CELL = 0.5 // floor height-map cell (world units)
	// Resolve every scene at roughly the same voxel density. A fixed world-space voxel
	// made compact scenes far too coarse: the visible gap between two props could land in
	// adjacent voxels and 26-connectivity would merge them into one object. Forty-eight
	// cells across the longest scene axis cleanly separates those gaps while remaining
	// small enough for the bridge/core pass below.
	const VOX_TARGET_CELLS = 48
	const VOX_MIN = 0.06
	const VOX_MAX = 0.25
	const MIN_BLOB = 200 // smaller blobs (grass tufts) fold back into the ground
	const ERODE = 2 // floor-map min-filter radius in cells; raise for very wide flat-bottomed objects faking an elevated floor
	const SKIN_FLATNESS = 0.45 // pancake test: thinnest axis under this fraction of the median axis
	const SKIN_UPRIGHT = 0.75 // ...and lying flat (|vertical component of thin axis| above this) → ground skin, stays behind
	const SKIN_BAND_PAD = 0.4 // how far above FLOOR_BAND the skin cull still applies
	const BRIDGE_MIN_NEIGHBORS = 4 // bridge cutting: voxels with fewer in-blob neighbours are peelable skin/wisps; raise to cut thicker bridges, lower if single objects split apart
	const BRIDGE_MIN_DENSITY = 8 // ...and voxels with fewer gaussians than this are peelable too: object surfaces pack tens per voxel, wispy grass bridges only a few
	const CORE_MIN_VOXELS = 25 // a peeled component must be at least this many voxels to count as a separate object core

	// Pass 1: positions + XZ bounds.
	const n = packed.numSplats
	const pxs = new Float32Array(n)
	const pys = new Float32Array(n)
	const pzs = new Float32Array(n)
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
	packed.forEachSplat((i, center) => {
		pxs[i] = center.x
		pys[i] = center.y
		pzs[i] = center.z
		if (center.x < minX) minX = center.x
		if (center.x > maxX) maxX = center.x
		if (center.y < minY) minY = center.y
		if (center.y > maxY) maxY = center.y
		if (center.z < minZ) minZ = center.z
		if (center.z > maxZ) maxZ = center.z
	})
	const spanX = Math.max(1e-3, maxX - minX)
	const spanY = Math.max(1e-3, maxY - minY)
	const spanZ = Math.max(1e-3, maxZ - minZ)
	const VOX = Math.max(VOX_MIN, Math.min(VOX_MAX, Math.max(spanX, spanY, spanZ) / VOX_TARGET_CELLS))

	// Local floor height map: per-cell low percentile of gaussian heights. A MAP, not a
	// single plane — the drawn ground has real relief. Sparse cells inherit the median.
	const gw = Math.max(1, Math.min(96, Math.ceil(spanX / CELL)))
	const gh = Math.max(1, Math.min(96, Math.ceil(spanZ / CELL)))
	const cellOfXZ = (x, z) => {
		const cx = Math.min(gw - 1, Math.max(0, Math.floor(((x - minX) / spanX) * gw)))
		const cz = Math.min(gh - 1, Math.max(0, Math.floor(((z - minZ) / spanZ) * gh)))
		return cz * gw + cx
	}
	const cellHeights = Array.from({ length: gw * gh }, () => [])
	for (let i = 0; i < n; i++) cellHeights[cellOfXZ(pxs[i], pzs[i])].push(pys[i])
	const floorLevel = new Float32Array(gw * gh).fill(NaN)
	const validLevels = []
	for (let c = 0; c < gw * gh; c++) {
		const hs = cellHeights[c]
		if (hs.length < 6) continue
		hs.sort((a, b) => a - b)
		floorLevel[c] = hs[Math.floor(hs.length * 0.3)]
		validLevels.push(floorLevel[c])
	}
	validLevels.sort((a, b) => a - b)
	const globalFloor = validLevels.length ? validLevels[Math.floor(validLevels.length / 2)] : 0
	for (let c = 0; c < gw * gh; c++) if (Number.isNaN(floorLevel[c])) floorLevel[c] = globalFloor
	// Erode (min-filter) the floor map: cells under a WIDE object see only the object's
	// own surface and estimate a "floor" partway up it, which left the object's lower
	// body behind as a shell when the piece moved. A cell's floor can never sit above
	// its neighbourhood's lowest estimate, so take the neighbourhood minimum — the floor
	// under a rock comes from the grass around it.
	const erodedLevel = new Float32Array(gw * gh)
	for (let cz = 0; cz < gh; cz++) {
		for (let cx = 0; cx < gw; cx++) {
			let low = Infinity
			for (let dz = -ERODE; dz <= ERODE; dz++) {
				for (let dx = -ERODE; dx <= ERODE; dx++) {
					const nx = cx + dx
					const nz = cz + dz
					if (nx < 0 || nx >= gw || nz < 0 || nz >= gh) continue
					const v = floorLevel[nz * gw + nx]
					if (v < low) low = v
				}
			}
			erodedLevel[cz * gw + cx] = low
		}
	}
	floorLevel.set(erodedLevel)

	// Flood fill (26-connected voxel components) over everything ABOVE the floor band.
	const VOFF = 128 // voxel index offset keeps negative heights positive
	const voxels = new Map() // packed voxel key -> { idx, blob, kx, ky, kz }
	for (let i = 0; i < n; i++) {
		if (hasGround && pys[i] <= floorLevel[cellOfXZ(pxs[i], pzs[i])] + FLOOR_BAND) continue
		const kx = Math.floor((pxs[i] - minX) / VOX)
		const kz = Math.floor((pzs[i] - minZ) / VOX)
		const ky = Math.floor(pys[i] / VOX) + VOFF
		const key = (kx * 2048 + kz) * 2048 + ky
		let v = voxels.get(key)
		if (!v) voxels.set(key, v = { idx: [], blob: -1, kx, ky, kz })
		v.idx.push(i)
	}
	const blobs = [] // { count, cols:Set<packed kx,kz> }
	for (const [key, seedVox] of voxels) {
		if (seedVox.blob >= 0) continue
		const id = blobs.length
		const blob = { count: 0, cols: new Set() }
		blobs.push(blob)
		seedVox.blob = id
		const stack = [key]
		while (stack.length) {
			const cur = voxels.get(stack.pop())
			blob.count += cur.idx.length
			blob.cols.add(cur.kx * 4096 + cur.kz)
			for (let dx = -1; dx <= 1; dx++) {
				for (let dz = -1; dz <= 1; dz++) {
					for (let dy = -1; dy <= 1; dy++) {
						if (!dx && !dz && !dy) continue
						const nk = ((cur.kx + dx) * 2048 + (cur.kz + dz)) * 2048 + (cur.ky + dy)
						const nb = voxels.get(nk)
						if (nb && nb.blob < 0) {
							nb.blob = id
							stack.push(nk)
						}
					}
				}
			}
		}
	}
	// Bridge cutting: two SEPARATE objects often flood-fill into one blob through a thin
	// bridge — a chain of grass tufts between them, a contact seam, one diagonal voxel
	// kiss. Bridge voxels have few in-blob neighbours; real surfaces are dense sheets.
	// Peel the low-neighbour skin, find the fat CORES that remain, and if a blob holds
	// two or more cores, grow them back over the peeled voxels (multi-source BFS) and
	// split the blob along that watershed. Peeled remnants that reach no core rejoin
	// whichever side claims them; sub-blobs that end up tiny fold into the ground later.
	const blobVoxKeys = new Map() // blob id -> its voxel keys
	for (const [key, v] of voxels) {
		let arr = blobVoxKeys.get(v.blob)
		if (!arr) blobVoxKeys.set(v.blob, arr = [])
		arr.push(key)
	}
	const neighborKeys = v => {
		const out = []
		for (let dx = -1; dx <= 1; dx++) {
			for (let dz = -1; dz <= 1; dz++) {
				for (let dy = -1; dy <= 1; dy++) {
					if (!dx && !dz && !dy) continue
					out.push(((v.kx + dx) * 2048 + (v.kz + dz)) * 2048 + (v.ky + dy))
				}
			}
		}
		return out
	}
	let splits = 0
	for (const [blobId, keys] of blobVoxKeys) {
		if (blobs[blobId].count < MIN_BLOB || keys.length < CORE_MIN_VOXELS * 2) continue
		const inBlob = new Set(keys)
		// Peel: survivors need in-blob company AND real gaussian density. Thin chains fail
		// the first test; wispy grass-bridge voxels (a handful of gaussians where object
		// surfaces pack dozens) fail the second.
		const survivors = new Set()
		for (const key of keys) {
			const v = voxels.get(key)
			if (v.idx.length < BRIDGE_MIN_DENSITY) continue
			let count = 0
			for (const nk of neighborKeys(v)) if (inBlob.has(nk)) count++
			if (count >= BRIDGE_MIN_NEIGHBORS) survivors.add(key)
		}
		// Cores = connected components of the survivors.
		const coreOf = new Map()
		const coreSizes = []
		for (const key of survivors) {
			if (coreOf.has(key)) continue
			const label = coreSizes.length
			coreSizes.push(0)
			const stack = [key]
			coreOf.set(key, label)
			while (stack.length) {
				const cur = stack.pop()
				coreSizes[coreOf.get(cur)]++
				for (const nk of neighborKeys(voxels.get(cur))) {
					if (survivors.has(nk) && !coreOf.has(nk)) {
						coreOf.set(nk, coreOf.get(cur))
						stack.push(nk)
					}
				}
			}
		}
		const bigCores = coreSizes.map((s, i) => (s >= CORE_MIN_VOXELS ? i : -1)).filter(i => i >= 0)
		if (bigCores.length < 2) continue // one solid core (or none) — nothing to split
		// Grow the big cores back over the whole blob: multi-source BFS, first come wins.
		const owner = new Map()
		const queue = []
		const coreRank = new Map(bigCores.map((c, i) => [c, i]))
		for (const [key, label] of coreOf) {
			if (!coreRank.has(label)) continue
			owner.set(key, coreRank.get(label))
			queue.push(key)
		}
		for (let qi = 0; qi < queue.length; qi++) {
			const cur = queue[qi]
			for (const nk of neighborKeys(voxels.get(cur))) {
				if (inBlob.has(nk) && !owner.has(nk)) {
					owner.set(nk, owner.get(cur))
					queue.push(nk)
				}
			}
		}
		// Relabel: rank 0 keeps this blob id, every further core becomes a new blob.
		const newIds = bigCores.map((_, i) => (i === 0 ? blobId : blobs.push({ count: 0, cols: new Set() }) - 1))
		for (const key of keys) {
			const rank = owner.get(key) ?? 0
			voxels.get(key).blob = newIds[rank]
		}
		splits += bigCores.length - 1
	}
	if (splits) { // recompute per-blob stats after relabeling
		for (const b of blobs) {
			b.count = 0
			b.cols = new Set()
		}
		for (const v of voxels.values()) {
			const b = blobs[v.blob]
			b.count += v.idx.length
			b.cols.add(v.kx * 4096 + v.kz)
		}
	}

	const minBlob = hasGround ? MIN_BLOB : Math.max(40, Math.floor(MIN_BLOB / 4))
	const blobOf = new Int32Array(n).fill(-1)
	for (const v of voxels.values()) {
		const keep = blobs[v.blob].count >= minBlob // tiny floor blobs stay ground; object-only specks attach below
		if (keep) for (const gi of v.idx) blobOf[gi] = v.blob
	}
	const bigBlobIds = blobs.map((b, id) => id).filter(id => blobs[id].count >= minBlob)
	if (!hasGround && !bigBlobIds.length && blobs.length) {
		bigBlobIds.push(blobs.reduce((best, blob, id) => blob.count > blobs[best].count ? id : best, 0))
		for (const v of voxels.values()) if (v.blob === bigBlobIds[0]) for (const gi of v.idx) blobOf[gi] = bigBlobIds[0]
	}

	// With no floor, there must not be a synthetic "ground remainder" piece. Attach
	// sparse disconnected reconstruction specks to the nearest substantial object.
	if (!hasGround && bigBlobIds.length) {
		const centres = new Map(bigBlobIds.map(id => [id, { x: 0, y: 0, z: 0, n: 0 }]))
		for (let i = 0; i < n; i++) {
			const c = centres.get(blobOf[i])
			if (!c) continue
			c.x += pxs[i]; c.y += pys[i]; c.z += pzs[i]; c.n++
		}
		for (const c of centres.values()) {
			const d = Math.max(1, c.n)
			c.x /= d; c.y /= d; c.z /= d
		}
		for (let i = 0; i < n; i++) {
			if (blobOf[i] >= 0) continue
			let nearest = bigBlobIds[0]
			let best = Infinity
			for (const id of bigBlobIds) {
				const c = centres.get(id)
				const d = (pxs[i] - c.x) ** 2 + (pys[i] - c.y) ** 2 + (pzs[i] - c.z) ** 2
				if (d < best) { best = d; nearest = id }
			}
			blobOf[i] = nearest
		}
	}

	// Base-fringe claim: floor-band gaussians directly under a blob's (dilated) footprint
	// and above the fringe floor join that blob, so objects keep their contact base.
	const dilatedCols = new Map() // blob id -> Set of packed columns
	for (const blobId of bigBlobIds) {
		const out = new Set()
		for (const col of blobs[blobId].cols) {
			const kx = Math.floor(col / 4096)
			const kz = col % 4096
			// Dilation: object bases flare outward past the columns their upper body
			// occupies (rock skirts), and the fringe claim should still catch them.
			for (let dx = -FRINGE_DILATE; dx <= FRINGE_DILATE; dx++) for (let dz = -FRINGE_DILATE; dz <= FRINGE_DILATE; dz++) out.add((kx + dx) * 4096 + (kz + dz))
		}
		dilatedCols.set(blobId, out)
	}
	for (let i = 0; hasGround && i < n; i++) {
		if (blobOf[i] >= 0) continue
		const floor = floorLevel[cellOfXZ(pxs[i], pzs[i])]
		if (pys[i] <= floor + FRINGE_LOW || pys[i] > floor + FLOOR_BAND) continue
		const col = Math.floor((pxs[i] - minX) / VOX) * 4096 + Math.floor((pzs[i] - minZ) / VOX)
		for (const [blobId, cols] of dilatedCols) {
			if (cols.has(col)) {
				blobOf[i] = blobId
				break
			}
		}
	}

	// Build the pieces: one per big blob (largest first = obj-001), plus the ground rest.
	const makePart = name => ({ name, packed: new PackedSplats(), bounds: new THREE.Box3() })
	const ground = makePart("scene-ground")
	const ranked = [...bigBlobIds].sort((a, b) => blobs[b].count - blobs[a].count)
	const blobParts = new Map(ranked.map((id, i) => [id, makePart(`obj-${String(i + 1).padStart(3, "0")}`)]))
	const skinNormal = new THREE.Vector3()
	let skinCulled = 0
	packed.forEachSplat((i, center, scales, quaternion, opacity, color) => {
		let part = blobParts.get(blobOf[i]) ?? ground
		// Razor-thin, lying-flat pancakes near floor level are ground SKIN, not object —
		// leave them with the ground even when they sit inside the object's footprint
		// (they sneak in via the fringe claim and read as floor patches when moved).
		// Genuine object material nearby survives: rock skirts are chunky (not razor
		// thin) and tent walls are thin but stand upright (normal not vertical).
		if (hasGround && part !== ground && center.y <= floorLevel[cellOfXZ(center.x, center.z)] + FLOOR_BAND + SKIN_BAND_PAD) {
			const ax = Math.abs(scales.x)
			const ay = Math.abs(scales.y)
			const az = Math.abs(scales.z)
			let minAxis = 0
			let minS = ax
			if (ay < minS) { minAxis = 1; minS = ay }
			if (az < minS) { minAxis = 2; minS = az }
			const midS = Math.max(Math.min(ax, ay), Math.min(Math.max(ax, ay), az)) // median scale
			if (minS < midS * SKIN_FLATNESS) {
				skinNormal.set(minAxis === 0 ? 1 : 0, minAxis === 1 ? 1 : 0, minAxis === 2 ? 1 : 0).applyQuaternion(quaternion)
				if (Math.abs(skinNormal.y) > SKIN_UPRIGHT) {
					part = ground
					skinCulled++
				}
			}
		}
		part.packed.pushSplat(center, scales, quaternion, opacity, color)
		part.bounds.expandByPoint(center)
	})

	// Swap the monolith for its pieces inside the same view-frame records array.
	const idx = world.generated.indexOf(record)
	if (idx >= 0) world.generated.splice(idx, 1)
	disposeObject(record.mesh)
	const seatPiece = (part, kind) => {
		if (!part.packed.numSplats) return 0
		const mesh = new SplatMesh({ packedSplats: part.packed })
		mesh.userData.genName = part.name
		mesh.userData.genKind = kind
		mesh.userData.contentBox = part.bounds.clone()
		world.addGenerated(mesh, [])
		return 1
	}
	let pieces = hasGround ? seatPiece(ground, "floor") : 0
	for (const id of ranked) pieces += seatPiece(blobParts.get(id), "object")
	const remainder = hasGround ? `${blobs.length - bigBlobIds.length} tuft(s) folded into ground, ${skinCulled} floor-skin gaussian(s) left behind` : "no ground piece"
	console.log(`[segment] content → ${pieces} piece(s) from ${n} gaussians (${bigBlobIds.length} object blob(s), ${splits} bridge split(s), voxel ${VOX.toFixed(3)}, ${remainder})`)
}

// Whole-scene generation: ONE capture of the floor + all primitives goes directly to
// ONE TripoSplat call. There is no object identification, per-object image editing,
// floor pass, subject deduplication, or per-object seating in this mode. The modular
// multi-object + plots pipeline (and the sliced-ground terrain path) remains below,
// currently unused.
async function generateWorld(prompt) {
	if (generating) return
	const hasGround = Boolean(world.groundInkBounds())
	if (!hasGround && !world.primitives.length) {
		// The status line is CSS-hidden, so surface the hint where the user is looking.
		els.chatPrompt.value = ""
		els.chatPrompt.placeholder = "Draw some ground with the paint tool first…"
		return
	}
	generating = true
	splatting = true
	world.prompt = prompt
	syncGenerateButton()
	setStatus("")
	clearRawSplatPreview()
	beginNewSplatFrame()
	setUiTab("build")
	showProgress(0, 1, "Capturing complete scene…")

	try {
		const genStart = performance.now()
		const cfg = await getConfig()
		applyRuntimeConfig(cfg)
		let output = null
		try { output = (await newOutput()).index } catch {}

		const box = wholeSceneBox()
		const subjectMeshes = hasGround ? world.allBlockoutMeshes() : [...world.primitives]
		const tCap = performance.now()
		const capture = await captureWorld(renderer, scene, world, box)
		const captureMs = performance.now() - tCap

		splatStore.clear()
		sessionSubjects = []
		showProgress(0, 1, "Texturing and reconstructing complete scene…")
		const bytes = await generateSubject({
			prompt,
			kind: "scene",
			output,
			name: "scene",
			hasGround,
			colors: primitiveColors(subjectMeshes),
			image: capture.guide,
		})
		// Fit a copy so splatStore retains the pristine TripoSplat bytes for ZIP/history.
		// Preserve the one-shot reconstruction's proportions with a uniform fit. The
		// terrain and objects share one cloud, so independently forcing X and Z onto the
		// block-out footprint would stretch/compress every object along with the floor.
		// Estimate every one-shot scene's quarter-turn from its content. The config yaw is
		// only a fallback when a scene is too monochrome or symmetric to disambiguate.
		const sceneYawDeg = await estimateSceneYaw(bytes, subjectMeshes, capture.guide)
			?? (hasGround ? sceneFit.yawDeg : objectFit.yawDeg)
		await seatSubject(bytes.slice(), box, "scene", subjectMeshes, {
			kind: "scene",
			yawTurns: OBJECT_YAW_TURNS,
			yawDeg: sceneYawDeg,
			yOffset: sceneFit.yOffset,
			fillXZ: false,
			colors: primitiveColors(subjectMeshes),
		})
		splatStore.set("scene", bytes)
		sessionSubjects = [{ name: "scene", kind: "scene", plotId: null, yawTurns: OBJECT_YAW_TURNS, fitHeight: false, hasGround, yawDeg: sceneYawDeg }]
		// Carve the one splat into per-object pieces so View can move them; a segmentation
		// failure must never sink the (paid) generation — the monolith is a fine fallback.
		try { segmentSceneSplat(hasGround) } catch (error) { console.warn("segment:", error) }

		console.log(`[timing] whole scene ${((performance.now() - genStart) / 1000).toFixed(1)}s — one capture ${(captureMs / 1000).toFixed(1)}s · one texture edit · one TripoSplat request`)

		world.state = "generated"
		splatting = false
		applyOverlayVisibility()
		setUiTab("view")
		saveBuildToHistory(world.prompt)
		showProgress(1, 1, "Done")
		window.setTimeout(hideProgress, 1000)
	} catch (error) {
		setStatus(error.message || "Generation failed")
		hideProgress()
	} finally {
		generating = false
		splatting = false
		syncGenerateButton()
	}
}

// Reconstruct + seat one subject's splat into its target box. `colors` (hex palette) drives
// the optional splat-side palette lock when it's enabled in config.
function floorSeamBox(box) {
	const out = box.clone()
	out.min.x -= floorSeamOverlap
	out.min.z -= floorSeamOverlap
	out.max.x += floorSeamOverlap
	out.max.z += floorSeamOverlap
	return out
}

function floorSeamClipBoxes(boxes) {
	return boxes?.map(floorSeamBox) ?? null
}

async function seatSubject(bytes, box, name, sourcePrimitives, { kind = "object", yawTurns = 0, yawDeg = 0, yOffset = 0, fitHeight = false, fillXZ = false, colors = null, plotId = null, clipBoxes = null, paletteStrength = null, paletteLightness = null, fileName = `${name}.splat` } = {}) {
	const raw = new SplatMesh({ fileBytes: bytes, fileName })
	await raw.initialized
	const fit = fitSettingsFor(kind)
	const isFloor = kind === "floor"
	// Floors keep their natural height — no vertical compression. fit.js seats the ground
	// sheet at floor level and culls everything below it, so the boxes here only bound
	// X/Z; Y gets effectively unlimited headroom so the world-space clip cull never chops
	// standing relief.
	const FLOOR_HEADROOM = 1000
	const fitBox = isFloor ? floorSeamBox(box) : box
	if (isFloor) fitBox.max.y = fitBox.min.y + FLOOR_HEADROOM
	const fitClipBoxes = isFloor
		? floorSeamClipBoxes(clipBoxes ?? [box]).map(b => {
			b.max.y = b.min.y + FLOOR_HEADROOM
			return b
		})
		: null
	const fitted = await fitSplatToBox(raw, fitBox, {
		yawTurns,
		yawDeg,
		yOffset,
		fitHeight,
		fillXZ: fillXZ || isFloor, // dedicated floor splats may fit X/Z exactly; scenes pass false to preserve proportions
		exactBounds: isFloor, // floors are clamped into the target slab, including thickness
		fillOverscale: fit.fillOverscale, // floors: overfill the tile, clip boxes trim the edges
		reliefDip: fit.reliefDip, // floors: shallow ruts below the sheet survive the underground cull
		clipBoxes: fitClipBoxes,
		opacityFloor: fit.opacityFloor,
		clampK: fit.fitClampK,
		spanLo: fit.fitBboxPercentile,
		spanHi: 1 - fit.fitBboxPercentile,
		palette: fit.paletteLock && colors?.length ? colors : null,
		paletteStrength: paletteStrength ?? fit.paletteStrength,
		paletteLightness: paletteLightness ?? fit.paletteLightness,
	})
	if (!fitted) {
		disposeObject(raw)
		throw new Error(`${name}: splat had no usable bounds after culling`)
	}
	fitted.userData.genName = name
	fitted.userData.genKind = kind
	fitted.userData.genPlotId = kind === "floor" ? plotId : (sourcePrimitives?.[0]?.userData?.plotId ?? 0)
	// Footprint centre + base Y, so elevation can stick the object to the deformed ground surface
	// under it and tilt it to the slope normal there.
	fitted.userData.seatX = (box.min.x + box.max.x) / 2
	fitted.userData.seatZ = (box.min.z + box.max.z) / 2
	fitted.userData.seatBaseY = box.min.y
	world.addGenerated(fitted, sourcePrimitives || [])
	return fitted
}

// --- World expansion ("Add plot") -------------------------------------------
// Plots are 16×16 ground tiles laid edge-to-edge. Objects are generated incrementally per plot,
// and floors are generated as one independently bounded splat per plot.

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

// Drop an adjacent plot at a specific grid cell. The new plot is NOT focused — focus follows
// interaction (building/painting/selecting on it), see focusPlot.
function addPlotAt(cell) {
	// Plot expansion is disabled while testing whole-scene one-shot mode.
	return
}

// --- Plot grid ----------------------------------------------------------------
// Build shows a Draw-style grid on the ground plane: clicking any EMPTY cell creates a
// plot there — including cells that don't touch the existing footprint, so disconnected
// plots are fine. Lives on GHOST_LAYER, so capture cameras never bake it into images.

const plotGrid = { group: null, plane: null, hover: null, minIx: 0, minIz: 0, maxIx: 0, maxIz: 0 }
let hoveredGhost = null // the hovered EMPTY cell {ix,iz}, or null

function gridCellAt(point) {
	return { ix: Math.round(point.x / floorSize), iz: Math.round(point.z / floorSize) }
}

function cellOccupied(cell) {
	return world.groundTiles.some(t => {
		const c = cellOf(t.userData.origin)
		return c.ix === cell.ix && c.iz === cell.iz
	})
}

function clearGhostHover() {
	if (!hoveredGhost) return
	if (plotGrid.hover) plotGrid.hover.visible = false
	document.body.style.cursor = ""
	hoveredGhost = null
}

// Plot expansion is disabled in whole-scene one-shot mode. Keep the shared call sites
// as a cleanup no-op so restoring older snapshots cannot leave stale grid geometry.
function updateGhostTiles() {
	clearGhostHover()
	if (plotGrid.group) disposeObject(plotGrid.group)
	plotGrid.group = null
	plotGrid.plane = null
	plotGrid.hover = null
}

// Hover highlight on the empty cell under the cursor.
function updateGhostHover(event) {
	if (generating) { // input is frozen — nothing should look clickable
		clearGhostHover()
		return
	}
	if (!plotGrid.plane) return
	const hit = raycast(event, [plotGrid.plane])
	const cell = hit ? gridCellAt(hit.point) : null
	if (cell && !cellOccupied(cell)) {
		plotGrid.hover.position.set(cell.ix * floorSize, 0.03, cell.iz * floorSize)
		plotGrid.hover.visible = true
		document.body.style.cursor = "pointer"
		hoveredGhost = cell
	} else clearGhostHover()
}

// --- Plot elevation (hills) -------------------------------------------------
// Raising a plot deforms every generated floor splat via a smooth height field: flat at each
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

function slopeNormalAt(x, z) {
	const eps = Math.max(0.25, floorSize * 0.04)
	const gradX = (heightAt(x + eps, z) - heightAt(x - eps, z)) / (2 * eps)
	const gradZ = (heightAt(x, z + eps) - heightAt(x, z - eps)) / (2 * eps)
	return new THREE.Vector3(-gradX, 1, -gradZ).normalize()
}

function hasPlotElevation() {
	for (const h of plotHeights.values()) {
		if (Math.abs(h) > 1e-4) return true
	}
	return false
}

// A tile-sized grid displaced by the height field — the tile's true (curved) surface.
// Used by the slope preview and by the ground selection highlight.
function buildCurvedTileGeometry(tile, lift) {
	const segments = 24
	const half = floorSize / 2
	const origin = tile.userData.origin
	const positions = []
	const uvs = []
	const indices = []
	for (let z = 0; z <= segments; z++) {
		for (let x = 0; x <= segments; x++) {
			const u = x / segments
			const v = z / segments
			const wx = origin.x - half + u * floorSize
			const wz = origin.z - half + v * floorSize
			positions.push(wx, heightAt(wx, wz) + groundTopY + lift, wz)
			uvs.push(u, 1 - v)
		}
	}
	for (let z = 0; z < segments; z++) {
		for (let x = 0; x < segments; x++) {
			const a = z * (segments + 1) + x
			const b = a + 1
			const c = a + segments + 1
			const d = c + 1
			indices.push(a, c, b, b, c, d)
		}
	}
	const geometry = new THREE.BufferGeometry()
	geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
	geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
	geometry.setIndex(indices)
	// No normals: every consumer (slope preview, selection highlight) is unlit MeshBasic.
	return geometry
}

function makeGroundSlopePreview(tile) {
	const geometry = buildCurvedTileGeometry(tile, 0.035)
	const material = new THREE.MeshBasicMaterial({
		color: 0xffffff,
		map: tile.userData.paint?.texture ?? null,
		side: THREE.DoubleSide,
		depthWrite: true,
	})
	applyGroundDepthBias(material)
	const mesh = new THREE.Mesh(geometry, material)
	// Plot-boundary outline on the curved surface too (its geometry is smooth, so a high
	// crease threshold keeps slope shading clean and only the border loop draws).
	addEdgeOutline(mesh, `#${tile.userData.baseColor ?? baseGroundColor.replace("#", "")}`, { threshold: 15 })
	mesh.userData.isGroundSlopePreview = true
	mesh.userData.isGround = true
	mesh.userData.tile = tile // hits on the curved surface resolve back to the editable flat tile
	mesh.userData.plotId = tile.userData.plotId
	mesh.userData.origin = tile.userData.origin
	mesh.userData.paint = tile.userData.paint
	mesh.renderOrder = 3
	return mesh
}

function updateGroundSlopePreview() {
	if (!hasPlotElevation()) {
		for (const mesh of world.groundSlopePreviews) disposeObject(mesh)
		world.groundSlopePreviews = []
		return
	}
	// Fast path (height drags): the tile set is unchanged, so update the existing
	// geometries' heights IN PLACE instead of disposing and reallocating every mesh —
	// this runs once per frame during a plot lift.
	const previews = world.groundSlopePreviews
	if (previews.length === world.groundTiles.length && previews.every((p, i) => p.userData.tile === world.groundTiles[i])) {
		for (const preview of previews) {
			const pos = preview.geometry.attributes.position
			for (let i = 0; i < pos.count; i++) {
				pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)) + groundTopY + 0.035)
			}
			pos.needsUpdate = true
			preview.geometry.computeBoundingSphere() // ground raycasts rely on it
			const edges = preview.children.find(child => child.userData.isEdgeOutline)
			if (edges) { // the plot-border outline follows the new heights
				edges.geometry.dispose()
				edges.geometry = new THREE.EdgesGeometry(preview.geometry, 15)
			}
			preview.visible = uiTab === "build"
		}
		return
	}
	// Slow path: the tile set changed — rebuild. EVERY tile gets its curved surface
	// whenever any plot is elevated — including after the floor splat is baked. Build
	// must always show the plots smoothly connected; the View tab hides these previews
	// and shows the deformed floor splat instead. The curved mesh doubles as the ground
	// raycast target so clicks land on the true surface.
	for (const mesh of previews) disposeObject(mesh)
	world.groundSlopePreviews = []
	for (const tile of world.groundTiles) {
		const preview = makeGroundSlopePreview(tile)
		preview.visible = uiTab === "build" // View renders splats only
		world.group.add(preview)
		world.groundSlopePreviews.push(preview)
	}
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
	for (const g of world.generated) {
		if (g.mesh.userData.genKind === "floor") deformGround(g.mesh)
	}
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
	const normal = slopeNormalAt(x, z)
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

// Keep editable floor tiles and slope previews aligned to the current plot heights.
function updateElevationHandles() {
	const slopePreview = hasPlotElevation() // curved surfaces cover the flat tiles whenever any plot is elevated, baked or not
	updateGroundSlopePreview()
	refreshGroundSelectionHighlight()
	for (const tile of world.groundTiles) {
		tile.position.y = groundThickness / 2 + (plotHeights.get(tile.userData.plotId) || 0) + (tile.userData.seamLift || 0)
		// View renders splats only — every tile hides (the Colliders debug overlay excepted).
		if (uiTab === "view") {
			if (showColliders && world.state === "generated") {
				setPickableHidden(tile, false)
				tile.visible = true
			} else tile.visible = false
			continue
		}
		// Build: every tile is a visible, editable slab — unless a curved slope preview
		// covers it (elevation draft), where the flat tile goes transparent underneath.
		setPickableHidden(tile, false) // restore the green paint map if this tile was ever hidden
		tile.material.transparent = slopePreview
		tile.material.opacity = slopePreview ? 0 : 1
		tile.material.depthWrite = !slopePreview
		tile.material.needsUpdate = true
		setEdgeOutlineVisible(tile, !slopePreview && !tile.userData.isGroundSheet) // sheet outline stays hidden (no plot border around the void)
		tile.visible = true
	}
}

function setPlotHeight(pid, height) {
	const clamped = Math.max(-floorSize, Math.min(floorSize, height))
	const old = plotHeights.get(pid) || 0
	if (Math.abs(clamped - old) < 1e-4) return
	// Blocks must STICK to the curved surface and tilt perpendicular to it, exactly like
	// seatObjectOnGround does for splats — not just translate straight up. Each object
	// cluster moves rigidly: sample the height field at the cluster's footprint centre
	// BEFORE the change, then apply the delta (rotate about the cluster's base by the
	// slope-normal change, lift by the surface-height change). Clusters everywhere are
	// affected — a plot's height also reshapes neighbouring plots near the shared seam.
	const clusters = computeObjects(world.primitives).map(group => {
		const centre = group.box.getCenter(new THREE.Vector3())
		return { group, x: centre.x, z: centre.z, baseY: group.box.min.y, h0: heightAt(centre.x, centre.z), n0: slopeNormalAt(centre.x, centre.z) }
	})
	plotHeights.set(pid, clamped)
	for (const c of clusters) {
		const dq = new THREE.Quaternion().setFromUnitVectors(localUp, slopeNormalAt(c.x, c.z))
			.multiply(new THREE.Quaternion().setFromUnitVectors(localUp, c.n0).invert())
		const base = new THREE.Vector3(c.x, c.baseY, c.z)
		const lift = heightAt(c.x, c.z) - c.h0
		for (const mesh of c.group.primitives) {
			mesh.position.sub(base).applyQuaternion(dq).add(base)
			mesh.position.y += lift
			mesh.quaternion.premultiply(dq)
		}
	}
	// Generated splats intentionally NOT re-seated: Build edits after generation no longer
	// move View content — the tabs are decoupled (View has its own move/rotate tools).
	elevationDirty = true // terrain preview refresh is coalesced to once per frame (animate)
}

// --- Cohesive-texture-sliced ground -------------------------------------------------
// ONE terrain TEXTURE is generated for the whole footprint (top-down, so per-tile
// slicing is a plain rectangle crop), then each occupied tile's slice is projected to
// the object-capture iso pose and reconstructed as its OWN splat. Every plot's ground
// comes from the same image, so the design flows across plot borders — no repetition,
// no per-generation seams — while per-tile splat density stays constant no matter how
// many plots the world has. The texture (already top-down) becomes `groundMaster`
// directly, so a later add-plot outpaints from it and only the NEW tiles get splats
// (`newTiles` limits the splat step; existing tiles keep theirs untouched).
async function generateSlicedGround(groundPromptText, output, newTiles = null) {
	const fp = footprint()
	const size = groundImageSize(fp.cols, fp.rows)
	const { canvas, mask } = buildGroundComposite(fp, size) // mask (if any) preserves kept terrain, outpaints the rest
	let groundColorHex = world.baseGroundColor
	let groundColors = primitiveColors(world.groundTiles)
	if (groundMaster?.imageEl) {
		const existing = sampleImageColor(groundMaster.imageEl)
		if (existing) {
			groundColorHex = existing
			groundColors = [existing, ...groundColors] // keep both hues in the palette so the seam can transition
		}
	}
	const res = await generateGroundTexture({
		prompt: groundPromptText, image: await canvasToBlob(canvas), mask: mask ? await canvasToBlob(mask) : null,
		groundColor: groundColorHex, colors: groundColors, cols: fp.cols, rows: fp.rows,
		imageSize: size.label, output, name: "floor",
	})
	const texture = await blobToImage(res.imageBlob)
	const cellW = texture.width / fp.cols
	const cellH = texture.height / fp.rows

	// Reconstruct per tile, bounded by the same concurrency knob as object generation.
	const tiles = [...(newTiles ?? world.groundTiles)]
	const cfg = await getConfig()
	const concurrency = Math.max(1, Math.floor(cfg.genConcurrency || 1))
	let seated = 0
	await runPool(tiles, concurrency, async tile => {
		try {
			const c = cellOf(tile.userData.origin)
			const pid = tile.userData.plotId ?? 0
			const crop = document.createElement("canvas")
			crop.width = Math.max(1, Math.round(cellW))
			crop.height = Math.max(1, Math.round(cellH))
			crop.getContext("2d").drawImage(
				texture,
				(c.ix - fp.minIx) * cellW, (c.iz - fp.minIz) * cellH, cellW, cellH,
				0, 0, crop.width, crop.height,
			)
			// Tripo gets the same isometric pose as every object capture (top-down sheets
			// reconstruct unreliably); skip_image_edit sends the slice straight to Tripo.
			const iso = projectGroundIso(crop, 1, 1, 1024, 1024)
			const name = `floor-p${pid}`
			const bytes = await generateSubject({
				prompt: groundPromptText, kind: "floor", output, name,
				colors: primitiveColors([tile]), image: await canvasToBlob(iso), skipImageEdit: true,
			})
			const box = world.floorBoxForTile(tile)
			// bytes.slice(): the SplatMesh gets its own buffer in case the parser transfers it
			const mesh = await seatSubject(bytes.slice(), box, name, null, {
				kind: "floor", yawTurns: FLOOR_YAW_TURNS, yawDeg: floorFit.yawDeg, yOffset: floorFit.yOffset,
				fillXZ: true, colors: primitiveColors([tile]), plotId: pid, clipBoxes: [box],
			})
			mesh.userData.floorCells = new Set([`${c.ix},${c.iz}`])
			backfillFloorHoles(mesh, crop, box)
			splatStore.set(name, bytes)
			seated++
		} catch (error) {
			console.warn(`floor-p${tile.userData.plotId ?? 0}:`, error.message)
		}
	})
	if (!seated) throw new Error("no floor tile could be reconstructed")

	world.groundGenerated()
	// The texture IS top-down — it becomes the outpaint master for the next expansion directly.
	groundMaster = { imageEl: texture, cols: fp.cols, rows: fp.rows, minIx: fp.minIx, minIz: fp.minIz }
	blendFloorSeamColors() // soften any residual per-tile border difference in splat space
	return true
}

// Backstop against "patchy" floors: TripoSplat sometimes STARVES large smooth regions
// (flat pond water, uniform sand) of gaussians entirely, leaving see-through holes in a
// seated tile no prompt wording reliably prevents. Scan the tile footprint on a grid
// and pave every near-empty cell with flat sheet gaussians coloured straight from the
// tile's own texture slice — the ground truth for what belongs there. Writes into the
// free tail capacity the fit's culling left in the packed buffer (silently stops when
// full), so healthy tiles cost nothing and holes become flat painted ground.
function backfillFloorHoles(mesh, crop, box) {
	const packed = mesh.packedSplats
	if (!packed?.forEachSplat || !packed.setSplat) return
	const G = 24
	const counts = new Int32Array(G * G)
	const x0 = box.min.x
	const z0 = box.min.z
	const w = Math.max(1e-6, box.max.x - x0)
	const d = Math.max(1e-6, box.max.z - z0)
	packed.forEachSplat((_i, center) => {
		const gx = Math.floor(((center.x - x0) / w) * G)
		const gz = Math.floor(((center.z - z0) / d) * G)
		if (gx >= 0 && gx < G && gz >= 0 && gz < G) counts[gz * G + gx]++
	})
	// Spark's setSplat auto-grows the packed buffer (ensureSplats), so pancakes can be
	// appended freely; the cap only bounds pathological all-empty tiles.
	const start = packed.numSplats
	const cap = start + 4096
	let write = start
	const pixels = crop.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, crop.width, crop.height).data
	const centre = new THREE.Vector3()
	const scales = new THREE.Vector3(w / G * 0.6, 0.02, d / G * 0.6) // flat pancakes, one cell wide-ish
	const quat = new THREE.Quaternion()
	const colour = new THREE.Color()
	const y = box.min.y + 0.04
	let holes = 0
	for (let gz = 0; gz < G; gz++) {
		for (let gx = 0; gx < G; gx++) {
			if (counts[gz * G + gx] >= 2) continue
			holes++
			for (let k = 0; k < 4 && write < cap; k++) {
				const fx = (gx + 0.25 + 0.5 * (k & 1)) / G // deterministic 2x2 sub-jitter per cell
				const fz = (gz + 0.25 + 0.5 * (k >> 1)) / G
				const px = Math.min(crop.width - 1, Math.floor(fx * crop.width))
				const pz = Math.min(crop.height - 1, Math.floor(fz * crop.height))
				const o = (pz * crop.width + px) * 4
				colour.setRGB(pixels[o] / 255, pixels[o + 1] / 255, pixels[o + 2] / 255)
				centre.set(x0 + fx * w, y, z0 + fz * d)
				packed.setSplat(write, centre, scales, quat, 1, colour)
				write++
			}
		}
	}
	if (write === start) return
	console.log(`[backfill] ${mesh.userData?.genName || "floor"}: paved ${holes} empty cells with ${write - start} sheet gaussians`)
	packed.needsUpdate = true
}

// --- Seam colour blending (math, not the image model) -------------------------------
// A GRADIENT between the two plots' colours across every shared border: each plot keeps its own
// colour in its body, and over a wide band on each side of the border the gaussian colours ramp
// from plot A's colour, through their exact midpoint AT the border, to plot B's colour. Pure
// splat-space math — the image model is never trusted to blend. Runs after floor seating; a
// single-splat world is a no-op.
const SEAM_BLEND_BAND = floorSize * 0.4 // gradient half-width per side (0.4 → ~13u total ramp)
const SEAM_BLEND_MAX = 0.95 // convergence at the border (1 = both sides meet exactly at the mid colour)

const smooth01 = t => t * t * (3 - 2 * t) // smoothstep — soft ease instead of a linear ramp

function blendFloorSeamColors() {
	const floors = world.generated.map(g => g.mesh).filter(m => m.userData.genKind === "floor")
	if (floors.length < 2) return
	const owner = new Map() // "ix,iz" → floor mesh (later meshes win: an added plot overrides stale cells)
	for (const mesh of floors) {
		if (mesh.userData.floorCells) for (const key of mesh.userData.floorCells) owner.set(key, mesh)
	}
	// Fallback: a floor restored from an older build may not carry floorCells — give the single
	// untagged mesh every occupied cell nobody else claims, so its seams still blend.
	const untagged = floors.filter(m => !m.userData.floorCells?.size)
	if (untagged.length === 1) {
		for (const key of occupiedCells()) if (!owner.has(key)) owner.set(key, untagged[0])
	}
	// One seam per shared edge between cells owned by different meshes (+X/+Z only → no duplicates).
	let seams = 0
	for (const [key, mesh] of owner) {
		const [ix, iz] = key.split(",").map(Number)
		const nx = owner.get(`${ix + 1},${iz}`)
		if (nx && nx !== mesh) { blendOneSeam({ axis: "x", at: (ix + 0.5) * floorSize, lo: (iz - 0.5) * floorSize, hi: (iz + 0.5) * floorSize, a: mesh, b: nx }); seams++ }
		const nz = owner.get(`${ix},${iz + 1}`)
		if (nz && nz !== mesh) { blendOneSeam({ axis: "z", at: (iz + 0.5) * floorSize, lo: (ix - 0.5) * floorSize, hi: (ix + 0.5) * floorSize, a: mesh, b: nz }); seams++ }
	}
	if (seams) console.log(`[seam] gradient-blended ${seams} plot border(s)`)
}

// Blend one 16-unit border segment at `axis`=`at` between mesh `a` (negative side) and `b`
// (positive side), for gaussians whose along-seam coordinate is in [lo, hi].
function blendOneSeam({ axis, at, lo, hi, a, b }) {
	const W = SEAM_BLEND_BAND
	const coordOf = c => (axis === "x" ? c.x : c.z)
	const alongOf = c => (axis === "x" ? c.z : c.x)
	// 1. Each side's PLOT colour = mean over its whole adjacent tile strip (stable even when the
	// pixels right at the border already drifted), sampled per seam so multi-colour plots stay local.
	const meanOf = (mesh, sign) => {
		const acc = [0, 0, 0, 0]
		mesh.packedSplats.forEachSplat((i, center, scales, quaternion, opacity, color) => {
			const d = coordOf(center) - at
			const along = alongOf(center)
			if (along < lo || along > hi) return
			if (sign < 0 ? (d >= 0 || d < -floorSize) : (d <= 0 || d > floorSize)) return
			acc[0] += color.r; acc[1] += color.g; acc[2] += color.b; acc[3]++
		})
		return acc[3] >= 16 ? [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]] : null
	}
	const ma = meanOf(a, -1)
	const mb = meanOf(b, +1)
	if (!ma || !mb) return // one side has no coverage here — nothing to blend toward
	// 2. The gradient: ideal(t) = lerp(plotA, plotB, t) with t 0→1 across the band; each gaussian
	// is pulled toward ideal by a smoothstep weight that peaks at the border (both sides converge
	// on the exact mid colour) and fades to zero at the band edge (plot keeps its own colour).
	const apply = (mesh, sign) => {
		const packed = mesh.packedSplats
		packed.forEachSplat((i, center, scales, quaternion, opacity, color) => {
			const d = coordOf(center) - at
			const along = alongOf(center)
			if (along < lo || along > hi || Math.abs(d) > W) return
			if (sign < 0 ? d > 0 : d < 0) return
			const t = (d / W + 1) / 2 // 0 at A's band edge → 0.5 at the border → 1 at B's band edge
			const w = smooth01(1 - Math.abs(d) / W) * SEAM_BLEND_MAX
			color.r += (ma[0] + (mb[0] - ma[0]) * t - color.r) * w
			color.g += (ma[1] + (mb[1] - ma[1]) * t - color.g) * w
			color.b += (ma[2] + (mb[2] - ma[2]) * t - color.b) * w
			packed.setSplat(i, center, scales, quaternion, opacity, color)
		})
		packed.needsUpdate = true
	}
	apply(a, -1)
	apply(b, +1)
}

// Generate / extend a multi-plot world: ONE unified ground splat sliced to the occupied tiles,
// then objects generated only for plots not yet built (existing object splats stay frozen).
async function generateExpanded(prompt) {
	if (generating) return
	generating = true
	splatting = true // gates the View tab until the expansion lands
	world.prompt = prompt
	syncGenerateButton()
	setStatus("")
	clearRawSplatPreview()
	beginNewSplatFrame() // fresh frame → builtPlotIds() is empty → all plots build fresh
	setUiTab("build")

	const cfg = await getConfig()
	applyRuntimeConfig(cfg)
	const concurrency = Math.max(1, Math.floor(cfg.genConcurrency || 1))

	const already = builtPlotIds()
	const toBuild = orderedPlotIds().filter(pid => !already.has(pid) && plotPrimitives(pid).length)
	let totalObjects = 0
	for (const pid of toBuild) totalObjects += dedupeObjectGroups(computeObjects(plotPrimitives(pid))).length
	const total = 1 + totalObjects // 1 = the unified ground splat
	let done = 0
	showProgress(0, total, "Preparing expansion…")

	try {
		let output = null
		try { output = (await newOutput()).index } catch {}

		// 1. FLOOR. Two modes:
		//  - ADD-PLOT (a floor already exists and only some tiles are new): keep the existing floor
		//    UNTOUCHED and generate ONLY the new plot(s) — design continued from the neighbour, but
		//    colours locked to the new plot's own paint, seam-merged at the border.
		//  - FIRST multi-plot generation (nothing baked yet): ONE unified splat spanning the whole
		//    footprint, sliced to the occupied tiles so empty cells (the hole in a ring/U) are culled.
		const newFloorTiles = world.groundTiles.filter(t => !t.userData.floorBaked)
		const hasExistingFloor = world.generated.some(g => g.mesh.userData.genKind === "floor")
		if (hasExistingFloor && newFloorTiles.length && newFloorTiles.length < world.groundTiles.length) {
			showProgress(done, total, "Growing into the new plot…")
			try {
				// Outpaint the master texture across the new tiles, splat ONLY those slices.
				await generateSlicedGround(prompt, output, newFloorTiles)
			} catch (error) {
				console.warn("added floor:", error.message)
				setStatus("Ground generation failed: " + (error.message || error))
			}
		} else {
			world.removeGeneratedWhere(g => g.mesh.userData.genKind === "floor")
			world.floorGenerated = false
			updateElevationHandles()
			for (const name of [...splatStore.keys()]) {
				if (name === "floor" || name.startsWith("floor-p")) splatStore.delete(name)
			}
			showProgress(done, total, groundMaster ? "Extending terrain (seamless)…" : "Generating terrain…")
			try {
				// ONE cohesive texture over the whole footprint, sliced into per-tile splats.
				await generateSlicedGround(prompt, output)
			} catch (error) {
				console.warn("ground:", error.message)
				setStatus("Ground generation failed: " + (error.message || error))
			}
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

			const uniqueForPlot = dedupeObjectGroups(objects)
			const subjects = []
			for (const entry of uniqueForPlot) {
				const cap = await captureObject(renderer, scene, world, entry.group)
				subjects.push({
					image: cap.guide, box: entry.group.box, name: `p${pid}-obj-${String(entry.index + 1).padStart(3, "0")}`,
					label: labels[String(entry.index + 1)] || "", instances: entry.instances, colors: primitiveColors(entry.group.primitives),
				})
			}
			await runPool(subjects, concurrency, async s => {
				try {
					const bytes = await generateSubject({ prompt, kind: "object", output, name: s.name, label: s.label, colors: s.colors, image: s.image })
					for (const inst of s.instances) {
						const name = `p${pid}-obj-${String(inst.index + 1).padStart(3, "0")}`
						await seatSubject(bytes.slice(), inst.group.box, name, inst.group.primitives, { kind: "object", yawTurns: OBJECT_YAW_TURNS, yawDeg: objectFit.yawDeg, yOffset: objectFit.yOffset, fitHeight: true, colors: s.colors })
						splatStore.set(name, bytes)
					}
				} catch (error) {
					console.warn(`${s.name}:`, error.message)
				}
				done++
				showProgress(done, total)
			})
		}

		applyAllPlotHeights() // re-apply any hills to the freshly-seated ground + objects
		world.state = "generated"
		splatting = false // unlock the View gate before switching to it
		applyOverlayVisibility()
		setUiTab("view")
		sessionSubjects = world.generated
			.map(g => ({
				name: g.mesh.userData.genName,
				kind: g.mesh.userData.genKind ?? "object",
				plotId: g.mesh.userData.genPlotId ?? null,
				yawTurns: g.mesh.userData.genKind === "floor" ? FLOOR_YAW_TURNS : OBJECT_YAW_TURNS,
				fitHeight: g.mesh.userData.genKind !== "floor",
			}))
			.filter(s => s.name)
		saveBuildToHistory(world.prompt)
		showProgress(total, total, "Done")
		window.setTimeout(hideProgress, 1000)
	} catch (error) {
		setStatus(error.message || "Expansion failed")
		hideProgress()
	} finally {
		generating = false
		splatting = false
		syncGenerateButton()
	}
}

function fileStem(file) {
	return file.name.replace(/\.[^.]+$/, "")
}

function clearRawSplatPreview() {
	if (!rawSplatPreview) return
	disposeObject(rawSplatPreview)
	rawSplatPreview = null
	world.group.visible = true
	if (rawOrbitSnapshot) {
		orbit.target.copy(rawOrbitSnapshot.target)
		orbit.radius = rawOrbitSnapshot.radius
		orbit.theta = rawOrbitSnapshot.theta
		orbit.phi = rawOrbitSnapshot.phi
		rawOrbitSnapshot = null
		updateCamera()
	}
}

// Point the camera at the exact stored center bounds (the upright flip is baked into
// the gaussians before this runs, so the bounds are already right-side-up).
function frameRawSplat(mesh) {
	const bounds = new THREE.Box3()
	let count = 0
	mesh.packedSplats?.forEachSplat((_i, center) => {
		if (![center.x, center.y, center.z].every(Number.isFinite)) return
		bounds.expandByPoint(center)
		count++
	})
	if (!count || bounds.isEmpty()) return
	const sphere = bounds.getBoundingSphere(new THREE.Sphere())
	orbit.target.copy(sphere.center)
	orbit.radius = Math.max(0.001, sphere.radius * 2.75)
	updateCamera()
}

// Developer-only raw viewer: instantiate the file directly and add it to the scene.
// Deliberately bypasses seatSubject/fitSplatToBox and the session/export pipeline.
async function viewRawSplat(file) {
	if (!file || generating) return
	generating = true
	syncGenerateButton()
	setStatus("")
	showProgress(0, 1, "Loading raw splat...")
	let raw = null
	try {
		world.resetGenerated()
		splatStore.clear()
		sessionSubjects = []
		const bytes = new Uint8Array(await file.arrayBuffer())
		raw = new SplatMesh({ fileBytes: bytes, fileName: file.name })
		await raw.initialized

		rawOrbitSnapshot = {
			target: orbit.target.clone(),
			radius: orbit.radius,
			theta: orbit.theta,
			phi: orbit.phi,
		}
		// Turn the upload upright: stored splat files are Y-inverted vs the world. Bake a
		// 180° X-rotation into the gaussians (a rotation, not a mirror — handedness kept),
		// the same in-place mutation pattern the ground deformation uses.
		{
			const flip = new THREE.Quaternion(1, 0, 0, 0) // 180° about X
			const packed = raw.packedSplats
			packed?.forEachSplat((i, center, scales, quaternion, opacity, color) => {
				center.set(center.x, -center.y, -center.z)
				quaternion.premultiply(flip)
				packed.setSplat(i, center, scales, quaternion, opacity, color)
			})
			if (packed) packed.needsUpdate = true
		}

		rawSplatPreview = raw
		raw = null
		world.group.visible = false
		scene.add(rawSplatPreview)
		selectPrimitive(null)
		frameRawSplat(rawSplatPreview)

		const count = rawSplatPreview.packedSplats?.numSplats
		const detail = Number.isFinite(count) ? ` (${count.toLocaleString()} gaussians)` : ""
		setStatus(`Viewing ${file.name} raw${detail} - no fitting or transforms. Press Esc to return.`)
		showProgress(1, 1, "Done")
		window.setTimeout(hideProgress, 700)
	} catch (error) {
		if (raw) disposeObject(raw)
		clearRawSplatPreview()
		setStatus(error.message || "Raw splat upload failed")
		hideProgress()
	} finally {
		generating = false
		syncGenerateButton()
	}
}

function uploadedSubjectSlots(files) {
	const objectGroups = computeObjects(world.primitives)
	const objectSlots = objectGroups.map((group, i) => ({
		name: `obj-${String(i + 1).padStart(3, "0")}`,
		kind: "object",
		box: group.box,
		sourcePrimitives: group.primitives,
		colors: primitiveColors(group.primitives),
		yawTurns: OBJECT_YAW_TURNS,
		fitHeight: true,
		used: false,
	}))
	const floorSlot = {
		name: "floor",
		kind: "floor",
		box: world.footprintBox(),
		sourcePrimitives: null,
		colors: primitiveColors(world.groundTiles),
		yawTurns: FLOOR_YAW_TURNS,
		fitHeight: false,
		plotId: null,
		clipBoxes: world.floorClipBoxes(),
		used: false,
	}
	const byName = new Map([...objectSlots, floorSlot].map(slot => [slot.name, slot]))
	const slots = []

	for (const file of files) {
		const stem = fileStem(file)
		const normalized = stem.toLowerCase()
		let slot = byName.get(normalized)
		if (!slot && normalized === "ground") slot = floorSlot
		if (!slot) slot = objectSlots.find(candidate => !candidate.used)
		if (!slot && !floorSlot.used) slot = floorSlot
		if (!slot) {
			slots.push({ file, skipped: "No matching object or floor slot" })
			continue
		}
		slot.used = true
		slots.push({ file, slot, name: slot.name })
	}
	return slots
}

// Load uploaded .splat/.ply files into the same subject slots used by generation:
// obj-001 -> first computed object group, floor/ground -> generated terrain.
async function uploadSplats(files) {
	const list = [...(files || [])]
	if (!list.length || generating) return
	generating = true
	splatting = true
	syncGenerateButton()
	setStatus("")
	try {
		const cfg = await getConfig()
		applyRuntimeConfig(cfg)
		clearRawSplatPreview()
		beginNewSplatFrame()
		splatStore.clear()
		sessionSubjects = []

		const uploads = uploadedSubjectSlots(list)
		let seatedCount = 0
		let floorUploaded = false
		showProgress(0, uploads.length, "Loading splats...")
		for (let i = 0; i < uploads.length; i++) {
			const { file, slot, name, skipped } = uploads[i]
			if (!slot) {
				console.warn(`upload ${file.name}: ${skipped}`)
				showProgress(i + 1, uploads.length)
				continue
			}
			try {
				const bytes = new Uint8Array(await file.arrayBuffer())
				const fit = fitSettingsFor(slot.kind)
				const seated = await seatSubject(bytes, slot.box, name, slot.sourcePrimitives, {
					kind: slot.kind,
					yawTurns: slot.yawTurns,
					yawDeg: fit.yawDeg,
					yOffset: fit.yOffset,
					fitHeight: slot.fitHeight,
					colors: slot.colors,
					plotId: slot.plotId,
					clipBoxes: slot.clipBoxes,
					fileName: file.name,
				})
				if (slot.kind === "floor") {
					seated.userData.floorCells = occupiedCells()
					floorUploaded = true
				}
				splatStore.set(name, bytes)
				sessionSubjects.push({
					name,
					kind: slot.kind,
					plotId: slot.kind === "floor" ? slot.plotId : (slot.sourcePrimitives?.[0]?.userData?.plotId ?? null),
					yawTurns: slot.yawTurns ?? 0,
					fitHeight: Boolean(slot.fitHeight),
				})
				seatedCount++
			} catch (error) {
				console.warn(`upload ${file.name}:`, error.message)
			}
			showProgress(i + 1, uploads.length)
		}
		if (floorUploaded) world.groundGenerated()
		world.state = "generated"
		splatting = false
		setUiTab("view")
		applyOverlayVisibility()
		setStatus(`Loaded ${seatedCount} uploaded splat${seatedCount === 1 ? "" : "s"}`)
		showProgress(uploads.length, uploads.length, "Done")
		window.setTimeout(hideProgress, 1000)
	} catch (error) {
		setStatus(error.message || "Upload failed")
		hideProgress()
	} finally {
		generating = false
		splatting = false
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
			plotId: mesh.userData.plotId ?? 0,
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
	splatting = true
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
		splatting = false
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

	// Frames: a restored build gets its own Build frame AND its own Splat frame, so
	// whatever was open before survives untouched.
	snapshotActiveBuildFrame()
	pushBuildFrame()
	beginNewSplatFrame()

	// Reload primitives (resets generated state, rebuilds block-out). Must be the
	// lock-free core — this path runs under the caller's `generating` lock.
	await applyPrimitives(new File([primBytes], "primitives.json", { type: "application/json" }))

	// Pull fresh fit params from the server so the user can tune via .env and re-fit.
	const cfg = await getConfig()
	applyRuntimeConfig(cfg)

	// Group the newly loaded primitives into objects (same logic as generation).
	const objectGroups = computeObjects(world.primitives)
	let objectIdx = 0
	let floorIdx = 0

	splatStore.clear()
	sessionSubjects = []
	world.resetGenerated()

	const total = subjects.length
	let done = 0
	showProgress(0, total, "Re-fitting…")

	for (const s of subjects) {
		const splatBytes = getSplat(s.name)
		if (!splatBytes) { console.warn(`missing splat ${s.name}`); done++; showProgress(done, total); continue }

		let box, sourcePrimitives, colors, plotId = null, clipBoxes = null, floorCells = null
		if (s.kind === "scene") {
			box = wholeSceneBox()
			sourcePrimitives = world.allBlockoutMeshes()
			colors = primitiveColors(sourcePrimitives)
		} else if (s.kind === "floor") {
			// Three floor shapes: the unified "floor" (footprint splat sliced to all tiles), an
			// added-plot "floor-p<ids>" with no plotId (footprint splat sliced to just those plots'
			// tiles), and the legacy per-plot floor (plotId set, one splat fitted to its own tile).
			const addedPlotIds = s.plotId == null && /^floor-p[\d-]+$/.test(s.name)
				? s.name.slice("floor-p".length).split("-").map(Number)
				: null
			const addedTiles = addedPlotIds
				? world.groundTiles.filter(t => addedPlotIds.includes(t.userData.plotId ?? 0))
				: []
			if (s.plotId == null && s.name === "floor") {
				box = world.footprintBox?.() ?? world.floorBox()
				colors = primitiveColors(world.groundTiles)
				clipBoxes = world.floorClipBoxes()
				floorCells = occupiedCells()
			} else if (addedTiles.length) {
				box = world.footprintBox()
				colors = primitiveColors(addedTiles)
				clipBoxes = addedTiles.map(t => world.floorBoxForTile(t))
				floorCells = new Set(addedTiles.map(t => { const c = cellOf(t.userData.origin); return `${c.ix},${c.iz}` }))
			} else {
				plotId = s.plotId ?? world.groundTiles[floorIdx]?.userData.plotId ?? 0
				const tile = world.groundTiles.find(t => t.userData.plotId === plotId) ?? world.groundTiles[floorIdx] ?? world.ground
				box = world.floorBoxForTile(tile)
				colors = primitiveColors([tile])
				clipBoxes = [box]
				const c = cellOf(tile.userData.origin)
				floorCells = new Set([`${c.ix},${c.iz}`])
			}
			floorIdx++
			sourcePrimitives = null
		} else {
			const group = objectGroups[objectIdx++]
			if (!group) { done++; showProgress(done, total); continue }
			box = group.box
			sourcePrimitives = group.primitives
			colors = primitiveColors(sourcePrimitives)
		}

		const fit = fitSettingsFor(s.kind)
		try {
			let yawDeg = fit.yawDeg
			if (s.kind === "scene") {
				let guide = null
				try { guide = (await captureWorld(renderer, scene, world, box)).guide }
				catch (error) { console.warn("capture restored yaw guide:", error) }
				yawDeg = await estimateSceneYaw(splatBytes, sourcePrimitives, guide)
					?? (Number.isFinite(s.yawDeg) ? s.yawDeg : fit.yawDeg)
			}
			const seated = await seatSubject(splatBytes, box, s.name, sourcePrimitives, {
				kind: s.kind,
				yawTurns: s.yawTurns ?? 0,
				// Re-estimate restored one-shot scenes so orientation fixes apply to existing
				// paid generations. Stored/config yaw remains the ambiguity fallback.
				yawDeg,
				yOffset: fit.yOffset,
				fitHeight: Boolean(s.fitHeight) && s.kind !== "scene",
				// A scene's floor and objects are one cloud; keep a uniform fit on restore too.
				fillXZ: false,
				colors,
				plotId,
				clipBoxes,
			})
			if (floorCells) seated.userData.floorCells = floorCells
			splatStore.set(s.name, splatBytes)
			sessionSubjects.push({ ...s, plotId: s.kind === "floor" ? plotId : (sourcePrimitives?.[0]?.userData?.plotId ?? s.plotId ?? null) })
		} catch (err) {
			console.warn(`refit ${s.name}:`, err.message)
		}
		done++
		showProgress(done, total)
	}

	// Stored one-shot builds contain the pristine monolithic scene splat. Re-run the
	// current segmentation whenever they are restored so segmentation fixes can be
	// tested on an existing paid generation without generating it again.
	const restoredScene = sessionSubjects.find(s => s.kind === "scene")
	if (restoredScene) {
		try { segmentSceneSplat(restoredScene.hasGround !== false) }
		catch (error) { console.warn("segment restored scene:", error) }
	}

	if (sessionSubjects.some(s => s.kind === "floor")) world.groundGenerated()
	blendFloorSeamColors() // re-apply the math seam blend across restored floor splats
	applyAllPlotHeights()
	world.state = "generated"
	splatting = false // unlock the View gate before switching to it
	setUiTab("view")
	applyOverlayVisibility()
	showProgress(total, total, "Done")
	window.setTimeout(hideProgress, 1000)
	return sessionSubjects.length
}

// Load a primitives JSON file (from downloadPrimitives), replacing the current block-out
// and restoring the support links once every mesh exists. The user-facing input handler
// guards on the `generating` lock; applyPrimitives is the lock-free core so ZIP/history
// restores (which run UNDER that lock) can swap the block-out too — the guarded wrapper
// silently skipped the import there, leaving every restore without its primitives.
async function uploadPrimitives(file) {
	if (!file || generating) return
	await applyPrimitives(file)
}

async function applyPrimitives(file) {
	if (!file) return
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
		mesh.userData.plotId = Number.isInteger(p.plotId) ? p.plotId : 0
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
	applyUiTab() // owns block-out vs splat visibility (incl. the colliders overlay in View)
	world.setBoundsVisible(showBounds)
}

// Capture the exact one-shot scene guide used by generation. This is intentionally not
// the current editor camera; it is the canonical image sent through the scene-wide
// texture edit and then to TripoSplat.
async function screenshotFloor() {
	try {
		const cap = await captureWorld(renderer, scene, world, wholeSceneBox())
		downloadBlob(cap.guide, `scene-${Date.now()}.png`)
	} catch (err) {
		setStatus("Scene screenshot failed: " + (err.message || err))
	}
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
		camera.layers.disable(GHOST_LAYER) // keep expansion outlines out of the thumbnail
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
			camera.layers.enable(GHOST_LAYER)
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
	splatting = true
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
		splatting = false
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
for (const button of els.viewToolButtons) button.addEventListener("click", () => setViewTool(button.dataset.viewTool))
for (const button of els.viewTabs) button.addEventListener("click", () => setUiTab(button.dataset.viewTab))
els.frameAdd?.addEventListener("click", addFrameForActiveTab)
for (const swatch of els.colorSwatches) bindColorSwatch(swatch)
for (const swatch of els.brushSwatches) swatch.addEventListener("click", () => applyBrushScale(Number(swatch.dataset.scale)))

els.addColor?.addEventListener("click", () => els.customColor?.click())
els.customColor?.addEventListener("change", event => addPaletteColor(event.target.value))

els.floorShot?.addEventListener("click", async () => {
	try {
		await screenshotFloor()
	} catch (error) {
		setStatus(error.message || "Floor screenshot failed")
	}
})

els.viewRawSplat?.addEventListener("change", async event => {
	toggleSettings(false)
	await viewRawSplat(event.target.files[0])
	event.target.value = "" // let the same file be re-selected
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
	applyUiTab() // colliders overlay only means something in the View tab; Build already shows the block-out
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
})

document.addEventListener("keydown", event => {
	// Ctrl/Cmd+Z undoes, Ctrl+Y (or Ctrl/Cmd+Shift+Z) redoes — history is per tab (and
	// per frame). Text inputs keep their native undo; View has nothing to undo.
	const key = event.key.toLowerCase()
	if ((event.ctrlKey || event.metaKey) && (key === "z" || key === "y")) {
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
		event.preventDefault()
		if (generating || drawStroke || drag) return
		const isRedo = key === "y" || event.shiftKey
		if (uiTab === "draw") isRedo ? redoDraw() : undoDraw()
		else if (uiTab === "build") isRedo ? redoBuild() : undoBuild()
		return
	}
	if (!event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && (event.code === "Backquote" || event.key === "~")) {
		event.preventDefault()
		toggleDevControls()
		return
	}
	if (event.key === "Escape") {
		const settingsOpen = !els.settingsPopover.classList.contains("hidden")
		if (settingsOpen) toggleSettings(false)
		else if (rawSplatPreview) {
			world.resetGenerated()
			setStatus("")
		}
		else if (uiTab === "view" && selectedSplatMesh) deselectSplat()
	}
})

els.historyToggle?.addEventListener("click", () => toggleHistoryPanel())

els.historyClear?.addEventListener("click", async () => {
	try { await clearBuilds() } catch (err) { console.warn(err) }
	await refreshHistoryPanel()
})

els.historyClose?.addEventListener("click", () => toggleHistoryPanel(false))

// The chat bar has one job in whole-scene mode: splat the current Build in one shot.
els.chatForm.addEventListener("submit", event => {
	event.preventDefault()
	if (els.generate.disabled) return
	const prompt = els.chatPrompt.value.trim()
	generateWorld(prompt)
})

window.addEventListener("resize", () => {
	camera.aspect = window.innerWidth / window.innerHeight
	camera.updateProjectionMatrix()
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)) // resize also fires when the window moves to a monitor with a different DPI
	renderer.setSize(window.innerWidth, window.innerHeight)
	resizeSketchCanvas()
})

function animate() {
	// The Draw overlay covers the 3D viewport completely — skip all GPU work there
	// (Spark otherwise re-sorts and draws every splat each frame for nothing).
	if (uiTab !== "draw") {
		sky.position.copy(camera.position)
		if (pendingPlotHeight) { // floor-lift drags coalesce to one height change per frame
			const p = pendingPlotHeight
			pendingPlotHeight = null
			setPlotHeight(p.pid, p.height)
		}
		if (elevationDirty) { // curved-terrain refresh, at most once per frame
			elevationDirty = false
			updateElevationHandles()
		}
		updateTransformGizmo()
		renderer.render(scene, camera)
	}
	requestAnimationFrame(animate)
}

setActiveTool("pointer")
applyColor(activeColor)
applyBrushScale(activeBrushScale)
pushBuildFrame()
snapshotActiveBuildFrame()
applyUiTab() // start directly in Build; Draw is temporarily removed
updateCamera()
syncGenerateButton()
if (world.prompt) els.chatPrompt.value = world.prompt
refreshHistoryPanel() // populate the count badge from any builds saved in earlier sessions
updateGhostTiles() // no-op while plots are disabled in whole-scene one-shot mode
requestAnimationFrame(animate)
