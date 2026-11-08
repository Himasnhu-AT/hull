//! Physical camera and photos (feature `photo`). A [`PhotoCamera`] on a camera entity holds a
//! lens (focal length on a sensor), aperture, shutter speed, ISO and focus (manual or
//! autofocus raycast). Each frame the plugin turns those into the camera's field of view and
//! the [`crate::look::Look`] lens block (depth of field, motion blur, exposure). A
//! [`PhotoRequest`] renders the view into a high-resolution image and emits [`PhotoTaken`] with
//! [`PhotoMetadata`] (lens, pose, the [`Photographable`]s in frame) that games extend through
//! hooks. Docs: `docs/PHOTO.md`.
//!
//! ```ignore
//! commands.spawn((Camera3d::default(), MainCamera, PhotoCamera::tele()));
//! commands.spawn((Photographable { kind: "deer".into(), radius: 0.8, ..default() }, Transform::..));
//! requests.write(PhotoRequest::default());                  // fire
//! for p in taken.read() { p.metadata.subjects; p.path }     // react
//! app.world_mut().resource_mut::<PhotoHooks>().on_metadata(|world, m| { m.extra.insert("score".into(), 3.into()); });
//! ```
//! Saving goes through [`PhotoSink`]; the default writes PNGs (metadata in a tEXt chunk) to
//! `<data dir>/photos`. Capture needs a renderer (not `--headless`).

pub mod lens;
pub mod sink;
pub mod subjects;

#[cfg(feature = "devtools")]
mod control;

use std::sync::Arc;

use avian3d::prelude::{SpatialQuery, SpatialQueryFilter};
use bevy::camera::RenderTarget;
use bevy::prelude::*;
use bevy::render::render_resource::{TextureFormat, TextureUsages};
use bevy::render::view::window::screenshot::{Screenshot, ScreenshotCaptured};
use serde::Serialize;

pub use sink::{PhotoSink, PngFileSink};
pub use subjects::{CameraView, FrustumSubjects, Photographable, Subject, SubjectQuery};

use crate::look::Look;

/// System sets, for ordering game systems around the lens update.
#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PhotoSet {
    Autofocus,
    /// Writes the camera FOV and the `Look` lens/exposure fields.
    Lens,
    Capture,
}

/// A camera with real-world controls. Put it next to `Camera3d` (and `MainCamera` if the look
/// should follow it: only one camera drives the shared `Look`).
#[derive(Component, Clone, Debug, Reflect)]
#[reflect(Component)]
#[require(LensState)]
pub struct PhotoCamera {
    pub focal_mm: f32,
    /// Zoom limits for [`PhotoCamera::zoom`].
    pub focal_range: (f32, f32),
    pub sensor_height_mm: f32,
    pub aperture: f32,
    pub aperture_range: (f32, f32),
    pub shutter_s: f32,
    pub iso: f32,
    /// Focus distance (m). Written by autofocus when `autofocus` is on.
    pub focus_m: f32,
    pub autofocus: bool,
    /// Autofocus speed: fraction of the log-distance gap closed per second.
    pub af_speed: f32,
    pub af_max_m: f32,
    /// Drive `Look::lens.dof` (depth of field).
    pub dof: bool,
    /// Drive `Look::lens.motion_blur` from the shutter speed.
    pub motion_blur: bool,
    /// Drive `Look::exposure.ev100` (and turn auto exposure off) from aperture, shutter and ISO.
    pub exposure_link: bool,
    /// Added to the physical EV100 (exposure compensation, stops; positive = darker).
    pub exposure_bias_ev: f32,
}

impl Default for PhotoCamera {
    fn default() -> Self {
        PhotoCamera {
            focal_mm: 35.0,
            focal_range: (18.0, 600.0),
            sensor_height_mm: lens::FULL_FRAME_HEIGHT_MM,
            aperture: 5.6,
            aperture_range: (1.4, 22.0),
            shutter_s: 1.0 / 500.0,
            iso: 100.0,
            focus_m: 10.0,
            autofocus: true,
            af_speed: 6.0,
            af_max_m: 500.0,
            dof: true,
            motion_blur: true,
            exposure_link: true,
            exposure_bias_ev: 0.0,
        }
    }
}

