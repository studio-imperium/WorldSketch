package palette

import (
	"bytes"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"math"
	"strconv"
	"strings"
)

func Match(srcPNG, dstPNG []byte, strength float64) ([]byte, error) {
	src, err := decodeRGBA(srcPNG)
	if err != nil {
		return nil, fmt.Errorf("decode source: %w", err)
	}
	dst, err := decodeRGBA(dstPNG)
	if err != nil {
		return nil, fmt.Errorf("decode target: %w", err)
	}
	sMean, sStd, sN := labStats(src)
	dMean, dStd, dN := labStats(dst)
	if sN == 0 || dN == 0 {
		return dstPNG, nil
	}
	b := dst.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			i := dst.PixOffset(x, y)
			r, g, bl := dst.Pix[i], dst.Pix[i+1], dst.Pix[i+2]
			if isBackground(r, g, bl) {
				continue
			}
			l, a, bb := rgbToLab(r, g, bl)
			a = transferChannel(a, dMean[1], dStd[1], sMean[1], sStd[1], strength)
			bb = transferChannel(bb, dMean[2], dStd[2], sMean[2], sStd[2], strength)
			nr, ng, nb := labToRGB(l, a, bb)
			dst.Pix[i], dst.Pix[i+1], dst.Pix[i+2] = nr, ng, nb
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, dst); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func ParseColors(csv string) [][3]float64 {
	var out [][3]float64
	for _, token := range strings.Split(csv, ",") {
		token = strings.TrimPrefix(strings.TrimSpace(token), "#")
		if len(token) != 6 {
			continue
		}
		r, e1 := strconv.ParseUint(token[0:2], 16, 8)
		g, e2 := strconv.ParseUint(token[2:4], 16, 8)
		b, e3 := strconv.ParseUint(token[4:6], 16, 8)
		if e1 != nil || e2 != nil || e3 != nil {
			continue
		}
		l, a, bb := rgbToLab(uint8(r), uint8(g), uint8(b))
		out = append(out, [3]float64{l, a, bb})
	}
	return out
}

func Lock(dstPNG, maskPNG []byte, palette [][3]float64, strength, lightnessLock float64) ([]byte, error) {
	if len(palette) == 0 {
		return dstPNG, nil
	}
	lightnessLock = math.Max(0, math.Min(1, lightnessLock))
	dst, err := decodeRGBA(dstPNG)
	if err != nil {
		return nil, fmt.Errorf("decode target: %w", err)
	}
	var mask *image.RGBA
	if len(maskPNG) > 0 {
		if mask, err = decodeRGBA(maskPNG); err != nil {
			return nil, fmt.Errorf("decode mask: %w", err)
		}
	}
	b := dst.Bounds()
	mb := b
	if mask != nil {
		mb = mask.Bounds()
	}
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			if mask != nil {
				mx := mb.Min.X + (x-b.Min.X)*mb.Dx()/b.Dx()
				my := mb.Min.Y + (y-b.Min.Y)*mb.Dy()/b.Dy()
				if mask.Pix[mask.PixOffset(mx, my)+3] >= 128 {
					continue
				}
			}
			i := dst.PixOffset(x, y)
			r, g, bl := dst.Pix[i], dst.Pix[i+1], dst.Pix[i+2]
			if isBackground(r, g, bl) {
				continue
			}
			l, a, bb := rgbToLab(r, g, bl)
			p := nearestLab(palette, a, bb)
			nl := l + (p[0]-l)*lightnessLock
			na := a + (p[1]-a)*strength
			nbb := bb + (p[2]-bb)*strength
			nr, ng, nb := labToRGB(nl, na, nbb)
			dst.Pix[i], dst.Pix[i+1], dst.Pix[i+2] = nr, ng, nb
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, dst); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func nearestLab(palette [][3]float64, a, b float64) [3]float64 {
	best := palette[0]
	bestD := math.Inf(1)
	for _, p := range palette {
		da := p[1] - a
		db := p[2] - b
		if d := da*da + db*db; d < bestD {
			bestD = d
			best = p
		}
	}
	return best
}

