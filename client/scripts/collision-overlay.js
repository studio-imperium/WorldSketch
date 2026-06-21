import * as THREE from "three"

export function createCollisionOverlay(scene) {
	const group = new THREE.Group()
	group.name = "collision_overlay"
	scene.add(group)

	return {
		group,
		load(data) {
			clearGroup(group)
			const colliders = data.colliders ?? data.primitives ?? []
			for (const collider of colliders) {
				group.add(createWire(collider))
			}
			return colliders.length
		},
		clear() {
			clearGroup(group)
		},
	}
}

export async function readCollisionFile(file) {
	return JSON.parse(await file.text())
}

export async function fetchCollision(url) {
	const res = await fetch(url)
	if (!res.ok) throw new Error(res.statusText)
	return res.json()
}

function createWire(collider) {
	const geometry = geometryFor(collider.type)
	const wire = new THREE.LineSegments(new THREE.WireframeGeometry(geometry), new THREE.LineBasicMaterial({
		color: 0x69e7ff,
		transparent: true,
		opacity: 0.92,
		depthTest: false,
		depthWrite: false,
	}))
	wire.renderOrder = 999
	wire.position.fromArray(collider.position ?? [0, 0, 0])
	wire.rotation.fromArray(collider.rotation ?? [0, 0, 0])
	wire.scale.fromArray(collider.scale ?? [1, 1, 1])
	wire.userData = { id: collider.id, type: collider.type }
	return wire
}

function geometryFor(type) {
	if (type === "sphere") return new THREE.SphereGeometry(0.5, 18, 10)
	if (type === "cylinder") return new THREE.CylinderGeometry(0.5, 0.5, 1, 18, 1)
	if (type === "cone") return new THREE.ConeGeometry(0.5, 1, 18, 1)
	return new THREE.BoxGeometry(1, 1, 1)
}

function clearGroup(group) {
	for (const child of [...group.children]) {
		child.geometry?.dispose()
		child.material?.dispose()
		child.removeFromParent()
	}
}
