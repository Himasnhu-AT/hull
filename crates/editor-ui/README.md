# editor-ui

The editor's UI: egui 0.36 + ashlar-ui panels over `editor_proto::EditorBackend`. No Bevy
(`cargo tree -p editor-ui | grep -c bevy` is 0). Contract: `docs/EDITOR.md`.

## Hosting

```rust
let mut editor = editor_ui::EditorUi::new();
// each egui pass:
let out = editor.show(&ctx, &mut backend);   // backend: impl EditorBackend
// out.viewport: Option<egui::Rect> in points -> place the 3D camera there
// out.wants_pointer / wants_keyboard / pointer_over_viewport -> gate scene picking and game input
```
`show` draws over the whole screen (toolbar, status bar, docked panels). The viewport panel is a
transparent hole; everything else is opaque. Persist the layout with `save_state()` /
`load_state(json)` (invalid layouts are rejected, the current one stays).

Standalone proof: `cargo run -p editor-ui --example mock_editor` (eframe window over the
in-memory `mock::MockBackend`); `-- --shot out.png [TabLabel]` renders one headless frame.

## Panels

- **Outliner**: tree from `backend.tree` (search filter is passed to the backend), multi-select
  (click, Cmd/Ctrl-click, Shift-click) synced with `selection/set_selection`, double-click or F2
  renames (`Op::Rename`), drag a row onto another to reparent (`Op::Reparent`; dropping on the
  empty area moves to the root), Delete removes (`Op::Despawn` built from `backend.snapshot`).
  Generated nodes are greyed and read-only.
- **Details**: first selected entity; one collapsible section per `ComponentDoc`, a property grid
  built from `TypeSchema` (bool toggle, int/float scrub fields, Vec2/3/4, Quat as euler degrees,
  Color picker, enum combo, string, asset path with a placeholder browse button, nested
  struct/list). Non-editable components are read-only. "Add component" from `component_types`;
  `x` removes a component.
- **Content**: `backend.assets(dir)` with breadcrumbs, search, licence badges; double-click a
  folder to enter, double-click a file or press Place to `place_asset` (the returned `Spawn` op
  goes on the undo stack; the backend has already applied it).
- **Output**: diagnostics with a level filter; click a row to copy `file:line:col`.
- **Logic**: placeholder; with feature `snarl` a 3-node egui-snarl demo graph.
- **Command palette** (Cmd+K): every toolbar action is a command (`model::COMMANDS`):
  Cmd+S save, Cmd+Shift+S save as, Cmd+O open, Cmd+Z undo, Cmd+Shift+Z / Cmd+Y redo, 1-4 tools (Select, Move, Rotate, Scale), 5-9 world tools, Cmd+D duplicate, Cmd+A select all, F1 controls,
  G snap, F focus, F2 rename, Delete, Cmd+P play/stop.

## Undo

`undo::UndoStack` is a journal of `Op`s (not document snapshots). Every edit is `backend.apply(op)`
then recorded; undo applies `op.inverse()`. Edits with the same merge key
(`entity|type_path|field`) within 1.5 s fold into one step (`Op::merge`, first `before`, last
`after`); a committed scrub seals the step. Gizmo drags in the viewport call
`EditorUi::record_applied(label, op, key)` then `seal_undo()` on release.

## Tests

`cargo test -p editor-ui`: unit tests (undo merge, reparent rules, euler, commands) and
`tests/ui.rs` (egui_kittest: click a row, change a value field, undo/redo, shortcuts, delete and
undo, content browser, output). Rows are exposed to accessibility via `model::a11y_row`.

## Known limits

- Drag-to-reparent and rename-by-double-click are covered by unit tests of the op logic, not by
  pointer-driven UI tests.
- `snarl` feature: see docs/EDITOR.md ("Changes requested by Stream B").
