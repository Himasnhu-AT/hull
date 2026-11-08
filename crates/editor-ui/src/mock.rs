//! An in-memory [`EditorBackend`] for tests, examples and the standalone editor proof. Entities
//! hold components as JSON; `apply` implements every [`Op`] exactly, so undo is checkable.

use std::collections::BTreeMap;

use editor_proto::*;
use serde_json::{Value, json};

#[derive(Clone, Debug)]
struct Ent {
    stable: StableId,
    name: String,
    parent: Option<EntityId>,
    generated: bool,
    kind: NodeKind,
    components: BTreeMap<String, Value>,
}

pub struct MockBackend {
    ents: BTreeMap<EntityId, Ent>,
    order: Vec<EntityId>,
    next_id: EntityId,
    selection: Vec<EntityId>,
    pub schemas: BTreeMap<String, TypeSchema>,
    pub applied: Vec<Op>,
    pub viewport_cmds: Vec<ViewportCmd>,
    pub level: LevelInfo,
    pub play: PlayState,
    pub saved: Vec<Option<String>>,
    pub opened: Vec<String>,
    pub placed: Vec<String>,
    pub diag: Vec<Diagnostic>,
    pub assets: Vec<(String, Vec<AssetEntry>)>,
    /// Tools the mock offers (`tools()`), the active one, and what the engine recorded on its own.
    pub tool_docs: Vec<ToolDoc>,
    pub active: Option<String>,
    pub recorded: Vec<RecordedOp>,
    pub placeable_docs: Vec<PlaceableDoc>,
    /// Logic graph files the mock lists, and the `(name, template)` pairs created.
    pub logic_files: Vec<LogicFile>,
    pub logic_created: Vec<(String, String)>,
    /// `Default::default()` per component type (reset arrows).
    pub defaults: BTreeMap<String, Value>,
    /// Settings groups the mock offers (`settings()`); `set_settings` merges into `value`.
    pub settings_groups: Vec<SettingsGroup>,
    /// Node script sources by asset path (`scripts/x.ruspy`), and stubs `script_add_stub` appended.
    pub script_files: BTreeMap<String, String>,
    pub stubs: Vec<(EntityId, String, Vec<String>)>,
    /// Built-in signals per entity (`pressed` for a button ...).
    pub signal_hints: BTreeMap<EntityId, Vec<String>>,
}

pub const TRANSFORM: &str = "bevy_transform::components::transform::Transform";
pub const LIGHT: &str = "bevy_light::PointLight";
pub const HEALTH: &str = "game::Health";
pub const LOGIC: &str = "engine::logic::Logic";
pub const SCRIPT: &str = "engine::scripting::Script";
pub const SCRIPT_PROPS: &str = "engine::scripting::ScriptProps";
pub const GROUPS: &str = "engine::scripting::Groups";
pub const CONNECTIONS: &str = "engine::scripting::Connections";

fn transform_schema() -> TypeSchema {
    TypeSchema::Struct {
        fields: vec![
            ("translation".into(), TypeSchema::Vec3),
            ("rotation".into(), TypeSchema::Quat),
            ("scale".into(), TypeSchema::Vec3),
        ],
    }
}

fn transform(x: f64, y: f64, z: f64) -> Value {
    json!({"translation": [x, y, z], "rotation": [0.0, 0.0, 0.0, 1.0], "scale": [1.0, 1.0, 1.0]})
}

