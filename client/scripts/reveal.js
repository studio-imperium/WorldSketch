// Scroll-reveal, two acts sharing one WebGL context. Act one is the editor
// block-out (assets/reveal-blockout.json, baked by
// scripts/generate-reveal-blockout.mjs): ~45 purposeful blocks construct
// bottom-up, ramp white-hot, and vanish. Act two is the materialization: the
// baked PLY (bake-reveal-splat.mjs, top 100k gaussians pre-normalized into a
// unit frame) is split client-side into chunks by radial distance from the
// plot's axis plus per-gaussian jitter — regional AND stochastic, so the build
// sweeps outward behind a fuzzy frontier — and the chunks fade in on
// staggered, overlapping ramps until the render is dense. Blocks and splat
// share the scene exactly like hero-splat.js; Spark accumulators are
// scene-scoped, so this can't ghost the hero or showcase splats.

import * as THREE from "three"
import { SparkRenderer, SplatMesh } from "spark"
import { createPrimitive, disposeObject } from "/scripts/primitives.js"

const TILT = 0.6                    // tipped down — a clear look onto the plot's ground
const DIST = 3.5                    // camera distance on +Z
const YAW = Math.PI * 0.5 - 0.5     // fixed orientation (180° flip, then 90° left), no spin
const FOCAL = 2.1                   // × min(W,H) — how much of the band the plot fills
const OX = 0.5                      // projection centre as a fraction of band width
const OY = 0.44                     // projection centre as a fraction of band height (< 0.5 sits it up a touch)
const BLOCK_BUILD_S = 0.9           // seconds of staggered block construction
const FADE_MS = 600                 // the matte blocks fade out evenly (smoothstep) while the
                                    // gaussians drizzle in beneath — a visible dissolve, but brief.
const WARM_MS = 600                 // chunks seated invisibly behind the blocks so the sort settles
const CHUNKS = 16                   // reveal granularity — each chunk ≈ 1/16th of the gaussians
const BUILD_S = 4.0                 // seconds from first gaussians to the full set
const RAMP_S = 1.2                  // outer chunks' fade — overlaps the next chunks' starts
const RAMP_FIRST_S = 0.4            // the centre chunk snaps in fast; ramps
                                    // lengthen toward RAMP_S across the first quarter of chunks
// Chunk area grows with radius (annuli get bigger), so a mild power keeps the
// visual pace even: slightly wider gaps for the small central chunks, tighter
// for the big outer rings.
const STAGGER_POW = 0.8
const JITTER = 0.3                  // × unit radius — how fuzzy the outward frontier is
const BLOCKOUT = "/assets/reveal-blockout.json"
const SPLAT = "/assets/reveal-splat.ply"

export function initReveal() {
	const band = document.getElementById("reveal")
	if (!band) return
	document.getElementById("reveal-canvas")?.remove() // retired ASCII layer
	main(band).catch(error => console.error(error)) // band keeps its background on failure
}

