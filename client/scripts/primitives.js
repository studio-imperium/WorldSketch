import * as THREE from "three"

const colors = {
	box: "#9b9b9b",
	sphere: "#8b8175",
	cylinder: "#7d684d",
	cone: "#8e826a",
}

export function createPrimitive(type, id, seed) {
	const material = new THREE.MeshStandardMaterial({
		color: seed?.color ?? colors[type],
		roughness: 0.86,
		metalness: 0,
	})
	const mesh = new THREE.Mesh(geometryFor(type), material)
	mesh.userData = { id, type, locked: Boolean(seed?.locked) }
	mesh.position.fromArray(seed?.position ?? [0, 0.5, 0])
	mesh.rotation.fromArray(seed?.rotation ?? [0, 0, 0])
	mesh.scale.fromArray(seed?.scale ?? defaultScale(type))
	return mesh
}

export function serializePrimitive(mesh) {
	return {
		id: mesh.userData.id,
		type: mesh.userData.type,
		position: mesh.position.toArray().map(round),
		rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z].map(round),
		scale: mesh.scale.toArray().map(round),
		color: `#${mesh.material.color.getHexString()}`,
		// existing = already decorated by a prior generation (frozen during expansion).
		existing: mesh.userData.existing === true,
	}
}

export function round(value) {
	return Math.round(value * 1000) / 1000
}

function geometryFor(type) {
	if (type === "sphere") return new THREE.SphereGeometry(0.5, 32, 16)
	if (type === "cylinder") return new THREE.CylinderGeometry(0.5, 0.5, 1, 32)
	if (type === "cone") return new THREE.ConeGeometry(0.5, 1, 32)
	return new THREE.BoxGeometry(1, 1, 1)
}

function defaultScale(type) {
	if (type === "cylinder") return [1, 2, 1]
	if (type === "cone") return [1, 1, 1]
	return [1, 1, 1]
}
