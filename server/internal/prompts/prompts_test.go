package prompts

import (
	"strings"
	"testing"
)

func TestSceneWithoutGroundUsesObjectOnlyPrompt(t *testing.T) {
	prompt := Scene("a spaceship", false)
	for _, want := range []string{"OBJECTS ONLY", "NO ground", "Do not invent one", "pure black", "temporary volumetric scaffolding", "erase every cube seam", "occupied silhouette, protrusions, proportions, empty spaces"} {
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
	if !strings.Contains(prompt, "broad flat base/ground shape is NOT object scaffolding") {
		t.Fatal("grounded scene prompt no longer protects the floor from object reinterpretation")
	}
	if !strings.Contains(prompt, "remains visible ground occupying the same broad screen-space footprint") {
		t.Fatal("grounded scene prompt no longer requires visible in-place ground")
	}
}

func TestSceneTreatsTextAsArtDirectionNotInventory(t *testing.T) {
	prompt := Scene("forest", true, 4)
	for _, want := range []string{
		"sole authority for WHAT EXISTS and WHERE",
		"NOT an object inventory",
		"SEMANTIC ID DIAGRAM",
		"NO SOURCE CLUSTER = NO OBJECT",
		"Object nouns in the text are valid only when a source cluster already has that object's full coarse silhouette",
		"Never add major functional parts",
		"Keep the same spatial size, center position, orientation, footprint, height range",
		"do not inflate, stretch, rotate, bend, shrink, shift, or recompose",
		"long axis, taper direction, color-region layout, and 2D screen-space footprint",
		"Do not rotate a horizontal cluster upright",
		"must first look like the source capture was repainted in place",
		"Above-ground pixels must stay inside each source cluster's projected 2D footprint",
		"output small squat mining crystals/ore chunks in those exact locations, not a drill",
		"small isolated blue object at that location",
		"Text cannot change a cluster's dominant hue family",
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

func TestObjectPromptDoesNotInventMissingCanonicalParts(t *testing.T) {
	prompt := Object("tool", "drill")
	for _, want := range []string{
		"occupied silhouette",
		"typed label is a material/category hint",
		"do not rotate a horizontal form upright",
		"Text cannot change a source region's dominant hue family",
		"never add major parts outside the source envelope",
		"handles, legs, wheels, wings, barrels, roofs, limbs, grips, triggers",
		"constrained stylized interpretation",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("object prompt missing %q", want)
		}
	}
}

func TestImageForPassesSceneObjectCount(t *testing.T) {
	prompt := ImageFor("scene", "forest", "", "", true, 3)
	if !strings.Contains(prompt, "exactly 3 independently placeable objects") {
		t.Fatal("scene object count was not propagated through ImageFor")
	}
}
