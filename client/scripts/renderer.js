import * as THREE from "three"
import { SparkRenderer, SplatMesh } from "spark"
import { zip, unzip } from "fflate"
import { getConfig, newOutput, generateSubject, generateGround, identifyObjects } from "/scripts/api.js"
import { captureObject, captureFloor, captureWorldContext, FRONT_THETA, FRONT_PHI } from "/scripts/capture.js"
import { fitSplatToBox, ensureSplatEditBase, applySplatEditTransform } from "/scripts/fit.js"
import { computeObjects } from "/scripts/geometry.js"
import { clearSelectionOutline, createPrimitive, createSelectionOutline, disposeObject } from "/scripts/primitives.js"
import { addBuild, listBuilds, getBuildSplats, deleteBuild, clearBuilds } from "/scripts/history.js"
import { createSky } from "/scripts/sky.js"

const root = document.getElementById("canvas")
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.03, 400)
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
const raycaster = new THREE.Raycaster()
// Expansion ghost tiles live on their own layer so the editor camera shows them but the
// capture cameras (capture.js, default layer 0) never bake them into generated images.
const GHOST_LAYER = 1
camera.layers.enable(GHOST_LAYER)
raycaster.layers.enable(GHOST_LAYER)
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
const gizmoRayPoint = new THREE.Vector3()
const gizmoPlane = new THREE.Plane()
const gizmoAxisWorld = new THREE.Vector3()
const gizmoCameraDir = new THREE.Vector3()
const gizmoPlaneNormal = new THREE.Vector3()
const backgroundColor = new THREE.Color(0xfcfcfc)

