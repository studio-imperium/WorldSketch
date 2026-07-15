import * as THREE from "three"

// Seat a freshly-reconstructed Tripo splat into its target box.
//
// Each subject is captured ALONE on a black background from a fixed pose, so Tripo's
// output lands in a consistent orientation — the same property the old whole-plot
// pipeline relied on. We therefore NEVER rotate the splat (we have no reliable way to
// know a gaussian cloud's "correct" yaw). We only:
//   1. gently cull the transparent haze + stray floaters Tripo leaves behind,
//   2. measure the robust content AABB (percentile extents, ignoring outliers),
//   3. fit the content onto the target box and seat its bottom on it.
//
// The stored model is upside-down (world-up = decreasing stored-Y), so the Y scale is
// negated (the proven flip) and the subject's BOTTOM is its MAX stored-Y.

const UP = new THREE.Vector3(0, 1, 0)

const IDENTITY_QUAT = new THREE.Quaternion()

function matrix3FromMatrix4(m) {
	const e = m.elements
	return [
		e[0], e[4], e[8],
		e[1], e[5], e[9],
		e[2], e[6], e[10],
	]
}

function covarianceFromSplat(scales, quaternion) {
	const m = new THREE.Matrix4().makeRotationFromQuaternion(quaternion)
	const e = m.elements
	const axes = [
		[e[0], e[1], e[2]],
		[e[4], e[5], e[6]],
		[e[8], e[9], e[10]],
	]
	const s2 = [scales.x * scales.x, scales.y * scales.y, scales.z * scales.z]
	const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0]
	for (let k = 0; k < 3; k++) {
		for (let r = 0; r < 3; r++) {
			for (let c = 0; c < 3; c++) cov[r * 3 + c] += axes[k][r] * axes[k][c] * s2[k]
		}
	}
	return cov
}

function transformCovariance(a, cov) {
	const ac = new Array(9).fill(0)
	const out = new Array(9).fill(0)
	for (let r = 0; r < 3; r++) {
		for (let c = 0; c < 3; c++) {
			for (let k = 0; k < 3; k++) ac[r * 3 + c] += a[r * 3 + k] * cov[k * 3 + c]
		}
	}
	for (let r = 0; r < 3; r++) {
		for (let c = 0; c < 3; c++) {
			for (let k = 0; k < 3; k++) out[r * 3 + c] += ac[r * 3 + k] * a[c * 3 + k]
		}
	}
	return out
}

function determinantColumns(x, y, z) {
	return x.x * (y.y * z.z - y.z * z.y) - y.x * (x.y * z.z - x.z * z.y) + z.x * (x.y * y.z - x.z * y.y)
}

function eigensystemSymmetric3(input) {
	const a = input.slice()
	const v = [1, 0, 0, 0, 1, 0, 0, 0, 1]
	const pairs = [[0, 1, 1], [0, 2, 2], [1, 2, 5]]
	for (let iter = 0; iter < 32; iter++) {
		let p = 0, q = 1, idx = 1, best = 0
		for (const pair of pairs) {
			const mag = Math.abs(a[pair[2]])
			if (mag > best) { [p, q, idx] = pair; best = mag }
		}
		if (best < 1e-14) break

		const app = a[p * 3 + p], aqq = a[q * 3 + q], apq = a[idx]
		const angle = 0.5 * Math.atan2(2 * apq, aqq - app)
		const c = Math.cos(angle), s = Math.sin(angle)

		for (let k = 0; k < 3; k++) {
			if (k === p || k === q) continue
			const akp = a[k * 3 + p], akq = a[k * 3 + q]
			const np = c * akp - s * akq
			const nq = s * akp + c * akq
			a[k * 3 + p] = a[p * 3 + k] = np
			a[k * 3 + q] = a[q * 3 + k] = nq
		}
		a[p * 3 + p] = c * c * app - 2 * s * c * apq + s * s * aqq
		a[q * 3 + q] = s * s * app + 2 * s * c * apq + c * c * aqq
		a[p * 3 + q] = a[q * 3 + p] = 0

		for (let k = 0; k < 3; k++) {
			const vkp = v[k * 3 + p], vkq = v[k * 3 + q]
			v[k * 3 + p] = c * vkp - s * vkq
			v[k * 3 + q] = s * vkp + c * vkq
		}
	}

	const axes = [
		{ value: Math.max(0, a[0]), axis: new THREE.Vector3(v[0], v[3], v[6]).normalize() },
		{ value: Math.max(0, a[4]), axis: new THREE.Vector3(v[1], v[4], v[7]).normalize() },
		{ value: Math.max(0, a[8]), axis: new THREE.Vector3(v[2], v[5], v[8]).normalize() },
	].sort((l, r) => r.value - l.value)

	if (determinantColumns(axes[0].axis, axes[1].axis, axes[2].axis) < 0) axes[2].axis.multiplyScalar(-1)

	const matrix = new THREE.Matrix4().makeBasis(axes[0].axis, axes[1].axis, axes[2].axis)
	return {
		scales: new THREE.Vector3(Math.sqrt(axes[0].value), Math.sqrt(axes[1].value), Math.sqrt(axes[2].value)),
		quaternion: new THREE.Quaternion().setFromRotationMatrix(matrix).normalize(),
	}
}

