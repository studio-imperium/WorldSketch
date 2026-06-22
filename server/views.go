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

var viewNames = []string{
	"front",
	"back",
	"left",
	"right",
	"top",
	"corner_fl_high",
	"corner_fr_high",
	"corner_bl_high",
	"corner_br_high",
	"corner_fl_low",
	"corner_fr_low",
	"corner_bl_low",
	"corner_br_low",
}
