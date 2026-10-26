#!/bin/sh
# Build a ship (release) copy of a game made on the engine and put only what players need
# in dist/<bin>/: the binary and assets/. No docs, scripts, tests, examples, control port,
# MCP, CLI debug flags or trace reporting.
#
# usage: scripts/package.sh --manifest <Cargo.toml> --package <pkg> --bin <name>
#                           [--features "physics fps"] [--assets <dir>] [--out <dir>]
#                           [--dry-run] [--archive] [--check-assets]
#
#   --dry-run       check the ship dependency graph and print the plan (build command, env,
#                   files) without building or copying anything.
#   --archive       also write <out>/<bin>-<version>.tar.gz, byte-for-byte reproducible
#                   (sorted entries, fixed mtime = SOURCE_DATE_EPOCH, uid/gid 0).
#   --check-assets  run the engine's asset check (examples/devkit_cli) first; errors stop it.
#
# Reproducible + small by default, whatever the game's Cargo.toml says: the release profile is
# overridden through CARGO_PROFILE_RELEASE_* (strip symbols, no debug info, thin LTO, one
# codegen unit, abort on panic is left to the game), $HOME is remapped out of the binary, and
# SOURCE_DATE_EPOCH comes from the last commit. dist/<bin>/MANIFEST.sha256 lists every file.
#
# The game must depend on the engine with `default-features = false` and turn its debug
# features on only through its own `dev` feature (see docs/PORTING.md, "Ship builds").
set -eu

manifest=Cargo.toml package= bin= features= assets= out=dist dry=0 archive=0 check=0
while [ $# -gt 0 ]; do
    case "$1" in
        --manifest) manifest=$2; shift 2 ;;
        --package) package=$2; shift 2 ;;
        --bin) bin=$2; shift 2 ;;
        --features) features=$2; shift 2 ;;
        --assets) assets=$2; shift 2 ;;
        --out) out=$2; shift 2 ;;
        --dry-run) dry=1; shift ;;
        --archive) archive=1; shift ;;
        --check-assets) check=1; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
[ -n "$package" ] && [ -n "$bin" ] || { echo "need --package and --bin" >&2; exit 2; }

engine_dir=$(cd "$(dirname "$0")/.." && pwd)
feat_args="--no-default-features"
[ -n "$features" ] && feat_args="$feat_args --features $features"

# Deterministic, lean release settings (env overrides beat the manifest's [profile.release]).
manifest_dir=$(cd "$(dirname "$manifest")" && pwd)
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git -C "$manifest_dir" log -1 --format=%ct 2>/dev/null || echo 0)}
export SOURCE_DATE_EPOCH
export CARGO_PROFILE_RELEASE_STRIP=symbols
export CARGO_PROFILE_RELEASE_DEBUG=false
export CARGO_PROFILE_RELEASE_LTO=thin
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
export CARGO_PROFILE_RELEASE_INCREMENTAL=false
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=~"

# 1. Debug crates must not be in the ship dependency graph at all.
leaked=$(cargo tree --manifest-path "$manifest" -p "$package" $feat_args -e normal --prefix none \
    | grep -E '^ashlar-' | sort -u || true)
if [ -n "$leaked" ]; then
    echo "ship build still depends on debug crates:" >&2
    echo "$leaked" >&2
    echo "fix: depend on engine with default-features = false and gate these behind a 'dev' feature" >&2
    exit 1
fi

# 2. Optional asset check (missing refs, oversized textures, unreadable files).
if [ "$check" = 1 ] && [ -n "$assets" ]; then
    src_dir="$manifest_dir/src"
    [ -d "$manifest_dir/crates" ] && src_dir="$manifest_dir/crates"
    if [ "$dry" = 1 ]; then
        echo "plan: asset check: cargo run --example devkit_cli -- assets $assets --src $src_dir"
    else
        memgate -- cargo run --quiet --manifest-path "$engine_dir/Cargo.toml" --example devkit_cli -- \
            assets "$assets" --src "$src_dir" > "${TMPDIR:-/tmp}/asset-check-$$.json" || {
            echo "asset check failed: ${TMPDIR:-/tmp}/asset-check-$$.json" >&2
            exit 1
        }
    fi
