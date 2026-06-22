package main

type Scene struct {
	Version    int         `json:"version"`
	Prompt     string      `json:"prompt,omitempty"`
	Parent     string      `json:"parent,omitempty"` // job id of the plot being expanded; "" = one-shot
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
	Existing bool   `json:"existing,omitempty"` // already decorated by the parent plot (frozen)
}

// newPrimitives returns only the primitives added since the parent plot — the delta to
// decorate. On a one-shot scene (nothing marked Existing) this is every primitive.
func (s Scene) newPrimitives() []Primitive {
	var out []Primitive
	for _, p := range s.Primitives {
		if !p.Existing {
			out = append(out, p)
		}
	}
	return out
}

// isExpansion reports whether this scene grows an existing plot rather than generating
// a fresh one.
func (s Scene) isExpansion() bool {
	return s.Parent != ""
}

type Vec3 [3]float64
