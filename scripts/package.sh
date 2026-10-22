#!/bin/sh
# Build a ship (release) copy of a game made on the engine and put only what players need
# in dist/<bin>/: the binary and assets/. No docs, scripts, tests, examples, control port,
# MCP, CLI debug flags or trace reporting.
#
# usage: scripts/package.sh --manifest <Cargo.toml> --package <pkg> --bin <name>
#                           [--features "physics fps"] [--assets <dir>] [--out <dir>]
#
# The game must depend on the engine with `default-features = false` and turn its debug
# features on only through its own `dev` feature (see docs/PORTING.md, "Ship builds").
set -eu

manifest=Cargo.toml package= bin= features= assets= out=dist
while [ $# -gt 0 ]; do
    case "$1" in
        --manifest) manifest=$2; shift 2 ;;
        --package) package=$2; shift 2 ;;
        --bin) bin=$2; shift 2 ;;
        --features) features=$2; shift 2 ;;
        --assets) assets=$2; shift 2 ;;
        --out) out=$2; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
[ -n "$package" ] && [ -n "$bin" ] || { echo "need --package and --bin" >&2; exit 2; }

feat_args="--no-default-features"
[ -n "$features" ] && feat_args="$feat_args --features $features"

# 1. Debug crates must not be in the ship dependency graph at all.
leaked=$(cargo tree --manifest-path "$manifest" -p "$package" $feat_args -e normal --prefix none \
    | grep -E '^ashlar-' | sort -u || true)
if [ -n "$leaked" ]; then
    echo "ship build still depends on debug crates:" >&2
    echo "$leaked" >&2
    echo "fix: depend on engine with default-features = false and gate these behind a 'dev' feature" >&2
    exit 1
fi

# 2. Release build (memgate release profile: big link step).
memgate --profile release -- cargo build --release --manifest-path "$manifest" -p "$package" --bin "$bin" $feat_args

target=$(cargo metadata --manifest-path "$manifest" --format-version 1 --no-deps \
    | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')
binary="$target/release/$bin"

# 3. Belt and braces: no debug code compiled in.
if strings "$binary" | grep -qE 'ashlar_'; then
    echo "binary still contains ashlar debug code: $binary" >&2
    exit 1
fi

# 4. Only the binary and assets go in the package.
dest="$out/$bin"
rm -rf "$dest"
mkdir -p "$dest"
cp "$binary" "$dest/"
strip "$dest/$bin" 2>/dev/null || true
if [ -n "$assets" ]; then
    cp -R "$assets" "$dest/assets"
fi
echo "packaged $dest ($(du -sh "$dest" | cut -f1))"
