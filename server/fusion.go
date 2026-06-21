package main

import (
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
)

func WritePLYFromViews(scene Scene, dir, path string) error {
	points := make([]Point, 0, 240000)

	for _, name := range viewNames {
		viewDir := filepath.Join(dir, "views", name)
		camera := readCamera(filepath.Join(viewDir, "camera.json"))

		rgb := readPNG(prefer(filepath.Join(viewDir, "generated_rgb.png"), filepath.Join(viewDir, "primitive_rgb.png")))
		primitiveDepth := readPNG(filepath.Join(viewDir, "primitive_depth.png"))
		generatedDepth := readPNG(prefer(filepath.Join(viewDir, "generated_depth.png"), filepath.Join(viewDir, "primitive_depth.png")))

		points = append(points, pointsFromView(camera, rgb, primitiveDepth, generatedDepth)...)
	}

	points = dedupe(points, 0.025)
	deduped := len(points)
	points = cullUnsupportedPoints(points, scene.Primitives)
	supported := len(points)
	points = cullSparsePoints(points, 0.1, 8)
	writeLog(dir, "point_filter.log", fmt.Sprintf("deduped_points=%d\nprimitive_supported_points=%d\nfiltered_points=%d\nprimitive_culled_points=%d\nsparse_culled_points=%d\n", deduped, supported, len(points), deduped-supported, supported-len(points)))
	if len(points) == 0 {
		return os.ErrInvalid
	}
	return writePointsPLY(points, path)
}

func pointsFromView(camera Camera, rgb image.Image, primitiveDepth image.Image, generatedDepth image.Image) []Point {
	bounds := primitiveDepth.Bounds()
	w := bounds.Dx()
	h := bounds.Dy()
	stride := 2

	a, b := depthFit(primitiveDepth, generatedDepth)
	points := make([]Point, 0, (w/stride)*(h/stride))
	tan := math.Tan(camera.FOV * math.Pi / 360)

	for y := 0; y < h; y += stride {
		for x := 0; x < w; x += stride {
			pd := grayAt(primitiveDepth, x, y)
			if pd < 0.01 {
				continue
			}

			nd := detailDepth(primitiveDepth, generatedDepth, x, y, a, b)

			depth := camera.Near + nd*(camera.Far-camera.Near)
			px := ((float64(x)+0.5)/float64(w)*2 - 1) * camera.Aspect * tan * depth
			py := (1 - (float64(y)+0.5)/float64(h)*2) * tan * depth
			world := add(camera.Position, add(mul(camera.Forward, depth), add(mul(camera.Right, px), mul(camera.Up, py))))
			if outside(world) {
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

func outside(p Vec3) bool {
	return p[0] < -16 || p[0] > 16 || p[1] < -1 || p[1] > 9 || p[2] < -16 || p[2] > 16
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
