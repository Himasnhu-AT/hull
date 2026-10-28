//! Thread priorities (macOS quality-of-service classes; no-ops elsewhere).
//!
//! Without a class every thread is "default" priority and the scheduler can't tell the main
//! and render threads (which set the frame rate) from asset loading or background AI. Unreal
//! raises its Mac game thread and splits workers into foreground/background pools; Godot caps
//! low-priority tasks. Here:
//! - main thread and render thread: `UserInteractive` (set by `EnginePlugin`),
//! - compute pool (systems, par_iter): `UserInitiated`,
//! - async compute and IO pools (loading, baking, PCG cells): `Utility`.
//!
//! Games running their own background threads (simulations, training) should call
//! [`set_current`] with [`Qos::Utility`] or [`Qos::Background`] on them.

/// macOS QoS classes, highest first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Qos {
    UserInteractive,
    UserInitiated,
    Default,
    Utility,
    Background,
}

/// Sets the calling thread's class. Returns whether it took effect (macOS only).
pub fn set_current(q: Qos) -> bool {
    // `ENGINE_QOS=off`: leave every thread at the default (for A/B measurements).
    if std::env::var("ENGINE_QOS").is_ok_and(|v| v == "off") {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn pthread_set_qos_class_self_np(class: u32, relative_priority: i32) -> i32;
        }
        let class = match q {
            Qos::UserInteractive => 0x21,
            Qos::UserInitiated => 0x19,
            Qos::Default => 0x15,
            Qos::Utility => 0x11,
            Qos::Background => 0x09,
        };
        // SAFETY: plain libpthread call on the current thread with a valid class constant.
        unsafe { pthread_set_qos_class_self_np(class, 0) == 0 }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = q;
        false
    }
}
