#!/usr/bin/env bash
# Prune the shared target dir (engine/target: the engine and every game build here).
# Cargo never deletes stale artifacts, so the dir grows with every crate/feature/worktree change.
# cargo-sweep drops the least recently used artifacts until the dir fits under the cap; what
# you built lately stays warm (an 80 GB cap keeps roughly the last two days of builds).
#
#   scripts/sweep-target.sh [CAP]        # prune, CAP default 80GB
#   scripts/sweep-target.sh --dry [CAP]  # show what would go
# (`cargo sweep --time N` keys on fingerprint use and misses most stale artifacts here, so the
# size cap is the reliable mode.)
set -euo pipefail
DRY=()
if [ "${1:-}" = "--dry" ]; then DRY=(--dry-run); shift; fi
CAP="${1:-80GB}"
ENGINE="$(cd "$(dirname "$0")/.." && pwd)"
command -v cargo-sweep >/dev/null || { echo "installing cargo-sweep"; memgate -- cargo install cargo-sweep --locked; }
[ -d "$ENGINE/target" ] || { echo "no $ENGINE/target"; exit 0; }
if [ ${#DRY[@]} -eq 0 ] && memgate status 2>/dev/null | grep -qE "cargo|rustc"; then
  echo "a cargo build is running (memgate status): sweep later"; exit 1
fi
echo "before: $(du -sh "$ENGINE/target" | cut -f1)"
# The engine project resolves to the shared target dir through its .cargo/config.toml.
cargo sweep ${DRY[@]+"${DRY[@]}"} --maxsize "$CAP" "$ENGINE"
echo "after:  $(du -sh "$ENGINE/target" | cut -f1)"
