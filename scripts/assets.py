#!/usr/bin/env python3
"""Asset library: fetch CC0 kits, import your own downloads, list, check licences.

  python3 -I scripts/assets.py fetch <name|group>... [--cook]   # see scripts/assets_catalog.json
  python3 -I scripts/assets.py import <zip|dir> --source fab|other --license ID --url URL --author NAME
                                      [--kind cars|roads|buildings|props|textures|hdris] [--name NAME]
  python3 -I scripts/assets.py list
  python3 -I scripts/assets.py check          # exit 1 on a missing entry / forbidden licence
  python3 -I scripts/assets.py cook           # textures -> KTX2 with tools/cook

Shared store (several games, one download; docs/ASSETS.md "Shared store"):
  assets.py add <catalog-name|group|kind/name|zip|dir>... [--store DIR] [import flags]
  assets.py lock                  # assets.manifest.json -> assets.lock.json (hashes)
  assets.py sync [--copy] [--force]   # lock -> assets/library (symlinks by default), ATTRIBUTION.md
  assets.py store [list|path]
Store dir: --store DIR, else $ENGINE_ASSET_STORE, else ~/codes/game/asset-store.

Layout: assets/library/<kind>/<name>/... plus assets/library/LICENSES.json, keyed "<kind>/<name>"
(docs/ASSETS.md). Everything downloaded is untrusted data: it is unpacked into a fresh temp
directory (zip paths checked), only glTF/GLB, images and licence text are copied out, and
nothing from it is executed. Standard library only.
"""
import datetime, json, os, shutil, ssl, subprocess, sys, tempfile, urllib.error, urllib.parse, urllib.request, zipfile

SCRIPT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.environ.get("ENGINE_ASSETS_ROOT") or SCRIPT_ROOT  # the game root (manifest, lock, library)
LIB = os.path.join(ROOT, "assets", "library")
LICENSES = os.path.join(LIB, "LICENSES.json")
CATALOG = os.path.join(SCRIPT_ROOT, "scripts", "assets_catalog.json")
DEFAULT_STORE = os.path.expanduser("~/codes/game/asset-store")
UA = "Mozilla/5.0 (engine assets.py)"

ALLOWED = {"CC0-1.0", "CC-BY-4.0", "CC-BY-3.0", "CC-BY-SA-4.0", "MIT", "Apache-2.0", "OFL-1.1",
           "public-domain", "fab-standard"}
FORBIDDEN = {"ue-only", "reference-only", "epic-sample"}
KINDS = ("cars", "roads", "buildings", "props", "textures", "hdris", "characters", "audio", "misc")
MAX_UNPACKED = 2 << 30
KEEP_MODEL = (".glb", ".gltf", ".bin")
KEEP_IMG = (".png", ".jpg", ".jpeg", ".ktx2", ".hdr", ".exr")
CONVERTIBLE = (".fbx", ".obj")


def die(msg, code=1):
    print("error: " + msg, file=sys.stderr)
    sys.exit(code)


def opt(args, name, default=None):
    return args[args.index(name) + 1] if name in args else default


def ssl_context():
    """python.org builds ship no CA bundle; fall back to the OS one (verification stays on)."""
    ctx = ssl.create_default_context()
    if not ctx.cert_store_stats().get("x509_ca"):
        for cafile in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
            if os.path.exists(cafile):
                return ssl.create_default_context(cafile=cafile)
    return ctx


def http(url, referer=None, headers=None):
    if os.environ.get("ENGINE_ASSETS_OFFLINE"):
        die("network disabled (ENGINE_ASSETS_OFFLINE)")
    h = {"User-Agent": UA}
    if referer:
        h["Referer"] = referer
    h.update(headers or {})
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=120, context=ssl_context()) as r:
        return r.read()


def download(url, dest, referer=None):
    data = http(url, referer)
    with open(dest, "wb") as f:
        f.write(data)
    return len(data)


# ------------------------------------------------------------------ licences file
def read_licenses():
    if not os.path.exists(LICENSES):
        return {}
    with open(LICENSES) as f:
        return json.load(f)


def write_licenses(d):
    os.makedirs(LIB, exist_ok=True)
    with open(LICENSES, "w") as f:
        json.dump(dict(sorted(d.items())), f, indent=2)
        f.write("\n")


