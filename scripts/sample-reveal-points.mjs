// Bake the landing page's scroll-reveal cloud from a gaussian-splat PLY:
//   node scripts/sample-reveal-points.mjs "<splat>.ply" client/assets/reveal-points.bin
// Full-fidelity offline pass so the page fetches ~150KB instead of a 17MB PLY:
// honors opacity (sigmoid) and scale (exp) so visible surfaces dominate the
// sample, keeps real color (0.5 + SH_C0·f_dc) quantized to a small palette,
// normalizes into a unit frame on percentile bounds, and pre-sorts centre-out
// (the reveal is a count threshold). Deterministic — same input, same bytes.
//
// Binary layout (little-endian):
//   u32 jsonLen | json { total, count, palette:[[r,g,b]…] }
//   i16 × 3 × count   positions, quantized to the unit sphere (÷32767)
//   u8  × count       palette index
//   u8  × count       weight (opacity×area percentile → glyph density)
import { readFileSync, writeFileSync } from "node:fs"

const [src, dst] = process.argv.slice(2)
const SAMPLE = 9000
const K = 24 // palette size
const SH_C0 = 0.28209479177387814
const sig = v => 1 / (1 + Math.exp(-v))

const buf = readFileSync(src)
const headerEnd = buf.indexOf("end_header\n") + "end_header\n".length
const header = buf.toString("ascii", 0, headerEnd)
const total = Number(header.match(/element vertex (\d+)/)[1])
const props = [...header.matchAll(/property float (\w+)/g)].map(m => m[1])
const stride = props.length * 4
const at = Object.fromEntries(props.map((p, i) => [p, i * 4]))

// pass 1: world frame (rotX(PI): y→-y, z→-z), opacity/scale decoded, faint fog culled
const pos = [], col = [], w = []
for (let i = 0; i < total; i++) {
	const o = headerEnd + i * stride
	const f = n => buf.readFloatLE(o + at[n])
	const x = f("x"), y = -f("y"), z = -f("z")
	if (![x, y, z].every(Number.isFinite)) continue
	const op = sig(f("opacity"))
	if (op < 0.05) continue
	const s = [Math.exp(f("scale_0")), Math.exp(f("scale_1")), Math.exp(f("scale_2"))]
	pos.push([x, y, z])
	col.push([f("f_dc_0"), f("f_dc_1"), f("f_dc_2")].map(v => Math.max(0, Math.min(1, 0.5 + SH_C0 * v))))
	w.push(op * (s[0] * s[1] + s[1] * s[2] + s[2] * s[0])) // opacity × surface-area proxy
}

// percentile-trim (sheds floaters), centre, unit-normalize on the trimmed radius
const bnd = a => {
	const v = pos.map(p => p[a]).sort((x, y) => x - y)
	return [v[Math.floor(0.005 * v.length)], v[Math.min(v.length - 1, Math.floor(0.995 * v.length))]]
}
const bb = [bnd(0), bnd(1), bnd(2)]
const ctr = bb.map(([lo, hi]) => (lo + hi) / 2)
const keep = []
for (let i = 0; i < pos.length; i++) {
	if ([0, 1, 2].some(a => pos[i][a] < bb[a][0] || pos[i][a] > bb[a][1])) continue
	keep.push(i)
}
let maxR = 1e-6
for (const i of keep) maxR = Math.max(maxR, Math.hypot(pos[i][0] - ctr[0], pos[i][1] - ctr[1], pos[i][2] - ctr[2]))

// weighted reservoir sample (A-Res: top-k by u^(1/w)), deterministic seed
let seed = 0x5eed1
const rng = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
const scored = keep.map(i => [Math.pow(rng() || 1e-9, 1 / (w[i] || 1e-9)), i])
scored.sort((a, b) => b[0] - a[0])
const picked = scored.slice(0, SAMPLE).map(([, i]) => i)

// centre-out sort so the reveal threshold walks outward
const r2 = i => {
	const dx = pos[i][0] - ctr[0], dy = pos[i][1] - ctr[1], dz = pos[i][2] - ctr[2]
	return dx * dx + dy * dy + dz * dz
}
picked.sort((a, b) => r2(a) - r2(b))

// k-means palette over the picked colors (few iterations is plenty)
const palette = Array.from({ length: K }, (_, k) => col[picked[Math.floor((k + 0.5) * picked.length / K)]].slice())
const assign = new Array(picked.length).fill(0)
for (let iter = 0; iter < 12; iter++) {
	for (let j = 0; j < picked.length; j++) {
		const c = col[picked[j]]
		let best = 0, bd = Infinity
		for (let k = 0; k < K; k++) {
			const p = palette[k]
			const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2
			if (d < bd) { bd = d; best = k }
		}
		assign[j] = best
	}
	const sum = Array.from({ length: K }, () => [0, 0, 0, 0])
	for (let j = 0; j < picked.length; j++) {
		const c = col[picked[j]], s = sum[assign[j]]
		s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; s[3]++
	}
	for (let k = 0; k < K; k++) if (sum[k][3]) palette[k] = [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]]
}

// weight byte: percentile rank of opacity×area → glyph density (rank beats raw
// value — area spans orders of magnitude)
const rank = picked.map((i, j) => [w[i], j]).sort((a, b) => a[0] - b[0])
const weightByte = new Uint8Array(picked.length)
rank.forEach(([, j], order) => { weightByte[j] = Math.round((order / (picked.length - 1)) * 255) })

const json = Buffer.from(JSON.stringify({
	total,
	count: picked.length,
	palette: palette.map(p => p.map(v => Math.round(v * 255))),
}))
const out = Buffer.alloc(4 + json.length + picked.length * (6 + 1 + 1))
out.writeUInt32LE(json.length, 0)
json.copy(out, 4)
let off = 4 + json.length
for (let j = 0; j < picked.length; j++) {
	const i = picked[j]
	for (let a = 0; a < 3; a++) {
		const q = Math.max(-32767, Math.min(32767, Math.round(((pos[i][a] - ctr[a]) / maxR) * 32767)))
		out.writeInt16LE(q, off); off += 2
	}
}
for (let j = 0; j < picked.length; j++) out.writeUInt8(assign[j], off++)
for (let j = 0; j < picked.length; j++) out.writeUInt8(weightByte[j], off++)
writeFileSync(dst, out)
console.log(`baked ${picked.length} pts (of ${total} gaussians, ${keep.length} after trim), ${K}-color palette, ${(out.length / 1024).toFixed(0)}KB -> ${dst}`)
