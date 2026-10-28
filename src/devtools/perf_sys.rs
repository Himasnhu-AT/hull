//! OS probes for the perf monitor: process memory/CPU, per-thread CPU, GPU. All `unsafe` FFI
//! for perf lives here. Called only from the sampler thread (1 Hz), never on the frame.
//!
//! macOS:
//! - memory: `proc_pid_rusage(RUSAGE_INFO_V2)` → resident size and `phys_footprint`
//!   (what Activity Monitor calls "Memory");
//! - CPU: `getrusage(RUSAGE_SELF)`; threads: `task_threads` + `thread_info(THREAD_EXTENDED_INFO)`
//!   (CPU ns + name) and `THREAD_IDENTIFIER_INFO` (stable id);
//! - GPU: IOKit `IOAccelerator` → `PerformanceStatistics` (device-wide device/renderer/tiler
//!   utilisation and memory; polled several times a second because one read is near-instant)
//!   and its `AGXDeviceUserClient` children's `AppUsage.accumulatedGPUTime` (ns) per creator
//!   pid (per-process GPU time, as asitop/macmon read it); Metal `currentAllocatedSize` of the
//!   default device (this process's GPU allocations).
//! - Machine processes: sysinfo (CPU, resident) + `proc_pid_rusage` footprint where readable.
//!   See docs/PERF.md.
//!
//! Linux: `/proc/self` for RSS and threads, no GPU. Elsewhere: process CPU only (or nothing).

/// CPU time used so far by one thread.
#[derive(Clone, Debug)]
pub struct ThreadCpu {
    pub id: u64,
    pub name: String,
    pub cpu_ns: u64,
    /// Unnamed thread currently serving a GCD queue (macOS dispatch worker).
    pub gcd: bool,
}

/// One instantaneous read of the driver's `PerformanceStatistics` (device-wide, all apps).
/// The driver's window is short, so single reads jump between 0 and 100 %; poll and average.
#[derive(Clone, Copy, Debug, Default)]
pub struct GpuUtil {
    pub device: f64,
    pub renderer: f64,
    pub tiler: f64,
    /// Device-wide memory in use, bytes.
    pub in_use: u64,
    /// Device-wide memory allocated (wired for the GPU), bytes.
    pub alloc: u64,
}

/// Cumulative GPU time of one process (summed over its IOAccelerator user clients).
#[derive(Clone, Debug)]
pub struct GpuClient {
    pub pid: i32,
    pub name: String,
    pub gpu_ns: u64,
}

#[derive(Clone, Debug, Default)]
pub struct GpuSys {
    /// GPU time used by this process so far, ns.
    pub process_gpu_ns: Option<u64>,
    /// This process's Metal allocations, bytes.
    pub process_alloc: Option<u64>,
    /// Metal's `recommendedMaxWorkingSetSize`: how much GPU memory the app should stay under.
    pub working_set: Option<u64>,
    /// Every process holding a GPU user client, with its cumulative GPU time.
    pub clients: Vec<GpuClient>,
}

/// One process on the machine, for the top-N tables.
#[derive(Clone, Debug)]
pub struct ProcSample {
    pub pid: i32,
    pub name: String,
    /// % of one core over the last refresh window.
    pub cpu_pct: f32,
    /// Bytes: phys_footprint on macOS (Activity Monitor's "Memory"), resident elsewhere.
    pub mem: u64,
}

/// Machine-wide process probe. Lives on the sampler thread.
///
/// macOS: libproc (`proc_listallpids` + `proc_pid_rusage` + `proc_name`). sysinfo can't be used
/// there: Bevy turns on its `apple-app-store` feature, which stubs process listing out (0
/// processes). Processes of other users (root, `_windowserver`) aren't readable without root
/// and are skipped; the GPU table still lists them from IOKit. Elsewhere: sysinfo.
pub struct ProcProbe {
    #[cfg(target_os = "macos")]
    prev: std::collections::HashMap<i32, u64>,
    #[cfg(target_os = "macos")]
    prev_t: std::time::Instant,
    /// Mach ticks → ns (`ri_user_time` is in mach absolute time units on Apple silicon).
    #[cfg(target_os = "macos")]
    timebase: (u64, u64),
    #[cfg(not(target_os = "macos"))]
    sys: sysinfo::System,
}

