import * as THREE from "three"

// Seat a freshly-reconstructed Tripo splat into its target box.
//
// Each subject is captured ALONE on a black background from a fixed pose, so Tripo's
// output lands in a consistent orientation — the same property the old whole-plot
// pipeline relied on. We therefore NEVER rotate the splat (we have no reliable way to
// know a gaussian cloud's "correct" yaw). We only:
//   1. gently cull the transparent haze + stray floaters Tripo leaves behind,
//   2. measure the robust content AABB (percentile extents, ignoring outliers),
//   3. uniform-scale the footprint onto the target box and seat its bottom on it.
//
// The stored model is upside-down (world-up = decreasing stored-Y), so the Y scale is
// negated (the proven flip) and the subject's BOTTOM is its MAX stored-Y.

const UP = new THREE.Vector3(0, 1, 0)

// SparkEngine renders gaussians at a fraction (~1/3) of the nominal mesh scale, so a
// SplatMesh sized 1:1 against its colliders shows up ~3x too small. This is the
// constant the old pipeline carried as WS_CULL_FIT / unitScale = 3: multiply the
// mesh scale by it to reach true primitive/world units. (If your SparkEngine build
// renders 1:1, set this to 1.)
const SPARK_UNIT_SCALE = 3

function percentile(sorted, q) {
	if (!sorted.length) return 0
	const pos = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
	return sorted[pos]
}

// --- sRGB <-> CIELAB (D65), for enforcing the block-out palette onto gaussian colours.
// Mirrors the server's image-side palette lock so the splat gets the same treatment.
const clamp01 = v => Math.min(1, Math.max(0, v))
const sToLin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const linToS = c => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)