async function main(band) {
	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches

	const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" })
	renderer.setClearColor(0x000000, 0) // paper and the pixel-wave background show through
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
	renderer.domElement.className = "reveal-splat show" // chunks/blocks carry the build, not the canvas
	band.appendChild(renderer.domElement)
	const scene = new THREE.Scene()
	scene.add(new SparkRenderer({ renderer }))
	// Splats are unlit; the lights are for the matte block-out (hero's rig).
	scene.add(new THREE.HemisphereLight(0xffffff, 0x4a5d42, 2.25))
	const sun = new THREE.DirectionalLight(0xffffff, 1.8)
	sun.position.set(5, 8, 3)
	scene.add(sun)
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

	// Render only while the band is on screen; the tweens mutate state, the
	// loop just draws it (Spark's sort worker needs the steady frames).
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

	// The splat streams and chunks while the blocks build; the .catch marks the
	// rejection handled until the real await below.
	const seating = loadChunks()
	seating.catch(() => {})

	let blocks = null
	try {
		blocks = await buildBlocks()
		tilt.add(blocks)
	} catch (error) {
		console.warn("reveal block-out unavailable, going straight to the gaussians", error)
	}

	await arm
	// Don't play the show into a hidden tab — the setTimeout-driven build would
	// advance while rAF is frozen and the dissolve would play unseen.
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

	// Act one — bottom-up staggered construction, verbatim pacing from the
	// editor's Apply-JSON path: time-based so timer throttling can't stretch it.
	if (blocks && !reduceMotion) {
		const meshes = [...blocks.children].sort(
			(a, b) => (a.position.y - a.scale.y / 2) - (b.position.y - b.scale.y / 2),
		)
		const start = performance.now()
		let shown = 0
		while (shown < meshes.length) {
			const elapsed = performance.now() - start
			const due = Math.min(meshes.length, Math.max(shown + 1, Math.ceil((elapsed / (BLOCK_BUILD_S * 1000)) * meshes.length)))
			while (shown < due) meshes[shown++].visible = true
			await new Promise(resolve => window.setTimeout(resolve, 16))
		}
	} else if (blocks) {
		for (const mesh of blocks.children) mesh.visible = true
	}

	let chunks = null
	try {
		chunks = await seating
	} catch (error) {
		if (!blocks) throw error // nothing on screen — let the outer catch log it
		console.error("reveal splat unavailable; the block-out stays up", error)
		return
	}

	if (!blocks || reduceMotion) {
		if (blocks) disposeObject(blocks)
		for (const mesh of chunks) mesh.opacity = 1
		return
	}

	// The chunks sit seated at opacity 0; give Spark's sort a beat behind the
	// opaque blocks before the swap.
	await new Promise(resolve => window.setTimeout(resolve, WARM_MS))

	// Act two starts under act one's finale: the materialization clock begins
	// as the blocks start dissolving, so the world is already forming behind
	// the ghost geometry — no empty stage.
	const span = Math.max(0.001, BUILD_S - RAMP_S) // last chunk still finishes inside BUILD_S
	const materialize = animate(BUILD_S * 1000, t => {
		const now = t * BUILD_S
		chunks.forEach((mesh, i) => {
			const ramp = RAMP_FIRST_S + (RAMP_S - RAMP_FIRST_S) * Math.min(1, i / (chunks.length / 4))
			const local = (now - Math.pow(i / (chunks.length - 1), STAGGER_POW) * span) / ramp
			const o = local >= 1 ? 1 : local <= 0 ? 0 : local * local * (3 - 2 * local)
			if (o !== mesh.opacity) mesh.opacity = o
		})
	})

	// No white flash — full white on a white page reads as the blocks blinking
	// out and back. The matte blocks fade out evenly over the forming gaussians.
	const mats = []
	for (const block of blocks.children) {
		mats.push(block.material)
		const edge = block.children.find(child => child.userData.isEdgeOutline)
		if (edge) mats.push(edge.material)
	}
	for (const mat of mats) {
		mat.transparent = true
		mat.depthWrite = false
		// the materials were compiled opaque (blending off, opacity ignored);
		// without a recompile the "fade" renders as a hard snap at dispose
		mat.needsUpdate = true
	}
	await animate(FADE_MS, t => {
		const o = 1 - t * t * (3 - 2 * t)
		for (const mat of mats) mat.opacity = o
	})
	disposeObject(blocks)
	await materialize
	for (const mesh of chunks) mesh.opacity = 1

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

	// The PLY ships pre-normalized into the block-out's exact unit frame; each
	// chunk seats invisibly so the whole set is sort-warm before its fade.
	async function loadChunks() {
		const response = await fetch(SPLAT)
		if (!response.ok) throw new Error(`reveal splat fetch failed (${response.status})`)
		const bytes = new Uint8Array(await response.arrayBuffer())
		return Promise.all(chunkPly(bytes, CHUNKS).map(async chunk => {
			const mesh = new SplatMesh({ fileBytes: chunk, fileName: "reveal-chunk.ply" })
			await mesh.initialized
			mesh.rotation.x = Math.PI // stored splat files are Y-inverted vs the world
			mesh.opacity = 0
			tilt.add(mesh)
			return mesh
		}))
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

// Split a binary-little-endian PLY into k sub-PLYs ordered for the reveal:
// each gaussian is scored by its radial distance from the plot's vertical axis
// plus deterministic jitter, the rows are sorted by score, and chunk j gets the
// j-th slice. Fading chunks in order then grows the world outward from the
// centre behind a stochastic frontier.
function chunkPly(bytes, k) {
	const headText = new TextDecoder().decode(bytes.subarray(0, 4096))
	const marker = "end_header\n"
	const headEnd = headText.indexOf(marker) + marker.length
	const total = Number(headText.match(/element vertex (\d+)/)[1])
	const props = [...headText.matchAll(/property float (\w+)/g)].length
	const stride = props * 4
	const view = new DataView(bytes.buffer, bytes.byteOffset)

	// positions are unit-frame and origin-centred (the bake guarantees it), so
	// radius in the ground plane needs no measuring; x/z are props 0 and 2
	let seed = 0x5eed2
	const rng = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
	const score = new Float32Array(total)
	const order = new Uint32Array(total)
	for (let i = 0; i < total; i++) {
		const o = headEnd + i * stride
		score[i] = Math.hypot(view.getFloat32(o, true), view.getFloat32(o + 8, true)) + JITTER * rng()
		order[i] = i
	}
	order.sort((a, b) => score[a] - score[b])

	const chunks = []
	for (let j = 0; j < k; j++) {
		const from = Math.floor(j * total / k)
		const to = Math.floor((j + 1) * total / k)
		const header = new TextEncoder().encode(
			headText.slice(0, headEnd).replace(/element vertex \d+/, `element vertex ${to - from}`))
		const out = new Uint8Array(header.length + (to - from) * stride)
		out.set(header, 0)
		let off = header.length
		for (let n = from; n < to; n++) {
			const i = order[n]
			out.set(bytes.subarray(headEnd + i * stride, headEnd + (i + 1) * stride), off)
			off += stride
		}
		chunks.push(out)
	}
	return chunks
}
