//! Tool settings: the active tool's settings drawn with the same property grid as Details. Tools
//! are generic ids + schemas from the backend; nothing here knows what a brush is. The Modes
//! panel (`modes.rs`) hosts this.

use editor_proto::{ToolDoc, TypeSchema};

use crate::model::Req;
use crate::props::{self, Cx, Phase};

/// The settings of `tool` as a property grid. Fields named in `hide` are drawn elsewhere (the
/// Place mode shows its `type_path` as a dropdown).
pub(crate) fn settings(ui: &mut egui::Ui, tool: &ToolDoc, hide: &[&str], reqs: &mut Vec<Req>) {
    let mut working = tool.settings.clone();
    let schema = match &tool.schema {
        TypeSchema::Struct { fields } => TypeSchema::Struct { fields: fields.iter().filter(|(n, _)| !hide.contains(&n.as_str())).cloned().collect() },
        other => other.clone(),
    };
    let mut cx = Cx::new(format!("tool.{}", tool.id), false);
    props::component_body(ui, &mut cx, &schema, &mut working);
    if let Some(change) = cx.change
        && change.phase != Phase::Begin
        && working != tool.settings
    {
        reqs.push(Req::ToolSettings { id: tool.id.clone(), settings: working });
    }
}
