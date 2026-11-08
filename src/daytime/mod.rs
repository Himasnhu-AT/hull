//! Time of day (feature `daytime`): a [`DayClock`] (hour, day of the year, latitude, speed)
//! moves a solar **sun**, a phased **moon**, a **star field** and a **cloud dome with cloud
//! shadows**, and rewrites the [`Look`](crate::look::Look) (sun light, fill, exposure, haze) from
//! keyframes on the sun's elevation. Docs: `docs/ENVIRONMENT.md`.
//!
//! ```ignore
//! app.insert_resource(DayClock { hours: 17.0, day: 200.0, latitude: 52.0, rate: 120.0, running: true, ..default() });
//! // Optional: knobs as data.
//! app.insert_resource(DayConfig { moon_follows: true, ..default() });
//! app.insert_resource(DayWeather { overcast: 0.4, ..default() });
//! commands.spawn((SpotLight::default(), NightLight::lamp(18_000.0)));   // on after dusk
//! ```
//!
//! Zero cost unused: with no [`DayClock`] resource no system here does any work. The `Look` is
//! rewritten only when the sun has moved one quantum (0.02 degrees, about once a second at 5x),
//! so `apply_look` runs about 1 Hz and the sky's env light refilters at most every 20 s.
//! [`LookTimeline`](crate::look::LookTimeline) (keyed whole looks on a free clock) stays the
//! tool for games without a real sun; this module drives the look instead when it exists
//! (it never writes while a `LookTimeline` / `LookTransition` is present).
//!
//! Control commands (feature `devtools`): `day.get`, `day.set`, `day.clouds`.

pub mod astro;
pub mod clouds;
pub mod keys;
mod lights;

#[cfg(feature = "devtools")]
mod control;

use bevy::prelude::*;

pub use clouds::{CloudConfig, CloudDome, CloudShadowParams, CloudState};
pub use keys::{DayKey, DayKeys, Light};
pub use lights::NightLight;

use crate::gfx::QualitySet;
use crate::look::{Look, LookConfig, LookTimeline, LookTransition};

/// The game clock. Insert it to turn the module on.
#[derive(Resource, Clone, Copy, Debug, PartialEq)]
pub struct DayClock {
    /// Local clock hour, `0..24`; solar noon is at `solar_noon`.
    pub hours: f32,
    /// Day of the year (0 = 1 January). Moves on at midnight.
    pub day: f32,
    /// Game seconds per real second (3600 = a day in 24 s; 1 = real time).
    pub rate: f32,
    pub running: bool,
    /// Degrees north (negative south).
    pub latitude: f32,
    /// Clock hour of solar noon (12 with no time-zone or summer-time shift).
    pub solar_noon: f32,
    /// A day of the year with a new moon; the phase cycle (29.53 days) runs from it.
    pub new_moon_day: f32,
}

impl Default for DayClock {
    fn default() -> Self {
        DayClock { hours: 10.0, day: 150.0, rate: 60.0, running: true, latitude: 45.0, solar_noon: 12.0, new_moon_day: 140.0 }
    }
}

impl DayClock {
    /// A clock where one day lasts `secs` real seconds.
    pub fn with_day_length(mut self, secs: f32) -> Self {
        self.rate = 86_400.0 / secs.max(1.0);
        self
    }
    pub fn sun(&self) -> (f32, f32) {
        astro::sun(self.latitude, self.day, self.hours, self.solar_noon)
    }
    pub fn moon(&self) -> astro::MoonState {
        astro::moon(self.latitude, self.day, self.hours, self.solar_noon, self.new_moon_day)
    }
    /// 0 at night .. 1 in full day, from the sun's elevation (-6 .. +6 degrees).
    pub fn daylight(&self) -> f32 {
        ((self.sun().1 + 6.0) / 12.0).clamp(0.0, 1.0)
    }
    pub fn is_night(&self) -> bool {
        self.daylight() < 0.05
    }
    /// Moves the clock on by `real_secs` real seconds (the day counter moves at midnight).
    pub fn advance(&mut self, real_secs: f32) {
        if !self.running {
            return;
        }
        self.hours += real_secs * self.rate / 3600.0;
        while self.hours >= 24.0 {
            self.hours -= 24.0;
            self.day = (self.day + 1.0).rem_euclid(365.0);
        }
    }
}

/// Weather as two knobs the sky understands. Other systems (rain, storms) write this.
#[derive(Resource, Clone, Copy, Debug, PartialEq, Default)]
pub struct DayWeather {
    /// Cloud coverage override 0..1 (`None`: from the keys by sun elevation).
    pub cover: Option<f32>,
    /// 0 clear .. 1 fully overcast: more cloud, dimmer direct sun, shorter visibility.
    pub overcast: f32,
}

