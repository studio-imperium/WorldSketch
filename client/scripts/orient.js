import * as THREE from "three"

// Tripo single-image reconstruction is spatially consistent but lands at an
// arbitrary axis-aligned orientation: one of the 8 elements of the dihedral group
// D4 (4 yaws x optional handedness flip). The block-out primitives are the known-
// correct orientation, so recovering the splat's pose is a "pick 1 of 8" problem,
// not a regression. This module scores the 8 candidates against the colliders
// (height-map + colour) and, when present, against two corner fiducials baked into
// the capture, then exposes the apply transforms (centres + gaussian quaternions).

const UP = new THREE.Vector3(0, 1, 0)

// Two corner fiducials added to the capture (see capture.js). Distinct, saturated
// hues unlikely to occur naturally, at two ADJACENT corners so their labelled
// positions encode the full D4 (which corner = yaw, which colour-order = handedness).
export const ORIENT_MARKERS = [
	{ key: "a", hex: 0xff00ff, rgb: [1, 0, 1], corner: [1, 1] }, // magenta, +X +Z
	{ key: "b", hex: 0x00ffff, rgb: [0, 1, 1], corner: [1, -1] }, // cyan,    +X -Z
]
export const MARKER_INSET = 0.78 // marker centres sit at this fraction of the half-plot
const MARKER_CULL_RADIUS = 0.2 // normalised radius culled around a detected marker (clears its halo)

// The 8 axis-aligned orientations. Each maps splat coords -> plot-local: rotate
// about the vertical axis by yawDeg, THEN optionally mirror X (negate x). mirror +
// the 4 yaws generate all 8 reflections, so this enumerates D4 exactly once.
export const D4 = []
for (const mirror of [false, true]) {
	for (const yawDeg of [0, 90, 180, 270]) D4.push({ yawDeg, mirror })
}

function rotY2(x, z, yawDeg) {
	// Rotation about +Y by yawDeg (right-handed: x right, z toward viewer).
	switch (yawDeg) {
		case 90:
			return [z, -x]
		case 180:
			return [-x, -z]
		case 270:
			return [-z, x]
		default:
			return [x, z]
	}
}

// Apply a D4 element to a 2D (x,z) point: rotate, then mirror-x.
export function orient2D(o, x, z) {
	let [rx, rz] = rotY2(x, z, o.yawDeg)
	if (o.mirror) rx = -rx
	return [rx, rz]
}

export function isIdentity(o) {
	return o.yawDeg === 0 && !o.mirror
}

// Apply a D4 element to a gaussian centre in place (THREE.Vector3-like; y unchanged).
export function orientCenter(o, c) {
	let [rx, rz] = rotY2(c.x, c.z, o.yawDeg)
	if (o.mirror) rx = -rx
	c.x = rx
	c.z = rz
}

const _yawQuat = new THREE.Quaternion()

// Apply a D4 element to a gaussian rotation quaternion in place: rotate by the yaw
// (q' = qYaw . q), then for the mirror reflect across the X-plane via the
// pseudovector rule (negate y,z) so the ellipsoid stays correct under the flip.
export function orientQuaternion(o, q) {
	if (o.yawDeg) {
		_yawQuat.setFromAxisAngle(UP, (o.yawDeg * Math.PI) / 180)
		q.premultiply(_yawQuat)
	}
	if (o.mirror) {
		q.y = -q.y
		q.z = -q.z
	}
	return q
}

// Rotate the working xs/zs arrays in place so the measurement/fit stages downstream
// operate on the oriented cloud (kept in lockstep with the packed write).
export function orientArrays(o, xs, zs, total) {
	if (isIdentity(o)) return
	for (let i = 0; i < total; i++) {
		let [rx, rz] = rotY2(xs[i], zs[i], o.yawDeg)
		if (o.mirror) rx = -rx
		xs[i] = rx
		zs[i] = rz
	}
}

const GRID = 16 // scoring resolution per axis