impl MockBackend {
    pub fn empty() -> Self {
        let mut schemas = BTreeMap::new();
        schemas.insert(TRANSFORM.to_owned(), transform_schema());
        schemas.insert(
            LIGHT.to_owned(),
            TypeSchema::Struct {
                fields: vec![
                    ("color".into(), TypeSchema::Color),
                    (
                        "intensity".into(),
                        TypeSchema::Float {
                            min: Some(0.0),
                            max: Some(100000.0),
                            step: Some(10.0),
                        },
                    ),
                    (
                        "range".into(),
                        TypeSchema::Float {
                            min: Some(0.0),
                            max: None,
                            step: None,
                        },
                    ),
                    ("shadows".into(), TypeSchema::Bool),
                ],
            },
        );
        schemas.insert(
            HEALTH.to_owned(),
            TypeSchema::Struct {
                fields: vec![
                    ("max".into(), TypeSchema::Int { min: Some(1), max: Some(1000) }),
                    ("label".into(), TypeSchema::String),
                    ("mesh".into(), TypeSchema::AssetPath { kind: "mesh".into() }),
                    (
                        "mode".into(),
                        TypeSchema::Enum {
                            variants: vec![
                                ("Normal".into(), None),
                                (
                                    "Armored".into(),
                                    Some(TypeSchema::Float {
                                        min: Some(0.0),
                                        max: Some(1.0),
                                        step: None,
                                    }),
                                ),
                            ],
                        },
                    ),
                    ("tags".into(), TypeSchema::List(Box::new(TypeSchema::String))),
                ],
            },
        );
        schemas.insert(LOGIC.to_owned(), TypeSchema::Struct { fields: vec![("graph".into(), TypeSchema::String)] });
        let mut defaults = BTreeMap::new();
        defaults.insert(TRANSFORM.to_owned(), transform(0.0, 0.0, 0.0));
        defaults.insert(HEALTH.to_owned(), json!({"max": 10, "label": "", "mesh": "", "mode": "Normal", "tags": []}));
        defaults.insert(LOGIC.to_owned(), json!({"graph": ""}));
        MockBackend {
            logic_files: Vec::new(),
            logic_created: Vec::new(),
            defaults,
            ents: BTreeMap::new(),
            order: Vec::new(),
            next_id: 1,
            selection: Vec::new(),
            schemas,
            applied: Vec::new(),
            viewport_cmds: Vec::new(),
            level: LevelInfo {
                path: Some("levels/demo.level.ron".into()),
                dirty: false,
            },
            play: PlayState::Editing,
            saved: Vec::new(),
            opened: Vec::new(),
            placed: Vec::new(),
            diag: Vec::new(),
            assets: Vec::new(),
            tool_docs: Vec::new(),
            active: None,
            recorded: Vec::new(),
            placeable_docs: Vec::new(),
            settings_groups: Vec::new(),
            script_files: BTreeMap::new(),
            stubs: Vec::new(),
            signal_hints: BTreeMap::new(),
        }
    }

    /// Registers the scripting components (`Script`, `ScriptProps`, `Groups`, `Connections`) so
    /// the Details Script section can attach and edit them.
    pub fn with_scripting(mut self) -> Self {
        let s = |fields: Vec<(&str, TypeSchema)>| TypeSchema::Struct { fields: fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect() };
        self.schemas.insert(SCRIPT.into(), s(vec![("path", TypeSchema::String), ("priority", TypeSchema::Int { min: None, max: None })]));
        self.schemas.insert(SCRIPT_PROPS.into(), s(vec![("values", TypeSchema::List(Box::new(s(vec![("name", TypeSchema::String), ("value", TypeSchema::String)]))))]));
        self.schemas.insert(GROUPS.into(), TypeSchema::List(Box::new(TypeSchema::String)));
        self.schemas.insert(
            CONNECTIONS.into(),
            TypeSchema::List(Box::new(s(vec![
                ("signal", TypeSchema::String),
                ("target", TypeSchema::String),
                ("method", TypeSchema::String),
                ("binds", TypeSchema::List(Box::new(TypeSchema::String))),
                ("deferred", TypeSchema::Bool),
                ("one_shot", TypeSchema::Bool),
            ]))),
        );
        self
    }

    fn chain(&self, mut id: EntityId) -> Vec<EntityId> {
        let mut v = vec![id];
        while let Some(p) = self.ents.get(&id).and_then(|e| e.parent) {
            v.push(p);
            id = p;
        }
        v.reverse();
        v
    }

    fn rel_path(&self, from: EntityId, to: EntityId) -> Result<String, String> {
        let (a, b) = (self.chain(from), self.chain(to));
        let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
        let name = |i: &EntityId| self.ents.get(i).map(|e| e.name.clone()).ok_or_else(|| format!("no entity {i}"));
        if common == 0 {
            let n: Result<Vec<_>, _> = b.iter().map(name).collect();
            return Ok(format!("/{}", n?.join("/")));
        }
        let mut parts: Vec<String> = vec!["..".into(); a.len() - common];
        for i in &b[common..] {
            parts.push(name(i)?);
        }
        Ok(if parts.is_empty() { ".".into() } else { parts.join("/") })
    }