function srgbToLab(r, g, b) {
	const rl = sToLin(r), gl = sToLin(g), bl = sToLin(b)
	let X = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047
	const Y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722
	let Z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883
	const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
	const fx = f(X), fy = f(Y), fz = f(Z)
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function labToSrgb(L, a, b) {
	const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200
	const inv = t => {
		const t3 = t * t * t
		return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787
	}
	const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883
	const rl = X * 3.2406 + Y * -1.5372 + Z * -0.4986
	const gl = X * -0.9689 + Y * 1.8758 + Z * 0.0415
	const bl = X * 0.0557 + Y * -0.204 + Z * 1.057
	return [clamp01(linToS(rl)), clamp01(linToS(gl)), clamp01(linToS(bl))]
}

function hexToLab(hex) {
	const h = hex.replace("#", "")
	return srgbToLab(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255)
}

// Nearest palette colour in LAB, lightness down-weighted (×0.25) so the match is driven by
// hue/chroma — matches the server's nearestLab so image + splat agree on the same colour.
function nearestLab(palette, L, a, b) {
	let best = palette[0]
	let bestD = Infinity
	for (const p of palette) {
		const dL = (p[0] - L) * 0.25, da = p[1] - a, db = p[2] - b
		const d = dL * dL + da * da + db * db
		if (d < bestD) {
			bestD = d
			best = p
		}
	}
	return best
}

export async function fitSplatToBox(source, box, opts = {}) {
	const opacityFloor = opts.opacityFloor ?? 0.1 // drop low-opacity haze/wisp gaussians (WS_OPACITY_FLOOR)
	const radiusKeep = opts.radiusKeep ?? 0.995 // drop the farthest 0.5% (lone floaters)
	const loQ = opts.spanLo ?? 0 // robust extent percentiles, so a few strays
	const hiQ = opts.spanHi ?? 1 // can't blow up the measured size

	// Optional per-gaussian palette enforcement (the splat side of the palette lock): snap
	// each gaussian's chroma to its nearest block-out colour, pull its lightness similarly.
	const palette = opts.palette?.length ? opts.palette.map(hexToLab) : null
	const paletteStrength = opts.paletteStrength ?? 0 // chroma blend toward the palette colour
	const paletteLightness = opts.paletteLightness ?? 0 // lightness pull toward the palette colour

	const packed = source.packedSplats
	const total = packed?.numSplats ?? 0
	if (!total) return null

	const xs = new Float32Array(total)
	const ys = new Float32Array(total)
	const zs = new Float32Array(total)
	const keep = new Uint8Array(total).fill(1)

	packed.forEachSplat((i, center, scales, quaternion, opacity) => {
		xs[i] = center.x
		ys[i] = center.y
		zs[i] = center.z
		if (opacity < opacityFloor) keep[i] = 0
	})

	// Median center (robust) of the survivors, then drop the farthest few as floaters.
	const survivorsX = []
	const survivorsZ = []
	for (let i = 0; i < total; i++) {
		if (!keep[i]) continue
		survivorsX.push(xs[i])
		survivorsZ.push(zs[i])
	}
	if (!survivorsX.length) return null
	const medianX = percentile(survivorsX.slice().sort((a, b) => a - b), 0.5)
	const medianZ = percentile(survivorsZ.slice().sort((a, b) => a - b), 0.5)
	if (radiusKeep < 1) {
		const dists = []
		for (let i = 0; i < total; i++) if (keep[i]) dists.push(Math.hypot(xs[i] - medianX, zs[i] - medianZ))
		const cut = percentile(dists.sort((a, b) => a - b), radiusKeep)
		for (let i = 0; i < total; i++) if (keep[i] && Math.hypot(xs[i] - medianX, zs[i] - medianZ) > cut) keep[i] = 0
	}

	// Robust content extents from the kept gaussians.
	const keptX = []
	const keptY = []
	const keptZ = []
	for (let i = 0; i < total; i++) {
		if (!keep[i]) continue
		keptX.push(xs[i])
		keptY.push(ys[i])
		keptZ.push(zs[i])
	}
	if (!keptX.length) return null
	keptX.sort((a, b) => a - b)
	keptY.sort((a, b) => a - b)
	keptZ.sort((a, b) => a - b)

	const minX = percentile(keptX, loQ)
	const maxX = percentile(keptX, hiQ)
	const minZ = percentile(keptZ, loQ)
	const maxZ = percentile(keptZ, hiQ)
	const topStoredY = percentile(keptY, loQ) // world-up top (min stored-Y)
	const bottomStoredY = percentile(keptY, hiQ) // world-up bottom (max stored-Y)

	const spanX = Math.max(1e-4, maxX - minX)
	const spanZ = Math.max(1e-4, maxZ - minZ)
	const spanY = Math.max(1e-4, bottomStoredY - topStoredY)
	const centerX = (minX + maxX) / 2
	const centerZ = (minZ + maxZ) / 2

	// Uniform scale = the AVERAGE of the per-axis box-fits (target/span), so the subject
	// fills its collider as a compromise across axes without distorting Tripo's proportions
	// (it's still one scale). X+Z always (the footprint); Y too when opts.fitHeight is set
	// (objects). Y is omitted for the flat floor box, whose tiny targetY/spanY would
	// otherwise crush the average and shrink the floor.
	const targetX = box.max.x - box.min.x
	const targetZ = box.max.z - box.min.z
	const fits = [targetX / spanX, targetZ / spanZ]
	if (opts.fitHeight) fits.push((box.max.y - box.min.y) / spanY)
	const scale = fits.reduce((a, b) => a + b, 0) / fits.length
	if (!Number.isFinite(scale) || scale <= 0) return null

	// Compact survivors to the front of the packed buffer + truncate. No reorientation,
	// so each survivor is written straight back at its (culled) new index. If a palette is
	// given, recolour each kept gaussian onto it (chroma by paletteStrength, lightness by
	// paletteLightness) — the splat-level twin of the server's image palette lock.
	let kept = 0
	packed.forEachSplat((i, center, scales, quaternion, opacity, color) => {
		if (!keep[i]) return
		if (palette) {
			const [L, a, b] = srgbToLab(color.r, color.g, color.b)
			const p = nearestLab(palette, L, a, b)
			const [nr, ng, nb] = labToSrgb(L + (p[0] - L) * paletteLightness, a + (p[1] - a) * paletteStrength, b + (p[2] - b) * paletteStrength)
			color.r = nr
			color.g = ng
			color.b = nb
		}
		packed.setSplat(kept, center, scales, quaternion, opacity, color)
		kept++
	})
	if (!kept) return null
	packed.numSplats = kept
	packed.needsUpdate = true

	// Seat: center the footprint on the target box, pin the subject's bottom to the
	// box floor. With scale.y = -scale, a stored y renders at worldY = -scale*y + posY;
	// the bottom (y = bottomStoredY) must land at box.min.y.
	const targetCenterX = (box.min.x + box.max.x) / 2
	const targetCenterZ = (box.min.z + box.max.z) / 2
	const posY = box.min.y + scale * bottomStoredY
	// The mesh scale gets the SparkEngine unit-scale bump; position + seat keep the
	// true ratio `scale`, so the rendered content still lands centered + seated in the
	// box regardless of the engine's internal render fraction.
	const render = scale * SPARK_UNIT_SCALE
	source.scale.set(render, -render, render)
	source.position.set(targetCenterX - scale * centerX, posY, targetCenterZ - scale * centerZ)

	// Post-seat yaw about the subject's own centre (NOT a pose search — we never recover the
	// cloud's true pose; we bank on Tripo being consistent for a fixed capture angle). yawTurns
	// gives 90° steps (legacy); yawDeg adds an arbitrary offset (WS_OBJECT_YAW / WS_FLOOR_YAW)
	// so a turned reconstruction can be dialled back in degrees without a rebuild.
	const yawDeg = ((opts.yawTurns ?? 0) % 4) * 90 + (opts.yawDeg ?? 0)
	if (yawDeg) {
		const yaw = new THREE.Quaternion().setFromAxisAngle(UP, (yawDeg * Math.PI) / 180)
		const pivot = new THREE.Vector3(targetCenterX, posY, targetCenterZ)
		source.quaternion.copy(yaw)
		source.position.sub(pivot).applyQuaternion(yaw).add(pivot)
	}

	// Final Y nudge (WS_CULL_Y_OFFSET), applied AFTER the fit + seat + yaw so it is a
	// pure plot-local lift/drop of the already-seated subject (+ = up).
	const yOffset = opts.yOffset ?? 0
	source.position.y += yOffset

	// The seated content AABB in plot-local space, for the "Bounds" debug overlay. A yaw near
	// 90°/270° swaps the X/Z extents (approximate for off-axis yawDeg — it's a debug box).
	const quarter = Math.abs(Math.round(yawDeg / 90)) % 2
	const halfX = (quarter ? scale * spanZ : scale * spanX) / 2
	const halfZ = (quarter ? scale * spanX : scale * spanZ) / 2
	const floorY = box.min.y + yOffset
	source.userData.contentBox = new THREE.Box3(
		new THREE.Vector3(targetCenterX - halfX, floorY, targetCenterZ - halfZ),
		new THREE.Vector3(targetCenterX + halfX, floorY + scale * spanY, targetCenterZ + halfZ),
	)
	return source
}
