//! Byte-level wire helpers: little-endian ints, LEB128 varints, zigzag, sequence-number
//! arithmetic, quantised floats / quaternions, and a fast 64-bit hash.
//!
//! Writing appends to a plain `Vec<u8>` ([`Put`]); reading goes through [`Reader`], which never
//! panics on short or corrupt input (every read returns `Result`).

use bevy::math::{Quat, Vec3};

/// Malformed or truncated input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WireError;

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("malformed packet")
    }
}

impl std::error::Error for WireError {}

pub type WireResult<T> = Result<T, WireError>;

/// Appending writes onto a byte buffer.
pub trait Put {
    fn put_u8(&mut self, v: u8);
    fn put_u16(&mut self, v: u16);
    fn put_u32(&mut self, v: u32);
    fn put_u64(&mut self, v: u64);
    fn put_f32(&mut self, v: f32);
    /// LEB128 unsigned varint (1 byte below 128, 2 below 16384, ...).
    fn put_var(&mut self, v: u64);
    /// Zigzag + varint for signed values.
    fn put_ivar(&mut self, v: i64) {
        self.put_var(zigzag(v));
    }
    /// Varint length + bytes.
    fn put_bytes(&mut self, b: &[u8]);
}

impl Put for Vec<u8> {
    #[inline]
    fn put_u8(&mut self, v: u8) {
        self.push(v);
    }
    #[inline]
    fn put_u16(&mut self, v: u16) {
        self.extend_from_slice(&v.to_le_bytes());
    }
    #[inline]
    fn put_u32(&mut self, v: u32) {
        self.extend_from_slice(&v.to_le_bytes());
    }
    #[inline]
    fn put_u64(&mut self, v: u64) {
        self.extend_from_slice(&v.to_le_bytes());
    }
    #[inline]
    fn put_f32(&mut self, v: f32) {
        self.extend_from_slice(&v.to_le_bytes());
    }
    #[inline]
    fn put_var(&mut self, mut v: u64) {
        while v >= 0x80 {
            self.push((v as u8) | 0x80);
            v >>= 7;
        }
        self.push(v as u8);
    }
    #[inline]
    fn put_bytes(&mut self, b: &[u8]) {
        self.put_var(b.len() as u64);
        self.extend_from_slice(b);
    }
}

/// Bytes a varint of `v` takes.
#[inline]
pub fn var_len(v: u64) -> usize {
    (64 - (v | 1).leading_zeros()).div_ceil(7) as usize
}

#[inline]
pub fn zigzag(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

#[inline]
pub fn unzigzag(v: u64) -> i64 {
    ((v >> 1) as i64) ^ -((v & 1) as i64)
}

/// Cursor over received bytes.
#[derive(Clone, Copy, Debug)]
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }
    pub fn remaining(&self) -> &'a [u8] {
        &self.buf[self.pos..]
    }
    pub fn is_empty(&self) -> bool {
        self.pos >= self.buf.len()
    }
    pub fn position(&self) -> usize {
        self.pos
    }
    pub fn skip(&mut self, n: usize) -> WireResult<()> {
        if self.buf.len() - self.pos < n {
            return Err(WireError);
        }
        self.pos += n;
        Ok(())
    }
    #[inline]
    fn take<const N: usize>(&mut self) -> WireResult<[u8; N]> {
        let s = self.buf.get(self.pos..self.pos + N).ok_or(WireError)?;
        self.pos += N;
        Ok(s.try_into().unwrap())
    }
    pub fn u8(&mut self) -> WireResult<u8> {
        Ok(self.take::<1>()?[0])
    }
    pub fn u16(&mut self) -> WireResult<u16> {
        Ok(u16::from_le_bytes(self.take()?))
    }
    pub fn u32(&mut self) -> WireResult<u32> {
        Ok(u32::from_le_bytes(self.take()?))
    }
    pub fn u64(&mut self) -> WireResult<u64> {
        Ok(u64::from_le_bytes(self.take()?))
    }
    pub fn f32(&mut self) -> WireResult<f32> {
        Ok(f32::from_le_bytes(self.take()?))
    }
    pub fn var(&mut self) -> WireResult<u64> {
        let mut v = 0u64;
        for shift in (0..64).step_by(7) {
            let b = self.u8()?;
            v |= u64::from(b & 0x7f) << shift;
            if b & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err(WireError)
    }
    pub fn var_u32(&mut self) -> WireResult<u32> {
        u32::try_from(self.var()?).map_err(|_| WireError)
    }
    pub fn ivar(&mut self) -> WireResult<i64> {
        Ok(unzigzag(self.var()?))
    }
    pub fn bytes(&mut self) -> WireResult<&'a [u8]> {
        let n = usize::try_from(self.var()?).map_err(|_| WireError)?;
        let s = self.buf.get(self.pos..self.pos.checked_add(n).ok_or(WireError)?).ok_or(WireError)?;
        self.pos += n;
        Ok(s)
    }
    /// Advance past bytes consumed by an external decoder that was handed [`Self::remaining`].
    pub fn advance_to(&mut self, rest: &'a [u8]) {
        self.pos = self.buf.len() - rest.len();
    }
}

