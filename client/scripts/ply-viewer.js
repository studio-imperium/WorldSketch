import * as THREE from "three"
import { createOrbit } from "/scripts/controls.js"
import { createCollisionOverlay, fetchCollision, readCollisionFile } from "/scripts/collision-overlay.js"

const root = document.getElementById("canvas")
const renderer = new THREE.WebGLRenderer({ antialias: true })
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 1000)
const file = document.getElementById("file")
const collisionFile = document.getElementById("collision_file")
const status = document.getElementById("status")
const stats = document.getElementById("stats")
const frameButton = document.getElementById("frame_btn")
const cullButton = document.getElementById("cull_btn")
const sizeInput = document.getElementById("point_size")

let points = null
let currentCloud = null
let collisionData = null
let material = new THREE.PointsMaterial({
	size: Number(sizeInput.value),
	vertexColors: true,
	sizeAttenuation: true,
})

renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setClearColor(0x171717, 1)
root.appendChild(renderer.domElement)

camera.position.set(3, 2, 4)
const orbit = createOrbit(renderer.domElement, camera)
scene.add(new THREE.HemisphereLight(0xffffff, 0x222222, 1.8))
scene.add(new THREE.GridHelper(10, 20, 0x555555, 0x282828))
const collisions = createCollisionOverlay(scene)

const colliderToggle = document.getElementById("show_colliders")
collisions.group.visible = colliderToggle.checked
colliderToggle.addEventListener("change", () => {
	collisions.group.visible = colliderToggle.checked
})

file.addEventListener("change", async () => {
	if (!file.files.length) return
	await loadText(await file.files[0].text(), file.files[0].name)
})

collisionFile.addEventListener("change", async () => {
	if (!collisionFile.files.length) return
	await loadCollision(await readCollisionFile(collisionFile.files[0]), collisionFile.files[0].name)
})

window.addEventListener("dragover", event => {
	event.preventDefault()
})

window.addEventListener("drop", async event => {
	event.preventDefault()
	const item = event.dataTransfer.files[0]
	if (!item) return
	if (item.name.toLowerCase().endsWith(".json")) {
		await loadCollision(await readCollisionFile(item), item.name)
		return
	}
	await loadText(await item.text(), item.name)
})

frameButton.addEventListener("click", frame)
cullButton.addEventListener("click", applyCullings)
sizeInput.addEventListener("input", () => {
	material.size = Number(sizeInput.value)
})

window.addEventListener("resize", () => {
	camera.aspect = window.innerWidth / window.innerHeight
	camera.updateProjectionMatrix()
	renderer.setSize(window.innerWidth, window.innerHeight)
})

const src = new URLSearchParams(location.search).get("src")
const collisionSrc = new URLSearchParams(location.search).get("collisions")
if (src) {
	status.textContent = "Loading PLY"
	fetch(src)
		.then(res => {
			if (!res.ok) throw new Error(res.statusText)
			return res.text()
		})
		.then(text => loadText(text, src.split("/").pop()))
		.catch(err => status.textContent = err.message)
}
if (collisionSrc) {
	fetchCollision(collisionSrc)
		.then(data => loadCollision(data, collisionSrc.split("/").pop()))
		.catch(err => status.textContent = err.message)
}

function loadText(text, name) {
	try {
		const cloud = parsePLY(text)
		showCloud(cloud)
		status.textContent = name
		stats.textContent = `${cloud.count.toLocaleString()} points`
	} catch (err) {
		status.textContent = err.message
	}
}

function parsePLY(text) {
	const lines = text.split(/\r?\n/)
	if (lines[0] !== "ply") throw new Error("Not a PLY file")

	let vertexCount = 0
	let headerEnd = -1
	const properties = []
	let inVertex = false

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim()
		if (line === "end_header") {
			headerEnd = i
			break
		}
		const parts = line.split(/\s+/)
		if (parts[0] === "element") {
			inVertex = parts[1] === "vertex"
			if (inVertex) vertexCount = Number(parts[2])
			continue
		}
		if (inVertex && parts[0] === "property") {
			properties.push(parts[2])
		}
	}

	if (headerEnd < 0) throw new Error("Missing PLY header end")
	if (!vertexCount) throw new Error("No vertices found")

	const ix = properties.indexOf("x")
	const iy = properties.indexOf("y")
	const iz = properties.indexOf("z")
	const ir = properties.indexOf("red")
	const ig = properties.indexOf("green")
	const ib = properties.indexOf("blue")
	if (ix < 0 || iy < 0 || iz < 0) throw new Error("PLY needs x/y/z vertex properties")

	const positions = new Float32Array(vertexCount * 3)
	const colors = new Float32Array(vertexCount * 3)
	let count = 0

	for (let i = 0; i < vertexCount; i++) {
		const line = lines[headerEnd + 1 + i]
		if (!line) continue
		const values = line.trim().split(/\s+/)
		const p = count * 3
		positions[p] = Number(values[ix])
		positions[p + 1] = Number(values[iy])
		positions[p + 2] = Number(values[iz])
		colors[p] = ir >= 0 ? Number(values[ir]) / 255 : 1
		colors[p + 1] = ig >= 0 ? Number(values[ig]) / 255 : 1
		colors[p + 2] = ib >= 0 ? Number(values[ib]) / 255 : 1
		count++
	}

	return {
		count,
		positions: positions.subarray(0, count * 3),
		colors: colors.subarray(0, count * 3),
	}
}

