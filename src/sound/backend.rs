//! The thin layer between the logic (voices, music, mixer) and the DSP [`Renderer`]:
//! - `Device`: the renderer lives in a [`MixStream`] played by Bevy's audio output.
//! - `Offline`: the renderer runs on the main thread, `dt` worth of audio per frame (tests,
//!   `--offscreen` captures that want meters); optionally keeps a capture buffer.
//! - `None`: muted / headless — logic only, on a virtual clock. Commands are dropped.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use bevy::prelude::*;

use super::dsp::{BLOCK, Cmd, MixStream, Renderer, Shared};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BackendKind {
    /// Muted / headless: logic runs, nothing is rendered.
    #[default]
    None,
    Device,
    Offline,
}

impl BackendKind {
    pub fn as_str(self) -> &'static str {
        match self {
            BackendKind::None => "none",
            BackendKind::Device => "device",
            BackendKind::Offline => "offline",
        }
    }
}

#[derive(Resource)]
pub struct SoundBackend {
    pub(crate) shared: Arc<Shared>,
    pub(crate) out: Vec<Cmd>,
    kind: BackendKind,
    rate: u32,
    clock: u64,
    frac: f64,
    offline: Option<Renderer>,
    capture: Vec<f32>,
    capture_cap: usize,
    /// Voice ids the renderer finished since last frame (drained by voices + music).
    pub(crate) finished: Vec<u32>,
    pub(crate) sent_topology: u32,
    stall: f32,
    last_ns: u64,
    last_frames: u64,
    /// Fraction of real time spent rendering (0..1), averaged over ~0.5 s.
    pub(crate) dsp_load: f32,
}

impl SoundBackend {
    pub(crate) fn new(rate: u32) -> Self {
        SoundBackend {
            shared: Arc::new(Shared::default()),
            out: Vec::with_capacity(256),
            kind: BackendKind::None,
            rate,
            clock: 0,
            frac: 0.0,
            offline: None,
            capture: Vec::new(),
            capture_cap: 0,
            finished: Vec::with_capacity(64),
            sent_topology: 0,
            stall: 0.0,
            last_ns: 0,
            last_frames: 0,
            dsp_load: 0.0,
        }
    }

    pub fn kind(&self) -> BackendKind {
        self.kind
    }

    pub fn rate(&self) -> u32 {
        self.rate
    }

    /// Output frames rendered (or virtually elapsed) so far.
    pub fn clock(&self) -> u64 {
        self.clock
    }

    pub fn clock_secs(&self) -> f64 {
        self.clock as f64 / self.rate as f64
    }

    /// Whether commands reach a renderer.
    pub fn active(&self) -> bool {
        self.kind != BackendKind::None
    }

    #[inline]
    pub(crate) fn push(&mut self, c: Cmd) {
        if self.kind != BackendKind::None {
            self.out.push(c);
        }
    }

    /// Interleaved stereo captured in offline mode (oldest first), up to the configured length.
    pub fn capture(&self) -> &[f32] {
        &self.capture
    }

    pub fn clear_capture(&mut self) {
        self.capture.clear();
    }

    /// Peak level of bus `i` since the last read (linear).
    pub fn take_peak(&self, i: usize) -> f32 {
        self.shared.take_peak(i)
    }

    pub(crate) fn start_offline(&mut self, voice_capacity: usize, capture_secs: f32) {
        self.offline = Some(Renderer::new(self.shared.clone(), self.rate, voice_capacity));
        self.capture_cap = (capture_secs.max(0.0) * self.rate as f32) as usize * 2;
        self.capture = Vec::with_capacity(self.capture_cap.min(1 << 22));
        self.kind = BackendKind::Offline;
    }

    pub(crate) fn device_stream(&mut self, voice_capacity: usize) -> MixStream {
        self.kind = BackendKind::Device;
        MixStream::new(Renderer::new(self.shared.clone(), self.rate, voice_capacity))
    }

    /// Render `frames` now (offline only; rounded up to whole blocks).
    pub fn render_offline(&mut self, frames: usize) {
        self.flush();
        let Some(r) = self.offline.as_mut() else { return };
        for _ in 0..frames.div_ceil(BLOCK) {
            let block = r.render_block();
            if self.capture_cap > 0 {
                let room = self.capture_cap.saturating_sub(self.capture.len());
                self.capture.extend_from_slice(&block[..room.min(block.len())]);
            }
        }
        self.clock = r.clock();
    }

    pub(crate) fn flush(&mut self) {
        if self.out.is_empty() {
            return;
        }
        if self.kind == BackendKind::None {
            self.out.clear();
            return;
        }
        if let Ok(mut inbox) = self.shared.inbox.lock() {
            inbox.append(&mut self.out);
        }
    }

    /// Once per frame, after all logic: send commands, advance the clock, collect finished ids.
    pub(crate) fn frame(&mut self, dt: f32) {
        self.flush();
        match self.kind {
            BackendKind::None => {
                self.frac += dt as f64 * self.rate as f64;
                let whole = self.frac.floor();
                self.frac -= whole;
                self.clock += whole as u64;
            }
            BackendKind::Offline => {
                self.frac += dt as f64 * self.rate as f64;
                let whole = (self.frac / BLOCK as f64).floor() as usize * BLOCK;
                self.frac -= whole as f64;
                self.render_offline(whole);
            }
            BackendKind::Device => {
                let c = self.shared.clock.load(Ordering::Relaxed);
                if c == self.clock && dt > 0.0 {
                    self.stall += dt;
                    if self.stall > 1.0 {
                        // Nobody pulls the stream (no output device): fall back to virtual time.
                        warn!("sound: audio device not consuming; running virtual");
                        self.kind = BackendKind::None;
                        self.out.clear();
                    }
                } else {
                    self.stall = 0.0;
                }
                self.clock = c;
            }
        }
        if let Ok(mut d) = self.shared.done.try_lock() {
            self.finished.clear();
            self.finished.append(&mut d);
        }
        let ns = self.shared.render_ns.load(Ordering::Relaxed);
        let frames = self.shared.rendered.load(Ordering::Relaxed);
        let df = frames.saturating_sub(self.last_frames);
        if df >= (self.rate / 2) as u64 {
            let audio_ns = df as f64 / self.rate as f64 * 1e9;
            self.dsp_load = (ns.saturating_sub(self.last_ns) as f64 / audio_ns) as f32;
            self.last_ns = ns;
            self.last_frames = frames;
        }
    }
}
