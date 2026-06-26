import * as THREE from "three"

// Object grouping + sizing for modular world generation.
//
// Blocks are snapped face-to-face, so a cluster of touching primitives is one
// logical object (a whole house = walls + roof + door, all touching). We recover
// those groups at generation time as connected components of the primitives whose
// (slightly expanded) axis-aligned boxes overlap. The ground is NOT in this graph —
// it is generated separately as the floor — so objects that merely rest on the
// ground stay distinct from each other.

const TOUCH_EPS = 0.06 // world units of slack so snapped-face neighbours read as touching

const _corner = new THREE.Vector3()

// AABB of a single primitive in world/plot-local space. The world group sits at the
// origin with no transform, so the two frames coincide. Computed from the geometry's
// bounding box (not setFromObject) so selection-outline children never inflate it.
export function primitiveBox(mesh, target = new THREE.Box3()) {
	if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
	const bb = mesh.geometry.boundingBox
	mesh.updateMatrixWorld(true)
	target.makeEmpty()
	for (let i = 0; i < 8; i++) {
		_corner.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z)
		_corner.applyMatrix4(mesh.matrixWorld)
		target.expandByPoint(_corner)
	}
	return target
}

// Group primitives into objects by touching-box connectivity (union-find). Each
// object carries its source meshes, the union AABB of its colliders (the target the
// splat is fitted into), and its total solid volume (drives the Tripo step budget).
export function computeObjects(primitives) {
	const n = primitives.length
	if (!n) return []
	const boxes = primitives.map(p => primitiveBox(p))
	const expanded = boxes.map(b => b.clone().expandByScalar(TOUCH_EPS))

	const parent = [...Array(n).keys()]
	const find = i => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]]
			i = parent[i]
		}
		return i
	}
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			if (expanded[i].intersectsBox(expanded[j])) parent[find(i)] = find(j)
		}
	}

	const groups = new Map()
	for (let i = 0; i < n; i++) {
		const root = find(i)
		if (!groups.has(root)) groups.set(root, [])
		groups.get(root).push(i)
	}

	return [...groups.values()].map(idxs => {
		const box = new THREE.Box3()
		let volume = 0
		for (const i of idxs) {
			box.union(boxes[i])
			volume += primitiveVolume(primitives[i])
		}
		return { primitives: idxs.map(i => primitives[i]), box, volume }
	})
}

// Solid volume of a primitive from its type + per-axis scale. Mirrors the default
// geometries in primitives.js (box 1³, sphere r0.5, cylinder r0.5/h1, cone r0.5/h1),
// each scaled by the mesh's scale vector.
export function primitiveVolume(mesh) {
	const sx = Math.abs(mesh.scale.x)
	const sy = Math.abs(mesh.scale.y)
	const sz = Math.abs(mesh.scale.z)
	switch (mesh.userData.type) {
		case "sphere":
			return (4 / 3) * Math.PI * (sx / 2) * (sy / 2) * (sz / 2)
		case "cylinder":
			return Math.PI * (sx / 2) * (sz / 2) * sy
		case "cone":
			return (1 / 3) * Math.PI * (sx / 2) * (sz / 2) * sy
		default:
			return sx * sy * sz
	}
}

// Map an object's volume to a TripoSplat step budget. Cheap for tiny props (a field
// of pebbles costs almost nothing), generous for big structures. Scaled on the
// cube-root (linear size) so a handful of unit blocks doesn't blow the budget.
const STEP_MIN = 5 // floor on diffusion steps even for the tiniest prop
const STEP_MAX = 24
const SIZE_MIN = 0.7 // ~a single small primitive
const SIZE_MAX = 6 // ~a large multi-block structure

export function stepsForVolume(volume) {
	const size = Math.cbrt(Math.max(1e-3, volume))
	const t = Math.min(1, Math.max(0, (size - SIZE_MIN) / (SIZE_MAX - SIZE_MIN)))
	return Math.round(STEP_MIN + (STEP_MAX - STEP_MIN) * t)
}