impl ProcProbe {
    #[allow(deprecated)] // libc points at mach2 for mach_timebase_info; not worth a dependency
    pub fn new() -> Self {
        #[cfg(target_os = "macos")]
        {
            let mut tb = libc::mach_timebase_info { numer: 0, denom: 0 };
            // SAFETY: `tb` is a valid out pointer.
            let ok = unsafe { libc::mach_timebase_info(&mut tb) } == 0 && tb.denom != 0;
            Self {
                prev: Default::default(),
                prev_t: std::time::Instant::now(),
                timebase: if ok { (tb.numer as u64, tb.denom as u64) } else { (1, 1) },
            }
        }
        #[cfg(not(target_os = "macos"))]
        Self { sys: sysinfo::System::new() }
    }

    /// Every readable process's CPU (since the last call) and memory.
    #[cfg(target_os = "macos")]
    pub fn sample(&mut self) -> Vec<ProcSample> {
        // SAFETY: a null buffer asks for the pid count.
        let n = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if n <= 0 {
            return Vec::new();
        }
        let mut pids = vec![0i32; n as usize + 64];
        // SAFETY: `pids` is writable for the byte size we pass.
        let n = unsafe {
            libc::proc_listallpids(pids.as_mut_ptr() as *mut libc::c_void, (pids.len() * size_of::<i32>()) as i32)
        };
        pids.truncate(n.max(0) as usize);
        let now = std::time::Instant::now();
        let wall = now.duration_since(self.prev_t).as_nanos().max(1) as f64;
        self.prev_t = now;
        let (numer, denom) = self.timebase;
        let mut next = std::collections::HashMap::with_capacity(pids.len());
        let mut out = Vec::with_capacity(pids.len());
        for pid in pids.into_iter().filter(|p| *p > 0) {
            let Some(ru) = rusage(pid) else { continue };
            let cpu_ns = (ru.ri_user_time + ru.ri_system_time) as u128 * numer as u128 / denom as u128;
            let cpu_ns = cpu_ns as u64;
            let cpu_pct = self.prev.get(&pid).map_or(0.0, |p| (cpu_ns.saturating_sub(*p) as f64 / wall * 100.0) as f32);
            next.insert(pid, cpu_ns);
            let mut buf = [0u8; 64];
            // SAFETY: `buf` is writable for its length; proc_name NUL-terminates within it.
            let len = unsafe { libc::proc_name(pid, buf.as_mut_ptr() as *mut libc::c_void, buf.len() as u32) };
            let name = String::from_utf8_lossy(&buf[..len.clamp(0, 64) as usize]).into_owned();
            out.push(ProcSample { pid, name, cpu_pct, mem: ru.ri_phys_footprint });
        }
        self.prev = next;
        out
    }

    /// Every process's CPU (since the last call) and resident memory.
    #[cfg(not(target_os = "macos"))]
    pub fn sample(&mut self) -> Vec<ProcSample> {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate};
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );
        self.sys
            .processes()
            .iter()
            .map(|(pid, p)| ProcSample {
                pid: pid.as_u32() as i32,
                name: p.name().to_string_lossy().into_owned(),
                cpu_pct: p.cpu_usage(),
                mem: p.memory(),
            })
            .collect()
    }
}

#[cfg(target_os = "macos")]
fn rusage(pid: i32) -> Option<libc::rusage_info_v2> {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
    // SAFETY: `info` is a writable rusage_info_v2, matching the RUSAGE_INFO_V2 flavor.
    let rc = unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V2, info.as_mut_ptr() as *mut libc::rusage_info_t) };
    // SAFETY: zero-initialised and filled in by a successful proc_pid_rusage.
    (rc == 0).then(|| unsafe { info.assume_init() })
}

