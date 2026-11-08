//! Microphone capture with `cpal`: one thread owns the input stream (cpal streams are not
//! `Send` on every platform); the device callback downmixes and resamples to 16 kHz mono and
//! appends to a small ring the game drains every frame.
//!
//! Failure is never fatal: no input device, an unsupported format or a stream error set
//! [`MicStatus`] and log once; the game carries on without voice input.
//!
//! macOS: the first time the game opens the microphone, the system asks "“<app>” would like
//! to access the microphone" (for an unbundled binary started from a terminal, the prompt names
//! the terminal app, e.g. Terminal or iTerm). Until it is granted, or if it is denied, CoreAudio
//! delivers silence rather than an error: we detect a stream that has delivered only exact
//! zeros for 3 s and report [`MicStatus::Silent`] with a hint to check System Settings ›
//! Privacy & Security › Microphone. A packaged `.app` needs `NSMicrophoneUsageDescription` in
//! its Info.plist, or macOS denies access without asking.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;

use bevy::log::{info, warn};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};

use super::dsp::{Resampler, to_i16};

/// Samples kept if the game stops draining (0.5 s); older ones are dropped.
const RING_CAP: usize = 8_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[repr(u8)]
pub enum MicStatus {
    Off = 0,
    Starting = 1,
    Live = 2,
    NoDevice = 3,
    Failed = 4,
    /// Live but only zeros so far (on macOS: microphone permission not granted).
    Silent = 5,
}

impl MicStatus {
    fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Starting,
            2 => Self::Live,
            3 => Self::NoDevice,
            4 => Self::Failed,
            5 => Self::Silent,
            _ => Self::Off,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Starting => "starting",
            Self::Live => "live",
            Self::NoDevice => "no input device",
            Self::Failed => "failed",
            Self::Silent => "silent (permission?)",
        }
    }
}

#[derive(Default)]
struct Shared {
    ring: Mutex<VecDeque<i16>>,
    status: AtomicU8,
    /// 16 kHz samples produced / of them non-zero (permission check).
    produced: AtomicU64,
    nonzero: AtomicU64,
    dropped: AtomicU64,
}

/// A running microphone capture. Dropping it stops the stream and joins the thread.
pub struct Capture {
    shared: Arc<Shared>,
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
    device: Arc<Mutex<String>>,
}

