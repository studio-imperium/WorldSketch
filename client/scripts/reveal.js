// Scroll-reveal "gaussian resolve": the plot assembles as an ASCII-filter cloud,
// then crossfades into the REAL gaussian splat once the build lands — same full
// quality as the hero and showcase renders. Two baked assets drive it:
//   · reveal-points.bin (sample-reveal-points.mjs) — 9k opacity×area-weighted
//     samples with real colors (24-color palette), ~70KB, so assembly starts
//     near-instantly; and
//   · reveal-splat.ply (bake-reveal-splat.mjs) — the top 100k gaussians (~5MB
//     instead of 17.8MB), pre-normalized into the SAME unit frame, streaming in
//     parallel so the crossfade lines up with zero runtime measuring.
// The splat layer gets its own WebGL context + SparkRenderer + scene — Spark
// accumulators are scene-scoped (hero-splat.js proves the pattern), so it can't
// ghost the hero or showcase splats.

import * as THREE from "three"
import { SparkRenderer, SplatMesh } from "spark"

const RAMP = " .·:-=+*#%@"          // sparse → dense; indexed by opacity-weight + depth
const ACCENT = "#5b6ee1"            // editor accent — freshly-formed points flash this, then settle
const TILT = 0.6                    // tipped down — a clear look onto the plot's ground
const DIST = 3.5                    // camera distance on +Z
const YAW = Math.PI * 0.5 - 0.5     // fixed orientation (180° flip, then 90° left), no spin
const FOCAL = 2.1                   // × min(W,H) — how much of the band the plot fills
const OX = 0.5                      // projection centre as a fraction of band width
const OY = 0.44                     // projection centre as a fraction of band height (< 0.5 sits it up a touch)
const BUILD_S = 1.6                 // seconds from first sight to fully resolved
const FADE_MS = 900                 // ASCII → splat crossfade; matches the CSS transition
// versioned: the server caches non-HTML for 1h, and a stale 18k-point bake would
// undo the fast-resolve tuning (fewer, bigger glyphs)
const POINTS = "/assets/reveal-points.bin?v=2"
const SPLAT = "/assets/reveal-splat.ply"