impl PhotoCamera {
    pub fn wide() -> Self {
        PhotoCamera { focal_mm: 24.0, aperture: 8.0, ..default() }
    }
    pub fn tele() -> Self {
        PhotoCamera { focal_mm: 200.0, aperture: 4.0, ..default() }
    }
    pub fn fov_y(&self) -> f32 {
        lens::vertical_fov(self.focal_mm, self.sensor_height_mm)
    }
    /// Multiply the focal length (clamped to `focal_range`).
    pub fn zoom(&mut self, factor: f32) {
        self.focal_mm = (self.focal_mm * factor).clamp(self.focal_range.0, self.focal_range.1);
    }
    /// Move the aperture by `stops` full stops (clamped).
    pub fn stop_aperture(&mut self, stops: f32) {
        self.aperture = (self.aperture * 2f32.powf(stops * 0.5)).clamp(self.aperture_range.0, self.aperture_range.1);
    }
}

/// What the lens does right now (derived each frame from [`PhotoCamera`]).
#[derive(Component, Clone, Copy, Debug, Default, Reflect, Serialize)]
#[reflect(Component)]
pub struct LensState {
    pub fov_y: f32,
    pub ev100: f32,
    pub hyperfocal_m: f32,
    /// Sharp from `near_m` to `far_m` around the focus distance (`far_m` may be infinite).
    pub near_m: f32,
    pub far_m: f32,
    /// Bevy `DepthOfField` aperture after sensor-size compensation.
    pub bevy_aperture: f32,
    /// Motion blur shutter angle as a fraction of a frame.
    pub blur_angle: f32,
}

/// Photo settings.
#[derive(Resource, Clone, Debug)]
pub struct PhotoConfig {
    /// Resolution of a photo (the camera aspect follows the render target).
    pub resolution: UVec2,
    /// Frames the camera renders at the photo resolution before the capture (lets history
    /// effects and auto exposure settle).
    pub settle_frames: u32,
    /// Frame rate the shutter speed is judged against for motion blur.
    pub ref_fps: f32,
    pub min_focus_m: f32,
    /// Give up and restore the camera after this many frames without a capture.
    pub timeout_frames: u32,
    /// Hide root UI nodes while the photo renders (the UI camera is usually the photo camera,
    /// so the HUD would end up in the picture).
    pub hide_ui: bool,
}

impl Default for PhotoConfig {
    fn default() -> Self {
        PhotoConfig { resolution: UVec2::new(3840, 2160), settle_frames: 3, ref_fps: 60.0, min_focus_m: 0.3, timeout_frames: 180, hide_ui: true }
    }
}

/// Take a photo with `camera` (default: the first [`PhotoCamera`]).
#[derive(Message, Clone, Debug, Default)]
pub struct PhotoRequest {
    pub camera: Option<Entity>,
    /// Override [`PhotoConfig::resolution`].
    pub resolution: Option<UVec2>,
    /// Don't hand the photo to the sink (it is still announced).
    pub skip_save: bool,
}

/// Lens settings frozen at the moment of the photo.
#[derive(Clone, Debug, Serialize)]
pub struct LensSnapshot {
    pub focal_mm: f32,
    pub aperture: f32,
    pub shutter_s: f32,
    pub iso: f32,
    pub focus_m: f32,
    pub fov_deg: f32,
    pub ev100: f32,
    pub dof_near_m: f32,
    /// `None` = infinity.
    pub dof_far_m: Option<f32>,
}