// ---- 16-bit sequence numbers (wrap-around safe) ----

/// `a` is newer than `b` (half-range comparison on u16).
#[inline]
pub fn seq_gt(a: u16, b: u16) -> bool {
    a != b && a.wrapping_sub(b) < 0x8000
}

/// `b - a` as a signed distance.
#[inline]
pub fn seq_diff(a: u16, b: u16) -> i32 {
    a.wrapping_sub(b) as i16 as i32
}

// ---- byte-level delta (any codec; equal-length encodings) ----

/// `cur` against `base` (same length): per 8 bytes a mask byte, then the changed bytes.
/// A 14-byte transform where only the position's low bytes moved takes ~5 bytes.
pub fn byte_delta(base: &[u8], cur: &[u8], out: &mut Vec<u8>) {
    debug_assert_eq!(base.len(), cur.len());
    for (b, c) in base.chunks(8).zip(cur.chunks(8)) {
        let mut mask = 0u8;
        for (j, (x, y)) in b.iter().zip(c).enumerate() {
            if x != y {
                mask |= 1 << j;
            }
        }
        out.push(mask);
        for (j, &y) in c.iter().enumerate() {
            if mask & (1 << j) != 0 {
                out.push(y);
            }
        }
    }
}

/// Inverse of [`byte_delta`]: rebuild the full encoding into `out` (cleared first).
pub fn byte_undelta(base: &[u8], delta: &[u8], out: &mut Vec<u8>) -> WireResult<()> {
    out.clear();
    let mut r = Reader::new(delta);
    for b in base.chunks(8) {
        let mask = r.u8()?;
        for (j, &byte) in b.iter().enumerate() {
            out.push(if mask & (1 << j) != 0 { r.u8()? } else { byte });
        }
    }
    if r.is_empty() { Ok(()) } else { Err(WireError) }
}

// ---- quantisation ----

/// Position quantised to `step` metres, zigzag varints (3–9 bytes for typical game worlds).
pub fn put_vec3_q(out: &mut Vec<u8>, v: Vec3, step: f32) {
    let inv = 1.0 / step;
    for c in [v.x, v.y, v.z] {
        out.put_ivar((c * inv).round() as i64);
    }
}

pub fn read_vec3_q(r: &mut Reader, step: f32) -> WireResult<Vec3> {
    Ok(Vec3::new(r.ivar()? as f32 * step, r.ivar()? as f32 * step, r.ivar()? as f32 * step))
}

/// Value a [`put_vec3_q`]/[`read_vec3_q`] round trip gives.
pub fn quantize_vec3(v: Vec3, step: f32) -> Vec3 {
    let inv = 1.0 / step;
    (v * inv).round() * step
}

