import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const outputPath = resolve(scriptDir, "../artifacts/walking-fortress/walking-fortress.json")

const C = {
	stone: "#a9a08e",
	stoneLight: "#c8bd9f",
	stoneDark: "#6f685d",
	teal: "#466b73",
	tealDark: "#304a51",
	iron: "#353536",
	ironLight: "#565657",
	brass: "#a8762d",
	gold: "#d6a33d",
	amber: "#f3ae36",
	wood: "#70492f",
	roof: "#8f4035",
	roofDark: "#61312e",
	flag: "#263d6d",
}

const primitives = []

function box(position, scale, color, rotation = [0, 0, 0]) {
	primitives.push({
		type: "box",
		position: position.map(value => Number(value.toFixed(4))),
		rotation: rotation.map(value => Number(value.toFixed(4))),
		scale: scale.map(value => Number(value.toFixed(4))),
		color,
		locked: false,
		support: null,
		supportAxis: { name: "y", sign: 1 },
	})
}

function trimBand(y, halfX, halfZ, thickness, color) {
	box([0, y, halfZ], [halfX * 2, thickness, 0.32], color)
	box([0, y, -halfZ], [halfX * 2, thickness, 0.32], color)
	box([halfX, y, 0], [0.32, thickness, halfZ * 2], color)
	box([-halfX, y, 0], [0.32, thickness, halfZ * 2], color)
}

function makeLeg({ x, z, kneeX, kneeZ, ankleX, ankleZ, footZ, upperRX = 0, upperRZ = 0, lowerRX = 0, lowerRZ = 0 }) {
	// Hip socket and layered side armour.
	box([x, 8.15, z], [2.55, 1.45, 2.55], C.iron)
	box([x, 8.25, z], [2.9, 0.72, 2.9], C.teal)
	box([x, 7.7, z], [1.05, 0.62, 1.05], C.brass)

	// Upper leg, knee bearing, shin and ankle. The mild rotations make the
	// silhouette read as a gait instead of four static pillars.
	box([(x + kneeX) / 2, 6.65, (z + kneeZ) / 2], [1.45, 2.75, 1.45], C.ironLight, [upperRX, 0, upperRZ])
	box([(x + kneeX) / 2, 6.65, (z + kneeZ) / 2], [1.78, 1.25, 1.78], C.teal, [upperRX, 0, upperRZ])
	box([kneeX, 5.15, kneeZ], [2.15, 1.05, 2.15], C.brass)
	box([kneeX, 5.15, kneeZ], [1.35, 1.35, 2.45], C.iron)
	box([(kneeX + ankleX) / 2, 3.65, (kneeZ + ankleZ) / 2], [1.38, 2.7, 1.38], C.ironLight, [lowerRX, 0, lowerRZ])
	box([(kneeX + ankleX) / 2, 3.65, (kneeZ + ankleZ) / 2], [1.72, 1.2, 1.72], C.teal, [lowerRX, 0, lowerRZ])
	box([ankleX, 2.2, ankleZ], [1.95, 0.9, 1.95], C.brass)

	// Broad stone-and-metal foot with a toe cap and sole.
	box([ankleX, 1.3, footZ], [3.15, 1.25, 3.75], C.stoneLight)
	box([ankleX, 0.62, footZ + Math.sign(footZ || 1) * 0.12], [3.42, 0.34, 4.05], C.iron)
	box([ankleX, 1.25, footZ + Math.sign(footZ || 1) * 1.65], [2.7, 0.82, 0.65], C.brass)
}

// Four articulated legs in an alternating walking pose.
makeLeg({ x: 3.65, z: 3.45, kneeX: 4.05, kneeZ: 4.05, ankleX: 4.25, ankleZ: 4.75, footZ: 5.2, upperRX: 0.14, upperRZ: -0.13, lowerRX: 0.18, lowerRZ: -0.07 })
makeLeg({ x: -3.65, z: 3.45, kneeX: -3.95, kneeZ: 3.05, ankleX: -4.1, ankleZ: 2.65, footZ: 3.0, upperRX: -0.12, upperRZ: 0.11, lowerRX: -0.14, lowerRZ: 0.06 })
makeLeg({ x: 3.65, z: -3.45, kneeX: 3.35, kneeZ: -3.95, ankleX: 3.15, ankleZ: -4.55, footZ: -4.95, upperRX: -0.13, upperRZ: -0.1, lowerRX: -0.16, lowerRZ: -0.06 })
makeLeg({ x: -3.65, z: -3.45, kneeX: -4.05, kneeZ: -3.05, ankleX: -4.25, ankleZ: -2.65, footZ: -3.05, upperRX: 0.12, upperRZ: 0.13, lowerRX: 0.13, lowerRZ: 0.08 })

