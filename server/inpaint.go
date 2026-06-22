package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// defaultSeed is the fixed KSampler seed the one-shot batched path uses
// (batchedWorkflow). Expansion reuses it so the inpainted delta lands in the same
// stylistic basin as the plot it grows.
const defaultSeed = 1125899906842624

// inpaintViewWorkflow builds a single-view masked img2img ("inpaint") prompt: encode
// the context image (the parent's decorated view with the new object's flat blockout
// colour composited into the masked region), restrict denoising to the new-object mask
// via SetLatentNoiseMask, and pin the new object's silhouette/geometry with canny +
// depth ControlNet. The frozen region is preserved regardless of denoise, so the new
// object is painted to match the surrounding existing world.
//
// One view per call (each view has a different mask, and core ComfyUI has no clean
// batched-mask node); batching is a documented follow-up in docs/world-expansion-plan.md.
func inpaintViewWorkflow(ckpt, control, depthControl, contextImg, edgeImg, depthImg, maskImg, positiveText string, seed, steps int, cfg, denoise float64, maskGrow int) map[string]any {
	prompt := map[string]any{
		"ckpt": node("CheckpointLoaderSimple", map[string]any{"ckpt_name": ckpt}),
		"pos": node("CLIPTextEncode", map[string]any{
			"text": positiveText,
			"clip": link("ckpt", 1),
		}),
		"neg": node("CLIPTextEncode", map[string]any{
			"text": negativePrompt,
			"clip": link("ckpt", 1),
		}),
		"load_rgb":  node("LoadImage", map[string]any{"image": contextImg}),
		"load_mask": node("LoadImage", map[string]any{"image": maskImg}),
	}

	// Encode the full context image; SetLatentNoiseMask then limits the KSampler to the
	// masked region so the frozen (decorated) pixels survive exactly.
	prompt["vae_encode"] = node("VAEEncode", map[string]any{
		"pixels": link("load_rgb", 0),
		"vae":    link("ckpt", 2),
	})
	prompt["to_mask"] = node("ImageToMask", map[string]any{
		"image":   link("load_mask", 0),
		"channel": "red",
	})
	maskSrc := "to_mask"
	if maskGrow > 0 {
		// Dilate the mask so the new object blends into its seam instead of leaving a
		// hard edge at the silhouette boundary.
		prompt["grow_mask"] = node("GrowMask", map[string]any{
			"mask":            link("to_mask", 0),
			"expand":          maskGrow,
			"tapered_corners": true,
		})
		maskSrc = "grow_mask"
	}
	prompt["set_mask"] = node("SetLatentNoiseMask", map[string]any{
		"samples": link("vae_encode", 0),
		"mask":    link(maskSrc, 0),
	})

	// ControlNets in series, same as the one-shot path: canny pins the new silhouette,
	// depth pins its surface geometry so it fuses where the primitive says it should.
	positive := link("pos", 0)
	negative := link("neg", 0)
	if control != "" {
		prompt["load_edge"] = node("LoadImage", map[string]any{"image": edgeImg})
		prompt["cnet_loader"] = node("ControlNetLoader", map[string]any{"control_net_name": control})
		prompt["cnet"] = node("ControlNetApplyAdvanced", map[string]any{
			"positive":      positive,
			"negative":      negative,
			"control_net":   link("cnet_loader", 0),
			"image":         link("load_edge", 0),
			"strength":      envFloat("WS_CANNY_STRENGTH", 0.9),
			"start_percent": 0.0,
			"end_percent":   0.9,
		})
		positive = link("cnet", 0)
		negative = link("cnet", 1)
	}
	if depthControl != "" {
		prompt["load_depth"] = node("LoadImage", map[string]any{"image": depthImg})
		prompt["cnet_depth_loader"] = node("ControlNetLoader", map[string]any{"control_net_name": depthControl})
		prompt["cnet_depth"] = node("ControlNetApplyAdvanced", map[string]any{
			"positive":      positive,
			"negative":      negative,
			"control_net":   link("cnet_depth_loader", 0),
			"image":         link("load_depth", 0),
			"strength":      envFloat("WS_DEPTH_STRENGTH", 0.6),
			"start_percent": 0.0,
			"end_percent":   0.8,
		})
		positive = link("cnet_depth", 0)
		negative = link("cnet_depth", 1)
	}

	prompt["ksampler"] = node("KSampler", map[string]any{
		"model":        link("ckpt", 0),
		"positive":     positive,
		"negative":     negative,
		"latent_image": link("set_mask", 0),
		"seed":         seed,
		"steps":        steps,
		"cfg":          cfg,
		"sampler_name": "euler",
		"scheduler":    "normal",
		"denoise":      denoise,
	})
	prompt["decode"] = node("VAEDecode", map[string]any{
		"samples": link("ksampler", 0),
		"vae":     link("ckpt", 2),
	})
	prompt["save"] = node("SaveImage", map[string]any{
		"images":          link("decode", 0),
		"filename_prefix": "worldsketch_expand",
	})

	return prompt
}

