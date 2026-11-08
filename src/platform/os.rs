//! OS services behind one small trait: open in the file browser, clipboard, notifications and
//! native file dialogs. No extra crates: each OS implementation shells out to what ships with
//! it (`open` / `pbcopy` / `osascript`; `explorer` / `clip` / PowerShell; `xdg-open` /
//! `wl-copy` or `xclip` / `notify-send` / `zenity`). macOS is the tested path, the others are
//! best effort. Swap the implementation with [`Platform::set`] (a crate-backed one such as
//! `arboard` or `rfd` is a drop-in), or use [`NullOs`] (headless, tests).
//!
//! Every call that can fail returns `Result<_, String>`; none block longer than the child
//! process, so call dialogs from a task or accept a frozen frame while they are open.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use bevy::prelude::*;

use super::dirs::OsKind;

/// A file dialog request.
#[derive(Clone, Debug, Default)]
pub struct DialogSpec {
    pub title: String,
    pub dir: Option<PathBuf>,
    /// Extensions without the dot (`["png", "jpg"]`); empty = any.
    pub extensions: Vec<String>,
    /// Save dialog: the suggested file name.
    pub file_name: Option<String>,
}

pub trait OsServices: Send + Sync + 'static {
    fn name(&self) -> &'static str;

    /// Show a folder (or reveal a file) in the OS file browser.
    fn open_path(&self, path: &Path) -> Result<(), String>;
    /// Open a URL or file with the default application.
    fn open_url(&self, url: &str) -> Result<(), String>;
    fn clipboard_get(&self) -> Result<String, String>;
    fn clipboard_set(&self, text: &str) -> Result<(), String>;
    /// A desktop notification (best effort).
    fn notify(&self, title: &str, body: &str) -> Result<(), String>;
    /// `Ok(None)` when the user cancels.
    fn pick_file(&self, spec: &DialogSpec) -> Result<Option<PathBuf>, String>;
    fn save_file(&self, spec: &DialogSpec) -> Result<Option<PathBuf>, String>;
}

/// The implementation for the OS this binary runs on.
pub fn native() -> Box<dyn OsServices> {
    Box::new(Native(OsKind::current()))
}

/// The active implementation. Replace it with [`Self::set`].
#[derive(Resource)]
pub struct Platform(pub Box<dyn OsServices>);

impl Platform {
    pub fn set(&mut self, os: impl OsServices) {
        self.0 = Box::new(os);
    }
}

impl std::ops::Deref for Platform {
    type Target = dyn OsServices;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

// ---------------------------------------------------------------- null

/// Does nothing; the clipboard is in memory. For headless runs and tests.
#[derive(Default)]
pub struct NullOs {
    clip: std::sync::Mutex<String>,
    pub log: std::sync::Mutex<Vec<String>>,
}

impl NullOs {
    fn note(&self, s: String) {
        self.log.lock().unwrap().push(s);
    }
}

impl OsServices for NullOs {
    fn name(&self) -> &'static str {
        "null"
    }
    fn open_path(&self, path: &Path) -> Result<(), String> {
        self.note(format!("open {}", path.display()));
        Ok(())
    }
    fn open_url(&self, url: &str) -> Result<(), String> {
        self.note(format!("url {url}"));
        Ok(())
    }
    fn clipboard_get(&self) -> Result<String, String> {
        Ok(self.clip.lock().unwrap().clone())
    }
    fn clipboard_set(&self, text: &str) -> Result<(), String> {
        *self.clip.lock().unwrap() = text.to_string();
        Ok(())
    }
    fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        self.note(format!("notify {title}: {body}"));
        Ok(())
    }
    fn pick_file(&self, _: &DialogSpec) -> Result<Option<PathBuf>, String> {
        Ok(None)
    }
    fn save_file(&self, _: &DialogSpec) -> Result<Option<PathBuf>, String> {
        Ok(None)
    }
}

// ---------------------------------------------------------------- native

struct Native(OsKind);