/// Process CPU time (user + system) in ns.
pub fn process_cpu_ns() -> Option<u64> {
    #[cfg(unix)]
    {
        let mut ru = std::mem::MaybeUninit::<libc::rusage>::zeroed();
        // SAFETY: `ru` is a valid, writable `rusage`; getrusage only writes into it.
        let ok = unsafe { libc::getrusage(libc::RUSAGE_SELF, ru.as_mut_ptr()) } == 0;
        if !ok {
            return None;
        }
        // SAFETY: zero-initialised and filled in by a successful getrusage.
        let ru = unsafe { ru.assume_init() };
        let tv = |t: libc::timeval| t.tv_sec as u64 * 1_000_000_000 + t.tv_usec as u64 * 1000;
        Some(tv(ru.ru_utime) + tv(ru.ru_stime))
    }
    #[cfg(not(unix))]
    None
}

/// Id of the calling thread, comparable with [`ThreadCpu::id`].
pub fn current_thread_id() -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut id = 0u64;
        // SAFETY: a null pthread_t means "the calling thread"; `id` is a valid out pointer.
        unsafe { libc::pthread_threadid_np(0 as libc::pthread_t, &mut id) };
        id
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: gettid has no preconditions.
        unsafe { libc::gettid() as u64 }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    0
}

pub use imp::*;

#[cfg(target_os = "macos")]
mod imp {
    use super::{GpuClient, GpuSys, GpuUtil, ThreadCpu};
    use std::collections::HashMap;
    use std::ffi::{CStr, c_char, c_void};

    type CFTypeRef = *const c_void;
    type IoObject = u32;

    const KCF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const KCF_NUMBER_SINT64: isize = 4;

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOServiceMatching(name: *const c_char) -> *mut c_void;
        fn IOServiceGetMatchingServices(main_port: u32, matching: *mut c_void, it: *mut IoObject) -> i32;
        fn IOIteratorNext(it: IoObject) -> IoObject;
        fn IOObjectRelease(o: IoObject) -> i32;
        fn IORegistryEntryCreateCFProperty(entry: IoObject, key: CFTypeRef, alloc: CFTypeRef, options: u32) -> CFTypeRef;
        fn IORegistryEntryGetChildIterator(entry: IoObject, plane: *const c_char, it: *mut IoObject) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(alloc: CFTypeRef, s: *const c_char, enc: u32) -> CFTypeRef;
        fn CFStringGetCString(s: CFTypeRef, buf: *mut c_char, size: isize, enc: u32) -> u8;
        fn CFDictionaryGetValue(d: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
        fn CFNumberGetValue(n: CFTypeRef, ty: isize, out: *mut c_void) -> u8;
        fn CFArrayGetCount(a: CFTypeRef) -> isize;
        fn CFArrayGetValueAtIndex(a: CFTypeRef, i: isize) -> CFTypeRef;
        fn CFGetTypeID(cf: CFTypeRef) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFNumberGetTypeID() -> usize;
        fn CFArrayGetTypeID() -> usize;
        fn CFDictionaryGetTypeID() -> usize;
        fn CFRelease(cf: CFTypeRef);
    }

    #[link(name = "Metal", kind = "framework")]
    unsafe extern "C" {
        fn MTLCreateSystemDefaultDevice() -> *mut c_void;
    }

    #[link(name = "objc")]
    unsafe extern "C" {
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend();
    }

    unsafe extern "C" {
        fn mach_port_deallocate(task: libc::mach_port_t, name: libc::mach_port_t) -> i32;
        static mach_task_self_: libc::mach_port_t;
    }

    fn task_self() -> libc::mach_port_t {
        // SAFETY: `mach_task_self_` is set by libSystem before main and never changes.
        unsafe { mach_task_self_ }
    }

