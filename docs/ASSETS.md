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
