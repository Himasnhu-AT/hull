//! IMA ADPCM, 4:1: 16-bit PCM → 4-bit codes. Pure, deterministic, no allocation.
//!
//! A frame is [`FRAME_BYTES`] bytes: a 4-byte header (predictor `i16` LE, step index `u8`,
//! one reserved byte) followed by [`FRAME`] nibbles, low nibble first. The header carries the
//! decoder state at the start of the frame, so every frame decodes on its own: a lost packet
//! never corrupts the next one. 320 samples / 20 ms at 16 kHz → 164 bytes → 65.6 kbit/s.

/// Samples per frame (20 ms at 16 kHz).
pub const FRAME: usize = 320;
/// Encoded bytes per frame (header + nibbles).
pub const FRAME_BYTES: usize = 4 + FRAME / 2;

const INDEX_TABLE: [i8; 16] = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

const STEP_TABLE: [i16; 89] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173,
    190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818,
    18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

/// Codec state: the predicted sample and the step-table index.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct State {
    pub predictor: i16,
    pub index: u8,
}

impl State {
    /// Decode one 4-bit code, updating the state; returns the sample.
    #[inline]
    fn decode(&mut self, code: u8) -> i16 {
        let step = i32::from(STEP_TABLE[self.index as usize]);
        let mut diff = step >> 3;
        if code & 4 != 0 {
            diff += step;
        }
        if code & 2 != 0 {
            diff += step >> 1;
        }
        if code & 1 != 0 {
            diff += step >> 2;
        }
        let p = if code & 8 != 0 { i32::from(self.predictor) - diff } else { i32::from(self.predictor) + diff };
        self.predictor = p.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16;
        self.index = (i32::from(self.index) + i32::from(INDEX_TABLE[code as usize & 15])).clamp(0, 88) as u8;
        self.predictor
    }

    /// Encode one sample, updating the state exactly as the decoder will; returns the code.
    #[inline]
    fn encode(&mut self, sample: i16) -> u8 {
        let step = i32::from(STEP_TABLE[self.index as usize]);
        let mut diff = i32::from(sample) - i32::from(self.predictor);
        let mut code = 0u8;
        if diff < 0 {
            code = 8;
            diff = -diff;
        }
        let mut s = step;
        if diff >= s {
            code |= 4;
            diff -= s;
        }
        s >>= 1;
        if diff >= s {
            code |= 2;
            diff -= s;
        }
        s >>= 1;
        if diff >= s {
            code |= 1;
        }
        // Reconstruct with the decoder's arithmetic so both sides stay in lockstep.
        self.decode(code);
        code
    }
}

/// Encoder with state carried across frames (better than restarting each frame).
#[derive(Clone, Copy, Debug, Default)]
pub struct Encoder {
    state: State,
}

impl Encoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Encode one frame of [`FRAME`] samples into `out` ([`FRAME_BYTES`]).
    pub fn encode(&mut self, pcm: &[i16; FRAME], out: &mut [u8; FRAME_BYTES]) {
        out[0..2].copy_from_slice(&self.state.predictor.to_le_bytes());
        out[2] = self.state.index;
        out[3] = 0;
        for (i, pair) in pcm.as_chunks::<2>().0.iter().enumerate() {
            let lo = self.state.encode(pair[0]);
            let hi = self.state.encode(pair[1]);
            out[4 + i] = lo | (hi << 4);
        }
    }
}

