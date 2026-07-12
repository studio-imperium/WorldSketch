package prompts

import (
	"encoding/json"
	"strconv"
	"strings"
)

func Ground(scene, groundColor string, extending bool) string {
	// scene = strings.TrimSpace(scene)
	// if scene == "" {
	// 	scene = "a coherent stylized natural game environment"
	// }
	// layout := " The painted floor design is a HARD LAYOUT CONSTRAINT, not a suggestion: preserve the exact positions, silhouettes, topology, curvature, width, and connectivity of all painted regions. Do not straighten, reroute, simplify, merge, split, rotate, resize, or invent terrain markings. A circular or looping river must remain circular/looping in the same place; a winding path must keep the same bends; islands, ponds, crossings, and branches must keep their exact relative layout. Only replace flat colours with matching terrain materials inside those same shapes."
	// base := "This is a flat, top-down view of ground terrain for Gaussian-splat reconstruction. Render a high-fidelity, photorealistic, evenly-lit terrain surface that FILLS the entire canvas edge to edge with NO padding, border, frame, vignette, or margin. The ground is ONE LEVEL flat surface at a single height — NO hills, mounds, dunes, slopes, ridges, banks, cliffs, terraces, or raised landforms; only a thin textured skin of natural surface detail (grass blades, moss, scattered pebbles, dirt, small cracks, twigs, leaves) and flush flat features (paths, rivers, and ponds sit level with the surrounding ground, never carved or raised)." + layout + " Use fully ambient illumination: no cast shadows, no directional sunlight, no dramatic lighting. The material and colour stay UNIFORM all the way to every edge so the terrain tiles seamlessly with no rim, fade, or detail bunching."
	// cont := ""
	// if extending {
	// 	cont = " IMPORTANT — this is an EXTENSION: the opaque (kept) part of the image is already-generated terrain that you must preserve unchanged. Paint ONLY the masked (empty) region, and make it a perfectly seamless CONTINUATION of the existing terrain across the boundary: identical materials, colours, lighting, texture grain, and scale, flowing across with NO visible seam, line, edge, or change in tone. Do NOT copy, repeat, or mirror the existing region — grow it naturally as if the whole ground had always been one continuous piece."
	// }
	return "interpret this colored plot as a floor terrain plot, should be a square plot from isometric view. Keep the EXACT same isometric camera angle and the plot's exact position, size, and diamond silhouette in frame as the input image — repaint only the plot's surface, in place. No large details like trees or anything, just small things like grass and pebbles are allowed. Stay faithful to the original details - if it is just a single color then you should probably only use one material/texture. in a polished hand-painted stylized isometric game-art style — semi-realistic yet clearly stylized, richly detailed, with soft warm painted lighting, clean readable silhouettes, saturated natural colors, and crisp storybook charm, like a high-quality cozy fantasy builder/RPG game asset. The plot surface is a seamless ground TEXTURE: every pixel within the plot must be painted terrain — absolutely no white background, empty margins, or grass clumps floating on white — with the ground continuing uniformly to the plot's four edges. The area outside the plot stays pure black."
}

