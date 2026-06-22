import * as THREE from "three"

export function createOrbit(canvas, camera) {
	const target = new THREE.Vector3(0, 0.6, 0)
	const spherical = new THREE.Spherical()
	const offset = new THREE.Vector3()
	const worldUp = new THREE.Vector3(0, 1, 0)
	const panRight = new THREE.Vector3()
	const panUp = new THREE.Vector3()
	const moveFwd = new THREE.Vector3()
	const moveRight = new THREE.Vector3()
	const heldKeys = new Set()
	let dragging = false
	let panning = false
	let lastX = 0
	let lastY = 0
	let moved = false

	function sync() {
		offset.copy(camera.position).sub(target)
		spherical.setFromVector3(offset)
	}

	function update() {
		spherical.phi = Math.max(0.08, Math.min(Math.PI - 0.08, spherical.phi))
		spherical.radius = Math.max(1.5, Math.min(120, spherical.radius))
		camera.position.copy(target).add(offset.setFromSpherical(spherical))
		camera.lookAt(target)
	}

	sync()
	update()

	canvas.addEventListener("contextmenu", (event) => event.preventDefault())

	canvas.addEventListener("pointerdown", (event) => {
		dragging = true
		moved = false
		// Right / middle button, or Shift+drag → pan (move the pivot). Left drag → orbit.
		panning = event.button === 2 || event.button === 1 || event.shiftKey
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
		if (panning) {
			// Slide the pivot (and the camera with it) across the screen plane, scaled by
			// distance so panning feels the same whether zoomed in or out.
			const factor = spherical.radius * 0.0018
			camera.updateMatrixWorld()
			panRight.setFromMatrixColumn(camera.matrixWorld, 0)
			panUp.setFromMatrixColumn(camera.matrixWorld, 1)
			target.addScaledVector(panRight, -dx * factor).addScaledVector(panUp, dy * factor)
		} else {
			spherical.theta -= dx * 0.006
			spherical.phi -= dy * 0.006
		}
		update()
	})

	canvas.addEventListener("pointerup", (event) => {
		dragging = false
		panning = false
		canvas.releasePointerCapture(event.pointerId)
	})

	canvas.addEventListener("wheel", (event) => {
		event.preventDefault()
		spherical.radius *= event.deltaY > 0 ? 1.08 : 0.92
		update()
	}, { passive: false })

	// WASD / arrow keys fly the pivot across the ground (Q/E lower/raise it) — applyMovement()
	// is ticked each animation frame so holding a key glides smoothly.
	const moveKeys = new Set(["w", "a", "s", "d", "q", "e", "arrowup", "arrowdown", "arrowleft", "arrowright"])
	function isTyping() {
		const el = document.activeElement
		return Boolean(el) && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
	}
	window.addEventListener("keydown", (event) => {
		if (isTyping() || event.metaKey || event.ctrlKey || event.altKey) return
		const key = event.key.toLowerCase()
		if (!moveKeys.has(key)) return
		heldKeys.add(key)
		event.preventDefault()
	})
	window.addEventListener("keyup", (event) => heldKeys.delete(event.key.toLowerCase()))
	window.addEventListener("blur", () => heldKeys.clear())

	function applyMovement() {
		if (!heldKeys.size) return
		camera.getWorldDirection(moveFwd)
		moveFwd.y = 0
		if (moveFwd.lengthSq() < 1e-6) moveFwd.set(0, 0, -1)
		moveFwd.normalize()
		moveRight.crossVectors(moveFwd, worldUp).normalize()
		const step = spherical.radius * 0.02
		let fwd = 0, strafe = 0, lift = 0
		if (heldKeys.has("w") || heldKeys.has("arrowup")) fwd += 1
		if (heldKeys.has("s") || heldKeys.has("arrowdown")) fwd -= 1
		if (heldKeys.has("d") || heldKeys.has("arrowright")) strafe += 1
		if (heldKeys.has("a") || heldKeys.has("arrowleft")) strafe -= 1
		if (heldKeys.has("e")) lift += 1
		if (heldKeys.has("q")) lift -= 1
		if (!fwd && !strafe && !lift) return
		target.addScaledVector(moveFwd, fwd * step).addScaledVector(moveRight, strafe * step)
		target.y += lift * step
		update()
	}

	return {
		target,
		moved: () => moved,
		update,
		applyMovement,
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
