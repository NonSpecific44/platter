#!/bin/bash
# Builds FFmpeg's audio decoders for the Android app (src-tauri/gen/android/ffmpeg-decoder).
# LGPL only: no --enable-gpl or nonfree parts. Re-run after changing the decoder list or FFmpeg.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/.build-tools/ffmpeg-src"
NDK="${NDK_HOME:-$HOME/Android/Sdk/ndk/28.2.13676358}"
[ -d "$SRC" ] || git clone --depth 1 --branch release/6.0 https://git.ffmpeg.org/ffmpeg.git "$SRC"
# Everything ExoPlayer can hand to FFmpeg for music. WAV and AIFF need none: ExoPlayer reads
# their samples itself.
DECODERS=(flac alac mp3 aac vorbis opus pcm_mulaw pcm_alaw)
bash "$ROOT/src-tauri/gen/android/ffmpeg-decoder/src/main/jni/build_ffmpeg.sh" \
  "$ROOT/src-tauri/gen/android/ffmpeg-decoder/src/main" "$NDK" linux-x86_64 24 "${DECODERS[@]}"
