import * as THREE from "three"

const colors = {
	box: "#9b9b9b",
	sphere: "#8b8175",
	cylinder: "#7d684d",
	cone: "#8e826a",
}

export function createPrimitive(type, id, seed = {}) {
	const material = new THREE.MeshStandardMaterial({
		color: seed.color ?? colors[type],
		roughness: 0.86,
		metalness: 0,
	})
	const mesh = new THREE.Mesh(geometryFor(type), material)
	mesh.userData = { id, type, locked: Boolean(seed.locked) }
	mesh.position.fromArray(seed.position ?? [0, 0.5, 0])
	mesh.rotation.fromArray(seed.rotation ?? [0, 0, 0])
	mesh.scale.fromArray(seed.scale ?? defaultScale(type))
	return mesh
}

export function createSelectionOutline(mesh, color = 0xb8ff38) {
	const outline = new THREE.Mesh(
		mesh.geometry.clone(),
		new THREE.MeshBasicMaterial({
			color,
			side: THREE.BackSide,
			depthTest: true,
			depthWrite: false,
		}),
	)
	outline.name = "selection_outline"
	outline.userData.isSelectionOutline = true
	outline.scale.setScalar(1.045)
	mesh.add(outline)
	return outline
}

export function createEdgeOutline(mesh, color = 0xffffff) {
	const geometry = new THREE.EdgesGeometry(mesh.geometry)
	const material = new THREE.LineBasicMaterial({ color, depthTest: true, depthWrite: false })
	const outline = new THREE.LineSegments(geometry, material)
	outline.name = "selection_outline"
	outline.userData.isSelectionOutline = true
	outline.renderOrder = 2
	mesh.add(outline)
	return outline
}

export function clearSelectionOutline(mesh) {
	const outline = mesh?.children.find(child => child.userData.isSelectionOutline)
	if (outline) disposeObject(outline)
}

export function disposeObject(object) {
	object.traverse(child => {
		if (child.geometry) child.geometry.dispose()
		if (child.material) {
			const materials = Array.isArray(child.material) ? child.material : [child.material]
			for (const material of materials) material.dispose()
		}
	})
	object.removeFromParent()
}

function geometryFor(type) {
	if (type === "sphere") return new THREE.SphereGeometry(0.5, 32, 16)
	if (type === "cylinder") return new THREE.CylinderGeometry(0.5, 0.5, 1, 32)
	if (type === "cone") return new THREE.ConeGeometry(0.5, 1, 32)
	return new THREE.BoxGeometry(1, 1, 1)
}

function defaultScale(type) {
	if (type === "cylinder") return [1, 2, 1]
	return [1, 1, 1]
}
