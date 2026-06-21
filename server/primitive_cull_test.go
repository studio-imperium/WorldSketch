package main

import "testing"

func box(color string) Primitive {
	return Primitive{
		Type:     "box",
		Position: Vec3{0, 0, 0},
		Rotation: Vec3{0, 0, 0},
		Scale:    Vec3{4, 4, 4}, // half-extent 2 in each axis
		Color:    color,
	}
}

func TestColorCull(t *testing.T) {
	prims := []Primitive{box("#508040")} // green ~ (80,128,64)

	greenInside := Point{X: 0, Y: 0, Z: 0, R: 80, G: 128, B: 64}
	nearGreen := Point{X: 0.5, Y: 0, Z: 0.5, R: 90, G: 140, B: 70}
	whiteInside := Point{X: 0, Y: 0, Z: 0, R: 255, G: 255, B: 255} // position-supported but vastly off-colour
	farPoint := Point{X: 10, Y: 10, Z: 10, R: 80, G: 128, B: 64}   // right colour, wrong place

	out := cullUnsupportedPoints([]Point{greenInside, nearGreen, whiteInside, farPoint}, prims)

	kept := map[uint8]bool{}
	for _, p := range out {
		kept[p.R] = true
	}
	if len(out) != 2 {
		t.Fatalf("expected 2 kept points (green, near-green), got %d", len(out))
	}
	if !kept[80] || !kept[90] {
		t.Fatalf("expected green(80) and near-green(90) kept, got %+v", out)
	}
	if kept[255] {
		t.Fatal("white point should be colour-culled despite being inside the box")
	}
}

func TestColorCullNoColorKeepsPositionOnly(t *testing.T) {
	// Empty/invalid primitive colour disables colour culling (position-only).
	prims := []Primitive{box("")}
	white := Point{X: 0, Y: 0, Z: 0, R: 255, G: 255, B: 255}
	out := cullUnsupportedPoints([]Point{white}, prims)
	if len(out) != 1 {
		t.Fatalf("with no primitive colour, position-supported point should be kept; got %d", len(out))
	}
}
