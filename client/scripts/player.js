import * as THREE from "three"
import { primitiveBox } from "/scripts/geometry.js"

// Third-person character controller for play mode. You drag a placeholder body onto the
// generated world, then walk it around: WASD moves relative to the camera, Space jumps,
// Shift sprints. Gravity + collide-and-slide run against the block-out primitives, which
// persist (hidden) after generation and are the scene's de-facto colliders — the splats
// themselves have no collision geometry. No pointer lock: look is click-drag, so nothing
// depends on Esc (Mac-friendly). Exit is a button in the renderer UI.

const HEIGHT = 1.7 // body height in world units (the floor tile is 16 wide)
const RADIUS = 0.35 // horizontal half-width for collision
const WALK = 4.5 // units/sec
const SPRINT = 1.9 // multiplier while Shift held
const JUMP = 6.0 // initial jump velocity
const GRAVITY = 18 // downward accel
const CAM_DIST = 4.4 // default third-person camera distance
const CAM_MIN = 2.2
const CAM_MAX = 8
const HEAD = 1.45 // camera look-at height above the feet

// buildBody makes a simple placeholder figure (capsule torso + sphere head + a little
// nose so its facing reads). Its origin is at the feet, so positioning is just the feet
// point. Later this is where a nicer/custom avatar would slot in.
function buildBody() {
	const group = new THREE.Group()
	const skin = new THREE.MeshStandardMaterial({ color: 0x4f9dff, roughness: 0.7, metalness: 0 })
	const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.9, 6, 16), skin)
	torso.position.y = 0.85 // capsule total height ≈ 1.5, centered so feet ≈ 0.1
	group.add(torso)
	const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 24, 16), new THREE.MeshStandardMaterial({ color: 0x2f6dbf, roughness: 0.7 }))
	head.position.y = 1.55
	group.add(head)
	const nose = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.16), new THREE.MeshStandardMaterial({ color: 0xffd23f }))
	nose.position.set(0, 1.55, 0.26) // points +Z, the body's forward
	group.add(nose)
	group.userData.isPlayer = true
	return group
}

