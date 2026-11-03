//! World and project settings shown in the editor's settings tab and window.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::TypeSchema;

/// Which settings surface a group belongs to.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingsPage {
    /// The World Settings tab: how this level looks and streams (look, terrain, streaming).
    #[default]
    World,
    /// The Project Settings window: budgets and switches that belong to the whole game.
    Project,
}

/// One group of settings: a value plus the schema the property grid draws it with.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SettingsGroup {
    /// Stable id (`look`, `streaming`...), the key for `EditorBackend::set_settings`.
    pub id: String,
    pub label: String,
    pub page: SettingsPage,
    /// One line of help shown under the group title.
    #[serde(default)]
    pub hint: String,
    pub schema: TypeSchema,
    pub value: Value,
}
