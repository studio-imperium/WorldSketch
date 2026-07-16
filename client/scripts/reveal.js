// Scroll-reveal "gaussian resolve": the courtyard splat's own points, sampled by
// landing.js, drawn as a monochrome ASCII cloud that assembles from its centre
// outward as the band scrolls into view — over a field of drifting graphics-code.
// Pure 2D canvas, no second WebGL/Spark context, so it can't ghost the hero splat.

const RAMP = " .·:-=+*#%@"          // sparse → dense; index by depth (far → near)
const INK = "#0d0d0c"
const ACCENT = "#5b6ee1"            // editor accent — freshly-formed points flash this, then settle
const TILT = 0.34                   // look slightly down onto the cloud, like the hero
const DIST = 3.5                    // camera distance on +Z
const YAW_SPEED = 0.16              // rad/s ambient turn

// Mount the band's background (grid is CSS; this adds the drifting code field and
// wires the canvas) immediately, independent of the splat. Returns a setPoints()
// the caller feeds once the splat's sampled points are ready — so a slow or failed
// splat never leaves the band empty.
export function initReveal() {
	const band = document.getElementById("reveal")
	const canvas = document.getElementById("reveal-canvas")
	const codeHost = document.getElementById("reveal-code")
	const countEl = document.getElementById("reveal-count")
	if (!band || !canvas) return () => {}

	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
	const ctx = canvas.getContext("2d")

	buildCodeField(codeHost)

	// Point arrays fill in once setPoints() runs; until then the loop just idles.
	let n = 0, pointTotal = 0
	let px = new Float32Array(0), py = new Float32Array(0), pz = new Float32Array(0)
	function setPoints(flatPoints, total) {
		// normalise into a unit, origin-centred, pre-tilted frame, sorted centre-outward
		// so a reveal is just a count threshold
		const m = Math.floor(flatPoints.length / 3)
		if (!m) return
		let cx = 0, cy = 0, cz = 0
		for (let i = 0; i < m; i++) { cx += flatPoints[i * 3]; cy += flatPoints[i * 3 + 1]; cz += flatPoints[i * 3 + 2] }
		cx /= m; cy /= m; cz /= m
		let maxR = 1e-6
		const centred = new Float32Array(m * 3)
		for (let i = 0; i < m; i++) {
			const x = flatPoints[i * 3] - cx, y = flatPoints[i * 3 + 1] - cy, z = flatPoints[i * 3 + 2] - cz
			centred[i * 3] = x; centred[i * 3 + 1] = y; centred[i * 3 + 2] = z
			maxR = Math.max(maxR, Math.hypot(x, y, z))
		}
		const order = [...Array(m).keys()].sort((a, b) =>
			(centred[a * 3] ** 2 + centred[a * 3 + 1] ** 2 + centred[a * 3 + 2] ** 2) -
			(centred[b * 3] ** 2 + centred[b * 3 + 1] ** 2 + centred[b * 3 + 2] ** 2))
		const cosT = Math.cos(TILT), sinT = Math.sin(TILT)
		px = new Float32Array(m); py = new Float32Array(m); pz = new Float32Array(m)
		for (let k = 0; k < m; k++) {
			const i = order[k]
			const x = centred[i * 3] / maxR, y = centred[i * 3 + 1] / maxR, z = centred[i * 3 + 2] / maxR
			px[k] = x                      // pre-tilt about X so we read the ground plane
			py[k] = y * cosT - z * sinT
			pz[k] = y * sinT + z * cosT
		}
		n = m
		pointTotal = total || m
	}

	// --- glyph sprites (blit beats per-point fillText) ---
	let dpr = 1, cell = 16, inkTiles = [], accentTiles = []
	function bakeSprites() {
		dpr = Math.min(window.devicePixelRatio || 1, 2)
		cell = Math.round(16 * dpr)
		inkTiles = RAMP.split("").map(g => bake(g, INK))
		accentTiles = RAMP.split("").map(g => bake(g, ACCENT))
	}
	function bake(glyph, color) {
		const t = document.createElement("canvas")
		t.width = t.height = cell
		const c = t.getContext("2d")
		c.font = `${Math.round(cell * 0.92)}px ui-monospace, SFMono-Regular, Menlo, monospace`
		c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = color
		c.fillText(glyph, cell / 2, cell / 2 + cell * 0.04)
		return t
	}

	let W = 0, H = 0
	function resize() {
		const r = band.getBoundingClientRect()
		W = r.width; H = r.height
		canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
		canvas.style.width = W + "px"; canvas.style.height = H + "px"
	}
	bakeSprites(); resize()
	new ResizeObserver(resize).observe(band)

	// scroll progress: 0 as the band enters from the bottom, 1 once it's settled high
	function progress() {
		const r = band.getBoundingClientRect()
		const vh = window.innerHeight || 1
		return clamp((vh - r.top) / (vh * 0.85), 0, 1)
	}

	let yaw = -0.5, last = performance.now(), running = false, shown = 0
	function tick(now) {
		if (!running) return
		const dt = Math.min(0.05, (now - last) / 1000); last = now
		if (!reduceMotion) yaw += dt * YAW_SPEED

		const p = progress()
		const eased = p * p * (3 - 2 * p)                  // smoothstep the assembly
		const revealTo = Math.floor(eased * n)
		const focal = Math.min(W, H) * dpr * 0.52
		const ox = canvas.width / 2, oy = canvas.height * 0.52
		const cy2 = Math.cos(yaw), sy2 = Math.sin(yaw)

		ctx.clearRect(0, 0, canvas.width, canvas.height)
		for (let k = 0; k < revealTo; k++) {
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
			const gi = Math.min(RAMP.length - 1, 1 + Math.floor(near * (RAMP.length - 1)))
			// points at the growing frontier flash accent, then settle to ink
			const frontier = clamp((k - (revealTo - n * 0.05)) / (n * 0.05), 0, 1)
			ctx.globalAlpha = (0.30 + 0.55 * near) * (0.4 + 0.6 * eased)
			const tile = (frontier > 0 && !reduceMotion ? accentTiles : inkTiles)[gi]
			ctx.drawImage(tile, sx - cell / 2, sy - cell / 2)
		}
		ctx.globalAlpha = 1

		if (countEl && revealTo !== shown) {
			shown = revealTo
			const live = n ? Math.round((revealTo / n) * pointTotal) : 0
			countEl.textContent = `${live.toLocaleString("en-US")} gaussians`
		}
		requestAnimationFrame(tick)
	}

	// only burn frames while the band is actually on screen
	new IntersectionObserver(([e]) => {
		if (e.isIntersecting && !running) { running = true; last = performance.now(); requestAnimationFrame(tick) }
		else if (!e.isIntersecting) running = false
	}, { threshold: 0 }).observe(band)

	return setPoints
}

