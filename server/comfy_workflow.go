package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// comfyWorkflowDir is an optional folder to also drop the editable UI workflow into
// (e.g. ComfyUI's user workflows dir, for opening in the desktop app). Set via
// COMFY_WORKFLOW_DIR; empty = skip. The workflow is always saved into the job dir too.
func comfyWorkflowDir() string {
	return os.Getenv("COMFY_WORKFLOW_DIR")
}

func saveWorkflowFiles(dir, ckpt, control, depthControl string) {
	workflow := comfyCanvasWorkflow(ckpt, control, depthControl, "worldsketch_front.png", "worldsketch_front_edges.png", "worldsketch_front_depth.png")
	saveJSON(filepath.Join(dir, "worldsketch_comfy_workflow.json"), workflow)

	uiDir := comfyWorkflowDir()
	if uiDir != "" {
		os.MkdirAll(uiDir, 0755)
		saveJSON(filepath.Join(uiDir, "worldsketch_img2img.json"), workflow)
	}

	if zero123, err := firstZero123Checkpoint(); err == nil {
		saveJSON(filepath.Join(dir, "worldsketch_zero123_workflow.json"), zero123CanvasWorkflow(zero123, "worldsketch_front.png"))
		if uiDir != "" {
			saveJSON(filepath.Join(uiDir, "worldsketch_zero123.json"), zero123CanvasWorkflow(zero123, "worldsketch_front.png"))
		}
	}
}

func saveDefaultWorkflow(dir string) {
	ckpt, err := firstCheckpoint()
	if err != nil {
		return
	}
	control, _ := firstControlNet()
	depthControl := firstDepthControlNet()
	saveWorkflowFiles(dir, ckpt, control, depthControl)
}

func saveJSON(path string, value any) {
	data, err := json.MarshalIndent(value, "", "\t")
	if err != nil {
		return
	}
	os.WriteFile(path, data, 0644)
}

