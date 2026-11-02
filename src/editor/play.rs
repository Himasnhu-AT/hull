//! Play and Stop.
//!
//! **Play** (`EditorBackend::play`):
//! 1. writes the level to `<data dir>/play/editor_play.level.ron` (the open level file is not
//!    touched, and the editor's "open level" does not change);
//! 2. builds the game: `memgate -- cargo build --manifest-path <M> -p <package> (--bin N | --example N)`
//!    (plain `cargo` when `memgate` is not installed), output streamed line by line into the
//!    Output panel (errors carry `file:line:col`); the target is the one named like the running
//!    executable, found with `cargo metadata`;
//! 3. starts the executable cargo just built (`compiler-artifact`; the running executable when
//!    that is unknown, e.g. with `skip_build`) with `--level <that file> --control 0` in its own process group, plus
//!    the metrics viewer (`ViewerLauncher`), and stops drawing the editor viewport (the scene
//!    camera goes inactive and winit goes reactive).
//!
//! **Stop** kills the game's process group.
//!
//! Where the game is found (`EditorConfig::manifest`, else in this order): env
//! `EDITOR_GAME_MANIFEST` (a `Cargo.toml` or its folder), the parent of
//! `GameInfo::assets_fallback` (games pass `concat!(env!("CARGO_MANIFEST_DIR"), "/assets")`), the
//! working folder and its parents, the executable's folders. The bin/example name is the
//! executable's file name; a `release` folder in its path builds `--release`.
//! `EditorConfig::play_features` (or env `EDITOR_PLAY_FEATURES`)
//! gives `--features`, `skip_build` runs the executable as is.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};

use bevy::prelude::*;
use bevy::winit::WinitSettings;
use editor_proto::{Diagnostic, Level, PlayState};

use super::{EditorConfig, EditorState, log};
use crate::app::GameInfo;
use crate::paths::DataDir;

/// From the build's reader threads.
enum Msg {
    Diag(Diagnostic),
    Exe(PathBuf),
}

#[derive(Default)]
enum Phase {
    #[default]
    Idle,
    Building {
        child: Child,
        msgs: std::sync::Mutex<Receiver<Msg>>,
        level: PathBuf,
        /// The executable cargo reported building.
        exe: Option<PathBuf>,
    },
    Running {
        child: Child,
    },
}

/// The Play pipeline's state (inside [`EditorState`]).
#[derive(Default)]
pub struct PlayRuntime {
    phase: Phase,
    /// `WinitSettings` before Play, restored on Stop.
    saved_winit: Option<WinitSettings>,
}

impl PlayRuntime {
    pub fn is_running(&self) -> bool {
        matches!(self.phase, Phase::Running { .. })
    }
}

pub fn state(world: &mut World) -> PlayState {
    match world.resource::<EditorState>().play.phase {
        Phase::Idle => PlayState::Editing,
        Phase::Building { .. } => PlayState::Building,
        Phase::Running { .. } => PlayState::Playing,
    }
}

fn manifest_dir(world: &World) -> Option<PathBuf> {
    let as_dir = |p: &Path| -> Option<PathBuf> {
        let d = if p.is_dir() { p.to_path_buf() } else { p.parent()?.to_path_buf() };
        d.join("Cargo.toml").is_file().then_some(d)
    };
    if let Some(m) = world.get_resource::<EditorConfig>().and_then(|c| c.manifest.clone()).and_then(|m| as_dir(&m)) {
        return Some(m);
    }
    if let Some(m) = std::env::var_os("EDITOR_GAME_MANIFEST").and_then(|m| as_dir(Path::new(&m))) {
        return Some(m);
    }
    if let Some(a) = world.get_resource::<GameInfo>().and_then(|i| i.assets_fallback)
        && let Some(d) = Path::new(a).parent().and_then(as_dir)
    {
        return Some(d);
    }
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        starts.extend(exe.parent().map(Path::to_path_buf));
    }
    starts.iter().flat_map(|s| s.ancestors()).find_map(|d| {
        let m = d.join("Cargo.toml");
        std::fs::read_to_string(&m).ok().filter(|t| t.contains("[package]")).map(|_| d.to_path_buf())
    })
}

/// (package, "bin" | "example") of the cargo target named `name` in the manifest.
fn find_target(manifest: &Path, name: &str) -> Result<(String, &'static str), String> {
    let out = Command::new("cargo")
        .args(["metadata", "--no-deps", "--format-version", "1", "--manifest-path"])
        .arg(manifest)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cargo metadata: {e}"))?;
    if !out.status.success() {
        return Err(format!("cargo metadata failed: {}", String::from_utf8_lossy(&out.stderr).lines().next().unwrap_or("")));
    }
    let meta: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("cargo metadata: {e}"))?;
    let mut example = None;
    for p in meta["packages"].as_array().into_iter().flatten() {
        for t in p["targets"].as_array().into_iter().flatten() {
            if t["name"].as_str() != Some(name) {
                continue;
            }
            let kinds: Vec<&str> = t["kind"].as_array().into_iter().flatten().filter_map(|k| k.as_str()).collect();
            let pkg = p["name"].as_str().unwrap_or("").to_string();
            if kinds.contains(&"bin") {
                return Ok((pkg, "bin"));
            }
            if kinds.contains(&"example") {
                example = Some((pkg, "example"));
            }
        }
    }
    example.ok_or_else(|| format!("{} has no bin or example named `{name}` (the editor runs as that executable)", manifest.display()))
}

