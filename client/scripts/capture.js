import * as THREE from "three"

const size = 512
const names = [
	"front",
	"back",
	"left",
	"right",
	"top",
	"corner_fl_high",
	"corner_fr_high",
	"corner_bl_high",
	"corner_br_high",
	"corner_fl_low",
	"corner_fr_low",
	"corner_bl_low",
	"corner_br_low",
]


export async function captureViews(renderer, scene, camera, helpers, selected, subjects = []) {
	const original = snapshot(camera, renderer)
	const target = new THREE.WebGLRenderTarget(size, size)
	const depthMaterial = createDepthMaterial(camera)
	const views = []
	const frame = captureFrame(subjects)

	setHelpers(helpers, false)
	const selectionOutlines = selected ? selected.children.filter(child => child.userData.isSelectionOutline) : []
	for (const outline of selectionOutlines) outline.visible = false

	for (const name of names) {
		poseCamera(camera, name, frame)
		updateSky(scene, camera)
		camera.aspect = 1
		camera.updateProjectionMatrix()
		camera.updateMatrixWorld(true)
		depthMaterial.uniforms.near.value = camera.near
		depthMaterial.uniforms.far.value = camera.far

		const rgb = await captureTarget(renderer, scene, camera, target, 0xeef5f2)
		scene.overrideMaterial = depthMaterial
		const depth = await captureTarget(renderer, scene, camera, target, 0x000000)
		scene.overrideMaterial = null

		views.push({
			name,
			rgb,
			depth,
			camera: cameraPayload(camera, name),
		})
	}

	target.dispose()
	depthMaterial.dispose()
	restore(camera, renderer, original)
	setHelpers(helpers, true)
	for (const outline of selectionOutlines) outline.visible = true

	return views
}

function poseCamera(camera, name, frame) {
	const directions = {
		front: [0, 0.28, 1],
		back: [0, 0.28, -1],
		left: [-1, 0.28, 0],
		right: [1, 0.28, 0],
		top: [0.001, 1, 0],
		corner_fl_high: [-1, 0.78, 1],
		corner_fr_high: [1, 0.78, 1],
		corner_bl_high: [-1, 0.78, -1],
		corner_br_high: [1, 0.78, -1],
		corner_fl_low: [-1, 0.13, 1],
		corner_fr_low: [1, 0.13, 1],
		corner_bl_low: [-1, 0.13, -1],
		corner_br_low: [1, 0.13, -1],
	}
	camera.near = 0.05
	camera.fov = 50
	const direction = new THREE.Vector3(...directions[name]).normalize()
	const distance = fitDistanceForFrame(camera, frame, direction, 1.14)
	camera.position.copy(frame.target).addScaledVector(direction, distance)
	camera.far = Math.max(48, distance + frame.radius * 3 + 12)
	camera.lookAt(frame.target)
}

function captureFrame(subjects) {
	const box = new THREE.Box3()
	const subjectBox = new THREE.Box3()
	let hasSubject = false

	for (const subject of subjects) {
		if (!subject.visible) continue
		subject.updateMatrixWorld(true)
		subjectBox.setFromObject(subject)
		if (subjectBox.isEmpty()) continue
		box.union(subjectBox)
		hasSubject = true
	}

	if (!hasSubject) {
		const target = new THREE.Vector3(0, 1.6, 0)
		return {
			box: new THREE.Box3().setFromCenterAndSize(target, new THREE.Vector3(8, 4, 8)),
			target,
			radius: 7,
		}
	}

	const target = box.getCenter(new THREE.Vector3())
	const size = box.getSize(new THREE.Vector3())
	target.y = Math.max(1.2, target.y)
	return {
		box: box.clone(),
		target,
		radius: Math.max(4, size.length() * 0.5),
	}
}