// Plan asks the model to act as a level designer: turn a scene description — and
// optionally the user's top-down sketch — into a structured block-out plan (plots with
// heights + axis-aligned coloured boxes) that the client editor applies directly.
// JSON-only response.
func Plan(scene string, hasSketch bool) string {
	intro := "Turn this scene description into a build plan: \"" + scene + "\".\n"
	if hasSketch {
		intro = "The attached image is the user's TOP-DOWN SKETCH of the world they want — a hand-drawn map. Image up = -z (far), image down = +z (near), image left = -x, image right = +x. The faint grey grid on the image is the PLOT GRID: each grid square is exactly ONE 16x16 plot — pick your plot cells to mirror the sketch's grid squares (top-left grid square = the most negative ix,iz you use) and place each drawn feature on the matching plot at the matching position within it. Interpret every drawn shape or icon as a real feature (a scribbled tree icon = a tree there, a box with a roof = a cabin, a blue squiggle = water, a brown line = a path, text labels name things) and MATCH their relative positions, counts, and rough sizes. Prefer the sketch when it conflicts with the text.\n" +
			"The user describes the sketch as: \"" + scene + "\".\n"
	}
	return "You are the level designer for a block-out 3D world editor. The world is a grid of flat square plots, each 16x16 units; y is UP. " + intro +
		"Respond with ONLY a JSON object of this exact shape:\n" +
		"{\"plots\":[{\"ix\":0,\"iz\":0,\"height\":0.0}],\"ground\":\"#587553\",\"blocks\":[{\"x\":2.5,\"z\":-3.0,\"y\":0,\"sx\":1.5,\"sy\":2.0,\"sz\":1.5,\"yaw\":0,\"color\":\"#8f563b\"}]}\n" +
		"Rules:\n" +
		"- plots: 1 to 5 grid cells. ALWAYS include {\"ix\":0,\"iz\":0}. Every cell must share an edge with another listed cell. height is the plot's ground elevation in units, between -1.5 and 3. Prefer gentle IRREGULARITY over dead-flat: give at least one plot a different height (a low hill, a sunken hollow) unless the scene explicitly demands perfectly flat ground.\n" +
		"- World coordinates: plot (ix,iz) spans x from ix*16-8 to ix*16+8 and z from iz*16-8 to iz*16+8.\n" +
		"- blocks: 6 to 40 axis-aligned boxes. x,z is the block's CENTER; keep every block fully inside a listed plot (keep centers at least sx/2 or sz/2 away from plot edges). y is the height of the block's BOTTOM above the local ground surface: 0 means resting on the ground; to stack a block on another, set y to the sum of the blocks' sy below it.\n" +
		"- sx,sy,sz: box size in units, each between 0.2 and 10.\n" +
		"- yaw: rotation in degrees around the vertical axis, usually 0.\n" +
		"- color: a hex colour like \"#8f563b\". Prefer this palette: #222034 #45283c #663931 #8f563b #df7126 #d9a066 #eec39a #fbf236 #99e550 #6abe30 #37946e #4b692f #524b24 #323c39 #3f3f74 #306082 #5b6ee1 #639bff #5fcde4 #cbdbfc #ffffff #9badb7 #847e87 #696a6a #595652 #76428a #ac3232 #d95763 #d77bba #8f974a #8a6f30.\n" +
		"- Blocks that TOUCH or OVERLAP form ONE object that is generated as a single asset: build compound structures from several touching blocks (a house = wall box + overhanging roof box + door slab; a tree = trunk + one or two canopy boxes; a well = ring + posts + tiny roof). Keep SEPARATE objects at least 2 units apart so they generate as separate assets.\n" +
		"- Build 2 to 6 distinct structures that match the scene, sensibly sized (a hut 4-7 units wide and 3-5 tall, a tree 2-4 wide and 3-6 tall, a boulder 1-3 units). Spread them across the plots; do not cluster everything at the origin. Use colour to communicate material (brown trunk, green canopy, grey stone).\n" +
		"- ground: the base terrain hex colour for the whole world, matching the scene (fresh grass #587553, dry sand #d9a066, snow #cbdbfc, dark forest floor #4b692f, ...).\n" +
		"Respond with ONLY the JSON object, no other text."
}

