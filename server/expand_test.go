package main

import (
	"encoding/json"
	"image"
	"image/color"
	"os"
	"path/filepath"
	"testing"
)

func writeGrayPNG(t *testing.T, path string, w, h int, y uint8) {
	t.Helper()
	img := image.NewGray(image.Rect(0, 0, w, h))
	for i := range img.Pix {
		img.Pix[i] = y
	}
	if err := writePNG(path, img); err != nil {
		t.Fatal(err)
	}
}

func writeRGBPNG(t *testing.T, path string, w, h int, r, g, b uint8) {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			img.Set(x, y, color.NRGBA{R: r, G: g, B: b, A: 255})
		}
	}
	if err := writePNG(path, img); err != nil {
		t.Fatal(err)
	}
}

func testCamera() Camera {
	return Camera{
		Name: "front", Width: 64, Height: 64,
		Position: Vec3{0, 0, 0}, Forward: Vec3{0, 0, -1}, Right: Vec3{1, 0, 0}, Up: Vec3{0, 1, 0},
		FOV: 50, Aspect: 1, Near: 0.05, Far: 48,
	}
}

func TestPLYRoundTrip(t *testing.T) {
	pts := []Point{
		{X: 1.5, Y: -2.25, Z: 3.0, R: 10, G: 20, B: 30},
		{X: -4.0, Y: 0, Z: 0.125, R: 255, G: 0, B: 128},
	}
	path := filepath.Join(t.TempDir(), "round.ply")
	if err := writePointsPLY(pts, path); err != nil {
		t.Fatal(err)
	}
	got := readPointsPLY(path)
	if len(got) != len(pts) {
		t.Fatalf("round-trip count: want %d got %d", len(pts), len(got))
	}
	for i, p := range pts {
		if got[i].R != p.R || got[i].G != p.G || got[i].B != p.B {
			t.Fatalf("point %d colour mismatch: %+v vs %+v", i, got[i], p)
		}
		if abs(got[i].X-p.X) > 1e-4 || abs(got[i].Y-p.Y) > 1e-4 || abs(got[i].Z-p.Z) > 1e-4 {
			t.Fatalf("point %d position mismatch: %+v vs %+v", i, got[i], p)
		}
	}
}

func TestReadPointsPLYMissing(t *testing.T) {
	if got := readPointsPLY(filepath.Join(t.TempDir(), "nope.ply")); got != nil {
		t.Fatalf("missing ply should read as nil, got %d points", len(got))
	}
}

func TestCompositeContext(t *testing.T) {
	w, h := 4, 4
	parent := image.NewNRGBA(image.Rect(0, 0, w, h))
	prim := image.NewNRGBA(image.Rect(0, 0, w, h))
	mask := image.NewGray(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			parent.Set(x, y, color.NRGBA{R: 10, G: 10, B: 10, A: 255})
			prim.Set(x, y, color.NRGBA{R: 200, G: 200, B: 200, A: 255})
		}
	}
	// Mark the left half new.
	for y := 0; y < h; y++ {
		for x := 0; x < w/2; x++ {
			mask.SetGray(x, y, color.Gray{Y: 255})
		}
	}

	out, white := compositeContext(parent, prim, mask)
	if white != (w/2)*h {
		t.Fatalf("white count: want %d got %d", (w/2)*h, white)
	}
	// Masked pixel = prim colour; unmasked = parent colour.
	if r, _, _ := rgbAt(out, 0, 0); r != 200 {
		t.Fatalf("masked pixel should be prim colour, got %d", r)
	}
	if r, _, _ := rgbAt(out, w-1, 0); r != 10 {
		t.Fatalf("unmasked pixel should be parent colour, got %d", r)
	}
}

func TestPointsFromViewMaskGating(t *testing.T) {
	cam := testCamera()
	depth := image.NewGray(image.Rect(0, 0, 64, 64))
	rgb := image.NewNRGBA(image.Rect(0, 0, 64, 64))
	for i := range depth.Pix {
		depth.Pix[i] = 40 // ~7.6 world units deep — inside the fusion bounds
	}
	for x := 0; x < 64; x++ {
		for y := 0; y < 64; y++ {
			rgb.Set(x, y, color.NRGBA{R: 120, G: 120, B: 120, A: 255})
		}
	}

	whiteMask := image.NewGray(image.Rect(0, 0, 64, 64))
	for i := range whiteMask.Pix {
		whiteMask.Pix[i] = 255
	}
	blackMask := image.NewGray(image.Rect(0, 0, 64, 64))

	min, max := defaultCullBounds()
	unmasked := pointsFromView(cam, rgb, depth, depth)
	allWhite := pointsFromViewMasked(cam, rgb, depth, depth, whiteMask, min, max)
	allBlack := pointsFromViewMasked(cam, rgb, depth, depth, blackMask, min, max)

	if len(unmasked) == 0 {
		t.Fatal("expected some points from the synthetic view")
	}
	if len(allWhite) != len(unmasked) {
		t.Fatalf("all-white mask should match unmasked: %d vs %d", len(allWhite), len(unmasked))
	}
	if len(allBlack) != 0 {
		t.Fatalf("all-black mask should emit no points, got %d", len(allBlack))
	}
}