function fitDistanceForFrame(camera, frame, direction, margin) {
	const target = frame.target
	const box = frame.box
	const corners = [
		new THREE.Vector3(box.min.x, box.min.y, box.min.z),
		new THREE.Vector3(box.min.x, box.min.y, box.max.z),
		new THREE.Vector3(box.min.x, box.max.y, box.min.z),
		new THREE.Vector3(box.min.x, box.max.y, box.max.z),
		new THREE.Vector3(box.max.x, box.min.y, box.min.z),
		new THREE.Vector3(box.max.x, box.min.y, box.max.z),
		new THREE.Vector3(box.max.x, box.max.y, box.min.z),
		new THREE.Vector3(box.max.x, box.max.y, box.max.z),
	]
	const forward = direction.clone().multiplyScalar(-1)
	const upHint = Math.abs(forward.y) > 0.96 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0)
	const right = new THREE.Vector3().crossVectors(upHint, forward).normalize()
	const up = new THREE.Vector3().crossVectors(forward, right).normalize()
	const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5)
	let distance = Math.max(frame.radius, 1)

	for (const corner of corners) {
		const rel = corner.sub(target)
		const planeX = Math.abs(rel.dot(right))
		const planeY = Math.abs(rel.dot(up))
		const towardCamera = rel.dot(direction)
		distance = Math.max(distance, towardCamera + Math.max(planeX, planeY) * margin / tan)
	}

	return distance + frame.radius * 0.08
}

function cameraPayload(camera, name) {
	const forward = new THREE.Vector3()
	const right = new THREE.Vector3()
	const up = new THREE.Vector3()

	camera.getWorldDirection(forward)
	right.setFromMatrixColumn(camera.matrixWorld, 0).normalize()
	up.setFromMatrixColumn(camera.matrixWorld, 1).normalize()

	return {
		name,
		width: size,
		height: size,
		position: camera.position.toArray(),
		forward: forward.toArray(),
		right: right.toArray(),
		up: up.toArray(),
		fov: camera.fov,
		aspect: camera.aspect,
		near: camera.near,
		far: camera.far,
	}
}

function createDepthMaterial(camera) {
	const material = new THREE.ShaderMaterial({
		uniforms: {
			near: { value: camera.near },
			far: { value: camera.far },
		},
		vertexShader: `
			varying float viewZ;
			void main() {
				vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
				viewZ = -mvPosition.z;
				gl_Position = projectionMatrix * mvPosition;
			}
		`,
		fragmentShader: `
			uniform float near;
			uniform float far;
			varying float viewZ;
			void main() {
				float depth = clamp((viewZ - near) / (far - near), 0.0, 1.0);
				gl_FragColor = vec4(vec3(depth), 1.0);
			}
		`,
	})
	material.toneMapped = false
	return material
}

async function captureTarget(renderer, scene, camera, target, clearColor) {
	renderer.setRenderTarget(target)
	renderer.setClearColor(clearColor, 1)
	renderer.clear()
	renderer.render(scene, camera)

	const pixels = new Uint8Array(size * size * 4)
	renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels)
	renderer.setRenderTarget(null)

	return pixelsToBlob(pixels)
}

function pixelsToBlob(pixels) {
	const canvas = document.createElement("canvas")
	canvas.width = size
	canvas.height = size
	const ctx = canvas.getContext("2d")
	const image = ctx.createImageData(size, size)

	for (let y = 0; y < size; y++) {
		const src = y * size * 4
		const dst = (size - y - 1) * size * 4
		image.data.set(pixels.subarray(src, src + size * 4), dst)
	}

	ctx.putImageData(image, 0, 0)
	const data = canvas.toDataURL("image/png").split(",")[1]
	const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0))
	return new Blob([bytes], { type: "image/png" })
}

function snapshot(camera, renderer) {
	return {
		position: camera.position.clone(),
		quaternion: camera.quaternion.clone(),
		aspect: camera.aspect,
		near: camera.near,
		far: camera.far,
		fov: camera.fov,
		clear: renderer.getClearColor(new THREE.Color()).clone(),
	}
}

function restore(camera, renderer, state) {
	camera.position.copy(state.position)
	camera.quaternion.copy(state.quaternion)
	camera.aspect = state.aspect
	camera.near = state.near
	camera.far = state.far
	camera.fov = state.fov
	camera.updateProjectionMatrix()
	renderer.setClearColor(state.clear, 1)
}

function updateSky(scene, camera) {
	scene.traverse(object => {
		if (object.userData.sky) object.position.copy(camera.position)
	})
}

function setHelpers(helpers, visible) {
	for (const helper of helpers) helper.visible = visible
}
