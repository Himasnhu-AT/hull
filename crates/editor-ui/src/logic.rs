//! Logic panel: the node graph canvas. Today a 3-node demo graph (egui-snarl, feature `snarl`);
//! the real graph model comes with the logic runtime (docs/EDITOR.md, "Logic graphs").

#[cfg(not(feature = "snarl"))]
use ashlar_ui::tokens;
use egui::Ui;

#[cfg(feature = "snarl")]
mod graph {
    use egui_snarl::ui::{PinInfo, SnarlViewer, SnarlWidget};
    use egui_snarl::{InPin, InPinId, OutPin, OutPinId, Snarl};

    pub struct Demo {
        graph: Snarl<&'static str>,
    }

    impl Default for Demo {
        fn default() -> Self {
            let mut g = Snarl::new();
            let t = g.insert_node(egui::pos2(10.0, 20.0), "Time");
            let m = g.insert_node(egui::pos2(140.0, 20.0), "Multiply");
            let s = g.insert_node(egui::pos2(280.0, 20.0), "Spin");
            g.connect(OutPinId { node: t, output: 0 }, InPinId { node: m, input: 0 });
            g.connect(OutPinId { node: m, output: 0 }, InPinId { node: s, input: 0 });
            Demo { graph: g }
        }
    }

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

    impl Demo {
        pub fn show(&mut self, ui: &mut egui::Ui) {
            SnarlWidget::new().id(egui::Id::new("editor.logic.graph")).show(&mut self.graph, &mut Viewer, ui);
        }
    }
}

#[derive(Default)]
pub(crate) struct LogicState {
    #[cfg(feature = "snarl")]
    demo: graph::Demo,
}

pub(crate) fn show(ui: &mut Ui, st: &mut LogicState) {
    #[cfg(feature = "snarl")]
    {
        st.demo.show(ui);
    }
    #[cfg(not(feature = "snarl"))]
    {
        let _ = st;
        let t = tokens::current(ui.ctx());
        ui.add_space(t.space.md);
        ui.label(egui::RichText::new("Logic graphs").color(t.text.primary).strong());
        ui.label(egui::RichText::new("The node graph editor comes with the logic runtime.").color(t.text.secondary));
    }
}
