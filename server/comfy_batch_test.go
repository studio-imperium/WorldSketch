package main

import (
	"encoding/json"
	"testing"
)

func linkRefs(inputs map[string]any) []string {
	var refs []string
	for _, v := range inputs {
		if arr, ok := v.([]any); ok && len(arr) == 2 {
			if id, ok := arr[0].(string); ok {
				refs = append(refs, id)
			}
		}
	}
	return refs
}

func countClass(prompt map[string]any, class string) int {
	n := 0
	for _, raw := range prompt {
		if raw.(map[string]any)["class_type"] == class {
			n++
		}
	}
	return n
}

func validatePrompt(t *testing.T, prompt map[string]any, wantLoads int) {
	t.Helper()
	// Every link must reference an existing node.
	for nodeID, raw := range prompt {
		n := raw.(map[string]any)
		inputs, _ := n["inputs"].(map[string]any)
		for _, ref := range linkRefs(inputs) {
			if _, ok := prompt[ref]; !ok {
				t.Fatalf("node %q references missing node %q", nodeID, ref)
			}
		}
	}
	if _, err := json.Marshal(prompt); err != nil {
		t.Fatalf("prompt not serializable: %v", err)
	}
	if got := countClass(prompt, "LoadImage"); got != wantLoads {
		t.Fatalf("expected %d LoadImage nodes, got %d", wantLoads, got)
	}
	for _, required := range []string{"ksampler", "vae_encode", "decode", "save"} {
		if _, ok := prompt[required]; !ok {
			t.Fatalf("missing required node %q", required)
		}
	}
}

func mockJobs(n int) []viewJob {
	jobs := make([]viewJob, n)
	for i := range jobs {
		jobs[i] = viewJob{name: "v", rgbName: "r.png", edgeName: "e.png", depthName: "d.png", outPath: "o.png"}
	}
	return jobs
}

func TestBatchedWorkflowWiring(t *testing.T) {
	// canny + depth: 3 LoadImage groups (rgb, edge, depth) of 6 each = 18.
	p := batchedWorkflow("ckpt.st", "cn.pth", "depth.pth", mockJobs(6), defaultPositivePrompt)
	validatePrompt(t, p, 18)
	for _, required := range []string{"cnet", "cnet_depth"} {
		if _, ok := p[required]; !ok {
			t.Fatalf("missing required node %q", required)
		}
	}
}

func TestBatchedWorkflowDepthChain(t *testing.T) {
	// Depth ControlNet must take the canny ControlNet's output (applied in series),
	// and the KSampler must consume the depth ControlNet's output.
	p := batchedWorkflow("ckpt.st", "cn.pth", "depth.pth", mockJobs(3), defaultPositivePrompt)
	depthIn := p["cnet_depth"].(map[string]any)["inputs"].(map[string]any)
	if depthIn["positive"].([]any)[0].(string) != "cnet" {
		t.Fatalf("depth ControlNet should chain off canny, got %v", depthIn["positive"])
	}
	ks := p["ksampler"].(map[string]any)["inputs"].(map[string]any)
	if ks["positive"].([]any)[0].(string) != "cnet_depth" {
		t.Fatalf("ksampler should consume depth ControlNet output, got %v", ks["positive"])
	}
}

func TestBatchedWorkflowCannyOnly(t *testing.T) {
	// No depth model installed: rgb + edge loads only, no cnet_depth, ksampler off canny.
	p := batchedWorkflow("ckpt.st", "cn.pth", "", mockJobs(4), defaultPositivePrompt)
	validatePrompt(t, p, 8)
	if _, ok := p["cnet_depth"]; ok {
		t.Fatal("no depth model should omit cnet_depth")
	}
	ks := p["ksampler"].(map[string]any)["inputs"].(map[string]any)
	if ks["positive"].([]any)[0].(string) != "cnet" {
		t.Fatalf("ksampler should consume canny output, got %v", ks["positive"])
	}
}

func TestBatchedWorkflowNoControl(t *testing.T) {
	// No control nets at all: rgb loads only, ksampler straight off the text prompt.
	p := batchedWorkflow("ckpt.st", "", "", mockJobs(4), defaultPositivePrompt)
	validatePrompt(t, p, 4)
	if _, ok := p["cnet"]; ok {
		t.Fatal("no control should omit cnet")
	}
	ks := p["ksampler"].(map[string]any)["inputs"].(map[string]any)
	if ks["positive"].([]any)[0].(string) != "pos" {
		t.Fatalf("ksampler positive should link to pos, got %v", ks["positive"])
	}
}

func TestBatchedWorkflowSingleView(t *testing.T) {
	// One view: no ImageBatch chaining anywhere.
	p := batchedWorkflow("ckpt.st", "cn.pth", "depth.pth", mockJobs(1), defaultPositivePrompt)
	if n := countClass(p, "ImageBatch"); n != 0 {
		t.Fatalf("single view should create no ImageBatch nodes, got %d", n)
	}
	validatePrompt(t, p, 3)
}