// Armoured mechanical chassis supporting the castle.
box([0, 8.95, 0], [8.6, 1.9, 8.0], C.iron)
box([0, 9.55, 0], [9.25, 1.25, 8.6], C.tealDark)
box([0, 10.35, 0], [9.9, 0.55, 9.25], C.brass)
box([0, 10.72, 0], [9.35, 0.42, 8.8], C.iron)
box([0, 11.0, 0], [8.85, 0.38, 8.35], C.stoneDark)

// Chassis armour plates, vents and glowing engine windows on the visible sides.
for (const x of [-3.0, 0, 3.0]) {
	box([x, 9.65, 4.42], [2.25, 1.28, 0.26], C.teal)
	box([x, 9.63, 4.58], [0.8, 0.58, 0.22], C.amber)
}
for (const z of [-2.7, 0, 2.7]) {
	box([4.76, 9.65, z], [0.26, 1.28, 2.1], C.teal)
	box([4.92, 9.63, z], [0.22, 0.58, 0.72], C.amber)
}
box([-4.76, 9.65, 0], [0.26, 1.28, 4.9], C.teal)
box([0, 9.65, -4.46], [5.2, 1.28, 0.26], C.teal)

// Castle plinth and fortified lower hall.
box([0, 11.45, 0], [7.85, 0.7, 7.45], C.stoneDark)
box([0, 13.05, 0], [7.15, 3.0, 6.8], C.stone)
box([0, 14.7, 0], [7.65, 0.42, 7.25], C.brass)
trimBand(12.05, 3.67, 3.48, 0.35, C.stoneLight)

// Front gate and its frame sit on the +Z face, which is visible in the canonical view.
box([0, 12.85, 3.52], [2.15, 2.45, 0.34], C.wood)
box([0, 14.12, 3.58], [2.65, 0.32, 0.42], C.brass)
box([-1.22, 12.9, 3.58], [0.3, 2.9, 0.42], C.brass)
box([1.22, 12.9, 3.58], [0.3, 2.9, 0.42], C.brass)
box([0, 11.65, 4.3], [2.5, 0.32, 1.85], C.wood, [-0.13, 0, 0])

// Amber windows in the lower hall.
for (const x of [-2.45, 2.45]) {
	box([x, 13.15, 3.48], [1.0, 1.35, 0.26], C.amber)
	box([x, 13.15, 3.64], [0.16, 1.52, 0.18], C.brass)
}
for (const z of [-2.2, 0, 2.2]) {
	box([3.64, 13.15, z], [0.26, 1.3, 0.92], C.amber)
	box([3.8, 13.15, z], [0.18, 1.5, 0.15], C.brass)
}

// Upper courtyard/deck and crenellated parapets.
box([0, 15.05, 0], [8.2, 0.65, 7.8], C.stoneLight)
box([0, 15.48, 3.78], [7.95, 0.65, 0.42], C.stoneDark)
box([0, 15.48, -3.78], [7.95, 0.65, 0.42], C.stoneDark)
box([3.98, 15.48, 0], [0.42, 0.65, 7.55], C.stoneDark)
box([-3.98, 15.48, 0], [0.42, 0.65, 7.55], C.stoneDark)
for (const x of [-3.5, -2.1, -0.7, 0.7, 2.1, 3.5]) {
	box([x, 16.05, 3.78], [0.72, 0.75, 0.62], C.stoneLight)
	box([x, 16.05, -3.78], [0.72, 0.75, 0.62], C.stoneLight)
}
for (const z of [-3.2, -1.9, -0.6, 0.7, 2.0, 3.3]) {
	box([3.98, 16.05, z], [0.62, 0.75, 0.72], C.stoneLight)
	box([-3.98, 16.05, z], [0.62, 0.75, 0.72], C.stoneLight)
}

