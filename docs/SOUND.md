# Sound (`engine::sound`, feature `sound`)

A small Wwise/FMOD-style audio layer, defined in Rust. It covers a bus/mixer tree, mix
snapshots, sidechain ducking, sound cues (variants, randomisation, cooldown, instance and voice
limits with stealing, delay), 3D (rolloff curves, panning, doppler, rear darkening, raycast
occlusion), reverb/ambience zones, layered music with quantized transitions, and captions.
Everything can be inspected and driven from the control port, and everything except the final
sample output can be tested headless with `App::update()`.

No new dependencies. The engine plays one rodio source (`MixStream`) through Bevy's audio
output, and all the DSP is ours (`src/sound/dsp.rs`). This means the same effects run on every
platform, and offline rendering in tests uses exactly the same code.

```text
SoundCtl::play("cue") ─▶ Voices ─────────────┐ only changed params
SoundZone ─▶ snapshot weights / ambience     ├─▶ SoundBackend ─▶ dsp::Renderer (audio thread)
Music (stems, intensity, bar-quantized)  ────┤     Device | Offline | None     voices → bus tree
Mixer (buses, snapshots, ducks) ─────────────┘                                  → reverb → master
```

`PostUpdate`, after transform propagation: `SoundSet::Gather` (settings → bus volumes, pause
snapshot, listener, zones, legacy loops) → `SoundSet::Voices` (occlusion rays, voices, music) →
`SoundSet::Mix` (mixer → bus commands, backend frame, stats, captions).

## Quick start

```rust
use engine::prelude::*;
use engine::sound::{synth, Caption};

fn setup(mut cues: ResMut<SoundCues>, mut clips: ResMut<Assets<SoundClip>>, server: Res<AssetServer>) {
    cues.add(SoundCue::new("pickup").clip(server.load("audio/pickup.wav")).pitch_jitter(1.0).bus("sfx"));
    cues.add(SoundCue::new("beep").clip(clips.add(synth::blip(880.0, 0.1))).bus("ui").cooldown(0.05));
    cues.add(
        SoundCue::new("guard.alert")
            .clips([server.load("vo/alert_0.ogg"), server.load("vo/alert_1.ogg")])
            .pick(Pick::Sequence)
            .bus("voice")
            .priority(220)
            .caption(Caption::speech("Guard", "Who's there?"))
            .caption(Caption::speech("Guard", "Show yourself!")),
    );
}

fn gameplay(mut ctl: ResMut<SoundCtl>, enemy: Single<Entity, With<Enemy>>) {
    ctl.play("beep");                                  // 2D
    ctl.play_at("pickup", Vec3::new(3.0, 0.0, -2.0));  // 3D at a point
    let v = ctl.play_on("engine.loop", *enemy);        // 3D, follows + stops with the entity
    ctl.stop(v, 0.5);                                  // fade out
}
```

`SoundPlugin` is added by `EnginePlugin` when the feature is on (it is in `default`). See
`examples/sound_demo.rs` for a full scene with no audio files.

## Clips

`SoundClip` holds decoded f32 PCM (mono or stereo) behind an `Arc`, so it is shared with the
audio thread without copying.
- `.wav` (8/16/24/32-bit int, 32-bit float, WAVE_FORMAT_EXTENSIBLE) uses our parser. `.ogg` uses
  Bevy's vorbis decoder. Both are decoded **once, at load**, on the asset task pool:
  `server.load::<SoundClip>("x.ogg")`. Bevy's own `AudioSource` loader still serves
  `Handle<AudioSource>`; the handle type picks the loader.
- `synth::{tone, blip, chirp, noise_burst, drone, babble, music_stem}` generate small test
  sounds in code (deterministic, so tests and demos ship no binaries). `SoundClip::to_wav()`
  writes 16-bit WAV.

## Cues (`SoundCue`, registry `SoundCues`)

| Field | Meaning |
|---|---|
| `clips`, `pick` | variants; `Pick::Random`, `Shuffle` (each once per round, never twice in a row), `Sequence` |
| `bus` | bus name (default `"sfx"`) |
| `volume_db`, `volume_jitter_db` | level ± uniform dB |
| `pitch_semitones`, `pitch_jitter` | pitch ± uniform semitones |
| `cooldown` | seconds during which new starts are rejected |
| `max_instances`, `steal` | per-cue limit; `Steal::Oldest / Quietest / Farthest / Reject` |
| `priority` | 0..255; decides the global voice limit |
| `delay`, `fade_in`, `looping` | |
| `spatial: Option<Attenuation>` | `min_distance`, `max_distance`, `rolloff` (`Logarithmic`, `Linear`, `Custom(points)`), `spatial_blend` (0 = 2D), `doppler`, `occlusion` |
| `captions` | one caption for all clips, or one per clip |