function transformSplatShape(scales, quaternion, linear) {
	return eigensystemSymmetric3(transformCovariance(linear, covarianceFromSplat(scales, quaternion)))
}

function percentile(sorted, q) {
	if (!sorted.length) return 0
	const pos = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
	return sorted[pos]
}

export function ensureSplatEditBase(mesh) {
	const packed = mesh.packedSplats
	const total = packed?.numSplats ?? 0
	const existing = mesh.userData.editBase
	if (!total) return null
	if (existing?.numSplats === total) return existing
	const centers = new Float32Array(total * 3)
	const scales = new Float32Array(total * 3)
	const quaternions = new Float32Array(total * 4)
	const opacities = new Float32Array(total)
	const colors = new Float32Array(total * 3)
	packed.forEachSplat((i, center, scale, quaternion, opacity, color) => {
		centers[i * 3] = center.x
		centers[i * 3 + 1] = center.y
		centers[i * 3 + 2] = center.z
		scales[i * 3] = scale.x
		scales[i * 3 + 1] = scale.y
		scales[i * 3 + 2] = scale.z
		quaternions[i * 4] = quaternion.x
		quaternions[i * 4 + 1] = quaternion.y
		quaternions[i * 4 + 2] = quaternion.z
		quaternions[i * 4 + 3] = quaternion.w
		opacities[i] = opacity
		colors[i * 3] = color.r
		colors[i * 3 + 1] = color.g
		colors[i * 3 + 2] = color.b
	})
	mesh.userData.editBase = { numSplats: total, centers, scales, quaternions, opacities, colors }
	return mesh.userData.editBase
}

export function applySplatEditTransform(mesh, matrix) {
	const packed = mesh.packedSplats
	const base = ensureSplatEditBase(mesh)
	if (!packed?.numSplats || !base) return
	const linear = matrix3FromMatrix4(matrix)
	const center = new THREE.Vector3()
	const scales = new THREE.Vector3()
	const quaternion = new THREE.Quaternion()
	const color = new THREE.Color()
	for (let i = 0; i < base.numSplats; i++) {
		center.set(base.centers[i * 3], base.centers[i * 3 + 1], base.centers[i * 3 + 2]).applyMatrix4(matrix)
		scales.set(base.scales[i * 3], base.scales[i * 3 + 1], base.scales[i * 3 + 2])
		quaternion.set(base.quaternions[i * 4], base.quaternions[i * 4 + 1], base.quaternions[i * 4 + 2], base.quaternions[i * 4 + 3])
		const transformed = transformSplatShape(scales, quaternion, linear)
		color.setRGB(base.colors[i * 3], base.colors[i * 3 + 1], base.colors[i * 3 + 2])
		packed.setSplat(i, center, transformed.scales, transformed.quaternion, base.opacities[i], color)
	}
	packed.numSplats = base.numSplats
	packed.needsUpdate = true
	mesh.position.set(0, 0, 0)
	mesh.quaternion.identity()
	mesh.scale.set(1, 1, 1)
}