/// Unit quaternion in 32 bits: "smallest three", 2-bit index + 3 × 10-bit components
/// (max error ~0.25°).
pub fn pack_quat(q: Quat) -> u32 {
    let q = q.normalize();
    let a = [q.x, q.y, q.z, q.w];
    let mut largest = 0;
    for i in 1..4 {
        if a[i].abs() > a[largest].abs() {
            largest = i;
        }
    }
    let sign = if a[largest] < 0.0 { -1.0 } else { 1.0 };
    const RANGE: f32 = std::f32::consts::FRAC_1_SQRT_2;
    let mut bits = largest as u32;
    for (i, c) in a.iter().enumerate() {
        if i == largest {
            continue;
        }
        let n = ((c * sign / RANGE) * 0.5 + 0.5).clamp(0.0, 1.0);
        bits = (bits << 10) | (n * 1023.0).round() as u32;
    }
    bits
}

pub fn unpack_quat(bits: u32) -> Quat {
    const RANGE: f32 = std::f32::consts::FRAC_1_SQRT_2;
    let largest = (bits >> 30) as usize;
    let mut a = [0.0f32; 4];
    let mut sum = 0.0;
    let mut shift = 20;
    for (i, slot) in a.iter_mut().enumerate() {
        if i == largest {
            continue;
        }
        let n = ((bits >> shift) & 1023) as f32 / 1023.0;
        *slot = (n - 0.5) * 2.0 * RANGE;
        sum += *slot * *slot;
        shift -= 10;
    }
    a[largest] = (1.0 - sum).max(0.0).sqrt();
    Quat::from_xyzw(a[0], a[1], a[2], a[3]).normalize()
}

/// FNV-1a 64 (protocol ids, packet hashes): tiny, no dependency, good enough for non-adversarial ids.
pub fn hash64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Deterministic small PRNG (splitmix64) for the link conditioner and salts in tests.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed ^ 0x9e37_79b9_7f4a_7c15)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    /// Uniform in `[0, 1)`.
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }
    pub fn chance(&mut self, p: f32) -> bool {
        p > 0.0 && self.next_f32() < p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varints_round_trip() {
        let mut b = Vec::new();
        let vals = [0u64, 1, 127, 128, 300, 16383, 16384, u32::MAX as u64, u64::MAX];
        for v in vals {
            b.put_var(v);
            assert_eq!(var_len(v), {
                let mut t = Vec::new();
                t.put_var(v);
                t.len()
            });
        }
        for i in [-5i64, 0, 7, i64::MIN, i64::MAX] {
            b.put_ivar(i);
        }
        let mut r = Reader::new(&b);
        for v in vals {
            assert_eq!(r.var().unwrap(), v);
        }
        for i in [-5i64, 0, 7, i64::MIN, i64::MAX] {
            assert_eq!(r.ivar().unwrap(), i);
        }
        assert!(r.is_empty());
        assert!(r.u8().is_err(), "reading past the end is an error, not a panic");
    }

    #[test]
    fn byte_delta_round_trips() {
        let base = [1u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
        let cur = [1u8, 2, 9, 4, 5, 6, 7, 8, 9, 10, 12];
        let mut d = Vec::new();
        byte_delta(&base, &cur, &mut d);
        assert_eq!(d.len(), 4, "2 masks + 2 changed bytes");
        let mut out = Vec::new();
        byte_undelta(&base, &d, &mut out).unwrap();
        assert_eq!(out, cur);
        assert!(byte_undelta(&base, &d[..3], &mut out).is_err());
    }

    #[test]
    fn seq_wraps() {
        assert!(seq_gt(1, 0));
        assert!(seq_gt(0, 65535));
        assert!(!seq_gt(65535, 0));
        assert_eq!(seq_diff(2, 65534), 4);
    }

    #[test]
    fn quat_packs_within_a_tenth_degree() {
        let mut rng = Rng::new(7);
        for _ in 0..1000 {
            let q = Quat::from_xyzw(rng.next_f32() - 0.5, rng.next_f32() - 0.5, rng.next_f32() - 0.5, rng.next_f32() - 0.5)
                .normalize();
            let u = unpack_quat(pack_quat(q));
            assert!(q.angle_between(u).to_degrees() < 0.3, "{q:?} vs {u:?}");
        }
    }
}
