#!/bin/sh
# Builds the backend as one static linux/arm64 binary (for a t4g host) in backend/dist/. Does not touch any server.
set -eu
cd "$(dirname "$0")/.."
mkdir -p dist
out=dist/hull-backend-linux-arm64
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o "$out" ./cmd/hull-backend
echo "built $out"
echo "size:   $(wc -c < "$out" | tr -d ' ') bytes"
if command -v sha256sum >/dev/null 2>&1; then echo "sha256: $(sha256sum "$out" | cut -d' ' -f1)"; else echo "sha256: $(shasum -a 256 "$out" | cut -d' ' -f1)"; fi
