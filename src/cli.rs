//! Command-line helpers shared by engine and games. Owner: core stream.
//! Engine flags: `--headless`, `--offscreen`, `--control <port>`, `--play` (skip the menu),
//! `--quit-after <s>`, `--seed <n>`, `--mute`, `--volume <0..1>`.

/// Value of `--<name> <value>` or `--<name>=<value>`.
pub fn arg_value(name: &str) -> Option<String> {
    let flag = format!("--{name}");
    let mut args = std::env::args();
    while let Some(a) = args.next() {
        if a == flag {
            return args.next();
        }
        if let Some(v) = a.strip_prefix(&format!("{flag}=")) {
            return Some(v.to_string());
        }
    }
    None
}

/// Whether `--<name>` is on the command line.
pub fn has_flag(name: &str) -> bool {
    let flag = format!("--{name}");
    std::env::args().any(|a| a == flag)
}

/// Runs driven by the control port / MCP / offscreen tests: never grab the mouse, never
/// change window mode, never play sound unless `--sound`.
pub fn test_driven() -> bool {
    has_flag("control") || has_flag("offscreen") || has_flag("mcp")
}
