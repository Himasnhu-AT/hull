//! The mixer that runs on the audio thread: voices → bus tree (gain, low-pass, reverb send) →
//! master (soft clip). One rodio source ([`MixStream`]) feeds Bevy's output, so every effect
//! here is ours and identical on every platform; offline rendering (tests, `sound.render`)
//! runs the same code on the main thread.
//!
//! Main thread → audio thread: a `Vec<Cmd>` swapped under a mutex once per block (no
//! allocation in steady state). Audio thread → main: a clock (frames), finished voice ids,
//! per-bus peak meters, DSP time.
//!
//! Cost model: a voice costs one interpolated read + gain per frame (plus 2 one-poles when its
//! low-pass is below 19 kHz); a bus costs a buffer pass only if a voice wrote to it, plus a
//! biquad when filtered; the reverb runs only while something sends to it (and its tail).

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use bevy::asset::Asset;
use bevy::audio::{ChannelCount, Decodable, SampleRate, Source};
use bevy::reflect::TypePath;

use super::clip::ClipPcm;

/// Frames per render block (5.3 ms at 48 kHz): command latency and parameter-ramp length.
pub const BLOCK: usize = 256;
/// Bus slots preallocated by the renderer.
pub const MAX_BUSES: usize = 32;
/// Cut-offs at or above this are "no filter" (and cost nothing).
pub const LP_OFF: f32 = 19_000.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VoiceParams {
    /// Voice-level gain (cue volume × attenuation × occlusion); buses apply theirs.
    pub gain: f32,
    /// Left/right gains (1, 1 = centre).
    pub pan: [f32; 2],
    /// Source frames advanced per output frame (pitch × doppler × clip rate / output rate).
    pub rate: f32,
    /// Low-pass cut-off in Hz (≥ [`LP_OFF`]: off).
    pub lowpass: f32,
    /// 0..1: fold a stereo clip to mono before panning (spatialised stereo).
    pub mono: f32,
}

