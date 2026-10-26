//! Devkit command line: asset checks and golden-image comparison, JSON out, exit code 1 on
//! failure. No window, no Bevy app.
//!
//! ```text
//! cargo run --example devkit_cli -- assets <assets dir> [--src <dir>]... [--max-px 4096] [--info]
//! cargo run --example devkit_cli -- golden <actual.png> <golden.png> [--threshold 0.1] [--ratio 0.002]
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

use engine::devkit::content::{AssetCheckConfig, Severity, check_assets};
use engine::devkit::golden::{GoldenOptions, check_golden};

fn flag_values(args: &[String], name: &str) -> Vec<String> {
    args.windows(2).filter(|w| w[0] == name).map(|w| w[1].clone()).collect()
}

fn flag<T: std::str::FromStr>(args: &[String], name: &str) -> Option<T> {
    flag_values(args, name).last().and_then(|v| v.parse().ok())
}

fn usage() -> ExitCode {
    eprintln!("usage: devkit_cli assets <dir> [--src <dir>]... [--max-px N] [--info]\n       devkit_cli golden <actual.png> <golden.png> [--threshold T] [--ratio R]");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("assets") => {
            let Some(dir) = args.get(1) else { return usage() };
            let mut cfg = AssetCheckConfig::default();
            let src = flag_values(&args, "--src");
            if !src.is_empty() {
                cfg.sources = src.into_iter().map(PathBuf::from).collect();
            }
            if let Some(px) = flag(&args, "--max-px") {
                cfg.max_texture_px = px;
            }
            let mut r = check_assets(&PathBuf::from(dir), &cfg);
            if !args.iter().any(|a| a == "--info") {
                r.issues.retain(|i| i.severity != Severity::Info);
            }
            println!("{}", serde_json::to_string_pretty(&r).unwrap_or_default());
            if r.ok() { ExitCode::SUCCESS } else { ExitCode::from(1) }
        }
        Some("golden") => {
            let (Some(actual), Some(golden)) = (args.get(1), args.get(2)) else { return usage() };
            let mut opts = GoldenOptions::default();
            if let Some(t) = flag(&args, "--threshold") {
                opts.pixel_threshold = t;
            }
            if let Some(r) = flag(&args, "--ratio") {
                opts.max_diff_ratio = r;
            }
            match check_golden(&PathBuf::from(actual), &PathBuf::from(golden), &opts) {
                Ok(r) => {
                    println!("{}", serde_json::to_string_pretty(&r).unwrap_or_default());
                    if r.pass { ExitCode::SUCCESS } else { ExitCode::from(1) }
                }
                Err(e) => {
                    eprintln!("golden: {e}");
                    ExitCode::from(2)
                }
            }
        }
        _ => usage(),
    }
}