function buildCodeField(host) {
	if (!host) return
	const rng = lcg(0x5eed)
	const toks = [
		"SplatMesh.forEachSplat((i, center, scale, quat, rgba) =>",
		"spark.SparkRenderer({ renderer }).sort(view.camera)",
		"ground = outpaint(plots).slice(floorClipBoxes)",
		"packedSplats.pack(centers, covariance, sh0)",
		"radixDepthSort(order, camZ)   // 16-bit buckets",
		"mesh.rotation.x = Math.PI      // stored splats are Y-inverted",
		"heightAt(x, z) => raycast(ground).point.y",
		"plot.lift(delta) => deform(unifiedSplat, falloff)",
		"seam = blend(a.edge, b.edge, gradient)",
		"export.shotPath(keys).render({ gui: false })",
	]
	const lines = []
	for (let i = 0; i < 40; i++) {
		let s = toks[Math.floor(rng() * toks.length)]
		if (rng() < 0.5) s += "   " + hex(rng, 3 + Math.floor(rng() * 6))
		lines.push(s)
	}
	const block = lines.join("\n")
	const pre = document.createElement("pre")
	pre.textContent = block + "\n" + block          // doubled for a seamless upward drift
	host.appendChild(pre)
}

function hex(rng, n) {
	let s = "0x"
	for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(rng() * 16)]
	return s
}
function lcg(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