fi

version=$(cargo metadata --manifest-path "$manifest" --format-version 1 --no-deps \
    | python3 -I -c 'import json,sys; m=json.load(sys.stdin); print(next((p["version"] for p in m["packages"] if p["name"]==sys.argv[1]), "0"))' "$package")
build="memgate --profile release -- cargo build --release --locked --manifest-path $manifest -p $package --bin $bin $feat_args"
dest="$out/$bin"

if [ "$dry" = 1 ]; then
    echo "plan: $bin $version (ship graph clean: no ashlar-* crates)"
    echo "plan: env SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH CARGO_PROFILE_RELEASE_{STRIP=symbols,DEBUG=false,LTO=thin,CODEGEN_UNITS=1} RUSTFLAGS='$RUSTFLAGS'"
    echo "plan: build: $build"
    echo "plan: copy binary -> $dest/$bin"
    if [ -n "$assets" ]; then
        n=$(find "$assets" -type f ! -name '.*' | wc -l | tr -d ' ')
        sz=$(du -sh "$assets" | cut -f1)
        echo "plan: copy assets ($n files, $sz) -> $dest/assets"
    fi
    echo "plan: write $dest/MANIFEST.sha256"
    [ "$archive" = 1 ] && echo "plan: archive -> $out/$bin-$version.tar.gz (reproducible)"
    exit 0
fi

# 3. Release build (memgate release profile: big link step). --locked: the lock file decides.
$build

target=$(cargo metadata --manifest-path "$manifest" --format-version 1 --no-deps \
    | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')
binary="$target/release/$bin"

# 4. Belt and braces: no debug code compiled in.
if strings "$binary" | grep -qE 'ashlar_'; then
    echo "binary still contains ashlar debug code: $binary" >&2
    exit 1
fi

# 5. Only the binary and assets go in the package.
rm -rf "$dest"
mkdir -p "$dest"
cp "$binary" "$dest/"
strip "$dest/$bin" 2>/dev/null || true
if [ -n "$assets" ]; then
    # No dotfiles (.DS_Store, editor swap files).
    (cd "$assets" && find . -type f ! -name '.*' | LC_ALL=C sort) | while read -r f; do
        mkdir -p "$dest/assets/$(dirname "$f")"
        cp "$assets/$f" "$dest/assets/$f"
    done
fi
(cd "$dest" && find . -type f ! -name MANIFEST.sha256 | LC_ALL=C sort | sed 's|^\./||' | while read -r f; do
    shasum -a 256 "$f"
done) > "$dest/MANIFEST.sha256"
echo "packaged $dest ($(du -sh "$dest" | cut -f1))"

# 6. Reproducible archive.
if [ "$archive" = 1 ]; then
    python3 -I - "$dest" "$out/$bin-$version.tar.gz" "$SOURCE_DATE_EPOCH" <<'EOF'
import gzip, os, sys, tarfile
src, dst, epoch = sys.argv[1], sys.argv[2], int(sys.argv[3])
base = os.path.basename(src.rstrip("/"))
files = []
for d, dirs, fs in os.walk(src):
    dirs.sort()
    files += [os.path.join(d, f) for f in sorted(fs)]
with open(dst, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=epoch, filename="") as gz, \
        tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tar:
    for path in sorted(files):
        info = tar.gettarinfo(path, arcname=os.path.join(base, os.path.relpath(path, src)))
        info.mtime, info.uid, info.gid, info.uname, info.gname = epoch, 0, 0, "", ""
        info.mode = 0o755 if os.access(path, os.X_OK) else 0o644
        with open(path, "rb") as f:
            tar.addfile(info, f)
print(f"archive {dst} ({os.path.getsize(dst) // 1024} KB)")
EOF
fi