// Wire the band's ASCII canvas immediately (the animated background is its own
// layer, assets/bg_2.js), then fetch the baked points — tiny, so the cloud is
// ready long before any splat download would be.
export function initReveal() {
	const band = document.getElementById("reveal")
	const canvas = document.getElementById("reveal-canvas")
	if (!band || !canvas) return

	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
	const ctx = canvas.getContext("2d")

	// Point data fills in once the baked asset arrives; until then the loop idles.
	let n = 0
	let px = new Float32Array(0), py = new Float32Array(0), pz = new Float32Array(0)
	let ci = new Uint8Array(0)   // palette index per point
	let wt = new Uint8Array(0)   // opacity×area percentile per point → glyph density
	let palette = []
	function setPoints({ positions, colorIdx, weights, colors, count }) {
		// positions arrive unit-normalized, origin-centred, centre-out sorted;
		// pre-tilt about X here so the per-frame work is just the projection.
		const cosT = Math.cos(TILT), sinT = Math.sin(TILT)
		px = new Float32Array(count); py = new Float32Array(count); pz = new Float32Array(count)
		for (let i = 0; i < count; i++) {
			const x = positions[i * 3] / 32767
			const y = positions[i * 3 + 1] / 32767
			const z = positions[i * 3 + 2] / 32767
			px[i] = x
			py[i] = y * cosT - z * sinT
			pz[i] = y * sinT + z * cosT
		}
		ci = colorIdx
		wt = weights
		palette = colors
		bakeSprites()
		n = count
	}

	// --- glyph sprites, one per (palette color × ramp glyph); blit beats fillText ---
	// 18px cells: the bake ships 9k points (half the old 18k so frames stay cheap)
	// spread over a 2×-size projection, so larger glyphs keep the cloud reading
	// solid during assembly.
	let dpr = 1, cell = 18, tiles = [], accentTiles = []
	function bakeSprites() {
		dpr = Math.min(window.devicePixelRatio || 1, 2)
		cell = Math.round(18 * dpr)
		accentTiles = RAMP.split("").map(g => bake(g, ACCENT))
		// slight chroma/contrast push so the plot's colors read on paper at glyph size
		tiles = palette.map(([r, g, b]) => {
			const lum = 0.299 * r + 0.587 * g + 0.114 * b
			const pop = v => Math.max(0, Math.min(255, Math.round((lum + (v - lum) * 1.35) * 0.9)))
			const color = `rgb(${pop(r)},${pop(g)},${pop(b)})`
			return RAMP.split("").map(g2 => bake(g2, color))
		})
	}
	function bake(glyph, color) {
		const t = document.createElement("canvas")
		t.width = t.height = cell
		const c = t.getContext("2d")
		c.font = `${Math.round(cell * 0.95)}px ui-monospace, SFMono-Regular, Menlo, monospace`
		c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = color
		c.fillText(glyph, cell / 2, cell / 2 + cell * 0.04)
		return t
	}

	let W = 0, H = 0
	// declared before the first resize() below — it calls sizeSplat()
	let splat = null   // { renderer, scene, camera, el } once seated
	let fadeAt = 0     // tick timestamp when the crossfade started
	function resize() {
		const r = band.getBoundingClientRect()
		W = r.width; H = r.height
		canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
		canvas.style.width = W + "px"; canvas.style.height = H + "px"
		sizeSplat()
	}
	bakeSprites(); resize()
	new ResizeObserver(resize).observe(band)

	// --- real splat layer: what the ASCII build resolves INTO ---
	// The PLY ships pre-normalized into the bin's exact unit frame, so seating
	// needs no measuring: a tilt group plus a yaw group reproduce the 2D cloud's
	// transform, and the crossfade lands on the same silhouette.
	loadSplat().catch(error => console.error(error)) // on failure the ASCII cloud just stays

	async function loadSplat() {
		const response = await fetch(SPLAT)
		if (!response.ok) throw new Error(`reveal splat fetch failed (${response.status})`)
		const bytes = new Uint8Array(await response.arrayBuffer())
		const mesh = new SplatMesh({ fileBytes: bytes, fileName: "reveal-splat.ply" })
		await mesh.initialized
		mesh.rotation.x = Math.PI // stored splat files are Y-inverted vs the world

		const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" })
		renderer.setClearColor(0x000000, 0) // paper, grid and code field show through
		renderer.setPixelRatio(dpr)
		renderer.domElement.className = "reveal-splat"
		band.insertBefore(renderer.domElement, canvas) // just under the ASCII canvas
		const scene = new THREE.Scene()
		scene.add(new SparkRenderer({ renderer }))
		// same composite as the glyph projection: world = Ry(−YAW) · Rx(TILT)
		const tilt = new THREE.Group()
		tilt.rotation.x = TILT
		tilt.add(mesh)
		const yawGroup = new THREE.Group()
		yawGroup.rotation.y = -YAW
		yawGroup.add(tilt)
		scene.add(yawGroup)
		const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 100)
		camera.position.set(0, 0, DIST)
		camera.lookAt(0, 0, 0)
		splat = { renderer, scene, camera, el: renderer.domElement }
		sizeSplat()
	}
	// Match the 2D projection exactly — focal length FOCAL·min(W,H) with the
	// principal point at (OX·W, OY·H) (the cloud's ox/oy) — so the crossfade
	// doesn't jump.
	function sizeSplat() {
		if (!splat || !W || !H) return
		splat.renderer.setSize(W, H, false)
		splat.camera.aspect = W / H
		splat.camera.fov = 2 * Math.atan(H / (2 * FOCAL * Math.min(W, H))) * (180 / Math.PI)
		splat.camera.setViewOffset(W, H, (0.5 - OX) * W, (0.5 - OY) * H, W, H)
		splat.camera.updateProjectionMatrix()
	}

	// how far the band has scrolled into view — only used to ARM the build
	function inView() {
		const r = band.getBoundingClientRect()
		const vh = window.innerHeight || 1
		return (vh - r.top) / (vh * 0.85) > 0.15
	}

	// The build is time-driven, not scroll-driven: first sight starts a BUILD_S
	// clock and the plot assembles itself — no need to keep scrolling it along.
	// Accumulated dt (not wall time) so an off-screen pause doesn't skip ahead.
	let buildT = -1 // -1 = not armed yet; then 0 → 1 over BUILD_S
	let last = performance.now(), running = false
	const cy2 = Math.cos(YAW), sy2 = Math.sin(YAW) // fixed orientation, hoisted out of the loop
	function tick(now) {
		if (!running) return
		const raw = (now - last) / 1000; last = now

		if (buildT < 0 && n && inView()) buildT = reduceMotion ? 1 : 0 // reduced motion: appear built
		// The build clock runs on real elapsed time (clamped only against hitches),
		// NOT the render dt clamp above — on a slow machine dropped frames would
		// otherwise stretch BUILD_S out several-fold. Off-screen pause is still
		// safe: `last` resets when the IntersectionObserver restarts the loop.
		else if (buildT >= 0 && buildT < 1) buildT = Math.min(1, buildT + Math.min(0.25, raw) / BUILD_S)
		const t = buildT < 0 ? 0 : buildT
		const eased = t * t * (3 - 2 * t)                    // smoothstep the assembly
		const revealTo = Math.floor(eased * n)
		const focal = Math.min(W, H) * dpr * FOCAL
		const ox = canvas.width * OX, oy = canvas.height * OY

		// Build complete + splat seated → crossfade: glyphs out, real render in.
		if (!fadeAt && splat && buildT >= 1) {
			fadeAt = now
			splat.el.classList.add("show")
			canvas.classList.add("hide")
		}
		// Render every visible frame like the hero does — Spark's sort worker is
		// async, so a static scene still needs live renders until the sorted
		// order lands. Starting during the build (canvas still at opacity 0)
		// warms the sort up, so the fade's first visible frame is already whole;
		// the IntersectionObserver pauses all of this off-screen.
		if (splat && buildT >= 0) splat.renderer.render(splat.scene, splat.camera)
		// once the CSS fade has finished, stop paying for 9k glyph blits per frame
		const faded = fadeAt > 0 && now - fadeAt >= FADE_MS

		ctx.clearRect(0, 0, canvas.width, canvas.height)
		for (let k = 0; k < (faded ? 0 : revealTo); k++) {
			const x = px[k], y = py[k], z = pz[k]
			const rx = x * cy2 - z * sy2
			const rz = x * sy2 + z * cy2
			const camZ = DIST - rz
			if (camZ <= 0.15) continue
			const f = focal / camZ
			const sx = ox + rx * f
			const sy = oy - y * f
			if (sx < -cell || sx > canvas.width + cell || sy < -cell || sy > canvas.height + cell) continue
			const near = clamp((DIST + 1 - camZ) / 2, 0, 1)     // far 0 → near 1
			// glyph density = mostly how solid the gaussian is, sharpened by depth
			const density = 0.65 * (wt[k] / 255) + 0.35 * near
			const gi = 1 + Math.min(RAMP.length - 2, Math.floor(density * (RAMP.length - 1)))
			// points at the growing frontier flash accent, then settle into their color
			const frontier = clamp((k - (revealTo - n * 0.05)) / (n * 0.05), 0, 1)
			ctx.globalAlpha = (0.45 + 0.5 * near) * (0.5 + 0.5 * eased)
			const tile = (frontier > 0 && !reduceMotion ? accentTiles : tiles[ci[k]])[gi]
			ctx.drawImage(tile, sx - cell / 2, sy - cell / 2)
		}
		ctx.globalAlpha = 1
		requestAnimationFrame(tick)
	}

	// only burn frames while the band is actually on screen
	new IntersectionObserver(([e]) => {
		if (e.isIntersecting && !running) { running = true; last = performance.now(); requestAnimationFrame(tick) }
		else if (!e.isIntersecting) running = false
	}, { threshold: 0 }).observe(band)

	fetch(POINTS)
		.then(r => { if (!r.ok) throw new Error(`reveal points fetch failed (${r.status})`); return r.arrayBuffer() })
		.then(b => {
			const jsonLen = new DataView(b).getUint32(0, true)
			const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(b, 4, jsonLen)))
			let o = 4 + jsonLen
			// slice before viewing: o isn't guaranteed 2-byte aligned for Int16Array
			const positions = new Int16Array(b.slice(o, o + meta.count * 6)); o += meta.count * 6
			const colorIdx = new Uint8Array(b, o, meta.count); o += meta.count
			const weights = new Uint8Array(b, o, meta.count)
			setPoints({ positions, colorIdx, weights, colors: meta.palette, count: meta.count })
		})
		.catch(error => console.error(error)) // band stays background-only, never empty
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