    fn resolve_rel(&self, from: EntityId, path: &str) -> Option<EntityId> {
        let mut cur = from;
        if let Some(rest) = path.strip_prefix('/') {
            let mut it = rest.split('/');
            cur = *self.ents.iter().find(|(_, e)| e.parent.is_none() && Some(e.name.as_str()) == it.next()).map(|(i, _)| i)?;
            for seg in it {
                cur = *self.ents.iter().find(|(_, e)| e.parent == Some(cur) && e.name == seg).map(|(i, _)| i)?;
            }
            return Some(cur);
        }
        for seg in path.split('/') {
            match seg {
                "" | "." => {}
                ".." => cur = self.ents.get(&cur)?.parent?,
                n => cur = *self.ents.iter().find(|(_, e)| e.parent == Some(cur) && e.name == n).map(|(i, _)| i)?,
            }
        }
        Some(cur)
    }

    fn script_path_of(&self, id: EntityId) -> String {
        self.component(id, SCRIPT).and_then(|v| v.get("path")).and_then(Value::as_str).unwrap_or("").to_owned()
    }

    fn script_src(&self, path: &str) -> Option<&String> {
        self.script_files.get(&if path.contains('/') { path.to_owned() } else { format!("scripts/{path}") })
    }

    /// A small level: Sun, Ground, a Crate with a child, a generated Skybox.
    pub fn demo() -> Self {
        let mut m = MockBackend::empty();
        let sun = m.add(
            "Sun",
            None,
            NodeKind::Light,
            false,
            vec![
                (TRANSFORM, transform(0.0, 10.0, 0.0)),
                (LIGHT, json!({"color": [1.0, 0.95, 0.8, 1.0], "intensity": 8000.0, "range": 20.0, "shadows": true})),
            ],
        );
        let _ = sun;
        m.add("Ground", None, NodeKind::Mesh, false, vec![(TRANSFORM, transform(0.0, 0.0, 0.0))]);
        let cr = m.add(
            "Crate",
            None,
            NodeKind::Mesh,
            false,
            vec![
                (TRANSFORM, transform(2.0, 0.5, -1.0)),
                (
                    HEALTH,
                    json!({"max": 100, "label": "Crate", "mesh": "library/props/crate.glb", "mode": "Normal", "tags": ["wood", "breakable"]}),
                ),
            ],
        );
        m.add("Lid", Some(cr), NodeKind::Mesh, false, vec![(TRANSFORM, transform(0.0, 0.5, 0.0))]);
        m.add("Player", None, NodeKind::Camera, false, vec![(TRANSFORM, transform(0.0, 1.7, 5.0))]);
        m.add("Skybox", None, NodeKind::Generated, true, vec![(TRANSFORM, transform(0.0, 0.0, 0.0))]);
        m.placeable_docs = vec![
            PlaceableDoc { name: "Event marker".into(), icon: "flag".into(), category: "Gameplay".into(), type_path: "game::EventMarker".into() },
            PlaceableDoc { name: "Start line".into(), icon: "flag".into(), category: "Gameplay".into(), type_path: "game::StartLine".into() },
            PlaceableDoc { name: "Point light".into(), icon: "light".into(), category: "Lights".into(), type_path: "game::PointLight".into() },
        ];
        let fl = |min: f64, max: f64| TypeSchema::Float { min: Some(min), max: Some(max), step: None };
        m.settings_groups = vec![
            SettingsGroup {
                id: "look".into(),
                label: "Look".into(),
                page: SettingsPage::World,
                hint: "Sun and sky.".into(),
                schema: TypeSchema::Struct { fields: vec![("sun".into(), TypeSchema::Struct { fields: vec![("elevation_deg".into(), fl(-20.0, 90.0))] })] },
                value: json!({"sun": {"elevation_deg": 45.0}}),
            },
            SettingsGroup {
                id: "scatter".into(),
                label: "Foliage and scatter".into(),
                page: SettingsPage::Project,
                hint: String::new(),
                schema: TypeSchema::Struct { fields: vec![("distance_scale".into(), fl(0.0, 8.0))] },
                value: json!({"distance_scale": 1.0}),
            },
        ];
        m.assets = vec![
            (
                String::new(),
                vec![
                    asset("library", AssetKind::Folder, None),
                    asset("levels", AssetKind::Folder, None),
                    asset("hero.glb", AssetKind::Model, None),
                ],
            ),
            (
                "library".into(),
                vec![
                    asset("library/cars", AssetKind::Folder, None),
                    asset("library/crate.glb", AssetKind::Model, Some("CC0-1.0")),
                    asset("library/engine.ogg", AssetKind::Audio, None),
                    asset("library/rock.glb", AssetKind::Model, Some("CC-BY-4.0")),
                    asset("library/ue_tree.glb", AssetKind::Model, Some("ue-only")),
                ],
            ),
            ("library/cars".into(), vec![asset("library/cars/sedan.glb", AssetKind::Model, Some("CC0-1.0"))]),
        ];
        m.diag = vec![
            Diagnostic::new(Level::Info, "engine", "level loaded"),
            Diagnostic::new(Level::Warn, "assets", "missing texture, using fallback").at("assets/props/crate.glb", None, None),
            Diagnostic::new(Level::Error, "ruspy", "unexpected token ')'").at("scripts/door.ruspy", Some(12), Some(8)),
        ];
        m
    }

