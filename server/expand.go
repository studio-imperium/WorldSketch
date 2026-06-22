package main

import (
	"bufio"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// minNewPixels is how much of a view a new object must cover before we bother
// inpainting/fusing it there — below this it's a stray edge pixel, not a real surface.
const minNewPixels = 25

// prepareExpansionView builds the inpaint context for one view and reports whether the
// new object is actually visible from this camera. The context is the parent's
// decorated view everywhere, with the new object's flat blockout colour composited into
// the masked region (so the masked latent has colour/shape to start from). When no new
// pixels are present it returns the parent's view path unchanged with hasNew=false.
func prepareExpansionView(viewDir, parentViewDir string) (string, bool, error) {
	parentGen := prefer(filepath.Join(parentViewDir, "generated_rgb.png"), filepath.Join(viewDir, "primitive_rgb.png"))
	mask := readPNG(filepath.Join(viewDir, "new_mask.png"))
	if mask == nil {
		return parentGen, false, nil // no mask uploaded — treat as nothing new here
	}

	parent := readPNG(parentGen)
	prim := readPNG(filepath.Join(viewDir, "primitive_rgb.png"))
	if parent == nil || prim == nil {
		return parentGen, false, nil
	}

	ctx, white := compositeContext(parent, prim, mask)
	if white < minNewPixels {
		return parentGen, false, nil
	}

	out := filepath.Join(viewDir, "context_rgb.png")
	if err := writePNG(out, ctx); err != nil {
		return "", false, err
	}
	return out, true, nil
}

// compositeContext returns parent everywhere, overwritten by prim where mask is white,
// plus the count of masked (white) pixels.
func compositeContext(parent, prim, mask image.Image) (*image.NRGBA, int) {
	b := parent.Bounds()
	w, h := b.Dx(), b.Dy()
	out := image.NewNRGBA(image.Rect(0, 0, w, h))
	white := 0
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			src := parent
			if grayAt(mask, x, y) >= 0.5 {
				src = prim
				white++
			}
			r, g, bl := rgbAt(src, x, y)
			out.Set(x, y, color.NRGBA{R: r, G: g, B: bl, A: 255})
		}
	}
	return out, white
}

func writePNG(path string, img image.Image) error {
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer file.Close()
	return png.Encode(file, img)
}

// WriteExpandedPLY fuses only the new-object pixels (those inside each view's mask) into
// points and writes them as this plot's own world.ply. Each plot is independent: the
// parent cloud is never read or merged here — the world is composed by stacking per-plot
// splats in the viewer. The output is ONLY the new tile's delta, culled tight to the new
// primitives so a tile offset from origin survives while sky/floaters are dropped.
func WriteExpandedPLY(scene Scene, dir, path string) error {
	// Cull against the NEW tile's tight AABB (not the union of all tiles) — this plot's
	// world.ply only ever holds its own content, so a wider box would just keep junk.
	min, max := expandCullBounds(scene)

	newPoints := make([]Point, 0, 120000)
	masksSeen := 0
	for _, name := range viewNames {
		viewDir := filepath.Join(dir, "views", name)
		mask := readPNG(filepath.Join(viewDir, "new_mask.png"))
		if mask == nil {
			continue
		}
		masksSeen++
		camera := readCamera(filepath.Join(viewDir, "camera.json"))
		rgb := readPNG(prefer(filepath.Join(viewDir, "generated_rgb.png"), filepath.Join(viewDir, "primitive_rgb.png")))
		primitiveDepth := readPNG(filepath.Join(viewDir, "primitive_depth.png"))
		generatedDepth := readPNG(prefer(filepath.Join(viewDir, "generated_depth.png"), filepath.Join(viewDir, "primitive_depth.png")))
		if rgb == nil || primitiveDepth == nil {
			continue
		}
		newPoints = append(newPoints, pointsFromViewMasked(camera, rgb, primitiveDepth, generatedDepth, mask, min, max)...)
	}
	// No masks anywhere means the expansion payload lost them (old worker / staging bug),
	// not a legitimately empty delta — fail rather than silently produce an empty plot.
	if masksSeen == 0 {
		return fmt.Errorf("expansion has no new-object masks in any view (masks not staged?)")
	}

	newPoints = dedupe(newPoints, envFloat("WS_DEDUPE", 0.025))
	deduped := len(newPoints)
	// Cull against the NEW primitives only — this plot is exactly the delta.
	newPoints = cullUnsupportedPoints(newPoints, scene.newPrimitives())
	supported := len(newPoints)
	newPoints = cullSparsePoints(newPoints, envFloat("WS_SPARSE_VOXEL", 0.1), envInt("WS_SPARSE_MIN_NEIGHBORS", 4))

	stats := fmt.Sprintf("new_deduped=%d\nnew_supported=%d\nnew_kept=%d\n",
		deduped, supported, len(newPoints))
	writeLog(dir, "point_filter.log", stats)
	log.Printf("expand point_filter:\n%s", stats)

	if len(newPoints) == 0 {
		return os.ErrInvalid
	}
	return writePointsPLY(newPoints, path)
}

