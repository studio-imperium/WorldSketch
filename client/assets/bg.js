// Animated pixel-wave background — WebGL port of the old canvas-2D version.
// Same pattern: the screen is quantized into 8px cells and each cell switches on
// when six directions of cos(dir·p + offset) sum past a threshold. The 2D port
// walked every cell on the CPU each frame; here one fragment shader evaluates
// all cells on the GPU, so the page's main thread does nothing but tick a clock.
//
// The shader also bakes in the landing-page fade: fully opaque at the bottom of
// the viewport, fully transparent at the top. Scrolling fades the whole layer
// out — gone entirely after about half a viewport — and pauses the render loop.

const PIXEL = 8 // CSS px per pattern cell (the retro chunkiness — do not DPR-scale)
const ZOOM = 16
const SPEED = 13 // offset units per frame, /128 — matches the 2D version's tempo
const SEED = 5.6 // 6 wave directions spread over 2π/5.6 steps (the .6 skews them)
const COLOR = "#0d0d0c" // ink — the project accent
const SCROLL_FADE_PX = () => window.innerHeight * 0.5 // fully gone after this much scroll

const canvas = document.createElement("canvas")
canvas.setAttribute("aria-hidden", "true")
canvas.style.cssText = "position: fixed; inset: 0; z-index: -1; pointer-events: none;"
const gl = canvas.getContext("webgl", { alpha: true, antialias: false, depth: false, stencil: false })

if (gl) {
	document.body.prepend(canvas)

	const FRAG = `
		precision mediump float;
		uniform vec2 uRes;
		uniform float uOffset;
		const float TAU = 6.28318530718;

		void main() {
			// Canvas-2D orientation (y down) and the old loop's centered coordinates.
			vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
			vec2 cell = floor((frag - uRes * 0.5) / ${PIXEL.toFixed(1)}) * ${PIXEL.toFixed(1)};
			vec2 p = cell / ${ZOOM.toFixed(1)};

			float sum = 0.0;
			float angle = TAU;
			for (int i = 0; i < ${Math.ceil(SEED)}; i++) {
				sum += cos(cos(angle) * p.x + sin(angle) * p.y + uOffset) * 100.0;
				angle -= TAU / ${SEED};
			}
			float on = step(0.5, sum / ${SEED});

			// 100% opacity at the viewport bottom, 0% at the top.
			float fade = clamp(frag.y / uRes.y, 0.0, 1.0);
			gl_FragColor = vec4(${hexToGlsl(COLOR)}, 1.0) * (on * fade); // premultiplied
		}`

	const VERT = "attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }"

	const program = gl.createProgram()
	for (const [type, source] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]]) {
		const shader = gl.createShader(type)
		gl.shaderSource(shader, source)
		gl.compileShader(shader)
		gl.attachShader(program, shader)
	}
	gl.linkProgram(program)
	gl.useProgram(program)

	gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
	const aPos = gl.getAttribLocation(program, "aPos")
	gl.enableVertexAttribArray(aPos)
	gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

	const uRes = gl.getUniformLocation(program, "uRes")
	const uOffset = gl.getUniformLocation(program, "uOffset")

	let offset = 0
	let raf = 0
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")

	function resize() {
		canvas.width = window.innerWidth
		canvas.height = window.innerHeight
		gl.viewport(0, 0, canvas.width, canvas.height)
		gl.uniform2f(uRes, canvas.width, canvas.height)
		draw()
	}

	function draw() {
		gl.uniform1f(uOffset, offset)
		gl.drawArrays(gl.TRIANGLES, 0, 3)
	}

	function tick() {
		raf = 0
		offset += SPEED / 128
		draw()
		if (!reducedMotion.matches) raf = requestAnimationFrame(tick)
	}

	// Scroll a bit and the layer leaves entirely; the loop pauses while it is gone.
	function applyScroll() {
		const opacity = Math.max(0, 1 - window.scrollY / SCROLL_FADE_PX())
		canvas.style.opacity = String(opacity)
		canvas.style.visibility = opacity ? "visible" : "hidden"
		if (opacity && !raf && !reducedMotion.matches) raf = requestAnimationFrame(tick)
		if (!opacity && raf) { cancelAnimationFrame(raf); raf = 0 }
	}

	window.addEventListener("resize", () => { resize(); applyScroll() })
	window.addEventListener("scroll", applyScroll, { passive: true })
	reducedMotion.addEventListener?.("change", applyScroll)

	resize()
	applyScroll()
}

function hexToGlsl(hex) {
	const n = parseInt(hex.slice(1), 16)
	return [16, 8, 0].map(shift => (((n >> shift) & 255) / 255).toFixed(4)).join(", ")
}
