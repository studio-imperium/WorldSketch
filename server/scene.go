package main

type Scene struct {
	Version    int         `json:"version"`
	Prompt     string      `json:"prompt,omitempty"`
	Bounds     Bounds      `json:"bounds"`
	Primitives []Primitive `json:"primitives"`
}

type Bounds struct {
	Min Vec3 `json:"min"`
	Max Vec3 `json:"max"`
}

type Primitive struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Position Vec3   `json:"position"`
	Rotation Vec3   `json:"rotation"`
	Scale    Vec3   `json:"scale"`
	Color    string `json:"color"`
}

type Vec3 [3]float64
