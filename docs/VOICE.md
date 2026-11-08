# Voice chat (`engine::voice`, feature `voice`)

Push-to-talk / open-mic voice between the peers of a net session, in ~2 k lines (incl. tests).
Ported from a shipped rally game and made generic: no roles, no UI, no game assumptions.
`voice = ["net", "sound", "actions", "dep:cpal"]` (the same `cpal` Bevy's audio already builds);
not in `default`, and the plugin is opt-in: `app.add_plugins(VoicePlugin)`.

```text
mic (cpal thread) -> 16 kHz mono -> 20 ms frames -> gate (push-to-talk / open mic)
   -> IMA ADPCM (164 B) -> VoiceFrame, unreliable net message -> host hub
   -> jitter buffer per talker -> per-talker gain (proximity) -> mix
   -> rodio source on Bevy audio (device clock) -> speakers; sfx / ambience ducked
```

## Quick start

```rust
app.add_plugins(engine::voice::VoicePlugin);   // after the net/session setup; needs `sound` + `actions`
```

That is all: while at least one other peer is connected (a session host with a guest, or a
connected client) the microphone opens, frames go out on the net session's unreliable channel,
and what others say plays on the engine's **voice bus** (master x Dialogue volume, mute and solo
apply). Push-to-talk is the `voice.talk` action (V / left trigger, rebindable); the default
mode is open mic with a gate (threshold in dBFS, plus 10 dB over the noise floor, pre-roll of two
frames so syllables aren't cut). Settings (`VoiceSettings`, persisted as section `voice`) appear
on the Audio tab: enabled, volume, talk mode, open-mic threshold. The microphone is never
opened in headless, `--mute` or test-driven runs unless `--mic` is passed.

## Topology

Star: the host is the hub. The host's frames go to every guest (`broadcast_except(HOST)`); a
guest's go `to_server`, are played by the host and relayed to the other guests. The server
stamps frames with the sender's `ClientId` so nobody can speak as someone else. Talker 0 is the
host. ~170 B per 20 ms frame while talking, silence costs nothing (about 7 KB/s per talker).
With a relayed session (`Session` route `Relayed`) voice goes through the relay like everything
else.

## Extension points

- **Proximity / 3D.** `VoiceProximity { enabled, attenuation }` (the sound module's
  `Attenuation`: min/max distance, `Rolloff` curve) attenuates each remote talker by the distance
  between the sound listener (`SoundListener`, else a `Camera3d`) and the entity carrying
  `VoiceTalker(client_id)`. Off by default (full volume, e.g. a radio channel). Voices are
  mono-mixed: distance gain only, no panning (the playout is one 16 kHz mono stream).
- **Your own gains.** `VoiceTalkerGains(Vec<(talker, gain)>)` is what the playout reads each
  frame; with proximity off, write it yourself (radio vs. in-person, mute a player, ...). Talkers
  not listed play at 1; changes ramp over 20 ms.
- **State for HUDs.** `VoiceState`: `active`, `transmitting`, `mic_level_db`, `mic_status`,
  `remote_talking`, `talkers` (per talker: level, jitter, depth, loss stats).
- **Ducking.** While someone talks the `voice_chat` mix snapshot ducks `sfx` by `duck_db` (4 dB)
  and `ambience` 2 dB more (fades 0.12 s in / 0.7 s out).
- **Ordering.** `VoiceSet` (Update) if your systems must run before / after.

## Pieces (usable alone)

`adpcm` (IMA ADPCM encoder/decoder, 4:1, 20 ms frames), `dsp` (resampler to 16 kHz, level, open-mic
`Gate`, test signals), `jitter` (adaptive jitter buffer with loss concealment, per talker),
`capture` (cpal input on its own thread, device selection, `MicStatus` incl. "silent" detection for
the macOS permission), `playback` (`Player` mixer, `PlayoutEngine`, the rodio `VoiceStream`),
`net` (the one file that knows the net API).

## Control commands and test sources (feature `devtools`)

| Command | Params | Result |
|---|---|---|
| `voice.status` | - | `{enabled, active, talker, mode, mic: {status, device, level_db, test_source}, transmitting, frames_captured, sent, relayed, sent_bytes, received, malformed, remote_talking, talkers, device_playout}` |
| `voice.talk` | `{on}` | force push-to-talk (null: back to the key) |
| `voice.source` | `{source}` | `tone`, `tone:<hz>`, `talk` (speech-like babble), a WAV/OGG path, or null for the microphone |

`--voice-test tone|tone:<hz>|talk|<file>` does the same from the command line. Test sources work
headless: `tests/coop.rs` (feature `voice`) has a guest "talk" with a 440 Hz tone over a session and
checks the host plays it (RMS of the headless playout, `VoiceState::keep_output`), then moves
the talker's avatar beyond / inside the proximity range and checks silence / full volume.

## Known limits

- Mono, 16 kHz (telephone-grade, ~24 kbit/s); no echo cancellation or noise suppression (use
  push-to-talk or headphones); no voice activity beyond the gate.
- One voice bus; no per-peer volume UI (write `VoiceTalkerGains`), no spatial panning.
- The host is a single point of relay: a guest-to-guest frame crosses the host (migration
  re-establishes it, see NET.md).
- Capture needs the OS microphone permission (macOS: Privacy > Microphone); the engine reports
  `MicStatus::Silent` and logs a hint.
