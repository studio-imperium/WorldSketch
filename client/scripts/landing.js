// Landing-page hero stage: the japanese-courtyard block-out sketch crossfades
// into its generated splat every 5 seconds — the product story in one loop.
// Two stacked canvases share one orbit; the sketch layer CSS-fades over the
// splat layer. Standalone on purpose — shares only primitives.js with the
// editor so the marketing page can't drift the app.

import * as THREE from "three"
import { SparkRenderer, SplatMesh } from "spark"
import { createPrimitive } from "/scripts/primitives.js"

const ASSET = "/assets/japanese-courtyard"
const PANEL = 0xf5f4f1 // must match --panel in site.css so the world floats on the card
const CYCLE_MS = 5000

const stage = document.getElementById("stage")
const hint = document.getElementById("stage-hint")
const tabs = [...document.querySelectorAll(".tab[data-phase]")]

main().catch(error => {
	console.error(error)
	hint.textContent = "The world couldn't load. Check client/assets/japanese-courtyard.*"
})

async function main() {
	const splatLayer = makeLayer()
	// Spark draws every SplatMesh through ANY SparkRenderer sharing its globals, so
	// only the splat layer gets one — a second would ghost the splat into the sketch.
	splatLayer.scene.add(new SparkRenderer({ renderer: splatLayer.renderer }))
	const sketchLayer = makeLayer() // later sibling paints on top
	sketchLayer.canvas.classList.add("fade")
	sketchLayer.scene.add(new THREE.HemisphereLight(0xffffff, 0x4a5d42, 2.25)) // editor lighting,
	const sun = new THREE.DirectionalLight(0xffffff, 1.8) // so the block-out reads identically
	sun.position.set(5, 8, 3)
	sketchLayer.scene.add(sun)

	// The sketch is a 35KB JSON — build and show it immediately while the splat streams.
	const blockoutJson = await (await fetch(`${ASSET}-blockout.json`)).json()
	const { group: blockout, box: blockoutBox } = normalize(buildBlockout(blockoutJson))
	sketchLayer.scene.add(blockout)

	const view = frameFor(blockoutBox)
	let phase = "sketch"
	const setPhase = name => {
		phase = name
		sketchLayer.canvas.classList.toggle("show", name === "sketch")
		for (const tab of tabs) tab.classList.toggle("active", tab.dataset.phase === name)
	}
	hint.remove()
	setPhase("sketch")

	// Drag to orbit; auto-rotate resumes after a beat of stillness.
	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
	let lastPointer = null
	let lastInteraction = -Infinity
	stage.addEventListener("pointerdown", event => {
		stage.setPointerCapture(event.pointerId)
		lastPointer = { x: event.clientX, y: event.clientY }
		lastInteraction = performance.now()
	})
	stage.addEventListener("pointermove", event => {
		if (!lastPointer) return
		view.theta -= (event.clientX - lastPointer.x) * 0.005
		view.phi = Math.min(1.5, Math.max(0.45, view.phi - (event.clientY - lastPointer.y) * 0.005))
		lastPointer = { x: event.clientX, y: event.clientY }
		lastInteraction = performance.now()
	})
	const release = () => { lastPointer = null }
	stage.addEventListener("pointerup", release)
	stage.addEventListener("pointercancel", release)

	let lastTime = performance.now()
	splatLayer.renderer.setAnimationLoop(() => {
		const now = performance.now()
		const dt = Math.min(0.05, (now - lastTime) / 1000)
		lastTime = now
		if (!reduceMotion && !lastPointer && now - lastInteraction > 2500) view.theta += dt * 0.12
		for (const layer of [splatLayer, sketchLayer]) {
			layer.camera.position.set(
				view.target.x + view.radius * Math.sin(view.phi) * Math.sin(view.theta),
				view.target.y + view.radius * Math.cos(view.phi),
				view.target.z + view.radius * Math.sin(view.phi) * Math.cos(view.theta),
			)
			layer.camera.lookAt(view.target)
			layer.renderer.render(layer.scene, layer.camera)
		}
	})

	// Stream in the splat, seat it in the same normalized frame, then start the loop.
	const response = await fetch(`${ASSET}.ply`)
	if (!response.ok) throw new Error(`splat fetch failed (${response.status})`)
	const bytes = new Uint8Array(await response.arrayBuffer())
	const mesh = new SplatMesh({ fileBytes: bytes, fileName: "japanese-courtyard.ply" })
	await mesh.initialized
	mesh.rotation.x = Math.PI // stored splat files are Y-inverted vs the world
	mesh.updateMatrixWorld(true)

	const rawBox = new THREE.Box3()
	const point = new THREE.Vector3()
	mesh.packedSplats?.forEachSplat((_i, center) => {
		if (![center.x, center.y, center.z].every(Number.isFinite)) return
		rawBox.expandByPoint(point.copy(center).applyMatrix4(mesh.matrixWorld))
	})
	const { group: splat } = normalize({ group: new THREE.Group().add(mesh), box: rawBox })
	splatLayer.scene.add(splat)
	splatLayer.canvas.classList.add("base")

	let timer = setInterval(() => setPhase(phase === "sketch" ? "splat" : "sketch"), CYCLE_MS)
	for (const tab of tabs) {
		tab.addEventListener("click", () => {
			setPhase(tab.dataset.phase)
			clearInterval(timer)
			timer = setInterval(() => setPhase(phase === "sketch" ? "splat" : "sketch"), CYCLE_MS)
		})
	}

	function makeLayer() {
		const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" })
		renderer.setClearColor(PANEL, 1)
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
		const scene = new THREE.Scene()
		const camera = new THREE.PerspectiveCamera(46, 1, 0.05, 2000)
		const layer = { renderer, scene, camera, canvas: renderer.domElement }
		stage.insertBefore(layer.canvas, hint)
		const resize = () => {
			const w = stage.clientWidth
			const h = stage.clientHeight
			if (!w || !h) return
			renderer.setSize(w, h, false)
			camera.aspect = w / h
			camera.updateProjectionMatrix()
		}
		new ResizeObserver(resize).observe(stage)
		resize()
		return layer
	}
}