    pub fn add(&mut self, name: &str, parent: Option<EntityId>, kind: NodeKind, generated: bool, comps: Vec<(&str, Value)>) -> EntityId {
        let id = self.next_id;
        self.next_id += 1;
        self.ents.insert(
            id,
            Ent {
                stable: StableId(100 + id),
                name: name.into(),
                parent,
                generated,
                kind,
                components: comps.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
            },
        );
        self.order.push(id);
        id
    }

    pub fn id_of(&self, name: &str) -> Option<EntityId> {
        self.ents.iter().find(|(_, e)| e.name == name).map(|(i, _)| *i)
    }
    pub fn component(&self, id: EntityId, ty: &str) -> Option<&Value> {
        self.ents.get(&id)?.components.get(ty)
    }
    pub fn name_of(&self, id: EntityId) -> Option<&str> {
        self.ents.get(&id).map(|e| e.name.as_str())
    }
    pub fn parent_of(&self, id: EntityId) -> Option<EntityId> {
        self.ents.get(&id)?.parent
    }
    pub fn exists(&self, id: EntityId) -> bool {
        self.ents.contains_key(&id)
    }
    pub fn len(&self) -> usize {
        self.ents.len()
    }
    pub fn is_empty(&self) -> bool {
        self.ents.is_empty()
    }

    fn resolve(&self, r: StableOrId) -> Result<EntityId, String> {
        match r {
            StableOrId::Id(i) if self.ents.contains_key(&i) => Ok(i),
            StableOrId::Stable(s) => self
                .ents
                .iter()
                .find(|(_, e)| e.stable == s)
                .map(|(i, _)| *i)
                .ok_or_else(|| format!("no entity with stable id {}", s.0)),
            StableOrId::Id(i) => Err(format!("no entity {i}")),
        }
    }

    fn node(&self, id: EntityId, f: &TreeFilter) -> Option<TreeNode> {
        let e = self.ents.get(&id)?;
        if (e.generated && !f.include_generated) || !f.include_hidden && false {
            return None;
        }
        let children: Vec<TreeNode> = self
            .order
            .iter()
            .filter(|c| self.ents.get(c).is_some_and(|x| x.parent == Some(id)))
            .filter_map(|c| self.node(*c, f))
            .collect();
        let matches = f.text.is_empty() || e.name.to_lowercase().contains(&f.text.to_lowercase());
        if !matches && children.is_empty() {
            return None;
        }
        Some(TreeNode {
            id,
            stable: Some(e.stable),
            name: e.name.clone(),
            icon: e.kind,
            children,
            generated: e.generated,
            hidden: false,
            origin: e.generated.then(|| "mock".to_string()),
            pickable: true,
        })
    }

    fn snapshot_of(&self, id: EntityId) -> Result<EntitySnapshot, String> {
        let e = self.ents.get(&id).ok_or_else(|| format!("no entity {id}"))?;
        let parent = e.parent.and_then(|p| self.ents.get(&p)).map(|p| p.stable);
        let children = self
            .order
            .iter()
            .filter(|c| self.ents.get(c).is_some_and(|x| x.parent == Some(id)))
            .map(|c| self.snapshot_of(*c))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(EntitySnapshot {
            stable: e.stable,
            name: e.name.clone(),
            parent,
            components: e.components.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            children,
        })
    }

    fn spawn(&mut self, s: &EntitySnapshot, parent: Option<EntityId>) -> EntityId {
        let id = self.next_id;
        self.next_id += 1;
        self.ents.insert(
            id,
            Ent {
                stable: s.stable,
                name: s.name.clone(),
                parent,
                generated: false,
                kind: NodeKind::Mesh,
                components: s.components.iter().cloned().collect(),
            },
        );
        self.order.push(id);
        for c in &s.children {
            self.spawn(c, Some(id));
        }
        id
    }