Selection uses a seeded xorshift RNG (seeded from `GameSeed`), so runs with `--seed` play back
the same way.

## Voices: limits, stealing, culling, virtual voices

A voice is an entry in a flat list (`Voices`), not an entity, so one-shots cause no
archetype moves. Lifecycle:

1. **Request** (`SoundCtl::play*`): cooldown, then the per-cue instance limit (steals by policy
   or rejects).
2. `Loading` (the clip isn't loaded yet; dropped after `SoundConfig::load_timeout`) → `Delayed`.
3. **Admission:** loudness *as heard* = voice gain × attenuation × occlusion × the bus chain.
   - Below `cull_db` (−60 dB): a one-shot is **culled** (never started) and a loop goes
     **virtual**.
   - Global limit `max_voices` (48): score = `priority + loudness`. A newcomer steals the
     lowest-scored real voice if it beats it. Otherwise a one-shot is dropped and a loop goes
     virtual.
4. **Virtual** voices keep their clock and cost no DSP. When they become audible again and win
   a slot (with a hysteresis margin, so equal voices don't swap every frame), they restart at
   the right offset with a 30 ms fade-in. Real voices that become inaudible go virtual.

Outcomes are reported per request (`Voices::outcome(id)`): `playing`, `virtual`, `delayed`,
`loading`, `culled`, `voice_limit`, `cooldown`, `max_instances`, `unknown_cue`, `no_clips`.

## Mixer: buses, snapshots, ducking (`Mixer`)

- **Buses:** `master → music, sfx, voice, ui, ambience` (fixed ids `BusId::MASTER…`). Games add
  more with `mixer.add_bus("radio", BusId::VOICE)` (32 max). Each bus has a user `volume`,
  `mute` and `solo`. Solo keeps the soloed bus, its ancestors and its descendants. Volumes are
  wired to settings: master/music/sfx/ambience/ui come from `CoreSettings` (through `Volumes`,
  so `--volume` still works) and voice from `SoundSettings::voice_volume`.
- **Snapshots** (`MixSnapshot`): per-bus `volume(db)`, `lowpass(hz)`, `reverb_send(0..1)`,
  optional `reverb(ReverbParams)`, with `fades(in, out)`. Several can be active at once and
  blend by weight: dB offsets add, cut-offs take the lowest (interpolated in log-frequency),
  and sends take the highest. Built-ins:
  - `paused`: music −8 dB with a 2.5 kHz low-pass; sfx −10 dB with a 900 Hz low-pass. It turns
    on automatically while `Paused` (see `SoundConfig::pause_snapshot`).
  - `underwater`: heavy low-pass plus a damped reverb.
  - `cave`: reverb sends plus a long room.
  - `mixer.set_snapshot(name, on)` / `clear_snapshots()`.
- **Ducking** (`DuckRule`): while the trigger bus (or a child bus) has a voice louder than
  `duck_trigger_db`, the target buses drop by their depth, with attack/hold/release. Default:
  voice ducks music −9 dB, sfx −4 dB and ambience −6 dB (attack 0.12 s, hold 0.25 s,
  release 0.7 s).

The renderer applies each bus's gain (ramped per block), a 12 dB/oct biquad low-pass (only
when below 19 kHz) and a post-fader reverb send. Children are summed into parents. A
Freeverb-lite reverb (4 combs + 2 all-passes per side) returns into master, followed by a soft
clip.

## 3D, occlusion, zones

- Listener: the first `SoundListener`, else Bevy's `SpatialListener`, else `MainCamera`.
- Per voice:
  - rolloff curve;
  - equal-power pan (centre = unity, pan narrows inside `min_distance`);
  - rear darkening (sources behind are low-passed to `spatial.rear_lowpass_hz`);
  - doppler from smoothed velocities (clamped 0.5..2);
  - stereo clips are folded toward mono by `spatial_blend`.
- **Occlusion** (feature `physics`): `occlusion_rays_per_frame` (8) avian raycasts per frame,
  round-robin over 3D voices. The ray ignores the source's own entity, the listener and anything
  marked `SoundOcclusionIgnore` (or their children). An occluded voice eases towards
  `occlusion_db` (−9 dB) and `occlusion_lowpass_hz` (1.2 kHz).
- **Zones** (`SoundZone`): a sphere or rotated box with a soft `fade` margin. Its weight drives
  a snapshot (for example `"cave"` reverb) and crossfades a looping 2D ambience cue. Overlapping
  zones take the max weight per snapshot.

## Music (`Music`)

```rust
music.add_track(MusicTrack::new("explore", 96.0).intro(intro)
    .stem(MusicStem::always(pad)).stem(MusicStem::at(drums, 0.4)).stem(MusicStem::at(lead, 0.75)));
music.play("explore", MusicTransition::default());   // next bar, 1.5 s crossfade
music.set_intensity(0.8);                           // stems fade in by threshold
```

- Stems are started on the **sample clock** at the same frame, so they stay locked together. If
  a start arrives late, it skips ahead to stay on the grid. An optional intro plays first and
  the stems start exactly at its end.
- Transitions are quantized with `Quantize::Immediate | Beat | Bar` against the playing track's
  grid. The old track fades out from the boundary and the new one starts on it.
- `Music::position(clock, rate)` returns bar/beat/phase. A `MusicBeat` message fires on every
  beat for gameplay sync.

## Captions

- A cue's captions are pushed when the voice really starts (culled sounds show none).
- `Captions` keeps up to 3 lines. The same text is refreshed instead of repeated, and lines
  expire after `secs` (0 = clip length + 0.75 s, clamped to 1.5..8 s).
- For 3D sources, a line follows the voice's pan and shows `‹` or `›`.
- The panel (bottom centre, engine UI kit theme, `SPEAKER:` in the accent colour, sound effects
  in `[brackets]`) shows when `SoundSettings::captions` is on. Its size is set by
  `caption_size` (Small/Medium/Large).
- The queue runs headless as well, so tests and `sound.captions` can read it.

## Settings

`SoundSettings` adds four rows to the settings screen's "Audio" tab: `voice_volume`
("Dialogue"), `captions` ("Subtitles"), `caption_size` and `caption_directions`. They are saved
to `<data>/sound.json`, debounced like `settings.json` and also written on exit.

## Old `engine::audio` API

`audio::play` / `audio::play_loop` keep their signatures. With `sound` on, they become voices on
the matching bus (`AudioCategory` → sfx/music/ambience/ui), so they also get snapshots, ducking
and limits. The `AudioSource` path is loaded again as a `SoundClip`, which is cached. Despawning
a loop's entity stops it, and changing its `SinkGain` changes its volume. Without the feature,
the original Bevy-sink path is compiled in.

## Config (`SoundConfig`, built with `..default()`)

`max_voices` 48, `cull_db` −60, `sample_rate` 48 kHz, `load_timeout` 5 s,
`spatial: SpatialCfg { rear_lowpass_hz 9 kHz, speed_of_sound 343, doppler_scale 1 }`,
`occlusion_rays_per_frame` 8, `occlusion_db` −9, `occlusion_lowpass_hz` 1200,
`occlusion_speed` 6/s, `duck_trigger_db` −40, `pause_snapshot` `Some("paused")`,
`offline` false, `capture_secs` 0, `device_volume` 1.

Backends (`SoundBackend::kind()`):

| Kind | When | What runs |
|---|---|---|
| `device` | windowed and not muted | the renderer runs on the audio thread |
| `offline` | `SoundConfig { offline: true, .. }` | the renderer runs on the main thread, `dt` of audio per frame; `capture()` keeps `capture_secs` of output |
| `none` | headless, `--mute`, or test-driven runs without `--sound` | logic only, on a virtual clock |

If the device stops pulling samples for 1 s, the backend falls back to `none`. Dev flag
`--mute-output` runs the full DSP against the device at zero output gain, so cost can be
measured without making noise.

## Control commands (feature `devtools`)

| Command | Params | Result |
|---|---|---|
| `sound.play` | `{cue, pos?: [x,y,z], volume?, pitch?}` | `{voice, outcome}` (resolved immediately) |
| `sound.stop` | `{voice?, cue?, fade?}` (neither: all) | `{}` |
| `sound.stats` | — | counters (`active`, `virtual_voices`, `pending`, `culled`, `stolen`, `voice_limited`, `revived`, `rejected_*`, `dsp_load`, `renderer_voices`, `backend`, `clock_secs`), `voices` (first 32), `buses` (with `effective_db`, `snapshot_db`, `duck_db`, `lowpass_hz`, `peak_db`), `snapshots`, `ducks`, `listener`, `music` |
| `sound.bus` | `{name?, volume?, mute?, solo?}` | `{buses}`; volume on a core bus goes through settings, so it persists |
| `sound.snapshot` | `{name?, on?}` (`"none"` clears) | `{active, available}` |
| `sound.captions` | `{enabled?, size?, directions?}` | `{enabled, size, directions, lines: [{speaker, text, shown, remaining, side}]}` |
| `sound.music` | `{track?, intensity?, quantize?, fade?, stop?}` | `{track, pending, position, intensity, tracks}` |
| `sound.cues` | — | `{cues: [...]}` |

To check a mix by script: `python3 -I scripts/play.py steps.json --example sound_demo --sound
--id engine-sound-demo -- --sound --mute-output`. Without `-- --sound`, test-driven runs are
muted and the backend is `none`.

## Tests

- Unit tests (`cargo test --lib sound`, 23 tests) cover: WAV round trip and bad input, renderer
  output (one-shot ends, voice and bus low-pass, bus gain, sample-exact scheduled start, reverb
  tail, fade-out), bus math (hierarchy/mute/solo, snapshot blending, ducking envelope, idle
  no-op), shuffle/sequence/random selection, rolloff curves, pan law, rear filter, doppler,
  captions queue, zone weights, music boundaries and stem gains.
- `tests/sound.rs` (9 tests, headless `App::update()`, offline renderer):
  - cooldown, instance stealing and rejection;
  - priority stealing, culling, voice-limit drops, virtual/revive, walking out of range and back;
  - real rendered samples and per-bus meters;
  - ducking −9 dB and its release;
  - captions;
  - settings volume → virtual voice;
  - pause snapshot;
  - cave zone (reverb, ambience on/off);
  - music beats and a bar-quantized transition;
  - avian occlusion through a wall;
  - the legacy `audio::play` / `play_loop` bridge;
  - the demo, with first-frame bus routing and `sound.json` persistence;
  - every control command.
- `cargo test --test sound -- --ignored --nocapture bench` prints the numbers below.

## Measurements

Apple M5 Pro, dev profile (the engine crate builds at opt-level 1, dependencies at 3).

| What | Result |
|---|---|
| DSP: 48 3D voices (panned, about half rear-filtered), 6 buses, `underwater` bus low-passes + `cave` reverb | **97 ms per 10 s of audio = 0.97 % of one core** (3 runs: 0.967–0.976 %) |
| Device run, `sound_demo` (4 music stems + 2 3D loops + one-shots, paused snapshot on) | `dsp_load` 0.25 % of real time; the `audio` thread is at 0.39 % CPU in the perf monitor |
| Logic: 48 real + 2000 virtual voices, 8 occlusion rays/frame | +0.03–0.10 ms/frame over the same app idle (at the noise floor). Before the lazy score floor in `Voices::update`, this was **3.7 ms/frame** (O(n²) admission checks) |
| Idle (no voices, no music) | the systems return early; the mixer recomputes only on change |
| Live ducking on device (`sound.bus` peaks) | music peak −23 → −31 dB while the guard speaks, back after release |
| Memory | renderer preallocates 32 bus buffers (64 KB), reverb lines (~52 KB) and command and voice vectors; no allocation per block in steady state |

## Known limits

- Ducking keys on voice activity (a voice above `duck_trigger_db` as heard), not on the
  measured RMS of the trigger bus. Bus peak meters exist but don't feed back into the ducking.
- One global reverb: snapshots change its character (the most-weighted wins, blended from the
  default), and buses only differ in send level. There are no per-zone convolution reverbs.
- No HRTF. Spatialisation is equal-power stereo pan plus rear low-pass, and output is stereo
  only (no 5.1/7.1).
- Resampling is linear interpolation (fine for SFX and pitch jitter, softer highs at extreme
  pitch). rodio resamples the 48 kHz mix if the device runs at another rate.
- Occlusion is binary per ray (hit or no hit) and smoothed over time. There is no material
  transmission or diffraction path.
- Captions show the sound's direction only left/right, not front/behind. There is no
  per-speaker colour table.
- Music: quantization uses the playing track's grid; there are no transition segments or
  stingers yet.
- The legacy bridge re-decodes `AudioSource` files that are only reachable by bytes (no path)
  on the main thread, once.
- Ogg decoding relies on Bevy's `vorbis` feature (on by default). MP3/FLAC are not loaded as
  `SoundClip`.