export function createPlayer({ camera, world, groundTopY }) {
	const body = buildBody()
	body.visible = false
	world.group.add(body)

	const pos = new THREE.Vector3() // feet position, world/plot-local coords (world.group is identity)
	const vel = new THREE.Vector3()
	const keys = new Set()
	let facing = 0 // body yaw
	let camYaw = 0 // azimuth of the camera around the body
	let camPolar = 1.05 // polar angle from +Y (smaller = looking down from higher)
	let camDist = CAM_DIST
	let onGround = false
	let colliders = [] // Box3[] world AABBs of the block-out primitives

	const forward = new THREE.Vector3()
	const right = new THREE.Vector3()
	const offset = new THREE.Vector3()
	const spherical = new THREE.Spherical()

	function buildColliders() {
		// Reuse the same AABB the editor's collider overlay uses. Rotated/round primitives
		// become blocky colliders — fine for walking around.
		return world.primitives.map(p => primitiveBox(p))
	}

	// spawn drops the body at a ground point and starts play.
	function spawn(point) {
		pos.set(point.x, groundTopY, point.z)
		clampToTile()
		vel.set(0, 0, 0)
		camYaw = 0
		camPolar = 1.05
		camDist = CAM_DIST
		onGround = true
		colliders = buildColliders()
		body.visible = true
		syncCamera()
	}

	function hide() {
		body.visible = false
		keys.clear()
	}

	function clampToTile() {
		const half = world.size / 2 - RADIUS
		pos.x = Math.max(-half, Math.min(half, pos.x))
		pos.z = Math.max(-half, Math.min(half, pos.z))
	}

	// addLook rotates the third-person camera around the body (click-drag).
	function addLook(dx, dy) {
		camYaw -= dx * 0.005
		camPolar = Math.max(0.35, Math.min(1.45, camPolar + dy * 0.004))
	}

	function zoom(deltaY) {
		camDist = Math.max(CAM_MIN, Math.min(CAM_MAX, camDist * (deltaY > 0 ? 1.1 : 0.9)))
	}

	function syncCamera() {
		offset.setFromSpherical(spherical.set(camDist, camPolar, camYaw))
		camera.position.copy(pos).add(offset)
		camera.up.set(0, 1, 0)
		camera.lookAt(pos.x, pos.y + HEAD, pos.z)
	}

	// camForward is the horizontal direction from the camera toward the body — WASD moves
	// relative to it, so "W" always walks into the screen regardless of look angle.
	function updateBasis() {
		forward.set(pos.x - camera.position.x, 0, pos.z - camera.position.z)
		if (forward.lengthSq() < 1e-6) forward.set(0, 0, 1)
		forward.normalize()
		right.set(-forward.z, 0, forward.x) // screen-right (D strafes right)
	}

	function update(dt) {
		if (!body.visible) return
		dt = Math.min(dt, 0.05) // clamp so a stutter can't tunnel through walls
		updateBasis()

		// Jump uses last frame's grounded state.
		if (keys.has("Space") && onGround) {
			vel.y = JUMP
			onGround = false
		}

		// Vertical integrate.
		vel.y -= GRAVITY * dt
		const prevFeet = pos.y
		pos.y += vel.y * dt
		onGround = false

		// Land on the floor tile.
		if (pos.y <= groundTopY) {
			pos.y = groundTopY
			vel.y = 0
			onGround = true
		}

		// Land on top of a primitive: only when descending through its top face this frame.
		if (vel.y <= 0) {
			for (const box of colliders) {
				if (pos.x < box.min.x || pos.x > box.max.x || pos.z < box.min.z || pos.z > box.max.z) continue
				if (prevFeet >= box.max.y - 1e-3 && pos.y < box.max.y) {
					pos.y = box.max.y
					vel.y = 0
					onGround = true
				}
			}
		}

		// Horizontal move from input, relative to the camera basis.
		const speed = WALK * (keys.has("ShiftLeft") || keys.has("ShiftRight") ? SPRINT : 1)
		let mx = 0, mz = 0
		if (keys.has("KeyW")) { mx += forward.x; mz += forward.z }
		if (keys.has("KeyS")) { mx -= forward.x; mz -= forward.z }
		if (keys.has("KeyD")) { mx += right.x; mz += right.z }
		if (keys.has("KeyA")) { mx -= right.x; mz -= right.z }
		const len = Math.hypot(mx, mz)
		if (len > 1e-4) {
			pos.x += (mx / len) * speed * dt
			pos.z += (mz / len) * speed * dt
			facing = Math.atan2(mx, mz) // face the move direction
		}

		resolveHorizontal()
		clampToTile()

		body.position.copy(pos)
		body.rotation.y = facing
		syncCamera()
	}

	// resolveHorizontal pushes the body out of any primitive it overlaps (footprint fattened
	// by RADIUS), along the shallowest of the four side faces — collide-and-slide.
	function resolveHorizontal() {
		const feetY = pos.y
		const headY = pos.y + HEIGHT
		for (const box of colliders) {
			if (headY <= box.min.y || feetY >= box.max.y) continue // no vertical overlap → not a wall here
			const minx = box.min.x - RADIUS, maxx = box.max.x + RADIUS
			const minz = box.min.z - RADIUS, maxz = box.max.z + RADIUS
			if (pos.x <= minx || pos.x >= maxx || pos.z <= minz || pos.z >= maxz) continue
			const dxL = pos.x - minx, dxR = maxx - pos.x
			const dzL = pos.z - minz, dzR = maxz - pos.z
			const m = Math.min(dxL, dxR, dzL, dzR)
			if (m === dxL) pos.x = minx
			else if (m === dxR) pos.x = maxx
			else if (m === dzL) pos.z = minz
			else pos.z = maxz
		}
	}

	// Keyboard is owned here so WASD never collides with the editor's shortcuts; listeners
	// are attached only between attach()/detach().
	function onKeyDown(e) {
		if (e.repeat) return
		keys.add(e.code)
		if (["KeyW", "KeyA", "KeyS", "KeyD", "Space"].includes(e.code)) e.preventDefault()
	}
	function onKeyUp(e) { keys.delete(e.code) }

	function attach() {
		window.addEventListener("keydown", onKeyDown)
		window.addEventListener("keyup", onKeyUp)
	}
	function detach() {
		window.removeEventListener("keydown", onKeyDown)
		window.removeEventListener("keyup", onKeyUp)
		keys.clear()
	}

	return { body, spawn, hide, update, addLook, zoom, attach, detach }
}
