package main

import "math"

func cullUnsupportedPoints(points []Point, primitives []Primitive) []Point {
	if len(primitives) == 0 {
		return points
	}

	out := make([]Point, 0, len(points))
	for _, point := range points {
		p := Vec3{point.X, point.Y, point.Z}
		for _, primitive := range primitives {
			if primitiveSupportDistance(p, primitive) <= primitiveSupportMargin(primitive) &&
				primitiveColorMatches(point, primitive) {
				out = append(out, point)
				break
			}
		}
	}
	return out
}

// colorCullThreshold is the 0-255 RGB distance (~0.6 normalized) above which a
// point is considered vastly off-colour from its primitive and gets culled.
const colorCullThreshold = 153.0

func primitiveColorMatches(point Point, primitive Primitive) bool {
	target := parseColor(primitive.Color, Color{R: -1})
	if target.R < 0 {
		return true // primitive has no usable colour — don't colour-cull
	}
	dr := float64(point.R) - target.R
	dg := float64(point.G) - target.G
	db := float64(point.B) - target.B
	return math.Sqrt(dr*dr+dg*dg+db*db) <= colorCullThreshold
}

// primitiveSupportDistance returns the signed distance from a point to the
// primitive surface: negative inside, positive outside, ~0 on the surface.
func primitiveSupportDistance(point Vec3, primitive Primitive) float64 {
	local := inversePrimitivePoint(point, primitive)
	h := primitiveHalfExtents(primitive)
	switch primitive.Type {
	case "sphere":
		return ellipsoidDistance(local, h)
	case "cylinder":
		return cylinderDistance(local, h)
	case "cone":
		return coneDistance(local, h)
	default:
		return boxDistance(local, h)
	}
}

func ellipsoidDistance(p, h Vec3) float64 {
	k0 := math.Sqrt(sq(p[0]/h[0]) + sq(p[1]/h[1]) + sq(p[2]/h[2]))
	if k0 == 0 {
		return -math.Min(h[0], math.Min(h[1], h[2]))
	}
	k1 := math.Sqrt(sq(p[0]/(h[0]*h[0])) + sq(p[1]/(h[1]*h[1])) + sq(p[2]/(h[2]*h[2])))
	return k0 * (k0 - 1) / k1
}

func cylinderDistance(p, h Vec3) float64 {
	radial := (math.Hypot(p[0]/h[0], p[2]/h[2]) - 1) * math.Min(h[0], h[2])
	axial := math.Abs(p[1]) - h[1]
	return math.Min(math.Max(radial, axial), 0) + math.Hypot(math.Max(radial, 0), math.Max(axial, 0))
}

func coneDistance(p, h Vec3) float64 {
	// Apex at +y, base (full radius) at -y; allowed radius shrinks with height.
	t := math.Min(math.Max((p[1]+h[1])/(2*h[1]), 0), 1)
	radial := (math.Hypot(p[0]/h[0], p[2]/h[2]) - (1 - t)) * math.Min(h[0], h[2])
	axial := math.Abs(p[1]) - h[1]
	return math.Min(math.Max(radial, axial), 0) + math.Hypot(math.Max(radial, 0), math.Max(axial, 0))
}

func boxDistance(p, h Vec3) float64 {
	qx := math.Abs(p[0]) - h[0]
	qy := math.Abs(p[1]) - h[1]
	qz := math.Abs(p[2]) - h[2]
	outside := math.Sqrt(sq(math.Max(qx, 0)) + sq(math.Max(qy, 0)) + sq(math.Max(qz, 0)))
	return math.Min(math.Max(qx, math.Max(qy, qz)), 0) + outside
}

func sq(v float64) float64 {
	return v * v
}

func inversePrimitivePoint(point Vec3, primitive Primitive) Vec3 {
	x := point[0] - primitive.Position[0]
	y := point[1] - primitive.Position[1]
	z := point[2] - primitive.Position[2]

	cz, sz := math.Cos(-primitive.Rotation[2]), math.Sin(-primitive.Rotation[2])
	x, y = x*cz-y*sz, x*sz+y*cz

	cy, sy := math.Cos(-primitive.Rotation[1]), math.Sin(-primitive.Rotation[1])
	x, z = x*cy+z*sy, -x*sy+z*cy

	cx, sx := math.Cos(-primitive.Rotation[0]), math.Sin(-primitive.Rotation[0])
	y, z = y*cx-z*sx, y*sx+z*cx

	return Vec3{x, y, z}
}

func primitiveHalfExtents(primitive Primitive) Vec3 {
	return Vec3{primitive.Scale[0] * 0.5, primitive.Scale[1] * 0.5, primitive.Scale[2] * 0.5}
}

func primitiveSupportMargin(primitive Primitive) float64 {
	return 0.1
}