func transferChannel(v, mDst, sDst, mSrc, sSrc, strength float64) float64 {
	scale := 1.0
	if sDst > 1e-6 {
		scale = sSrc / sDst
	}
	scale = math.Max(0.25, math.Min(4, scale))
	matched := (v-mDst)*scale + mSrc
	return v + (matched-v)*strength
}

func decodeRGBA(b []byte) (*image.RGBA, error) {
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	if rgba, ok := img.(*image.RGBA); ok {
		return rgba, nil
	}
	rgba := image.NewRGBA(img.Bounds())
	draw.Draw(rgba, img.Bounds(), img, img.Bounds().Min, draw.Src)
	return rgba, nil
}

func labStats(img *image.RGBA) (mean, std [3]float64, n int) {
	var sum, sumSq [3]float64
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			i := img.PixOffset(x, y)
			r, g, bl := img.Pix[i], img.Pix[i+1], img.Pix[i+2]
			if isBackground(r, g, bl) {
				continue
			}
			l, a, bb := rgbToLab(r, g, bl)
			sum[0], sum[1], sum[2] = sum[0]+l, sum[1]+a, sum[2]+bb
			sumSq[0], sumSq[1], sumSq[2] = sumSq[0]+l*l, sumSq[1]+a*a, sumSq[2]+bb*bb
			n++
		}
	}
	if n == 0 {
		return mean, std, 0
	}
	for c := 0; c < 3; c++ {
		mean[c] = sum[c] / float64(n)
		variance := sumSq[c]/float64(n) - mean[c]*mean[c]
		if variance < 0 {
			variance = 0
		}
		std[c] = math.Sqrt(variance)
	}
	return mean, std, n
}

func isBackground(r, g, b uint8) bool {
	return r < 18 && g < 18 && b < 18
}

func rgbToLab(r, g, b uint8) (float64, float64, float64) {
	rl := srgbToLinear(float64(r) / 255)
	gl := srgbToLinear(float64(g) / 255)
	bl := srgbToLinear(float64(b) / 255)
	x := (rl*0.4124564 + gl*0.3575761 + bl*0.1804375) / 0.95047
	y := rl*0.2126729 + gl*0.7151522 + bl*0.0721750
	z := (rl*0.0193339 + gl*0.1191920 + bl*0.9503041) / 1.08883
	fx, fy, fz := labF(x), labF(y), labF(z)
	return 116*fy - 16, 500 * (fx - fy), 200 * (fy - fz)
}

func labToRGB(l, a, bb float64) (uint8, uint8, uint8) {
	fy := (l + 16) / 116
	fx := fy + a/500
	fz := fy - bb/200
	x := labFInv(fx) * 0.95047
	y := labFInv(fy)
	z := labFInv(fz) * 1.08883
	rl := x*3.2404542 + y*-1.5371385 + z*-0.4985314
	gl := x*-0.9692660 + y*1.8760108 + z*0.0415560
	bl := x*0.0556434 + y*-0.2040259 + z*1.0572252
	return clamp8(linearToSrgb(rl)), clamp8(linearToSrgb(gl)), clamp8(linearToSrgb(bl))
}

func labF(t float64) float64 {
	if t > 0.008856 {
		return math.Cbrt(t)
	}
	return 7.787*t + 16.0/116.0
}

func labFInv(t float64) float64 {
	if c := t * t * t; c > 0.008856 {
		return c
	}
	return (t - 16.0/116.0) / 7.787
}

func srgbToLinear(c float64) float64 {
	if c <= 0.04045 {
		return c / 12.92
	}
	return math.Pow((c+0.055)/1.055, 2.4)
}

func linearToSrgb(c float64) float64 {
	if c <= 0.0031308 {
		return c * 12.92
	}
	return 1.055*math.Pow(c, 1/2.4) - 0.055
}

func clamp8(c float64) uint8 {
	v := c * 255
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return uint8(v + 0.5)
}