// Rasterise the non-ground primitives into a plot-local [-1,1] reference grid:
// per cell, the tallest primitive top-Y and its colour. Returns null if the plot
// has no objects to align against (empty plot -> nothing to resolve).
function buildReference(plot) {
	const half = plot.size / 2
	const height = new Float32Array(GRID * GRID)
	const r = new Float32Array(GRID * GRID)
	const g = new Float32Array(GRID * GRID)
	const b = new Float32Array(GRID * GRID)
	const mask = new Uint8Array(GRID * GRID)
	const corner = new THREE.Vector3()
	let objects = 0

	for (const prim of plot.primitives) {
		if (!prim.geometry) continue
		prim.updateMatrix()
		if (!prim.geometry.boundingBox) prim.geometry.computeBoundingBox()
		const bb = prim.geometry.boundingBox
		let minX = Infinity
		let maxX = -Infinity
		let minZ = Infinity
		let maxZ = -Infinity
		let topY = -Infinity
		for (let cx = 0; cx < 2; cx++) {
			for (let cy = 0; cy < 2; cy++) {
				for (let cz = 0; cz < 2; cz++) {
					corner.set(cx ? bb.max.x : bb.min.x, cy ? bb.max.y : bb.min.y, cz ? bb.max.z : bb.min.z)
					corner.applyMatrix4(prim.matrix) // mesh-local -> plot-local
					minX = Math.min(minX, corner.x)
					maxX = Math.max(maxX, corner.x)
					minZ = Math.min(minZ, corner.z)
					maxZ = Math.max(maxZ, corner.z)
					topY = Math.max(topY, corner.y)
				}
			}
		}
		objects++
		const col = Array.isArray(prim.material) ? prim.material[0]?.color : prim.material?.color
		const cr = col?.r ?? 0.5
		const cg = col?.g ?? 0.5
		const cb = col?.b ?? 0.5
		const i0 = Math.max(0, Math.floor(((minX / half + 1) / 2) * GRID))
		const i1 = Math.min(GRID - 1, Math.floor(((maxX / half + 1) / 2) * GRID))
		const j0 = Math.max(0, Math.floor(((minZ / half + 1) / 2) * GRID))
		const j1 = Math.min(GRID - 1, Math.floor(((maxZ / half + 1) / 2) * GRID))
		for (let j = j0; j <= j1; j++) {
			for (let i = i0; i <= i1; i++) {
				const c = j * GRID + i
				if (topY > height[c]) {
					height[c] = topY
					r[c] = cr
					g[c] = cg
					b[c] = cb
				}
				mask[c] = 1
			}
		}
	}
	if (!objects) return null
	return { height, r, g, b, mask }
}

function cell(nx, nz) {
	const i = Math.min(GRID - 1, Math.max(0, Math.floor(((nx + 1) / 2) * GRID)))
	const j = Math.min(GRID - 1, Math.max(0, Math.floor(((nz + 1) / 2) * GRID)))
	return j * GRID + i
}

// Cosine similarity between two grids (rewards matching bump/colour locations,
// scale-invariant). Both are non-negative so the score sits in [0,1].
function cosine(a, bb) {
	let dot = 0
	let na = 0
	let nb = 0
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * bb[i]
		na += a[i] * a[i]
		nb += bb[i] * bb[i]
	}
	if (na < 1e-9 || nb < 1e-9) return 0
	return dot / Math.sqrt(na * nb)
}

// Detect a marker colour cluster among the kept gaussians; return its normalised
// (nx,nz) centroid + per-gaussian membership, or null if too few hits.
function findMarker(rgb, kept, nx, nz, rs, gs, bs) {
	let sx = 0
	let sz = 0
	let count = 0
	const member = new Uint8Array(kept.length)
	for (let k = 0; k < kept.length; k++) {
		const i = kept[k]
		if (Math.abs(rs[i] - rgb[0]) > 0.3) continue
		if (Math.abs(gs[i] - rgb[1]) > 0.3) continue
		if (Math.abs(bs[i] - rgb[2]) > 0.3) continue
		member[k] = 1
		sx += nx[k]
		sz += nz[k]
		count++
	}
	if (count < 8) return null
	return { x: sx / count, z: sz / count, member, count }
}