impl Capture {
    /// Open `device` (by name; `None` or not found = the default input device).
    pub fn start(device: Option<String>) -> Self {
        let shared = Arc::new(Shared { ring: Mutex::new(VecDeque::with_capacity(RING_CAP)), ..Default::default() });
        shared.status.store(MicStatus::Starting as u8, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel::<()>();
        let name = Arc::new(Mutex::new(String::new()));
        let (sh, nm) = (shared.clone(), name.clone());
        let thread = std::thread::Builder::new()
            .name("voice-capture".into())
            .spawn(move || run(sh, nm, device, rx))
            .map_err(|e| warn!("voice: could not start the capture thread: {e}"))
            .ok();
        if thread.is_none() {
            shared.status.store(MicStatus::Failed as u8, Ordering::Relaxed);
        }
        Capture { shared, stop: Some(tx), thread, device: name }
    }

    pub fn status(&self) -> MicStatus {
        let s = MicStatus::from_u8(self.shared.status.load(Ordering::Relaxed));
        if s == MicStatus::Live
            && self.shared.produced.load(Ordering::Relaxed) > 3 * 16_000
            && self.shared.nonzero.load(Ordering::Relaxed) == 0
        {
            return MicStatus::Silent;
        }
        s
    }

    pub fn device_name(&self) -> String {
        self.device.lock().map(|n| n.clone()).unwrap_or_default()
    }

    /// Samples dropped because the game did not drain in time.
    pub fn dropped(&self) -> u64 {
        self.shared.dropped.load(Ordering::Relaxed)
    }

    /// Move every captured 16 kHz sample into `out`.
    pub fn drain(&self, out: &mut Vec<i16>) {
        if let Ok(mut r) = self.shared.ring.lock() {
            out.extend(r.drain(..));
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn run(shared: Arc<Shared>, name: Arc<Mutex<String>>, want: Option<String>, stop: mpsc::Receiver<()>) {
    let fail = |status: MicStatus, msg: String| {
        warn!("voice: {msg}; voice input is off");
        shared.status.store(status as u8, Ordering::Relaxed);
    };
    let host = cpal::default_host();
    let named = want.as_deref().filter(|n| !n.is_empty()).and_then(|want| {
        host.input_devices().ok()?.find(|d| d.description().is_ok_and(|desc| desc.name() == want))
    });
    let Some(device) = named.or_else(|| host.default_input_device()) else {
        return fail(MicStatus::NoDevice, "no microphone found".into());
    };
    let dev_name = device.description().map(|d| d.name().to_string()).unwrap_or_else(|_| "unknown".into());
    if let Ok(mut n) = name.lock() {
        *n = dev_name.clone();
    }
    let supported = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => return fail(MicStatus::Failed, format!("microphone \"{dev_name}\" has no usable format ({e})")),
    };
    let config = supported.config();
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, &config, shared.clone()),
        SampleFormat::I16 => build::<i16>(&device, &config, shared.clone()),
        SampleFormat::I32 => build::<i32>(&device, &config, shared.clone()),
        SampleFormat::U16 => build::<u16>(&device, &config, shared.clone()),
        SampleFormat::U8 => build::<u8>(&device, &config, shared.clone()),
        SampleFormat::F64 => build::<f64>(&device, &config, shared.clone()),
        f => return fail(MicStatus::Failed, format!("microphone sample format {f:?} not supported")),
    };
    let stream = match stream {
        Ok(s) => s,
        Err(e) => return fail(MicStatus::Failed, format!("could not open microphone \"{dev_name}\" ({e})")),
    };
    if let Err(e) = stream.play() {
        return fail(MicStatus::Failed, format!("could not start microphone \"{dev_name}\" ({e})"));
    }
    info!("voice: microphone \"{dev_name}\" at {} Hz, {} ch", config.sample_rate, config.channels);
    // Errors from the callback may already have set Failed.
    let _ = shared.status.compare_exchange(MicStatus::Starting as u8, MicStatus::Live as u8, Ordering::Relaxed, Ordering::Relaxed);
    // Keep the stream alive until the game drops the Capture (the sender hangs up).
    let _ = stop.recv();
    drop(stream);
    shared.status.store(MicStatus::Off as u8, Ordering::Relaxed);
}

fn build<T>(device: &cpal::Device, config: &cpal::StreamConfig, shared: Arc<Shared>) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let mut rs = Resampler::new(config.sample_rate, config.channels);
    let mut scratch: Vec<f32> = Vec::with_capacity(4096);
    let mut out: Vec<i16> = Vec::with_capacity(2048);
    let err_shared = shared.clone();
    device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            scratch.clear();
            scratch.extend(data.iter().map(|&s| f32::from_sample_(s)));
            out.clear();
            rs.push(&scratch, |x| out.push(to_i16(x)));
            let nz = out.iter().filter(|&&s| s != 0).count() as u64;
            shared.produced.fetch_add(out.len() as u64, Ordering::Relaxed);
            shared.nonzero.fetch_add(nz, Ordering::Relaxed);
            if let Ok(mut r) = shared.ring.lock() {
                let over = (r.len() + out.len()).saturating_sub(RING_CAP);
                if over > 0 {
                    let n = over.min(r.len());
                    r.drain(..n);
                    shared.dropped.fetch_add(over as u64, Ordering::Relaxed);
                }
                r.extend(out.iter().copied());
            }
        },
        move |e| {
            warn!("voice: microphone stream error: {e}");
            err_shared.status.store(MicStatus::Failed as u8, Ordering::Relaxed);
        },
        None,
    )
}