def add_license(key, source, url, author, license_id):
    d = read_licenses()
    d[key] = {"source": source, "url": url, "author": author, "license": license_id,
              "fetched": datetime.date.today().isoformat()}
    write_licenses(d)


def check_license_arg(lic):
    if lic.lower() in FORBIDDEN:
        die(f"licence `{lic}` cannot be imported: the library only takes content you may ship "
            f"in any engine (forbidden: {', '.join(sorted(FORBIDDEN))}).", 3)
    if lic not in ALLOWED:
        die(f"unknown licence `{lic}`. Allowed: {', '.join(sorted(ALLOWED))}. Fab Standard License -> fab-standard.", 3)


# ------------------------------------------------------------------ unpacking
def safe_unzip(zpath, dest):
    total = 0
    with zipfile.ZipFile(zpath) as z:
        for i in z.infolist():
            total += i.file_size
            if total > MAX_UNPACKED:
                die("archive unpacks to more than 2 GB; refusing")
            target = os.path.realpath(os.path.join(dest, i.filename))
            if not target.startswith(os.path.realpath(dest) + os.sep) and target != os.path.realpath(dest):
                die(f"archive entry escapes the target directory: {i.filename}")
            if (i.external_attr >> 16) & 0o170000 == 0o120000:
                continue  # symlink: skip
        z.extractall(dest)


def walk_files(root):
    for dp, dn, fn in os.walk(root):
        dn[:] = [d for d in dn if not d.startswith(("__MACOSX", "."))]
        for f in fn:
            if not f.startswith("."):
                yield os.path.join(dp, f)


def is_unreal(root):
    return any(f.lower().endswith((".uproject", ".uasset", ".umap")) for f in walk_files(root))


def common_dir(paths):
    return os.path.commonpath([os.path.dirname(p) for p in paths]) if paths else None


def convert(src, dst):
    """FBX/OBJ -> GLB with an installed converter; True on success."""
    ext = os.path.splitext(src)[1].lower()
    if ext == ".fbx" and shutil.which("FBX2glTF"):
        cmd = ["FBX2glTF", "--binary", "-i", src, "-o", dst[:-4]]
    elif ext == ".obj" and shutil.which("obj2gltf"):
        cmd = ["obj2gltf", "-i", src, "-o", dst, "-b"]
    else:
        return False
    return subprocess.run(cmd, capture_output=True).returncode == 0 and os.path.exists(dst)


def normalise_models(src_root, dest):
    """Copy glTF/GLB (+ their textures, keeping relative layout) from src_root to dest.
    Prefers a GLB folder; converts OBJ/FBX only with an installed converter. Returns file count."""
    files = list(walk_files(src_root))
    models = [f for f in files if f.lower().endswith((".glb", ".gltf"))]
    if models:
        glb = [f for f in models if f.lower().endswith(".glb")]
        if glb:
            # Kit zips ship the same models as GLB, FBX and OBJ: keep the GLB folder only.
            keep_dir = common_dir(glb)
            base = keep_dir
            picked = [f for f in files if os.path.commonpath([base, f]) == base] if base else glb
        else:
            base = common_dir(models)
            picked = [f for f in files if os.path.commonpath([base, f]) == base]
        # Textures may sit beside the model folder (Textures/ next to "GLB format/"): glTF uris
        # are relative to the model, so walk up while some uri would not resolve.
        picked = [f for f in picked if f.lower().endswith(KEEP_MODEL + KEEP_IMG)]
        n = 0
        for f in picked:
            out = os.path.join(dest, os.path.relpath(f, base))
            os.makedirs(os.path.dirname(out), exist_ok=True)
            shutil.copy2(f, out)
            n += 1
        missing = unresolved_uris(dest)
        if missing:
            print(f"  warning: {len(missing)} glTF uri(s) do not resolve, e.g. {missing[0]}", file=sys.stderr)
        return n
    conv = [f for f in files if f.lower().endswith(CONVERTIBLE)]
    if not conv:
        return 0
    # Prefer FBX over OBJ, never both.
    fbx = [f for f in conv if f.lower().endswith(".fbx")]
    conv = fbx or conv
    n = 0
    for f in conv:
        out = os.path.join(dest, os.path.splitext(os.path.basename(f))[0] + ".glb")
        os.makedirs(dest, exist_ok=True)
        if convert(f, out):
            n += 1
    if n == 0:
        print("  no glTF in this pack and no converter (FBX2glTF / obj2gltf) on PATH: skipped. "
              "Convert to GLB (Blender: File > Export > glTF) and import the folder.", file=sys.stderr)
    return n


