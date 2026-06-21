package main

import (
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
)

func WriteEdgeMap(src, dst string) {
	img := readPNG(src)
	bounds := img.Bounds()
	out := image.NewGray(bounds)

	for y := bounds.Min.Y + 1; y < bounds.Max.Y-1; y++ {
		for x := bounds.Min.X + 1; x < bounds.Max.X-1; x++ {
			gx := -luma(img, x-1, y-1) + luma(img, x+1, y-1) - 2*luma(img, x-1, y) + 2*luma(img, x+1, y) - luma(img, x-1, y+1) + luma(img, x+1, y+1)
			gy := -luma(img, x-1, y-1) - 2*luma(img, x, y-1) - luma(img, x+1, y-1) + luma(img, x-1, y+1) + 2*luma(img, x, y+1) + luma(img, x+1, y+1)
			if math.Hypot(gx, gy) > 0.16 {
				out.SetGray(x, y, color.Gray{Y: 255})
			}
		}
	}

	file, _ := os.Create(dst)
	defer file.Close()
	png.Encode(file, out)
}

func luma(img image.Image, x, y int) float64 {
	r, g, b, _ := img.At(x, y).RGBA()
	return 0.2126*float64(r)/65535 + 0.7152*float64(g)/65535 + 0.0722*float64(b)/65535
}

// WriteDepthControl converts the captured primitive depth (near = dark, background
// = black) into the convention the SD1.5 depth ControlNet expects (near = bright,
// far/background = dark) by inverting object pixels and leaving the background black.
func WriteDepthControl(src, dst string) {
	img := readPNG(src)
	if img == nil {
		return
	}
	bounds := img.Bounds()
	out := image.NewGray(bounds)

	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			d := grayAt(img, x, y)
			if d < 0.01 {
				continue // background stays black (far)
			}
			v := (1 - d) * 255
			if v < 0 {
				v = 0
			}
			if v > 255 {
				v = 255
			}
			out.SetGray(x, y, color.Gray{Y: uint8(v)})
		}
	}

	file, _ := os.Create(dst)
	defer file.Close()
	png.Encode(file, out)
}