func comfyCanvasWorkflow(ckpt, control, depthControl, image, edge, depth string) map[string]any {
	seed := SeedFromString("front")
	if seed < 0 {
		seed = -seed
	}

	positiveLink := 7
	negativeLink := 8
	nodes := []any{
		uiNode(1, "CheckpointLoaderSimple", 80, 330, 270, 100, []any{ckpt}, []any{}, []any{
			output("MODEL", "MODEL", 0, []int{1}),
			output("CLIP", "CLIP", 1, []int{2, 3}),
			output("VAE", "VAE", 2, []int{4, 5}),
		}),
		uiNode(2, "CLIPTextEncode", 430, 150, 460, 180, []any{"stylized realistic game environment, grassy ground, mossy boulder in the centre, pale blue overcast sky, soft ambient diffuse lighting, shadowless albedo material look, no directional sunlight, readable object silhouettes, coherent 3d scene"}, []any{
			input("clip", "CLIP", 2),
		}, []any{
			output("CONDITIONING", "CONDITIONING", 0, []int{7}),
		}),
		uiNode(3, "CLIPTextEncode", 430, 370, 460, 160, []any{"black background, darkness, night, galaxy, stars, abstract noise, empty image, blank image, hard shadows, cast shadows, directional sunlight, dramatic lighting, rim light, baked lighting, dark shading, high contrast lighting, spotlight, sunset, text, watermark, blurry, people"}, []any{
			input("clip", "CLIP", 3),
		}, []any{
			output("CONDITIONING", "CONDITIONING", 0, []int{8}),
		}),
		uiNode(4, "LoadImage", 80, 80, 300, 220, []any{image, "image"}, []any{}, []any{
			output("IMAGE", "IMAGE", 0, []int{6}),
			output("MASK", "MASK", 1, []int{}),
		}),
		uiNode(5, "VAEEncode", 960, 430, 240, 90, []any{}, []any{
			input("pixels", "IMAGE", 6),
			input("vae", "VAE", 4),
		}, []any{
			output("LATENT", "LATENT", 0, []int{9}),
		}),
	}
	links := []any{
		linkRow(1, 1, 0, 6, 0, "MODEL"),
		linkRow(2, 1, 1, 2, 0, "CLIP"),
		linkRow(3, 1, 1, 3, 0, "CLIP"),
		linkRow(4, 1, 2, 5, 1, "VAE"),
		linkRow(5, 1, 2, 7, 1, "VAE"),
		linkRow(6, 4, 0, 5, 0, "IMAGE"),
		linkRow(9, 5, 0, 6, 3, "LATENT"),
		linkRow(10, 6, 0, 7, 0, "LATENT"),
		linkRow(11, 7, 0, 8, 0, "IMAGE"),
	}
	lastNode := 8
	lastLink := 11

	if control != "" {
		positiveLink = 14
		negativeLink = 15
		lastNode = 11
		lastLink = 15
		nodes = append(nodes,
			uiNode(9, "LoadImage", 80, 560, 300, 220, []any{edge, "image"}, []any{}, []any{
				output("IMAGE", "IMAGE", 0, []int{13}),
				output("MASK", "MASK", 1, []int{}),
			}),
			uiNode(10, "ControlNetLoader", 430, 590, 370, 80, []any{control}, []any{}, []any{
				output("CONTROL_NET", "CONTROL_NET", 0, []int{12}),
			}),
			uiNode(11, "ControlNetApplyAdvanced", 930, 130, 340, 220, []any{envFloat("WS_CANNY_STRENGTH", 0), 0, 0.9}, []any{
				input("positive", "CONDITIONING", 7),
				input("negative", "CONDITIONING", 8),
				input("control_net", "CONTROL_NET", 12),
				input("image", "IMAGE", 13),
			}, []any{
				output("positive", "CONDITIONING", 0, []int{14}),
				output("negative", "CONDITIONING", 1, []int{15}),
			}),
		)
		links = append(links,
			linkRow(7, 2, 0, 11, 0, "CONDITIONING"),
			linkRow(8, 3, 0, 11, 1, "CONDITIONING"),
			linkRow(12, 10, 0, 11, 2, "CONTROL_NET"),
			linkRow(13, 9, 0, 11, 3, "IMAGE"),
			linkRow(14, 11, 0, 6, 1, "CONDITIONING"),
			linkRow(15, 11, 1, 6, 2, "CONDITIONING"),
		)
		if depthControl != "" {
			positiveLink = 18
			negativeLink = 19
			lastNode = 14
			lastLink = 19
			nodes = append(nodes,
				uiNode(12, "LoadImage", 80, 810, 300, 220, []any{depth, "image"}, []any{}, []any{
					output("IMAGE", "IMAGE", 0, []int{17}),
					output("MASK", "MASK", 1, []int{}),
				}),
				uiNode(13, "ControlNetLoader", 430, 840, 370, 80, []any{depthControl}, []any{}, []any{
					output("CONTROL_NET", "CONTROL_NET", 0, []int{16}),
				}),
				uiNode(14, "ControlNetApplyAdvanced", 930, 395, 340, 220, []any{envFloat("WS_DEPTH_STRENGTH", 0.35), 0, 0.8}, []any{
					input("positive", "CONDITIONING", 14),
					input("negative", "CONDITIONING", 15),
					input("control_net", "CONTROL_NET", 16),
					input("image", "IMAGE", 17),
				}, []any{
					output("positive", "CONDITIONING", 0, []int{18}),
					output("negative", "CONDITIONING", 1, []int{19}),
				}),
			)
			links = append(links,
				linkRow(16, 13, 0, 14, 2, "CONTROL_NET"),
				linkRow(17, 12, 0, 14, 3, "IMAGE"),
				linkRow(18, 14, 0, 6, 1, "CONDITIONING"),
				linkRow(19, 14, 1, 6, 2, "CONDITIONING"),
			)
			links[13] = linkRow(14, 11, 0, 14, 0, "CONDITIONING")
			links[14] = linkRow(15, 11, 1, 14, 1, "CONDITIONING")
		}
	} else {
		links = append(links,
			linkRow(7, 2, 0, 6, 1, "CONDITIONING"),
			linkRow(8, 3, 0, 6, 2, "CONDITIONING"),
		)
	}

	nodes = append(nodes,
		uiNode(6, "KSampler", 1320, 230, 320, 270, []any{seed, "fixed", envInt("WS_STEPS", 32), envFloat("WS_CFG", 7.5), "euler", "normal", envFloat("WS_DENOISE", 0.74)}, []any{
			input("model", "MODEL", 1),
			input("positive", "CONDITIONING", positiveLink),
			input("negative", "CONDITIONING", negativeLink),
			input("latent_image", "LATENT", 9),
		}, []any{
			output("LATENT", "LATENT", 0, []int{10}),
		}),
		uiNode(7, "VAEDecode", 1700, 250, 230, 90, []any{}, []any{
			input("samples", "LATENT", 10),
			input("vae", "VAE", 5),
		}, []any{
			output("IMAGE", "IMAGE", 0, []int{11}),
		}),
		uiNode(8, "SaveImage", 1990, 250, 230, 100, []any{"worldsketch_tuned"}, []any{
			input("images", "IMAGE", 11),
		}, []any{}),
	)

	return map[string]any{
		"last_node_id": lastNode,
		"last_link_id": lastLink,
		"nodes":        nodes,
		"links":        links,
		"groups":       []any{},
		"config":       map[string]any{},
		"extra":        map[string]any{"ds": map[string]any{"scale": 0.74, "offset": []float64{120, 60}}},
		"version":      0.4,
	}
}