def unresolved_uris(dest):
    bad = []
    for f in walk_files(dest):
        if f.lower().endswith(".glb"):
            with open(f, "rb") as fh:
                head = fh.read(20)
                if len(head) < 20:
                    continue
                ln = int.from_bytes(head[12:16], "little")
                try:
                    j = json.loads(fh.read(ln))
                except ValueError:
                    continue
        elif f.lower().endswith(".gltf"):
            try:
                with open(f) as fh:
                    j = json.load(fh)
            except ValueError:
                continue
        else:
            continue
        for key in ("images", "buffers"):
            for it in j.get(key, []):
                u = it.get("uri")
                if u and not u.startswith("data:"):
                    p = os.path.normpath(os.path.join(os.path.dirname(f), urllib.parse.unquote(u)))
                    if not os.path.exists(p):
                        bad.append(os.path.relpath(p, dest))
    return bad


def install(kind, name, tmp_src, source, url, author, lic, extra_license_text=None):
    dest = os.path.join(LIB, kind, name)
    stage = tempfile.mkdtemp(prefix="stage_", dir=tempfile.mkdtemp(prefix="assets_out_"))
    n = normalise_models(tmp_src, stage)
    if n == 0:
        shutil.rmtree(os.path.dirname(stage), ignore_errors=True)
        return 0
    if extra_license_text:
        with open(os.path.join(stage, "LICENSE.txt"), "w") as f:
            f.write(extra_license_text)
    if os.path.exists(dest):
        shutil.rmtree(dest)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.move(stage, dest)
    shutil.rmtree(os.path.dirname(stage), ignore_errors=True)
    add_license(f"{kind}/{name}", source, url, author, lic)
    return n


# ------------------------------------------------------------------ fetchers
def fetch_kenney(name, e):
    page = f"https://kenney.nl/assets/{e['slug']}"
    html = http(page).decode("utf8", "replace")
    if "creativecommons.org/publicdomain/zero/1.0" not in html:
        die(f"{page} no longer states CC0; not fetching")
    did = ("assets/" + e["slug"]).encode().hex()
    link = json.loads(http(f"https://kenney.nl/download-link/{did}", referer=page))
    tmp = tempfile.mkdtemp(prefix="kenney_dl_")
    zp = os.path.join(tmp, "pack.zip")
    size = download(link["url"], zp)
    out = os.path.join(tmp, "x")
    os.makedirs(out)
    safe_unzip(zp, out)
    lic_txt = None
    for f in walk_files(out):
        if os.path.basename(f).lower() == "license.txt":
            lic_txt = open(f, errors="replace").read()
    n = install(e["kind"], name, out, "kenney", page, "Kenney", "CC0-1.0", lic_txt)
    shutil.rmtree(tmp, ignore_errors=True)
    return size, n


def fetch_polyhaven(name, e, hdri=False):
    info = json.loads(http(f"https://api.polyhaven.com/info/{e['id']}"))
    authors = ", ".join(info.get("authors", {})) or "Poly Haven"
    files = json.loads(http(f"https://api.polyhaven.com/files/{e['id']}"))
    res = e.get("res", "1k")
    page = f"https://polyhaven.com/a/{e['id']}"
    dest = os.path.join(LIB, e["kind"], name)
    stage = tempfile.mkdtemp(prefix="ph_")
    size = 0
    if hdri:
        h = files["hdri"][res]["hdr"]
        size += download(h["url"], os.path.join(stage, f"{e['id']}_{res}.hdr"))
    else:
        want = {"color.jpg": "Diffuse", "normal.jpg": "nor_gl", "rough.jpg": "Rough", "ao.jpg": "AO"}
        for out, key in want.items():
            if key in files and res in files[key] and "jpg" in files[key][res]:
                size += download(files[key][res]["jpg"]["url"], os.path.join(stage, out))
        if not os.path.exists(os.path.join(stage, "color.jpg")):
            die(f"{e['id']}: no diffuse map at {res}")
    if os.path.exists(dest):
        shutil.rmtree(dest)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.move(stage, dest)
    add_license(f"{e['kind']}/{name}", "polyhaven", page, authors, "CC0-1.0")
    return size, len(os.listdir(dest))


