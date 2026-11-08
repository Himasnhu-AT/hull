# Asset library

Ready-made, licence-tracked models, textures and HDRIs under `assets/library/`, fetched or
imported by `scripts/assets.py` (Python 3, standard library only). The editor's asset browser
(docs/EDITOR.md) and `content.check` read the same layout.

## Layout

```
assets/library/
  LICENSES.json                      # committed: one entry per item
  cars/kenney-car-kit/               # kit: *.glb + Textures/colormap.png + LICENSE.txt
  roads/kenney-city-kit-roads/
  buildings/kenney-city-kit-commercial/
  textures/polyhaven-asphalt_01/     # color.jpg normal.jpg rough.jpg ao.jpg (+ cooked *.ktx2, color.avg)
  hdris/polyhaven-kloofendal_48d_partly_cloudy_puresky/*.hdr
```

An **item** is `assets/library/<kind>/<name>/` and its key is `<kind>/<name>`. A kit is one item
(its GLBs share `Textures/`, and glTF uris are relative, so the folder is kept as shipped).
Kinds: `cars roads buildings props textures hdris characters audio misc`.

```json
{ "cars/kenney-car-kit": { "source": "kenney", "url": "https://kenney.nl/assets/car-kit",
    "author": "Kenney", "license": "CC0-1.0", "fetched": "2026-11-02" } }
```

Allowed licences (`assets.py check`): `CC0-1.0 CC-BY-4.0 CC-BY-3.0 CC-BY-SA-4.0 MIT Apache-2.0
OFL-1.1 public-domain fab-standard`. Refused everywhere: `ue-only`, `reference-only`,
`epic-sample`. CC-BY items need their credit in your game's credits screen (author is in the
entry).

## Commands

```sh
python3 -I scripts/assets.py fetch cars-and-roads      # a group, or kit names; see scripts/assets_catalog.json
python3 -I scripts/assets.py fetch all [--cook]
python3 -I scripts/assets.py import ~/Downloads/pack.zip --source fab --license fab-standard \
    --url https://www.fab.com/listings/... --author "Seller" [--kind cars] [--name my-pack]
python3 -I scripts/assets.py list                      # item, licence, files, size
python3 -I scripts/assets.py check                     # exit 1: missing entry / bad licence
python3 -I scripts/assets.py cook                      # textures -> KTX2 via tools/cook
```

**Catalog** (`scripts/assets_catalog.json`, all CC0, licence re-checked at fetch time):
Kenney Car Kit, Racing Kit, City Kit (Roads / Commercial / Suburban); Poly Haven textures
(asphalt_01, asphalt_02, concrete_floor_02, red_brick) and one 1k HDRI; ambientCG Asphalt004
and Concrete034. Kenney downloads use the site's own signed-link flow (the page must still
state CC0). Quaternius packs have no stable direct links: download by hand and `import`.

**Safety**: archives are unpacked into a fresh temp dir with path-escape and size (2 GB)
checks; only glTF/GLB, images and licence text are copied out; nothing downloaded is executed.
FBX/OBJ-only packs are converted only if `FBX2glTF` / `obj2gltf` are on `PATH` (those run on the
untrusted file; untested here), otherwise skipped with a message: export GLB from Blender.

## Fab workflow

Fab needs your Epic login, so you download, the script normalises:

1. On fab.com pick listings with the **Standard License** (or CC0 / CC-BY) whose formats include
   **glTF, FBX or OBJ**. Listings that are Unreal-only (`.uasset`, "UE only" format) are refused:
   their licence forbids use outside Unreal, and the importer rejects `--license ue-only`,
   `reference-only` and `epic-sample`.
2. Download the archive from your library.
3. `assets.py import <zip> --source fab --license fab-standard --url <listing> --author <seller>`.
   Standard-licence content is not redistributable: the files stay local (see git policy), only
   the ledger entry is committed.
4. A zip containing a `.uproject` / `.uasset` stops with a pointer to `tools/ue-import` (coming).