// negativePrompt is shared by the one-shot and inpaint paths.
const negativePrompt = "black background, darkness, night, galaxy, stars, abstract noise, empty image, blank image, hard shadows, cast shadows, directional sunlight, dramatic lighting, rim light, baked lighting, dark shading, high contrast lighting, spotlight, sunset, text, watermark, blurry, people"

// RunComfyInpaint generates the expanded views: for each of the 9 cameras it composites
// the inpaint context from the parent's decorated view + the new blockout, then either
// inpaints the new-object region (if the mask has any coverage) or copies the parent's
// view straight through (the new object isn't visible from that camera).
func RunComfyInpaint(dir, parentDir, scenePrompt string) error {
	ckpt, err := firstCheckpoint()
	if err != nil {
		writeLog(dir, "comfy.log", err.Error())
		return err
	}
	control, _ := firstControlNet()
	depthControl := firstDepthControlNet()

	steps := envInt("WS_STEPS", 7)
	cfg := envFloat("WS_CFG", 6.5)
	denoise := envFloat("WS_EXPAND_DENOISE", 0.8)
	maskGrow := envInt("WS_EXPAND_MASK_GROW", 6)
	positive := positivePrompt(scenePrompt)

	generated := 0
	for _, name := range viewNames {
		viewDir := filepath.Join(dir, "views", name)
		parentViewDir := filepath.Join(parentDir, "views", name)
		if _, err := os.Stat(filepath.Join(viewDir, "primitive_rgb.png")); err != nil {
			continue
		}

		ctx, hasNew, err := prepareExpansionView(viewDir, parentViewDir)
		if err != nil {
			writeLog(dir, "comfy.log", err.Error())
			return err
		}
		out := filepath.Join(viewDir, "generated_rgb.png")
		if !hasNew {
			// Nothing new is visible here — keep the parent's decorated view verbatim.
			if err := copyFile(ctx, out); err != nil {
				return err
			}
			continue
		}

		// Write the ControlNet hints from the *new* scene's full blockout.
		edge := filepath.Join(viewDir, "primitive_edges.png")
		WriteEdgeMap(filepath.Join(viewDir, "primitive_rgb.png"), edge)
		depthCtrl := ""
		if depthControl != "" {
			depthCtrl = filepath.Join(viewDir, "primitive_depth_control.png")
			WriteDepthControl(filepath.Join(viewDir, "primitive_depth.png"), depthCtrl)
		}

		ctxName, err := uploadImage(ctx, "worldsketch_expand_"+name+".png")
		if err != nil {
			return err
		}
		maskName, err := uploadImage(filepath.Join(viewDir, "new_mask.png"), "worldsketch_expand_"+name+"_mask.png")
		if err != nil {
			return err
		}
		edgeName, err := uploadImage(edge, "worldsketch_expand_"+name+"_edges.png")
		if err != nil {
			return err
		}
		depthName := ""
		if depthCtrl != "" {
			depthName, err = uploadImage(depthCtrl, "worldsketch_expand_"+name+"_depth.png")
			if err != nil {
				return err
			}
		}

		workflow := inpaintViewWorkflow(ckpt, control, depthControl, ctxName, edgeName, depthName, maskName, positive, defaultSeed, steps, cfg, denoise, maskGrow)
		saveJSON(filepath.Join(viewDir, "comfy_inpaint_prompt.json"), workflow)

		promptID, err := queuePrompt(workflow)
		if err != nil {
			return err
		}
		images, err := waitForImages(promptID)
		if err != nil {
			return err
		}
		if len(images) == 0 {
			return fmt.Errorf("comfy returned no image for expansion view %s", name)
		}
		data, err := downloadComfyImage(images[0])
		if err != nil {
			return err
		}
		if err := os.WriteFile(out, data, 0644); err != nil {
			return err
		}
		generated++
	}

	if generated == 0 {
		writeLog(dir, "comfy.log", "no new-object pixels were visible in any view")
	}
	return nil
}
