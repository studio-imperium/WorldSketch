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

	unmasked := pointsFromView(cam, rgb, depth, depth)
	allWhite := pointsFromViewMasked(cam, rgb, depth, depth, whiteMask)
	allBlack := pointsFromViewMasked(cam, rgb, depth, depth, blackMask)

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

func TestWriteExpandedPLYMergesOntoParent(t *testing.T) {
	root := t.TempDir()
	parentDir := filepath.Join(root, "parent")
	dir := filepath.Join(root, "child")
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		t.Fatal(err)
	}

	parentPts := []Point{
		{X: 0, Y: 0, Z: -5, R: 1, G: 2, B: 3},
		{X: 1, Y: 0, Z: -5, R: 1, G: 2, B: 3},
		{X: 2, Y: 0, Z: -5, R: 1, G: 2, B: 3},
	}
	if err := writePointsPLY(parentPts, filepath.Join(parentDir, "world.ply")); err != nil {
		t.Fatal(err)
	}

	// One view with a fully-white mask → new points get fused.
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
	if err := WriteExpandedPLY(scene, dir, parentDir, out); err != nil {
		t.Fatal(err)
	}
	merged := readPointsPLY(out)
	if len(merged) <= len(parentPts) {
		t.Fatalf("merged cloud should exceed parent (%d) after fusing new points, got %d", len(parentPts), len(merged))
	}
}

func TestWriteExpandedPLYEmptyMaskKeepsParentOnly(t *testing.T) {
	root := t.TempDir()
	parentDir := filepath.Join(root, "parent")
	dir := filepath.Join(root, "child")
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		t.Fatal(err)
	}
	parentPts := []Point{{X: 0, Y: 0, Z: -5, R: 9, G: 9, B: 9}}
	if err := writePointsPLY(parentPts, filepath.Join(parentDir, "world.ply")); err != nil {
		t.Fatal(err)
	}
	makeView(t, dir, "front", 0) // all-black mask → no new points

	scene := Scene{Parent: "parent", Primitives: []Primitive{{Type: "box", Scale: Vec3{1, 1, 1}}}}
	out := filepath.Join(dir, "world.ply")
	if err := WriteExpandedPLY(scene, dir, parentDir, out); err != nil {
		t.Fatal(err)
	}
	if got := readPointsPLY(out); len(got) != len(parentPts) {
		t.Fatalf("empty-mask expansion should preserve exactly the parent cloud, want %d got %d", len(parentPts), len(got))
	}
}

func TestWriteExpandedPLYNoParentNoNewIsInvalid(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "child")
	makeView(t, dir, "front", 0) // no parent ply, no new points
	scene := Scene{Parent: "missing", Primitives: []Primitive{{Type: "box", Scale: Vec3{1, 1, 1}}}}
	if err := WriteExpandedPLY(scene, dir, filepath.Join(root, "missing"), filepath.Join(dir, "world.ply")); err == nil {
		t.Fatal("expected an error when there are neither parent nor new points")
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

func abs(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}
