package main

import (
	"encoding/json"
	"testing"
)

func inpaintNode(t *testing.T, p map[string]any, id string) map[string]any {
	t.Helper()
	raw, ok := p[id]
	if !ok {
		t.Fatalf("missing required node %q", id)
	}
	return raw.(map[string]any)["inputs"].(map[string]any)
}

func linkTarget(t *testing.T, inputs map[string]any, field string) string {
	t.Helper()
	v, ok := inputs[field].([]any)
	if !ok || len(v) != 2 {
		t.Fatalf("input %q is not a link: %v", field, inputs[field])
	}
	return v[0].(string)
}

func validateInpaint(t *testing.T, p map[string]any, wantLoads int) {
	t.Helper()
	for nodeID, raw := range p {
		inputs, _ := raw.(map[string]any)["inputs"].(map[string]any)
		for _, ref := range linkRefs(inputs) {
			if _, ok := p[ref]; !ok {
				t.Fatalf("node %q references missing node %q", nodeID, ref)
			}
		}
	}
	if _, err := json.Marshal(p); err != nil {
		t.Fatalf("prompt not serializable: %v", err)
	}
	if got := countClass(p, "LoadImage"); got != wantLoads {
		t.Fatalf("expected %d LoadImage nodes, got %d", wantLoads, got)
	}
	for _, required := range []string{"ckpt", "pos", "neg", "load_rgb", "load_mask", "vae_encode", "to_mask", "set_mask", "ksampler", "decode", "save"} {
		if _, ok := p[required]; !ok {
			t.Fatalf("missing required node %q", required)
		}
	}
	// The masked latent must reach the sampler, and the mask must restrict it.
	if got := linkTarget(t, inpaintNode(t, p, "ksampler"), "latent_image"); got != "set_mask" {
		t.Fatalf("ksampler latent_image should be set_mask, got %q", got)
	}
	setMask := inpaintNode(t, p, "set_mask")
	if got := linkTarget(t, setMask, "samples"); got != "vae_encode" {
		t.Fatalf("set_mask samples should be vae_encode, got %q", got)
	}
}

func TestInpaintWorkflowFullControl(t *testing.T) {
	// canny + depth + rgb + mask = 4 LoadImage nodes.
	p := inpaintViewWorkflow("ckpt.st", "cn.pth", "depth.pth", "ctx.png", "edge.png", "depth.png", "mask.png", defaultPositivePrompt, defaultSeed, 7, 6.5, 0.8, 6)
	validateInpaint(t, p, 4)

	// Depth ControlNet chains off canny; the sampler consumes depth's output.
	if got := linkTarget(t, inpaintNode(t, p, "cnet_depth"), "positive"); got != "cnet" {
		t.Fatalf("depth ControlNet should chain off canny, got %q", got)
	}
	if got := linkTarget(t, inpaintNode(t, p, "ksampler"), "positive"); got != "cnet_depth" {
		t.Fatalf("ksampler should consume depth ControlNet output, got %q", got)
	}
	// With mask grow, the mask path is to_mask → grow_mask → set_mask.
	if got := linkTarget(t, inpaintNode(t, p, "set_mask"), "mask"); got != "grow_mask" {
		t.Fatalf("set_mask mask should be grow_mask when grown, got %q", got)
	}
	if got := linkTarget(t, inpaintNode(t, p, "grow_mask"), "mask"); got != "to_mask" {
		t.Fatalf("grow_mask should chain off to_mask, got %q", got)
	}
}

func TestInpaintWorkflowNoMaskGrow(t *testing.T) {
	// maskGrow=0 → no GrowMask node; set_mask reads to_mask directly.
	p := inpaintViewWorkflow("ckpt.st", "cn.pth", "depth.pth", "ctx.png", "edge.png", "depth.png", "mask.png", defaultPositivePrompt, defaultSeed, 7, 6.5, 0.8, 0)
	if _, ok := p["grow_mask"]; ok {
		t.Fatal("maskGrow=0 should omit grow_mask")
	}
	if got := linkTarget(t, inpaintNode(t, p, "set_mask"), "mask"); got != "to_mask" {
		t.Fatalf("set_mask mask should be to_mask without grow, got %q", got)
	}
}

func TestInpaintWorkflowCannyOnly(t *testing.T) {
	// No depth model: rgb + mask + edge = 3 LoadImage, no cnet_depth, sampler off canny.
	p := inpaintViewWorkflow("ckpt.st", "cn.pth", "", "ctx.png", "edge.png", "", "mask.png", defaultPositivePrompt, defaultSeed, 7, 6.5, 0.8, 6)
	validateInpaint(t, p, 3)
	if _, ok := p["cnet_depth"]; ok {
		t.Fatal("no depth model should omit cnet_depth")
	}
	if got := linkTarget(t, inpaintNode(t, p, "ksampler"), "positive"); got != "cnet" {
		t.Fatalf("ksampler should consume canny output, got %q", got)
	}
}

func TestInpaintWorkflowNoControl(t *testing.T) {
	// No control nets: rgb + mask = 2 LoadImage, sampler straight off the text prompt.
	p := inpaintViewWorkflow("ckpt.st", "", "", "ctx.png", "", "", "mask.png", defaultPositivePrompt, defaultSeed, 7, 6.5, 0.8, 6)
	validateInpaint(t, p, 2)
	if _, ok := p["cnet"]; ok {
		t.Fatal("no control should omit cnet")
	}
	if got := linkTarget(t, inpaintNode(t, p, "ksampler"), "positive"); got != "pos" {
		t.Fatalf("ksampler positive should link to pos, got %q", got)
	}
}

func TestInpaintWorkflowDenoise(t *testing.T) {
	p := inpaintViewWorkflow("ckpt.st", "cn.pth", "depth.pth", "ctx.png", "edge.png", "depth.png", "mask.png", defaultPositivePrompt, defaultSeed, 12, 7.0, 0.85, 6)
	ks := inpaintNode(t, p, "ksampler")
	if ks["denoise"].(float64) != 0.85 {
		t.Fatalf("denoise not threaded through, got %v", ks["denoise"])
	}
	if ks["seed"].(int) != defaultSeed {
		t.Fatalf("seed not threaded through, got %v", ks["seed"])
	}
}
