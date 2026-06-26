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

export async function fitSplatToBox(source, box, opts = {}) {
	const opacityFloor = opts.opacityFloor ?? 0.02 // drop near-invisible haze gaussians
	const radiusKeep = opts.radiusKeep ?? 0.995 // drop the farthest 0.5% (lone floaters)
	const loQ = opts.spanLo ?? 0.02 // robust extent percentiles, so a few strays
	const hiQ = opts.spanHi ?? 0.98 // can't blow up the measured size

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

	// Uniform footprint scale: average the X and Z box-fits so the subject fills its
	// colliders' footprint without distorting Tripo's proportions. Height follows.
	const targetX = box.max.x - box.min.x
	const targetZ = box.max.z - box.min.z
	const scale = ((targetX / spanX) + (targetZ / spanZ)) / 2
	if (!Number.isFinite(scale) || scale <= 0) return null

	// Compact survivors to the front of the packed buffer + truncate. No reorientation,
	// so each survivor is written straight back at its (culled) new index.
	let kept = 0
	packed.forEachSplat((i, center, scales, quaternion, opacity, color) => {
		if (!keep[i]) return
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

	// Fixed yaw correction (NOT a per-object orientation search — we never recover a
	// cloud's pose). We bank on Tripo's output being consistent for a fixed capture
	// angle, so any turn is the SAME every time. Default 0: the per-object capture
	// reuses the proven isometric angle, so the splat should already line up. If live
	// output comes out turned, bump yawTurns (1|2|3 = 90/180/270°) — one constant for
	// every subject of that capture angle. Applied about the subject's own centre.
	const turns = (((Math.round(opts.yawTurns ?? 0) % 4) + 4) % 4)
	if (turns) {
		const yaw = new THREE.Quaternion().setFromAxisAngle(UP, (turns * Math.PI) / 2)
		const pivot = new THREE.Vector3(targetCenterX, posY, targetCenterZ)
		source.quaternion.copy(yaw)
		source.position.sub(pivot).applyQuaternion(yaw).add(pivot)
	}

	// The seated content AABB in plot-local space, for the "Bounds" debug overlay. A
	// 90°/270° turn swaps the X/Z extents.
	const halfX = (turns % 2 ? scale * spanZ : scale * spanX) / 2
	const halfZ = (turns % 2 ? scale * spanX : scale * spanZ) / 2
	source.userData.contentBox = new THREE.Box3(
		new THREE.Vector3(targetCenterX - halfX, box.min.y, targetCenterZ - halfZ),
		new THREE.Vector3(targetCenterX + halfX, box.min.y + scale * spanY, targetCenterZ + halfZ),
	)
	return source
}
