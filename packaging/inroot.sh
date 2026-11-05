#!/bin/bash
# Runs a command inside the Ubuntu build root (an unprivileged user namespace).
# usage: inroot.sh <project-dir> <command...>
HERE="$(cd "$(dirname "$0")/../.build-tools" && pwd)"
export PROJECT="$1"; shift
exec unshare -U --map-auto --map-root-user --mount --pid --fork --kill-child bash -c '
  R="$0"
  mount --rbind /proc "$R/proc" 2>/dev/null || mount -t proc proc "$R/proc"
  mkdir -p "$R/sys" "$R/dev" "$R/project"
  mount --rbind /sys "$R/sys"
  mount --rbind /dev "$R/dev"
  mount --bind "$PROJECT" "$R/project"
  cp -L /etc/resolv.conf "$R/etc/resolv.conf"
  exec chroot "$R" /usr/bin/env -i HOME=/root PATH=/root/.cargo/bin:/opt/node/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=true bash -c "$@"
' "$HERE/rootfs" "$*"