// makeView writes the per-view files WriteExpandedPLY reads, with a mask of the given
// brightness everywhere.
func makeView(t *testing.T, dir, name string, maskY uint8) {
	t.Helper()
	viewDir := filepath.Join(dir, "views", name)
	if err := os.MkdirAll(viewDir, 0755); err != nil {
		t.Fatal(err)
	}
	cam, _ := json.Marshal(testCamera())
	if err := os.WriteFile(filepath.Join(viewDir, "camera.json"), cam, 0644); err != nil {
		t.Fatal(err)
	}
	writeGrayPNG(t, filepath.Join(viewDir, "primitive_depth.png"), 64, 64, 40)
	writeRGBPNG(t, filepath.Join(viewDir, "generated_rgb.png"), 64, 64, 120, 120, 120)
	writeGrayPNG(t, filepath.Join(viewDir, "new_mask.png"), 64, 64, maskY)
}

func TestWriteExpandedPLYOnlyNewPoints(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "child")

	// One view with a fully-white mask → only the new (masked) points get fused. No parent
	// cloud exists or is read — each plot's world.ply holds only its own delta.
	makeView(t, dir, "front", 255)

	// Permissive scene: a big box (no colour → position-only) so the delta survives the
	// cull, and disable sparse culling for the synthetic density.
	t.Setenv("WS_SPARSE_MIN_NEIGHBORS", "0")
	scene := Scene{
		Parent: "parent",
		Primitives: []Primitive{
			{Type: "box", Position: Vec3{0, 0, -8}, Rotation: Vec3{0, 0, 0}, Scale: Vec3{64, 64, 64}, Color: ""},
		},
	}

	out := filepath.Join(dir, "world.ply")
	if err := WriteExpandedPLY(scene, dir, out); err != nil {
		t.Fatal(err)
	}
	got := readPointsPLY(out)
	if len(got) == 0 {
		t.Fatal("expected the new plot's fused points, got an empty cloud")
	}
	// Every emitted point must be one of the new tile's (z≈-8 region from the front cam),
	// never a stray parent point — there is no parent to merge.
	for _, p := range got {
		if p.R == 1 && p.G == 2 && p.B == 3 {
			t.Fatalf("found a parent-coloured point %+v — expansion must not merge any parent cloud", p)
		}
	}
}

func TestWriteExpandedPLYEmptyDeltaIsInvalid(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "child")
	makeView(t, dir, "front", 0) // all-black mask → no new points

	scene := Scene{Parent: "parent", Primitives: []Primitive{{Type: "box", Scale: Vec3{1, 1, 1}}}}
	out := filepath.Join(dir, "world.ply")
	if err := WriteExpandedPLY(scene, dir, out); err == nil {
		t.Fatal("an expansion that fuses zero new points should be invalid (no parent to fall back on)")
	}
}

func TestWriteExpandedPLYNoMasksIsInvalid(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "child")
	// A view with all the files EXCEPT new_mask.png → masksSeen==0 (staging bug), which must
	// fail rather than silently emit an empty plot.
	viewDir := filepath.Join(dir, "views", "front")
	if err := os.MkdirAll(viewDir, 0755); err != nil {
		t.Fatal(err)
	}
	cam, _ := json.Marshal(testCamera())
	if err := os.WriteFile(filepath.Join(viewDir, "camera.json"), cam, 0644); err != nil {
		t.Fatal(err)
	}
	writeGrayPNG(t, filepath.Join(viewDir, "primitive_depth.png"), 64, 64, 40)
	writeRGBPNG(t, filepath.Join(viewDir, "generated_rgb.png"), 64, 64, 120, 120, 120)

	scene := Scene{Parent: "parent", Primitives: []Primitive{{Type: "box", Scale: Vec3{1, 1, 1}}}}
	if err := WriteExpandedPLY(scene, dir, filepath.Join(dir, "world.ply")); err == nil {
		t.Fatal("expected an error when no view carries a new-object mask")
	}
}

