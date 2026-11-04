//! The editor UI over an in-memory backend, in a plain eframe window: the "standalone later"
//! proof that `editor-ui` needs nothing from Bevy.
//!
//! `cargo run -p editor-ui --example mock_editor`
//! `cargo run -p editor-ui --example mock_editor -- --shot out.png` renders one frame headless.

use editor_ui::{EditorUi, mock::MockBackend};

struct App {
    ui: EditorUi,
    backend: MockBackend,
}

/// Stand-in for the 3D view: a perspective-ish grid in the viewport rect.
fn paint_viewport(ctx: &egui::Context, rect: egui::Rect) {
    let p = ctx.layer_painter(egui::LayerId::background()).with_clip_rect(rect);
    p.rect_filled(rect, 0.0, egui::Color32::from_rgb(34, 38, 46));
    let horizon = rect.top() + rect.height() * 0.38;
    p.rect_filled(
        egui::Rect::from_min_max(rect.min, egui::pos2(rect.right(), horizon)),
        0.0,
        egui::Color32::from_rgb(52, 62, 80),
    );
    let stroke = egui::Stroke::new(1.0, egui::Color32::from_rgb(70, 78, 92));
    for i in -12..=12 {
        let x = rect.center().x + i as f32 * rect.width() * 0.09;
        p.line_segment(
            [
                egui::pos2(rect.center().x + i as f32 * 8.0, horizon),
                egui::pos2(x * 1.0 + (x - rect.center().x) * 2.0, rect.bottom()),
            ],
            stroke,
        );
    }
    for k in 1..9 {
        let y = horizon + (rect.bottom() - horizon) * (k as f32 / 9.0).powf(2.0);
        p.line_segment([egui::pos2(rect.left(), y), egui::pos2(rect.right(), y)], stroke);
    }
    p.text(
        rect.center_top() + egui::vec2(0.0, 14.0),
        egui::Align2::CENTER_TOP,
        "3D viewport (host draws here)",
        egui::FontId::proportional(12.0),
        egui::Color32::from_gray(150),
    );
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        let out = self.ui.show(&ctx, &mut self.backend);
        if let Some(r) = out.viewport {
            paint_viewport(&ctx, r);
        }
    }
}

fn main() -> eframe::Result {
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--shot") {
        let path = args.get(i + 1).cloned().unwrap_or_else(|| "mock_editor.png".into());
        return shot(&path, args.get(i + 2).map(String::as_str));
    }
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_inner_size([1400.0, 860.0]).with_title("editor-ui mock"),
        ..Default::default()
    };
    eframe::run_native(
        "editor-ui mock",
        options,
        Box::new(|_cc| {
            Ok(Box::new(App {
                ui: EditorUi::new(),
                backend: MockBackend::demo(),
            }))
        }),
    )
}

/// Headless frame via egui_kittest's wgpu renderer.
fn shot(path: &str, tab: Option<&str>) -> eframe::Result {
    use egui_kittest::Harness;
    use egui_kittest::kittest::Queryable;
    // SHOT_SIZE=1280x720 picks the window size.
    let (w, hgt) = std::env::var("SHOT_SIZE").ok().and_then(|s| s.split_once('x').and_then(|(a, b)| Some((a.parse().ok()?, b.parse().ok()?)))).unwrap_or((1400.0_f32, 860.0_f32));
    let mut h = Harness::builder().with_size(egui::vec2(w, hgt)).with_max_steps(30).wgpu().build_ui_state(
        |ui, app: &mut App| {
            let ctx = ui.ctx().clone();
            let out = app.ui.show(&ctx, &mut app.backend);
            if let Some(r) = out.viewport {
                paint_viewport(&ctx, r);
            }
        },
        App {
            ui: EditorUi::new(),
            backend: MockBackend::demo(),
        },
    );
    h.run_steps(3);
    h.get_by_label("Crate").click();
    h.run_steps(4);
    for step in tab.into_iter().flat_map(|t| t.split(',')) {
        match step {
            "help" => h.key_press(egui::Key::F1),
            // layout:logic, win:preferences, panel:output, tab:logic/door.logic.ron, drawer:open|dock
            s if s.starts_with("layout:") => {
                let _ = h.state_mut().ui.apply_layout_name(&s[7..]);
            }
            s if s.starts_with("win:") => {
                let _ = h.state_mut().ui.set_window(&s[4..].replace('-', " "), true);
            }
            s if s.starts_with("panel:") => {
                let _ = h.state_mut().ui.show_panel(&s[6..].replace('-', " "));
            }
            s if s.starts_with("tab:") => h.state_mut().ui.open_logic_tab(&s[4..]),
            "drawer:open" => h.state_mut().ui.set_drawer_open(true),
            "drawer:dock" => h.state_mut().ui.dock_content_drawer(true),
            s if s.starts_with("menu:") => {
                h.get_by_label(&s[5..]).click();
                h.run_steps(3);
                continue;
            }
            s if s.starts_with("item:") => h.get_by_label_contains(&s[5..]).click(),
            s => h.get_all_by_label(s).next().expect("label").click(),
        }
        h.run_steps(4);
    }
    match h.render() {
        Ok(img) => {
            img.save(path).map_err(|e| eframe::Error::AppCreation(Box::new(e)))?;
            println!("wrote {path}");
            Ok(())
        }
        Err(e) => Err(eframe::Error::AppCreation(e.into())),
    }
}
