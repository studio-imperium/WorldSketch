package prompts

import (
	"strings"
	"testing"
)

// The single scene prompt covers both grounded and floorless block-outs: floors render
// only when the block-out contains one, and nothing may be invented around the shapes.
func TestScenePromptCoreInvariants(t *testing.T) {
	prompt := Scene("a spaceship")
	for _, want := range []string{
		"ISOMETRIC BLOCK-OUT",
		"SPATIAL FIDELITY IS THE TOP PRIORITY",
		"PRESERVE THE LAYOUT",
		"Do NOT ADD structure",
		"NEVER close an open room",
		"Do NOT INVENT a ground plane",
		"PHYSICALLY FLAT and LEVEL",
		"reproduce its drawn outline exactly",
		"you MUST render that floor too",
		"pure black",
		"Scene context: a spaceship",
		"keep the source silhouette and occlusion intact",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("scene prompt missing %q", want)
		}
	}
}