/// Everything known about a photo. Games add to `extra` through [`PhotoHooks::on_metadata`].
#[derive(Clone, Debug, Serialize)]
pub struct PhotoMetadata {
    pub id: u64,
    pub time_secs: f64,
    pub position: [f32; 3],
    /// Camera rotation quaternion `[x, y, z, w]`.
    pub rotation: [f32; 4],
    pub lens: LensSnapshot,
    pub resolution: [u32; 2],
    pub subjects: Vec<Subject>,
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// A finished photo.
#[derive(Message, Clone, Debug)]
pub struct PhotoTaken {
    pub image: Arc<Image>,
    pub metadata: PhotoMetadata,
    /// Where the sink put it (`None`: not saved, or the sink failed: see `save_error`).
    pub path: Option<std::path::PathBuf>,
    pub save_error: Option<String>,
}

/// A capture that could not happen.
#[derive(Message, Clone, Debug)]
pub struct PhotoFailed {
    pub reason: String,
}

type MetadataHook = Box<dyn Fn(&mut World, &mut PhotoMetadata) + Send + Sync>;

/// Extension points: who finds subjects, where photos are saved, extra metadata.
#[derive(Resource)]
pub struct PhotoHooks {
    pub subjects: Box<dyn SubjectQuery>,
    /// `None` = never save.
    pub sink: Option<Box<dyn PhotoSink>>,
    metadata: Vec<MetadataHook>,
}

impl Default for PhotoHooks {
    fn default() -> Self {
        PhotoHooks { subjects: Box::new(FrustumSubjects::default()), sink: None, metadata: Vec::new() }
    }
}

impl PhotoHooks {
    /// Runs when a photo is requested (the scene as it is when the shutter fires).
    pub fn on_metadata(&mut self, f: impl Fn(&mut World, &mut PhotoMetadata) + Send + Sync + 'static) -> &mut Self {
        self.metadata.push(Box::new(f));
        self
    }
}

struct Active {
    camera: Entity,
    prev_target: RenderTarget,
    handle: Handle<Image>,
    meta: PhotoMetadata,
    save: bool,
    settle: u32,
    shot_requested: bool,
    age: u32,
    hidden_ui: Vec<(Entity, Visibility)>,
}

/// Capture bookkeeping.
#[derive(Resource, Default)]
pub struct PhotoCapture {
    active: Option<Active>,
    captured: Option<Image>,
    next_id: u64,
    /// The last finished photo's metadata and path.
    pub last: Option<(PhotoMetadata, Option<std::path::PathBuf>)>,
    pub taken: u32,
}

impl PhotoCapture {
    pub fn busy(&self) -> bool {
        self.active.is_some()
    }
}

pub struct PhotoPlugin;

impl Plugin for PhotoPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<PhotoConfig>()
            .init_resource::<PhotoHooks>()
            .init_resource::<PhotoCapture>()
            .add_message::<PhotoRequest>()
            .add_message::<PhotoTaken>()
            .add_message::<PhotoFailed>()
            .register_type::<PhotoCamera>()
            .register_type::<LensState>()
            .register_type::<Photographable>()
            .configure_sets(Update, (PhotoSet::Autofocus, PhotoSet::Lens, PhotoSet::Capture).chain())
            .add_systems(
                Update,
                (
                    autofocus.in_set(PhotoSet::Autofocus).run_if(any_with_component::<PhotoCamera>),
                    update_lens.in_set(PhotoSet::Lens).run_if(any_with_component::<PhotoCamera>).before(crate::look::apply::apply_look),
                    (start_capture, drive_capture, finish_capture).chain().in_set(PhotoSet::Capture),
                ),
            );
        #[cfg(feature = "devtools")]
        control::register(app);
    }

    fn finish(&self, app: &mut App) {
        // Default sink: <data dir>/photos, unless the game already chose.
        let dir = app.world().get_resource::<crate::paths::DataDir>().map(|d| d.0.join("photos"));
        if let Some(dir) = dir {
            let mut hooks = app.world_mut().resource_mut::<PhotoHooks>();
            if hooks.sink.is_none() {
                hooks.sink = Some(Box::new(PngFileSink::new(dir)));
            }
        }
    }
}

