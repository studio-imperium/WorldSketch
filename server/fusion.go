package main

import (
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"
)

func WritePLYFromViews(scene Scene, dir, path string) error {
	points := make([]Point, 0, 240000)
	min, max := sceneCullBounds(scene)

	for _, name := range viewNames {
		viewDir := filepath.Join(dir, "views", name)
		camera := readCamera(filepath.Join(viewDir, "camera.json"))

		rgb := readPNG(prefer(filepath.Join(viewDir, "generated_rgb.png"), filepath.Join(viewDir, "primitive_rgb.png")))
		primitiveDepth := readPNG(filepath.Join(viewDir, "primitive_depth.png"))
		generatedDepth := readPNG(prefer(filepath.Join(viewDir, "generated_depth.png"), filepath.Join(viewDir, "primitive_depth.png")))

		points = append(points, pointsFromViewMasked(camera, rgb, primitiveDepth, generatedDepth, nil, min, max)...)
	}

	points = dedupe(points, envFloat("WS_DEDUPE", 0.015))
	deduped := len(points)
	points = cullUnsupportedPoints(points, scene.Primitives)
	supported := len(points)
	points = cullSparsePoints(points, envFloat("WS_SPARSE_VOXEL", 0.1), envInt("WS_SPARSE_MIN_NEIGHBORS", 4))
	stats := fmt.Sprintf("deduped_points=%d\nprimitive_supported_points=%d\nfiltered_points=%d\nprimitive_culled_points=%d\nsparse_culled_points=%d\n", deduped, supported, len(points), deduped-supported, supported-len(points))
	writeLog(dir, "point_filter.log", stats)
	log.Printf("point_filter:\n%s", stats) // surface in the worker log
	if len(points) == 0 {
		return os.ErrInvalid
	}
	return writePointsPLY(points, path)
}

func pointsFromView(camera Camera, rgb image.Image, primitiveDepth image.Image, generatedDepth image.Image) []Point {
	min, max := defaultCullBounds()
	return pointsFromViewMasked(camera, rgb, primitiveDepth, generatedDepth, nil, min, max)
}

// pointsFromViewMasked unprojects a view to world points, keeping only points inside
// [min,max] (the scene bounds + margin — this is what makes adjacent plots possible:
// the keep-region grows with the world instead of a fixed ±16 box). When mask is
// non-nil, only pixels where the mask is bright (white = new object) are emitted — this
// is how expansion fuses just the delta and leaves the existing world's points untouched.
func pointsFromViewMasked(camera Camera, rgb image.Image, primitiveDepth image.Image, generatedDepth image.Image, mask image.Image, lo, hi Vec3) []Point {
	bounds := primitiveDepth.Bounds()
	w := bounds.Dx()
	h := bounds.Dy()
	stride := max(envInt("WS_FUSION_STRIDE", 1), 1)

	a, b := depthFit(primitiveDepth, generatedDepth)
	points := make([]Point, 0, (w/stride)*(h/stride))
	tan := math.Tan(camera.FOV * math.Pi / 360)

	for y := 0; y < h; y += stride {
		for x := 0; x < w; x += stride {
			if mask != nil && grayAt(mask, x, y) < 0.5 {
				continue // outside the new-object region — belongs to the frozen world
			}
			pd := grayAt(primitiveDepth, x, y)
			if pd < 0.01 {
				continue
			}

			nd := detailDepth(primitiveDepth, generatedDepth, x, y, a, b)

			depth := camera.Near + nd*(camera.Far-camera.Near)
			px := ((float64(x)+0.5)/float64(w)*2 - 1) * camera.Aspect * tan * depth
			py := (1 - (float64(y)+0.5)/float64(h)*2) * tan * depth
			world := add(camera.Position, add(mul(camera.Forward, depth), add(mul(camera.Right, px), mul(camera.Up, py))))
			if outside(world, lo, hi) {
				continue
			}

			r, g, bl := rgbAt(rgb, x, y)
			if r+g+bl < 8 {
				continue
			}

			points = append(points, Point{X: world[0], Y: world[1], Z: world[2], R: r, G: g, B: bl})
		}
	}

	return points
}

