// Landing-page hero stage: the japanese-courtyard block-out sketch crossfades
// into its generated splat every 5 seconds — the product story in one loop.
// Two stacked canvases share one orbit; the sketch layer CSS-fades over the
// splat layer. Standalone on purpose — shares only primitives.js with the
// editor so the marketing page can't drift the app.

import * as THREE from "three"
import { SparkRenderer, SplatMesh } from "spark"
import { createPrimitive } from "/scripts/primitives.js"
import { initReveal } from "/scripts/reveal.js"

const REVEAL_SAMPLE = 3500 // points handed to the scroll-reveal ASCII cloud

const ASSET = "/assets/japanese-courtyard"
const PANEL = 0xf5f4f1 // must match --panel in site.css so the world floats on the card
const CYCLE_MS = 5000

const stage = document.getElementById("stage")
const hint = document.getElementById("stage-hint")
const tabs = [...document.querySelectorAll(".tab[data-phase]")]

// TEMP calibration harness — ?calib=1&yaw=0&k=1&dx=0&dz=0&theta=0.785&phi=1.12
// freezes the orbit and overlays the sketch at half opacity over the splat.
const Q = new URLSearchParams(location.search)
const calib = Q.has("calib")
const qn = (name, dflt) => (Q.has(name) ? Number(Q.get(name)) : dflt)

const booted = main()
booted.catch(error => {
	console.error(error)
	hint.textContent = "The world couldn't load. Check client/assets/japanese-courtyard.*"
})
// Calib screenshots wait on the window load event, so hold module evaluation
// (and with it the load event) until the splat is seated and drawn.
if (calib) await booted

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
	// Seat wrapper: rotates/scales the normalized sketch about the world origin so it
	// can be registered onto the splat's frame (content is already centered on origin).
	const seat = new THREE.Group()
	seat.add(blockout)
	seat.rotation.y = qn("yaw", 0)
	seat.scale.setScalar(qn("k", 1))
	seat.position.set(qn("dx", 0), 0, qn("dz", 0))
	sketchLayer.scene.add(seat)

	const view = frameFor(blockoutBox)
	if (calib) {
		view.theta = qn("theta", view.theta)
		view.phi = qn("phi", view.phi)
		view.radius *= qn("r", 1)
	}
	let phase = "sketch"
	const setPhase = name => {
		phase = name
		sketchLayer.canvas.classList.toggle("show", name === "sketch")
		for (const tab of tabs) tab.classList.toggle("active", tab.dataset.phase === name)
	}
	hint.remove()
	setPhase("sketch")

	// Drag to orbit; auto-rotate resumes after a beat of stillness.
	const reduceMotion = calib || window.matchMedia("(prefers-reduced-motion: reduce)").matches
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

	// Mount the scroll-reveal band now (code field + grid) so it's alive before the
	// 17MB splat arrives; feed it points once we've sampled them below.
	const feedReveal = calib ? null : initReveal()

	const drawFrame = () => {
		for (const layer of [splatLayer, sketchLayer]) {
			layer.camera.position.set(
				view.target.x + view.radius * Math.sin(view.phi) * Math.sin(view.theta),
				view.target.y + view.radius * Math.cos(view.phi),
				view.target.z + view.radius * Math.sin(view.phi) * Math.cos(view.theta),
			)
			layer.camera.lookAt(view.target)
			layer.renderer.render(layer.scene, layer.camera)
		}
	}
	let lastTime = performance.now()
	const tick = () => {
		const now = performance.now()
		const dt = Math.min(0.05, (now - lastTime) / 1000)
		lastTime = now
		if (!reduceMotion && !lastPointer && now - lastInteraction > 2500) view.theta += dt * 0.12
		drawFrame()
	}
	splatLayer.renderer.setAnimationLoop(tick)
	// The hero and the scroll-reveal cloud are never on screen together — pause the
	// hero's GL loop once it scrolls away so only one heavy render runs at a time.
	if (!calib) new IntersectionObserver(([e]) => {
		splatLayer.renderer.setAnimationLoop(e.isIntersecting ? tick : null)
		if (e.isIntersecting) lastTime = performance.now()
	}, { threshold: 0 }).observe(stage)

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
	// Reservoir-sample a fixed slice of the splat's points for the scroll-reveal cloud
	// (unbiased, O(1) memory) while we already visit every splat for the bounds.
	const sample = new Float32Array(REVEAL_SAMPLE * 3)
	let seen = 0
	mesh.packedSplats?.forEachSplat((_i, center) => {
		if (![center.x, center.y, center.z].every(Number.isFinite)) return
		point.copy(center).applyMatrix4(mesh.matrixWorld)
		rawBox.expandByPoint(point)
		const slot = seen < REVEAL_SAMPLE ? seen : Math.floor(Math.random() * (seen + 1))
		if (slot < REVEAL_SAMPLE) { sample[slot * 3] = point.x; sample[slot * 3 + 1] = point.y; sample[slot * 3 + 2] = point.z }
		seen++
	})
	const { group: splat } = normalize({ group: new THREE.Group().add(mesh), box: rawBox })
	splatLayer.scene.add(splat)
	splatLayer.canvas.classList.add("base")

	feedReveal?.(sample.subarray(0, Math.min(REVEAL_SAMPLE, seen) * 3), seen)

	if (calib) {
		// Overlay mode: both layers visible at once, camera frozen, no cycling.
		sketchLayer.canvas.style.transition = "none"
		sketchLayer.canvas.style.opacity = String(qn("op", 0.55))
		stage.scrollIntoView({ block: "center" })
		await new Promise(resolve => setTimeout(resolve, 800)) // let the sort worker settle
		drawFrame()
		document.title = "calib-ready"
		return
	}

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