/// Raycast along the camera's forward axis and ease the focus toward what it hits.
fn autofocus(spatial: SpatialQuery, time: Res<Time>, cfg: Res<PhotoConfig>, mut cams: Query<(&mut PhotoCamera, &GlobalTransform)>) {
    let filter = SpatialQueryFilter::default();
    for (mut cam, gt) in &mut cams {
        if !cam.autofocus {
            continue;
        }
        let target = match spatial.cast_ray(gt.translation(), gt.forward(), cam.af_max_m, true, &filter) {
            Some(h) => h.distance,
            None => cam.af_max_m,
        };
        let f = lens::focus_step(cam.focus_m, target.max(cfg.min_focus_m), cam.af_speed, time.delta_secs());
        if (f - cam.focus_m).abs() > 1e-4 {
            cam.focus_m = f;
        }
    }
}

/// Camera physics into FOV + `Look`.
fn update_lens(
    cfg: Res<PhotoConfig>,
    mut cams: Query<(&PhotoCamera, &mut LensState, Option<&mut Projection>, Has<crate::gfx::MainCamera>)>,
    mut look: Option<ResMut<Look>>,
) {
    for (cam, mut st, proj, main) in &mut cams {
        let coc = lens::coc_limit_mm(cam.sensor_height_mm);
        let dof = lens::depth_of_field(cam.focal_mm, cam.aperture, cam.focus_m, coc);
        let new = LensState {
            fov_y: cam.fov_y(),
            ev100: lens::ev100(cam.aperture, cam.shutter_s, cam.iso) + cam.exposure_bias_ev,
            hyperfocal_m: dof.hyperfocal_m,
            near_m: dof.near_m,
            far_m: dof.far_m,
            bevy_aperture: lens::bevy_aperture(cam.aperture, cam.sensor_height_mm),
            blur_angle: lens::blur_shutter_angle(cam.shutter_s, cfg.ref_fps),
        };
        if new.fov_y != st.fov_y || new.ev100 != st.ev100 || new.near_m != st.near_m || new.far_m != st.far_m || new.blur_angle != st.blur_angle {
            *st = new;
        }
        if let Some(mut p) = proj
            && let Projection::Perspective(pp) = &mut *p
            && (pp.fov - new.fov_y).abs() > 1e-5
        {
            pp.fov = new.fov_y;
        }
        // One camera drives the shared look: the main camera, or the only one.
        let Some(look) = look.as_mut() else { continue };
        if !main && !cam.dof && !cam.motion_blur && !cam.exposure_link {
            continue;
        }
        let l = look.bypass_change_detection();
        let mut changed = false;
        if cam.dof {
            if !l.lens.dof.enabled {
                l.lens.dof.enabled = true;
                changed = true;
            }
            changed |= set_f(&mut l.lens.dof.focal_distance, cam.focus_m);
            changed |= set_f(&mut l.lens.dof.aperture_f_stops, new.bevy_aperture);
        } else if l.lens.dof.enabled {
            l.lens.dof.enabled = false;
            changed = true;
        }
        if cam.motion_blur {
            if !l.lens.motion_blur.enabled {
                l.lens.motion_blur.enabled = true;
                changed = true;
            }
            changed |= set_f(&mut l.lens.motion_blur.shutter_angle, new.blur_angle);
        } else if l.lens.motion_blur.enabled {
            l.lens.motion_blur.enabled = false;
            changed = true;
        }
        if cam.exposure_link {
            if l.exposure.auto {
                l.exposure.auto = false;
                changed = true;
            }
            changed |= set_f(&mut l.exposure.ev100, new.ev100);
        }
        if changed {
            look.set_changed();
        }
    }
}

/// Sets `dst` when it differs; reports whether it did.
fn set_f(dst: &mut f32, v: f32) -> bool {
    let diff = (*dst - v).abs() > 1e-4;
    if diff {
        *dst = v;
    }
    diff
}

fn camera_view(world: &World, cam: Entity) -> Option<CameraView> {
    let gt = world.get::<GlobalTransform>(cam)?;
    let (_, rot, pos) = gt.to_scale_rotation_translation();
    let (fov_y, aspect, near, far) = match world.get::<Projection>(cam) {
        Some(Projection::Perspective(p)) => (p.fov, p.aspect_ratio, p.near, p.far),
        _ => (world.get::<PhotoCamera>(cam)?.fov_y(), 16.0 / 9.0, 0.1, 1000.0),
    };
    Some(CameraView { pos, rot, fov_y, aspect, near, far })
}