## Git policy (fetch on demand)

`.gitignore` ignores `assets/library/*` except `LICENSES.json`. The repo is 5 MB (4 MB pack);
the CC0 set here is 33 MB (cars 5.6, roads 1.6 + 1.9, buildings 3.8 + 2.6, textures 17, HDRI 1.4),
and cooked KTX2 plus Fab imports grow it further, so committing binaries would multiply the
clone size. Commit `LICENSES.json` and the catalog; a fresh checkout runs `assets.py fetch`.
To commit a small kit anyway, `git add -f` it (and keep its licence file). Fab imports cannot be
re-fetched by script and must not be redistributed under the Standard License.

## Using items

- Models: `WorldAssetRoot(server.load(GltfAssetLabel::Scene(0).from_asset("library/cars/kenney-car-kit/sedan.glb")))`;
  tag `Scenery` / `Actor` as usual (docs/GAME_GUIDE.md). Kenney GLBs reference a tiny shared
  `Textures/colormap.png`; they have no mips of their own (the engine builds them).
- Textures: `gfx::load_pbr_at(&server, &dir, &mut pending, "library/textures/polyhaven-asphalt_01", tint)`
  (`load_pbr` is the same for `textures/<name>`). Maps are `color/normal/rough/ao.jpg`, normals
  OpenGL (+Y). `assets.py cook` writes `color.ktx2 normal.ktx2 orm.ktx2 color.avg` beside them;
  with feature `ktx2` they are preferred.
- `examples/library_view.rs` lays out cars, road pieces and an asphalt ground.
- `content.check` (control port / `asset_check` example) reports `unlicensed_asset` and
  `forbidden_license` as errors for anything under `library/`.

## 3D pipeline (glTF in, cooked asset out)

`crates/asset-pipe` (Bevy-free; CLI `asset-pipe`, library for tools and tests) turns one glTF/GLB
into a **cooked asset**: LOD meshes, a collider, an impostor atlas, and a `.asset.ron` sidecar. The
runtime (`src/assets/`, feature `assets`, in `default`) loads that and spawns it in one call.

```sh
memgate -- cargo run -p asset-pipe -- model.glb --out assets/cooked/pine --name pine \
    --scale 0.01 --up z --height 6 --lods 0.35,0.12 --distances 15,40,80 --impostor 8,128 --tags tree
```

Output in `--out`: `pine.lod0.glb .. pine.lodN.glb` (LOD0 is the full model, textures embedded),
`pine.impostor.png`, `pine.asset.ron`, and with `--cook <path to tools/cook binary>` a
`pine.tex/` folder of KTX2 sets. Flags: `--scale K`, `--up y|z`, `--pivot keep|bottom|center`,
`--height M`, `--max-texture PX`, `--lods r1,r2` (share of triangles per extra level),
`--distances d0,d1,..` (metres where each level hands over; default from the model size),
`--collider auto|none|box|sphere|capsule|convex|trimesh`, `--impostor VIEWS[,CELLPX]` /
`--no-impostor`, `--impostor-max M`, `--tags a,b`, `--force`.

### Stages

Each stage is `trait Stage { fn name(&self) -> &'static str; fn run(&mut self, &mut Asset, &Ctx) }`
(`pipeline.rs`). `Pipeline::standard()` is `validate, normalize, textures, lods, collider,
impostor, emit`. Add your own with `push` / `insert_after("collider", MyStage)`; swap one with
`replace("lods", Lods::new(MyQuadricSimplifier))`.