// Rebuild the block-out exactly as the editor draws it: painted-stroke ground
// sheet + createPrimitive boxes (same materials and edge outlines).
function buildBlockout(data) {
	const group = new THREE.Group()

	const strokes = (data.ground?.strokes ?? []).filter(s => s.points?.length)
	if (strokes.length) {
		const pad = Math.max(...strokes.map(s => s.radius)) * 1.5
		const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }
		for (const stroke of strokes) {
			for (const [x, z] of stroke.points) {
				bounds.minX = Math.min(bounds.minX, x - pad); bounds.maxX = Math.max(bounds.maxX, x + pad)
				bounds.minZ = Math.min(bounds.minZ, z - pad); bounds.maxZ = Math.max(bounds.maxZ, z + pad)
			}
		}
		const w = bounds.maxX - bounds.minX
		const h = bounds.maxZ - bounds.minZ
		const W = 1024
		const H = Math.round(W * (h / w))
		const canvas = document.createElement("canvas")
		canvas.width = W
		canvas.height = H
		const ctx = canvas.getContext("2d")
		const px = x => ((x - bounds.minX) / w) * W
		const py = z => ((z - bounds.minZ) / h) * H // flipY texture: +z runs down the canvas
		for (const stroke of strokes) {
			ctx.strokeStyle = ctx.fillStyle = stroke.color
			ctx.lineWidth = stroke.radius * 2 * (W / w)
			ctx.lineCap = ctx.lineJoin = "round"
			if (stroke.points.length === 1) {
				const [x, z] = stroke.points[0]
				ctx.beginPath()
				ctx.arc(px(x), py(z), stroke.radius * (W / w), 0, Math.PI * 2)
				ctx.fill()
			} else {
				ctx.beginPath()
				stroke.points.forEach(([x, z], i) => (i ? ctx.lineTo(px(x), py(z)) : ctx.moveTo(px(x), py(z))))
				ctx.stroke()
			}
		}
		const texture = new THREE.CanvasTexture(canvas)
		texture.colorSpace = THREE.SRGBColorSpace
		const sheet = new THREE.Mesh(
			new THREE.PlaneGeometry(w, h),
			new THREE.MeshStandardMaterial({
				map: texture,
				transparent: true, // unpainted ground is void, like the editor
				roughness: 1,
				polygonOffset: true,
				polygonOffsetFactor: 1,
				polygonOffsetUnits: 1,
			}),
		)
		sheet.rotation.x = -Math.PI / 2
		sheet.position.set((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2)
		group.add(sheet)
	}

	;(data.primitives ?? []).forEach((prim, i) => group.add(createPrimitive(prim.type, i, prim)))

	group.updateMatrixWorld(true)
	const box = new THREE.Box3().setFromObject(group)
	return { group, box }
}

// Seat a world into a shared canonical frame — footprint spanning 2 units,
// centered at the origin, resting on y=0 — so sketch and splat overlay during
// the crossfade no matter what units they were authored in.
function normalize({ group, box }) {
	const size = box.getSize(new THREE.Vector3())
	const center = box.getCenter(new THREE.Vector3())
	const s = 2 / Math.max(size.x, size.z, 0.001)
	const wrapper = new THREE.Group()
	wrapper.add(group)
	wrapper.scale.setScalar(s)
	wrapper.position.set(-center.x * s, -box.min.y * s, -center.z * s)
	wrapper.updateMatrixWorld(true)
	const normBox = new THREE.Box3(
		new THREE.Vector3(-size.x * s / 2, 0, -size.z * s / 2),
		new THREE.Vector3(size.x * s / 2, size.y * s, size.z * s / 2),
	)
	return { group: wrapper, box: normBox }
}

function frameFor(box) {
	const sphere = box.getBoundingSphere(new THREE.Sphere())
	return {
		target: sphere.center.clone(),
		radius: Math.max(0.5, sphere.radius * 1.9),
		theta: Math.PI * 0.25,
		phi: 1.12, // polar angle from +Y — a gentle look down onto the plot
	}
}
