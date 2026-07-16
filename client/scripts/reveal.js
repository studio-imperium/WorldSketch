// Scroll-reveal "gaussian resolve": the arena assembles as an editor block-out
// — the voxel geometry baked by scripts/generate-reveal-blockout.mjs — then
// flashes white and dissolves into the REAL gaussian splat. The hero mech's
// build-up sequence at band scale; it replaced the ASCII-filter cloud (and its
// reveal-points.bin bake) entirely.
//
// Two baked assets drive it:
//   · reveal-blockout.json (generate-reveal-blockout.mjs) — ~45 purposeful
//     blocks (base, deck, wall runs, domes, hedges) in the splat's display
//     frame, a few KB, so construction starts fast;
//   · reveal-splat.ply (bake-reveal-splat.mjs) — the top 100k gaussians,
//     pre-normalized into the same unit frame, streaming in parallel so the
//     dissolve needs no runtime measuring.
// One WebGL context renders both: blocks and splat share the scene, exactly
// like hero-splat.js (Spark accumulators are scene-scoped, so this can't ghost
// the hero or showcase splats).

import * as THREE from "three"
import { SparkRenderer, SplatMesh } from "spark"
import { createPrimitive, disposeObject } from "/scripts/primitives.js"

const TILT = 0.6                    // tipped down — a clear look onto the plot's ground
const DIST = 3.5                    // camera distance on +Z
const YAW = Math.PI * 0.5 - 0.5     // fixed orientation (180° flip, then 90° left), no spin
const FOCAL = 2.1                   // × min(W,H) — how much of the band the plot fills
const OX = 0.5                      // projection centre as a fraction of band width
const OY = 0.44                     // projection centre as a fraction of band height
const BUILD_S = 0.5                 // seconds of staggered block construction
const FLASH_MS = 220                // blocks ramp to white-hot…
const FADE_MS = 180                 // …vanish completely…
const MATERIALIZE_MS = 320          // …and only then does the splat fade up
const WARM_MS = 600                 // splat warm-up behind the built blocks (hero+showcase
                                    // already paid Spark's cold-start by the time we're here)
const BLOCKOUT = "/assets/reveal-blockout.json"
const SPLAT = "/assets/reveal-splat.ply"
const WHITE = new THREE.Color(0xffffff)

export function initReveal() {
	const band = document.getElementById("reveal")
	const canvas = document.getElementById("reveal-canvas")
	if (!band || !canvas) return
	main(band, canvas).catch(error => {
		console.error(error)
		// The show is off — the copy must never stay invisible with it.
		showCopy(band, "lead")
		showCopy(band, "tail")
	})
}

// Staged copy: "A world is a" arrives with the first blocks, "a cloud of
// splats." only once the gaussian has fully materialized.
function showCopy(band, part) {
	band.querySelector(`.reveal-${part}`)?.classList.add("show")
}