func detailDepth(primitiveDepth image.Image, generatedDepth image.Image, x, y int, a, b float64) float64 {
	pd := grayAt(primitiveDepth, x, y)
	gd := clamp01(a*grayAt(generatedDepth, x, y) + b)
	local := blurredGeneratedDepth(generatedDepth, x, y, a, b)
	detail := clamp(gd-local, -0.045, 0.045)
	return clamp01(pd + detail*0.35)
}

func blurredGeneratedDepth(img image.Image, x, y int, a, b float64) float64 {
	bounds := img.Bounds()
	var sum float64
	var n float64
	for yy := y - 8; yy <= y+8; yy += 4 {
		if yy < bounds.Min.Y || yy >= bounds.Max.Y {
			continue
		}
		for xx := x - 8; xx <= x+8; xx += 4 {
			if xx < bounds.Min.X || xx >= bounds.Max.X {
				continue
			}
			sum += clamp01(a*grayAt(img, xx, yy) + b)
			n++
		}
	}
	if n == 0 {
		return clamp01(a*grayAt(img, x, y) + b)
	}
	return sum / n
}

func depthFit(primitive image.Image, generated image.Image) (float64, float64) {
	bounds := primitive.Bounds()
	var n, sumX, sumY, sumXX, sumXY float64

	for y := bounds.Min.Y; y < bounds.Max.Y; y += 4 {
		for x := bounds.Min.X; x < bounds.Max.X; x += 4 {
			p := grayAt(primitive, x, y)
			if p < 0.01 {
				continue
			}
			g := grayAt(generated, x, y)
			n++
			sumX += g
			sumY += p
			sumXX += g * g
			sumXY += g * p
		}
	}

	den := n*sumXX - sumX*sumX
	if n < 32 || math.Abs(den) < 1e-8 {
		return 1, 0
	}

	a := (n*sumXY - sumX*sumY) / den
	b := (sumY - a*sumX) / n
	if math.IsNaN(a) || math.IsInf(a, 0) || math.Abs(a) > 8 {
		return 1, 0
	}
	return a, b
}

func readCamera(path string) Camera {
	var camera Camera
	data, _ := os.ReadFile(path)
	json.Unmarshal(data, &camera)
	return camera
}

func readPNG(path string) image.Image {
	file, _ := os.Open(path)
	defer file.Close()
	img, _ := png.Decode(file)
	return img
}

func prefer(primary, fallback string) string {
	if _, err := os.Stat(primary); err == nil {
		return primary
	}
	return fallback
}

func grayAt(img image.Image, x, y int) float64 {
	r, g, b, _ := img.At(x, y).RGBA()
	return (float64(r) + float64(g) + float64(b)) / (3 * 65535)
}

func rgbAt(img image.Image, x, y int) (uint8, uint8, uint8) {
	r, g, b, _ := color.NRGBAModel.Convert(img.At(x, y)).RGBA()
	return uint8(r >> 8), uint8(g >> 8), uint8(b >> 8)
}

func add(a, b Vec3) Vec3 {
	return Vec3{a[0] + b[0], a[1] + b[1], a[2] + b[2]}
}

func mul(a Vec3, s float64) Vec3 {
	return Vec3{a[0] * s, a[1] * s, a[2] * s}
}

func outside(p Vec3, min, max Vec3) bool {
	return p[0] < min[0] || p[0] > max[0] || p[1] < min[1] || p[1] > max[1] || p[2] < min[2] || p[2] > max[2]
}

// defaultCullBounds reproduces the original fixed ±16 (x/z) / [-1,9] (y) keep-box, used
// when no scene bounds are available (the bare pointsFromView wrapper + tests).
func defaultCullBounds() (Vec3, Vec3) {
	return Vec3{-16, -1, -16}, Vec3{16, 9, 16}
}

// sceneCullBounds expands the scene's authored bounds by a margin so fused points just
// outside a primitive's surface survive, while points from an unrelated tile far away
// (or sky/floaters) are dropped. With the default single-plot bounds this is exactly the
// original ±16 / [-1,9] box; with multiple tiles it grows to cover them all.
func sceneCullBounds(scene Scene) (Vec3, Vec3) {
	min := scene.Bounds.Min
	max := scene.Bounds.Max
	if min == (Vec3{}) && max == (Vec3{}) {
		return defaultCullBounds()
	}
	return Vec3{min[0] - 6, min[1] - 1, min[2] - 6}, Vec3{max[0] + 6, max[1] + 4, max[2] + 6}
}

func clamp01(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

func clamp(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}