    fn despawn(&mut self, id: EntityId) {
        let kids: Vec<EntityId> = self.ents.iter().filter(|(_, e)| e.parent == Some(id)).map(|(i, _)| *i).collect();
        for k in kids {
            self.despawn(k);
        }
        self.ents.remove(&id);
        self.order.retain(|i| *i != id);
        self.selection.retain(|i| *i != id);
    }

    fn apply_inner(&mut self, op: &Op) -> Result<(), String> {
        match op {
            // The mock has no terrain: the op is just recorded.
            Op::TerrainPatch { .. } => {}
            Op::SetComponent { entity, type_path, before, after } => {
                let id = self.resolve(*entity)?;
                let e = self.ents.get_mut(&id).ok_or("gone")?;
                if e.generated {
                    return Err("generated entities are read-only".into());
                }
                if e.components.get(type_path) != before.as_ref() {
                    return Err(format!("stale edit of {type_path}: component is not at its expected value"));
                }
                match after {
                    Some(v) => {
                        e.components.insert(type_path.clone(), v.clone());
                    }
                    None => {
                        e.components.remove(type_path);
                    }
                }
            }
            Op::Spawn { snapshot } => {
                if self.ents.values().any(|e| e.stable == snapshot.stable) {
                    return Err("entity already exists".into());
                }
                let parent = snapshot.parent.and_then(|p| self.ents.iter().find(|(_, e)| e.stable == p).map(|(i, _)| *i));
                let id = self.spawn(snapshot, parent);
                self.selection = vec![id];
            }
            Op::Despawn { snapshot } => {
                let id = self.resolve(StableOrId::Stable(snapshot.stable))?;
                self.despawn(id);
            }
            Op::Reparent { entity, after, .. } => {
                let id = self.resolve(*entity)?;
                let np = after.map(|a| self.resolve(a)).transpose()?;
                let mut cur = np;
                while let Some(c) = cur {
                    if c == id {
                        return Err("cannot parent an entity under itself".into());
                    }
                    cur = self.ents.get(&c).and_then(|e| e.parent);
                }
                self.ents.get_mut(&id).ok_or("gone")?.parent = np;
            }
            Op::Rename { entity, after, .. } => {
                let id = self.resolve(*entity)?;
                self.ents.get_mut(&id).ok_or("gone")?.name = after.clone();
            }
            Op::Batch(ops) => {
                for o in ops {
                    self.apply_inner(o)?;
                }
            }
        }
        Ok(())
    }
}

fn asset(path: &str, kind: AssetKind, license: Option<&str>) -> AssetEntry {
    AssetEntry {
        path: path.into(),
        kind,
        name: path.rsplit('/').next().unwrap_or(path).into(),
        thumbnail: None,
        license: license.map(str::to_owned),
    }
}

impl EditorBackend for MockBackend {
    fn duplicate(&mut self, ids: &[EntityId]) -> Result<Op, String> {
        let mut ops = Vec::new();
        for id in ids {
            let mut snap = self.snapshot(*id)?;
            fn renumber(s: &mut EntitySnapshot, next: &mut u64) {
                *next += 1;
                s.stable = StableId(*next);
                let me = s.stable;
                for c in &mut s.children {
                    c.parent = Some(me);
                    renumber(c, next);
                }
            }
            let mut next = 10_000 + self.len() as u64 * 10;
            renumber(&mut snap, &mut next);
            snap.name = format!("{} copy", snap.name);
            snap.parent = None;
            self.apply(&Op::Spawn { snapshot: snap.clone() })?;
            ops.push(Op::Spawn { snapshot: snap });
        }
        Ok(if ops.len() == 1 { ops.remove(0) } else { Op::Batch(ops) })
    }

    fn tools(&mut self) -> Vec<ToolDoc> {
        self.tool_docs.clone()
    }
    fn active_tool(&mut self) -> Option<String> {
        self.active.clone()
    }
    fn set_active_tool(&mut self, id: Option<&str>) {
        self.active = id.map(str::to_owned);
    }
    fn set_tool_settings(&mut self, id: &str, settings: Value) -> Result<(), String> {
        let t = self.tool_docs.iter_mut().find(|t| t.id == id).ok_or("no such tool")?;
        t.settings = settings;
        Ok(())
    }
    fn take_recorded(&mut self) -> Vec<RecordedOp> {
        std::mem::take(&mut self.recorded)
    }
    fn placeables(&mut self) -> Vec<PlaceableDoc> {
        self.placeable_docs.clone()
    }