// PlanObjects asks the model to design geometry for EACH numbered stroke-object in the
// user's sketch separately, in a LOCAL frame — the client places the designs at the
// exact drawn positions itself, so layout accuracy is deterministic.
// footprints is preformatted like "Object 1 is about 5.2 x 3.1 units; Object 2 ...".
func PlanObjects(scene, footprints string) string {
	return "You are designing block-out geometry for a 3D world editor; y is UP. The attached image is the user's TOP-DOWN SKETCH map; the faint grey grid squares are 16x16-unit plots. Each distinct drawn object is tagged with a numbered pink circle just above it.\n" +
		"The user describes the sketch as: \"" + scene + "\".\n" +
		"For EACH numbered object: identify the concrete thing it depicts (judge by its drawn shape, its ink colours, and the description), then design it as 6 to 12 axis-aligned boxes forming ONE connected structure — AT LEAST 6 boxes per object, never a minimal 1-2 box blob; use the extra boxes for real form and silhouette (a tree = trunk + several stacked/offset canopy boxes; a cabin = walls + overhanging roof slabs + door + chimney; a well = ring + posts + crossbeam + roof). Boxes must touch or overlap so they read as a single asset.\n" +
		"Coordinates are LOCAL to that object: x,z are the offsets of each box's CENTER from the object's footprint centre (0,0 is the object's middle). y is the box BOTTOM's height above the ground: 0 rests on the ground; to stack, y = sum of the sy of the boxes below. sx,sy,sz are sizes in units. yaw is degrees around vertical, usually 0.\n" +
		"Drawn footprint sizes to roughly match: " + footprints + ". Heights should be sensible for the thing (a tree 3-6 tall, a hut 3-5).\n" +
		"color: hex like \"#8f563b\", prefer this palette: #222034 #45283c #663931 #8f563b #df7126 #d9a066 #eec39a #fbf236 #99e550 #6abe30 #37946e #4b692f #524b24 #323c39 #3f3f74 #306082 #5b6ee1 #639bff #5fcde4 #cbdbfc #ffffff #9badb7 #847e87 #696a6a #595652 #76428a #ac3232 #d95763 #d77bba #8f974a #8a6f30.\n" +
		"Respond with ONLY a JSON object of this exact shape, including EVERY number:\n" +
		"{\"ground\":\"#587553\",\"objects\":{\"1\":{\"label\":\"oak tree\",\"blocks\":[{\"x\":0,\"z\":0,\"y\":0,\"sx\":1,\"sy\":2.5,\"sz\":1,\"yaw\":0,\"color\":\"#663931\"}]}}}\n" +
		"ground is the base terrain hex colour matching the sketch and description (fresh grass #587553, dry sand #d9a066, snow #cbdbfc, ...). No other text."
}

func Identify(scene string, count int) string {
	n := strconv.Itoa(count)
	return "You are analysing an isometric block-out of a 3D scene so each part can be generated as a realistic asset. The overall scene is: \"" + scene + "\". Each object is tagged with a bright numbered circle, numbered 1 to " + n + ". Do TWO things:\n1. For EACH number, name the single most likely concrete real-world object it represents as a SHORT BUT SPECIFIC phrase (about 2 to 6 words). Judge by its shape and silhouette, by its COLOURS and any painted markings, spots, stripes, or patterns on it, AND by the scene context. Always fold in the distinguishing detail you can actually see — colour, material, or a notable feature — instead of a bare category: prefer \"weathered grey granite boulder\" over \"rock\", \"red-roofed log cabin\" over \"house\", \"tall pointed pine tree\" over \"tree\". Treat a clearly painted colour as a real cue (red spots on a bush = berries, blue top on a post = a lantern, etc.). Use the scene only to disambiguate; \n2. Describe the GROUND terrain — the flat surface the objects sit on — as a short, concrete phrase naming its material and surface detail, e.g. \"mossy forest floor\", \"cracked dry desert sand\", \"wet cobblestone path\", \"short green meadow grass\". Base it on the painted ground colour/markings and the scene.\nRespond with ONLY a JSON object of the form {\"objects\":{\"1\":\"tall pointed pine tree\",\"2\":\"bush dotted with red berries\"},\"ground\":\"mossy forest floor with scattered pebbles\"}, with no other text. Include every number from 1 to " + n + " in \"objects\"."
}

func ParseIdentify(raw string) (map[string]string, string) {
	s := strings.TrimSpace(raw)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	s = strings.TrimSpace(s)

	var full struct {
		Objects map[string]string `json:"objects"`
		Labels  map[string]string `json:"labels"`
		Ground  string            `json:"ground"`
		Terrain string            `json:"terrain"`
	}
	if err := json.Unmarshal([]byte(s), &full); err == nil {
		labels := full.Objects
		if labels == nil {
			labels = full.Labels
		}
		ground := strings.TrimSpace(full.Ground)
		if ground == "" {
			ground = strings.TrimSpace(full.Terrain)
		}
		if labels != nil || ground != "" {
			if labels == nil {
				labels = map[string]string{}
			}
			return labels, ground
		}
	}

	labels := map[string]string{}
	if err := json.Unmarshal([]byte(s), &labels); err == nil {
		return labels, ""
	}
	return map[string]string{}, ""
}

func ImageFor(kind, userPrompt, groundColor, label string) string {
	scene := strings.TrimSpace(userPrompt)
	if scene == "" {
		scene = "a coherent stylized natural game environment"
	}
	if kind == "floor" {
		return Floor(scene, groundColor)
	}
	if kind == "scene" {
		return Scene(scene)
	}
	return Object(scene, label)
}

