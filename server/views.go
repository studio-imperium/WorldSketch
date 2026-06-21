package main

type Camera struct {
	Name     string  `json:"name"`
	Width    int     `json:"width"`
	Height   int     `json:"height"`
	Position Vec3    `json:"position"`
	Forward  Vec3    `json:"forward"`
	Right    Vec3    `json:"right"`
	Up       Vec3    `json:"up"`
	FOV      float64 `json:"fov"`
	Aspect   float64 `json:"aspect"`
	Near     float64 `json:"near"`
	Far      float64 `json:"far"`
}

var viewNames = []string{"front", "back", "left", "right", "top", "corner_fl", "corner_fr", "corner_bl", "corner_br"}