func TestNewPrimitivesAndIsExpansion(t *testing.T) {
	scene := Scene{
		Parent: "abc",
		Primitives: []Primitive{
			{ID: "a", Existing: true},
			{ID: "b"},
			{ID: "c", Existing: true},
			{ID: "d"},
		},
	}
	if !scene.isExpansion() {
		t.Fatal("scene with a parent should be an expansion")
	}
	got := scene.newPrimitives()
	if len(got) != 2 || got[0].ID != "b" || got[1].ID != "d" {
		t.Fatalf("newPrimitives should be the non-existing ones, got %+v", got)
	}
	if (Scene{}).isExpansion() {
		t.Fatal("scene without a parent should not be an expansion")
	}
}

func TestSceneCullBounds(t *testing.T) {
	// Default single plot → the original ±16 / [-1,9] keep-box (no regression).
	def := Scene{Bounds: Bounds{Min: Vec3{-10, 0, -10}, Max: Vec3{10, 5, 10}}}
	min, max := sceneCullBounds(def)
	if min != (Vec3{-16, -1, -16}) || max != (Vec3{16, 9, 16}) {
		t.Fatalf("single-plot bounds regressed: min=%v max=%v", min, max)
	}

	// An adjacent tile out at +20 must fall INSIDE the grown keep-box (else fusion would
	// discard the whole new plot — the bug this fixes).
	tiled := Scene{Bounds: Bounds{Min: Vec3{-10, 0, -10}, Max: Vec3{30, 5, 10}}}
	tmin, tmax := sceneCullBounds(tiled)
	p := Vec3{20, 1, 0} // a point on the second tile
	if outside(p, tmin, tmax) {
		t.Fatalf("adjacent-tile point %v wrongly culled by bounds min=%v max=%v", p, tmin, tmax)
	}
	// ...and it WOULD have been culled by the old fixed box.
	dmin, dmax := defaultCullBounds()
	if !outside(p, dmin, dmax) {
		t.Fatal("expected the old fixed ±16 box to cull the adjacent-tile point (sanity check)")
	}
}

func TestExpandCullBounds(t *testing.T) {
	// Two NEW primitives offset from origin: the keep-box is their AABB grown by the
	// sceneCullBounds margins (min -6/-1/-6, max +6/+4/+6), staying tight to the tile
	// rather than the union of all tiles. Existing primitives are ignored.
	scene := Scene{
		Bounds: Bounds{Min: Vec3{-100, 0, -100}, Max: Vec3{100, 50, 100}}, // wide union — must NOT be used
		Primitives: []Primitive{
			{ID: "old", Existing: true, Position: Vec3{0, 0, 0}, Scale: Vec3{200, 200, 200}},
			{ID: "a", Position: Vec3{20, 1, 0}, Scale: Vec3{2, 2, 2}},   // [19,21] [0,2] [-1,1]
			{ID: "b", Position: Vec3{24, 3, -4}, Scale: Vec3{-4, 2, 2}}, // |scale| → [22,26] [2,4] [-5,-3]
		},
	}
	// AABB over new prims a,b: x[19,26] y[0,4] z[-5,1].
	wantMin := Vec3{19 - 6, 0 - 1, -5 - 6}
	wantMax := Vec3{26 + 6, 4 + 4, 1 + 6}
	min, max := expandCullBounds(scene)
	if min != wantMin || max != wantMax {
		t.Fatalf("expandCullBounds tile box: min=%v max=%v, want min=%v max=%v", min, max, wantMin, wantMax)
	}

	// No new primitives → fall back to sceneCullBounds (nothing to bound).
	noNew := Scene{Bounds: Bounds{Min: Vec3{-10, 0, -10}, Max: Vec3{10, 5, 10}}, Primitives: []Primitive{{ID: "x", Existing: true, Scale: Vec3{1, 1, 1}}}}
	gotMin, gotMax := expandCullBounds(noNew)
	sMin, sMax := sceneCullBounds(noNew)
	if gotMin != sMin || gotMax != sMax {
		t.Fatalf("empty newPrimitives should fall back to sceneCullBounds: got min=%v max=%v, want min=%v max=%v", gotMin, gotMax, sMin, sMax)
	}
}

func abs(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}
