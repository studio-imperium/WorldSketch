// Scroll-reveal: the world materializes gaussian-by-gaussian, growing outward
// from the centre of the plot. The baked PLY (bake-reveal-splat.mjs, top 100k
// gaussians pre-normalized into a unit frame) is split client-side into chunks
// by radial distance from the plot's axis plus per-gaussian jitter — regional
// AND stochastic, so the build sweeps outward behind a fuzzy frontier — and
// the chunks fade in on staggered, overlapping ramps until the render is dense.
// The splat layer gets its own WebGL context + SparkRenderer + scene — Spark
// accumulators are scene-scoped (hero-splat.js proves the pattern), so it can't
// ghost the hero or showcase splats.

import * as THREE from "three"
import { SparkRenderer, SplatMesh } from "spark"

const TILT = 0.6                    // tipped down — a clear look onto the plot's ground
const DIST = 3.5                    // camera distance on +Z
const YAW = Math.PI * 0.5 - 0.5     // fixed orientation (180° flip, then 90° left), no spin
const FOCAL = 2.1                   // × min(W,H) — how much of the band the plot fills
const OX = 0.5                      // projection centre as a fraction of band width
const OY = 0.44                     // projection centre as a fraction of band height (< 0.5 sits it up a touch)
const CHUNKS = 16                   // reveal granularity — each chunk ≈ 1/16th of the gaussians
const BUILD_S = 3.2                 // seconds from first gaussians to the full set
const RAMP_S = 0.9                  // each chunk's own fade — overlaps the next chunks' starts
// Chunk area grows with radius (annuli get bigger), so a mild power keeps the
// visual pace even: slightly wider gaps for the small central chunks, tighter
// for the big outer rings.
const STAGGER_POW = 0.8
const JITTER = 0.3                  // × unit radius — how fuzzy the outward frontier is
const WARM_MS = 250                 // the scene renders invisibly first, so the sort has settled

export function initReveal() {
	const band = document.getElementById("reveal")
	if (!band) return
	document.getElementById("reveal-canvas")?.remove() // retired ASCII layer

	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches

	let splat = null   // { renderer, scene, camera, el, meshes } once seated
	let W = 0, H = 0
	function resize() {
		const r = band.getBoundingClientRect()
		W = r.width; H = r.height
		sizeSplat()
	}
	resize()
	new ResizeObserver(resize).observe(band)

	loadSplat().catch(error => console.error(error)) // on failure the band keeps its background

	async function loadSplat() {
		const response = await fetch("/assets/reveal-splat.ply")
		if (!response.ok) throw new Error(`reveal splat fetch failed (${response.status})`)
		const bytes = new Uint8Array(await response.arrayBuffer())

		const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" })
		renderer.setClearColor(0x000000, 0) // paper and the pixel-wave background show through
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
		renderer.domElement.className = "reveal-splat"
		band.appendChild(renderer.domElement)
		const scene = new THREE.Scene()
		scene.add(new SparkRenderer({ renderer }))
		const tilt = new THREE.Group()
		tilt.rotation.x = TILT
		const yawGroup = new THREE.Group()
		yawGroup.rotation.y = -YAW
		yawGroup.add(tilt)
		scene.add(yawGroup)
		const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 100)
		camera.position.set(0, 0, DIST)
		camera.lookAt(0, 0, 0)

		const meshes = await Promise.all(chunkPly(bytes, CHUNKS).map(async chunk => {
			const mesh = new SplatMesh({ fileBytes: chunk, fileName: "reveal-chunk.ply" })
			await mesh.initialized
			mesh.rotation.x = Math.PI // stored splat files are Y-inverted vs the world
			mesh.opacity = 0 // visible from frame one so the sort covers everything; the ramp brings it up
			tilt.add(mesh)
			return mesh
		}))
		splat = { renderer, scene, camera, el: renderer.domElement, meshes }
		splat.el.classList.add("show") // the canvas itself is never faded — chunks carry the build
		sizeSplat()
	}
	function sizeSplat() {
		if (!splat || !W || !H) return
		splat.renderer.setSize(W, H, false)
		splat.camera.aspect = W / H
		splat.camera.fov = 2 * Math.atan(H / (2 * FOCAL * Math.min(W, H))) * (180 / Math.PI)
		splat.camera.setViewOffset(W, H, (0.5 - OX) * W, (0.5 - OY) * H, W, H)
		splat.camera.updateProjectionMatrix()
	}

	// how far the band has scrolled into view — arms the build
	function inView() {
		const r = band.getBoundingClientRect()
		const vh = window.innerHeight || 1
		return (vh - r.top) / (vh * 0.85) > 0.15
	}

	// Render every visible frame (Spark's sort worker is async); once the band is
	// in view, run the build clock. Chunk i starts its own RAMP_S fade at an even
	// offset through the build, so several chunks are always mid-fade — gaussians
	// accumulate as a continuous drizzle instead of discrete pops.
	let running = false
	let buildStart = 0
	function tick(now) {
		if (!running) return
		if (splat) {
			if (!buildStart && inView()) buildStart = now + WARM_MS
			if (buildStart) {
				const t = reduceMotion ? Infinity : (now - buildStart) / 1000
				const span = Math.max(0.001, BUILD_S - RAMP_S) // last chunk still finishes inside BUILD_S
				splat.meshes.forEach((mesh, i) => {
					const local = (t - Math.pow(i / (splat.meshes.length - 1), STAGGER_POW) * span) / RAMP_S
					const o = local >= 1 ? 1 : local <= 0 ? 0 : local * local * (3 - 2 * local)
					if (o !== mesh.opacity) mesh.opacity = o
				})
			}
			splat.renderer.render(splat.scene, splat.camera)
		}
		requestAnimationFrame(tick)
	}

	// only burn frames while the band is actually on screen
	new IntersectionObserver(([e]) => {
		if (e.isIntersecting && !running) { running = true; requestAnimationFrame(tick) }
		else if (!e.isIntersecting) running = false
	}, { threshold: 0 }).observe(band)
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