function showCloud(cloud) {
	currentCloud = cloud
	if (points) {
		points.geometry.dispose()
		points.removeFromParent()
	}

	const geometry = new THREE.BufferGeometry()
	geometry.setAttribute("position", new THREE.BufferAttribute(cloud.positions, 3))
	geometry.setAttribute("color", new THREE.BufferAttribute(cloud.colors, 3))
	geometry.computeBoundingBox()

	points = new THREE.Points(geometry, material)
	scene.add(points)
	frame()
}

function loadCollision(data, name) {
	try {
		collisionData = data
		const count = collisions.load(data)
		status.textContent = `${name}: ${count} collision wireframes`
	} catch (err) {
		status.textContent = err.message
	}
}

function applyCullings() {
	if (!currentCloud) {
		status.textContent = "Load a PLY first."
		return
	}

	const before = currentCloud.count
	let cloud = dedupeCloud(currentCloud, 0.025)
	const deduped = cloud.count
	if (collisionData) cloud = primitiveCullCloud(cloud, collisionData)
	const supported = cloud.count
	cloud = sparseCullCloud(cloud, 0.1, 8)
	showCloud(cloud)
	stats.textContent = `${cloud.count.toLocaleString()} points`
	status.textContent = `Culled ${before.toLocaleString()} -> ${cloud.count.toLocaleString()} (${deduped - supported} primitive, ${supported - cloud.count} sparse)`
}

function dedupeCloud(cloud, size) {
	const cells = new Map()
	for (let i = 0; i < cloud.count; i++) {
		const p = i * 3
		const key = voxelKey(cloud.positions[p], cloud.positions[p + 1], cloud.positions[p + 2], size)
		let cell = cells.get(key)
		if (!cell) {
			cell = { x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, n: 0 }
			cells.set(key, cell)
		}
		cell.x += cloud.positions[p]
		cell.y += cloud.positions[p + 1]
		cell.z += cloud.positions[p + 2]
		cell.r += cloud.colors[p]
		cell.g += cloud.colors[p + 1]
		cell.b += cloud.colors[p + 2]
		cell.n++
	}

	const positions = new Float32Array(cells.size * 3)
	const colors = new Float32Array(cells.size * 3)
	let i = 0
	for (const cell of cells.values()) {
		const p = i * 3
		positions[p] = cell.x / cell.n
		positions[p + 1] = cell.y / cell.n
		positions[p + 2] = cell.z / cell.n
		colors[p] = cell.r / cell.n
		colors[p + 1] = cell.g / cell.n
		colors[p + 2] = cell.b / cell.n
		i++
	}
	return { count: cells.size, positions, colors }
}

function primitiveCullCloud(cloud, data) {
	const colliders = data.colliders ?? data.primitives ?? []
	if (!colliders.length) return cloud

	const positions = []
	const colors = []
	for (let i = 0; i < cloud.count; i++) {
		const p = i * 3
		const point = [cloud.positions[p], cloud.positions[p + 1], cloud.positions[p + 2]]
		const color = [cloud.colors[p], cloud.colors[p + 1], cloud.colors[p + 2]]
		// Keep only if some collider both contains the point AND roughly matches its
		// colour — a point that's vastly off-colour from the primitive it sits on is culled.
		if (!colliders.some(collider => primitiveSupports(point, collider) && primitiveColorMatches(color, collider))) continue
		positions.push(...point)
		colors.push(color[0], color[1], color[2])
	}
	return {
		count: positions.length / 3,
		positions: new Float32Array(positions),
		colors: new Float32Array(colors),
	}
}

function sparseCullCloud(cloud, size, minNeighbors) {
	const cells = new Map()
	const keys = []
	for (let i = 0; i < cloud.count; i++) {
		const p = i * 3
		const key = voxelKey(cloud.positions[p], cloud.positions[p + 1], cloud.positions[p + 2], size)
		keys.push(key)
		cells.set(key, (cells.get(key) ?? 0) + 1)
	}

	const positions = []
	const colors = []
	for (let i = 0; i < cloud.count; i++) {
		const [kx, ky, kz] = keys[i].split(",").map(Number)
		let neighbors = 0
		for (let x = -1; x <= 1; x++) {
			for (let y = -1; y <= 1; y++) {
				for (let z = -1; z <= 1; z++) {
					neighbors += cells.get(`${kx + x},${ky + y},${kz + z}`) ?? 0
				}
			}
		}
		if (neighbors < minNeighbors) continue

		const p = i * 3
		positions.push(cloud.positions[p], cloud.positions[p + 1], cloud.positions[p + 2])
		colors.push(cloud.colors[p], cloud.colors[p + 1], cloud.colors[p + 2])
	}
	return {
		count: positions.length / 3,
		positions: new Float32Array(positions),
		colors: new Float32Array(colors),
	}
}

