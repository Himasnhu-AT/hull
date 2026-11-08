#!/usr/bin/env python3
"""Asset library: fetch CC0 kits, import your own downloads, list, check licences.

  python3 -I scripts/assets.py fetch <name|group>... [--cook]   # see scripts/assets_catalog.json
  python3 -I scripts/assets.py import <zip|dir> --source fab|other --license ID --url URL --author NAME
                                      [--kind cars|roads|buildings|props|textures|hdris] [--name NAME]
  python3 -I scripts/assets.py list
  python3 -I scripts/assets.py check          # exit 1 on a missing entry / forbidden licence
  python3 -I scripts/assets.py cook           # textures -> KTX2 with tools/cook

Layout: assets/library/<kind>/<name>/... plus assets/library/LICENSES.json, keyed "<kind>/<name>"
(docs/ASSETS.md). Everything downloaded is untrusted data: it is unpacked into a fresh temp
directory (zip paths checked), only glTF/GLB, images and licence text are copied out, and
nothing from it is executed. Standard library only.
"""
import datetime, json, os, shutil, ssl, subprocess, sys, tempfile, urllib.error, urllib.parse, urllib.request, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(ROOT, "assets", "library")
LICENSES = os.path.join(LIB, "LICENSES.json")
CATALOG = os.path.join(ROOT, "scripts", "assets_catalog.json")
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


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("fetch", "import", "list", "check", "cook"):
        print(__doc__)
        sys.exit(2)
    try:
        globals()["cmd_" + sys.argv[1]](sys.argv[2:])
    except (urllib.error.URLError, OSError, zipfile.BadZipFile, KeyError, ValueError) as e:
        die(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