def fetch_ambientcg(name, e):
    d = json.loads(http(f"https://ambientcg.com/api/v2/full_json?id={e['id']}&include=downloadData"))
    a = d["foundAssets"][0]
    attr = f"{e['res']}-JPG"
    dl = [x for x in a["downloadFolders"]["default"]["downloadFiletypeCategories"]["zip"]["downloads"] if x["attribute"] == attr]
    if not dl:
        die(f"{e['id']}: no {attr} download")
    tmp = tempfile.mkdtemp(prefix="acg_dl_")
    zp = os.path.join(tmp, "pack.zip")
    size = download(dl[0]["downloadLink"], zp)
    out = os.path.join(tmp, "x")
    os.makedirs(out)
    safe_unzip(zp, out)
    names = {"_Color.jpg": "color.jpg", "_NormalGL.jpg": "normal.jpg", "_Roughness.jpg": "rough.jpg",
             "_AmbientOcclusion.jpg": "ao.jpg"}
    dest = os.path.join(LIB, e["kind"], name)
    if os.path.exists(dest):
        shutil.rmtree(dest)
    os.makedirs(dest)
    for f in walk_files(out):
        for suf, o in names.items():
            if f.endswith(suf):
                shutil.copy2(f, os.path.join(dest, o))
    if not os.path.exists(os.path.join(dest, "color.jpg")):
        die(f"{e['id']}: no colour map in archive")
    shutil.rmtree(tmp, ignore_errors=True)
    add_license(f"{e['kind']}/{name}", "ambientcg", a["shortLink"], "ambientCG (Lennart Demes)", "CC0-1.0")
    return size, len(os.listdir(dest))


def cmd_fetch(args):
    cat = json.load(open(CATALOG))
    names = []
    for a in args:
        if a.startswith("--"):
            continue
        names += cat["groups"].get(a, [a])
    if not names:
        die("usage: assets.py fetch <name|group>... ; names: " + ", ".join(cat["kits"]) + " ; groups: " + ", ".join(cat["groups"]))
    total = 0
    for n in names:
        e = cat["kits"].get(n)
        if not e:
            die(f"unknown kit `{n}`")
        t = e["type"]
        print(f"fetch {n} ...", flush=True)
        if t == "kenney":
            size, files = fetch_kenney(n, e)
        elif t == "polyhaven":
            size, files = fetch_polyhaven(n, e)
        elif t == "polyhaven-hdri":
            size, files = fetch_polyhaven(n, e, hdri=True)
        elif t == "ambientcg":
            size, files = fetch_ambientcg(n, e)
        else:
            die(f"{n}: unknown type {t}")
        total += size
        print(f"  -> library/{e['kind']}/{n}: {files} files, downloaded {size / 1e6:.1f} MB")
    print(f"total downloaded: {total / 1e6:.1f} MB")
    if "--cook" in args:
        cmd_cook([])


def cmd_import(args):
    if not args or args[0].startswith("--"):
        die("usage: assets.py import <zip|dir> --source fab|other --license ID --url URL --author NAME [--kind K] [--name N]")
    src = args[0]
    source, lic, url, author = opt(args, "--source"), opt(args, "--license"), opt(args, "--url"), opt(args, "--author")
    if source not in ("fab", "other"):
        die("--source must be fab or other")
    if not (lic and url and author):
        die("--license, --url and --author are required")
    check_license_arg(lic)
    kind = opt(args, "--kind", "props")
    if kind not in KINDS:
        die(f"--kind must be one of {', '.join(KINDS)}")
    if not os.path.exists(src):
        die(f"{src} not found")
    name = opt(args, "--name") or os.path.splitext(os.path.basename(src.rstrip("/")))[0].lower().replace(" ", "-")
    tmp = tempfile.mkdtemp(prefix="import_")
    if os.path.isdir(src):
        root = src
    else:
        root = os.path.join(tmp, "x")
        os.makedirs(root)
        if not zipfile.is_zipfile(src):
            die(f"{src} is not a zip file or a directory")
        safe_unzip(src, root)
    if is_unreal(root):
        print("This is an Unreal project / .uasset content. tools/ue-import handles it (coming); "
              "assets.py only takes glTF/GLB/FBX/OBJ.")
        shutil.rmtree(tmp, ignore_errors=True)
        sys.exit(4)
    n = install(kind, name, root, source, url, author, lic)
    shutil.rmtree(tmp, ignore_errors=True)
    if n == 0:
        die("nothing imported (no glTF/GLB found and no converter for FBX/OBJ)")
    print(f"imported library/{kind}/{name}: {n} files, licence {lic}")