/// Metadata for a photo taken with `cam` now: lens, pose and subjects, then game hooks.
/// (Public so tests and games can preview a shot without rendering.)
pub fn build_metadata(world: &mut World, cam: Entity, id: u64, resolution: UVec2) -> Option<PhotoMetadata> {
    let pc = world.get::<PhotoCamera>(cam)?.clone();
    let ls = world.get::<LensState>(cam).copied().unwrap_or_default();
    let mut view = camera_view(world, cam)?;
    view.aspect = resolution.x as f32 / resolution.y.max(1) as f32;
    let (position, rotation) = (view.pos.to_array(), view.rot.to_array());
    let mut meta = PhotoMetadata {
        id,
        time_secs: world.get_resource::<Time>().map(|t| t.elapsed_secs_f64()).unwrap_or(0.0),
        position,
        rotation,
        lens: LensSnapshot {
            focal_mm: pc.focal_mm,
            aperture: pc.aperture,
            shutter_s: pc.shutter_s,
            iso: pc.iso,
            focus_m: pc.focus_m,
            fov_deg: pc.fov_y().to_degrees(),
            ev100: ls.ev100,
            dof_near_m: ls.near_m,
            dof_far_m: ls.far_m.is_finite().then_some(ls.far_m),
        },
        resolution: resolution.to_array(),
        subjects: Vec::new(),
        extra: Default::default(),
    };
    world.resource_scope(|world, hooks: Mut<PhotoHooks>| {
        meta.subjects = hooks.subjects.find(world, &view);
        for h in &hooks.metadata {
            h(world, &mut meta);
        }
    });
    Some(meta)
}

fn can_render(world: &World) -> bool {
    world.contains_resource::<Assets<Image>>() && !world.get_resource::<crate::flow::Headless>().is_some_and(|h| h.0)
}

fn fail(world: &mut World, reason: impl Into<String>) {
    let reason = reason.into();
    warn!("photo: {reason}");
    world.write_message(PhotoFailed { reason });
}

fn start_capture(world: &mut World) {
    let reqs: Vec<PhotoRequest> = world.resource_mut::<Messages<PhotoRequest>>().drain().collect();
    for req in reqs {
        if world.resource::<PhotoCapture>().busy() {
            fail(world, "a photo is already being taken");
            continue;
        }
        if !can_render(world) {
            fail(world, "taking a photo needs a renderer (not --headless)");
            continue;
        }
        let cam = req.camera.or_else(|| world.query_filtered::<Entity, With<PhotoCamera>>().iter(world).next());
        let Some(cam) = cam.filter(|c| world.get::<PhotoCamera>(*c).is_some()) else {
            fail(world, "no PhotoCamera");
            continue;
        };
        let res = req.resolution.unwrap_or(world.resource::<PhotoConfig>().resolution).clamp(UVec2::splat(16), UVec2::splat(16384));
        let id = {
            let mut c = world.resource_mut::<PhotoCapture>();
            c.next_id += 1;
            c.next_id
        };
        let Some(meta) = build_metadata(world, cam, id, res) else {
            fail(world, "camera has no transform");
            continue;
        };
        let mut image = Image::new_target_texture(res.x, res.y, TextureFormat::Rgba8UnormSrgb, None);
        image.texture_descriptor.usage |= TextureUsages::COPY_SRC;
        let handle = world.resource_mut::<Assets<Image>>().add(image);
        let prev_target = world.get::<RenderTarget>(cam).cloned().unwrap_or_default();
        retarget(world, cam, RenderTarget::from(handle.clone()));
        let settle = world.resource::<PhotoConfig>().settle_frames;
        let mut hidden_ui = Vec::new();
        if world.resource::<PhotoConfig>().hide_ui {
            let mut roots = world.query_filtered::<(Entity, &Visibility), (With<Node>, Without<ChildOf>)>();
            hidden_ui = roots.iter(world).map(|(e, v)| (e, *v)).collect();
            for (e, _) in &hidden_ui {
                world.entity_mut(*e).insert(Visibility::Hidden);
            }
        }
        world.resource_mut::<PhotoCapture>().active =
            Some(Active { camera: cam, prev_target, handle, meta, save: !req.skip_save, settle, shot_requested: false, age: 0, hidden_ui });
        return;
    }
}