async function main(band, canvas) {
	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: "high-performance" })
	renderer.setClearColor(0x000000, 0) // paper and the pixel-wave layer show through
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
	const scene = new THREE.Scene()
	scene.add(new SparkRenderer({ renderer }))
	// Splats are unlit; the lights are for the matte block-out (hero's rig).
	scene.add(new THREE.HemisphereLight(0xffffff, 0x4a5d42, 2.25))
	const sun = new THREE.DirectionalLight(0xffffff, 1.8)
	sun.position.set(5, 8, 3)
	scene.add(sun)

	// Same composite the ASCII cloud used: world = Ry(−YAW) · Rx(TILT), camera on
	// +Z with the principal point at (OX, OY) — the band's framing is unchanged.
	const tilt = new THREE.Group()
	tilt.rotation.x = TILT
	const yawGroup = new THREE.Group()
	yawGroup.rotation.y = -YAW
	yawGroup.add(tilt)
	scene.add(yawGroup)
	const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 100)
	camera.position.set(0, 0, DIST)
	camera.lookAt(0, 0, 0)

	let W = 0, H = 0
	function resize() {
		const r = band.getBoundingClientRect()
		W = r.width; H = r.height
		if (!W || !H) return
		renderer.setSize(W, H, false)
		camera.aspect = W / H
		camera.fov = 2 * Math.atan(H / (2 * FOCAL * Math.min(W, H))) * (180 / Math.PI)
		camera.setViewOffset(W, H, (0.5 - OX) * W, (0.5 - OY) * H, W, H)
		camera.updateProjectionMatrix()
	}
	resize()
	new ResizeObserver(resize).observe(band)

	// Render only while the band is on screen; the loop is all this scene needs
	// (block visibility and the tweens mutate state, the loop just draws it).
	let running = false
	function loop() {
		if (!running) return
		renderer.render(scene, camera)
		requestAnimationFrame(loop)
	}
	let armed
	const arm = new Promise(resolve => { armed = resolve })
	new IntersectionObserver(([e]) => {
		if (e.isIntersecting && !running) { running = true; requestAnimationFrame(loop) }
		else if (!e.isIntersecting) running = false
		if (e.isIntersecting) armed() // first sight starts the show
	}, { threshold: 0.25 }).observe(band)

	// The splat streams while the blocks build; the .catch marks the rejection
	// handled until the real await below.
	const seating = loadSplat()
	seating.catch(() => {})

	let blocks = null
	try {
		blocks = await buildBlocks()
		tilt.add(blocks)
	} catch (error) {
		console.warn("reveal block-out unavailable, going straight to the splat", error)
	}

	await arm
	showCopy(band, "lead")
	// Don't play the show into a hidden tab — the setTimeout-driven build would
	// advance while rAF is frozen and the flash would play unseen.
	if (document.hidden) {
		await new Promise(resolve => {
			const onVisible = () => {
				if (document.hidden) return
				document.removeEventListener("visibilitychange", onVisible)
				resolve()
			}
			document.addEventListener("visibilitychange", onVisible)
		})
	}

	// Bottom-up staggered construction, verbatim pacing from the editor's
	// Apply-JSON path: time-based so timer throttling can't stretch the build.
	if (blocks && !reduceMotion) {
		const meshes = [...blocks.children].sort(
			(a, b) => (a.position.y - a.scale.y / 2) - (b.position.y - b.scale.y / 2),
		)
		// Elapsed-fraction pacing: the build always takes BUILD_S total, showing
		// several blocks per frame when the count outruns the 16ms timer floor.
		const start = performance.now()
		let shown = 0
		while (shown < meshes.length) {
			const elapsed = performance.now() - start
			const due = Math.min(meshes.length, Math.max(shown + 1, Math.ceil((elapsed / (BUILD_S * 1000)) * meshes.length)))
			while (shown < due) meshes[shown++].visible = true
			await new Promise(resolve => window.setTimeout(resolve, 16))
		}
	} else if (blocks) {
		for (const mesh of blocks.children) mesh.visible = true
	}

	let mesh = null
	try {
		mesh = await seating
	} catch (error) {
		if (!blocks) throw error // nothing on screen — let the outer catch log it
		console.error("reveal splat unavailable; the block-out stays up", error)
		showCopy(band, "tail") // the sentence still completes over the blocks
		return
	}

	if (!blocks || reduceMotion) {
		if (blocks) disposeObject(blocks)
		tilt.add(mesh)
		showCopy(band, "tail")
		return
	}

	// Seat the splat invisibly and let Spark's sort settle behind the opaque
	// blocks. No cold-start probe here (the hero and showcase splats already
	// warmed WASM/workers/shaders during page load) — a fixed beat suffices.
	mesh.opacity = 0
	tilt.add(mesh)
	await new Promise(resolve => window.setTimeout(resolve, WARM_MS))

	// The payoff: every block ramps to white-hot, the splat fades up through
	// the glow, and the blocks dissolve away — primitives became a world.
	const mats = []
	const lines = []
	for (const block of blocks.children) {
		block.material.emissive = WHITE.clone()
		block.material.emissiveIntensity = 0
		mats.push(block.material)
		const edge = block.children.find(child => child.userData.isEdgeOutline)
		if (edge) lines.push({ material: edge.material, base: edge.material.color.clone() })
	}
	await animate(FLASH_MS, t => {
		for (const mat of mats) mat.emissiveIntensity = t
		for (const { material, base } of lines) material.color.copy(base).lerp(WHITE, t)
	})
	// The white blocks vanish completely before the splat shows a single
	// gaussian — the blink of empty stage is what sells the swap.
	for (const mat of [...mats, ...lines.map(l => l.material)]) {
		mat.transparent = true
		mat.depthWrite = false
	}
	await animate(FADE_MS, t => {
		for (const mat of mats) mat.opacity = 1 - t
		for (const { material } of lines) material.opacity = 1 - t
	})
	disposeObject(blocks)
	await animate(MATERIALIZE_MS, t => { mesh.opacity = t })
	mesh.opacity = 1
	showCopy(band, "tail") // the gaussian is fully there — close the sentence

	// The block-out is baked in the splat's display frame (see the generator),
	// so the boxes drop straight into the tilt group with the editor's look.
	async function buildBlocks() {
		const response = await fetch(BLOCKOUT)
		if (!response.ok) throw new Error(`reveal blockout fetch failed (${response.status})`)
		const data = await response.json()
		const group = new THREE.Group()
		;(data.primitives ?? []).forEach((prim, i) => {
			const block = createPrimitive(prim.type, i, prim)
			block.visible = false
			group.add(block)
		})
		if (!group.children.length) throw new Error("reveal blockout is empty")
		return group
	}

	// The PLY ships pre-normalized into the block-out's exact unit frame, so
	// seating needs no measuring — just the stored-file Y-flip.
	async function loadSplat() {
		const response = await fetch(SPLAT)
		if (!response.ok) throw new Error(`reveal splat fetch failed (${response.status})`)
		const bytes = new Uint8Array(await response.arrayBuffer())
		const splat = new SplatMesh({ fileBytes: bytes, fileName: "reveal-splat.ply" })
		await splat.initialized
		splat.rotation.x = Math.PI // stored splat files are Y-inverted vs the world
		return splat
	}
}

// rAF-driven tween, independent of the render loop so an off-screen band still
// finishes its sequence (invisibly) instead of stalling mid-swap.
function animate(ms, step) {
	return new Promise(resolve => {
		const start = performance.now()
		const frame = () => {
			const t = Math.min(1, (performance.now() - start) / ms)
			step(t)
			if (t < 1) requestAnimationFrame(frame)
			else resolve()
		}
		requestAnimationFrame(frame)
	})
}