# ------------------------------------------------------------------ list / check
def items():
    out = {}
    if os.path.isdir(LIB):
        for kind in sorted(os.listdir(LIB)):
            kd = os.path.join(LIB, kind)
            if os.path.isdir(kd):
                for name in sorted(os.listdir(kd)):
                    if os.path.isdir(os.path.join(kd, name)):
                        out[f"{kind}/{name}"] = os.path.join(kd, name)
    return out


def du(path):
    files = list(walk_files(path))
    return sum(os.path.getsize(f) for f in files), len(files)


def cmd_list(_):
    lic = read_licenses()
    rows = [("ITEM", "LICENSE", "FILES", "SIZE")]
    for key, path in items().items():
        size, n = du(path)
        rows.append((key, lic.get(key, {}).get("license", "MISSING"), str(n), f"{size / 1e6:.1f} MB"))
    for key in lic:
        if key not in items():
            rows.append((key, lic[key].get("license", "?"), "-", "not fetched"))
    w = [max(len(r[i]) for r in rows) for i in range(4)]
    for r in rows:
        print("  ".join(c.ljust(w[i]) for i, c in enumerate(r)))


def cmd_check(_):
    lic = read_licenses()
    bad = 0
    if os.path.isdir(LIB):
        for f in os.listdir(LIB):
            if f != "LICENSES.json" and not os.path.isdir(os.path.join(LIB, f)):
                print(f"FAIL library/{f}: loose file in library root"); bad += 1
    for key in items():
        e = lic.get(key)
        if e is None:
            print(f"FAIL {key}: no LICENSES.json entry"); bad += 1; continue
        l = e.get("license", "")
        if l.lower() in FORBIDDEN or l not in ALLOWED:
            print(f"FAIL {key}: licence `{l}` not allowed"); bad += 1
        for fld in ("source", "url", "author", "fetched"):
            if not e.get(fld):
                print(f"FAIL {key}: entry lacks `{fld}`"); bad += 1
    for key, e in lic.items():
        if e.get("license", "").lower() in FORBIDDEN:
            print(f"FAIL {key}: forbidden licence"); bad += 1
    print(f"{len(items())} items, {bad} problem(s)")
    sys.exit(1 if bad else 0)


def cmd_cook(_):
    tex = os.path.join(LIB, "textures")
    if not os.path.isdir(tex):
        die("no assets/library/textures")
    cmd = ["cargo", "run", "--release", "--manifest-path", os.path.join(ROOT, "tools/cook/Cargo.toml"), "--", tex]
    if shutil.which("memgate"):
        cmd = ["memgate", "--"] + cmd
    sys.exit(subprocess.run(cmd, cwd=ROOT).returncode)


# ------------------------------------------------------------------ shared store
import contextlib, hashlib

STORE = None


def store_dir():
    return os.path.abspath(STORE or os.environ.get("ENGINE_ASSET_STORE") or DEFAULT_STORE)


def pop_flag(args, name):
    """Remove `name VALUE` from args; return the value (or None)."""
    if name in args:
        i = args.index(name)
        if i + 1 >= len(args):
            die(f"{name} needs a value")
        v = args[i + 1]
        del args[i:i + 2]
        return v
    return None


def file_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def tree_hash(root):
    """sha256 over sorted "relpath\\0filehash" lines of every file (LICENSES.json excluded)."""
    lines = []
    for f in walk_files(root):
        if os.path.basename(f) == "LICENSES.json":
            continue
        rel = os.path.relpath(f, root).replace(os.sep, "/")
        lines.append(f"{rel}\0{file_hash(f)}")
    return hashlib.sha256("\n".join(sorted(lines)).encode()).hexdigest()


def copy_tree(src, dst):
    for f in walk_files(src):
        out = os.path.join(dst, os.path.relpath(f, src))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        shutil.copy2(f, out)
    os.makedirs(dst, exist_ok=True)


def read_index():
    p = os.path.join(store_dir(), "index.json")
    if not os.path.exists(p):
        return {}
    with open(p) as f:
        return json.load(f)


