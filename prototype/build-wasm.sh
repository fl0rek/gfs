#!/usr/bin/env bash
# PROTOTYPE. Build gfs-core to wasm and generate JS bindings into web/src/gfs-wasm/.
# Needs: cargo, wasm-bindgen-cli (same version as the wasm-bindgen crate), and either the
# wasm32-unknown-unknown target or rust-src (then std is built from source).
set -euo pipefail
cd "$(dirname "$0")/gfs-core"

if rustup target list --installed 2>/dev/null | grep -q '^wasm32-unknown-unknown$'; then
  cargo build --release --target wasm32-unknown-unknown
else
  echo "wasm32 target not installed; building std from source" >&2
  RUSTC_BOOTSTRAP=1 cargo build --release --target wasm32-unknown-unknown -Zbuild-std=std,panic_abort
fi

OUT=../web/src/gfs-wasm
mkdir -p "$OUT"
wasm-bindgen --target web --out-dir "$OUT" --out-name gfs_core \
  target/wasm32-unknown-unknown/release/gfs_core.wasm
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Os -o "$OUT/gfs_core_bg.wasm" "$OUT/gfs_core_bg.wasm"
fi
ls -la "$OUT"