// expandCullBounds is the keep-box for an expansion's fusion: the AABB over just the NEW
// primitives (each Position ± |Scale|/2 per axis), grown by the SAME margins
// sceneCullBounds uses. Unlike sceneCullBounds (union of every tile) it stays tight to the
// new tile, since an expansion plot's world.ply holds only its own delta. Falls back to
// sceneCullBounds when there are no new primitives (nothing to bound).
func expandCullBounds(scene Scene) (Vec3, Vec3) {
	newPrims := scene.newPrimitives()
	if len(newPrims) == 0 {
		return sceneCullBounds(scene)
	}
	var min, max Vec3
	for i, p := range newPrims {
		for ax := 0; ax < 3; ax++ {
			half := math.Abs(p.Scale[ax]) / 2
			lo := p.Position[ax] - half
			hi := p.Position[ax] + half
			if i == 0 {
				min[ax] = lo
				max[ax] = hi
				continue
			}
			if lo < min[ax] {
				min[ax] = lo
			}
			if hi > max[ax] {
				max[ax] = hi
			}
		}
	}
	// Mirror sceneCullBounds margins: min -6/-1/-6, max +6/+4/+6.
	return Vec3{min[0] - 6, min[1] - 1, min[2] - 6}, Vec3{max[0] + 6, max[1] + 4, max[2] + 6}
}

// readPointsPLY parses the ASCII PLY writePointsPLY emits (x y z r g b per vertex).
// Returns nil if the file is missing — callers treat that as "no parent points".
func readPointsPLY(path string) []Point {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	inHeader := true
	count := 0
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if inHeader {
			if strings.HasPrefix(line, "element vertex ") {
				count, _ = strconv.Atoi(strings.TrimPrefix(line, "element vertex "))
			}
			if line == "end_header" {
				inHeader = false
			}
			continue
		}
		break
	}

	points := make([]Point, 0, count)
	parse := func(line string) (Point, bool) {
		f := strings.Fields(line)
		if len(f) < 6 {
			return Point{}, false
		}
		x, e1 := strconv.ParseFloat(f[0], 64)
		y, e2 := strconv.ParseFloat(f[1], 64)
		z, e3 := strconv.ParseFloat(f[2], 64)
		r, e4 := strconv.Atoi(f[3])
		g, e5 := strconv.Atoi(f[4])
		b, e6 := strconv.Atoi(f[5])
		if e1 != nil || e2 != nil || e3 != nil || e4 != nil || e5 != nil || e6 != nil {
			return Point{}, false
		}
		return Point{X: x, Y: y, Z: z, R: clampByte(float64(r)), G: clampByte(float64(g)), B: clampByte(float64(b))}, true
	}

	// bufio.Scanner stops one line early after the header break above; re-handle the
	// current token, then continue.
	if line := strings.TrimSpace(scanner.Text()); line != "" {
		if p, ok := parse(line); ok {
			points = append(points, p)
		}
	}
	for scanner.Scan() {
		if p, ok := parse(strings.TrimSpace(scanner.Text())); ok {
			points = append(points, p)
		}
	}
	return points
}

// runExpansion is the NO-RunPod fallback for expansion (Store.Run routes to the worker
// when RunPod is configured). For per-plot independence it mirrors the one-shot/worker
// flow: the new tile is generated normally (framed on itself by the client, inheriting the
// parent's prompt for style continuity), then ONLY the new (masked) points are fused into
// this plot's own world.ply and trained. The parent cloud is never read or merged — the
// world is composed by stacking per-plot splats in the viewer; see
// docs/world-expansion-plan.md.
func (s *Store) runExpansion(id, dir string, scene Scene) {
	parentDir := filepath.Join(s.root, scene.Parent)
	if _, err := os.Stat(filepath.Join(parentDir, "scene.json")); err != nil {
		s.fail(id, fmt.Errorf("parent plot %q not found", scene.Parent))
		return
	}

	// Copy the parent's vibe: fall back to its prompt when the expansion submit didn't
	// supply one, so the new plot lands in the same stylistic basin.
	prompt := scene.Prompt
	if strings.TrimSpace(prompt) == "" {
		prompt = readScene(filepath.Join(parentDir, "scene.json")).Prompt
	}

	s.set(id, "generating images", "")
	if err := runImageGen(dir, prompt); err != nil {
		s.fail(id, err)
		return
	}
	s.setPreview(id)

	s.set(id, "estimating depth", "")
	RunDepth(dir)

	s.set(id, "fusing new plot", "")
	plyPath := filepath.Join(dir, "world.ply")
	if err := WriteExpandedPLY(scene, dir, plyPath); err != nil {
		s.fail(id, err)
		return
	}
	s.setPLY(id)
	s.setBundle(id)

	s.set(id, "training splat", "")
	if err := RunSplatTraining(dir); err != nil {
		s.fail(id, err)
		return
	}

	s.complete(id)
}

// complete marks a locally-run job done and fills in every artifact URL. Shared by the
// one-shot (Run) and expansion (runExpansion) paths.
func (s *Store) complete(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job := s.jobs[id]
	if job == nil {
		return
	}
	job.Status = "done"
	job.PlyURL = "/api/jobs/" + id + "/world.ply"
	job.CollisionURL = "/api/jobs/" + id + "/collisions.json"
	job.BundleURL = "/api/jobs/" + id + "/training-bundle.zip"
	job.PreviewURL = "/api/jobs/" + id + "/preview.png"
	job.SplatURL = "/api/jobs/" + id + "/world.splat"
	job.UpdatedAt = time.Now()
}