    fn settings(&mut self) -> Vec<SettingsGroup> {
        self.settings_groups.clone()
    }
    fn set_settings(&mut self, group: &str, value: Value) -> Result<(), String> {
        let g = self.settings_groups.iter_mut().find(|g| g.id == group).ok_or_else(|| format!("no settings group `{group}`"))?;
        if let (Value::Object(have), Value::Object(new)) = (&mut g.value, &value) {
            for (k, v) in new {
                have.insert(k.clone(), v.clone());
            }
        } else {
            g.value = value;
        }
        Ok(())
    }

    fn tree(&mut self, filter: &TreeFilter) -> Vec<TreeNode> {
        self.order
            .iter()
            .filter(|i| self.ents.get(i).is_some_and(|e| e.parent.is_none()))
            .filter_map(|i| self.node(*i, filter))
            .collect()
    }

    fn components(&mut self, id: EntityId) -> Result<Vec<ComponentDoc>, String> {
        let e = self.ents.get(&id).ok_or_else(|| format!("no entity {id}"))?;
        Ok(e.components
            .iter()
            .map(|(ty, v)| ComponentDoc {
                type_path: ty.clone(),
                short_name: ty.rsplit("::").next().unwrap_or(ty).to_owned(),
                value: v.clone(),
                schema: self.schemas.get(ty).cloned().unwrap_or(TypeSchema::Opaque),
                editable: self.schemas.contains_key(ty),
                category: String::new(),
                doc: String::new(),
                default: self.defaults.get(ty).cloned(),
            })
            .collect())
    }