fn build_command(world: &World, exe: &Path) -> Result<Command, String> {
    let manifest = manifest_dir(world).ok_or("cannot find the game's Cargo.toml: set EDITOR_GAME_MANIFEST or EditorConfig::manifest")?;
    let manifest_file = manifest.join("Cargo.toml");
    let name = exe.file_stem().ok_or("bad executable path")?.to_string_lossy().to_string();
    let (package, kind) = find_target(&manifest_file, &name)?;
    let release = exe.components().any(|c| c.as_os_str() == "release");
    let has_memgate = Command::new("memgate").arg("--help").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok();
    let mut cmd = if has_memgate {
        let mut c = Command::new("memgate");
        c.args(["--", "cargo"]);
        c
    } else {
        Command::new("cargo")
    };
    cmd.arg("build").arg("--manifest-path").arg(&manifest_file).args(["--message-format=json-render-diagnostics", "-p", &package]);
    cmd.arg(if kind == "example" { "--example" } else { "--bin" }).arg(&name);
    if release {
        cmd.arg("--release");
    }
    let features = world.get_resource::<EditorConfig>().and_then(|c| c.play_features.clone()).or_else(|| std::env::var("EDITOR_PLAY_FEATURES").ok());
    if let Some(f) = features.filter(|f| !f.is_empty()) {
        cmd.args(["--features", &f]);
    }
    cmd.current_dir(&manifest).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    own_group(&mut cmd);
    Ok(cmd)
}

fn own_group(cmd: &mut Command) {
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(cmd, 0);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(cmd, 0x0000_0200);
}

/// Kills a child and everything it started (its process group).
fn kill_group(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        // SAFETY: killpg on the group we created for this child.
        unsafe {
            libc::killpg(pid, libc::SIGTERM);
        }
        for _ in 0..30 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        unsafe {
            libc::killpg(pid, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

/// One line of cargo's rendered (human) output as a diagnostic. `last` is the level of the
/// message the line belongs to; ` --> file:line:col` lines carry the location.
fn parse_line(line: &str, last: Level) -> Diagnostic {
    let t = line.trim_start();
    let level = if t.starts_with("error") {
        Level::Error
    } else if t.starts_with("warning") {
        Level::Warn
    } else if line.starts_with(' ') || line.starts_with('|') || t.starts_with("-->") || t.starts_with('=') {
        last
    } else {
        Level::Info
    };
    let mut d = Diagnostic { level, source: "cargo".into(), message: line.trim_end().to_string(), file: None, line: None, col: None };
    if let Some(loc) = t.strip_prefix("--> ") {
        let mut parts = loc.rsplitn(3, ':');
        if let (Some(c), Some(l), Some(f)) = (parts.next(), parts.next(), parts.next())
            && let (Ok(l), Ok(c)) = (l.trim().parse::<u32>(), c.trim().parse::<u32>())
        {
            d.file = Some(f.to_string());
            d.line = Some(l);
            d.col = Some(c);
        }
    }
    d
}

/// Starts the Play pipeline.
pub fn start(world: &mut World) -> Result<(), String> {
    if !matches!(world.resource::<EditorState>().play.phase, Phase::Idle) {
        return Err("already building or playing".into());
    }
    let dir = world.get_resource::<DataDir>().map(|d| d.0.join("play")).unwrap_or_else(|| std::env::temp_dir().join("engine-editor-play"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let level_path = dir.join("editor_play.level.ron");
    {
        let header = world.resource::<crate::level::LevelState>().header.clone();
        let deny = world.resource::<crate::level::LevelConfig>().deny.clone();
        let (text, _) = crate::level::file::to_text(world, &header, &deny).map_err(|e| e.to_string())?;
        std::fs::write(&level_path, text).map_err(|e| format!("{}: {e}", level_path.display()))?;
    }
    let exe = std::env::current_exe().map_err(|e| format!("current exe: {e}"))?;
    if world.get_resource::<EditorConfig>().is_some_and(|c| c.skip_build) {
        run_game(world, &level_path, None)?;
        return Ok(());
    }
    let mut cmd = build_command(world, &exe)?;
    log(world, Level::Info, "play", format!("building: {cmd:?}"));
    let mut child = cmd.spawn().map_err(|e| format!("cannot start the build: {e}"))?;
    let (tx, rx) = channel();
    let name = exe.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    if let Some(err) = child.stderr.take() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut last = Level::Info;
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                let d = parse_line(&line, last);
                last = d.level;
                if tx.send(Msg::Diag(d)).is_err() {
                    break;
                }
            }
        });
    }
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                if v["reason"] == "compiler-artifact"
                    && v["target"]["name"].as_str() == Some(name.as_str())
                    && let Some(p) = v["executable"].as_str()
                    && tx.send(Msg::Exe(PathBuf::from(p))).is_err()
                {
                    break;
                }
            }
        });
    }
    world.resource_mut::<EditorState>().play.phase = Phase::Building { child, msgs: std::sync::Mutex::new(rx), level: level_path, exe: None };
    Ok(())
}