def write_index(d):
    os.makedirs(store_dir(), exist_ok=True)
    p = os.path.join(store_dir(), "index.json")
    with open(p + ".tmp", "w") as f:
        json.dump(dict(sorted(d.items())), f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(p + ".tmp", p)


def cas_path(h):
    return os.path.join(store_dir(), "cas", h)


@contextlib.contextmanager
def staging():
    """Point LIB / LICENSES at a fresh temp dir so fetch/import write there; yield its path."""
    global LIB, LICENSES
    old = LIB, LICENSES
    tmp = tempfile.mkdtemp(prefix="assets_stage_")
    LIB = os.path.join(tmp, "library")
    LICENSES = os.path.join(LIB, "LICENSES.json")
    try:
        yield LIB
    finally:
        LIB, LICENSES = old
        shutil.rmtree(tmp, ignore_errors=True)


def ingest(stage_lib):
    """Move every item staged under stage_lib into cas/ and the index. Returns the keys."""
    lic = {}
    p = os.path.join(stage_lib, "LICENSES.json")
    if os.path.exists(p):
        lic = json.load(open(p))
    index = read_index()
    keys = []
    for kind in sorted(os.listdir(stage_lib)) if os.path.isdir(stage_lib) else []:
        kd = os.path.join(stage_lib, kind)
        if not os.path.isdir(kd):
            continue
        for name in sorted(os.listdir(kd)):
            src = os.path.join(kd, name)
            if not os.path.isdir(src):
                continue
            key = f"{kind}/{name}"
            entry = lic.get(key)
            if not entry:
                die(f"{key}: staged without a licence entry; refusing")
            check_license_arg(entry.get("license", ""))
            h = tree_hash(src)
            dst = cas_path(h)
            if os.path.isdir(dst):
                print(f"  store: {key} already present ({h[:12]})")
            else:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                tmp = dst + ".tmp"
                shutil.rmtree(tmp, ignore_errors=True)
                copy_tree(src, tmp)
                os.rename(tmp, dst)
                print(f"  store: {key} -> cas/{h[:12]}")
            cur = index.get(key, {})
            hist = list(cur.get("history", []))
            for x in (cur.get("current"), h):
                if x and x not in hist:
                    hist.append(x)
            index[key] = {"current": h, "history": hist, "entry": entry}
            keys.append(key)
    write_index(index)
    return keys


def manifest_path():
    return os.path.join(ROOT, "assets.manifest.json")


def lock_path():
    return os.path.join(ROOT, "assets.lock.json")


def read_manifest():
    if not os.path.exists(manifest_path()):
        return []
    return json.load(open(manifest_path())).get("items", [])


def write_json(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, indent=2, sort_keys=True)
        f.write("\n")


def cmd_add(args):
    args = list(args)
    valued = {"--source", "--license", "--url", "--author", "--kind", "--name"}
    targets, flags, i = [], [], 0
    while i < len(args):
        if args[i] in valued:
            flags += args[i:i + 2]
            i += 2
        elif args[i].startswith("--"):
            flags.append(args[i])
            i += 1
        else:
            targets.append(args[i])
            i += 1
    if not targets:
        die("usage: assets.py add <catalog-name|group|kind/name|zip|dir>... [--store DIR] [import flags]")
    cat = json.load(open(CATALOG))
    index = read_index()
    keys = []
    for t in targets:
        names = cat["groups"].get(t) if t in cat["groups"] else ([t] if t in cat["kits"] else None)
        if names is not None:
            for n in names:
                e = cat["kits"].get(n)
                if not e:
                    die(f"unknown kit `{n}`")
                key = f"{e['kind']}/{n}"
                if key in index:
                    print(f"{key}: already in the store, no download")
                else:
                    with staging() as lib:
                        cmd_fetch([n])
                        ingest(lib)
                keys.append(key)
        elif os.path.exists(t):
            with staging() as lib:
                cmd_import([t] + flags)
                keys += ingest(lib)
        elif "/" in t and t.split("/", 1)[0] in KINDS:
            if t not in index:
                die(f"{t} is not in the store ({store_dir()}); add it from a catalog name, zip or dir first")
            print(f"{t}: already in the store")
            keys.append(t)
        else:
            die(f"`{t}` is not a catalog name, group, store key, zip or directory")
    m = sorted(set(read_manifest()) | set(keys))
    write_json(manifest_path(), {"items": m})
    print(f"manifest: {len(m)} item(s) in assets.manifest.json")


def cmd_lock(_):
    index = read_index()
    out = {}
    for key in sorted(set(read_manifest())):
        ent = index.get(key)
        if not ent:
            die(f"{key} is in assets.manifest.json but not in the store ({store_dir()}); run `assets.py add {key}`")
        e = ent["entry"]
        check_license_arg(e.get("license", ""))
        h = ent["current"]
        if not os.path.isdir(cas_path(h)):
            die(f"{key}: store is missing cas/{h}")
        out[key] = {"hash": h, "license": e.get("license"), "author": e.get("author"),
                    "url": e.get("url"), "source": e.get("source")}
    write_json(lock_path(), {"items": out})
    print(f"locked {len(out)} item(s) -> assets.lock.json")


def read_lock():
    if not os.path.exists(lock_path()):
        die("no assets.lock.json; run `assets.py lock`")
    return json.load(open(lock_path())).get("items", {})


def write_attribution(lock):
    lines = ["# Asset attribution", "", "Generated by `scripts/assets.py sync` from assets.lock.json. Do not edit.", "",
             "| Item | Author | Licence | URL |", "|---|---|---|---|"]
    for key, e in sorted(lock.items()):
        lines.append(f"| {key} | {e.get('author', '')} | {e.get('license', '')} | {e.get('url', '')} |")
    by = [(k, e) for k, e in sorted(lock.items()) if str(e.get("license", "")).startswith("CC-BY")]
    if by:
        lines += [""]
        for k, e in by:
            lines.append(f"- {k}: credit is required ({e['license']}): credit {e.get('author', '')}, {e.get('url', '')}")
    with open(os.path.join(ROOT, "ATTRIBUTION.md"), "w") as f:
        f.write("\n".join(lines) + "\n")


def cmd_sync(args):
    copy, force = "--copy" in args, "--force" in args
    lock = read_lock()
    index = read_index()
    lic = read_licenses()
    synced = 0
    for key, e in sorted(lock.items()):
        h = e["hash"]
        check_license_arg(e.get("license", ""))
        src = cas_path(h)
        if not os.path.isdir(src):
            die(f"{key}: store item cas/{h} is missing from {store_dir()}")
        dest = os.path.join(LIB, key)
        if os.path.islink(dest):
            os.unlink(dest)
        elif os.path.exists(dest):
            if not force:
                print(f"{key}: real directory in assets/library, left alone (use --force to replace)")
                continue
            shutil.rmtree(dest)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if copy:
            copy_tree(src, dest)
            got = tree_hash(dest)
        else:
            got = tree_hash(src)
            if got == h:
                os.symlink(src, dest)
        if got != h:
            if copy:
                shutil.rmtree(dest, ignore_errors=True)
            die(f"{key}: hash mismatch (lock {h[:12]}, store has {got[:12]}); the store item was modified or corrupt")
        ent = dict(index.get(key, {}).get("entry") or {})
        ent.update({k: e.get(k) for k in ("source", "url", "author", "license")})
        ent.setdefault("fetched", datetime.date.today().isoformat())
        lic[key] = ent
        synced += 1
        print(f"{key}: {'copied' if copy else 'linked'} ({h[:12]})")
    write_licenses(lic)
    write_attribution(lock)
    print(f"synced {synced}/{len(lock)} item(s); wrote ATTRIBUTION.md")


def cmd_store(args):
    sub = args[0] if args else "list"
    if sub == "path":
        print(store_dir())
        return
    if sub != "list":
        die("usage: assets.py store [list|path]")
    rows = [("ITEM", "HASH", "LICENSE", "SIZE")]
    for key, ent in sorted(read_index().items()):
        p = cas_path(ent["current"])
        size = du(p)[0] if os.path.isdir(p) else 0
        rows.append((key, ent["current"][:12], ent["entry"].get("license", "?"),
                     f"{size / 1e6:.1f} MB" if os.path.isdir(p) else "MISSING"))
    w = [max(len(r[i]) for r in rows) for i in range(4)]
    for r in rows:
        print("  ".join(c.ljust(w[i]) for i, c in enumerate(r)))


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("fetch", "import", "list", "check", "cook", "add", "lock", "sync", "store"):
        print(__doc__)
        sys.exit(2)
    global STORE
    rest = sys.argv[2:]
    if sys.argv[1] in ("add", "lock", "sync", "store"):
        STORE = pop_flag(rest, "--store")
    try:
        globals()["cmd_" + sys.argv[1]](rest)
    except (urllib.error.URLError, OSError, zipfile.BadZipFile, KeyError, ValueError) as e:
        die(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