// Scene re-textures the complete one-plot block-out in a single image edit. Layout and
// camera preservation are deliberately strict because the edited image is reconstructed
// as one splat and fitted back onto the complete block-out bounds.
func Scene(scene string) string {
	return "Image 1 is the exact isometric geometry and color guide for ONE COMPLETE 3D ENVIRONMENT on a flat, hand-drawn ground shape. Re-texture the ENTIRE image as this scene: \"" + scene + "\". Transform the colored block structures into coherent real objects and materials that match the scene and their guide colors; transform the flat painted ground into richly textured terrain appropriate to the scene. Use a polished hand-painted stylized isometric game-art style — semi-realistic, richly detailed, soft ambient lighting, clean readable silhouettes, saturated natural colors, and crisp storybook charm. " +
		"HARD COMPOSITION CONSTRAINTS: preserve the exact orthographic isometric camera angle, framing, the ground shape's exact position and silhouette, object count, object centers, relative sizes, heights, spacing, and overall silhouettes from Image 1. Keep every existing structure in place. Do not add, remove, duplicate, move, rotate, crop, or rearrange objects. Do not zoom or change perspective. Preserve distinct guide colors as material cues while replacing flat color with visible natural texture and fine surface detail such as bark, leaves, grass, stone, wood grain, soil, moss, and small pebbles as appropriate. The ground is EXACTLY the flat painted shape shown in Image 1 — keep its outline as drawn; do not expand, shrink, reshape, square it off, or turn it into a thick pedestal, floating island, hill, or cliff. " +
		"Everything outside the drawn ground shape must remain pure black and empty. No sky, horizon, background scenery, border, frame, text, labels, UI, cast shadow outside the ground, or extra ground plane. The final image must show the complete textured environment fully inside the frame in exactly the input pose, ready for single-image Gaussian-splat reconstruction."
}

func Object(scene, label string) string {
	subject := "a single object that fits this scene"
	if label != "" {
		subject = "a single " + label
	}
	return "Using the same proportions and colors as Image 1, transform the geometric structure into " + subject + ", in a polished hand-painted stylized isometric game-art style — semi-realistic yet clearly stylized, richly detailed, with soft warm painted lighting, clean readable silhouettes, saturated natural colors, and crisp storybook charm, like a high-quality cozy fantasy builder/RPG game asset. Keep in mind input structure will be made of cubes, output should be interpreted into an actual object without the cube structure. The object must appear completely alone — no floor, no ground plane, no shadow beneath it, no background scenery — just the isolated object on a pure black background."
}

func Floor(scene, groundColor string) string {
	ground := ""
	if groundColor != "" {
		ground = " The ground/baseplate input colour is " + groundColor + "; preserve that ground hue and material category. If it is sandy, tan, yellow, beige, orange, or brown, the ground must become sand, dry soil, clay, stone, or desert terrain, never green grass. If it is green, use grass, moss, or foliage in that same green tone."
	}
	layout := " Image 2, when provided, is a flat painted material-ID map and must be treated as a HARD LAYOUT CONSTRAINT. Preserve the exact positions, silhouettes, topology, curvature, width, and connectivity of all painted regions. Do not straighten, reroute, simplify, merge, split, rotate, resize, or invent terrain markings. A circular or looping river must remain circular/looping in the same place; a winding path must keep the same bends; islands, ponds, crossings, and branches must keep their exact relative layout. BLUE marks water (a flat river, stream, or pond), BROWN or TAN marks a dirt path or sand, GREY or DARK marks rock or stone, GREEN marks grass or moss. Change only the material/detail inside those same painted shapes."
	return "Re-texture this isometric view of a single flat, square ground tile into a high-fidelity, photorealistic terrain surface for Gaussian-splat reconstruction. The ground stays a single LEVEL surface at one height — NO hills, mounds, dunes, ridges, raised banks, embankments, slopes, terraces, plateaus, cliffs, craters, or other large 3D landforms; the overall plane does not rise or dip. Shallow SURFACE TEXTURE and natural detail are very welcome and encouraged, though: grass blades, moss, scattered pebbles, small stones, dirt clods, twigs, leaves, cracks, and fine material grain make the ground lively and dynamic — just keep that detail as a thin textured skin on the flat plane, never built up into raised terrain. Rivers, paths, and ponds read as essentially flat changes of colour and material: a river or pond water surface sits flush and level (not a deep carved canyon, not raised banks), and a path is flush with the surrounding grass. The tile itself is a thin flat slab — never a tall block, plinth, wall, or pedestal — and a perfect square with straight edges and square corners. Change MATERIALS and surface detail ONLY, preserving the exact square footprint. The square must FILL the canvas: its corners reach the image edges with NO empty padding, NO transparent margin, and NO border between the tile and the image edge (the splat is scaled to the canvas, so any padding breaks scale alignment with the colliders). Image 1 is the isometric geometry guide." + layout + ground + " The ground material and colour must be UNIFORM all the way to the four edges (except where painted terrain runs off an edge): no color shift, no fade, no darker rim, no vignette, no detail bunching, so adjacent tiles tile seamlessly. Render as flat, evenly-lit albedo with fully ambient illumination: no cast shadows, no directional sunlight, no dramatic lighting (fine surface texture and shallow material detail are welcome — just avoid shading that reads as hills or raised landforms). The area outside the square tile must be pure black and empty: no background, no walls, no sky, no scenery. No UI, text, frames, or camera-angle change. Scene context: " + scene
}