function turret(x, z, roofRotation = 0) {
	box([x, 16.9, z], [2.15, 3.25, 2.15], C.stone)
	box([x, 18.45, z], [2.55, 0.4, 2.55], C.brass)
	box([x, 18.82, z], [2.75, 0.42, 2.75], C.roofDark, [0, roofRotation, 0])
	box([x, 19.18, z], [2.15, 0.42, 2.15], C.roof, [0, roofRotation, 0])
	box([x, 19.53, z], [1.55, 0.4, 1.55], C.roof, [0, roofRotation, 0])
	box([x, 19.88, z], [0.85, 0.42, 0.85], C.brass, [0, roofRotation, 0])
}

turret(-2.85, -2.65, 0.1)
turret(2.85, -2.65, -0.08)
turret(-2.85, 2.65, -0.08)
turret(2.85, 2.65, 0.1)

// Windows on visible turret faces.
for (const [x, z] of [[-2.85, 2.65], [2.85, 2.65]]) {
	box([x, 17.0, 3.76], [0.78, 1.05, 0.24], C.amber)
}
for (const [x, z] of [[2.85, -2.65], [2.85, 2.65]]) {
	box([3.96, 17.0, z], [0.24, 1.05, 0.78], C.amber)
}

// Central keep and its steep layered roof.
box([0, 17.05, 0], [3.65, 3.65, 3.65], C.stoneLight)
box([0, 18.9, 0], [4.1, 0.4, 4.1], C.brass)
box([0, 19.3, 0], [4.35, 0.46, 4.35], C.roofDark, [0, Math.PI / 4, 0])
box([0, 19.72, 0], [3.55, 0.46, 3.55], C.roof, [0, Math.PI / 4, 0])
box([0, 20.14, 0], [2.8, 0.46, 2.8], C.roof, [0, Math.PI / 4, 0])
box([0, 20.56, 0], [2.0, 0.46, 2.0], C.roof, [0, Math.PI / 4, 0])
box([0, 20.98, 0], [1.2, 0.46, 1.2], C.roofDark, [0, Math.PI / 4, 0])
box([0, 21.48, 0], [0.42, 0.95, 0.42], C.brass)
box([0, 22.0, 0], [0.9, 0.18, 0.18], C.gold)
box([0, 22.0, 0], [0.18, 0.18, 0.9], C.gold)

// Keep windows.
box([0, 17.25, 1.9], [1.0, 1.3, 0.24], C.amber)
box([1.9, 17.25, 0], [0.24, 1.3, 1.0], C.amber)

// Chimney and a blue-gold banner, both kept chunky enough to reconstruct.
box([-1.9, 18.0, -3.0], [0.85, 2.6, 0.85], C.stoneDark)
box([-1.9, 19.35, -3.0], [1.15, 0.35, 1.15], C.iron)
box([3.25, 18.45, 0.7], [0.22, 5.0, 0.22], C.brass)
box([3.25, 19.45, 1.32], [0.22, 1.45, 1.4], C.flag)
box([3.38, 19.5, 1.32], [0.18, 0.25, 0.85], C.gold)

// A small deck cannon/telescope shape for a recognizable prop silhouette.
box([1.9, 16.15, -1.0], [0.75, 0.65, 0.75], C.wood)
box([2.15, 16.72, -1.0], [0.55, 0.55, 2.45], C.brass, [0.18, 0.18, 0])
box([2.35, 16.88, -1.38], [0.75, 0.75, 0.75], C.iron)

// Underbody engine core and brass stabilizers fill the central gap between the legs.
box([0, 7.85, 0], [3.7, 1.25, 3.7], C.iron)
box([0, 7.35, 0], [2.55, 1.15, 2.55], C.teal)
box([0, 6.78, 0], [1.6, 0.5, 1.6], C.amber)
box([0, 8.3, 4.05], [3.4, 0.42, 0.42], C.brass)
box([4.15, 8.3, 0], [0.42, 0.42, 3.3], C.brass)

const scene = { version: 4, ground: null, primitives }
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(scene, null, 2)}\n`, "utf8")
console.log(`Wrote ${primitives.length} primitives to ${outputPath}`)