/// Bevy 0.20 recomputes a camera's target size on a Projection change, not on a RenderTarget
/// change (same trick as `devtools::offscreen`).
fn retarget(world: &mut World, cam: Entity, target: RenderTarget) {
    if let Ok(mut e) = world.get_entity_mut(cam) {
        e.insert(target);
        if let Some(mut p) = e.get_mut::<Projection>() {
            p.set_changed();
        }
    }
}

fn drive_capture(world: &mut World) {
    let timeout = world.resource::<PhotoConfig>().timeout_frames;
    let mut cap = world.resource_mut::<PhotoCapture>();
    let Some(a) = cap.active.as_mut() else { return };
    a.age += 1;
    if a.age > timeout {
        let a = cap.active.take().unwrap();
        restore(world, a);
        fail(world, "capture timed out");
        return;
    }
    if a.settle > 0 {
        a.settle -= 1;
        return;
    }
    if !a.shot_requested {
        a.shot_requested = true;
        let handle = a.handle.clone();
        world.spawn(Screenshot::image(handle)).observe(|e: On<ScreenshotCaptured>, mut cap: ResMut<PhotoCapture>| {
            cap.captured = Some(e.image.clone());
        });
    }
}

fn restore(world: &mut World, a: Active) {
    for (e, v) in a.hidden_ui {
        if let Ok(mut e) = world.get_entity_mut(e) {
            e.insert(v);
        }
    }
    retarget(world, a.camera, a.prev_target);
    world.resource_mut::<Assets<Image>>().remove(&a.handle);
}

fn finish_capture(world: &mut World) {
    let Some(image) = world.resource_mut::<PhotoCapture>().captured.take() else { return };
    let Some(a) = world.resource_mut::<PhotoCapture>().active.take() else { return };
    let (meta, save) = (a.meta.clone(), a.save);
    restore(world, a);
    complete_photo(world, image, meta, save);
}