func FloorTexture(scene, groundColor string, extending bool) string {
	scene = strings.TrimSpace(scene)
	if scene == "" {
		scene = "a coherent stylized natural game environment"
	}
	ground := ""
	if groundColor != "" {
		ground = " The base ground colour is " + groundColor + "; preserve that hue and material category. If it is green, render grass, moss, or foliage in that green family. If it is tan, yellow, beige, orange, or brown, render sand, dry soil, clay, dirt, or desert terrain, never green grass."
	}
	cont := ""
	if extending {
		cont = " IMPORTANT — this is an EXTENSION: the opaque (kept) part of the image is already-generated terrain that you must preserve unchanged. Paint ONLY the masked (empty) region, and make it a perfectly seamless CONTINUATION of the existing terrain across the boundary: identical materials, colours, lighting, texture grain, and scale, flowing across with NO visible seam, line, edge, or change in tone. Do NOT copy, repeat, or mirror the existing region — grow it naturally as if the whole ground had always been one continuous piece."
	}
	return "Image 1 is a FLAT TOP-DOWN material and layout map for one square floor tile. Create a more realistic TOP-DOWN terrain texture from it, preserving the exact layout pixel-for-pixel in position and topology. The output must remain a square top-down orthographic texture, not perspective, not isometric, not 3D. Preserve the exact positions, silhouettes, curvature, widths, connectivity, and edge crossings of every painted region. Do not straighten, reroute, simplify, merge, split, rotate, resize, offset, or invent terrain shapes. A circular or looping river must remain circular/looping in the same place; a winding path must keep the same bends; islands, ponds, crossings, branches, and shoreline contours must keep their exact relative layout. BLUE regions become flat water; BROWN or TAN regions become dirt, sand, or path material; GREY or DARK regions become stone or rock; GREEN regions become grass or moss. Change only the material detail inside those same shapes. Every material — including water — must show visible painted texture everywhere: water gets ripples, a depth gradient, and soft shore lapping, never one flat uniform fill; large sand or dirt areas get grain, pebbles, and tonal variation. The overall terrain stays LEVEL — no hills, banks, cliffs, walls, objects, labels, UI, border, padding, vignette, or frame — but the SURFACE must read subtly three-dimensional, not flat: grass with visible tufts and slight height variation catching soft ambient light, paths and trails worn slightly LOWER than the surrounding grass with gentle ambient-occlusion shading along their edges, stones, roots, and clumps slightly raised with soft contact shadows. Use only soft, even, ambient top-light — no directional sun, no long cast shadows. Fill the entire image edge to edge, and keep materials seamless at the four edges except where a painted feature exits the tile." + ground +
		" Use a polished hand-painted stylized game-art style — semi-realistic yet clearly stylized, richly detailed, soft ambient light, clean readable silhouettes, saturated natural colors, and crisp storybook charm." +
		cont + " Scene context: " + scene
}