| Stage | Does |
|---|---|
| validate | empty / non-finite geometry, bad indices, degenerate triangles, missing or undecodable textures (warnings, the rest errors), size sanity ("looks like centimetres: try scale 0.01"), Z-up suspicion. Errors stop the run unless `--force` |
| normalize | up axis (Z to Y), scale, target height, pivot (bottom centre by default) |
| textures | decodes every image, downsizes to `max_texture_size`; with a `cook` binary also writes each material's colour / normal / roughness as a set and runs `tools/cook` (KTX2 BC7/BC5) |
| lods | `Simplifier` (default `Clustering`: grid vertex clustering that keeps each cell's most central vertex with its own UV and normal, so textures never smear; swap in a quadric collapse if you need better silhouettes) and switch distances |
| collider | `auto` is a box when the mesh fills > 60 % of its bounds, else convex (about 64 extreme points, the runtime builds the hull); also sphere, capsule, `trimesh` (the runtime builds it from one LOD's meshes) |
| impostor | software-rasterised albedo from N views around +Y into a single-row atlas (2x supersampled, edge-dilated), alpha from the material's mask. No GPU needed |
| emit | writes the files and the sidecar |

glTF reading (`gltf_in.rs`) bakes node transforms, reads triangle primitives, accessors with strides
and normalised integers, GLB, data URIs and sibling files (never paths that leave the folder).
Refused with a clear message: sparse accessors, required extensions (Draco, quantisation).

### The sidecar

```ron
(version: 1, name: "pine", bounds: ((-1.6, 0.0, -1.6), (1.6, 6.0, 1.6)),
 lods: [(mesh: "pine.lod0.glb", distance: 15.0, triangles: 1120), ...],
 collider: Convex(points: [...]), impostor: Some((atlas: "pine.impostor.png", grid: (8, 1), frames: 8,
 half_width: 1.6, y0: 0.0, y1: 6.0, cutoff: 0.5, max_distance: None)), tags: ["tree"], cooked_textures: None)
```

The impostor fields are those of `foliage::ImpostorParams`: the runtime turns it into an
`ImpostorAtlas` (`engine::assets::atlas_of`), the same contract the foliage renderer reads, so a
baked atlas can also feed `foliage` chunks directly. `distance` is where a level hands over to the next (the impostor after the last). Types:
`asset_pipe::desc::AssetDesc` (also in the Bevy-free build the engine uses).

### Runtime

```rust
engine::assets::spawn(&mut commands, &server, "cooked/pine", Transform::from_xyz(4.0, 0.0, -9.0));
// or: commands.spawn_cooked(&server, "cooked/pine", transform)   (trait SpawnCooked)
```

Returns the root at once; when the sidecar has loaded the root gets `CookedBuilt` and children:
one scene per LOD, the impostor quad, and a collider with a `RigidBody` on the root (static; the
tag `dynamic` makes it dynamic). The root is `Scenery` (`Actor` with the tag `actor`).

- LOD switching is Bevy's dithered `VisibilityRange` on the LOD's mesh entities (added when the
  glTF scene spawns them), so there is no per-frame system and no pop.
- The impostor is a quad turned about the vertical to face the camera (`impostor.wesl`); the
  vertex shader picks the atlas cell from the camera's azimuth in the asset's own frame, so
  instances at any yaw show the right side. It has no shadows and no prepass.
- **Render budget**: windows are metres at High quality and scale with the quality preset
  (`EffectiveRanges.view / SceneryRanges.view`); nothing is drawn past the effective view distance
  (the impostor runs to `max_distance` or the view distance); the fade width is the budget's
  `fade`; LOD meshes carry `KeepDetail` so the engine's own detail tiers leave them alone. Change
  the policy by replacing the `CookedLodSwitch` resource (`fn(window, ranges, scale) -> VisibilityRange`).
- `assets.list` (control port) reports every instance's distance to the camera and which part is
  drawn (`lod0`, `lod1`, `impostor`, `none`) with triangle counts. `spawn_asset(path, position)`
  in scripts.

Demo: `examples/asset_pipeline_demo.rs` cooks a procedural pine and spawns a row plus a forest
(`python3 -I scripts/play.py scripts/asset-pipeline-demo.json --example asset_pipeline_demo
--features asset_tools`; the cook output goes to `assets/cooked_demo/`, git-ignored).

Measurements (Apple M-series, release, the demo's pine of 1.1 k triangles): see the demo notes
in `docs/PERF.md` once a scene benchmark exists; the cook itself takes about 0.3 s per asset.

Known limits: the clustering simplifier is rough on thin shells; impostors have one elevation ring
(a bird's-eye view shows the side picture), albedo only (no baked normals), no mips on the atlas;
textures stay embedded PNG/JPEG in the LOD files (KTX2 sets are written but the loader does not
use them yet); skinned and animated models are not cooked; multi-asset batching (merging
impostors per chunk, as `pacenote` does) is the next step for forests of thousands.

## Shared store (several games, one download)

Games on this machine share one download of each item. The store holds the bytes; each game
records what it uses and links to the store.

**Store dir:** `--store DIR`, else `$ENGINE_ASSET_STORE`, else `~/codes/game/asset-store`.

```
<store>/index.json          "<kind>/<name>": {current, history[], entry{source,url,author,license,fetched}}
<store>/cas/<treehash>/     the item's files; treehash = sha256 of sorted "relpath\0filehash" lines
                            (every file, LICENSES.json excluded)
```

Per game (repo root): `assets.manifest.json` (`{"items": ["props/foo", ...]}`, sorted) says what
the game wants; `assets.lock.json` pins each item's hash, licence, author, url, source;
`ATTRIBUTION.md` is generated.

| Command | Does |
|---|---|
| `assets.py add <catalog-name\|group\|kind/name\|zip\|dir>... [import flags]` | Fetch/import into the store unless the key is already there (a known `kind/name` costs no download), then add the key(s) to the manifest. Import flags are the `import` ones: `--source --license --url --author --kind --name`. |
| `assets.py lock` | Every manifest item must be in the store; writes `assets.lock.json`. Refuses forbidden licences. |
| `assets.py sync [--copy] [--force]` | Materialises `assets/library/<key>` from `cas/<hash>`: a symlink by default, a real copy with `--copy`. Verifies the hash (copy: of the copied tree; symlink: of the cas dir) and fails on mismatch or a missing store item. Updates `LICENSES.json` for the synced keys (others kept) and regenerates `ATTRIBUTION.md` (table of item, author, licence, url; a "credit is required" line per CC-BY item). A real directory already in `assets/library` is left alone unless `--force`. |
| `assets.py store [list\|path]` | List store items (key, hash prefix, licence, size) / print the resolved store dir. |

Worked example:

```sh
python3 -I scripts/assets.py add kenney-car-kit polyhaven-asphalt_01      # downloads once
python3 -I scripts/assets.py add ~/Downloads/rocks.zip --source other --license CC-BY-4.0 \
    --url https://example.com/rocks --author "A. Artist" --kind props --name rocks
python3 -I scripts/assets.py lock && python3 -I scripts/assets.py sync    # library/ now links to the store
python3 -I scripts/assets.py store list
```

**Two games, one download:** in the second repo run `assets.py add cars/kenney-car-kit` (or the
catalog name); the key is already in the store, so nothing is downloaded and the manifest gains
the entry. `lock` then `sync` links it. The cas dir exists once on disk; both games' library
entries point at it. Updating an item in the store adds a new hash (`history` keeps the old
ones); a game keeps using its locked hash until it runs `lock` again.

**Git policy:** commit `assets.manifest.json`, `assets.lock.json` and `ATTRIBUTION.md`. Never
commit the store. `assets/library` stays ignored as before. On a fresh machine run `add` for the
manifest's items (catalog names re-download; Fab/own imports need the original zip), then `lock`
and `sync`; `sync` fails loudly if the store does not hold the locked hash.

Safety is unchanged: everything unpacked is untrusted, nothing is executed. `ENGINE_ASSETS_ROOT`
overrides the game root (tests); `ENGINE_ASSETS_OFFLINE=1` makes any network access fail.
Tests: `python3 -I scripts/test_assets_store.py`.