/// The module's knobs. All data; `DayConfig::default()` is a temperate clear day.
#[derive(Resource, Clone, Debug)]
pub struct DayConfig {
    /// Rewrite the `Look` from the clock (off: only read `DaySky`, light your own scene).
    pub drive_look: bool,
    /// The look the day modulates: its tonemapping, grading, bloom, lens, sky mode and
    /// the fog's extinction stay; sun, ambient, exposure and fog colours come from the keys.
    pub base: Look,
    pub keys: DayKeys,
    /// Sunlight above the atmosphere (lux) and colour; Bevy's atmosphere reddens it.
    pub raw_sun: f32,
    pub sun_color: [f32; 3],
    /// Full-moon light (lux; ~2x a real full moon so night stays playable) and colour.
    pub moon_lux: f32,
    pub moon_color: [f32; 3],
    /// The moon takes over the light below this sun elevation (fully 3 degrees lower).
    pub moon_from: f32,
    /// The light follows the real moon (else: opposite the sun, 35 degrees up, all night).
    pub moon_follows: bool,
    /// Followed moon: never lower than this for lighting; below the horizon it dims to `moon_floor`.
    pub moon_min_elevation: f32,
    pub moon_floor: f32,
    /// A new moon gives this share of the full moon's light.
    pub moon_phase_dim: f32,
    /// While the sun is lower than this the light is held here and dimmed a decade per
    /// `twilight_decade` degrees (the sky's brightness through dusk).
    pub twilight_el: f32,
    pub twilight_decade: f32,
    /// Multiplier on the keyed haze visibility and its floor (m).
    pub visibility_scale: f32,
    pub min_visibility: f32,
    /// The look is rewritten once per this much sun travel (degrees).
    pub quantum_deg: f32,
    /// Env-light refresh rate while the sky moves (Hz; 0 leaves `LookConfig` alone).
    pub env_refresh_hz: f32,
    pub clouds: CloudConfig,
}

impl Default for DayConfig {
    fn default() -> Self {
        let mut base = Look::clear_day();
        base.fog.extinction = crate::look::Rgb::new(0.55, 0.62, 0.72);
        base.fog.sun_exponent = 18.0;
        DayConfig {
            drive_look: true,
            base,
            keys: DayKeys::default(),
            raw_sun: 110_000.0,
            sun_color: [1.0, 0.98, 0.95],
            moon_lux: 0.6,
            moon_color: [0.62, 0.72, 1.0],
            moon_from: -10.0,
            moon_follows: false,
            moon_min_elevation: 15.0,
            moon_floor: 0.35,
            moon_phase_dim: 0.3,
            twilight_el: -2.5,
            twilight_decade: 1.9,
            visibility_scale: 1.0,
            min_visibility: 150.0,
            quantum_deg: 0.02,
            env_refresh_hz: 0.05,
            clouds: CloudConfig::default(),
        }
    }
}

/// The sky for the current clock, refreshed whenever the clock, config or weather changes.
/// Read it for anything that follows the sun (lamps, ambient audio, plants, UI).
#[derive(Resource, Clone, Copy, Debug, PartialEq)]
pub struct DaySky {
    pub sun_azimuth: f32,
    pub sun_elevation: f32,
    /// World direction towards the sun.
    pub sun_dir: Vec3,
    pub moon: astro::MoonState,
    /// The directional light (sun, held through twilight, or moon).
    pub light: Light,
    /// 0 night .. 1 day.
    pub daylight: f32,
    /// Star visibility 0..1 (the sun at least 6 degrees under the horizon).
    pub stars: f32,
    /// Sidereal angle (radians): how far the stars have turned.
    pub sidereal: f32,
}

impl DaySky {
    pub fn compute(clock: &DayClock, cfg: &DayConfig) -> DaySky {
        let (az, el) = clock.sun();
        let moon = clock.moon();
        DaySky {
            sun_azimuth: az,
            sun_elevation: el,
            sun_dir: astro::to_dir(az, el),
            moon,
            light: keys::light_at(cfg, az, el, &moon),
            daylight: ((el + 6.0) / 12.0).clamp(0.0, 1.0),
            stars: ((-6.0 - el) / 6.0).clamp(0.0, 1.0),
            sidereal: astro::sidereal(clock.day, clock.hours, clock.solar_noon),
        }
    }
}

/// Ordering: `Clock` advances the time and refreshes [`DaySky`], `Look` writes the look (before
/// the engine applies it), `Clouds` feeds the cloud dome (after the look applied).
#[derive(SystemSet, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DaySet {
    Clock,
    Look,
    Clouds,
}

pub struct DaytimePlugin;