/// Saves (through the sink) and announces a finished photo. Split out so tests and custom
/// capture paths can feed in an image.
pub fn complete_photo(world: &mut World, image: Image, metadata: PhotoMetadata, save: bool) {
    let mut photo = PhotoTaken { image: Arc::new(image), metadata, path: None, save_error: None };
    if save {
        let hooks = world.resource::<PhotoHooks>();
        if let Some(sink) = &hooks.sink {
            match sink.save(&photo) {
                Ok(p) => photo.path = Some(p),
                Err(e) => {
                    warn!("photo: saving failed: {e}");
                    photo.save_error = Some(e);
                }
            }
        }
    }
    let mut cap = world.resource_mut::<PhotoCapture>();
    cap.last = Some((photo.metadata.clone(), photo.path.clone()));
    cap.taken += 1;
    world.write_message(photo);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app() -> App {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins).init_resource::<Look>().init_resource::<PhotoConfig>().init_resource::<PhotoHooks>().init_resource::<PhotoCapture>();
        app.add_message::<PhotoTaken>().add_message::<PhotoFailed>();
        app
    }

    #[test]
    fn lens_drives_fov_and_look() {
        let mut app = app();
        app.add_systems(Update, update_lens);
        let cam = app
            .world_mut()
            .spawn((Camera3d::default(), crate::gfx::MainCamera, PhotoCamera { focal_mm: 200.0, aperture: 2.8, shutter_s: 1.0 / 30.0, focus_m: 20.0, autofocus: false, ..default() }))
            .id();
        app.update();
        let w = app.world();
        let Projection::Perspective(p) = w.get::<Projection>(cam).unwrap() else { panic!() };
        assert!((p.fov.to_degrees() - lens::vertical_fov(200.0, 24.0).to_degrees()).abs() < 1e-3);
        let look = w.resource::<Look>();
        assert!(look.lens.dof.enabled && look.lens.dof.focal_distance == 20.0);
        assert!(look.lens.dof.aperture_f_stops < 2.8, "bigger sensor than Bevy's: wider Bevy aperture");
        assert!(look.lens.motion_blur.enabled && look.lens.motion_blur.shutter_angle > 0.5);
        assert!(!look.exposure.auto);
        let ls = w.get::<LensState>(cam).unwrap();
        assert!((look.exposure.ev100 - lens::ev100(2.8, 1.0 / 30.0, 100.0)).abs() < 1e-3);
        assert!(ls.near_m < 20.0 && ls.far_m > 20.0 && ls.far_m.is_finite());
        // Stopping down deepens the field.
        let depth = ls.far_m - ls.near_m;
        app.world_mut().get_mut::<PhotoCamera>(cam).unwrap().aperture = 11.0;
        app.update();
        let ls = app.world().get::<LensState>(cam).unwrap();
        assert!(ls.far_m - ls.near_m > depth);
    }

    #[test]
    fn metadata_lists_subjects_and_runs_hooks() {
        let mut app = app();
        app.add_systems(Update, update_lens);
        let cam = app.world_mut().spawn((Camera3d::default(), PhotoCamera { autofocus: false, ..default() }, Transform::default(), GlobalTransform::default())).id();
        for (kind, p) in [("fox", Vec3::new(0.0, 0.0, -12.0)), ("owl", Vec3::new(0.0, 0.0, 12.0))] {
            app.world_mut().spawn((Photographable { kind: kind.into(), radius: 0.4, ..default() }, GlobalTransform::from(Transform::from_translation(p))));
        }
        app.world_mut().resource_mut::<PhotoHooks>().on_metadata(|w, m| {
            m.extra.insert("subject_count".into(), m.subjects.len().into());
            let _ = w;
        });
        app.update();
        let m = build_metadata(app.world_mut(), cam, 7, UVec2::new(1920, 1080)).unwrap();
        assert_eq!(m.id, 7);
        assert_eq!(m.subjects.len(), 1, "the owl is behind the camera");
        assert_eq!(m.subjects[0].kind, "fox");
        assert_eq!(m.extra["subject_count"], 1);
        assert_eq!(m.resolution, [1920, 1080]);
        serde_json::to_string(&m).unwrap();
    }

    #[test]
    fn completing_a_photo_saves_png_with_metadata() {
        let mut app = app();
        let dir = std::env::temp_dir().join(format!("engine-photo-{}", std::process::id()));
        app.world_mut().resource_mut::<PhotoHooks>().sink = Some(Box::new(PngFileSink::new(&dir)));
        let cam = app.world_mut().spawn((PhotoCamera::default(), Transform::default(), GlobalTransform::default())).id();
        app.world_mut().resource_mut::<PhotoCapture>().next_id = 41;
        let meta = build_metadata(app.world_mut(), cam, 42, UVec2::new(4, 2)).unwrap();
        let mut img = Image::new_target_texture(4, 2, TextureFormat::Rgba8UnormSrgb, None);
        img.data = Some((0..32).map(|i| i as u8 * 8).collect());
        complete_photo(app.world_mut(), img, meta, true);
        let path = app.world().resource::<PhotoCapture>().last.clone().unwrap().1.expect("saved");
        assert!(path.ends_with("photo-0042.png"));
        let text = sink::read_png_text(&path, "engine.photo").expect("metadata chunk");
        assert!(text.contains("\"id\":42"));
        let mut msgs = app.world_mut().resource_mut::<Messages<PhotoTaken>>();
        assert_eq!(msgs.drain().count(), 1);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn headless_requests_fail_cleanly() {
        let mut app = app();
        app.add_message::<PhotoRequest>().add_systems(Update, start_capture);
        app.world_mut().spawn((PhotoCamera::default(), Transform::default(), GlobalTransform::default()));
        app.world_mut().write_message(PhotoRequest::default());
        app.update();
        let n = app.world_mut().resource_mut::<Messages<PhotoFailed>>().drain().count();
        assert_eq!(n, 1, "no Assets<Image> in a bare app");
    }
}