    fn component_types(&mut self) -> Vec<(String, TypeSchema)> {
        self.schemas.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    fn apply(&mut self, op: &Op) -> Result<(), String> {
        let r = self.apply_inner(op);
        if r.is_ok() {
            self.applied.push(op.clone());
            self.level.dirty = true;
        }
        r
    }

    fn snapshot(&mut self, id: EntityId) -> Result<EntitySnapshot, String> {
        self.snapshot_of(id)
    }

    fn selection(&mut self) -> Vec<EntityId> {
        self.selection.clone()
    }

    fn set_selection(&mut self, ids: &[EntityId]) {
        self.selection = ids.iter().copied().filter(|i| self.ents.contains_key(i)).collect();
    }

    fn assets(&mut self, dir: &str) -> Vec<AssetEntry> {
        self.assets.iter().find(|(d, _)| d == dir).map(|(_, e)| e.clone()).unwrap_or_default()
    }

    fn place_asset(&mut self, path: &str, at: Placement) -> Result<Op, String> {
        if path.contains("ue_") {
            return Err("forbidden licence (ue-only)".into());
        }
        let id = self.next_id;
        let snapshot = EntitySnapshot {
            stable: StableId(100 + id),
            name: path.rsplit('/').next().unwrap_or(path).to_owned(),
            parent: at.parent,
            components: vec![(TRANSFORM.to_owned(), transform(at.position[0] as f64, at.position[1] as f64, at.position[2] as f64))],
            children: vec![],
        };
        self.apply_inner(&Op::Spawn { snapshot: snapshot.clone() })?;
        self.placed.push(path.to_owned());
        self.level.dirty = true;
        Ok(Op::Spawn { snapshot })
    }

    fn level(&mut self) -> LevelInfo {
        self.level.clone()
    }

    fn save_level(&mut self, path: Option<&str>) -> Result<(), String> {
        self.saved.push(path.map(str::to_owned));
        if let Some(p) = path {
            self.level.path = Some(p.to_owned());
        }
        self.level.dirty = false;
        Ok(())
    }

    fn open_level(&mut self, path: &str) -> Result<(), String> {
        self.opened.push(path.to_owned());
        self.level = LevelInfo {
            path: Some(path.to_owned()),
            dirty: false,
        };
        Ok(())
    }

    fn play(&mut self) -> Result<(), String> {
        self.play = PlayState::Playing;
        Ok(())
    }
    fn stop(&mut self) {
        self.play = PlayState::Editing;
    }
    fn play_state(&mut self) -> PlayState {
        self.play
    }

    fn diagnostics(&mut self, since: u64) -> (u64, Vec<Diagnostic>) {
        let from = (since as usize).min(self.diag.len());
        (self.diag.len() as u64, self.diag[from..].to_vec())
    }

    fn viewport(&mut self, cmd: ViewportCmd) {
        self.viewport_cmds.push(cmd);
    }

    fn logic_list(&mut self) -> Vec<LogicFile> {
        self.logic_files.clone()
    }

    fn logic_create(&mut self, name: &str, template: &str) -> Result<String, String> {
        if name.trim().is_empty() {
            return Err("a graph needs a name".into());
        }
        let path = format!("logic/{name}.logic.ron");
        if self.logic_files.iter().any(|f| f.path == path) {
            return Err(format!("{path} already exists"));
        }
        self.logic_files.push(LogicFile { path: path.clone(), name: name.to_owned(), errors: Vec::new() });
        self.logic_created.push((name.to_owned(), template.to_owned()));
        Ok(path)
    }

    fn script_info(&mut self, id: EntityId) -> ScriptInfo {
        let path = self.script_path_of(id);
        let mut info = ScriptInfo { path: path.clone(), ..Default::default() };
        info.signals = self.signal_hints.get(&id).cloned().unwrap_or_default().into_iter().map(|n| SignalDoc { name: n, builtin: true, doc: String::new() }).collect();
        if let Some(src) = self.script_src(&path).cloned() {
            info.found = true;
            for l in src.lines() {
                if let Some(rest) = l.strip_prefix("fn ") {
                    let (n, a) = rest.split_once('(').unwrap_or((rest, ""));
                    let params = a.split(')').next().unwrap_or("").split(',').map(|p| p.trim().to_owned()).filter(|p| !p.is_empty()).collect();
                    info.fns.push(ScriptFn { name: n.trim().to_owned(), params });
                } else if let Some((n, rhs)) = l.split_once('=')
                    && !l.starts_with(' ')
                    && !n.contains('(')
                {
                    info.members.push(ScriptMember { name: n.trim().to_owned(), default: rhs.trim().trim_end_matches(';').to_owned() });
                } else if let Some(rest) = l.strip_prefix("signal(\"") {
                    info.signals.push(SignalDoc { name: rest.split('"').next().unwrap_or("").to_owned(), builtin: false, doc: String::new() });
                }
            }
        }
        let conns = self.component(id, CONNECTIONS).and_then(Value::as_array).cloned().unwrap_or_default();
        info.connections = conns
            .iter()
            .map(|c| {
                let t = self.resolve_rel(id, c.get("target").and_then(Value::as_str).unwrap_or(""));
                let method = c.get("method").and_then(Value::as_str).unwrap_or("");
                let method_found = t.and_then(|t| self.script_src(&self.script_path_of(t))).map(|s| s.lines().any(|l| l.starts_with(&format!("fn {method}("))));
                ConnectionInfo { target_name: t.and_then(|t| self.name_of(t).map(str::to_owned)), method_found }
            })
            .collect();
        info
    }

    fn script_create(&mut self, name: &str, template: &str) -> Result<String, String> {
        if name.trim().is_empty() {
            return Err("give the script a name".into());
        }
        let path = format!("scripts/{name}.ruspy");
        if self.script_files.contains_key(&path) {
            return Err(format!("{path} already exists"));
        }
        let text = if template == "empty" { format!("// {name}\n") } else { format!("// {name}\nfn _ready() {{\n}}\nfn _process(delta) {{\n}}\n") };
        self.script_files.insert(path.clone(), text);
        self.logic_files.push(LogicFile { path: path.clone(), name: name.to_owned(), errors: Vec::new() });
        Ok(path)
    }

    fn script_node_path(&mut self, from: EntityId, to: EntityId) -> Result<String, String> {
        self.rel_path(from, to)
    }

    fn script_add_stub(&mut self, target: EntityId, method: &str, params: &[String]) -> Result<String, String> {
        let path = self.script_path_of(target);
        if path.is_empty() {
            return Err("the target has no script".into());
        }
        let key = if path.contains('/') { path.clone() } else { format!("scripts/{path}") };
        let src = self.script_files.get_mut(&key).ok_or("script file missing")?;
        src.push_str(&format!("\nfn {method}({}) {{\n}}\n", params.join(", ")));
        self.stubs.push((target, method.to_owned(), params.to_vec()));
        Ok(path)
    }
}
