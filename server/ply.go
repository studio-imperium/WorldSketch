package main

import (
	"bufio"
	"fmt"
	"hash/fnv"
	"math"
	"math/rand"
	"os"
)

type Point struct {
	X float64
	Y float64
	Z float64
	R uint8
	G uint8
	B uint8
}

type Color struct {
	R float64
	G float64
	B float64
}

type voxel struct {
	X int
	Y int
	Z int
}

type acc struct {
	X float64
	Y float64
	Z float64
	R float64
	G float64
	B float64
	N float64
}

func WritePLY(scene Scene, path string, seed int64) error {
	rng := rand.New(rand.NewSource(seed))
	points := make([]Point, 0, 16000)

	for _, primitive := range scene.Primitives {
		points = append(points, samplePrimitive(primitive, rng)...)
	}

	points = dedupe(points, 0.035)
	return writePointsPLY(points, path)
}

func writePointsPLY(points []Point, path string) error {
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer file.Close()

	w := bufio.NewWriter(file)
	defer w.Flush()

	fmt.Fprintln(w, "ply")
	fmt.Fprintln(w, "format ascii 1.0")
	fmt.Fprintf(w, "element vertex %d\n", len(points))
	fmt.Fprintln(w, "property float x")
	fmt.Fprintln(w, "property float y")
	fmt.Fprintln(w, "property float z")
	fmt.Fprintln(w, "property uchar red")
	fmt.Fprintln(w, "property uchar green")
	fmt.Fprintln(w, "property uchar blue")
	fmt.Fprintln(w, "end_header")

	for _, point := range points {
		fmt.Fprintf(w, "%.5f %.5f %.5f %d %d %d\n", point.X, point.Y, point.Z, point.R, point.G, point.B)
	}

	return nil
}

func samplePrimitive(p Primitive, rng *rand.Rand) []Point {
	count := sampleCount(p)
	points := make([]Point, 0, count)
	base := parseColor(p.Color, colorForType(p.Type))

	for i := 0; i < count; i++ {
		local, normal := sampleLocal(p.Type, rng)
		detail := 0.012 + 0.028*rng.Float64()
		local[0] += normal[0] * noise3(local, float64(i)) * detail
		local[1] += normal[1] * noise3(local, float64(i)+7) * detail
		local[2] += normal[2] * noise3(local, float64(i)+13) * detail

		world := transform(local, p)
		color := shade(base, p.Type, world, rng)
		points = append(points, Point{
			X: world[0],
			Y: world[1],
			Z: world[2],
			R: clampByte(color.R),
			G: clampByte(color.G),
			B: clampByte(color.B),
		})
	}

	return points
}

func sampleCount(p Primitive) int {
	s := p.Scale
	area := s[0]*s[1] + s[0]*s[2] + s[1]*s[2]
	if p.Type == "sphere" {
		area = 4 * math.Pi * math.Pow((s[0]+s[1]+s[2])/6, 2)
	}
	count := int(math.Max(400, area*720))
	if count > 9000 {
		return 9000
	}
	return count
}

func sampleLocal(kind string, rng *rand.Rand) (Vec3, Vec3) {
	switch kind {
	case "sphere":
		u := rng.Float64()
		v := rng.Float64()
		theta := 2 * math.Pi * u
		phi := math.Acos(2*v - 1)
		n := Vec3{
			math.Sin(phi) * math.Cos(theta),
			math.Cos(phi),
			math.Sin(phi) * math.Sin(theta),
		}
		return Vec3{n[0] * 0.5, n[1] * 0.5, n[2] * 0.5}, n
	case "cylinder":
		if rng.Float64() < 0.74 {
			theta := rng.Float64() * 2 * math.Pi
			y := rng.Float64() - 0.5
			n := Vec3{math.Cos(theta), 0, math.Sin(theta)}
			return Vec3{n[0] * 0.5, y, n[2] * 0.5}, n
		}
		y := -0.5
		n := Vec3{0, -1, 0}
		if rng.Float64() < 0.5 {
			y = 0.5
			n = Vec3{0, 1, 0}
		}
		r := math.Sqrt(rng.Float64()) * 0.5
		theta := rng.Float64() * 2 * math.Pi
		return Vec3{math.Cos(theta) * r, y, math.Sin(theta) * r}, n
	case "cone":
		if rng.Float64() < 0.82 {
			theta := rng.Float64() * 2 * math.Pi
			hf := 1 - math.Sqrt(rng.Float64()) // bias toward the wider base
			radius := 0.5 * (1 - hf)
			c, s := math.Cos(theta), math.Sin(theta)
			inv := 1 / math.Sqrt(1.25) // lateral normal: horizontal 1, vertical 0.5
			return Vec3{c * radius, hf - 0.5, s * radius}, Vec3{c * inv, 0.5 * inv, s * inv}
		}
		r := math.Sqrt(rng.Float64()) * 0.5
		theta := rng.Float64() * 2 * math.Pi
		return Vec3{math.Cos(theta) * r, -0.5, math.Sin(theta) * r}, Vec3{0, -1, 0}
	default:
		return sampleBoxLike(rng)
	}
}

