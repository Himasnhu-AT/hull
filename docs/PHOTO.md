# Photo: a physical camera (`engine::photo`, feature `photo`)

A camera with real-world controls and a way to take pictures of what it sees. It is a skeleton:
the lens maths, the capture path and the extension points are here; what counts as a good
photo is the game's call.

- **`PhotoCamera`** (component, next to `Camera3d` and `MainCamera`): focal length on a sensor,
  aperture, shutter speed, ISO, focus distance, autofocus.
- **Lens → look**: each frame the plugin writes the camera's FOV and the `Look` lens block
  (`dof`, `motion_blur`, `exposure.ev100`). One camera drives the shared `Look`.
- **`PhotoRequest`** → renders the view at photo resolution → **`PhotoTaken { image, metadata,
  path }`**. The metadata lists the `Photographable`s in frame; games add fields with hooks.
- **`PhotoSink`** trait saves the result; `PngFileSink` is the default.

## Quick start

```rust
commands.spawn((Camera3d::default(), MainCamera, PhotoCamera::tele()));          // 200 mm f/4
commands.spawn((Photographable { kind: "deer".into(), radius: 0.9, ..default() }, Transform::..));

requests.write(PhotoRequest::default());                      // the shutter
for p in taken.read() { p.metadata.subjects; p.path; p.image } // react

app.world_mut().resource_mut::<PhotoHooks>().on_metadata(|world, m| {
    m.extra.insert("temperature".into(), 11.into());          // anything serialisable
});
// camera controls: pc.zoom(1.4); pc.stop_aperture(-1.0); pc.autofocus = false; pc.focus_m = 8.0;
```

`cargo run --example sim_demo -- --play`: Space shoots, Z/X zoom, F/G aperture, C toggles AF.

## The camera model (`photo::lens`, pure functions)

| Fn | What |
|---|---|
| `vertical_fov(focal_mm, sensor_height_mm)` / `focal_for_fov` | `2·atan(sensor / 2f)`: 50 mm full frame = 27° |
| `depth_of_field(focal, N, focus_m, coc)` | thin lens: hyperfocal, near and far limit (`far` may be infinite) |
| `coc_limit_mm(sensor_height)` | sensor diagonal / 1500 |
| `ev100(N, shutter, iso)` | `log2(N²·100 / (t·ISO))`, what `look.exposure.ev100` and Bevy's `Exposure` use |
| `bevy_aperture(N, sensor)` | the aperture to give Bevy's `DepthOfField` so its blur matches this lens |
| `blur_shutter_angle(shutter, ref_fps)` | `shutter · ref_fps` clamped to 0..1: 1/60 s at 60 fps = a full frame of blur |
| `focus_step(cur, target, speed, dt)` | autofocus eases in log distance (no overshoot) |

Why `bevy_aperture`: Bevy's DoF takes the focal length from the projection FOV and its own
sensor height (18.66 mm). Blur scales with `f² / (N · sensor)`, so a 24 mm sensor needs
`N · 18.66/24`. The defaults are full frame (24 mm), 35 mm, f/5.6, 1/500 (EV 13.9, about the clear-day look), ISO 100, focus 10 m.

`LensState` (component, derived each frame): `fov_y`, `ev100`, `hyperfocal_m`, `near_m`, `far_m`,
`bevy_aperture`, `blur_angle`. Read it for UI ("sharp from 9 to 14 m") or game rules ("is the
subject in focus": `LensState::near_m <= subject.distance <= far_m`).

Flags on `PhotoCamera`: `dof`, `motion_blur`, `exposure_link` (turns auto exposure off and sets
EV100 from the camera; `exposure_bias_ev` is compensation, positive = darker). Autofocus casts
one avian ray along the camera's forward axis (`af_max_m` if nothing is hit).

## Taking a photo

1. `PhotoRequest { camera?, resolution?, skip_save }`. One photo at a time; a second request while
   busy produces `PhotoFailed`. `--headless` produces `PhotoFailed` too.
2. The metadata is built at once (the scene when the shutter fires): lens snapshot, pose, subjects,
   then your hooks.
3. The camera is retargeted to a new `PhotoConfig::resolution` image (default 3840×2160) for
   `settle_frames` (3) frames so history effects settle, then a `Screenshot::image` reads it back,
   the camera target is restored and the image dropped. Root UI nodes are hidden meanwhile
   (`hide_ui`). The screen shows the camera's view at the photo aspect for about five frames.
4. The sink saves; `PhotoTaken` is written with the `Arc<Image>` (RGBA8 sRGB), metadata and path.
   `PhotoCapture::last` keeps the last metadata and path.

**Subjects.** `Photographable { kind, radius, centre_offset, weight }` marks things. The default
`FrustumSubjects { occlusion_samples: 5, max_distance, min_in_frame }` projects each bounding
sphere and reports a `Subject`: `distance`, `uv` (0..1, y down), `screen_size` (diameter / frame
height), `in_frame` (fraction of the bounding square inside the frame), `visible` (fraction of
sample rays to the camera that are unobstructed), `off_centre`, `kind`, `name`, `weight`. Replace
the finder with `PhotoHooks::subjects = Box::new(MyFinder)` (`trait SubjectQuery`). Scoring
(rarity, composition, focus) belongs in a `on_metadata` hook or in the reader of `PhotoTaken`.

**Saving.** `trait PhotoSink { fn save(&self, &PhotoTaken) -> Result<PathBuf, String> }`.
`PngFileSink::new(dir)` writes `photo-0001.png` (RGB) with the metadata JSON in a tEXt chunk named
`engine.photo` (`sink::read_png_text` reads it back). The plugin installs `<data dir>/photos` as the
default sink; set `PhotoHooks::sink` to your own (the platform user-folders module, a gallery
index...) or `None`. `sink::write_png(path, image, &[(key, value)])` is public.

## Control commands (feature `devtools`)

| Command | Params | Result |
|---|---|---|
| `photo.state` | — | cameras (settings + derived DoF/EV/FOV), `busy`, `taken`, `last` (metadata, path) |
| `photo.set` | `focal_mm?`, `aperture?`, `shutter_s?`, `iso?`, `focus_m?` (turns AF off), `autofocus?` | new settings |
| `photo.subjects` | — | subjects the first camera sees now (no capture) |
| `photo.shoot` | `width?`, `height?`, `save?` | queued; poll `photo.state` |

`scripts/sim-demo.json` drives the demo: a shot, subject listing, a 1920×1080 photo, lens changes.

## Measurements and limits

- Unit tests: `cargo test --lib photo` (FOV round trip, textbook DoF numbers, EV/blur, Bevy aperture
  compensation, autofocus convergence, projection and frame overlap, subject sort/filter, metadata
  hooks, PNG with metadata chunk, headless failure).
- The capture itself needs a renderer; it is exercised by `scripts/sim-demo.json` (offscreen).
- A photo costs a few frames of high-resolution rendering (4K: an extra 33 MB texture, freed after).
  Do it on a button press, not per frame.
- No lens distortion, vignette per aperture, chromatic aberration per lens, or flash. Focus
  breathing, rolling shutter, ISO noise are not modelled. Bokeh shape follows Bevy's DoF.
- `PhotoRequest::camera` must have `PhotoCamera`. Only the first camera is used by the control
  commands. Several `PhotoCamera`s would fight over `Look`.
- The window shows the photo-aspect render for ~5 frames while capturing (it is the same camera).