fn run_game(world: &mut World, level: &Path, built: Option<PathBuf>) -> Result<(), String> {
    let exe = match built {
        Some(p) => p,
        None => std::env::current_exe().map_err(|e| format!("current exe: {e}"))?,
    };
    let mut cmd = Command::new(exe);
    cmd.arg("--level").arg(level).args(["--control", "0"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    own_group(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("cannot start the game: {e}"))?;
    log(world, Level::Info, "play", format!("game started (pid {})", child.id()));
    if let (Some(data), Some(mut l)) = (world.get_resource::<DataDir>().map(|d| d.0.clone()), world.get_resource_mut::<crate::devtools::metrics_viewer::ViewerLauncher>())
        && let Err(e) = l.launch(&data)
    {
        warn!("{e}");
    }
    let saved = world.get_resource::<WinitSettings>().cloned();
    world.insert_resource(WinitSettings::desktop_app());
    let mut st = world.resource_mut::<EditorState>();
    st.play.saved_winit = saved;
    st.play.phase = Phase::Running { child };
    Ok(())
}

/// Ends the build or the game.
pub fn stop(world: &mut World) {
    let phase = std::mem::take(&mut world.resource_mut::<EditorState>().play.phase);
    match phase {
        Phase::Idle => return,
        Phase::Building { mut child, .. } | Phase::Running { mut child } => kill_group(&mut child),
    }
    restore_winit(world);
    log(world, Level::Info, "play", "stopped".into());
}

fn restore_winit(world: &mut World) {
    if let Some(w) = world.resource_mut::<EditorState>().play.saved_winit.take() {
        world.insert_resource(w);
    } else if world.contains_resource::<WinitSettings>() {
        world.insert_resource(WinitSettings::default());
    }
}

/// Every frame: stream build output, move Building to Running, notice a game that exited.
pub fn poll(world: &mut World) {
    let mut diags = Vec::new();
    let mut done: Option<(Result<bool, String>, PathBuf, Option<PathBuf>)> = None;
    let mut exited = false;
    {
        let mut st = world.resource_mut::<EditorState>();
        match &mut st.play.phase {
            Phase::Idle => return,
            Phase::Building { child, msgs, level, exe } => {
                let mut drain = |exe: &mut Option<PathBuf>| {
                    if let Ok(rx) = msgs.get_mut() {
                        while let Ok(m) = rx.try_recv() {
                            match m {
                                Msg::Diag(d) => diags.push(d),
                                Msg::Exe(p) => *exe = Some(p),
                            }
                        }
                    }
                };
                drain(exe);
                match child.try_wait() {
                    Ok(Some(status)) => {
                        // What the reader threads still hold.
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        drain(exe);
                        done = Some((Ok(status.success()), level.clone(), exe.clone()));
                    }
                    Ok(None) => {}
                    Err(e) => done = Some((Err(e.to_string()), level.clone(), None)),
                }
            }
            Phase::Running { child } => {
                exited = matches!(child.try_wait(), Ok(Some(_)) | Err(_));
            }
        }
        for d in diags {
            st.push_diag(d);
        }
    }
    if let Some((result, level, exe)) = done {
        world.resource_mut::<EditorState>().play.phase = Phase::Idle;
        match result {
            Ok(true) => {
                log(world, Level::Info, "play", "build finished".into());
                if let Err(e) = run_game(world, &level, exe) {
                    log(world, Level::Error, "play", e);
                }
            }
            Ok(false) => log(world, Level::Error, "play", "build failed: see the errors above".into()),
            Err(e) => log(world, Level::Error, "play", format!("build: {e}")),
        }
    }
    if exited {
        world.resource_mut::<EditorState>().play.phase = Phase::Idle;
        restore_winit(world);
        log(world, Level::Info, "play", "the game exited".into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendered_cargo_lines_carry_a_level_and_a_location() {
        let d = parse_line("error[E0425]: cannot find value `x` in this scope", Level::Info);
        assert_eq!(d.level, Level::Error);
        let loc = parse_line("  --> src/main.rs:12:5", d.level);
        assert_eq!((loc.file.as_deref(), loc.line, loc.col, loc.level), (Some("src/main.rs"), Some(12), Some(5), Level::Error));
        assert_eq!(parse_line("warning: unused variable", Level::Error).level, Level::Warn);
        assert_eq!(parse_line("    Finished `dev` profile in 3.2s", Level::Warn).level, Level::Warn);
        assert_eq!(parse_line("Finished `dev` profile", Level::Warn).level, Level::Info);
        // Windows paths keep their drive colon.
        assert_eq!(parse_line(r" --> C:\game\src\main.rs:3:9", Level::Error).line, Some(3));
    }

    #[test]
    fn finds_the_engine_examples_as_examples() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        assert_eq!(find_target(&manifest, "level_demo").map(|t| t.1), Ok("example"));
        assert!(find_target(&manifest, "no_such_target").is_err());
    }
}