    /// `(resident bytes, phys_footprint bytes)`.
    pub fn process_mem() -> Option<(u64, u64)> {
        let mut info = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
        // SAFETY: `info` is a writable rusage_info_v2, matching the RUSAGE_INFO_V2 flavor.
        let rc = unsafe {
            libc::proc_pid_rusage(
                libc::getpid(),
                libc::RUSAGE_INFO_V2,
                info.as_mut_ptr() as *mut libc::rusage_info_t,
            )
        };
        if rc != 0 {
            return None;
        }
        // SAFETY: zero-initialised and filled in by a successful proc_pid_rusage.
        let info = unsafe { info.assume_init() };
        Some((info.ri_resident_size, info.ri_phys_footprint))
    }

    /// CPU time and name of every thread in this process.
    pub fn threads() -> Vec<ThreadCpu> {
        let task = task_self();
        let mut list: libc::thread_act_array_t = std::ptr::null_mut();
        let mut count: libc::mach_msg_type_number_t = 0;
        // SAFETY: valid out pointers; on success the kernel gives us `count` send rights in a
        // vm-allocated array, which we release below.
        if unsafe { libc::task_threads(task, &mut list, &mut count) } != 0 || list.is_null() {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(count as usize);
        for i in 0..count as usize {
            // SAFETY: `i < count`, the array holds `count` thread ports.
            let th = unsafe { *list.add(i) };
            let mut ext = std::mem::MaybeUninit::<libc::thread_extended_info>::zeroed();
            let mut n = libc::THREAD_EXTENDED_INFO_COUNT;
            // SAFETY: `ext` has room for THREAD_EXTENDED_INFO_COUNT integers, as `n` says.
            let ok = unsafe {
                libc::thread_info(th, libc::THREAD_EXTENDED_INFO as u32, ext.as_mut_ptr() as libc::thread_info_t, &mut n)
            } == 0;
            let mut ident = std::mem::MaybeUninit::<libc::thread_identifier_info>::zeroed();
            let mut n2 = libc::THREAD_IDENTIFIER_INFO_COUNT;
            // SAFETY: as above, for thread_identifier_info.
            let id_ok = unsafe {
                libc::thread_info(th, libc::THREAD_IDENTIFIER_INFO as u32, ident.as_mut_ptr() as libc::thread_info_t, &mut n2)
            } == 0;
            // SAFETY: `th` is a send right task_threads gave us; we drop our reference.
            unsafe { mach_port_deallocate(task, th) };
            if !ok {
                continue;
            }
            // SAFETY: filled in by a successful thread_info (zeroed otherwise).
            let (ext, ident) = unsafe { (ext.assume_init(), ident.assume_init()) };
            // SAFETY: pth_name is a NUL-terminated C string inside a fixed array (zeroed tail).
            let name = unsafe { CStr::from_ptr(ext.pth_name.as_ptr()) }.to_string_lossy().into_owned();
            out.push(ThreadCpu {
                id: if id_ok { ident.thread_id } else { th as u64 },
                name,
                cpu_ns: ext.pth_user_time + ext.pth_system_time,
                gcd: id_ok && ident.dispatch_qaddr != 0,
            });
        }
        // SAFETY: frees the port array task_threads allocated in our address space.
        unsafe {
            libc::vm_deallocate(
                task,
                list as libc::vm_address_t,
                count as usize * std::mem::size_of::<libc::thread_act_t>(),
            )
        };
        out
    }

    /// GPU probe. Holds CF strings and the Metal device; lives on the sampler thread.
    pub struct GpuProbe {
        k_perf: CFTypeRef,
        k_util: CFTypeRef,
        k_renderer: CFTypeRef,
        k_tiler: CFTypeRef,
        k_inuse: CFTypeRef,
        k_alloc: CFTypeRef,
        k_creator: CFTypeRef,
        k_usage: CFTypeRef,
        k_gputime: CFTypeRef,
        mtl: *mut c_void,
        sel_alloc: *const c_void,
        working_set: Option<u64>,
        pid: i32,
    }

    // SAFETY: CF strings are immutable and thread-safe; MTLDevice is thread-safe. The probe is
    // only used by one thread at a time anyway.
    unsafe impl Send for GpuProbe {}

    fn cfstr(s: &CStr) -> CFTypeRef {
        // SAFETY: `s` is a valid NUL-terminated string; the result is owned (+1) by the probe.
        unsafe { CFStringCreateWithCString(std::ptr::null(), s.as_ptr(), KCF_STRING_ENCODING_UTF8) }
    }

    /// `CFNumber` → i64, if `v` is one.
    fn num(v: CFTypeRef) -> Option<i64> {
        // SAFETY: `v` is null or a live CF object; we check its type before reading it.
        unsafe {
            if v.is_null() || CFGetTypeID(v) != CFNumberGetTypeID() {
                return None;
            }
            let mut x = 0i64;
            (CFNumberGetValue(v, KCF_NUMBER_SINT64, &mut x as *mut i64 as *mut c_void) != 0).then_some(x)
        }
    }

    /// `CFString` → String, if `v` is one.
    fn string(v: CFTypeRef) -> Option<String> {
        // SAFETY: `v` is null or a live CF object; type-checked; `buf` is writable for its length.
        unsafe {
            if v.is_null() || CFGetTypeID(v) != CFStringGetTypeID() {
                return None;
            }
            let mut buf = [0 as c_char; 256];
            if CFStringGetCString(v, buf.as_mut_ptr(), buf.len() as isize, KCF_STRING_ENCODING_UTF8) == 0 {
                return None;
            }
            Some(CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
        }
    }

    impl GpuProbe {
        pub fn new() -> Self {
            // SAFETY: MTLCreateSystemDefaultDevice returns a retained device (or null); we keep it
            // for the process lifetime. Devices are per-GPU singletons, so this is the device
            // wgpu renders with. sel_registerName takes a valid C string.
            let (mtl, sel_alloc, sel_ws) = unsafe {
                (MTLCreateSystemDefaultDevice(), sel_registerName(c"currentAllocatedSize".as_ptr()), sel_registerName(c"recommendedMaxWorkingSetSize".as_ptr()))
            };
            // SAFETY: `-[MTLDevice recommendedMaxWorkingSetSize]` takes no arguments and returns
            // uint64_t; objc_msgSend is called through the matching function type. Constant for
            // the device, so read once.
            let working_set = (!mtl.is_null()).then(|| unsafe {
                let f: unsafe extern "C" fn(*mut c_void, *const c_void) -> u64 = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
                f(mtl, sel_ws)
            });
            Self {
                k_perf: cfstr(c"PerformanceStatistics"),
                k_util: cfstr(c"Device Utilization %"),
                k_renderer: cfstr(c"Renderer Utilization %"),
                k_tiler: cfstr(c"Tiler Utilization %"),
                k_inuse: cfstr(c"In use system memory"),
                k_alloc: cfstr(c"Alloc system memory"),
                k_creator: cfstr(c"IOUserClientCreator"),
                k_usage: cfstr(c"AppUsage"),
                k_gputime: cfstr(c"accumulatedGPUTime"),
                mtl,
                sel_alloc,
                working_set,
                pid: std::process::id() as i32,
            }
        }

        /// Runs `f` on every IOAccelerator service.
        fn each_accel(&self, mut f: impl FnMut(IoObject)) {
            let mut it: IoObject = 0;
            // SAFETY: IOServiceMatching returns a dictionary that IOServiceGetMatchingServices
            // consumes; `it` is a valid out pointer and released below.
            if unsafe { IOServiceGetMatchingServices(0, IOServiceMatching(c"IOAccelerator".as_ptr()), &mut it) } != 0 {
                return;
            }
            loop {
                // SAFETY: `it` is a live iterator; returned objects are released below.
                let accel = unsafe { IOIteratorNext(it) };
                if accel == 0 {
                    break;
                }
                f(accel);
                // SAFETY: we own this reference from IOIteratorNext.
                unsafe { IOObjectRelease(accel) };
            }
            // SAFETY: we own the iterator.
            unsafe { IOObjectRelease(it) };
        }

        /// One read of the driver's device-wide utilisation counters (cheap: one property).
        pub fn poll_util(&mut self) -> Option<GpuUtil> {
            let mut out = None;
            self.each_accel(|accel| {
                // SAFETY: valid entry and key; the returned property (+1) is released here and
                // the dictionary lookups are given a type-checked live dictionary.
                unsafe {
                    let stats = IORegistryEntryCreateCFProperty(accel, self.k_perf, std::ptr::null(), 0);
                    if stats.is_null() {
                        return;
                    }
                    if CFGetTypeID(stats) == CFDictionaryGetTypeID()
                        && let Some(device) = num(CFDictionaryGetValue(stats, self.k_util))
                    {
                        let get = |k| num(CFDictionaryGetValue(stats, k)).unwrap_or(0);
                        out = Some(GpuUtil {
                            device: device as f64,
                            renderer: get(self.k_renderer) as f64,
                            tiler: get(self.k_tiler) as f64,
                            in_use: get(self.k_inuse).max(0) as u64,
                            alloc: get(self.k_alloc).max(0) as u64,
                        });
                    }
                    CFRelease(stats);
                }
            });
            out
        }

        /// Per-process GPU time (all processes) and this process's Metal allocations.
        pub fn sample(&mut self) -> GpuSys {
            let mut g = GpuSys { working_set: self.working_set, ..Default::default() };
            if !self.mtl.is_null() {
                // SAFETY: `-[MTLDevice currentAllocatedSize]` takes no arguments and returns
                // NSUInteger; objc_msgSend is called through the matching function type.
                g.process_alloc = Some(unsafe {
                    let f: unsafe extern "C" fn(*mut c_void, *const c_void) -> usize =
                        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
                    f(self.mtl, self.sel_alloc) as u64
                });
            }
            let mut by_pid: HashMap<i32, GpuClient> = HashMap::new();
            self.each_accel(|accel| self.clients(accel, &mut by_pid));
            g.process_gpu_ns = by_pid.get(&self.pid).map(|c| c.gpu_ns);
            g.clients = by_pid.into_values().collect();
            g
        }

        /// Adds `accumulatedGPUTime` of every user client of `accel` to its creator's entry.
        fn clients(&self, accel: IoObject, by_pid: &mut HashMap<i32, GpuClient>) {
            let mut it: IoObject = 0;
            // SAFETY: valid entry, plane name and out pointer; iterator released below.
            if unsafe { IORegistryEntryGetChildIterator(accel, c"IOService".as_ptr(), &mut it) } != 0 {
                return;
            }
            loop {
                // SAFETY: live iterator.
                let child = unsafe { IOIteratorNext(it) };
                if child == 0 {
                    break;
                }
                // SAFETY: properties are +1 references we release; CF accessors are given
                // type-checked live objects.
                unsafe {
                    let creator = IORegistryEntryCreateCFProperty(child, self.k_creator, std::ptr::null(), 0);
                    // "pid 123, WindowServer"
                    let who = string(creator).and_then(|s| {
                        let (pid, name) = s.strip_prefix("pid ")?.split_once(',')?;
                        Some((pid.trim().parse::<i32>().ok()?, name.trim().to_string()))
                    });
                    if !creator.is_null() {
                        CFRelease(creator);
                    }
                    if let Some((pid, name)) = who {
                        let usage = IORegistryEntryCreateCFProperty(child, self.k_usage, std::ptr::null(), 0);
                        let mut ns = 0u64;
                        if !usage.is_null() {
                            if CFGetTypeID(usage) == CFArrayGetTypeID() {
                                for i in 0..CFArrayGetCount(usage) {
                                    let d = CFArrayGetValueAtIndex(usage, i);
                                    if !d.is_null()
                                        && CFGetTypeID(d) == CFDictionaryGetTypeID()
                                        && let Some(t) = num(CFDictionaryGetValue(d, self.k_gputime))
                                    {
                                        ns += t.max(0) as u64;
                                    }
                                }
                            }
                            CFRelease(usage);
                        }
                        by_pid.entry(pid).or_insert_with(|| GpuClient { pid, name, gpu_ns: 0 }).gpu_ns += ns;
                    }
                    IOObjectRelease(child);
                }
            }
            // SAFETY: we own the iterator.
            unsafe { IOObjectRelease(it) };
        }
    }

    impl Drop for GpuProbe {
        fn drop(&mut self) {
            for k in [
                self.k_perf,
                self.k_util,
                self.k_renderer,
                self.k_tiler,
                self.k_inuse,
                self.k_alloc,
                self.k_creator,
                self.k_usage,
                self.k_gputime,
            ] {
                if !k.is_null() {
                    // SAFETY: each key is a +1 CFString created in `new`.
                    unsafe { CFRelease(k) };
                }
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{GpuSys, GpuUtil, ThreadCpu};

    /// `(resident bytes, resident bytes)`: Linux has no footprint, RSS stands in.
    pub fn process_mem() -> Option<(u64, u64)> {
        let s = std::fs::read_to_string("/proc/self/statm").ok()?;
        let pages: u64 = s.split_whitespace().nth(1)?.parse().ok()?;
        let rss = pages * 4096;
        Some((rss, rss))
    }

    pub fn threads() -> Vec<ThreadCpu> {
        let Ok(dir) = std::fs::read_dir("/proc/self/task") else { return Vec::new() };
        dir.flatten()
            .filter_map(|e| {
                let id: u64 = e.file_name().to_str()?.parse().ok()?;
                let name = std::fs::read_to_string(e.path().join("comm")).ok()?.trim().to_string();
                let stat = std::fs::read_to_string(e.path().join("stat")).ok()?;
                let rest = &stat[stat.rfind(')')? + 2..];
                let f: Vec<&str> = rest.split_whitespace().collect();
                // utime, stime (fields 14, 15) in clock ticks, assumed 100 Hz.
                let ticks: u64 = f.get(11)?.parse::<u64>().ok()? + f.get(12)?.parse::<u64>().ok()?;
                Some(ThreadCpu { id, name, cpu_ns: ticks * 10_000_000, gcd: false })
            })
            .collect()
    }

    pub struct GpuProbe;
    impl GpuProbe {
        pub fn new() -> Self {
            GpuProbe
        }
        pub fn sample(&mut self) -> GpuSys {
            GpuSys::default()
        }
        pub fn poll_util(&mut self) -> Option<GpuUtil> {
            None
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod imp {
    use super::{GpuSys, GpuUtil, ThreadCpu};

    pub fn process_mem() -> Option<(u64, u64)> {
        None
    }
    pub fn threads() -> Vec<ThreadCpu> {
        Vec::new()
    }
    pub struct GpuProbe;
    impl GpuProbe {
        pub fn new() -> Self {
            GpuProbe
        }
        pub fn sample(&mut self) -> GpuSys {
            GpuSys::default()
        }
        pub fn poll_util(&mut self) -> Option<GpuUtil> {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proc_probe_sees_this_process() {
        let mut p = ProcProbe::new();
        p.sample();
        // Burn ~150 ms of CPU so the CPU % (and the mach-tick conversion) can be checked.
        let t = std::time::Instant::now();
        let mut x = 0u64;
        while t.elapsed() < std::time::Duration::from_millis(150) {
            x = std::hint::black_box(x.wrapping_mul(31).wrapping_add(7));
        }
        let all = p.sample();
        let me = std::process::id() as i32;
        assert!(all.len() > 5, "only {} processes", all.len());
        let row = all.iter().find(|r| r.pid == me).expect("own pid listed");
        assert!(row.mem > 0);
        assert!((5.0..800.0).contains(&row.cpu_pct), "own cpu {}%", row.cpu_pct);
    }
}