const shapeTools = new Set(["box", "sphere", "cylinder", "cone"])
const selectionTools = new Set(["pointer", "move"]) // both select; move also shows the translate widget
const floorSize = 16 // the single world's ground tile (bigger now that it is its own splat)
const groundThickness = 0.05
const groundTopY = groundThickness // plot-local Y of the ground's top surface
const floorSeamOverlap = 0.18 // tiny X/Z overfit so adjacent per-plot floor splats do not reveal seams
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
let groundDeformDirty = false // a floor lift drag is in flight; deform the ground splat once per frame
let nextPrimitiveId = 1
let generating = false

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
		this.ghostTiles = [] // dashed "expand here" outlines around every open footprint edge
		this.groundSlopePreviews = []
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

	}

	allBlockoutMeshes() {
		return [...this.groundTiles, ...this.primitives]
	}

	floorCaptureMeshes() {
		const previews = this.groundSlopePreviews.filter(mesh => mesh.visible && !mesh.userData.isColliderOnly)
		return previews.length ? previews : this.groundTiles
	}

	floorCaptureMeshesForTile(tile) {
		const plotId = tile.userData.plotId
		const preview = this.groundSlopePreviews.find(mesh => mesh.visible && !mesh.userData.isColliderOnly && mesh.userData.plotId === plotId)
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
		const from = new THREE.Color(`#${prev}`)
		const to = new THREE.Color(`#${next}`)
		const fromRgb = [Math.round(from.r * 255), Math.round(from.g * 255), Math.round(from.b * 255)]
		const toRgb = [Math.round(to.r * 255), Math.round(to.g * 255), Math.round(to.b * 255)]
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
		updateGroundSlopePreview()
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

	paintAt(hit) {
		const uv = hit.uv
		if (!uv) return
		const surface = ensurePaintSurface(hit.object)
		if (!surface) return
		// Remember each colour painted onto a primitive (or the ground), so it joins that
		// subject's palette for the hue lock — e.g. red berry spots become an available
		// colour, and a painted blue river joins the floor's palette. Record on the tile,
		// not a transient curved-surface mesh (those are rebuilt on every height change).
		const paintTarget = hit.object.userData.tile ?? hit.object
		;(paintTarget.userData.paintedColors ??= new Set()).add(activeColor)
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
		const record = { mesh, primitives: sourcePrimitives }
		this.generated.push(record)
		this.group.add(mesh)
		prepareGeneratedEdit(record)
		for (const primitive of sourcePrimitives) {
			setColliderStyle(primitive, false)
			setPickableHidden(primitive, true)
		}
	}

	groundGenerated() {
		this.floorGenerated = true
		for (const tile of this.groundTiles) {
			tile.userData.floorBaked = true // this tile is now covered by the generated floor splat
			setColliderStyle(tile, false)
			setPickableHidden(tile, true)
		}
		updateElevationHandles()
	}

	// Tear down a previous generation: drop the splats, restore the editable block-out.
	resetGenerated() {
		for (const { mesh } of this.generated) disposeObject(mesh)
		this.generated = []
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
		updateElevationHandles()
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

function prepareGeneratedEdit(record) {
	if (!record?.mesh || !record.primitives?.length) return
	const root = record.primitives[0]
	root.updateWorldMatrix(true, false)
	record.editRoot = root
	record.editRootBase = root.matrixWorld.clone()
	ensureSplatEditBase(record.mesh)
}

function syncGeneratedForPrimitive(mesh) {
	const record = generatedForPrimitive(mesh)
	if (!record?.mesh || !record.primitives?.length) return
	if (!record.editRoot || !record.editRootBase) prepareGeneratedEdit(record)
	const root = record.editRoot ?? record.primitives[0]
	root.updateWorldMatrix(true, false)
	const delta = root.matrixWorld.clone().multiply(record.editRootBase.clone().invert())
	applySplatEditTransform(record.mesh, delta)
	const pos = root.getWorldPosition(tmpWorld)
	record.mesh.userData.seatX = pos.x
	record.mesh.userData.seatZ = pos.z
	record.mesh.userData.genPlotId = root.userData.plotId ?? record.mesh.userData.genPlotId
	seatObjectOnGround(record.mesh)
	if (showBounds) world.setBoundsVisible(true)
}

function syncGeneratedForPrimitives(meshes) {
	const seen = new Set()
	for (const mesh of meshes) {
		const record = generatedForPrimitive(mesh)
		if (!record || seen.has(record)) continue
		seen.add(record)
		syncGeneratedForPrimitive(record.primitives[0])
	}
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
	const show = Boolean(selectedPrimitive) && activeTool === "move" && !generating
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
	const subtree = floorDrag ? [] : collectSubtree(selectedPrimitive)
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
		startPlotHeight: floorDrag ? (plotHeights.get(selectedPrimitive.userData.plotId) || 0) : 0,
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
	drag = {
		mode: "gizmo",
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
	if (drag.mesh.userData.isGround) {
		setPlotHeight(drag.mesh.userData.plotId ?? 0, drag.startPlotHeight + (drag.startY - event.clientY) * 0.03)
		groundDeformDirty = true // deform the generated ground splat live (coalesced per frame in animate)
		updateTransformGizmo()
		return
	}
	if (!intersectGizmoPlane(event, gizmoRayPoint)) return
	const currentScalar = gizmoRayPoint.clone().sub(drag.origin).dot(drag.axisWorld)
	const delta = currentScalar - drag.startScalar
	tmpDelta.copy(drag.axisWorld).multiplyScalar(delta)
	const moved = [drag.mesh, ...drag.subtree]
	for (let i = 0; i < moved.length; i++) moved[i].position.copy(drag.startPositions[i]).add(tmpDelta)
	if (drag.axis !== "y") bindPrimitiveTreeToCurrentPlot(drag.mesh, drag.subtree)
	syncGeneratedForPrimitive(drag.mesh)
	updateTransformGizmo()
}

function finishGizmoDrag() {
	if (!drag || drag.mode !== "gizmo") return
	if (drag.mesh.userData.isGround) applyGroundDeform()
	else {
		bindPrimitiveTreeToCurrentPlot(drag.mesh, drag.subtree)
		syncGeneratedForPrimitive(drag.mesh)
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
			color: 0xffd400, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide,
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
		if (selectedPrimitive.userData.isGround) world.setGroundTileColor(selectedPrimitive, color)
		else {
			selectedPrimitive.material.color.set(color)
			selectedPrimitive.userData.baseColor = selectedPrimitive.material.color.getHexString()
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
	if (hit.object.userData.isGround || hit.object.userData.locked) {
		if (!hit.object.userData.isGround || !hasPlotElevation()) return hit.point.clone()
		return new THREE.Vector3(hit.point.x, heightAt(hit.point.x, hit.point.z) + groundTopY, hit.point.z)
	}
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
	radius: floorSize * 2.3, // open zoomed out enough to show the dashed expansion outlines on all 4 sides
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

// --- Primitive transform drags (scale / roll) -------------------------------

function startPrimitiveDrag(event, mesh) {
	mesh = editablePrimitiveFor(mesh)
	selectPrimitive(mesh)
	if (mesh.userData.isGround || mesh.userData.locked) return
	if (selectionTools.has(activeTool)) return
	const worldPosition = mesh.getWorldPosition(new THREE.Vector3())
	drag = {
		mode: activeTool === "rotate" ? "roll" : "scale",
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
	renderer.domElement.classList.add("is-dragging")
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
		syncGeneratedForPrimitives([drag.mesh, ...drag.roll.members.map(m => m.mesh)])
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
	syncGeneratedForPrimitive(s.mesh)
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
	if (!hit) return
	world.paintAt(hit)
	focusPlot(plotIdFromHit(hit))
}

// --- Pointer routing --------------------------------------------------------

function pointerDown(event) {
	if (event.button !== 0) return
	if (generating) {
		startOrbit(event) // only camera movement while generating
		return
	}

	const hitGizmo = gizmoHit(event)
	if (hitGizmo?.object && startGizmoDrag(event, hitGizmo.object)) return

	// A dashed ghost outline on any side → grow the world that way (works with any tool active).
	const ghostHit = world.ghostTiles.length ? raycast(event, world.ghostTiles.map(g => g.userData.fill)) : null
	if (ghostHit) {
		addPlotAt(ghostHit.object.parent.userData.cell)
		return
	}

	if (activeTool === "paint") {
		if (raycast(event, world.raycastables())) startPaint(event)
		else startOrbit(event)
		return
	}

	if (shapeTools.has(activeTool)) {
		const hit = surfaceHit(event)
		if (hit) focusPlot(world.addPrimitive(activeTool, hit).userData.plotId)
		else startOrbit(event)
		return
	}

	// pointer / move / scale / rotate / eraser act on a selectable block-out mesh under the cursor.
	const hit = raycast(event, world.selectables())
	if (hit?.object) {
		focusPlot(hit.object.userData.plotId ?? 0)
		if (activeTool === "eraser") {
			if (hit.object.userData.isGround || hit.object.userData.locked) {
				selectPrimitive(hit.object)
				return
			}
			world.removePrimitive(hit.object)
			return
		}
		if (activeTool === "scale" || activeTool === "rotate") startPrimitiveDrag(event, hit.object)
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
	else if (drag && ["scale", "roll"].includes(drag.mode)) updatePrimitiveDrag(event)
	else { updateGhostHover(event); updatePlacement(event) }
})

renderer.domElement.addEventListener("pointerup", event => {
	if (drag?.pointerId === event.pointerId) {
		if (drag.mode === "gizmo") finishGizmoDrag()
		groundDeformDirty = false // finishGizmoDrag already applied the final deform
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
		// Objects are captured serially against the intact block-out; the floor is generated after
		// them via the shared unified-ground path (one splat sliced to the tile), so single-plot and
		// multi-plot worlds share ONE terrain pipeline and set groundMaster for later "add plot" blend.
		const subjects = []
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
					output, name: s.name, label: s.label, groundColor: s.groundColor, colors: s.colors, image: s.image, skipImageEdit: s.skipImageEdit,
				})
				const requestMs = performance.now() - tReq // server-side image edit + Tripo (see server [timing] log)
				const tSeat = performance.now()
				await seatSubject(bytes, s.box, s.name, s.primitives, { kind: s.kind, yawTurns: s.yawTurns, yawDeg: s.yawDeg, yOffset: s.yOffset, fitHeight: Boolean(s.fitHeight), colors: s.colors, plotId: s.plotId })
				subjectTimes.push({ subject: s.name, "request(s)": +(requestMs / 1000).toFixed(2), "seat(ms)": Math.round(performance.now() - tSeat) })
				splatStore.set(s.name, bytes)
			} catch (error) {
				console.warn(`${s.name}:`, error.message)
			}
			done++
			showProgress(done, total)
		})

		// Floor: ONE unified ground splat over the plot, sliced to the tile (empty cells culled).
		// Sets groundMaster so a later "add plot" outpaints from — and blends into — this terrain.
		if (doFloor) {
			showProgress(done, total, "Generating terrain…")
			try {
				await generateUnifiedGround(groundDesc || prompt, output)
			} catch (error) {
				console.warn("floor:", error.message)
				setStatus("Ground generation failed: " + (error.message || error))
			}
			done++
			showProgress(done, total)
		}

		// Build subject metadata for ZIP export / re-fitting (only successfully seated subjects).
		sessionSubjects = subjects
			.filter(s => splatStore.has(s.name))
			.map(s => ({ name: s.name, kind: s.kind ?? "object", plotId: s.plotId ?? null, yawTurns: s.yawTurns ?? 0, fitHeight: Boolean(s.fitHeight) }))
		if (doFloor && splatStore.has("floor")) {
			sessionSubjects.push({ name: "floor", kind: "floor", plotId: null, yawTurns: FLOOR_YAW_TURNS, fitHeight: false })
		}

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
	const fitBox = isFloor ? floorSeamBox(box) : box
	const fitClipBoxes = isFloor ? floorSeamClipBoxes(clipBoxes ?? [box]) : null
	const fitted = await fitSplatToBox(raw, fitBox, {
		yawTurns,
		yawDeg,
		yOffset,
		fitHeight,
		fillXZ: fillXZ || isFloor, // floors fill their rectangular footprint exactly on X/Z
		exactBounds: isFloor, // floors are clamped into the target slab, including thickness
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
	if (generating) return
	const plotId = ++plotSeq
	world.addGroundTile(cell.ix, cell.iz, plotId)
	updateGhostTiles() // the ghost on that side steps outward past the new tile
}

// --- Expansion ghost tiles --------------------------------------------------
// Dashed outlines sit on every empty cell adjacent to the current floor footprint. Clicking one
// grows the world there. They live in the 3D world (on GHOST_LAYER), so capture cameras never
// bake them into generated images.

const GHOST_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] // +X, -X, +Z, -Z
const ghostBaseColor = 0x64748b // slate: reads against both the near-white sky and the ground
const ghostHoverColor = accent
let hoveredGhost = null

function availableGhostCells() {
	const occupied = occupiedCells()
	const cells = new Map()
	for (const tile of world.groundTiles) {
		const base = cellOf(tile.userData.origin)
		for (const [dx, dz] of GHOST_DIRS) {
			const cell = { ix: base.ix + dx, iz: base.iz + dz }
			const key = `${cell.ix},${cell.iz}`
			if (occupied.has(key)) continue
			cells.set(key, cell)
		}
	}
	return [...cells.values()].sort((a, b) => a.iz - b.iz || a.ix - b.ix)
}

// One ghost: a dashed square + a small centre "+", plus a faint fill used as the click/hover target.
function makeGhostTile(cell) {
	const c = floorSize / 2 - 1 // inset a little from the tile edge
	const g = new THREE.Group()
	g.position.set(cell.ix * floorSize, groundTopY + 0.03, cell.iz * floorSize)

	const outlineGeo = new THREE.BufferGeometry()
	outlineGeo.setAttribute("position", new THREE.Float32BufferAttribute(
		[-c, 0, -c, c, 0, -c, c, 0, -c, c, 0, c, c, 0, c, -c, 0, c, -c, 0, c, -c, 0, -c], 3))
	const outline = new THREE.LineSegments(outlineGeo, new THREE.LineDashedMaterial({
		color: ghostBaseColor, transparent: true, opacity: 0.9, dashSize: 0.7, gapSize: 0.5, depthTest: false, depthWrite: false,
	}))
	outline.computeLineDistances()
	outline.renderOrder = 999
	g.add(outline)

	const plusGeo = new THREE.BufferGeometry()
	plusGeo.setAttribute("position", new THREE.Float32BufferAttribute([-1.4, 0, 0, 1.4, 0, 0, 0, 0, -1.4, 0, 0, 1.4], 3))
	const plus = new THREE.LineSegments(plusGeo, new THREE.LineBasicMaterial({
		color: ghostBaseColor, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false,
	}))
	plus.renderOrder = 999
	g.add(plus)

	const fill = new THREE.Mesh(new THREE.PlaneGeometry(c * 2, c * 2), new THREE.MeshBasicMaterial({
		color: ghostBaseColor, transparent: true, opacity: 0.07, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
	}))
	fill.rotation.x = -Math.PI / 2
	fill.renderOrder = 998
	g.add(fill)

	g.traverse(o => o.layers.set(GHOST_LAYER))
	g.userData.isGhostTile = true
	g.userData.cell = cell
	g.userData.fill = fill
	g.userData.parts = [outline, plus, fill]
	return g
}

// Rebuild all empty perimeter ghosts around the current plot footprint.
function updateGhostTiles() {
	if (hoveredGhost) document.body.style.cursor = ""
	hoveredGhost = null
	for (const ghost of world.ghostTiles) disposeObject(ghost)
	world.ghostTiles = []
	for (const cell of availableGhostCells()) {
		const ghost = makeGhostTile(cell)
		world.group.add(ghost)
		world.ghostTiles.push(ghost)
	}
}

function setGhostHovered(ghost, on) {
	const color = on ? ghostHoverColor : ghostBaseColor
	const [outline, plus, fill] = ghost.userData.parts
	outline.material.color.setHex(color); outline.material.opacity = on ? 1 : 0.9
	plus.material.color.setHex(color); plus.material.opacity = on ? 1 : 0.9
	fill.material.color.setHex(color); fill.material.opacity = on ? 0.2 : 0.07
	document.body.style.cursor = on ? "pointer" : ""
}

// Hover highlight for ghost tiles (from pointermove when nothing is being dragged/placed).
function updateGhostHover(event) {
	const hit = world.ghostTiles.length ? raycast(event, world.ghostTiles.map(g => g.userData.fill)) : null
	const ghost = hit ? hit.object.parent : null
	if (ghost === hoveredGhost) return
	if (hoveredGhost) setGhostHovered(hoveredGhost, false)
	hoveredGhost = ghost
	if (hoveredGhost) setGhostHovered(hoveredGhost, true)
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
	geometry.computeVertexNormals()
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
	const mesh = new THREE.Mesh(geometry, material)
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
	for (const mesh of world.groundSlopePreviews) disposeObject(mesh)
	world.groundSlopePreviews = []
	if (!hasPlotElevation()) return
	// Once a tile is baked into the generated floor splat, its curved mesh stays on as an
	// INVISIBLE raycast collider: clicks must intersect the true curved surface, not the flat
	// tile underneath, or placement/painting lands offset from the cursor on slopes. A plot
	// added AFTER generation is drawn as a flat block-out tile, so it gets no curved mesh —
	// its flat tile stays the click target (see groundHitMeshes).
	for (const tile of world.groundTiles) {
		const colliderOnly = world.floorGenerated && tile.userData.floorBaked
		if (world.floorGenerated && !tile.userData.floorBaked) continue
		const preview = makeGroundSlopePreview(tile)
		if (colliderOnly) {
			preview.userData.isColliderOnly = true
			preview.material.transparent = true
			preview.material.opacity = 0
			preview.material.depthWrite = false
		}
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
	const slopePreview = hasPlotElevation() && !world.floorGenerated
	updateGroundSlopePreview()
	refreshGroundSelectionHighlight()
	for (const tile of world.groundTiles) {
		tile.position.y = groundThickness / 2 + (plotHeights.get(tile.userData.plotId) || 0)
		if (showColliders) {
			setPickableHidden(tile, false)
			tile.visible = true
			continue
		}
		// Hide only tiles baked into the generated floor splat. A plot ADDED after generation is
		// not yet baked, so it stays a visible, paintable block-out you can build on (otherwise the
		// new plot reads as a blank "white nothing square" — the transparent tile over the sky).
		if (world.floorGenerated && tile.userData.floorBaked) {
			setPickableHidden(tile, true)
			continue
		}
		setPickableHidden(tile, false) // restore the green paint map if this tile was ever hidden
		tile.material.transparent = slopePreview
		tile.material.opacity = slopePreview ? 0 : 1
		tile.material.depthWrite = !slopePreview
		tile.material.needsUpdate = true
		tile.visible = true
	}
}

function setPlotHeight(pid, height) {
	const clamped = Math.max(-floorSize, Math.min(floorSize, height))
	const old = plotHeights.get(pid) || 0
	const delta = clamped - old
	if (Math.abs(delta) < 1e-4) return
	plotHeights.set(pid, clamped)
	// Re-seat EVERY object onto the surface (a plot's height also tilts objects on neighbouring
	// plots near the shared seam). Objects follow the height field + tilt to the slope; cheap.
	for (const g of world.generated) if (g.mesh.userData.genKind !== "floor") seatObjectOnGround(g.mesh)
	for (const p of world.primitives) if ((p.userData.plotId ?? 0) === pid) p.position.y += delta
	updateElevationHandles()
}

// Generate the whole ground as ONE splat over the footprint bounding box, then slice it to the
// occupied tiles (floorClipBoxes drops gaussians in empty cells — the hole in a ring/U, the notch
// of an L). Uses the top-down composite + OpenAI outpaint so an ADDED plot repaints ONLY its new
// tiles and grows the EXISTING terrain across the seam (same colour/material/style, no jump); the
// new region's base hue is locked to the existing terrain's real colour (sampled from the kept
// image) so a differently-painted plot is pulled toward its neighbour instead of clashing. Keeps
// the result as `groundMaster` for the NEXT expansion. Shared by the single-plot (generateWorld)
// and multi-plot (generateExpanded) paths so EVERY generation blends consistently. Returns true if
// a floor was seated. `groundPromptText` is the terrain description (Gemini's, or the scene prompt).
async function generateUnifiedGround(groundPromptText, output) {
	const fp = footprint()
	const size = groundImageSize(fp.cols, fp.rows)
	const { canvas, mask } = buildGroundComposite(fp, size)
	const imageBlob = await canvasToBlob(canvas)
	const maskBlob = mask ? await canvasToBlob(mask) : null
	let groundColorHex = world.baseGroundColor
	let groundColors = primitiveColors(world.groundTiles)
	if (groundMaster?.imageEl) {
		const existing = sampleImageColor(groundMaster.imageEl)
		if (existing) {
			groundColorHex = existing
			groundColors = [existing, ...groundColors] // keep both hues in the palette so the seam can transition
		}
	}
	const res = await generateGround({
		prompt: groundPromptText, image: imageBlob, mask: maskBlob, groundColor: groundColorHex,
		colors: groundColors, cols: fp.cols, rows: fp.rows, imageSize: size.label, output, name: "floor",
	})
	const mesh = await seatSubject(res.splat, world.footprintBox(), "floor", null, {
		kind: "floor", yawTurns: FLOOR_YAW_TURNS, yawDeg: floorFit.yawDeg, yOffset: floorFit.yOffset,
		fillXZ: true, colors: groundColors, plotId: null, clipBoxes: world.floorClipBoxes(),
	})
	mesh.userData.floorCells = occupiedCells() // grid cells this splat covers (for seam blending)
	splatStore.set("floor", res.splat)
	world.groundGenerated()
	try {
		groundMaster = { imageEl: await blobToImage(res.imageBlob), cols: fp.cols, rows: fp.rows, minIx: fp.minIx, minIz: fp.minIz }
	} catch { groundMaster = null }
	return true
}

// Add-plot floor: keep the already-generated floor UNTOUCHED and generate ONLY the newly-added
// plot(s) as their own splat. The terrain DESIGN continues the neighbour (the composite outpaints
// from the kept master, so grass stays the same grass), but the new region's colours are LOCKED to
// the new plot's OWN paint (its colours only, not blended with the neighbour) via the floor palette
// lock. The new splat is clipped to just the new tiles and overfit by floorSeamOverlap, so its edge
// gaussians stretch into the neighbour and merge at the border — no seam gap, existing plots
// unchanged. Returns true if a floor was seated.
async function generateAddedPlotFloor(groundPromptText, output, newTiles) {
	const fp = footprint()
	const size = groundImageSize(fp.cols, fp.rows)
	const { canvas, mask } = buildGroundComposite(fp, size) // mask preserves the existing terrain, outpaints the new tiles
	const imageBlob = await canvasToBlob(canvas)
	const maskBlob = mask ? await canvasToBlob(mask) : null
	// ONLY the new plot's own painted colours — the palette lock restricts the new region to these,
	// so it keeps the design of the neighbour but the colours the user gave this plot.
	const newColors = primitiveColors(newTiles)
	const res = await generateGround({
		prompt: groundPromptText, image: imageBlob, mask: maskBlob,
		groundColor: newColors[0] || world.baseGroundColor, colors: newColors,
		cols: fp.cols, rows: fp.rows, imageSize: size.label, output, name: "floor",
	})
	const name = `floor-p${newTiles.map(t => t.userData.plotId ?? 0).join("-")}`
	const mesh = await seatSubject(res.splat, world.footprintBox(), name, null, {
		kind: "floor", yawTurns: FLOOR_YAW_TURNS, yawDeg: floorFit.yawDeg, yOffset: floorFit.yOffset,
		fillXZ: true, colors: newColors, plotId: null,
		clipBoxes: newTiles.map(t => world.floorBoxForTile(t)), // seat ONLY the new tiles (existing floor kept)
		paletteStrength: 1, // the plot body is EXACTLY the user's colours; the seam blend below re-introduces the neighbour
	})
	mesh.userData.floorCells = new Set(newTiles.map(t => { const c = cellOf(t.userData.origin); return `${c.ix},${c.iz}` }))
	splatStore.set(name, res.splat)
	world.groundGenerated() // bake + hide the new tiles (existing tiles were already baked/hidden)
	try {
		groundMaster = { imageEl: await blobToImage(res.imageBlob), cols: fp.cols, rows: fp.rows, minIx: fp.minIx, minIz: fp.minIz }
	} catch { /* keep the previous master */ }
	return true
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
				await generateAddedPlotFloor(prompt, output, newFloorTiles)
				blendFloorSeamColors() // math-blend the touching sides; the plot body keeps its own colours
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
				await generateUnifiedGround(prompt, output)
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
		if (s.kind === "floor") {
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
			const seated = await seatSubject(splatBytes, box, s.name, sourcePrimitives, {
				kind: s.kind,
				yawTurns: s.yawTurns ?? 0,
				yawDeg: fit.yawDeg,
				yOffset: fit.yOffset,
				fitHeight: Boolean(s.fitHeight),
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

	if (sessionSubjects.some(s => s.kind === "floor")) world.groundGenerated()
	blendFloorSeamColors() // re-apply the math seam blend across restored floor splats
	applyAllPlotHeights()
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
	world.setCollidersVisible(showColliders)
	world.setBoundsVisible(showBounds)
}

// Capture the exact isometric floor guide used by generation. This is intentionally not
// the current editor camera; it is the canonical floor capture sent to the image model.
async function screenshotFloor() {
	try {
		const cap = await captureFloor(renderer, scene, world)
		downloadBlob(cap.guide, `floor-${Date.now()}.png`)
	} catch (err) {
		setStatus("Floor screenshot failed: " + (err.message || err))
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
})

document.addEventListener("keydown", event => {
	if (event.key === "Escape") toggleSettings(false)
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
	// More than one plot → expansion path (ONE unified ground splat sliced to the occupied
	// tiles + per-plot objects). A single plot keeps the original one-shot pipeline untouched.
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
	if (groundDeformDirty) { // live plot-lift feedback: reshape the ground splat at most once per frame
		applyGroundDeform()
		groundDeformDirty = false
	}
	updateTransformGizmo()
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
updateGhostTiles() // dashed "expand here" outlines around the starting plot
requestAnimationFrame(animate)
