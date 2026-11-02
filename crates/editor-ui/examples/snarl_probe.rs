//! Renders an egui-snarl graph headless at several panel sizes to find out why it showed blank.
//! `cargo run -p editor-ui --features snarl --example snarl_probe -- <out-dir>`

use egui_kittest::Harness;
use egui_snarl::ui::{PinInfo, SnarlViewer, SnarlWidget};
use egui_snarl::{InPin, InPinId, OutPin, OutPinId, Snarl};

struct Viewer;
impl SnarlViewer<&'static str> for Viewer {
    fn title(&mut self, n: &&'static str) -> String {
        n.to_string()
    }
    fn inputs(&mut self, n: &&'static str) -> usize {
        usize::from(*n != "Time")
    }
    fn outputs(&mut self, n: &&'static str) -> usize {
        usize::from(*n != "Spin")
    }
    fn show_input(&mut self, _: &InPin, ui: &mut egui::Ui, _: &mut Snarl<&'static str>) -> impl egui_snarl::ui::SnarlPin + 'static {
        ui.label("in");
        PinInfo::circle()
    }
    fn show_output(&mut self, _: &OutPin, ui: &mut egui::Ui, _: &mut Snarl<&'static str>) -> impl egui_snarl::ui::SnarlPin + 'static {
        ui.label("out");
        PinInfo::circle()
    }
}

fn graph() -> Snarl<&'static str> {
    let mut g = Snarl::new();
    let t = g.insert_node(egui::pos2(10.0, 20.0), "Time");
    let m = g.insert_node(egui::pos2(140.0, 20.0), "Multiply");
    let s = g.insert_node(egui::pos2(280.0, 20.0), "Spin");
    g.connect(OutPinId { node: t, output: 0 }, InPinId { node: m, input: 0 });
    g.connect(OutPinId { node: m, output: 0 }, InPinId { node: s, input: 0 });
    g
}

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    for (name, size, wrapper, ppp) in [
        ("full", egui::vec2(700.0, 400.0), 0, 1.0),
        ("short", egui::vec2(700.0, 170.0), 0, 1.0),
        ("in_panel", egui::vec2(700.0, 400.0), 1, 1.0),
        ("retina_short", egui::vec2(700.0, 170.0), 0, 2.0),
    ] {
        let mut h = Harness::builder().with_size(size).with_pixels_per_point(ppp).wgpu().build_ui_state(
            move |ui, g: &mut Snarl<&'static str>| {
                if wrapper == 1 {
                    egui::Frame::new().fill(egui::Color32::from_gray(30)).show(ui, |ui| {
                        SnarlWidget::new().id(egui::Id::new("graph")).show(g, &mut Viewer, ui);
                    });
                } else {
                    SnarlWidget::new().id(egui::Id::new("graph")).show(g, &mut Viewer, ui);
                }
            },
            graph(),
        );
        h.run_steps(5);
        match h.render() {
            Ok(img) => {
                let p = format!("{dir}/snarl_{name}.png");
                let _ = img.save(&p);
                println!("wrote {p}");
            }
            Err(e) => println!("{name}: {e}"),
        }
    }
}