function primitiveSupports(point, primitive) {
	const local = inversePrimitivePoint(point, primitive)
	const half = primitiveHalfExtents(primitive)
	return primitiveSignedDistance(local, primitive.type, half) <= primitiveSupportMargin(primitive)
}

// Signed distance from a point (already in the primitive's local space) to the
// primitive surface: negative inside, positive outside, ~0 on the surface.
function primitiveSignedDistance(p, type, h) {
	if (type === "sphere") return ellipsoidDistance(p, h)
	if (type === "cylinder") return cylinderDistance(p, h)
	if (type === "cone") return coneDistance(p, h)
	return boxDistance(p, h)
}

function ellipsoidDistance(p, h) {
	const k0 = Math.hypot(p[0] / h[0], p[1] / h[1], p[2] / h[2])
	if (k0 === 0) return -Math.min(h[0], h[1], h[2])
	const k1 = Math.hypot(p[0] / (h[0] * h[0]), p[1] / (h[1] * h[1]), p[2] / (h[2] * h[2]))
	return (k0 * (k0 - 1)) / k1
}

function cylinderDistance(p, h) {
	const radial = (Math.hypot(p[0] / h[0], p[2] / h[2]) - 1) * Math.min(h[0], h[2])
	const axial = Math.abs(p[1]) - h[1]
	return Math.min(Math.max(radial, axial), 0) + Math.hypot(Math.max(radial, 0), Math.max(axial, 0))
}

function coneDistance(p, h) {
	// Apex at +y, base (full radius) at -y; allowed radius shrinks linearly with height.
	const t = Math.min(Math.max((p[1] + h[1]) / (2 * h[1]), 0), 1)
	const radial = (Math.hypot(p[0] / h[0], p[2] / h[2]) - (1 - t)) * Math.min(h[0], h[2])
	const axial = Math.abs(p[1]) - h[1]
	return Math.min(Math.max(radial, axial), 0) + Math.hypot(Math.max(radial, 0), Math.max(axial, 0))
}

function boxDistance(p, h) {
	const qx = Math.abs(p[0]) - h[0]
	const qy = Math.abs(p[1]) - h[1]
	const qz = Math.abs(p[2]) - h[2]
	return Math.min(Math.max(qx, qy, qz), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0))
}

function inversePrimitivePoint(point, primitive) {
	let x = point[0] - primitive.position[0]
	let y = point[1] - primitive.position[1]
	let z = point[2] - primitive.position[2]
	const rotation = primitive.rotation ?? [0, 0, 0]

	let c = Math.cos(-rotation[2])
	let s = Math.sin(-rotation[2])
	;[x, y] = [x * c - y * s, x * s + y * c]

	c = Math.cos(-rotation[1])
	s = Math.sin(-rotation[1])
	;[x, z] = [x * c + z * s, -x * s + z * c]

	c = Math.cos(-rotation[0])
	s = Math.sin(-rotation[0])
	;[y, z] = [y * c - z * s, y * s + z * c]

	return [x, y, z]
}

function primitiveHalfExtents(primitive) {
	const scale = primitive.scale ?? [1, 1, 1]
	return [scale[0] * 0.5, scale[1] * 0.5, scale[2] * 0.5]
}

function primitiveSupportMargin(primitive) {
	return 0.1
}

// Normalized RGB distance above which a point is considered "vastly" off-colour
// from its primitive and gets culled. Generous so only gross mismatches are removed.
const COLOR_CULL_THRESHOLD = 0.6

function primitiveColorMatches(color, primitive) {
	const target = hexToRgb(primitive.color)
	if (!target) return true // collider has no usable colour — don't colour-cull
	const dr = color[0] - target[0]
	const dg = color[1] - target[1]
	const db = color[2] - target[2]
	return Math.sqrt(dr * dr + dg * dg + db * db) <= COLOR_CULL_THRESHOLD
}

function hexToRgb(hex) {
	if (typeof hex !== "string" || hex.length !== 7 || hex[0] !== "#") return null
	const r = parseInt(hex.slice(1, 3), 16)
	const g = parseInt(hex.slice(3, 5), 16)
	const b = parseInt(hex.slice(5, 7), 16)
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null
	return [r / 255, g / 255, b / 255]
}

function voxelKey(x, y, z, size) {
	return `${Math.floor(x / size)},${Math.floor(y / size)},${Math.floor(z / size)}`
}

function frame() {
	if (!points) return
	const box = points.geometry.boundingBox
	if (!box) return
	orbit.frame(box)
}

function animate() {
	renderer.render(scene, camera)
	requestAnimationFrame(animate)
}

animate()
