//! Play and Stop.
//!
//! **Play** (`EditorBackend::play`):
//! 1. writes the level to `<data dir>/play/editor_play.level.ron` (the open level file is not
//!    touched, and the editor's "open level" does not change);
//! 2. builds the game: `memgate -- cargo build --manifest-path <M> (--bin N | --example N)` (plain
//!    `cargo` when `memgate` is not installed), output streamed line by line into the Output panel
//!    (cargo's short message format, so errors carry `file:line:col`);
//! 3. starts `<this executable> --level <that file> --control 0` in its own process group, plus
//!    the metrics viewer (`ViewerLauncher`), and stops drawing the editor viewport (the scene
//!    camera goes inactive and winit goes reactive).
//!
//! **Stop** kills the game's process group.
//!
//! Where the game is found (`EditorConfig::manifest`, else in this order): env
//! `EDITOR_GAME_MANIFEST` (a `Cargo.toml` or its folder), the parent of
//! `GameInfo::assets_fallback` (games pass `concat!(env!("CARGO_MANIFEST_DIR"), "/assets")`), the
//! working folder and its parents, the executable's folders. The bin/example name is the
//! executable's file name; an executable under `target/<profile>/examples/` is an example, a
//! `release` folder builds `--release`. The built binary is the running executable's path, so
//! Play runs the freshly built game. `EditorConfig::play_features` (or env `EDITOR_PLAY_FEATURES`)
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

#[derive(Default)]
enum Phase {
    #[default]
    Idle,
    Building {
        child: Child,
        lines: std::sync::Mutex<Receiver<String>>,
        level: PathBuf,
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

fn build_command(world: &World, exe: &Path) -> Result<Command, String> {
    let manifest = manifest_dir(world).ok_or("cannot find the game's Cargo.toml: set EDITOR_GAME_MANIFEST or EditorConfig::manifest")?;
    let name = exe.file_stem().ok_or("bad executable path")?.to_string_lossy().to_string();
    let in_examples = exe.parent().and_then(|p| p.file_name()).is_some_and(|n| n == "examples");
    let release = exe.components().any(|c| c.as_os_str() == "release");
    let has_memgate = Command::new("memgate").arg("--help").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok();
    let mut cmd = if has_memgate {
        let mut c = Command::new("memgate");
        c.args(["--", "cargo"]);
        c
    } else {
        Command::new("cargo")
    };
    cmd.arg("build").arg("--manifest-path").arg(manifest.join("Cargo.toml")).arg("--message-format=short");
    cmd.arg(if in_examples { "--example" } else { "--bin" }).arg(&name);
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

/// `path:line:col: message` from cargo's short format.
fn parse_line(line: &str) -> Diagnostic {
    let lower = line.to_ascii_lowercase();
    let level = if lower.contains("error") {
        Level::Error
    } else if lower.contains("warning") {
        Level::Warn
    } else {
        Level::Info
    };
    let mut d = Diagnostic { level, source: "cargo".into(), message: line.to_string(), file: None, line: None, col: None };
    let mut parts = line.splitn(4, ':');
    if let (Some(f), Some(l), Some(c), Some(rest)) = (parts.next(), parts.next(), parts.next(), parts.next())
        && let (Ok(l), Ok(c)) = (l.trim().parse::<u32>(), c.trim().parse::<u32>())
        && (f.ends_with(".rs") || f.contains('/'))
    {
        d.file = Some(f.to_string());
        d.line = Some(l);
        d.col = Some(c);
        d.message = rest.trim().to_string();
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
        run_game(world, &level_path)?;
        return Ok(());
    }
    let mut cmd = build_command(world, &exe)?;
    log(world, Level::Info, "play", format!("building: {:?}", cmd));
    let mut child = cmd.spawn().map_err(|e| format!("cannot start the build: {e}"))?;
    let (tx, rx) = channel();
    for stream in [child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>)].into_iter().flatten() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }
    world.resource_mut::<EditorState>().play.phase = Phase::Building { child, lines: std::sync::Mutex::new(rx), level: level_path };
    Ok(())
}

fn run_game(world: &mut World, level: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current exe: {e}"))?;
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
    let mut lines = Vec::new();
    let mut done: Option<(Result<bool, String>, PathBuf)> = None;
    let mut exited = false;
    {
        let mut st = world.resource_mut::<EditorState>();
        match &mut st.play.phase {
            Phase::Idle => return,
            Phase::Building { child, lines: rx, level } => {
                if let Ok(rx) = rx.lock() {
                    while let Ok(l) = rx.try_recv() {
                        lines.push(l);
                    }
                }
                match child.try_wait() {
                    Ok(Some(status)) => {
                        // Drain what the reader threads still hold.
                        std::thread::sleep(std::time::Duration::from_millis(30));
                        if let Ok(rx) = rx.lock() {
                            while let Ok(l) = rx.try_recv() {
                                lines.push(l);
                            }
                        }
                        done = Some((Ok(status.success()), level.clone()));
                    }
                    Ok(None) => {}
                    Err(e) => done = Some((Err(e.to_string()), level.clone())),
                }
            }
            Phase::Running { child } => {
                exited = matches!(child.try_wait(), Ok(Some(_)) | Err(_));
            }
        }
        for l in lines.drain(..) {
            if !l.trim().is_empty() {
                st.push_diag(parse_line(&l));
            }
        }
    }
    if let Some((result, level)) = done {
        world.resource_mut::<EditorState>().play.phase = Phase::Idle;
        match result {
            Ok(true) => {
                log(world, Level::Info, "play", "build finished".into());
                if let Err(e) = run_game(world, &level) {
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
    fn cargo_short_lines_carry_a_location() {
        let d = parse_line("src/main.rs:12:5: error[E0425]: cannot find value `x` in this scope");
        assert_eq!((d.file.as_deref(), d.line, d.col), (Some("src/main.rs"), Some(12), Some(5)));
        assert_eq!(d.level, Level::Error);
        assert!(d.message.starts_with("error[E0425]"));
        let d = parse_line("    Finished `dev` profile in 3.2s");
        assert!(d.file.is_none());
    }
}