// Resolve the splat's orientation. Inputs are the post-cull working arrays + the
// kept index list, the stored-space ground level (world-up = lower stored-Y), the
// plot (for its colliders), and flags. Returns the chosen D4 element, how it was
// chosen, an optional marker-cull mask (gaussians to drop), and the raw scores.
export function resolveOrientation({ xs, ys, zs, rs, gs, bs, kept, groundY, plot, markers, debug }) {
	const identity = { yawDeg: 0, mirror: false }
	if (!kept.length) return { orient: identity, source: "empty", markerCull: null, scores: null }

	// Normalise kept gaussians to a plot-centred [-1,1] frame (XZ) + a height proxy
	// (positive = above the ground; world-up is decreasing stored-Y).
	let minX = Infinity
	let maxX = -Infinity
	let minZ = Infinity
	let maxZ = -Infinity
	for (const i of kept) {
		if (xs[i] < minX) minX = xs[i]
		if (xs[i] > maxX) maxX = xs[i]
		if (zs[i] < minZ) minZ = zs[i]
		if (zs[i] > maxZ) maxZ = zs[i]
	}
	const cX = (minX + maxX) / 2
	const cZ = (minZ + maxZ) / 2
	const half = Math.max(1e-3, (maxX - minX) / 2, (maxZ - minZ) / 2)
	const nx = new Float32Array(kept.length)
	const nz = new Float32Array(kept.length)
	const h = new Float32Array(kept.length)
	for (let k = 0; k < kept.length; k++) {
		const i = kept[k]
		nx[k] = (xs[i] - cX) / half
		nz[k] = (zs[i] - cZ) / half
		h[k] = Math.max(0, groundY - ys[i])
	}

	// --- Marker resolution (preferred when fiducials survived) ---
	let markerCull = null
	if (markers) {
		const ma = findMarker(ORIENT_MARKERS[0].rgb, kept, nx, nz, rs, gs, bs)
		const mb = findMarker(ORIENT_MARKERS[1].rgb, kept, nx, nz, rs, gs, bs)
		if (ma || mb) {
			// Cull a spatial NEIGHBOURHOOD around each detected centroid, not just the
			// exact-colour hits: Tripo reconstructs the marker with a desaturated halo
			// that fails the colour gate but still renders. Radius is in normalised
			// units (the marker cube is ~0.07 of the half-plot; 0.2 clears its fringe).
			const r2 = MARKER_CULL_RADIUS * MARKER_CULL_RADIUS
			markerCull = new Uint8Array(xs.length)
			for (let k = 0; k < kept.length; k++) {
				for (const m of [ma, mb]) {
					if (!m) continue
					const dx = nx[k] - m.x
					const dz = nz[k] - m.z
					if (m.member[k] || dx * dx + dz * dz < r2) {
						markerCull[kept[k]] = 1
						break
					}
				}
			}
		}
		if (ma && mb) {
			const refA = ORIENT_MARKERS[0].corner
			const refB = ORIENT_MARKERS[1].corner
			let best = identity
			let bestErr = Infinity
			const scores = []
			for (const o of D4) {
				const [ax, az] = orient2D(o, ma.x, ma.z)
				const [bx, bz] = orient2D(o, mb.x, mb.z)
				const err = Math.hypot(ax - refA[0], az - refA[1]) + Math.hypot(bx - refB[0], bz - refB[1])
				scores.push({ yawDeg: o.yawDeg, mirror: o.mirror, err: +err.toFixed(3) })
				if (err < bestErr) {
					bestErr = err
					best = o
				}
			}
			return { orient: best, source: "marker", markerCull, scores: debug ? scores : null }
		}
	}

	// --- Collider scoring fallback (height-map + colour) ---
	const ref = buildReference(plot)
	if (!ref) return { orient: identity, source: markerCull ? "marker-partial" : "none", markerCull, scores: null }

	let best = identity
	let bestScore = -Infinity
	const scores = []
	const sh = new Float32Array(GRID * GRID)
	const sr = new Float32Array(GRID * GRID)
	const sg = new Float32Array(GRID * GRID)
	const sb = new Float32Array(GRID * GRID)
	const sc = new Float32Array(GRID * GRID)
	for (const o of D4) {
		sh.fill(0)
		sr.fill(0)
		sg.fill(0)
		sb.fill(0)
		sc.fill(0)
		for (let k = 0; k < kept.length; k++) {
			const [ox, oz] = orient2D(o, nx[k], nz[k])
			const c = cell(ox, oz)
			if (h[k] > sh[c]) sh[c] = h[k]
			const i = kept[k]
			sr[c] += rs[i]
			sg[c] += gs[i]
			sb[c] += bs[i]
			sc[c] += 1
		}
		const heightScore = cosine(sh, ref.height)
		let colorAcc = 0
		let colorCells = 0
		for (let c = 0; c < ref.mask.length; c++) {
			if (!ref.mask[c] || sc[c] === 0) continue
			const dr = Math.abs(sr[c] / sc[c] - ref.r[c])
			const dg = Math.abs(sg[c] / sc[c] - ref.g[c])
			const db = Math.abs(sb[c] / sc[c] - ref.b[c])
			colorAcc += 1 - (dr + dg + db) / 3
			colorCells++
		}
		const colorScore = colorCells ? colorAcc / colorCells : 0
		const total = heightScore + 0.5 * colorScore
		scores.push({
			yawDeg: o.yawDeg,
			mirror: o.mirror,
			height: +heightScore.toFixed(3),
			color: +colorScore.toFixed(3),
			total: +total.toFixed(3),
		})
		if (total > bestScore) {
			bestScore = total
			best = o
		}
	}
	return { orient: best, source: "score", markerCull, scores: debug ? scores : null }
}