impl Default for VoiceParams {
    fn default() -> Self {
        VoiceParams { gain: 1.0, pan: [1.0, 1.0], rate: 1.0, lowpass: 20_000.0, mono: 0.0 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReverbParams {
    /// 0..1 → decay (comb feedback 0.7..0.98).
    pub room: f32,
    /// 0..1 high-frequency damping of the tail.
    pub damping: f32,
    /// Return level of the reverb into master.
    pub wet: f32,
}

impl Default for ReverbParams {
    fn default() -> Self {
        ReverbParams { room: 0.6, damping: 0.4, wet: 0.6 }
    }
}

#[derive(Debug)]
pub enum Cmd {
    Start {
        id: u32,
        clip: Arc<ClipPcm>,
        bus: u16,
        /// Absolute output frame to start at (0 or past = now; late starts skip ahead so
        /// scheduled music stays on the grid).
        at: u64,
        looping: bool,
        params: VoiceParams,
        /// Start position in source frames.
        offset: f64,
        fade_in: u32,
    },
    Params(u32, VoiceParams),
    /// Ramp to `target` over `frames`, starting at output frame `at`; `stop` frees the voice
    /// when the ramp ends.
    Fade { id: u32, at: u64, target: f32, frames: u32, stop: bool },
    /// Stop with a 64-frame de-click.
    Stop(u32),
    StopAll,
    /// Parent of each bus (index = bus id; `u16::MAX` = master's).
    Topology(Vec<u16>),
    Bus { idx: u16, gain: f32, lowpass: f32, reverb: f32 },
    Reverb(ReverbParams),
}

/// State both sides see.
#[derive(Debug)]
pub struct Shared {
    pub(crate) inbox: Mutex<Vec<Cmd>>,
    pub(crate) done: Mutex<Vec<u32>>,
    pub(crate) clock: AtomicU64,
    pub(crate) render_ns: AtomicU64,
    pub(crate) rendered: AtomicU64,
    pub(crate) live_voices: AtomicU32,
    pub(crate) meters: [AtomicU32; MAX_BUSES],
}

impl Default for Shared {
    fn default() -> Self {
        Shared {
            inbox: Mutex::new(Vec::with_capacity(256)),
            done: Mutex::new(Vec::with_capacity(256)),
            clock: AtomicU64::new(0),
            render_ns: AtomicU64::new(0),
            rendered: AtomicU64::new(0),
            live_voices: AtomicU32::new(0),
            meters: std::array::from_fn(|_| AtomicU32::new(0)),
        }
    }
}

impl Shared {
    /// Peak of bus `i` since the last call (linear), then reset.
    pub fn take_peak(&self, i: usize) -> f32 {
        self.meters.get(i).map_or(0.0, |m| f32::from_bits(m.swap(0, Ordering::Relaxed)))
    }
}

#[derive(Debug)]
struct PendingFade {
    at: u64,
    target: f32,
    frames: u32,
    stop: bool,
}

#[derive(Debug)]
struct RVoice {
    id: u32,
    clip: Arc<ClipPcm>,
    bus: u16,
    at: u64,
    started: bool,
    looping: bool,
    pos: f64,
    cur: VoiceParams,
    target: VoiceParams,
    lp: [f32; 4],
    fade: f32,
    fade_step: f32,
    fade_target: f32,
    fade_stop: bool,
    pending: Option<PendingFade>,
}

#[derive(Clone, Copy, Debug, Default)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z: [[f32; 2]; 2],
}

impl Biquad {
    fn set_lowpass(&mut self, fc: f32, sr: f32) {
        let w = std::f32::consts::TAU * (fc / sr).min(0.49);
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
        let a0 = 1.0 + alpha;
        self.b0 = (1.0 - c) / 2.0 / a0;
        self.b1 = (1.0 - c) / a0;
        self.b2 = self.b0;
        self.a1 = -2.0 * c / a0;
        self.a2 = (1.0 - alpha) / a0;
    }
    #[inline]
    fn run(&mut self, ch: usize, x: f32) -> f32 {
        let z = &mut self.z[ch];
        let y = self.b0 * x + z[0];
        z[0] = self.b1 * x - self.a1 * y + z[1];
        z[1] = self.b2 * x - self.a2 * y;
        y
    }
}

#[derive(Debug)]
struct RBus {
    parent: u16,
    gain: f32,
    gain_target: f32,
    lp_hz: f32,
    lp_set: f32,
    filt: Biquad,
    reverb: f32,
    buf: Box<[f32]>,
    /// Something wrote to `buf` this block.
    used: bool,
    /// Filter state still ringing.
    filt_live: bool,
}

#[derive(Debug)]
struct Comb {
    buf: Box<[f32]>,
    idx: usize,
    filt: f32,
}

impl Comb {
    fn new(len: usize) -> Self {
        Comb { buf: vec![0.0; len.max(1)].into_boxed_slice(), idx: 0, filt: 0.0 }
    }
    #[inline]
    fn run(&mut self, x: f32, feedback: f32, damp: f32) -> f32 {
        let y = self.buf[self.idx];
        self.filt = y * (1.0 - damp) + self.filt * damp;
        self.buf[self.idx] = x + self.filt * feedback;
        self.idx += 1;
        if self.idx == self.buf.len() {
            self.idx = 0;
        }
        y
    }
}

#[derive(Debug)]
struct Allpass {
    buf: Box<[f32]>,
    idx: usize,
}

impl Allpass {
    fn new(len: usize) -> Self {
        Allpass { buf: vec![0.0; len.max(1)].into_boxed_slice(), idx: 0 }
    }
    #[inline]
    fn run(&mut self, x: f32) -> f32 {
        let b = self.buf[self.idx];
        self.buf[self.idx] = x + b * 0.5;
        self.idx += 1;
        if self.idx == self.buf.len() {
            self.idx = 0;
        }
        b - x
    }
}

/// Freeverb-lite: 4 damped combs + 2 all-passes per side.
#[derive(Debug)]
struct Reverb {
    combs: [[Comb; 4]; 2],
    aps: [[Allpass; 2]; 2],
    params: ReverbParams,
    /// Blocks since the last non-zero input (the tail is skipped after ~3 s of silence).
    quiet: u32,
}

impl Reverb {
    fn new(rate: u32) -> Self {
        let k = rate as f32 / 44_100.0;
        let l = |n: f32| (n * k) as usize;
        let side = |s: f32| [Comb::new(l(1116.0 + s)), Comb::new(l(1188.0 + s)), Comb::new(l(1277.0 + s)), Comb::new(l(1356.0 + s))];
        let ap = |s: f32| [Allpass::new(l(556.0 + s)), Allpass::new(l(441.0 + s))];
        Reverb { combs: [side(0.0), side(23.0)], aps: [ap(0.0), ap(23.0)], params: ReverbParams::default(), quiet: u32::MAX }
    }
}

/// The audio-thread mixer. Build with [`Renderer::new`], drive with [`Renderer::render_block`].
#[derive(Debug)]
pub struct Renderer {
    shared: Arc<Shared>,
    rate: u32,
    clock: u64,
    cmds: Vec<Cmd>,
    done: Vec<u32>,
    voices: Vec<RVoice>,
    buses: Vec<RBus>,
    bus_count: usize,
    reverb: Reverb,
    reverb_in: Box<[f32]>,
    out: Box<[f32]>,
}

impl Renderer {
    pub fn new(shared: Arc<Shared>, rate: u32, voice_capacity: usize) -> Self {
        let buses = (0..MAX_BUSES)
            .map(|_| RBus {
                parent: u16::MAX,
                gain: 1.0,
                gain_target: 1.0,
                lp_hz: 20_000.0,
                lp_set: 0.0,
                filt: Biquad::default(),
                reverb: 0.0,
                buf: vec![0.0; BLOCK * 2].into_boxed_slice(),
                used: false,
                filt_live: false,
            })
            .collect();
        Renderer {
            shared,
            rate,
            clock: 0,
            cmds: Vec::with_capacity(256),
            done: Vec::with_capacity(256),
            voices: Vec::with_capacity(voice_capacity),
            buses,
            bus_count: 1,
            reverb: Reverb::new(rate),
            reverb_in: vec![0.0; BLOCK].into_boxed_slice(),
            out: vec![0.0; BLOCK * 2].into_boxed_slice(),
        }
    }

    pub fn rate(&self) -> u32 {
        self.rate
    }

    pub fn clock(&self) -> u64 {
        self.clock
    }

    pub fn voice_count(&self) -> usize {
        self.voices.len()
    }

    fn apply(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Start { id, clip, bus, at, looping, params, offset, fade_in } => {
                let frames = clip.frames() as f64;
                if frames < 1.0 {
                    self.done.push(id);
                    return;
                }
                let pos = if looping { offset.rem_euclid(frames) } else { offset };
                if pos >= frames {
                    self.done.push(id);
                    return;
                }
                let (fade, fade_step) = if fade_in > 0 { (0.0, 1.0 / fade_in as f32) } else { (1.0, 0.0) };
                self.voices.push(RVoice {
                    id,
                    clip,
                    bus,
                    at,
                    started: false,
                    looping,
                    pos,
                    cur: params,
                    target: params,
                    lp: [0.0; 4],
                    fade,
                    fade_step,
                    fade_target: 1.0,
                    fade_stop: false,
                    pending: None,
                });
            }
            Cmd::Params(id, p) => {
                if let Some(v) = self.voices.iter_mut().find(|v| v.id == id) {
                    v.target = p;
                }
            }
            Cmd::Fade { id, at, target, frames, stop } => {
                if let Some(v) = self.voices.iter_mut().find(|v| v.id == id) {
                    v.pending = Some(PendingFade { at, target, frames, stop });
                }
            }
            Cmd::Stop(id) => {
                if let Some(v) = self.voices.iter_mut().find(|v| v.id == id) {
                    if !v.started {
                        v.fade = 0.0;
                    }
                    v.pending = Some(PendingFade { at: 0, target: 0.0, frames: 64, stop: true });
                }
            }
            Cmd::StopAll => {
                for v in &mut self.voices {
                    v.pending = Some(PendingFade { at: 0, target: 0.0, frames: 64, stop: true });
                }
            }
            Cmd::Topology(parents) => {
                self.bus_count = parents.len().clamp(1, MAX_BUSES);
                for (i, p) in parents.iter().take(MAX_BUSES).enumerate() {
                    // Parents always have lower ids (the mixer adds buses under existing ones).
                    self.buses[i].parent = if i == 0 {
                        u16::MAX
                    } else if (*p as usize) < i {
                        *p
                    } else {
                        0
                    };
                }
            }
            Cmd::Bus { idx, gain, lowpass, reverb } => {
                if let Some(b) = self.buses.get_mut(idx as usize) {
                    b.gain_target = gain;
                    b.lp_hz = lowpass;
                    b.reverb = reverb;
                }
            }
            Cmd::Reverb(p) => self.reverb.params = p,
        }
    }

    /// Render one block of [`BLOCK`] stereo frames (interleaved L R).
    pub fn render_block(&mut self) -> &[f32] {
        let t0 = Instant::now();
        if let Ok(mut inbox) = self.shared.inbox.try_lock()
            && !inbox.is_empty()
        {
            std::mem::swap(&mut *inbox, &mut self.cmds);
        }
        let mut cmds = std::mem::take(&mut self.cmds);
        for c in cmds.drain(..) {
            self.apply(c);
        }
        self.cmds = cmds;

        let sr = self.rate as f32;
        let clock = self.clock;
        for b in &mut self.buses[..self.bus_count] {
            if b.used {
                b.buf.fill(0.0);
                b.used = false;
            }
        }

        // Voices.
        let mut i = 0;
        while i < self.voices.len() {
            let v = &mut self.voices[i];
            // Resolved here, not at start: a topology may arrive in the same batch.
            let bus = &mut self.buses[(v.bus as usize).min(self.bus_count - 1)];
            let state = render_voice(v, &mut bus.buf, clock, sr);
            if state != VoiceRun::Waiting {
                bus.used = true;
            }
            if state == VoiceRun::Finished {
                let v = self.voices.swap_remove(i);
                self.done.push(v.id);
            } else {
                i += 1;
            }
        }

        // Buses, children before parents (parents have lower ids).
        let mut send_any = false;
        self.reverb_in.fill(0.0);
        for idx in (0..self.bus_count).rev() {
            let (lo, hi) = self.buses.split_at_mut(idx);
            let b = &mut hi[0];
            let ramping = (b.gain - b.gain_target).abs() > 1e-6;
            let filtered = b.lp_hz < LP_OFF;
            if !b.used && !(filtered && b.filt_live) {
                b.gain = b.gain_target;
                continue;
            }
            if filtered && (b.lp_set - b.lp_hz).abs() > 0.5 {
                b.filt.set_lowpass(b.lp_hz, sr);
                b.lp_set = b.lp_hz;
            }
            let (g0, g1) = (b.gain, b.gain_target);
            let dg = if ramping { (g1 - g0) / BLOCK as f32 } else { 0.0 };
            let mut g = g0;
            let mut peak = 0.0f32;
            let send = b.reverb;
            for f in 0..BLOCK {
                let (mut l, mut r) = (b.buf[2 * f], b.buf[2 * f + 1]);
                if filtered {
                    l = b.filt.run(0, l);
                    r = b.filt.run(1, r);
                }
                l *= g;
                r *= g;
                g += dg;
                b.buf[2 * f] = l;
                b.buf[2 * f + 1] = r;
                peak = peak.max(l.abs()).max(r.abs());
                if send > 0.0 {
                    self.reverb_in[f] += (l + r) * 0.5 * send;
                }
            }
            b.gain = g1;
            b.filt_live = filtered && peak > 1e-5;
            if !filtered {
                b.filt.z = [[0.0; 2]; 2];
            }
            send_any |= send > 0.0 && peak > 0.0;
            self.shared.meters[idx].fetch_max(peak.to_bits(), Ordering::Relaxed);
            if idx > 0 {
                let parent = &mut lo[(b.parent as usize).min(idx - 1)];
                for (d, s) in parent.buf.iter_mut().zip(b.buf.iter()) {
                    *d += *s;
                }
                parent.used = true;
            }
        }

        // Reverb return + master soft clip.
        let master = &self.buses[0];
        if send_any {
            self.reverb.quiet = 0;
        } else {
            self.reverb.quiet = self.reverb.quiet.saturating_add(1);
        }
        let tail_blocks = (3.0 * sr / BLOCK as f32) as u32;
        let run_reverb = self.reverb.quiet < tail_blocks;
        let rv = &mut self.reverb;
        let fb = 0.7 + 0.28 * rv.params.room.clamp(0.0, 1.0);
        let damp = rv.params.damping.clamp(0.0, 1.0) * 0.4;
        let wet = rv.params.wet * 0.25;
        for f in 0..BLOCK {
            let (mut l, mut r) = if master.used { (master.buf[2 * f], master.buf[2 * f + 1]) } else { (0.0, 0.0) };
            if run_reverb {
                let x = self.reverb_in[f] * 0.5;
                for (side, out) in [&mut l, &mut r].into_iter().enumerate() {
                    let mut acc = 0.0;
                    for c in &mut rv.combs[side] {
                        acc += c.run(x, fb, damp);
                    }
                    for a in &mut rv.aps[side] {
                        acc = a.run(acc);
                    }
                    *out += acc * wet;
                }
            }
            self.out[2 * f] = soft_clip(l);
            self.out[2 * f + 1] = soft_clip(r);
        }

        self.clock += BLOCK as u64;
        let sh = &self.shared;
        sh.clock.store(self.clock, Ordering::Relaxed);
        sh.live_voices.store(self.voices.len() as u32, Ordering::Relaxed);
        if !self.done.is_empty()
            && let Ok(mut d) = sh.done.try_lock()
        {
            d.append(&mut self.done);
        }
        sh.render_ns.fetch_add(t0.elapsed().as_nanos() as u64, Ordering::Relaxed);
        sh.rendered.fetch_add(BLOCK as u64, Ordering::Relaxed);
        &self.out
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VoiceRun {
    Waiting,
    Playing,
    Finished,
}

#[inline]
fn soft_clip(x: f32) -> f32 {
    // Transparent below 0.75, smooth knee to ±1.
    let a = x.abs();
    if a <= 0.75 {
        x
    } else {
        let t = ((a - 0.75) / 0.75).min(1.0);
        x.signum() * (0.75 + 0.25 * (t * (2.0 - t)))
    }
}

fn render_voice(v: &mut RVoice, out: &mut [f32], clock: u64, sr: f32) -> VoiceRun {
    let end = clock + BLOCK as u64;
    if v.at >= end {
        return VoiceRun::Waiting;
    }
    let mut off = 0usize;
    let frames = v.clip.frames();
    let len = frames as f64;
    if !v.started {
        if v.at > clock {
            off = (v.at - clock) as usize;
        } else if v.at > 0 && v.at < clock {
            // Late: skip ahead so scheduled (music) voices stay on the grid.
            v.pos += (clock - v.at) as f64 * v.target.rate as f64;
            if v.looping {
                v.pos = v.pos.rem_euclid(len);
            } else if v.pos >= len {
                return VoiceRun::Finished;
            }
        }
        v.started = true;
        v.cur = v.target;
    }
    if let Some(p) = &v.pending
        && p.at < end
    {
        v.fade_target = p.target;
        v.fade_step = (p.target - v.fade) / p.frames.max(1) as f32;
        v.fade_stop = p.stop;
        v.pending = None;
        if v.fade_step == 0.0 && v.fade_stop {
            return VoiceRun::Finished;
        }
    }
    let (c, t) = (v.cur, v.target);
    if (c.gain == 0.0 && t.gain == 0.0) || (v.fade == 0.0 && v.fade_step == 0.0) {
        // Silent (e.g. a music stem at zero intensity): keep its clock, skip the mixing.
        v.pos += (BLOCK - off) as f64 * t.rate.max(0.0) as f64;
        if v.pos >= len {
            if v.looping {
                v.pos = v.pos.rem_euclid(len);
            } else {
                return VoiceRun::Finished;
            }
        }
        return VoiceRun::Waiting;
    }
    let n = (BLOCK - off) as f32;
    let dg = (t.gain - c.gain) / n;
    let dl = (t.pan[0] - c.pan[0]) / n;
    let dr = (t.pan[1] - c.pan[1]) / n;
    let rate = t.rate.max(0.0) as f64;
    let lp = if t.lowpass < LP_OFF { Some(1.0 - (-std::f32::consts::TAU * t.lowpass / sr).exp()) } else { None };
    let mono = t.mono.clamp(0.0, 1.0);
    let data = &v.clip.samples;
    let stereo = v.clip.channels == 2;
    let (mut g, mut pl, mut pr) = (c.gain, c.pan[0], c.pan[1]);
    let mut finished = false;
    for f in off..BLOCK {
        let i0 = v.pos as usize;
        let frac = (v.pos - i0 as f64) as f32;
        let i1 = if i0 + 1 < frames {
            i0 + 1
        } else if v.looping {
            0
        } else {
            i0
        };
        let (mut sl, mut sr_) = if stereo {
            let l = data[2 * i0] + (data[2 * i1] - data[2 * i0]) * frac;
            let r = data[2 * i0 + 1] + (data[2 * i1 + 1] - data[2 * i0 + 1]) * frac;
            if mono > 0.0 {
                let m = (l + r) * 0.5;
                (l + (m - l) * mono, r + (m - r) * mono)
            } else {
                (l, r)
            }
        } else {
            let s = data[i0] + (data[i1] - data[i0]) * frac;
            (s, s)
        };
        if let Some(a) = lp {
            v.lp[0] += a * (sl - v.lp[0]);
            v.lp[1] += a * (v.lp[0] - v.lp[1]);
            v.lp[2] += a * (sr_ - v.lp[2]);
            v.lp[3] += a * (v.lp[2] - v.lp[3]);
            sl = v.lp[1];
            sr_ = v.lp[3];
        }
        if v.fade_step != 0.0 {
            v.fade += v.fade_step;
            if (v.fade_step > 0.0 && v.fade >= v.fade_target) || (v.fade_step < 0.0 && v.fade <= v.fade_target) {
                v.fade = v.fade_target;
                v.fade_step = 0.0;
                if v.fade_stop {
                    finished = true;
                }
            }
        }
        let amp = g * v.fade;
        out[2 * f] += sl * amp * pl;
        out[2 * f + 1] += sr_ * amp * pr;
        g += dg;
        pl += dl;
        pr += dr;
        v.pos += rate;
        if v.pos >= len {
            if v.looping {
                v.pos -= len;
            } else {
                finished = true;
            }
        }
        if finished {
            break;
        }
    }
    if lp.is_none() {
        v.lp = [0.0; 4];
    }
    v.cur = t;
    if finished { VoiceRun::Finished } else { VoiceRun::Playing }
}

/// The single rodio source the engine hands to Bevy's audio output. Holds the [`Renderer`]
/// until Bevy asks for its decoder (once).
#[derive(Asset, TypePath)]
pub struct MixStream {
    renderer: Mutex<Option<Renderer>>,
    rate: u32,
}

impl MixStream {
    pub fn new(renderer: Renderer) -> Self {
        let rate = renderer.rate();
        MixStream { renderer: Mutex::new(Some(renderer)), rate }
    }
}

/// Iterator side of [`MixStream`] (runs on the audio thread).
pub struct MixSource {
    renderer: Option<Renderer>,
    rate: u32,
    buf: [f32; BLOCK * 2],
    idx: usize,
}

impl Iterator for MixSource {
    type Item = f32;
    #[inline]
    fn next(&mut self) -> Option<f32> {
        if self.idx >= BLOCK * 2 {
            match &mut self.renderer {
                Some(r) => self.buf.copy_from_slice(r.render_block()),
                None => self.buf.fill(0.0),
            }
            self.idx = 0;
        }
        let s = self.buf[self.idx];
        self.idx += 1;
        Some(s)
    }
}

impl Source for MixSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> ChannelCount {
        ChannelCount::new(2).unwrap()
    }
    fn sample_rate(&self) -> SampleRate {
        SampleRate::new(self.rate.max(1)).unwrap()
    }
    fn total_duration(&self) -> Option<std::time::Duration> {
        None
    }
}

impl Decodable for MixStream {
    type Decoder = MixSource;
    fn decoder(&self) -> MixSource {
        let renderer = self.renderer.lock().ok().and_then(|mut r| r.take());
        MixSource { renderer, rate: self.rate, buf: [0.0; BLOCK * 2], idx: BLOCK * 2 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sound::clip::synth;

    fn renderer() -> (Arc<Shared>, Renderer) {
        let sh = Arc::new(Shared::default());
        let mut r = Renderer::new(sh.clone(), 48_000, 64);
        r.apply(Cmd::Topology(vec![u16::MAX, 0, 0]));
        (sh, r)
    }

    fn energy(r: &mut Renderer, blocks: usize) -> f32 {
        let mut e = 0.0;
        for _ in 0..blocks {
            e += r.render_block().iter().map(|s| s * s).sum::<f32>();
        }
        e
    }

    fn start(id: u32, clip: &crate::sound::SoundClip, bus: u16, params: VoiceParams) -> Cmd {
        Cmd::Start { id, clip: clip.pcm().clone(), bus, at: 0, looping: true, params, offset: 0.0, fade_in: 0 }
    }

    #[test]
    fn plays_and_finishes_one_shot() {
        let (sh, mut r) = renderer();
        let clip = synth::tone(440.0, 0.05, 0.5);
        r.apply(Cmd::Start { id: 7, clip: clip.pcm().clone(), bus: 1, at: 0, looping: false, params: VoiceParams::default(), offset: 0.0, fade_in: 0 });
        assert!(energy(&mut r, 4) > 1.0);
        energy(&mut r, 8);
        assert_eq!(r.voice_count(), 0, "one-shot freed at its end");
        assert_eq!(*sh.done.lock().unwrap(), vec![7]);
        assert!(sh.take_peak(1) > 0.3);
    }

    #[test]
    fn lowpass_removes_highs_and_bus_gain_applies() {
        let (_, mut r) = renderer();
        let hi = synth::tone(9_000.0, 1.0, 0.5);
        r.apply(start(1, &hi, 1, VoiceParams::default()));
        let open = energy(&mut r, 20);
        r.apply(Cmd::Params(1, VoiceParams { lowpass: 500.0, ..VoiceParams::default() }));
        energy(&mut r, 2);
        let shut = energy(&mut r, 20);
        assert!(shut < open * 0.05, "voice low-pass: {shut} vs {open}");
        r.apply(Cmd::Params(1, VoiceParams::default()));
        r.apply(Cmd::Bus { idx: 1, gain: 1.0, lowpass: 500.0, reverb: 0.0 });
        energy(&mut r, 2);
        let bus = energy(&mut r, 20);
        assert!(bus < open * 0.05, "bus low-pass: {bus} vs {open}");
        r.apply(Cmd::Bus { idx: 1, gain: 0.5, lowpass: 20_000.0, reverb: 0.0 });
        energy(&mut r, 2);
        let half = energy(&mut r, 20);
        assert!((half / open - 0.25).abs() < 0.05, "gain 0.5 → quarter energy: {}", half / open);
    }

    #[test]
    fn scheduled_start_is_sample_exact_and_reverb_has_tail() {
        let (_, mut r) = renderer();
        let clip = synth::drone(220.0, 1.0);
        r.apply(Cmd::Start { id: 1, clip: clip.pcm().clone(), bus: 1, at: 300, looping: true, params: VoiceParams::default(), offset: 0.0, fade_in: 0 });
        let first = r.render_block().to_vec();
        assert!(first.iter().all(|s| *s == 0.0), "nothing before frame 300");
        let second = r.render_block().to_vec();
        assert!(second[..2 * 44].iter().all(|s| *s == 0.0), "silent until frame 300 (= 44 into block 2)");
        assert!(second[2 * 45..].iter().any(|s| *s != 0.0));
        r.apply(Cmd::Bus { idx: 1, gain: 1.0, lowpass: 20_000.0, reverb: 1.0 });
        energy(&mut r, 10);
        r.apply(Cmd::Stop(1));
        energy(&mut r, 1);
        let tail = energy(&mut r, 10);
        assert!(tail > 1e-3, "reverb tail rings after the voice stops: {tail}");
    }

    #[test]
    fn fade_out_then_free() {
        let (_, mut r) = renderer();
        let clip = synth::drone(220.0, 1.0);
        r.apply(start(1, &clip, 1, VoiceParams::default()));
        energy(&mut r, 2);
        r.apply(Cmd::Fade { id: 1, at: 0, target: 0.0, frames: 1000, stop: true });
        energy(&mut r, 6);
        assert_eq!(r.voice_count(), 0);
    }
}
