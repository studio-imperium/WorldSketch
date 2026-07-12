import * as THREE from "three"

// Object grouping + sizing for modular world generation.
//
// A cluster of connected primitives is one logical object (a whole house = walls +
// roof + door), where "connected" is general: face-snapped, touching, OR overlapping. We recover
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
// object carries its source meshes and the union AABB of its colliders (the target
// the splat is fitted into). Shape count (primitives.length) drives the step budget.
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
		for (const i of idxs) box.union(boxes[i])
		return { primitives: idxs.map(i => primitives[i]), box }
	})
}