func sampleBoxLike(rng *rand.Rand) (Vec3, Vec3) {
	face := rng.Intn(6)
	x := rng.Float64() - 0.5
	y := rng.Float64() - 0.5
	z := rng.Float64() - 0.5

	switch face {
	case 0:
		x = -0.5
	case 1:
		x = 0.5
	case 2:
		y = -0.5
	case 3:
		y = 0.5
	case 4:
		z = -0.5
	case 5:
		z = 0.5
	}

	n := Vec3{0, 0, 0}
	if face == 0 {
		n[0] = -1
	}
	if face == 1 {
		n[0] = 1
	}
	if face == 2 {
		n[1] = -1
	}
	if face == 3 {
		n[1] = 1
	}
	if face == 4 {
		n[2] = -1
	}
	if face == 5 {
		n[2] = 1
	}

	return Vec3{x, y, z}, n
}

func transform(v Vec3, p Primitive) Vec3 {
	x := v[0] * p.Scale[0]
	y := v[1] * p.Scale[1]
	z := v[2] * p.Scale[2]

	cx, sx := math.Cos(p.Rotation[0]), math.Sin(p.Rotation[0])
	cy, sy := math.Cos(p.Rotation[1]), math.Sin(p.Rotation[1])
	cz, sz := math.Cos(p.Rotation[2]), math.Sin(p.Rotation[2])

	y, z = y*cx-z*sx, y*sx+z*cx
	x, z = x*cy+z*sy, -x*sy+z*cy
	x, y = x*cz-y*sz, x*sz+y*cz

	return Vec3{x + p.Position[0], y + p.Position[1], z + p.Position[2]}
}

func shade(base Color, kind string, p Vec3, rng *rand.Rand) Color {
	v := 0.72 + rng.Float64()*0.42
	warm := 0.94 + 0.1*math.Sin(p[0]*2.1+p[2]*1.7)
	color := Color{base.R * v * warm, base.G * v, base.B * v}

	if kind == "sphere" || kind == "box" || kind == "cone" {
		crack := math.Abs(math.Sin(p[0]*9.1 + p[1]*11.7 + p[2]*8.2))
		if crack > 0.93 {
			color.R *= 0.45
			color.G *= 0.45
			color.B *= 0.45
		}
	}

	if kind == "cylinder" {
		bark := 0.5 + 0.5*math.Sin(math.Atan2(p[2], p[0])*12+p[1]*8)
		color.R = mix(color.R, 82, bark*0.35)
		color.G = mix(color.G, 58, bark*0.25)
		color.B = mix(color.B, 38, bark*0.2)
	}

	return color
}

func dedupe(points []Point, size float64) []Point {
	cells := map[voxel]*acc{}
	for _, point := range points {
		key := voxel{
			X: int(math.Floor(point.X / size)),
			Y: int(math.Floor(point.Y / size)),
			Z: int(math.Floor(point.Z / size)),
		}
		cell := cells[key]
		if cell == nil {
			cell = &acc{}
			cells[key] = cell
		}
		cell.X += point.X
		cell.Y += point.Y
		cell.Z += point.Z
		cell.R += float64(point.R)
		cell.G += float64(point.G)
		cell.B += float64(point.B)
		cell.N++
	}

	out := make([]Point, 0, len(cells))
	for _, cell := range cells {
		n := cell.N
		out = append(out, Point{
			X: cell.X / n,
			Y: cell.Y / n,
			Z: cell.Z / n,
			R: clampByte(cell.R / n),
			G: clampByte(cell.G / n),
			B: clampByte(cell.B / n),
		})
	}
	return out
}

func cullSparsePoints(points []Point, size float64, minNeighbors int) []Point {
	if len(points) == 0 {
		return points
	}

	cells := map[voxel]int{}
	keys := make([]voxel, len(points))
	for i, point := range points {
		key := voxel{
			X: int(math.Floor(point.X / size)),
			Y: int(math.Floor(point.Y / size)),
			Z: int(math.Floor(point.Z / size)),
		}
		keys[i] = key
		cells[key]++
	}

	out := make([]Point, 0, len(points))
	for i, point := range points {
		neighbors := 0
		key := keys[i]
		for x := -1; x <= 1; x++ {
			for y := -1; y <= 1; y++ {
				for z := -1; z <= 1; z++ {
					neighbors += cells[voxel{X: key.X + x, Y: key.Y + y, Z: key.Z + z}]
				}
			}
		}
		if neighbors >= minNeighbors {
			out = append(out, point)
		}
	}
	return out
}

func parseColor(hex string, fallback Color) Color {
	var r, g, b uint8
	if len(hex) == 7 && hex[0] == '#' {
		_, err := fmt.Sscanf(hex, "#%02x%02x%02x", &r, &g, &b)
		if err == nil {
			return Color{float64(r), float64(g), float64(b)}
		}
	}
	return fallback
}

func colorForType(kind string) Color {
	switch kind {
	case "sphere":
		return Color{122, 117, 108}
	case "cylinder":
		return Color{112, 86, 57}
	case "cone":
		return Color{142, 130, 106}
	default:
		return Color{137, 137, 137}
	}
}

func clampByte(value float64) uint8 {
	if value < 0 {
		return 0
	}
	if value > 255 {
		return 255
	}
	return uint8(value)
}

func mix(a, b, t float64) float64 {
	return a + (b-a)*t
}

func noise3(v Vec3, salt float64) float64 {
	return math.Sin(v[0]*12.9898+v[1]*78.233+v[2]*37.719+salt*19.19) * 0.5
}

func SeedFromString(value string) int64 {
	hash := fnv.New64a()
	hash.Write([]byte(value))
	return int64(hash.Sum64())
}

func ComfySeedFromString(value string) uint64 {
	hash := fnv.New64a()
	hash.Write([]byte(value))
	return hash.Sum64()
}
