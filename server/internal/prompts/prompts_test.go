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
		"clean, isolated, game-ready 3D diorama scene chunk",
		"premium, richly textured, intricately authored stylized 3D game environment",
		"must not look like a clay render",
		"PRESERVE THE EXACT SOURCE STRUCTURE",
		"Prioritize 3D reconstruction readability over photorealism",
		"polished stylized 3D game asset",
		"Keep Image 1's existing camera, projection, framing, and viewpoint exactly",
		"inside an existing shape and its silhouette",
		"primitive block-out is a spatial mask, not the desired surface finish",
		"Do not push objects toward the edges",
		"Never close or complete missing structure",
		"if the source has no ground or base, do not create one",
		"pure black",
		"Scene context: a spaceship",
		"honor the original block-out exactly",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("scene prompt missing %q", want)
		}
	}
	for _, forbidden := range []string{"hand-painted", "handpainted", "isometric"} {
		if strings.Contains(strings.ToLower(prompt), forbidden) {
			t.Fatalf("scene prompt must not contain %q", forbidden)
		}
	}
}