fn run(cmd: &mut Command) -> Result<String, String> {
    let out = cmd.stdin(Stdio::null()).output().map_err(|e| format!("{:?}: {e}", cmd.get_program()))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end_matches(['\n', '\r']).to_string())
    } else {
        Err(format!("{:?} failed: {}", cmd.get_program(), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

fn spawn(cmd: &mut Command) -> Result<(), String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map(|_| ()).map_err(|e| format!("{:?}: {e}", cmd.get_program()))
}

fn pipe_to(cmd: &mut Command, text: &str) -> Result<(), String> {
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| format!("{:?}: {e}", cmd.get_program()))?;
    child.stdin.take().ok_or("no stdin")?.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    let st = child.wait().map_err(|e| e.to_string())?;
    if st.success() { Ok(()) } else { Err(format!("{:?} failed", cmd.get_program())) }
}

/// AppleScript string literal.
fn osa(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

impl OsServices for Native {
    fn name(&self) -> &'static str {
        match self.0 {
            OsKind::MacOs => "macos",
            OsKind::Windows => "windows",
            OsKind::Linux => "linux",
        }
    }

    fn open_path(&self, path: &Path) -> Result<(), String> {
        match self.0 {
            OsKind::MacOs if path.is_file() => spawn(Command::new("open").arg("-R").arg(path)),
            OsKind::MacOs => spawn(Command::new("open").arg(path)),
            OsKind::Windows if path.is_file() => spawn(Command::new("explorer").arg(format!("/select,{}", path.display()))),
            OsKind::Windows => spawn(Command::new("explorer").arg(path)),
            OsKind::Linux => spawn(Command::new("xdg-open").arg(if path.is_file() { path.parent().unwrap_or(path) } else { path })),
        }
    }

    fn open_url(&self, url: &str) -> Result<(), String> {
        match self.0 {
            OsKind::MacOs => spawn(Command::new("open").arg(url)),
            OsKind::Windows => spawn(Command::new("cmd").args(["/c", "start", "", url])),
            OsKind::Linux => spawn(Command::new("xdg-open").arg(url)),
        }
    }

    fn clipboard_get(&self) -> Result<String, String> {
        match self.0 {
            OsKind::MacOs => run(&mut Command::new("pbpaste")),
            OsKind::Windows => run(Command::new("powershell").args(["-NoProfile", "-Command", "Get-Clipboard"])),
            OsKind::Linux => run(Command::new("wl-paste").arg("-n")).or_else(|_| run(Command::new("xclip").args(["-selection", "clipboard", "-o"]))),
        }
    }

    fn clipboard_set(&self, text: &str) -> Result<(), String> {
        match self.0 {
            OsKind::MacOs => pipe_to(&mut Command::new("pbcopy"), text),
            OsKind::Windows => pipe_to(&mut Command::new("clip"), text),
            OsKind::Linux => pipe_to(&mut Command::new("wl-copy"), text).or_else(|_| pipe_to(Command::new("xclip").args(["-selection", "clipboard"]), text)),
        }
    }

    fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        match self.0 {
            OsKind::MacOs => spawn(Command::new("osascript").args(["-e", &format!("display notification {} with title {}", osa(body), osa(title))])),
            OsKind::Windows => {
                let ps = format!(
                    "Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(4000, '{}', '{}', 'Info')",
                    title.replace('\'', "''"),
                    body.replace('\'', "''")
                );
                spawn(Command::new("powershell").args(["-NoProfile", "-Command", &ps]))
            }
            OsKind::Linux => spawn(Command::new("notify-send").arg(title).arg(body)),
        }
    }

    fn pick_file(&self, spec: &DialogSpec) -> Result<Option<PathBuf>, String> {
        let title = if spec.title.is_empty() { "Open" } else { &spec.title };
        let out = match self.0 {
            OsKind::MacOs => {
                let mut s = format!("POSIX path of (choose file with prompt {}", osa(title));
                if let Some(d) = &spec.dir {
                    s += &format!(" default location (POSIX file {})", osa(&d.display().to_string()));
                }
                if !spec.extensions.is_empty() {
                    s += &format!(" of type {{{}}}", spec.extensions.iter().map(|e| osa(e)).collect::<Vec<_>>().join(", "));
                }
                run(Command::new("osascript").args(["-e", &(s + ")")]))
            }
            OsKind::Windows => run(Command::new("powershell").args([
                "-NoProfile",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; if ($d.ShowDialog() -eq 'OK') { $d.FileName }",
            ])),
            OsKind::Linux => {
                let mut c = Command::new("zenity");
                c.args(["--file-selection", "--title", title]);
                for e in &spec.extensions {
                    c.arg(format!("--file-filter=*.{e}"));
                }
                run(&mut c)
            }
        };
        cancelled(out)
    }

    fn save_file(&self, spec: &DialogSpec) -> Result<Option<PathBuf>, String> {
        let title = if spec.title.is_empty() { "Save" } else { &spec.title };
        let name = spec.file_name.clone().unwrap_or_default();
        let out = match self.0 {
            OsKind::MacOs => {
                let mut s = format!("POSIX path of (choose file name with prompt {} default name {}", osa(title), osa(&name));
                if let Some(d) = &spec.dir {
                    s += &format!(" default location (POSIX file {})", osa(&d.display().to_string()));
                }
                run(Command::new("osascript").args(["-e", &(s + ")")]))
            }
            OsKind::Windows => run(Command::new("powershell").args([
                "-NoProfile",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.SaveFileDialog; if ($d.ShowDialog() -eq 'OK') { $d.FileName }",
            ])),
            OsKind::Linux => run(Command::new("zenity").args(["--file-selection", "--save", "--confirm-overwrite", "--title", title, "--filename", &name])),
        };
        cancelled(out)
    }
}

/// A cancelled dialog exits non-zero or prints nothing: both are `Ok(None)`.
fn cancelled(out: Result<String, String>) -> Result<Option<PathBuf>, String> {
    match out {
        Ok(s) if s.trim().is_empty() => Ok(None),
        Ok(s) => Ok(Some(PathBuf::from(s.trim()))),
        Err(e) if e.contains("User canceled") || e.contains("failed:") && e.contains("-128") => Ok(None),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_os_keeps_a_clipboard_and_a_log() {
        let os = NullOs::default();
        os.clipboard_set("hello").unwrap();
        assert_eq!(os.clipboard_get().unwrap(), "hello");
        os.notify("t", "b").unwrap();
        os.open_path(Path::new("/x")).unwrap();
        assert_eq!(*os.log.lock().unwrap(), vec!["notify t: b".to_string(), "open /x".to_string()]);
        assert_eq!(os.pick_file(&DialogSpec::default()).unwrap(), None);
    }

    #[test]
    fn applescript_literals_escape() {
        assert_eq!(osa(r#"a "b" \c"#), r#""a \"b\" \\c""#);
        assert_eq!(cancelled(Ok("".into())), Ok(None));
        assert_eq!(cancelled(Ok("/a/b\n".into())), Ok(Some(PathBuf::from("/a/b"))));
    }
}
