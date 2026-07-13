package prompts

import (
	"strings"
	"testing"
)

func TestSceneWithoutGroundUsesObjectOnlyPrompt(t *testing.T) {
	prompt := Scene("a spaceship", false)
	for _, want := range []string{"OBJECTS ONLY", "NO ground", "Do not invent one", "pure black", "temporary volumetric scaffolding", "erase every cube seam", "Semantic identity outranks"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("no-ground scene prompt missing %q", want)
		}
	}
	if strings.Contains(prompt, "transform the flat painted ground") {
		t.Fatal("no-ground scene prompt still asks the model to texture ground")
	}
}

func TestSceneWithGroundKeepsTerrainPrompt(t *testing.T) {
	prompt := Scene("a campsite", true)
	if !strings.Contains(strings.ToLower(prompt), "transform the flat painted ground") {
		t.Fatal("grounded scene prompt no longer asks the model to texture its ground")
	}
	if !strings.Contains(prompt, "per-block silhouettes and seams are not constraints") {
		t.Fatal("grounded scene prompt no longer explains that blocks are disposable scaffolding")
	}
}
