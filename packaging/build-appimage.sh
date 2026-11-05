#!/bin/bash
# Builds a portable AppImage inside an Ubuntu 24.04 root. Bundled libraries must come from a
# generic distribution: CachyOS packages are compiled for the build machine's CPU (AVX-512 here),
# and an AppImage bundling them crashes on anything else, like an Intel laptop.
# Run through .build-tools/inroot.sh; see README → Building.
set -e
cd /project
export CARGO_TARGET_DIR=/root/target
export TAURI_SIGNING_PRIVATE_KEY="$(cat .updater-signing/tonearm-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat .updater-signing/password)"
npx tauri build --bundles appimage
mkdir -p /project/dist-appimage
cp "$CARGO_TARGET_DIR"/release/bundle/appimage/*.AppImage* /project/dist-appimage/