/// Decode one frame. Returns `false` (and leaves `pcm` untouched) if `data` is malformed.
pub fn decode(data: &[u8], pcm: &mut [i16; FRAME]) -> bool {
    if data.len() != FRAME_BYTES || data[2] > 88 {
        return false;
    }
    let mut st = State { predictor: i16::from_le_bytes([data[0], data[1]]), index: data[2] };
    for (i, &b) in data[4..].iter().enumerate() {
        pcm[2 * i] = st.decode(b & 15);
        pcm[2 * i + 1] = st.decode(b >> 4);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snr_db(a: &[i16], b: &[i16]) -> f64 {
        let sig: f64 = a.iter().map(|&x| f64::from(x).powi(2)).sum();
        let err: f64 = a.iter().zip(b).map(|(&x, &y)| (f64::from(x) - f64::from(y)).powi(2)).sum();
        10.0 * (sig / err.max(1e-9)).log10()
    }

    fn round_trip(input: &[i16]) -> Vec<i16> {
        let mut enc = Encoder::new();
        let mut out = Vec::new();
        let mut bytes = [0u8; FRAME_BYTES];
        let mut pcm = [0i16; FRAME];
        for f in input.chunks_exact(FRAME) {
            enc.encode(f.try_into().unwrap(), &mut bytes);
            assert!(decode(&bytes, &mut pcm));
            out.extend_from_slice(&pcm);
        }
        out
    }

    fn sine(n: usize, hz: f32, amp: f32) -> Vec<i16> {
        (0..n).map(|i| ((i as f32 / 16_000.0 * hz * std::f32::consts::TAU).sin() * amp * 32767.0) as i16).collect()
    }

    /// Deterministic white noise (xorshift).
    fn noise(n: usize, amp: f32) -> Vec<i16> {
        let mut x = 0x9e37_79b9u32;
        (0..n)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                ((x as f32 / u32::MAX as f32 * 2.0 - 1.0) * amp * 32767.0) as i16
            })
            .collect()
    }

    #[test]
    fn sine_round_trip_snr() {
        // Skip the first frame: the step size needs a few samples to adapt from zero.
        // ADPCM tracks low frequencies best; 3 kHz (near the top of speech) is a few dB worse.
        for (hz, amp, min) in [(220.0, 0.5, 20.0), (440.0, 0.3, 20.0), (1000.0, 0.5, 20.0), (3000.0, 0.2, 15.0)] {
            let x = sine(FRAME * 50, hz, amp);
            let y = round_trip(&x);
            let snr = snr_db(&x[FRAME..], &y[FRAME..]);
            assert!(snr > min, "{hz} Hz: SNR {snr:.1} dB");
        }
    }

    #[test]
    fn noise_round_trip_snr() {
        let x = noise(FRAME * 50, 0.3);
        let y = round_trip(&x);
        let snr = snr_db(&x[FRAME..], &y[FRAME..]);
        assert!(snr > 9.0, "noise SNR {snr:.1} dB");
    }

    #[test]
    fn deterministic_and_frames_independent() {
        let x = sine(FRAME * 10, 440.0, 0.5);
        let a = round_trip(&x);
        let b = round_trip(&x);
        assert_eq!(a, b);
        // Decoding frame 5 alone gives the same samples as the continuous decode.
        let mut enc = Encoder::new();
        let mut bytes = [0u8; FRAME_BYTES];
        let mut frames = Vec::new();
        for f in x.chunks_exact(FRAME) {
            enc.encode(f.try_into().unwrap(), &mut bytes);
            frames.push(bytes);
        }
        let mut pcm = [0i16; FRAME];
        assert!(decode(&frames[5], &mut pcm));
        assert_eq!(&pcm[..], &a[5 * FRAME..6 * FRAME]);
    }

    /// `cargo test --lib voice::adpcm -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_codec() {
        let x = sine(FRAME * 1000, 440.0, 0.5);
        let mut enc = Encoder::new();
        let mut bytes = [0u8; FRAME_BYTES];
        let mut pcm = [0i16; FRAME];
        let t = std::time::Instant::now();
        for f in x.chunks_exact(FRAME) {
            enc.encode(f.try_into().unwrap(), &mut bytes);
            std::hint::black_box(&bytes);
        }
        let e = t.elapsed().as_secs_f64() * 1e6 / 1000.0;
        let t = std::time::Instant::now();
        for _ in 0..1000 {
            decode(std::hint::black_box(&bytes), &mut pcm);
        }
        let d = t.elapsed().as_secs_f64() * 1e6 / 1000.0;
        println!("adpcm per 20 ms frame: encode {e:.2} us, decode {d:.2} us");
    }

    #[test]
    fn extremes_and_bad_input() {
        let mut x = vec![i16::MAX; FRAME * 4];
        x.extend(vec![i16::MIN; FRAME * 4]);
        let y = round_trip(&x);
        assert!(y[3 * FRAME..4 * FRAME].iter().all(|&s| s > 30_000));
        assert!(y[7 * FRAME..].iter().all(|&s| s < -30_000));
        let mut pcm = [7i16; FRAME];
        assert!(!decode(&[0; 10], &mut pcm));
        let mut bad = [0u8; FRAME_BYTES];
        bad[2] = 200;
        assert!(!decode(&bad, &mut pcm));
        assert_eq!(pcm[0], 7);
    }
}