func zero123CanvasWorkflow(ckpt, image string) map[string]any {
	nodes := []any{
		uiNode(1, "ImageOnlyCheckpointLoader", 80, 250, 330, 90, []any{ckpt}, []any{}, []any{
			output("MODEL", "MODEL", 0, []int{1}),
			output("CLIP_VISION", "CLIP_VISION", 1, []int{2}),
			output("VAE", "VAE", 2, []int{4, 10}),
		}),
		uiNode(2, "LoadImage", 80, 60, 300, 170, []any{image, "image"}, []any{}, []any{
			output("IMAGE", "IMAGE", 0, []int{3}),
			output("MASK", "MASK", 1, []int{}),
		}),
		uiNode(3, "StableZero123_Conditioning", 470, 110, 360, 220, []any{512, 512, 1, 0, 90}, []any{
			input("clip_vision", "CLIP_VISION", 2),
			input("init_image", "IMAGE", 3),
			input("vae", "VAE", 4),
		}, []any{
			output("positive", "CONDITIONING", 0, []int{5}),
			output("negative", "CONDITIONING", 1, []int{6}),
			output("latent", "LATENT", 2, []int{7}),
		}),
		uiNode(4, "KSampler", 930, 120, 320, 270, []any{690861308215210, "fixed", 18, 3.0, "euler", "normal", 1.0}, []any{
			input("model", "MODEL", 1),
			input("positive", "CONDITIONING", 5),
			input("negative", "CONDITIONING", 6),
			input("latent_image", "LATENT", 7),
		}, []any{
			output("LATENT", "LATENT", 0, []int{8}),
		}),
		uiNode(5, "VAEDecode", 1330, 190, 230, 90, []any{}, []any{
			input("samples", "LATENT", 8),
			input("vae", "VAE", 10),
		}, []any{
			output("IMAGE", "IMAGE", 0, []int{9}),
		}),
		uiNode(6, "SaveImage", 1640, 185, 250, 100, []any{"worldsketch_zero123"}, []any{
			input("images", "IMAGE", 9),
		}, []any{}),
	}

	return map[string]any{
		"last_node_id": 6,
		"last_link_id": 10,
		"nodes":        nodes,
		"links": []any{
			linkRow(1, 1, 0, 4, 0, "MODEL"),
			linkRow(2, 1, 1, 3, 0, "CLIP_VISION"),
			linkRow(3, 2, 0, 3, 1, "IMAGE"),
			linkRow(4, 1, 2, 3, 2, "VAE"),
			linkRow(5, 3, 0, 4, 1, "CONDITIONING"),
			linkRow(6, 3, 1, 4, 2, "CONDITIONING"),
			linkRow(7, 3, 2, 4, 3, "LATENT"),
			linkRow(8, 4, 0, 5, 0, "LATENT"),
			linkRow(9, 5, 0, 6, 0, "IMAGE"),
			linkRow(10, 1, 2, 5, 1, "VAE"),
		},
		"groups":  []any{},
		"config":  map[string]any{},
		"extra":   map[string]any{"ds": map[string]any{"scale": 0.74, "offset": []float64{80, 40}}},
		"version": 0.4,
	}
}

func uiNode(id int, kind string, x, y, w, h float64, widgets []any, inputs []any, outputs []any) map[string]any {
	return map[string]any{
		"id":             id,
		"type":           kind,
		"pos":            []float64{x, y},
		"size":           []float64{w, h},
		"flags":          map[string]any{},
		"order":          id,
		"mode":           0,
		"inputs":         inputs,
		"outputs":        outputs,
		"properties":     map[string]any{"Node name for S&R": kind},
		"widgets_values": widgets,
	}
}

func input(name, kind string, link int) map[string]any {
	return map[string]any{"name": name, "type": kind, "link": link}
}

func output(name, kind string, slot int, links []int) map[string]any {
	return map[string]any{"name": name, "type": kind, "links": links, "slot_index": slot}
}

func linkRow(id, from, fromSlot, to, toSlot int, kind string) []any {
	return []any{id, from, fromSlot, to, toSlot, kind}
}
