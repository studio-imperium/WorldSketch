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

func TestSceneTreatsTextAsArtDirectionNotInventory(t *testing.T) {
	prompt := Scene("forest", true, 4)
	for _, want := range []string{
		"sole authority for WHAT EXISTS and WHERE",
		"NOT an object inventory",
		"SEMANTIC ID DIAGRAM",
		"NO SOURCE CLUSTER = NO OBJECT",
		"exactly 4 spatially connected above-ground object clusters",
		"exactly 4 independently placeable objects",
		"do not add a cabin",
		"interpretation of the user's geometry",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("geometry-authority prompt missing %q", want)
		}
	}
}

func TestImageForPassesSceneObjectCount(t *testing.T) {
	prompt := ImageFor("scene", "forest", "", "", true, 3)
	if !strings.Contains(prompt, "exactly 3 independently placeable objects") {
		t.Fatal("scene object count was not propagated through ImageFor")
	}
}