export async function fitSplatToBox(source, box, opts = {}) {
	const opacityFloor = opts.opacityFloor ?? 0.03 // drop only near-transparent haze/wisp gaussians (WS_OPACITY_FLOOR)
	const radiusKeep = opts.radiusKeep ?? 1 // optional floater trim; 1 keeps every opacity survivor
	const loQ = opts.spanLo ?? 0 // robust extent percentiles, so a few strays
	const hiQ = opts.spanHi ?? 1 // can't blow up the measured size
	const cullAmount = Math.min(1, Math.max(0, opts.cullAmount ?? 1))
	const cullHeightFraction = Math.min(1, Math.max(0, opts.cullHeightFraction ?? 1))

	const exactBounds = Boolean(opts.exactBounds)
	const clipBoxes = Array.isArray(opts.clipBoxes) ? opts.clipBoxes : null

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
	const opacityKeep = Uint8Array.from(keep)

	// Median center (robust) of the survivors, then drop the farthest few as floaters.
	// 3D distance so stray gaussians above/below the object are caught as well as lateral ones.
	const survivorsX = []
	const survivorsY = []
	const survivorsZ = []
	for (let i = 0; i < total; i++) {
		if (!keep[i]) continue
		survivorsX.push(xs[i])
		survivorsY.push(ys[i])
		survivorsZ.push(zs[i])
	}
	// Keep fitting robust even when every gaussian is below the opacity threshold. The
	// threshold is a cull candidate detector; the global amount slider owns removal.
	if (!survivorsX.length) {
		for (let i = 0; i < total; i++) {
			keep[i] = 1
			survivorsX.push(xs[i])
			survivorsY.push(ys[i])
			survivorsZ.push(zs[i])
		}
	}
	const medianX = percentile(survivorsX.slice().sort((a, b) => a - b), 0.5)
	const medianY = percentile(survivorsY.slice().sort((a, b) => a - b), 0.5)
	const medianZ = percentile(survivorsZ.slice().sort((a, b) => a - b), 0.5)
	if (radiusKeep < 1) {
		const dists = []
		for (let i = 0; i < total; i++) if (keep[i]) dists.push(Math.hypot(xs[i] - medianX, ys[i] - medianY, zs[i] - medianZ))
		const cut = percentile(dists.sort((a, b) => a - b), radiusKeep)
		for (let i = 0; i < total; i++) if (keep[i] && Math.hypot(xs[i] - medianX, ys[i] - medianY, zs[i] - medianZ) > cut) keep[i] = 0
	}
	const renderKeep = new Uint8Array(total)
	for (let i = 0; i < total; i++) renderKeep[i] = opacityKeep[i] && keep[i] ? 1 : 0

	// For bounding-box measurement only: bin kept gaussians into a coarse 3D grid
	// and exclude cells below `sparseDensityMin`.  Isolated floaters that survive
	// the opacity/radius culls can't inflate the box, but the `keep[]` array (and
	// therefore the rendered gaussian set) is NOT touched.
	const sparseGridK = opts.sparseGridK ?? 0.15        // cell size as fraction of max span
	const sparseDensityMin = opts.sparseDensityMin ?? 1 // min gaussians per cell; 1 disables sparse bbox culling
	const bboxKeep = new Uint8Array(total)
	{
		let rawMinX = Infinity, rawMaxX = -Infinity
		let rawMinY = Infinity, rawMaxY = -Infinity
		let rawMinZ = Infinity, rawMaxZ = -Infinity
		for (let i = 0; i < total; i++) {
			if (!keep[i]) continue
			if (xs[i] < rawMinX) rawMinX = xs[i]
			if (xs[i] > rawMaxX) rawMaxX = xs[i]
			if (ys[i] < rawMinY) rawMinY = ys[i]
			if (ys[i] > rawMaxY) rawMaxY = ys[i]
			if (zs[i] < rawMinZ) rawMinZ = zs[i]
			if (zs[i] > rawMaxZ) rawMaxZ = zs[i]
		}
		const rawSpan = Math.max(rawMaxX - rawMinX, rawMaxY - rawMinY, rawMaxZ - rawMinZ, 1e-4)
		const cellSize = rawSpan * sparseGridK
		const cellCounts = new Map()
		for (let i = 0; i < total; i++) {
			if (!keep[i]) continue
			const k = `${Math.floor(xs[i] / cellSize)},${Math.floor(ys[i] / cellSize)},${Math.floor(zs[i] / cellSize)}`
			cellCounts.set(k, (cellCounts.get(k) ?? 0) + 1)
		}
		let n = 0
		for (let i = 0; i < total; i++) {
			if (!keep[i]) continue
			const k = `${Math.floor(xs[i] / cellSize)},${Math.floor(ys[i] / cellSize)},${Math.floor(zs[i] / cellSize)}`
			if ((cellCounts.get(k) ?? 0) >= sparseDensityMin) { bboxKeep[i] = 1; n++ }
		}
		// Degenerate: sparse cull removed everything — fall back to the full display set.
		if (!n) for (let i = 0; i < total; i++) bboxKeep[i] = keep[i]
	}

	// Robust content extents from the bbox-culled gaussians.
	const keptX = []
	const keptY = []
	const keptZ = []
	for (let i = 0; i < total; i++) {
		if (!bboxKeep[i]) continue
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

	// Uniform scale = a WEIGHTED blend of the per-axis box-fits (target/span), so the subject
	// fills its collider as a compromise across axes without distorting Tripo's proportions
	// (it's still one scale — the clamped non-uniform mode below can relax this per-axis). For
	// objects (opts.fitHeight): height is weighted 0.5, X and Z 0.25 each — height drives the
	// fit, footprint just nudges it. The flat floor box omits Y (its tiny targetY/spanY would
	// crush the scale), so X/Z split 0.5 each.
	// Compute yaw quarter-step early: for a 90°/270° yaw the mesh's stored X axis maps to
	// world Z and vice versa, so the per-axis fits must be cross-assigned before scaling.
	const yawDeg = ((opts.yawTurns ?? 0) % 4) * 90 + (opts.yawDeg ?? 0)
	const quarter = Math.abs(Math.round(yawDeg / 90)) % 2

	const xFit = (box.max.x - box.min.x) / spanX
	const zFit = (box.max.z - box.min.z) / spanZ
	const yFit = (box.max.y - box.min.y) / spanY
	// After a 90°/270° yaw: stored-X fills world-Z (needs targetZ/spanX) and stored-Z fills
	// world-X (needs targetX/spanZ).  Swap the effective fits so sx/sz target the right axis.
	const effXFit = quarter ? (box.max.z - box.min.z) / spanX : xFit
	const effZFit = quarter ? (box.max.x - box.min.x) / spanZ : zFit
	const scale = opts.fitHeight ? 0.25 * effXFit + 0.25 * effZFit + 0.5 * yFit : 0.5 * (effXFit + effZFit)
	if (!Number.isFinite(scale) || scale <= 0) return null

	// Non-uniform fit blend (WS_FIT_CLAMP_K): lerp each axis between the uniform scale (k=0)
	// and its own exact box-fit (k=1). At k=1 every axis independently hits target/span, so
	// the seated contentBox matches the collider exactly regardless of proportions.
	// k=0 or fitHeight=false leaves sx=sy=sz=scale (the proven uniform fit).
	const clampK = opts.clampK ?? 0
	let sx = scale, sy = scale, sz = scale
	// Ground fill (multi-tile expansion): a flat tile (fitHeight=false) gets an EXACT
	// per-axis X/Z fit so ONE splat fills a rectangular footprint precisely. The uniform
	// 0.5*(xFit+zFit) blend would leave a gap on the long axis of a 2×1/3×1 ground; here
	// each axis hits its own target. Y (thickness) is the XZ average — the slab is thin so
	// it barely matters and the bottom still seats on box.min.y.
	if (opts.fillXZ && !opts.fitHeight) {
		sx = effXFit
		sz = effZFit
		sy = 0.5 * (effXFit + effZFit)
	}
	if (clampK > 0 && opts.fitHeight) {
		sx = scale + clampK * (effXFit - scale)
		sy = scale + clampK * (yFit - scale)
		sz = scale + clampK * (effZFit - scale)
	}
	if (exactBounds) {
		// Fill the tile to its border: overscale the X/Z fit slightly so the texture's
		// SOLID interior — not its ragged, fading reconstruction edge — reaches the tile
		// boundary. The overhang is culled against the clip boxes in the bake loop below
		// (scale up, trim the edges off), so the floor reads flush to the tile edge.
		const fillOverscale = Math.max(1, opts.fillOverscale ?? 1)
		sx = effXFit * fillOverscale
		sz = effZFit * fillOverscale
		// NO vertical compression for floors: Y keeps the reconstruction's natural
		// (XZ-proportional) scale. Vertical bounding is handled by seating the ground
		// SHEET at floor level and CULLING everything that lands below it (see the
		// bake loop) — underground gaussians could never be visible anyway.
		sy = 0.5 * (sx + sz)
	}

	// Floors seat the SHEET at floor level rather than the absolute lowest gaussian:
	// stored Y is world-inverted, so the ~15% of content with storedY above this
	// percentile is BELOW the sheet (underground reconstruction noise) and gets culled
	// after the transform.
	const seatStoredY = exactBounds ? percentile(keptY, 0.85) : bottomStoredY

	// Compact survivors to the front of the packed buffer, baking the final fit into each
	// gaussian center and ellipsoid.
	let kept = 0
	const targetCenterX = (box.min.x + box.max.x) / 2
	const targetCenterZ = (box.min.z + box.max.z) / 2
	const posY = box.min.y + sy * seatStoredY
	const yOffset = opts.yOffset ?? 0
	// How far surface relief may dip BELOW the seated sheet before it counts as
	// underground reconstruction noise (worn paths sit lower than the grass around them).
	const reliefDip = Math.max(0.05, opts.reliefDip ?? 0.35)
	const yaw = yawDeg ? new THREE.Quaternion().setFromAxisAngle(UP, (yawDeg * Math.PI) / 180) : IDENTITY_QUAT
	// Handedness correction: a reconstruction whose horizontal frame is MIRRORED relative
	// to the capture can never be seated by yaw alone — negate Z (before the yaw) to flip
	// it back. The covariance bake below uses the same linear map, so ellipsoids follow.
	const mirrorZ = opts.mirrorZ ? -1 : 1
	const transformMatrix = new THREE.Matrix4().compose(new THREE.Vector3(), yaw, new THREE.Vector3(sx, -sy, sz * mirrorZ))
	const linear = matrix3FromMatrix4(transformMatrix)
	const transformedOffset = new THREE.Vector3()
	const insideClip = point => !clipBoxes || clipBoxes.some(b => b.containsPoint(point))
	// Build robust bottom/top ranges from valid fitted material before deciding whether a
	// cleanup candidate is low or high. A whole-scene splat uses local XZ stacks so a short
	// rock does not inherit a lighthouse's height; single-object/floor fits use one range.
	const localHeightRanges = Boolean(opts.localCleanupHeight)
	const heightCellSize = Math.max(0.25, Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 64)
	const heightKey = (x, z) => `${Math.floor((x - box.min.x) / heightCellSize)},${Math.floor((z - box.min.z) / heightCellSize)}`
	const heightSamples = new Map()
	const allHeightSamples = []
	for (let i = 0; i < total; i++) {
		if (!renderKeep[i]) continue
		transformedOffset
			.set(sx * (xs[i] - centerX), -sy * ys[i], mirrorZ * sz * (zs[i] - centerZ))
			.applyQuaternion(yaw)
		const x = targetCenterX + transformedOffset.x
		const y = posY + yOffset + transformedOffset.y
		const z = targetCenterZ + transformedOffset.z
		allHeightSamples.push(y)
		if (!localHeightRanges) continue
		const key = heightKey(x, z)
		let samples = heightSamples.get(key)
		if (!samples) heightSamples.set(key, samples = [])
		samples.push(y)
	}
	const robustHeightRange = samples => {
		if (!samples?.length) return null
		samples.sort((a, b) => a - b)
		const low = samples[Math.floor((samples.length - 1) * 0.01)]
		const high = samples[Math.ceil((samples.length - 1) * 0.99)]
		return { low, high: Math.max(low, high) }
	}
	const globalHeightRange = robustHeightRange(allHeightSamples) ?? { low: box.min.y + yOffset, high: box.max.y + yOffset }
	const heightRanges = new Map()
	for (const [key, samples] of heightSamples) heightRanges.set(key, robustHeightRange(samples))
	const heightRangeAt = (x, z) => heightRanges.get(heightKey(x, z)) ?? globalHeightRange
	const cullHash = (x, y, z) => {
		const value = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123
		return value - Math.floor(value)
	}
	const mayCullAt = (x, y, z) => {
		if (cullAmount <= 0) return false
		if (cullHeightFraction < 1) {
			const range = localHeightRanges ? heightRangeAt(x, z) : globalHeightRange
			const height = Math.max(0.05, range.high - range.low)
			const basePad = Math.min(0.1, height * 0.03)
			if (y > range.low + height * cullHeightFraction + basePad) return false
		}
		return cullAmount >= 1 || cullHash(x, y, z) < cullAmount
	}

	packed.forEachSplat((i, center, scales, quaternion, opacity, color) => {
		transformedOffset
			.set(sx * (center.x - centerX), -sy * center.y, mirrorZ * sz * (center.z - centerZ))
			.applyQuaternion(yaw)
		const nextX = targetCenterX + transformedOffset.x
		const nextY = posY + yOffset + transformedOffset.y
		const nextZ = targetCenterZ + transformedOffset.z
		const mayCull = mayCullAt(nextX, nextY, nextZ)
		if (!renderKeep[i] && mayCull) return
		// Floors: anything below floor level is underground and can never be visible —
		// cull it outright. `reliefDip` leaves headroom for SHALLOW surface relief (worn
		// paths, ruts) that dips under the seated sheet without being underground junk.
		// Above floor level Y is FREE (no clamp, no compression).
		if (exactBounds && nextY < box.min.y + yOffset - reliefDip && mayCull) return
		// With clip boxes the fill-overscale overhang is CULLED (insideClip below), keeping
		// interior gaussians at their true positions; clamping is only the fallback when
		// there is nothing to cull against (edge strays pile onto the border instead).
		const clampXZ = exactBounds && !clipBoxes
		center.set(
			clampXZ ? Math.min(box.max.x, Math.max(box.min.x, nextX)) : nextX,
			nextY,
			clampXZ ? Math.min(box.max.z, Math.max(box.min.z, nextZ)) : nextZ,
		)
		if (!insideClip(center) && mayCull) return
		const transformedShape = transformSplatShape(scales, quaternion, linear)
		packed.setSplat(kept, center, transformedShape.scales, transformedShape.quaternion, opacity, color)
		kept++
	})
	if (!kept) return null
	packed.numSplats = kept
	packed.needsUpdate = true

	// Spark 2.x collapses a SplatMesh object's scale to a single averaged value before
	// rendering. With the required Y mirror and non-uniform fits, that average can cancel
	// toward zero (wide houses became dots). The fitted affine is therefore baked above into
	// every gaussian center and covariance, leaving the Spark object transform as identity.
	source.position.set(0, 0, 0)
	source.quaternion.identity()
	source.scale.set(1, 1, 1)
	console.log(`[fit] ${source.name || "?"}  target=(${(box.max.x-box.min.x).toFixed(3)}×${(box.max.y-box.min.y).toFixed(3)}×${(box.max.z-box.min.z).toFixed(3)})  span=(${spanX.toFixed(3)}×${spanY.toFixed(3)}×${spanZ.toFixed(3)})  bakedScale=(${sx.toFixed(3)},${(-sy).toFixed(3)},${sz.toFixed(3)})  keep=${kept}`)

	// The seated content AABB in plot-local space, for the "Bounds" debug overlay. A yaw near
	// 90°/270° swaps the X/Z extents (approximate for off-axis yawDeg — it's a debug box).
	const halfX = (quarter ? sz * spanZ : sx * spanX) / 2
	const halfZ = (quarter ? sx * spanX : sz * spanZ) / 2
	const floorY = box.min.y + yOffset
	source.userData.contentBox = exactBounds
		? new THREE.Box3(
			new THREE.Vector3(box.min.x, floorY, box.min.z),
			new THREE.Vector3(box.max.x, box.max.y + yOffset, box.max.z),
		)
		: new THREE.Box3(
			new THREE.Vector3(targetCenterX - halfX, floorY, targetCenterZ - halfZ),
			new THREE.Vector3(targetCenterX + halfX, floorY + sy * spanY, targetCenterZ + halfZ),
		)
	return source
}
