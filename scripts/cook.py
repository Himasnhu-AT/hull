#!/usr/bin/env python3
"""Cook textures: PNG/JPEG -> KTX2 with a full mip chain (UASTC + zstd, or ETC1S with
--small), so the game skips CPU mip generation at load and uses ~4-8x less VRAM.

  python3 -I scripts/cook.py ASSETS [--out DIR] [--apply] [--small] [--only SUBSTR]
        [--normal-maps PATTERN] [--linear PATTERN]

Default is a dry run: prints the plan (one JSON line per texture: source, target, size,
command) and writes nothing. --apply runs the encoder; outputs go to DIR (default
ASSETS/../assets-cooked) mirroring ASSETS, plus DIR/cook-manifest.json (sorted, with
sha256 of every source and output, so a cook is reproducible and diffable). Unchanged
sources (same sha256 as the manifest) are skipped.

Encoder: `toktx` from KTX-Software 4.x (https://github.com/KhronosGroup/KTX-Software/releases,
or `brew install --cask ktx-software` if available). Not installed -> the plan says so and
--apply exits 2. Loading KTX2 in the game needs the engine feature `ktx2` (bevy/ktx2 +
bevy/zstd_rust; recompiles Bevy once), and the code must load the `.ktx2` path.

Color space: textures whose path matches --linear (default: normal|_n.|rough|metal|_ao|
occlusion|height|mask) are encoded as linear data; everything else as sRGB. Normal maps
(--normal-maps, default: normal|_n.) also get --normal_mode.
"""
import hashlib, json, os, re, shutil, subprocess, sys

TEXTURES = (".png", ".jpg", ".jpeg")


def opt(args, name, default=None):
    return args[args.index(name) + 1] if name in args else default


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def size_of(path):
    """(w, h) from a PNG / JPEG header, or None."""
    with open(path, "rb") as f:
        b = f.read(64 * 1024)
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return int.from_bytes(b[16:20], "big"), int.from_bytes(b[20:24], "big")
    if b[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(b):
            if b[i] != 0xFF:
                i += 1
                continue
            m = b[i + 1]
            if m in (0xD8, 0x01, 0xFF) or 0xD0 <= m <= 0xD7:
                i += 1 if m == 0xFF else 2
                continue
            seg = int.from_bytes(b[i + 2:i + 4], "big")
            if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                return int.from_bytes(b[i + 7:i + 9], "big"), int.from_bytes(b[i + 5:i + 7], "big")
            i += 2 + seg
    return None


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return
    src_root = os.path.abspath(args[0])
    out_root = os.path.abspath(opt(args, "--out", os.path.join(os.path.dirname(src_root), "assets-cooked")))
    apply = "--apply" in args
    only = opt(args, "--only")
    linear = re.compile(opt(args, "--linear", r"normal|_n\.|rough|metal|_ao|occlusion|height|mask"), re.I)
    normals = re.compile(opt(args, "--normal-maps", r"normal|_n\."), re.I)
    toktx = shutil.which("toktx")
    manifest_path = os.path.join(out_root, "cook-manifest.json")
    old = {}
    if os.path.exists(manifest_path):
        old = {e["source"]: e for e in json.load(open(manifest_path)).get("textures", [])}

    sources = []
    for d, dirs, files in os.walk(src_root):
        dirs[:] = sorted(x for x in dirs if not x.startswith("."))
        for f in sorted(files):
            if f.lower().endswith(TEXTURES):
                rel = os.path.relpath(os.path.join(d, f), src_root).replace(os.sep, "/")
                if not only or only in rel:
                    sources.append(rel)

    entries, todo = [], 0
    for rel in sources:
        src = os.path.join(src_root, rel)
        target = os.path.splitext(rel)[0] + ".ktx2"
        dst = os.path.join(out_root, target)
        digest = sha256(src)
        wh = size_of(src)
        is_linear = bool(linear.search(rel))
        cmd = [toktx or "toktx", "--t2", "--genmipmap", "--assign_oetf", "linear" if is_linear else "srgb"]
        if "--small" in args:
            cmd += ["--encode", "etc1s", "--clevel", "2", "--qlevel", "128"]
        else:
            cmd += ["--encode", "uastc", "--uastc_quality", "2", "--zcmp", "18"]
        if normals.search(rel):
            cmd.append("--normal_mode")
        cmd += [dst, src]
        prev = old.get(rel)
        fresh = prev and prev.get("sha256") == digest and os.path.exists(dst)
        e = {"source": rel, "target": target, "sha256": digest, "size": list(wh) if wh else None,
             "linear": is_linear, "action": "skip (unchanged)" if fresh else "encode", "command": " ".join(cmd)}
        if wh and (wh[0] & (wh[0] - 1) or wh[1] & (wh[1] - 1)):
            e["note"] = "not a power of two: mips still work, but consider resizing"
        if not fresh:
            todo += 1
            if apply:
                if not toktx:
                    sys.exit("toktx not found (install KTX-Software 4.x); run without --apply for the plan")
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                r = subprocess.run(cmd, capture_output=True, text=True)
                if r.returncode != 0:
                    sys.exit(f"toktx failed for {rel}:\n{r.stderr}")
                e["action"] = "encoded"
        if os.path.exists(dst):
            e["output_sha256"] = sha256(dst)
            e["output_bytes"] = os.path.getsize(dst)
        entries.append(e)
        print(json.dumps(e), flush=True)

    summary = {"textures": len(entries), "to_encode": todo, "encoder": toktx or None, "applied": apply, "out": out_root}
    if apply:
        os.makedirs(out_root, exist_ok=True)
        tmp = manifest_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"version": 1, "textures": entries}, f, indent=1, sort_keys=True)
            f.write("\n")
        os.replace(tmp, manifest_path)
    elif not toktx:
        summary["hint"] = "toktx not installed: get KTX-Software 4.x, then rerun with --apply"
    print(json.dumps(summary))


main()
