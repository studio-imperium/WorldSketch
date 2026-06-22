import * as THREE from "three"

export function createOrbit(canvas, camera) {
	const target = new THREE.Vector3(0, 0.6, 0)
	const spherical = new THREE.Spherical()
	const offset = new THREE.Vector3()
	let dragging = false
	let lastX = 0
	let lastY = 0
	let moved = false

	function sync() {
		offset.copy(camera.position).sub(target)
		spherical.setFromVector3(offset)
	}

	function update() {
		spherical.phi = Math.max(0.08, Math.min(Math.PI - 0.08, spherical.phi))
		spherical.radius = Math.max(2, Math.min(24, spherical.radius))
		camera.position.copy(target).add(offset.setFromSpherical(spherical))
		camera.lookAt(target)
	}

	sync()
	update()

	canvas.addEventListener("pointerdown", (event) => {
		dragging = true
		moved = false
		lastX = event.clientX
		lastY = event.clientY
		canvas.setPointerCapture(event.pointerId)
	})

	canvas.addEventListener("pointermove", (event) => {
		if (!dragging) return
		const dx = event.clientX - lastX
		const dy = event.clientY - lastY
		lastX = event.clientX
		lastY = event.clientY
		if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
		spherical.theta -= dx * 0.006
		spherical.phi -= dy * 0.006
		update()
	})

	canvas.addEventListener("pointerup", (event) => {
		dragging = false
		canvas.releasePointerCapture(event.pointerId)
	})

	canvas.addEventListener("wheel", (event) => {
		event.preventDefault()
		spherical.radius *= event.deltaY > 0 ? 1.08 : 0.92
		update()
	}, { passive: false })

	return {
		target,
		moved: () => moved,
		update,
		frame(box) {
			const center = new THREE.Vector3()
			const size = new THREE.Vector3()
			box.getCenter(center)
			box.getSize(size)
			target.copy(center)
			spherical.radius = Math.max(5, size.length() * 1.25)
			update()
		},
		// Persisted across reloads (renderer autosave) so the camera comes back where you left it.
		getState() {
			return { target: [target.x, target.y, target.z], radius: spherical.radius, theta: spherical.theta, phi: spherical.phi }
		},
		setState(state) {
			if (!state) return
			if (Array.isArray(state.target)) target.set(state.target[0] || 0, state.target[1] || 0, state.target[2] || 0)
			if (Number.isFinite(state.radius)) spherical.radius = state.radius
			if (Number.isFinite(state.theta)) spherical.theta = state.theta
			if (Number.isFinite(state.phi)) spherical.phi = state.phi
			update()
		},
	}
}