impl Plugin for DaytimePlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<DayConfig>()
            .init_resource::<DayWeather>()
            .init_resource::<DayLookState>()
            .init_resource::<EnvBoost>()
            .configure_sets(Update, (DaySet::Clock, DaySet::Look).chain().before(QualitySet::Look))
            .configure_sets(Update, DaySet::Clouds.after(QualitySet::Look))
            .add_systems(Update, (tick, refresh_sky).chain().in_set(DaySet::Clock).run_if(clock_exists))
            .add_systems(Update, (drive_look, env_cadence).chain().in_set(DaySet::Look).run_if(live))
            .add_systems(Update, lights::drive_night_lights.in_set(DaySet::Look).after(drive_look).run_if(resource_exists::<DaySky>));
        clouds::plugin(app);
        #[cfg(feature = "devtools")]
        control::register(app);
    }
}

fn clock_exists(clock: Option<Res<DayClock>>) -> bool {
    clock.is_some()
}

/// Run condition: the clock runs and the sky has been computed.
pub(crate) fn live(clock: Option<Res<DayClock>>, sky: Option<Res<DaySky>>) -> bool {
    clock.is_some() && sky.is_some()
}

/// Moves the clock on (virtual time: pause freezes it).
fn tick(time: Res<Time<Virtual>>, mut clock: ResMut<DayClock>) {
    if clock.running && time.delta_secs() > 0.0 {
        clock.advance(time.delta_secs());
    }
}

fn refresh_sky(mut commands: Commands, clock: Res<DayClock>, cfg: Res<DayConfig>, sky: Option<ResMut<DaySky>>) {
    let Some(mut sky) = sky else {
        commands.insert_resource(DaySky::compute(&clock, &cfg));
        return;
    };
    if clock.is_changed() || cfg.is_changed() {
        let new = DaySky::compute(&clock, &cfg);
        if *sky != new {
            *sky = new;
        }
    }
}

/// Look-writing bookkeeping (`day.get` shows the write count).
#[derive(Resource, Default, Debug)]
pub struct DayLookState {
    /// The sun quantum last written.
    last: Option<i64>,
    last_el: f32,
    pub writes: u64,
}

/// Until this real time the env light may refilter quickly (after a clock jump).
#[derive(Resource, Default)]
pub struct EnvBoost(pub f64);

/// Lets the sky light catch up with a jump of the clock within a second (3 s of fast refresh).
pub fn refresh_env_soon(world: &mut World) {
    let now = world.get_resource::<Time<Real>>().map_or(0.0, |t| t.elapsed_secs_f64());
    if let Some(mut b) = world.get_resource_mut::<EnvBoost>() {
        b.0 = now + 3.0;
    }
}

/// Rewrites the `Look` from the sky when the sun has moved a quantum (or config / weather changed).
fn drive_look(
    mut commands: Commands,
    sky: Res<DaySky>,
    clock: Res<DayClock>,
    cfg: Res<DayConfig>,
    weather: Res<DayWeather>,
    real: Res<Time<Real>>,
    look: Option<ResMut<Look>>,
    timeline: Option<Res<LookTimeline>>,
    transition: Option<Res<LookTransition>>,
    mut boost: ResMut<EnvBoost>,
    mut st: ResMut<DayLookState>,
) {
    if !cfg.drive_look || timeline.is_some() || transition.is_some() {
        return;
    }
    // No `Look` yet: this module makes the first one (the `Look` plugin applies it).
    let Some(mut look) = look else {
        commands.insert_resource(keys::day_look(&cfg, &weather, sky.sun_azimuth, sky.sun_elevation, &sky.moon, format!("day {:.2}", clock.hours)));
        st.writes += 1;
        return;
    };
    let quantum_h = (cfg.quantum_deg / 15.0).max(1e-5);
    let q = ((clock.day * 24.0 + clock.hours) / quantum_h).floor() as i64;
    let forced = cfg.is_changed() || weather.is_changed() || look.is_added();
    if st.last == Some(q) && !forced {
        return;
    }
    if (sky.sun_elevation - st.last_el).abs() > 1.0 && st.last.is_some() {
        boost.0 = real.elapsed_secs_f64() + 3.0;
    }
    st.last = Some(q);
    st.last_el = sky.sun_elevation;
    st.writes += 1;
    *look = keys::day_look(&cfg, &weather, sky.sun_azimuth, sky.sun_elevation, &sky.moon, format!("day {:.2}", clock.hours));
}

fn env_cadence(real: Res<Time<Real>>, boost: Res<EnvBoost>, cfg: Res<DayConfig>, config: Option<ResMut<LookConfig>>) {
    let Some(mut config) = config else { return };
    if cfg.env_refresh_hz <= 0.0 {
        return;
    }
    let want = if real.elapsed_secs_f64() < boost.0 { 4.0 } else { cfg.env_refresh_hz };
    if config.env_refresh_hz != want {
        config.env_refresh_hz = want;
    }
}
