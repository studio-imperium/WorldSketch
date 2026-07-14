package prompts

import (
	"strings"
	"testing"
)

// The single scene prompt covers both grounded and floorless block-outs: floors render
// only when the block-out contains one, and nothing may be invented around the shapes.
func TestScenePromptCoreInvariants(t *testing.T) {
	prompt := Scene("a spaceship", false)
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

func TestScenePromptIdenticalForGroundedScenes(t *testing.T) {
	if Scene("a campsite", true) != Scene("a campsite", false) {
		t.Fatal("grounded and floorless scenes should share the one block-out prompt")
	}
}

func TestImageForRoutesSceneKind(t *testing.T) {
	prompt := ImageFor("scene", "forest", "", "", true, 3)
	if !strings.Contains(prompt, "Scene context: forest") {
		t.Fatal("scene description was not propagated through ImageFor")
	}
}
