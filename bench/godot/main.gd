# Same scenes as engine/examples/bench_compare.rs. Prints `BENCH {...}` and quits.
#   Godot --path bench/godot -- --scene cubes --secs 10 --warmup 3
extends Node3D

var scene := "cubes"
var warmup := 3.0
var secs := 10.0
var t := 0.0
var frames: PackedFloat32Array = []
var start_us := 0
var ready_printed := false

func _ready() -> void:
	start_us = Time.get_ticks_usec()
	var args := OS.get_cmdline_user_args()
	for i in args.size():
		match args[i]:
			"--scene": scene = args[i + 1]
			"--secs": secs = float(args[i + 1])
			"--warmup": warmup = float(args[i + 1])
	DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
	var cube := BoxMesh.new()
	var mats: Array[StandardMaterial3D] = []
	for i in 8:
		var m := StandardMaterial3D.new()
		m.albedo_color = Color.from_hsv(i * 45.0 / 360.0, 0.6, 0.75)
		m.roughness = 0.8
		mats.append(m)
	var ground := MeshInstance3D.new()
	var gm := BoxMesh.new()
	gm.size = Vector3(400, 0.2, 400)
	ground.mesh = gm
	ground.position = Vector3(0, -0.1, 0)
	add_child(ground)
	match scene:
		"lights":
			for i in 4000:
				_cube(cube, mats[i % 8], Vector3((i % 80) * 2.5 - 100.0, 0.5, (i / 80) * 2.5 - 62.5))
			for i in 256:
				var l := OmniLight3D.new()
				l.light_color = Color.from_hsv(fmod(i * 37.0, 360.0) / 360.0, 0.8, 1.0)
				l.omni_range = 10.0
				l.light_energy = 2.0
				l.position = Vector3((i % 16) * 12.5 - 95.0, 2.0, (i / 16) * 7.8 - 60.0)
				add_child(l)
			var dim := DirectionalLight3D.new()
			dim.light_energy = 0.05
			dim.rotation_degrees = Vector3(-70, 20, 0)
			add_child(dim)
			_camera(Vector3(0, 40, 70), Vector3(0, 0, -10))
		"physics":
			var floor := StaticBody3D.new()
			var fs := CollisionShape3D.new()
			var fb := BoxShape3D.new()
			fb.size = Vector3(400, 0.2, 400)
			fs.shape = fb
			floor.add_child(fs)
			floor.position = Vector3(0, -0.1, 0)
			add_child(floor)
			var shape := BoxShape3D.new()
			for i in 4000:
				var b := RigidBody3D.new()
				var cs := CollisionShape3D.new()
				cs.shape = shape
				b.add_child(cs)
				var mi := MeshInstance3D.new()
				mi.mesh = cube
				mi.material_override = mats[i % 8]
				b.add_child(mi)
				b.position = Vector3((i % 20) * 1.5 - 15.0, 2.0 + (i / 400) * 1.5, ((i / 20) % 20) * 1.5 - 15.0)
				add_child(b)
			_sun()
			_camera(Vector3(0, 25, 45), Vector3(0, 4, 0))
		_:
			for i in 20000:
				_cube(cube, mats[i % 8], Vector3((i % 200) * 1.8 - 180.0, 0.5, (i / 200) * 1.8 - 90.0))
			_sun()
			_camera(Vector3(0, 60, 120), Vector3(0, 0, -20))

func _cube(mesh: Mesh, mat: Material, pos: Vector3) -> void:
	var mi := MeshInstance3D.new()
	mi.mesh = mesh
	mi.material_override = mat
	mi.position = pos
	add_child(mi)

func _sun() -> void:
	var s := DirectionalLight3D.new()
	s.shadow_enabled = true
	s.look_at_from_position(Vector3(30, 60, 20), Vector3.ZERO)
	add_child(s)

func _camera(pos: Vector3, at: Vector3) -> void:
	var c := Camera3D.new()
	add_child(c)
	c.look_at_from_position(pos, at)
	c.current = true

func _process(delta: float) -> void:
	if not ready_printed:
		ready_printed = true
		print("READY")
		print("FIRST_FRAME %.3f" % ((Time.get_ticks_usec() - start_us) / 1e6))
	t += delta
	if t < warmup:
		return
	frames.append(delta * 1000.0)
	if t < warmup + secs:
		return
	var f := frames.duplicate()
	f.sort()
	var n := f.size()
	var s := 0.0
	for v in f:
		s += v
	var pct := func(p: float) -> float: return f[int((n - 1) * p)]
	print("BENCH {\"engine\":\"godot\",\"scene\":\"%s\",\"frames\":%d,\"avg_ms\":%.3f,\"p50_ms\":%.3f,\"p95_ms\":%.3f,\"p99_ms\":%.3f}" % [scene, n, s / n, pct.call(0.5), pct.call(0.95), pct.call(0.99)])
	get_tree().quit()
