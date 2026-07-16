// Hero cursor-follower: the mascot splat in the hero's right column turns to
// face wherever the cursor is on the page, like a robot tracking your gaze.
// Own WebGL context + SparkRenderer + scene — Spark accumulators are scene-
// scoped, so this can't ghost into the showcase splat below (and vice versa).
// Standalone on purpose, same as landing.js: the marketing page shares nothing
// with the editor.

import * as THREE from "three"
import { SparkRenderer, SplatMesh } from "spark"

const ASSET = "/assets/hero-splat.ply"
const PAPER = 0xfbfbfa // must match --paper in site.css so the splat floats on the page
const BASE_YAW = 0 // trim if the splat's "front" isn't toward +Z after seating
const MAX_YAW = 0.85 // rad each way toward the cursor
const MAX_PITCH = 0.32
const FOLLOW = 5.5 // 1/s — exponential chase toward the cursor

const host = document.getElementById("hero-stage")
if (host) main().catch(error => {
	console.error(error)
	host.remove() // hero degrades to text-only; the grid collapses the empty cell
})

async function main() {
	const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" })
	renderer.setClearColor(PAPER, 1)
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
	host.appendChild(renderer.domElement)
	const scene = new THREE.Scene()
	scene.add(new SparkRenderer({ renderer }))
	const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100)

	const resize = () => {
		const w = host.clientWidth
		const h = host.clientHeight
		if (!w || !h) return
		renderer.setSize(w, h, false)
		camera.aspect = w / h
		camera.updateProjectionMatrix()
	}
	new ResizeObserver(resize).observe(host)
	resize()

	const response = await fetch(ASSET)
	if (!response.ok) throw new Error(`hero splat fetch failed (${response.status})`)
	const mesh = new SplatMesh({ fileBytes: new Uint8Array(await response.arrayBuffer()), fileName: "hero-splat.ply" })
	await mesh.initialized
	mesh.rotation.x = Math.PI // stored splat files are Y-inverted vs the world
	mesh.updateMatrixWorld(true)

	const box = new THREE.Box3()
	const point = new THREE.Vector3()
	mesh.packedSplats?.forEachSplat((_i, center) => {
		if (![center.x, center.y, center.z].every(Number.isFinite)) return
		box.expandByPoint(point.copy(center).applyMatrix4(mesh.matrixWorld))
	})
	// Seat the splat centred on the origin at unit-ish size, then rotate the
	// pivot (not the mesh) so the gaze turns about the object's own middle.
	const size = box.getSize(new THREE.Vector3())
	const center = box.getCenter(new THREE.Vector3())
	const s = 2 / Math.max(size.x, size.y, size.z, 0.001)
	const inner = new THREE.Group()
	inner.add(mesh)
	inner.scale.setScalar(s)
	inner.position.set(-center.x * s, -center.y * s, -center.z * s)
	const pivot = new THREE.Group()
	pivot.add(inner)
	pivot.rotation.y = BASE_YAW
	scene.add(pivot)
	camera.position.set(0, 0.14, 2.7)
	camera.lookAt(0, 0, 0)

	// Track the cursor anywhere on the page: the offset from the splat's own
	// screen position sets a target yaw/pitch, chased with critically-damped ease.
	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
	let targetYaw = 0
	let targetPitch = 0
	let sawPointer = false
	window.addEventListener("pointermove", event => {
		sawPointer = true
		const r = host.getBoundingClientRect()
		const dx = event.clientX - (r.left + r.width / 2)
		const dy = event.clientY - (r.top + r.height / 2)
		targetYaw = clamp(dx / (window.innerWidth * 0.5), -1, 1) * MAX_YAW
		targetPitch = clamp(dy / (window.innerHeight * 0.5), -1, 1) * MAX_PITCH
	}, { passive: true })

	let yaw = 0
	let pitch = 0
	let lastTime = performance.now()
	const tick = () => {
		const now = performance.now()
		const dt = Math.min(0.05, (now - lastTime) / 1000)
		lastTime = now
		if (!reduceMotion) {
			// No pointer yet (touch devices): a slow ambient sway so it isn't frozen.
			const wantYaw = sawPointer ? targetYaw : Math.sin(now / 2400) * 0.22
			const wantPitch = sawPointer ? targetPitch : Math.sin(now / 3100) * 0.06
			const k = 1 - Math.exp(-FOLLOW * dt)
			yaw += (wantYaw - yaw) * k
			pitch += (wantPitch - pitch) * k
			pivot.rotation.y = BASE_YAW + yaw
			pivot.rotation.x = pitch
		}
		renderer.render(scene, camera)
	}
	renderer.setAnimationLoop(tick)
	// Only burn GL frames while the hero is actually on screen.
	new IntersectionObserver(([e]) => {
		renderer.setAnimationLoop(e.isIntersecting ? tick : null)
		if (e.isIntersecting) lastTime = performance.now()
	}, { threshold: 0 }).observe(host)
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
